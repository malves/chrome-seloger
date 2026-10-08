/**
 * Liste des annonces, fiche détaillée et actions de suivi.
 *
 * Toutes les requêtes filtrent sur `user_id` : une annonce appartenant à un
 * autre compte renvoie 404, jamais 403 (on ne révèle pas son existence).
 */

import crypto from "node:crypto";
import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import HttpError from "../lib/http-error.js";
import config from "../config.js";
import { requireUser, isAdmin } from "../middlewares/auth.session.js";
import { DEFAULT_SORT, SORTS } from "../repositories/listings.repo.js";
import {
  STATUS_KEYS,
  PROPERTY_TYPE_KEYS,
  resolveListingStatusUpdate,
} from "../lib/format.js";
import { accountFinancingSettings } from "../services/settings.service.js";
import createProjectsService from "../services/projects.service.js";
import { userAddressFromBody } from "../lib/user-address.js";
import { listingDpeSearchCriteria } from "../lib/listing-dpe-criteria.js";
import createListingsService from "../services/listings.service.js";
import createListingFetchService from "../services/listing-fetch.service.js";
import createTravelService from "../services/travel.service.js";
import createAddressAiService from "../services/address-ai.service.js";
import { listingPayloadSchema } from "../schemas/listing.payload.js";
import {
  financingForListing,
  listingFinancingParams,
  readListingFinancingForm,
} from "../services/financing.service.js";
import { logActivity } from "../lib/activity.js";
import { departmentCodeFromInsee } from "../lib/immo-data-market.js";
import { buildDpeInsights } from "../lib/dpe-insights.js";

/** Nombre maximum de brouillons d'import conservés par session. */
const MAX_DRAFTS = 20;

/** Résumé d'un payload d'annonce envoyé au client pour l'aperçu. */
function previewSummary(payload) {
  const location = payload.location || {};
  return {
    title: payload.title || null,
    price: payload.price ?? null,
    surface: payload.surface ?? null,
    land_surface: payload.land_surface ?? null,
    rooms: payload.rooms ?? null,
    bedrooms: payload.bedrooms ?? null,
    city: location.city || null,
    postal_code: location.postal_code || null,
    photo: (payload.photos && payload.photos[0]) || null,
    source: payload.source,
    url: payload.url,
    property_type: payload.property_type || null,
    transaction_type: payload.transaction_type || null,
  };
}

/** Nombre d'annonces affichées par page de la liste. */
const PER_PAGE = 9;

function parseIntOrNull(value) {
  if (value === undefined || value === "") return null;
  const n = Number(String(value).replace(/[^\d-]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Normalise la query string en filtres sûrs. */
function readFilters(query) {
  const priceMin = parseIntOrNull(query.price_min);
  const priceMax = parseIntOrNull(query.price_max);

  const favorite = query.fav === "1";

  return {
    // Favoris remplace le statut : les deux ne se cumulent pas.
    status: favorite || !STATUS_KEYS.includes(query.status) ? null : query.status,
    propertyType: PROPERTY_TYPE_KEYS.includes(query.type) ? query.type : null,
    city: typeof query.city === "string" && query.city.trim() ? query.city.trim() : null,
    favorite,
    priceMin: priceMin ?? undefined,
    priceMax: priceMax ?? undefined,
    sort: SORTS[query.sort] ? query.sort : DEFAULT_SORT,
  };
}

export default function createListingsRouter({ repositories, enrichment, logger }) {
  const router = express.Router();
  const projectsService = createProjectsService({ repositories });
  const listingsService = createListingsService({ repositories });
  const listingFetch = createListingFetchService({ logger });
  const travel = createTravelService({ logger });
  const addressAi = createAddressAiService({ repositories, logger });

  function linkedDpeInsightsForListing(listing, fmt) {
    const numero = listing.linked_dpe_numero;
    if (!numero) return null;
    const record = repositories.dpe.findByNumero(numero);
    if (!record) return null;
    return buildDpeInsights(record, fmt);
  }

  function linkedDpeNumeroFromBody(body, source) {
    if (source !== "detected") return null;
    const raw = body.linked_dpe_numero;
    if (typeof raw !== "string" || !raw.trim()) return null;
    const numero = raw.trim();
    return repositories.dpe.findByNumero(numero) ? numero : null;
  }

  // Ces deux routes reçoivent du JSON (fetch côté client) ; le reste du site
  // utilise le parseur `urlencoded` global monté dans app.js.
  const jsonBody = express.json({ limit: "256kb" });

  router.use("/listings", requireUser);

  // L'aperçu déclenche un appel réseau sortant : on borne son usage.
  const previewLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: () => config.isTest,
    keyGenerator: (req) =>
      req.user ? `u:${req.user.id}` : ipKeyGenerator(req.ip),
    handler: (req, res) =>
      res.status(429).json({
        ok: false,
        reason: "rate_limited",
        message: "Trop de vérifications d'affilée. Patientez une minute.",
      }),
  });

  /** Charge l'annonce du compte courant ou lève une 404. L'admin peut ouvrir toute fiche. */
  function loadListing(req) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw HttpError.notFound("Annonce introuvable.");
    let listing = repositories.listings.findById(req.user.id, id);
    if (!listing && isAdmin(req.user)) {
      listing = repositories.listings.findByIdOnly(id);
    }
    if (!listing) throw HttpError.notFound("Annonce introuvable.");
    return listing;
  }

  function financingFor(listing) {
    const defaults = accountFinancingSettings(
      repositories.users.findById(listing.user_id)
    );
    const stored = repositories.enrichments.findOne(listing.id, "financing");
    const params = listingFinancingParams(listing, defaults, stored?.data);
    return { params, result: financingForListing(listing, params) };
  }

  /* ------------------------------ Liste ------------------------------ */

  router.get("/listings", (req, res) => {
    projectsService.ensureDefault(req.user.id);
    const projects = projectsService.list(req.user.id);

    // Le projet se désigne par son slug dans l'URL ; une valeur inconnue
    // retombe sur « tous les projets » plutôt que sur une liste vide.
    const activeProject =
      projects.find((project) => project.slug === req.query.project) || null;

    const filters = { ...readFilters(req.query), projectId: activeProject?.id };
    const projectId = activeProject?.id ?? null;
    const statusCounts = repositories.listings.statusCounts(req.user.id, projectId);
    const total = repositories.listings.countByUser(req.user.id, projectId);

    // Pagination : le total filtré peut différer du total projet (statut,
    // favoris, prix…). On borne la page demandée pour éviter une page vide.
    const matchCount = repositories.listings.countSearch(req.user.id, filters);
    const pageCount = Math.max(1, Math.ceil(matchCount / PER_PAGE));
    const requestedPage = parseIntOrNull(req.query.page) ?? 1;
    const page = Math.min(Math.max(1, requestedPage), pageCount);
    const offset = (page - 1) * PER_PAGE;

    res.render("listings", {
      title: activeProject ? activeProject.name : "Mes annonces",
      listings: repositories.listings.search(req.user.id, {
        ...filters,
        limit: PER_PAGE,
        offset,
      }),
      pagination: {
        page,
        pageCount,
        perPage: PER_PAGE,
        total: matchCount,
        from: matchCount === 0 ? 0 : offset + 1,
        to: Math.min(offset + PER_PAGE, matchCount),
      },
      filters,
      query: req.query,
      sorts: SORTS,
      statusCounts,
      total,
      favoriteCount: repositories.listings.countFavorites(req.user.id),
      rejectedCount: repositories.listings.statusCounts(req.user.id).rejected || 0,
      projects,
      activeProject,
      grandTotal: repositories.listings.countByUser(req.user.id),
    });
  });

  /* ----------------------- Ajout par URL ----------------------------- */

  // Étape 1 : on récupère et on lit la page, puis on renvoie un aperçu. Le
  // payload complet est conservé en session sous un jeton, pour éviter de
  // refaire l'appel réseau (donc un second risque de blocage) à la validation.
  router.post("/listings/preview", jsonBody, previewLimiter, async (req, res, next) => {
    try {
      const url = String(req.body?.url || "").trim();
      if (!url) {
        return res.status(400).json({
          ok: false,
          reason: "invalid_url",
          message: "Collez l'URL d'une annonce.",
        });
      }

      const result = await listingFetch.fetchAndParse(url);
      if (!result.ok) {
        return res.status(200).json(result);
      }

      const parsed = listingPayloadSchema.safeParse(result.payload);
      if (!parsed.success) {
        return res.status(200).json({
          ok: false,
          reason: "parse_failed",
          message:
            "Les données lues sur la page sont incomplètes ou invalides.",
        });
      }

      // Déjà dans le carnet ? On le signale sans empêcher la ré-import.
      const existing = listingsService.lookup(req.user, parsed.data.url);

      const token = crypto.randomBytes(16).toString("hex");
      if (!req.session.listingDrafts) req.session.listingDrafts = {};
      const drafts = req.session.listingDrafts;
      const tokens = Object.keys(drafts);
      if (tokens.length >= MAX_DRAFTS) delete drafts[tokens[0]];
      drafts[token] = parsed.data;

      logActivity(logger, req, "aperçu d'annonce par URL", {
        source: parsed.data.source,
      });

      return res.json({
        ok: true,
        token,
        preview: previewSummary(parsed.data),
        already_saved: existing ? { id: existing.id } : null,
      });
    } catch (err) {
      return next(err);
    }
  });

  // Étape 2 : validation. Le payload vient de la session (jamais du client),
  // seuls les projets choisis sont acceptés depuis la requête.
  router.post("/listings/import", jsonBody, (req, res, next) => {
    try {
      const token = String(req.body?.token || "");
      const drafts = req.session.listingDrafts || {};
      const payload = drafts[token];
      if (!payload) {
        return res.status(410).json({
          ok: false,
          reason: "expired",
          message:
            "Cet aperçu a expiré. Relancez la vérification de l'URL.",
        });
      }

      const projectIds = []
        .concat(req.body.project_ids ?? [])
        .filter((value) => value !== "" && value != null);

      const { id, created } = listingsService.save(req.user, {
        ...payload,
        projects: projectIds,
      });

      delete drafts[token];

      logActivity(logger, req, created ? "annonce ajoutée (URL)" : "annonce mise à jour (URL)", {
        listingId: id,
      });

      enrichment.schedule(req.user.id, id);

      return res.json({
        ok: true,
        id,
        created,
        web_url: `/listings/${id}`,
      });
    } catch (err) {
      return next(err);
    }
  });

  /** Découpe le viewModel enrichissement pour la fiche annonce. */
  async function listingEnrichmentPanels(listing) {
    const providers = await enrichment.viewModel(listing);
    const communeProviders = providers.filter((p) => p.group === "territory");
    const otherProviders = providers.filter(
      (p) =>
        p.group === "market" && p.key !== "financing" && p.key !== "prix-m2"
    );
    const enrichmentPoll = enrichment.isEnrichmentPending(providers);
    return { communeProviders, otherProviders, enrichmentPoll };
  }

  function requireAdminForEnrichmentRefresh(req, _res, next) {
    if (!isAdmin(req.user)) {
      throw HttpError.forbidden(
        "L'actualisation manuelle des enrichissements est réservée à l'administration."
      );
    }
    return next();
  }

  /* ------------------------------ Fiche ------------------------------ */

  router.get("/listings/:id", async (req, res, next) => {
    try {
      const listing = loadListing(req);
      const { communeProviders, otherProviders, enrichmentPoll } =
        await listingEnrichmentPanels(listing);
      if (enrichmentPoll) {
        enrichment.schedule(listing.user_id, listing.id);
      }
      const postalInseeCode = await repositories.postalInsee.resolveInsee(
        listing.postal_code,
        listing.city,
        { fetchJson: enrichment.fetchJson }
      );

      res.render("listing", {
        title: listing.title || "Annonce",
        listing,
        linkedDpeInsights: linkedDpeInsightsForListing(listing, res.locals.fmt),
        postalInseeCode,
        photos: repositories.listings.listPhotos(listing.id),
        priceHistory: repositories.listings.listPriceHistory(listing.id),
        // Le financement a son propre bloc ; les autres providers sont groupés
        // par vocation d'affichage (territoire vs analyse de marché), pas par
        // portée de cache (Immo Data est mis en cache en communal/départemental).
        communeProviders,
        otherProviders,
        enrichmentPoll,
        financing: financingFor(listing),
        projects: projectsService.list(req.user.id),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/listings/:id/enrichment-live", async (req, res, next) => {
    try {
      const listing = loadListing(req);
      const panels = await listingEnrichmentPanels(listing);
      if (panels.enrichmentPoll) {
        enrichment.schedule(listing.user_id, listing.id);
      }
      return res.render("partials/listing-enrichment-live", {
        layout: false,
        listing,
        ...panels,
      });
    } catch (err) {
      return next(err);
    }
  });

  /* --------------------- Statut, notes, favori ----------------------- */

  router.post("/listings/:id", (req, res, next) => {
    try {
      const listing = loadListing(req);
      const view = String(req.body.view || "card");

      if (typeof req.body.status === "string") {
        if (!STATUS_KEYS.includes(req.body.status)) {
          throw HttpError.badRequest("Statut inconnu.");
        }
        const patch = resolveListingStatusUpdate(listing, req.body.status);
        repositories.listings.setStatus(
          req.user.id,
          listing.id,
          patch.status,
          patch.status_progress
        );
        logActivity(logger, req, "statut d'annonce modifié", {
          listingId: listing.id,
          status: patch.status,
          statusProgress: patch.status_progress,
        });
      }

      if (req.body.is_favorite !== undefined) {
        const favorite =
          req.body.is_favorite === "1" || req.body.is_favorite === "true";
        repositories.listings.setFavorite(req.user.id, listing.id, favorite);
        logActivity(logger, req, favorite ? "annonce mise en favori" : "favori retiré", {
          listingId: listing.id,
        });
      }

      if (req.body.notes !== undefined) {
        repositories.listings.setNotes(
          req.user.id,
          listing.id,
          String(req.body.notes).slice(0, 20_000)
        );
      }

      const updated = repositories.listings.findById(req.user.id, listing.id);

      if (!req.get("hx-request")) {
        return res.redirect(view === "card" ? "/listings" : `/listings/${listing.id}`);
      }

      if (view === "notes") {
        return res.render("partials/notes-status", {
          layout: false,
          savedAt: new Date(),
        });
      }
      if (view === "header") {
        return res.render("partials/listing-lead", {
          layout: false,
          listing: updated,
          projects: projectsService.list(req.user.id),
        });
      }
      return res.render("partials/listing-card", {
        layout: false,
        listing: updated,
      });
    } catch (err) {
      return next(err);
    }
  });

  /* ------------------------ Adresse réelle --------------------------- */

  /**
   * Adresse réelle du bien, saisie à la main (souvent absente des annonces).
   * On géocode « best-effort » (BAN puis ORS, gratuit) pour obtenir un point
   * précis réutilisable (carte, et plus tard trajet / enrichissement). Le
   * géocodage ne doit jamais faire échouer l'enregistrement : s'il échoue,
   * l'adresse texte est conservée sans coordonnées.
   */
  router.post(
    "/listings/:id/address-ai/criteria",
    jsonBody,
    (req, res, next) => {
      try {
        const listing = loadListing(req);
        const payload = listingDpeSearchCriteria(listing);
        logActivity(logger, req, "critères recherche DPE (déterminer l'adresse)", {
          listingId: listing.id,
          criteres: payload.criteres,
          champsManquants: payload.champsManquants,
          filtresRechercheDpe: payload.filtresRechercheDpe,
        });
        logger.info(
          {
            listingId: listing.id,
            criteres: payload.criteres,
            champsManquants: payload.champsManquants,
            filtresRechercheDpe: payload.filtresRechercheDpe,
          },
          "address-ai/criteria"
        );
        return res.json(payload);
      } catch (err) {
        return next(err);
      }
    }
  );

  /**
   * Recherche réelle des adresses candidates (mode précis) dans la base DPE.
   * Renvoie une liste d'adresses notées par score de confiance.
   */
  router.post(
    "/listings/:id/address-ai/search",
    jsonBody,
    (req, res, next) => {
      try {
        const listing = loadListing(req);
        const result = addressAi.search(listing);
        logActivity(logger, req, "recherche DPE (déterminer l'adresse)", {
          listingId: listing.id,
          mode: result.mode,
          candidates: result.candidates.length,
          champsRequisManquants: result.champsRequisManquants,
        });
        return res.json(result);
      } catch (err) {
        return next(err);
      }
    }
  );

  router.post("/listings/:id/address", async (req, res, next) => {
    try {
      const listing = loadListing(req);
      const cleaned = userAddressFromBody(req.body);

      if (cleaned) {
        const geo = await travel.geocodeAddress(cleaned);
        const source =
          req.body.address_source === "detected" ? "detected" : "manual";
        repositories.listings.setUserAddress(req.user.id, listing.id, {
          address: cleaned,
          lat: geo?.lat ?? null,
          lng: geo?.lon ?? null,
          source,
          linkedDpeNumero: linkedDpeNumeroFromBody(req.body, source),
        });
        logActivity(logger, req, "adresse réelle saisie", {
          listingId: listing.id,
          geocoded: Boolean(geo),
        });
      } else {
        repositories.listings.setUserAddress(req.user.id, listing.id, {
          address: null,
        });
        logActivity(logger, req, "adresse réelle effacée", {
          listingId: listing.id,
        });
      }

      repositories.listings.setInseeCode(listing.id, null, { force: true });
      // L'adresse pilote les caches propres à l'annonce (grand quartier, DVF) et
      // le verdict Immo Data : on repart de zéro pour ces entrées.
      for (const key of ["immo-data", "immo-data-quartier", "dvf-local"]) {
        repositories.enrichments.removeOne(listing.id, key);
      }

      // L'analyse de marché a besoin de l'INSEE : on résout la commune de façon
      // synchrone AVANT de répondre, pour que le rafraîchissement client du
      // widget (déclenché après le swap) trouve un code INSEE à jour.
      if (req.get("hx-request")) {
        await enrichment.runForListing(req.user.id, listing.id, {
          only: "commune",
        });
      }
      enrichment.schedule(req.user.id, listing.id);

      const updated = repositories.listings.findById(req.user.id, listing.id);

      if (!req.get("hx-request")) {
        return res.redirect(`/listings/${listing.id}`);
      }
      return res.render("partials/listing-location-block", {
        layout: false,
        listing: updated,
        linkedDpeInsights: linkedDpeInsightsForListing(
          updated,
          res.locals.fmt
        ),
      });
    } catch (err) {
      return next(err);
    }
  });

  /* ------------------------------ Projets ---------------------------- */

  router.post("/listings/:id/projects", (req, res, next) => {
    try {
      const listing = loadListing(req);
      // Les cases décochées n'arrivent pas dans le corps : une absence totale
      // signifie « aucun projet », donc repli sur le projet par défaut.
      const selected = [].concat(req.body.project_ids ?? []);
      const assigned = projectsService.setForListing(req.user.id, listing.id, selected);
      logActivity(logger, req, "projets de l'annonce modifiés", {
        listingId: listing.id,
        projectCount: assigned?.length,
      });

      const refreshed = repositories.listings.findById(req.user.id, listing.id);
      if (!req.get("hx-request")) {
        return res.redirect(`/listings/${listing.id}`);
      }
      // On renvoie la dropdown rouverte : l'utilisateur peut cocher plusieurs
      // projets d'affilée sans que le menu ne se referme à chaque changement.
      return res.render("partials/project-dropdown", {
        layout: false,
        listing: refreshed,
        projects: projectsService.list(req.user.id),
        open: true,
      });
    } catch (err) {
      return next(err);
    }
  });

  /* --------------------------- Financement --------------------------- */

  router.post("/listings/:id/financing", (req, res, next) => {
    try {
      const listing = loadListing(req);
      const current = financingFor(listing).params;
      const params = readListingFinancingForm(req.body, current);
      const result = financingForListing(listing, params);

      repositories.enrichments.saveListingResult(listing.id, "financing", {
        status: "ok",
        data: { params, result },
      });

      if (!req.get("hx-request")) {
        return res.redirect(`/listings/${listing.id}#financement`);
      }
      return res.render("partials/financing", {
        layout: false,
        listing,
        financing: { params, result },
      });
    } catch (err) {
      return next(err);
    }
  });

  /* ------------- Actualisation de tout le bloc Territoire ------------- */

  /** Code département de l'annonce (cache commune si dispo, sinon depuis l'INSEE). */
  function deptCodeFor(listing) {
    if (!listing.insee_code) return null;
    const commune = repositories.enrichments.findCommune(listing.insee_code, "commune");
    return commune?.data?.department?.code || departmentCodeFromInsee(listing.insee_code);
  }

  /** Vide le cache d'un provider selon sa portée, avant un rafraîchissement. */
  function resetScopeCache(listing, provider) {
    repositories.enrichments.removeOne(listing.id, provider.key);
    if (provider.scope === "commune" && listing.insee_code) {
      repositories.enrichments.removeCommune(listing.insee_code, provider.key);
    } else if (provider.scope === "department") {
      repositories.enrichments.removeDepartment(deptCodeFor(listing), provider.key);
    }
  }

  function marketEnrichmentProviders(providers) {
    return providers.filter(
      (provider) =>
        provider.group === "market" &&
        provider.key !== "financing" &&
        provider.key !== "prix-m2"
    );
  }

  async function refreshTerritoryProviders(userId, listing) {
    const providers = await enrichment.listProviders();
    const territory = providers.filter((provider) => provider.group === "territory");

    for (const provider of territory) {
      resetScopeCache(listing, provider);
    }

    for (const provider of territory) {
      await enrichment.runForListing(userId, listing.id, {
        only: provider.key,
        force: true,
      });
    }

    return repositories.listings.findById(userId, listing.id);
  }

  async function refreshMarketProviders(userId, listing) {
    const providers = await enrichment.listProviders();
    const market = marketEnrichmentProviders(providers);

    for (const provider of market) {
      resetScopeCache(listing, provider);
    }

    for (const provider of market) {
      await enrichment.runForListing(userId, listing.id, {
        only: provider.key,
        force: true,
      });
    }

    return repositories.listings.findById(userId, listing.id);
  }

  router.post("/listings/:id/enrich/marche", requireAdminForEnrichmentRefresh, async (req, res, next) => {
    try {
      const listing = loadListing(req);
      const refreshed = await refreshMarketProviders(listing.user_id, listing);
      const blocks = await enrichment.viewModel(refreshed);
      const otherProviders = marketEnrichmentProviders(blocks);

      if (!req.get("hx-request")) {
        return res.redirect(`/listings/${listing.id}`);
      }
      return res.render("partials/listing-market", {
        layout: false,
        listing: refreshed,
        otherProviders,
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post("/listings/:id/enrich/territoire", requireAdminForEnrichmentRefresh, async (req, res, next) => {
    try {
      const listing = loadListing(req);
      const refreshed = await refreshTerritoryProviders(listing.user_id, listing);
      const blocks = await enrichment.viewModel(refreshed);
      const communeProviders = blocks.filter((provider) => provider.group === "territory");

      if (!req.get("hx-request")) {
        return res.redirect(`/listings/${listing.id}`);
      }
      return res.render("partials/listing-territory", {
        layout: false,
        listing: refreshed,
        communeProviders,
      });
    } catch (err) {
      return next(err);
    }
  });

  /* ------------------- Nouvel essai d'un provider -------------------- */

  router.post("/listings/:id/enrich/:provider", requireAdminForEnrichmentRefresh, async (req, res, next) => {
    try {
      const listing = loadListing(req);
      const key = String(req.params.provider);
      const providers = await enrichment.listProviders();
      if (!providers.some((provider) => provider.key === key)) {
        throw HttpError.notFound("Provider inconnu.");
      }

      const providerDef = providers.find((provider) => provider.key === key);
      const shared = providerDef?.scope === "commune" || providerDef?.scope === "department";
      resetScopeCache(listing, providerDef || { key, scope: providerDef?.scope });

      // Les blocs d'affichage composent plusieurs portées : rafraîchir la facade
      // entraîne son complément départemental (prix / délinquance).
      const siblings = { "immo-data": "immo-data-dept", delinquance: "delinquance-dept" };
      const withListingScope = {
        "immo-data": ["dvf-local", "immo-data-quartier"],
      };
      const toRunAll = [
        key,
        siblings[key],
        ...(withListingScope[key] || []),
      ].filter(Boolean);
      for (const toRun of toRunAll) {
        const def = providers.find((provider) => provider.key === toRun) || providerDef;
        resetScopeCache(listing, def || { key: toRun });
        await enrichment.runForListing(listing.user_id, listing.id, {
          only: toRun,
          force: shared,
        });
      }

      const refreshed = repositories.listings.findById(listing.user_id, listing.id)
        || repositories.listings.findByIdOnly(listing.id);
      const blocks = await enrichment.viewModel(refreshed);
      const block = blocks.find((provider) => provider.key === key);
      const inlineCommuneHead =
        block?.group === "territory" &&
        blocks.filter((provider) => provider.group === "territory").length === 1;

      if (!req.get("hx-request")) {
        return res.redirect(`/listings/${listing.id}`);
      }
      return res.render("partials/enrichment-block", {
        layout: false,
        listing: refreshed,
        provider: block,
        eyebrow: inlineCommuneHead ? "Territoire" : null,
        sectionTitle: inlineCommuneHead ? "Commune" : null,
      });
    } catch (err) {
      return next(err);
    }
  });

  /* --------------------------- Suppression --------------------------- */

  router.post("/listings/:id/delete", (req, res, next) => {
    try {
      const listing = loadListing(req);
      repositories.listings.remove(req.user.id, listing.id);
      logActivity(logger, req, "annonce supprimée", { listingId: listing.id });
      if (req.get("hx-request")) {
        // Dernière annonce : la carte disparaît en swap « delete » mais la
        // pagination et l'état vide resteraient sinon affichés sans rechargement.
        if (repositories.listings.countByUser(req.user.id) === 0) {
          res.set("HX-Refresh", "true");
        }
        return res.status(200).send("");
      }
      req.session.flash = { type: "success", message: "Annonce supprimée." };
      return res.redirect("/listings");
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

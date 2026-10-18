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
import createAddressAiService, {
  enrichAddressAiCandidateMaps,
} from "../services/address-ai.service.js";
import createAddressDpeLookupService from "../services/address-dpe-lookup.service.js";
import createProbableLocationRunService from "../services/location/probable-location-run.service.js";
import createPhotoAnalysisRunService from "../services/photo-analysis/photo-analysis-run.service.js";
import { photoAnalysisViewModel } from "../lib/photo-analysis/view-model.js";
import * as photoLabels from "../lib/photo-analysis/labels.js";
import { PHOTO_ANALYSIS_PROVIDER } from "../lib/photo-analysis-cache.js";
import {
  RENT_ESTIMATE_PROVIDER,
  financingGrossYield,
  yieldAttractiveness,
} from "../lib/rent-estimate.js";
import { findCommuneRentEstimate } from "../services/enrichment/rent-estimate.provider.js";
import {
  LISTING_TRAVEL_PROVIDER,
  resolveTravelProject,
  resolveTravelOrigin,
  destinationsFromProject,
  needsListingTravelRefresh,
  webTravelTimesFor,
} from "../lib/listing-travel.js";
import createWorksPlanService from "../services/works-plan.service.js";
import { plannerOptions } from "../lib/works/works-plan.js";
import { financingWorksDefault } from "../lib/works/financing-works-default.js";
import { buildWorksOverview } from "../lib/works/works-overview.js";
import { buildWorksSummary } from "../lib/works/works-summary.js";
import createVisitSheetService from "../services/visit-sheet.service.js";
import createListingPostalCodeService from "../services/listing-postal-code.service.js";
import {
  listingPostalCodeBodySchema,
  listingPostalCodeQuerySchema,
} from "../schemas/listing-postal-code.js";
import createVisitQuestionsConfigService from "../services/visit-questions-config.service.js";
import { visitSheetBodySchema } from "../schemas/visit.js";
import { resolveAll } from "../lib/listing-field-provenance.js";
import { extractDescriptionFacts } from "../lib/listing-description-facts.js";
import { buildListingSpecs } from "../lib/listing-specs.js";
import { buildListingStructuredDataView } from "../lib/listing-structured-data.js";
import {
  LISTING_SPEC_RESTORE_LOCATION_KEY,
  listingFieldKeyParamSchema,
  listingFieldPatchBodySchema,
  listingFieldRestoreKeyParamSchema,
} from "../schemas/listing-field.patch.js";
import { buildVisitSheet } from "../lib/visit/visit-sheet-view.js";
import { listingPayloadSchema } from "../schemas/listing.payload.js";
import {
  buildAmortizationSchedule,
  editedFinancingKeys,
  financingForListing,
  listingFinancingParams,
  readListingFinancingForm,
} from "../services/financing.service.js";
import { logActivity } from "../lib/activity.js";
import { departmentCodeFromInsee } from "../lib/immo-data-market.js";
import { buildDpeInsights } from "../lib/dpe-insights.js";
import { resolveGoogleMapsListingUrl } from "../lib/google-maps-url.js";

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

async function userAddressMapsHref(listing) {
  if (!listing?.user_address) return null;
  return resolveGoogleMapsListingUrl(
    {
      lat: listing.user_lat,
      lng: listing.user_lng,
      query: listing.user_address,
    },
    { apiKey: config.googleMaps.apiKey }
  );
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
  const addressDpeLookup = createAddressDpeLookupService({ repositories, logger });
  const probableLocationRun = createProbableLocationRunService({
    repositories,
    logger,
  });
  const photoAnalysisRun = createPhotoAnalysisRunService({ repositories, logger });
  const worksPlans = createWorksPlanService({ repositories, photoAnalysisRun });
  const visitSheet = createVisitSheetService({ repositories });
  const postalCodes = createListingPostalCodeService({
    repositories,
    fetchJson: (url) => enrichment.fetchJson(url),
  });
  const visitQuestionsConfig = createVisitQuestionsConfigService({ repositories });

  /**
   * Analyse des photos pour la fiche : résultat stocké + modèle d'affichage.
   * Si rien n'est stocké alors que l'annonce a des photos (annonce antérieure
   * au déploiement, ou cache invalidé), on programme l'analyse.
   */
  function photoAnalysisForListing(listing, photos, dpeInsights) {
    const stored = photoAnalysisRun.readStored(listing);
    if (!stored.ready && stored.status === "pending") {
      enrichment.schedule(listing.user_id, listing.id, { only: PHOTO_ANALYSIS_PROVIDER });
    }
    return photoAnalysisViewModel(stored, photos, dpeInsights);
  }

  /**
   * État du calcul web des trajets. Sans adresse réelle géocodée, il n'y a rien
   * à calculer : la fiche affiche les trajets envoyés par l'extension.
   */
  function listingTravelState(listing, userId) {
    const project = resolveTravelProject(listing, projectsService, userId);
    const destinations = project?.id
      ? destinationsFromProject(repositories, project.id)
      : [];
    const row = repositories.enrichments.findOne(listing.id, LISTING_TRAVEL_PROVIDER);
    const active = resolveTravelOrigin(listing) != null && destinations.length > 0;
    const stale =
      row?.status === "ok" &&
      needsListingTravelRefresh(row.data, listing, project?.id, destinations);
    return {
      project,
      destinations,
      row,
      pending: active && (!row || stale),
      stale,
      error: active && row?.status === "error" ? row.error || null : null,
      webTrips: webTravelTimesFor(listing, row, project?.id, destinations),
    };
  }

  function maybeScheduleListingTravel(listing, userId) {
    const state = listingTravelState(listing, userId);
    if (!state.pending) return;
    if (state.stale) {
      repositories.enrichments.removeOne(listing.id, LISTING_TRAVEL_PROVIDER);
    }
    enrichment.schedule(userId, listing.id, { only: LISTING_TRAVEL_PROVIDER });
  }

  const NOTES_META_PROVIDER = "notes-meta";
  const SPECS_META_PROVIDER = "specs-meta";

  function notesUpdatedAtFor(listingId) {
    return repositories.enrichments.findOne(listingId, NOTES_META_PROVIDER)?.fetched_at || null;
  }

  function specsUpdatedAtFor(listing) {
    const edited = repositories.enrichments.findOne(listing.id, SPECS_META_PROVIDER)?.fetched_at;
    const saved = listing.last_saved_at;
    if (edited && saved) {
      return edited > saved ? edited : saved;
    }
    return edited || saved || null;
  }

  function bumpSpecsUpdatedAt(listingId) {
    repositories.enrichments.saveListingResult(listingId, SPECS_META_PROVIDER, {
      status: "ok",
      data: {},
    });
    return repositories.enrichments.findOne(listingId, SPECS_META_PROVIDER)?.fetched_at || null;
  }

  function locationUpdatedAtFor(listing) {
    const candidates = [
      repositories.enrichments.findOne(listing.id, "probable-location")?.fetched_at,
      listing.user_address_updated_at,
      listing.postal_override?.updated_at,
      listing.last_saved_at,
    ].filter(Boolean);
    if (!candidates.length) return null;
    return candidates.reduce((latest, value) => (value > latest ? value : latest));
  }

  function extensionPanelLocals(listing, userId) {
    const accountProjects = projectsService.list(userId);
    const travelConfigProject =
      (listing.projects && listing.projects[0]) ||
      accountProjects.find((project) => project.is_default) ||
      null;
    const travelProjectAddresses = travelConfigProject
      ? projectsService.listAddresses(userId, travelConfigProject.id)
      : [];
    const state = listingTravelState(listing, userId);
    const extensionData = listing.extension_data || {};
    const displayData = state.webTrips
      ? { ...extensionData, travel_times: state.webTrips }
      : extensionData;
    const showExtensionPanel =
      Object.keys(displayData).length > 0 || state.pending || Boolean(state.error);
    const extensionHasData =
      Object.keys(displayData).length > 0 || Boolean(state.webTrips);
    const extensionUpdatedAt =
      state.webTrips && state.row?.fetched_at
        ? state.row.fetched_at
        : Object.keys(extensionData).length > 0
          ? listing.last_saved_at
          : null;
    const extensionTravelRefreshable =
      resolveTravelOrigin(listing) != null && state.destinations.length > 0;

    return {
      listing,
      displayData,
      travelHint: state.webTrips ? "Depuis l'adresse enregistrée du bien." : null,
      travelConfigProject,
      travelProjectAddresses,
      travelPoll: state.pending,
      travelError: state.error,
      showExtensionPanel,
      extensionHasData,
      extensionUpdatedAt,
      extensionTravelRefreshable,
    };
  }

  function linkedDpeInsightsForListing(listing, fmt) {
    const numero = listing.linked_dpe_numero;
    if (!numero) return null;
    const record = repositories.dpe.findByNumero(numero);
    if (!record) return null;
    return buildDpeInsights(record, fmt);
  }

  /**
   * Corrections utilisateur a APPLIQUER (couche visite acceptee) + faits
   * extraits de la description. Base commune du resolveur de provenance.
   */
  function provenanceContext(listing) {
    return {
      descriptionFacts: extractDescriptionFacts(listing.description),
      overrides: visitSheet.appliedOverrides(listing),
    };
  }

  /** Locals du partial d'une ligne « Caractéristiques ». */
  function specRowLocals(listing, row, extra = {}) {
    return {
      listing,
      specKey: row.key,
      label: row.label,
      display: row.display,
      fieldKey: row.fieldKey,
      editModal: row.editModal,
      valueHoverHint: row.valueHoverHint,
      rawValue: row.rawValue,
      source: row.source,
      fieldInputKind: row.fieldInputKind,
      ...extra,
    };
  }

  /**
   * Réponse htmx d'une correction : la ligne modifiée et, en OOB, les lignes
   * calculées qui en dépendent (prix au m² après une correction de surface).
   */
  function listingSpecPatchLocals(listing, fmt, fieldKey, { fieldErrorMessage = null } = {}) {
    const { descriptionFacts, overrides } = provenanceContext(listing);
    const provenance = resolveAll({ listing, overrides, descriptionFacts });
    const specs = buildListingSpecs(listing, provenance, fmt);
    const row = specs.find((entry) => entry.fieldKey === fieldKey);
    if (!row) {
      throw HttpError.notFound("Caractéristique introuvable.");
    }
    const dependents = fieldErrorMessage
      ? []
      : specs.filter((entry) => entry.key && entry.dependsOn.includes(fieldKey));
    return {
      layout: false,
      primary: specRowLocals(listing, row, { fieldErrorMessage }),
      dependents: dependents.map((entry) => specRowLocals(listing, entry, { oob: true })),
    };
  }

  async function postalInseeCodeForSpecs(listing) {
    if (listing.postal_override) return listing.postal_override.insee_code;
    return repositories.postalInsee.resolveInsee(listing.postal_code, listing.city, {
      fetchJson: enrichment.fetchJson,
    });
  }

  async function listingSpecLocationRestoreLocals(listing, fmt, primaryKey) {
    const postalInseeCode = await postalInseeCodeForSpecs(listing);
    const { descriptionFacts, overrides } = provenanceContext(listing);
    const provenance = resolveAll({ listing, overrides, descriptionFacts });
    const specs = buildListingSpecs(listing, provenance, fmt, { postalInseeCode });
    const touchKeys = ["postal_code", "city"];
    const touched = specs.filter((entry) => touchKeys.includes(entry.key));
    if (!touched.length) {
      throw HttpError.notFound("Caractéristique introuvable.");
    }
    const primary = touched.find((entry) => entry.key === primaryKey) || touched[0];
    const dependents = touched.filter((entry) => entry.key !== primary.key);
    const insee = specs.find((entry) => entry.label === "Code INSEE");
    if (insee) dependents.push(insee);
    return {
      layout: false,
      primary: specRowLocals(listing, primary),
      dependents: dependents.map((entry) => specRowLocals(listing, entry, { oob: true })),
    };
  }

  /** Surface effective : correction de visite acceptee, sinon surface annoncée. */
  function effectiveSurface(listing) {
    const { overrides } = provenanceContext(listing);
    const o = overrides.surface;
    return o && typeof o.value === "number" && o.value > 0 ? o.value : null;
  }

  /**
   * View-model complet de la fiche de visite (catalogue + provenance « naturelle »
   * + questions / points de négociation déjà produits par l'IA + bilan). Rendu
   * uniquement sur la page dédiée /listings/:id/visite, jamais inliné dans la
   * fiche annonce (les libellés IA n'y ont pas leur place).
   */
  function buildVisitSheetFor(listing, fmt) {
    const photos = repositories.listings.listPhotos(listing.id);
    const { descriptionFacts } = provenanceContext(listing);
    const naturalResolved = resolveAll({ listing, overrides: {}, descriptionFacts });
    const photoAnalysis = photoAnalysisForListing(
      listing,
      photos,
      linkedDpeInsightsForListing(listing, fmt)
    );
    return buildVisitSheet({
      listing,
      photo: photos[0] || null,
      resolved: naturalResolved,
      photoAnalysis,
      priceHistory: repositories.listings.listPriceHistory(listing.id),
      sheet: visitSheet.getSheet(listing),
      isCopro: Boolean(descriptionFacts.is_copro),
      fmt,
      questionConfig: visitQuestionsConfig.get(),
    });
  }

  /**
   * Récap fixe de la modale « Pièces et état » avec la surface effective :
   * une surface corrigée pendant la visite (et acceptée) réajuste tout le
   * chiffrage, sur la fiche comme dans la modale.
   */
  function worksOverviewFor(listing, state, fmt, dpeInsights) {
    const overview = buildWorksOverview(
      listing,
      state.analysis,
      dpeInsights === undefined ? linkedDpeInsightsForListing(listing, fmt) : dpeInsights,
      state.photos
    );
    const surf = effectiveSurface(listing);
    if (surf != null) overview.surface = surf;
    return overview;
  }

  /** Travaux à prévoir d'après le plan des pièces (même chiffrage que la modale). */
  function worksSummaryForListing(listing, fmt, dpeInsights) {
    const state = worksPlans.getPlan(listing);
    const overview = worksOverviewFor(listing, state, fmt, dpeInsights);
    return buildWorksSummary({
      plan: state.plan,
      overview,
      propertyType: overview.propertyType || "",
      aiStatus: state.aiStatus,
      aiNewer: state.aiNewer,
    });
  }

  function linkedDpeNumeroFromBody(body) {
    const raw = body.linked_dpe_numero;
    if (typeof raw !== "string" || !raw.trim()) return null;
    const numero = raw.trim();
    return repositories.dpe.findByNumero(numero) ? numero : null;
  }

  /** DPE lié + analyse photo (view-model) après changement d'adresse HTMX. */
  function addressHtmxLocals(listing, fmt) {
    const photos = repositories.listings.listPhotos(listing.id);
    const linkedDpeInsights = linkedDpeInsightsForListing(listing, fmt);
    const photoAnalysis = photoAnalysisForListing(
      listing,
      photos,
      linkedDpeInsights
    );
    const worksSummary = photos.length ? worksSummaryForListing(listing, fmt, linkedDpeInsights) : null;
    return { photos, linkedDpeInsights, photoAnalysis, worksSummary };
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

  // Estimation de localisation : LLM + géocodage + isochrones (quotas tiers).
  const locationLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: () => config.isTest,
    keyGenerator: (req) =>
      req.user ? `u:${req.user.id}` : ipKeyGenerator(req.ip),
    handler: (req, res) =>
      res.status(429).json({
        error: {
          code: "rate_limited",
          message: "Trop d'estimations d'affilée. Patientez une minute.",
        },
      }),
  });

  // Chaque relance de l'estimation locative consomme un appel LLM + recherche web.
  const rentEstimateRunLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 5,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: () => config.isTest,
    keyGenerator: (req) =>
      req.user ? `u:${req.user.id}` : ipKeyGenerator(req.ip),
    // htmx ne remplace pas le panneau sur une réponse 4xx : on le renvoie avec un message.
    handler: (req, res, next) => {
      try {
        const listing = loadListing(req);
        if (!req.get("hx-request")) {
          return res.redirect(`/listings/${listing.id}`);
        }
        return renderRentEstimatePanel(req, res, listing, {
          rentNotice: "Trop de relances d'affilée. Réessayez dans quelques minutes.",
        });
      } catch (err) {
        return next(err);
      }
    },
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

  function financingFor(listing, dpeInsights = undefined) {
    const defaults = accountFinancingSettings();
    const stored = repositories.enrichments.findOne(listing.id, "financing");
    const worksDefault =
      listing.transaction_type === "rent"
        ? 0
        : financingWorksDefault({
            listing,
            repositories,
            analysis: photoAnalysisRun.readStored(listing),
            dpeInsights,
          });
    const params = listingFinancingParams(
      listing,
      defaults,
      stored?.data,
      worksDefault
    );
    const result = financingForListing(listing, params);
    const bundle = {
      params,
      result,
      edited: Array.isArray(stored?.data?.edited) ? stored.data.edited : [],
      amortization: buildAmortizationSchedule(result),
      updatedAt: stored?.fetched_at || null,
    };
    return attachFinancingRentYield(listing, bundle);
  }

  function attachFinancingRentYield(listing, bundle) {
    if (!bundle || listing.transaction_type === "rent") return bundle;
    const estimate = enrichment.rentEstimateFor(listing, {
      works: bundle.params.works,
    });
    const { position } = enrichment.pricePositionFor(listing, {
      works: bundle.params.works,
    });
    const marketEstimate =
      position?.primary?.estimate > 0
        ? Math.round(Number(position.primary.estimate))
        : null;
    const acquisition =
      (Number(bundle.result.price) || 0) +
      (Number(bundle.result.works) || 0);
    let rentYield = financingGrossYield({
      monthlyRentMid: estimate.monthly?.mid,
      price: bundle.result.price,
      works: bundle.result.works,
    });
    const rentYieldGrade =
      marketEstimate && acquisition > 0
        ? yieldAttractiveness(acquisition, marketEstimate)
        : null;
    if (rentYield && rentYieldGrade) {
      rentYield = { ...rentYield, attractiveness: rentYieldGrade };
    }
    return { ...bundle, rentYield, marketEstimate, rentYieldGrade };
  }

  /**
   * Budget travaux retenu pour le positionnement « prix + travaux » : montant
   * « Travaux » du financement (par défaut le milieu de la fourchette du plan
   * des pièces, modifiable par l'utilisateur) et fourchette du plan.
   *
   * @param {object} listing
   * @param {object} fmt
   * @param {{ works?: number, financing?: object|null, worksSummary?: object|null }} [known]
   *   valeurs déjà calculées par la route appelante (évite de recalculer)
   */
  function worksOptionsFor(listing, fmt, known = {}) {
    if (listing.transaction_type === "rent") return { works: 0, worksRange: null };
    const works =
      known.works != null
        ? Number(known.works) || 0
        : Number((known.financing || financingFor(listing)).params.works) || 0;
    let summary = known.worksSummary;
    if (summary === undefined) {
      summary = repositories.listings.listPhotos(listing.id).length
        ? worksSummaryForListing(listing, fmt)
        : null;
    }
    const worksRange =
      summary && !summary.unavailableReason && Number(summary.max) > 0
        ? { min: summary.min, max: summary.max }
        : null;
    return { works, worksRange };
  }

  /**
   * Fragment « Positionnement du prix » à renvoyer hors cible (OOB) quand le
   * budget travaux change. `null` tant que l'analyse de marché n'est pas en cache.
   */
  function pricePositionOobFor(listing, fmt, known = {}) {
    const { position, dvfRadius } = enrichment.pricePositionFor(
      listing,
      worksOptionsFor(listing, fmt, known)
    );
    return position ? { position, dvfRadius } : null;
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
      styles: ["/public/css/listings.css"],
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

      enrichment.scheduleAfterListingCapture(req.user.id, id, { created });

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
  async function listingEnrichmentPanels(listing, worksOptions = {}) {
    const providers = await enrichment.viewModel(listing, worksOptions);
    const communeProviders = providers.filter((p) => p.group === "territory");
    const otherProviders = providers.filter(
      (p) =>
        p.group === "market" && p.key !== "financing" && p.key !== "prix-m2"
    );
    const enrichmentPoll = enrichment.isEnrichmentPending(providers);
    return { communeProviders, otherProviders, enrichmentPoll };
  }

  /** Lance l'estimation locative si aucun résultat exploitable n'est en cache. */
  function maybeScheduleRentEstimate(listing) {
    if (listing.transaction_type === "rent") return;
    if (!(listing.surface > 0)) return;
    const row = repositories.enrichments.findOne(
      listing.id,
      RENT_ESTIMATE_PROVIDER
    );
    if (row?.status === "ok" && row.data?.rent_m2) return;
    if (row?.status === "error") return;
    enrichment.schedule(listing.user_id, listing.id, {
      only: RENT_ESTIMATE_PROVIDER,
      force: Boolean(row),
    });
  }

  function renderRentEstimatePanel(req, res, listing, { rentNotice = null } = {}) {
    const estimate = enrichment.rentEstimateFor(
      listing,
      worksOptionsFor(listing, res.locals.fmt)
    );
    const financingOob =
      listing.transaction_type !== "rent" &&
      estimate.status === "ok" &&
      estimate.monthly?.mid > 0
        ? financingFor(listing)
        : null;
    res.set("Cache-Control", "no-store");
    return res.render("partials/enrichment/rent-estimate", {
      layout: false,
      listing,
      estimate,
      financingOob,
      rentNotice,
    });
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
      const photos = repositories.listings.listPhotos(listing.id);
      const linkedDpeInsights = linkedDpeInsightsForListing(listing, res.locals.fmt);
      const worksSummary = photos.length
        ? worksSummaryForListing(listing, res.locals.fmt, linkedDpeInsights)
        : null;
      const financing = financingFor(listing, linkedDpeInsights);

      const { communeProviders, otherProviders, enrichmentPoll } =
        await listingEnrichmentPanels(
          listing,
          worksOptionsFor(listing, res.locals.fmt, { financing, worksSummary })
        );
      if (enrichmentPoll) {
        enrichment.schedule(listing.user_id, listing.id);
      }
      maybeScheduleRentEstimate(listing);
      const postalInseeCode = listing.postal_override
        ? listing.postal_override.insee_code
        : await repositories.postalInsee.resolveInsee(listing.postal_code, listing.city, {
            fetchJson: enrichment.fetchJson,
          });

      const userAddressMapsHrefValue = await userAddressMapsHref(listing);

      const offerPricePosition =
        listing.transaction_type !== "rent" && listing.price
          ? enrichment.pricePositionFor(
              listing,
              worksOptionsFor(listing, res.locals.fmt, { financing, worksSummary })
            ).position
          : null;

      const accountProjects = projectsService.list(req.user.id);
      maybeScheduleListingTravel(listing, req.user.id);
      const extensionPanel = extensionPanelLocals(listing, req.user.id);

      const photoAnalysis = photoAnalysisForListing(listing, photos, linkedDpeInsights);
      const priceHistory = repositories.listings.listPriceHistory(listing.id);

      // Provenance : valeur effective (corrections de visite appliquées) +
      // source retenue, pour les badges des caractéristiques. La fiche de
      // visite complète vit sur sa propre page (/listings/:id/visite).
      const { descriptionFacts, overrides: appliedOverrides } = provenanceContext(listing);
      const provenance = resolveAll({ listing, overrides: appliedOverrides, descriptionFacts });
      const listingSpecs = buildListingSpecs(listing, provenance, res.locals.fmt, {
        postalInseeCode,
      });
      const listingStructuredData = buildListingStructuredDataView(
        listing,
        { photoCount: photos.length, postalInseeCode },
        res.locals.fmt
      );

      res.render("listing", {
        title: res.locals.fmt.listingTitle(listing.title, listing.price) || "Annonce",
        listing,
        listingSpecs,
        listingStructuredData,
        userAddressMapsHref: userAddressMapsHrefValue,
        linkedDpeInsights,
        postalInseeCode,
        photos,
        photoAnalysis,
        photoLabels,
        worksSummary,
        scripts: [
          ...(photos.length ? ["/public/js/works-planner.js"] : []),
          ...(listing.transaction_type !== "rent" && listing.price
            ? ["/public/js/offer-wizard.js"]
            : []),
        ],
        priceHistory,
        // Le financement a son propre bloc ; les autres providers sont groupés
        // par vocation d'affichage (territoire vs analyse de marché), pas par
        // portée de cache (Immo Data est mis en cache en communal/départemental).
        communeProviders,
        otherProviders,
        enrichmentPoll,
        financing,
        offerPricePosition,
        projects: accountProjects,
        notesUpdatedAt: notesUpdatedAtFor(listing.id),
        specsUpdatedAt: specsUpdatedAtFor(listing),
        locationUpdatedAt: locationUpdatedAtFor(listing),
        ...extensionPanel,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/listings/:id/extension-panel", (req, res, next) => {
    try {
      const listing = loadListing(req);
      const fresh = repositories.listings.findById(req.user.id, listing.id);
      const panel = extensionPanelLocals(fresh, req.user.id);
      res.set("Cache-Control", "no-store");
      return res.render("partials/listing-extension-panel", {
        layout: false,
        ...panel,
      });
    } catch (err) {
      return next(err);
    }
  });

  router.get("/listings/:id/enrichment-live", async (req, res, next) => {
    try {
      const listing = loadListing(req);
      const panels = await listingEnrichmentPanels(
        listing,
        worksOptionsFor(listing, res.locals.fmt)
      );
      if (panels.enrichmentPoll) {
        enrichment.schedule(listing.user_id, listing.id);
      }
      maybeScheduleRentEstimate(listing);
      return res.render("partials/listing-enrichment-live", {
        layout: false,
        listing,
        ...panels,
      });
    } catch (err) {
      return next(err);
    }
  });

  /* ----------------------- Analyse des photos ------------------------ */

  /** Panneau « État visible du bien » (polling htmx tant que l'analyse tourne). */
  router.get("/listings/:id/photo-analysis/panel", (req, res, next) => {
    try {
      const listing = loadListing(req);
      const { photos, photoAnalysis } = addressHtmxLocals(
        listing,
        res.locals.fmt
      );
      return renderPhotoAnalysisPanel(req, res, listing, photoAnalysis, photos);
    } catch (err) {
      return next(err);
    }
  });

  /**
   * Résultat stocké brut (JSON). Ne lance jamais le modèle : sert au débogage
   * et aux futurs moteurs (travaux, estimation).
   */
  router.get("/listings/:id/photo-analysis/stored", (req, res, next) => {
    try {
      const listing = loadListing(req);
      res.set("Cache-Control", "no-store");
      return res.json(photoAnalysisRun.readStored(listing));
    } catch (err) {
      return next(err);
    }
  });

  /** Panneau de diagnostic (lots vision, exclusions) : administration uniquement. */
  router.get(
    "/listings/:id/photo-analysis/debug",
    requireAdminForEnrichmentRefresh,
    (req, res, next) => {
      try {
        const listing = loadListing(req);
        const row = repositories.enrichments.findOne(listing.id, PHOTO_ANALYSIS_PROVIDER);
        res.set("Cache-Control", "no-store");
        return res.render("partials/listing-photo-analysis-debug", {
          layout: false,
          listing,
          stored: photoAnalysisRun.readStored(listing),
          row,
          photoLabels,
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  function renderPhotoAnalysisPanel(
    req,
    res,
    listing,
    photoAnalysis,
    photos = null
  ) {
    const gallery = photos ?? repositories.listings.listPhotos(listing.id);
    const worksSummary = gallery.length
      ? worksSummaryForListing(listing, res.locals.fmt)
      : null;
    // Le budget travaux vient d'être chiffré : le financement et le
    // positionnement « prix + travaux » le reprennent.
    const financingOob =
      photoAnalysis?.ready && listing.transaction_type !== "rent"
        ? financingFor(listing)
        : null;
    res.set("Cache-Control", "no-store");
    return res.render("partials/listing-photo-analysis", {
      layout: false,
      listing,
      photos: gallery,
      photoAnalysis,
      photoLabels,
      worksSummary,
      worksHasPhotos: gallery.length > 0,
      refreshWorksHeadAside: true,
      financingOob,
      pricePositionOob: financingOob
        ? pricePositionOobFor(listing, res.locals.fmt, {
            financing: financingOob,
            worksSummary,
          })
        : null,
    });
  }

  /** Recalcul forcé (appels vision payants) : administration uniquement. */
  router.post(
    "/listings/:id/photo-analysis/run",
    requireAdminForEnrichmentRefresh,
    (req, res, next) => {
      try {
        const listing = loadListing(req);
        repositories.enrichments.removeOne(listing.id, PHOTO_ANALYSIS_PROVIDER);
        enrichment.schedule(listing.user_id, listing.id, { only: PHOTO_ANALYSIS_PROVIDER });
        logActivity(logger, req, "analyse des photos relancée", {
          listingId: listing.id,
          status: "pending",
        });

        if (!req.get("hx-request")) {
          return res.redirect(`/listings/${listing.id}`);
        }
        const { photos, linkedDpeInsights, photoAnalysis } = addressHtmxLocals(
          listing,
          res.locals.fmt
        );
        return renderPhotoAnalysisPanel(
          req,
          res,
          listing,
          photoAnalysisViewModel(
            photoAnalysisRun.readStored(listing),
            photos,
            linkedDpeInsights
          ),
          photos
        );
      } catch (err) {
        return next(err);
      }
    }
  );

  /* ----------------------- Valeur locative --------------------------- */

  router.get("/listings/:id/rent-estimate/panel", (req, res, next) => {
    try {
      const listing = loadListing(req);
      maybeScheduleRentEstimate(listing);
      return renderRentEstimatePanel(req, res, listing);
    } catch (err) {
      return next(err);
    }
  });

  router.post("/listings/:id/rent-estimate/run", rentEstimateRunLimiter, (req, res, next) => {
    try {
      const listing = loadListing(req);
      repositories.enrichments.removeOne(listing.id, RENT_ESTIMATE_PROVIDER);
      enrichment.schedule(listing.user_id, listing.id, {
        only: RENT_ESTIMATE_PROVIDER,
        force: true,
      });
      logActivity(logger, req, "estimation locative relancée", {
        listingId: listing.id,
        status: "pending",
      });

      if (!req.get("hx-request")) {
        return res.redirect(`/listings/${listing.id}`);
      }
      return renderRentEstimatePanel(req, res, listing);
    } catch (err) {
      return next(err);
    }
  });

  /* ------------------------- Plan de travaux ------------------------- */

  const worksJsonBody = express.json({ limit: "1mb" });

  function worksPlanResponse(state) {
    return {
      ok: true,
      plan: state.plan,
      stored: state.stored,
      aiStatus: state.aiStatus,
      aiAnalyzedAt: state.aiAnalyzedAt,
      aiNewer: state.aiNewer,
      updatedAt: state.updatedAt,
      photos: state.photos,
    };
  }

  /** Les erreurs de ces routes JSON restent en JSON (le site rend sinon une page). */
  function worksJsonError(res, next, err) {
    if (err instanceof HttpError && err.status < 500) {
      return res.status(err.status).json({ ok: false, error: { message: err.message } });
    }
    return next(err);
  }

  router.get("/listings/:id/works/plan", (req, res, next) => {
    try {
      const listing = loadListing(req);
      res.set("Cache-Control", "no-store");
      const state = worksPlans.getPlan(listing);
      return res.json({
        ...worksPlanResponse(state),
        options: plannerOptions(),
        overview: worksOverviewFor(listing, state, res.locals.fmt),
      });
    } catch (err) {
      return worksJsonError(res, next, err);
    }
  });

  /** Verdict et état général de la fiche, resynchronisés après le plan des pièces. */
  router.get("/listings/:id/works/summary", (req, res, next) => {
    try {
      const listing = loadListing(req);
      res.set("Cache-Control", "no-store");
      const worksSummary = worksSummaryForListing(listing, res.locals.fmt);
      const financing =
        listing.transaction_type === "rent" ? null : financingFor(listing);
      return res.render("partials/listing-works-summary", {
        layout: false,
        listing,
        worksSummary,
        financing,
        pricePositionOob: financing
          ? pricePositionOobFor(listing, res.locals.fmt, { financing, worksSummary })
          : null,
      });
    } catch (err) {
      return next(err);
    }
  });

  router.put("/listings/:id/works/plan", worksJsonBody, (req, res, next) => {
    try {
      const listing = loadListing(req);
      const state = worksPlans.save(listing, req.body?.plan);
      logActivity(logger, req, "plan de travaux enregistré", {
        listingId: listing.id,
        rooms: state.plan.rooms.length,
      });
      return res.json(worksPlanResponse(state));
    } catch (err) {
      return worksJsonError(res, next, err);
    }
  });

  router.delete("/listings/:id/works/plan", (req, res, next) => {
    try {
      const listing = loadListing(req);
      const state = worksPlans.reset(listing);
      logActivity(logger, req, "plan de travaux réinitialisé", { listingId: listing.id });
      return res.json(worksPlanResponse(state));
    } catch (err) {
      return worksJsonError(res, next, err);
    }
  });

  /* --------------------- Fiche de visite ----------------------- */

  const visitJsonBody = express.json({ limit: "256kb" });

  router.get("/listings/:id/visite", (req, res, next) => {
    try {
      const listing = loadListing(req);
      const sheet = buildVisitSheetFor(listing, res.locals.fmt);
      res.set("Cache-Control", "no-store");
      return res.render("visit", {
        title: `Préparer la visite · ${sheet.listing.title}`,
        listing,
        sheet,
        styles: ["/public/css/visit.css"],
        scripts: ["/public/js/visit-sheet.js"],
      });
    } catch (err) {
      return next(err);
    }
  });

  router.put("/listings/:id/visite", visitJsonBody, (req, res, next) => {
    try {
      const listing = loadListing(req);
      const parsed = visitSheetBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw HttpError.unprocessable("Fiche de visite invalide.");
      }
      const saved = visitSheet.saveSheet(listing, parsed.data);
      logActivity(logger, req, "fiche de visite enregistrée", {
        listingId: listing.id,
        answers: Object.keys(saved.visit.answers || {}).length,
        applyToSheet: saved.visit.applyToSheet,
        mode: saved.visit.mode,
      });
      return res.json({ ok: true, applyToSheet: saved.visit.applyToSheet, mode: saved.visit.mode });
    } catch (err) {
      return worksJsonError(res, next, err);
    }
  });

  const fieldPatchJson = express.json({ limit: "8kb" });

  router.patch("/listings/:id/fields/:fieldKey", fieldPatchJson, async (req, res, next) => {
    try {
      let listing = loadListing(req);
      const parsedBody = listingFieldPatchBodySchema.safeParse(req.body);
      if (!parsedBody.success) {
        throw HttpError.unprocessable("Valeur invalide.");
      }

      if ("restore" in parsedBody.data) {
        const parsedKey = listingFieldRestoreKeyParamSchema.safeParse(req.params.fieldKey);
        if (!parsedKey.success) {
          throw HttpError.unprocessable("Champ non modifiable depuis la fiche.");
        }
        const restoreKey = parsedKey.data;

        if (restoreKey === LISTING_SPEC_RESTORE_LOCATION_KEY) {
          if (!listing.postal_override) {
            throw HttpError.unprocessable("Aucune correction de localisation à rétablir.");
          }
          postalCodes.clear(listing);
          await refreshAfterPostalCodeChange(listing);
          listing = loadListing(req);
          logActivity(logger, req, "localisation de l'annonce rétablie depuis les caractéristiques", {
            listingId: listing.id,
          });
          if (req.get("HX-Request")) {
            const primaryKey = parsedBody.data.primaryKey || "postal_code";
            const specsUpdatedAt = bumpSpecsUpdatedAt(listing.id);
            return res.render("partials/listing-spec-patch", {
              ...(await listingSpecLocationRestoreLocals(listing, res.locals.fmt, primaryKey)),
              listing,
              specsUpdatedAt,
            });
          }
          return res.json({ ok: true, field: restoreKey });
        }

        const { descriptionFacts } = provenanceContext(listing);
        const result = visitSheet.restoreListingField(listing, restoreKey, { descriptionFacts });

        if (!result.ok) {
          throw HttpError.unprocessable(result.message);
        }

        logActivity(logger, req, "caractéristique rétablie à la valeur d'origine", {
          listingId: listing.id,
          field: restoreKey,
        });

        if (req.get("HX-Request")) {
          const specsUpdatedAt = bumpSpecsUpdatedAt(listing.id);
          return res.render("partials/listing-spec-patch", {
            ...listingSpecPatchLocals(listing, res.locals.fmt, restoreKey),
            listing,
            specsUpdatedAt,
          });
        }
        return res.json({ ok: true, field: restoreKey, resolved: result.resolved });
      }

      const parsedKey = listingFieldKeyParamSchema.safeParse(req.params.fieldKey);
      if (!parsedKey.success) {
        throw HttpError.unprocessable("Champ non modifiable depuis la fiche.");
      }
      const fieldKey = parsedKey.data;

      const { descriptionFacts } = provenanceContext(listing);
      const result = visitSheet.patchListingField(listing, fieldKey, parsedBody.data.value, {
        descriptionFacts,
      });

      if (!result.ok) {
        if (req.get("HX-Request")) {
          res.status(422);
          return res.render(
            "partials/listing-spec-patch",
            listingSpecPatchLocals(listing, res.locals.fmt, fieldKey, {
              fieldErrorMessage: result.message,
            })
          );
        }
        throw HttpError.unprocessable(result.message);
      }

      logActivity(logger, req, "caractéristique corrigée depuis la fiche", {
        listingId: listing.id,
        field: fieldKey,
      });

      if (req.get("HX-Request")) {
        const specsUpdatedAt = bumpSpecsUpdatedAt(listing.id);
        return res.render("partials/listing-spec-patch", {
          ...listingSpecPatchLocals(listing, res.locals.fmt, fieldKey),
          listing,
          specsUpdatedAt,
        });
      }
      return res.json({ ok: true, field: fieldKey, resolved: result.resolved });
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
        repositories.enrichments.saveListingResult(listing.id, NOTES_META_PROVIDER, {
          status: "ok",
          data: {},
        });
      }

      const updated = repositories.listings.findById(req.user.id, listing.id);

      if (!req.get("hx-request")) {
        return res.redirect(view === "card" ? "/listings" : `/listings/${listing.id}`);
      }

      if (view === "notes") {
        return res.render("partials/notes-status", {
          layout: false,
          savedAt: notesUpdatedAtFor(listing.id),
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
    async (req, res, next) => {
      try {
        const listing = loadListing(req);
        const result = addressAi.search(listing, { userId: req.user?.id });
        const candidates = await enrichAddressAiCandidateMaps(
          result.candidates,
          (query) => travel.geocodeAddress(query),
          { mapsApiKey: config.googleMaps.apiKey }
        );
        logActivity(logger, req, "recherche DPE (déterminer l'adresse)", {
          listingId: listing.id,
          mode: result.mode,
          candidates: candidates.length,
          champsRequisManquants: result.champsRequisManquants,
        });
        return res.json({ ...result, candidates });
      } catch (err) {
        return next(err);
      }
    }
  );

  /**
   * Résultat déjà calculé à l'enregistrement (enrichissement). Ne lance jamais
   * le LLM : la fiche interroge cet endpoint (éventuellement en poll).
   */
  router.get("/listings/:id/location/stored", (req, res, next) => {
    try {
      const listing = loadListing(req);
      res.set("Cache-Control", "no-store");
      return res.json(probableLocationRun.readStored(listing));
    } catch (err) {
      return next(err);
    }
  });

  /** Diagnostic zone probable (LLM, contraintes, heatmap) — administration uniquement. */
  router.get(
    "/listings/:id/location/debug",
    requireAdminForEnrichmentRefresh,
    (req, res, next) => {
      try {
        const listing = loadListing(req);
        const payload = probableLocationRun.readDebug(listing);
        res.set("Cache-Control", "no-store");
        return res.render("partials/listing-location-probable-debug", {
          layout: false,
          listing,
          // Ne pas nommer cette clé `debug` : EJS interprète `debug` comme option de compilation.
          locationDebug: payload,
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  /**
   * Recalcul forcé (LLM + géocodage). Réservé à un usage explicite ; la fiche
   * utilise GET /location/stored pour afficher le cache.
   */
  router.post(
    "/listings/:id/location/estimate",
    requireAdminForEnrichmentRefresh,
    jsonBody,
    locationLimiter,
    async (req, res, next) => {
      try {
        const listing = loadListing(req);
        const force = Boolean(req.body?.force);
        const result = await probableLocationRun.runForListing(listing, { force });

        logActivity(
          logger,
          req,
          result.cached ? "localisation probable (cache)" : "localisation probable estimée",
          {
            listingId: listing.id,
            status: result.status,
            constraintsUsed: result.constraints_used ?? 0,
            constraintsRejected: result.constraints_rejected ?? 0,
            cached: Boolean(result.cached),
          }
        );
        return res.json(result);
      } catch (err) {
        return next(err);
      }
    }
  );

  /** DPE de l'adresse saisie dans la modale, avant enregistrement. */
  router.post("/listings/:id/address/dpe-lookup", jsonBody, (req, res, next) => {
    try {
      const listing = loadListing(req);
      const body = req.body || {};
      const result = addressDpeLookup.lookup(listing, {
        street: typeof body.street === "string" ? body.street.slice(0, 120) : "",
        postalCode: typeof body.postal_code === "string" ? body.postal_code : "",
        city: typeof body.city === "string" ? body.city.slice(0, 80) : "",
      });
      logActivity(logger, req, "recherche DPE (adresse saisie)", {
        listingId: listing.id,
        status: result.status,
        candidates: result.candidates.length,
      });
      res.set("Cache-Control", "no-store");
      return res.json({ ok: true, ...result });
    } catch (err) {
      return next(err);
    }
  });

  /**
   * Résout la commune puis, sans appel LLM, copie la valeur locative
   * communale déjà connue : la fiche n'affiche pas d'état « en cours ».
   */
  async function resolveCommuneAndRent(userId, listingId) {
    await enrichment.runForListing(userId, listingId, { only: "commune" });
    const resolved = repositories.listings.findById(userId, listingId);
    if (resolved && findCommuneRentEstimate(repositories, resolved)) {
      await enrichment.runForListing(userId, listingId, {
        only: RENT_ESTIMATE_PROVIDER,
      });
    }
  }

  /* ------------------------ Code postal corrigé ---------------------- */

  /** Communes du code postal saisi (liste de choix de la modale). */
  router.get("/listings/:id/postal-code/communes", async (req, res, next) => {
    try {
      const listing = loadListing(req);
      const parsed = listingPostalCodeQuerySchema.safeParse(req.query);
      if (!parsed.success) throw HttpError.badRequest("Code postal invalide.");
      const result = await postalCodes.communesForPostalCode(parsed.data.postal_code);
      res.set("Cache-Control", "no-store");
      return res.render("partials/listing-postal-communes", {
        layout: false,
        result,
        selectedInsee: listing.postal_override?.insee_code || null,
      });
    } catch (err) {
      return next(err);
    }
  });

  /**
   * Après un changement de commune, tout ce qui dépend de la localisation est
   * recalculé (prix au m² communal, loyer, zone probable). La commune et le
   * loyer communal connu sont résolus avant la redirection pour que la fiche
   * affiche directement la nouvelle valorisation.
   */
  async function refreshAfterPostalCodeChange(listing) {
    for (const key of ["immo-data", "immo-data-quartier", "dvf-local", RENT_ESTIMATE_PROVIDER]) {
      repositories.enrichments.removeOne(listing.id, key);
    }
    try {
      await resolveCommuneAndRent(listing.user_id, listing.id);
    } catch (err) {
      logger.warn({ err: err.message, listingId: listing.id }, "commune après correction du code postal");
    }
    enrichment.schedule(listing.user_id, listing.id);
  }

  router.post("/listings/:id/postal-code", async (req, res, next) => {
    try {
      const listing = loadListing(req);
      const parsed = listingPostalCodeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw HttpError.unprocessable("Code postal ou commune invalide.");
      }
      const result = await postalCodes.save(listing, {
        postalCode: parsed.data.postal_code,
        inseeCode: parsed.data.insee_code,
      });
      if (!result.ok) {
        if (result.reason !== "unavailable") throw HttpError.unprocessable(result.message);
        req.session.flash = { type: "error", message: result.message };
        return res.redirect(`/listings/${listing.id}#listing-location`);
      }

      await refreshAfterPostalCodeChange(listing);
      logActivity(logger, req, "code postal corrigé", {
        listingId: listing.id,
        postalCode: parsed.data.postal_code,
        inseeCode: result.commune.insee_code,
      });
      req.session.flash = {
        type: "success",
        message: listing.user_address
          ? `Code postal corrigé : ${parsed.data.postal_code} ${result.commune.name}. L'adresse réelle saisie reste la référence de la valorisation.`
          : `Code postal corrigé : ${parsed.data.postal_code} ${result.commune.name}. La valorisation est recalculée sur cette commune.`,
      };
      return res.redirect(`/listings/${listing.id}#listing-location`);
    } catch (err) {
      return next(err);
    }
  });

  router.post("/listings/:id/postal-code/reset", async (req, res, next) => {
    try {
      const listing = loadListing(req);
      if (listing.postal_override) {
        postalCodes.clear(listing);
        await refreshAfterPostalCodeChange(listing);
        logActivity(logger, req, "code postal de l'annonce rétabli", {
          listingId: listing.id,
        });
        req.session.flash = {
          type: "success",
          message: "Code postal de l'annonce rétabli.",
        };
      }
      return res.redirect(`/listings/${listing.id}#listing-location`);
    } catch (err) {
      return next(err);
    }
  });

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
          linkedDpeNumero: linkedDpeNumeroFromBody(req.body),
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
      for (const key of [
        "immo-data",
        "immo-data-quartier",
        "dvf-local",
        RENT_ESTIMATE_PROVIDER,
        LISTING_TRAVEL_PROVIDER,
      ]) {
        repositories.enrichments.removeOne(listing.id, key);
      }

      // L'analyse de marché a besoin de l'INSEE : on résout la commune de façon
      // synchrone AVANT de répondre, pour que le rafraîchissement client du
      // widget (déclenché après le swap) trouve un code INSEE à jour.
      if (req.get("hx-request")) {
        await resolveCommuneAndRent(req.user.id, listing.id);
      }
      enrichment.schedule(req.user.id, listing.id, {
        skipProbableLocation: true,
      });
      // Adresse effacée : le cache web est supprimé ci-dessus, la fiche
      // réaffiche les trajets envoyés par l'extension.
      const updated = repositories.listings.findById(req.user.id, listing.id);
      if (resolveTravelOrigin(updated)) {
        enrichment.schedule(req.user.id, listing.id, {
          only: LISTING_TRAVEL_PROVIDER,
        });
      }

      if (!req.get("hx-request")) {
        return res.redirect(`/listings/${listing.id}`);
      }
      const addressLocals = addressHtmxLocals(updated, res.locals.fmt);
      return res.render("partials/listing-address-htmx-response", {
        layout: false,
        listing: updated,
        userAddressMapsHref: await userAddressMapsHref(updated),
        linkedDpeInsights: addressLocals.linkedDpeInsights,
        photos: addressLocals.photos,
        photoAnalysis: addressLocals.photoAnalysis,
        worksSummary: addressLocals.worksSummary,
        photoLabels,
        extensionPanel: extensionPanelLocals(updated, req.user.id),
        locationUpdatedAt: locationUpdatedAtFor(updated),
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
      const { params: current, edited: previouslyEdited } = financingFor(listing);
      const params = readListingFinancingForm(req.body, current);
      const result = financingForListing(listing, params);
      const edited = editedFinancingKeys(previouslyEdited, current, params);

      repositories.enrichments.saveListingResult(listing.id, "financing", {
        status: "ok",
        data: { params, result, edited },
      });
      const financingRow = repositories.enrichments.findOne(listing.id, "financing");

      if (!req.get("hx-request")) {
        return res.redirect(`/listings/${listing.id}#financement`);
      }
      return res.render("partials/financing", {
        layout: false,
        listing,
        financing: attachFinancingRentYield(listing, {
          params,
          result,
          amortization: buildAmortizationSchedule(result),
          updatedAt: financingRow?.fetched_at || null,
        }),
        // Le montant « Travaux » pilote aussi le positionnement « prix + travaux ».
        pricePositionOob: pricePositionOobFor(listing, res.locals.fmt, {
          works: params.works,
        }),
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
      const blocks = await enrichment.viewModel(
        refreshed,
        worksOptionsFor(refreshed, res.locals.fmt)
      );
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

  router.post("/listings/:id/enrich/trajets", requireAdminForEnrichmentRefresh, async (req, res, next) => {
    try {
      const listing = loadListing(req);
      repositories.enrichments.removeOne(listing.id, LISTING_TRAVEL_PROVIDER);
      await enrichment.runForListing(listing.user_id, listing.id, {
        only: LISTING_TRAVEL_PROVIDER,
        force: true,
      });
      const refreshed = repositories.listings.findById(listing.user_id, listing.id);
      const panel = extensionPanelLocals(refreshed, req.user.id);

      if (!req.get("hx-request")) {
        return res.redirect(`/listings/${listing.id}`);
      }
      return res.render("partials/listing-extension-panel", {
        layout: false,
        ...panel,
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
        "immo-data": ["dvf-local", "immo-data-quartier", RENT_ESTIMATE_PROVIDER],
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
      const blocks = await enrichment.viewModel(
        refreshed,
        key === "immo-data" ? worksOptionsFor(refreshed, res.locals.fmt) : {}
      );
      const block = blocks.find((provider) => provider.key === key);

      if (!req.get("hx-request")) {
        return res.redirect(`/listings/${listing.id}`);
      }
      return res.render("partials/enrichment-block", {
        layout: false,
        listing: refreshed,
        provider: block,
        hideProviderHead: block?.group === "territory",
        hideProviderAside: block?.group === "territory",
        hideProviderRefresh: block?.group === "territory",
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

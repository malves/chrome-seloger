/**
 * Liste des annonces, fiche détaillée et actions de suivi.
 *
 * Toutes les requêtes filtrent sur `user_id` : une annonce appartenant à un
 * autre compte renvoie 404, jamais 403 (on ne révèle pas son existence).
 */

import express from "express";
import HttpError from "../lib/http-error.js";
import { requireUser } from "../middlewares/auth.session.js";
import { DEFAULT_SORT, SORTS } from "../repositories/listings.repo.js";
import { STATUS_KEYS, PROPERTY_TYPE_KEYS } from "../lib/format.js";
import { accountFinancingSettings } from "../services/settings.service.js";
import createProjectsService from "../services/projects.service.js";
import {
  financingForListing,
  listingFinancingParams,
  readListingFinancingForm,
} from "../services/financing.service.js";
import { logActivity } from "../lib/activity.js";

/** Nombre d'annonces affichées par page de la liste. */
const PER_PAGE = 24;

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

  router.use("/listings", requireUser);

  /** Charge l'annonce du compte courant ou lève une 404. */
  function loadListing(req) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw HttpError.notFound("Annonce introuvable.");
    const listing = repositories.listings.findById(req.user.id, id);
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

  /* ------------------------------ Fiche ------------------------------ */

  router.get("/listings/:id", async (req, res, next) => {
    try {
      const listing = loadListing(req);
      const providers = await enrichment.viewModel(listing);

      res.render("listing", {
        title: listing.title || "Annonce",
        listing,
        photos: repositories.listings.listPhotos(listing.id),
        priceHistory: repositories.listings.listPriceHistory(listing.id),
        // Le financement a son propre bloc ; les autres providers sont groupés.
        communeProviders: providers.filter((p) => p.scope === "commune"),
        otherProviders: providers.filter(
          (p) => p.scope !== "commune" && p.key !== "financing"
        ),
        financing: financingFor(listing),
        projects: projectsService.list(req.user.id),
      });
    } catch (err) {
      next(err);
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
        repositories.listings.setStatus(req.user.id, listing.id, req.body.status);
        logActivity(logger, req, "statut d'annonce modifié", {
          listingId: listing.id,
          status: req.body.status,
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
        return res.render("partials/detail-header", {
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

  /* ------------------- Nouvel essai d'un provider -------------------- */

  router.post("/listings/:id/enrich/:provider", async (req, res, next) => {
    try {
      const listing = loadListing(req);
      const key = String(req.params.provider);
      const providers = await enrichment.listProviders();
      if (!providers.some((provider) => provider.key === key)) {
        throw HttpError.notFound("Provider inconnu.");
      }

      repositories.enrichments.removeOne(listing.id, key);
      await enrichment.runForListing(req.user.id, listing.id, { only: key });

      const refreshed = repositories.listings.findById(req.user.id, listing.id);
      const blocks = await enrichment.viewModel(refreshed);
      const block = blocks.find((provider) => provider.key === key);
      const inlineCommuneHead =
        block?.scope === "commune" &&
        blocks.filter((provider) => provider.scope === "commune").length === 1;

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
      req.session.flash = { type: "success", message: "Annonce supprimée." };
      return res.redirect("/listings");
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

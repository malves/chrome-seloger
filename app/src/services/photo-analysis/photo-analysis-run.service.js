/**
 * Exécution + persistance de l'analyse des photos (partagée entre les routes
 * HTTP et le provider d'enrichissement lancé à l'enregistrement).
 */

import createPhotoAnalysisService from "./photo-analysis.service.js";
import {
  PHOTO_ANALYSIS_PROVIDER,
  photoAnalysisCachePayload,
  photoAnalysisFromCache,
} from "../../lib/photo-analysis-cache.js";

function stripMeta(result) {
  const { cached, cached_at, ...rest } = result;
  return rest;
}

/** « insufficient » (aucune photo) est mémorisé pour ne pas retenter sans cesse. */
function shouldPersist(result) {
  return result.status !== "unavailable";
}

export default function createPhotoAnalysisRunService({
  repositories,
  logger,
  photoAnalysis,
} = {}) {
  const engine = photoAnalysis || createPhotoAnalysisService({ logger });

  function photosOf(listing) {
    return repositories.listings.listPhotos(listing.id);
  }

  /**
   * @returns {Promise<object>} résultat (avec cached / cached_at si applicable)
   */
  async function runForListing(listing, { force = false, persist = true } = {}) {
    if (!listing?.id) {
      return { status: "unavailable", warnings: ["Annonce invalide."] };
    }
    const photos = photosOf(listing);

    const row = repositories.enrichments.findOne(listing.id, PHOTO_ANALYSIS_PROVIDER);
    if (!force) {
      const cached = photoAnalysisFromCache(row, listing, photos);
      if (cached) return cached;
    }

    const result = await engine.analyze(listing, photos);

    if (persist && shouldPersist(result)) {
      repositories.enrichments.saveListingResult(listing.id, PHOTO_ANALYSIS_PROVIDER, {
        status: "ok",
        data: photoAnalysisCachePayload(listing, photos, stripMeta(result)),
        error: null,
      });
    }

    return { ...result, cached: false, cached_at: null };
  }

  /**
   * Lit le résultat stocké sans recalculer (fiche annonce).
   * @returns {{ ready: boolean, status?: string, ... }}
   */
  function readStored(listing) {
    if (!listing?.id) {
      return { ready: true, status: "unavailable", warnings: ["Annonce invalide."] };
    }
    const photos = photosOf(listing);
    if (!photos.length) {
      return { ready: true, status: "insufficient", warnings: ["Aucune photo dans l'annonce."] };
    }

    const row = repositories.enrichments.findOne(listing.id, PHOTO_ANALYSIS_PROVIDER);
    const hit = photoAnalysisFromCache(row, listing, photos);
    if (hit) return { ...hit, ready: true };

    if (row?.status === "error") {
      return {
        ready: true,
        status: "unavailable",
        warnings: [row.error || "Analyse indisponible."],
      };
    }

    return { ready: false, status: "pending" };
  }

  return { runForListing, readStored, engine };
}

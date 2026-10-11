/**
 * Analyse des photos : lancée automatiquement à l'enregistrement de l'annonce,
 * en parallèle des autres providers (`standalone`), sans bloc générique
 * (`display: false`) : la fiche a son propre panneau « État visible du bien ».
 */

import ProviderSkipped from "./skipped.js";
import createPhotoAnalysisRunService from "../photo-analysis/photo-analysis-run.service.js";
import { photoAnalysisCachePayload } from "../../lib/photo-analysis-cache.js";

export default {
  key: "photo-analysis",
  scope: "listing",
  order: 3,
  ttlDays: 365,
  label: "Analyse des photos",
  display: false,
  /** Lent (plusieurs appels vision) : exécuté hors de la chaîne séquentielle. */
  standalone: true,

  async fetch(ctx) {
    const { listing, repositories, logger } = ctx;
    const runner = createPhotoAnalysisRunService({ repositories, logger });

    if (!runner.engine.configured()) {
      throw new ProviderSkipped("Vision non configurée : analyse des photos ignorée.");
    }

    const photos = repositories.listings.listPhotos(listing.id);
    if (!photos.length) {
      throw new ProviderSkipped("Aucune photo : analyse non effectuée.");
    }

    const result = await runner.runForListing(listing, { force: false, persist: false });
    if (result.status === "unavailable") {
      throw new ProviderSkipped(result.warnings?.[0] || "Analyse des photos indisponible.");
    }

    const { cached, cached_at, ...toStore } = result;
    return photoAnalysisCachePayload(listing, photos, toStore);
  },
};

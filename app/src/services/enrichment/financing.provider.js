/**
 * Tableau de financement : calcul local, aucun appel externe.
 *
 * Les paramètres sont ceux du compte, surchargés par ceux déjà enregistrés
 * pour cette annonce depuis la fiche.
 */

import { financingWorksDefault } from "../../lib/works/financing-works-default.js";
import {
  PHOTO_ANALYSIS_PROVIDER,
  photoAnalysisFromCache,
} from "../../lib/photo-analysis-cache.js";
import { accountFinancingSettings } from "../settings.service.js";
import {
  financingForListing,
  listingFinancingParams,
} from "../financing.service.js";
import ProviderSkipped from "./skipped.js";

function readPhotoAnalysisStored(listing, repositories) {
  const photos = repositories.listings.listPhotos(listing.id);
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

export default {
  key: "financing",
  scope: "listing",
  order: 10,
  ttlDays: 0,
  label: "Financement",

  async fetch({ listing, repositories }) {
    if (listing.transaction_type === "rent") {
      throw new ProviderSkipped(
        "Bien en location : pas de tableau de financement."
      );
    }

    const defaults = accountFinancingSettings();
    const stored = repositories.enrichments.findOne(listing.id, "financing");
    const worksDefault = financingWorksDefault({
      listing,
      repositories,
      analysis: readPhotoAnalysisStored(listing, repositories),
    });
    const params = listingFinancingParams(
      listing,
      defaults,
      stored?.data,
      worksDefault
    );

    return {
      params,
      result: financingForListing(listing, params),
      edited: Array.isArray(stored?.data?.edited) ? stored.data.edited : [],
    };
  },
};

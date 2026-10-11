/**
 * Cache de l'analyse des photos par annonce (`listing_enrichments`).
 *
 * L'analyse n'est pas relancée tant que ses entrées n'ont pas changé : liste
 * ordonnée des photos, description et caractéristiques structurées qui
 * servent de contexte (pièces, chambres, surface, type, année).
 */

import crypto from "node:crypto";

export const PHOTO_ANALYSIS_PROVIDER = "photo-analysis";

/** Version du format stocké : incrémenter force un recalcul. */
export const PHOTO_ANALYSIS_FORMAT_VERSION = 2;

function hashParts(parts) {
  return crypto.createHash("sha1").update(parts.join("\x1e")).digest("hex");
}

/**
 * @param {object} listing
 * @param {string[]} photos - URLs ordonnées
 */
export function photoAnalysisInputFingerprint(listing, photos = []) {
  const parts = [
    String(PHOTO_ANALYSIS_FORMAT_VERSION),
    (photos || []).map((u) => String(u).trim()).join("\x1f"),
    String(listing?.description || "").trim(),
    String(listing?.property_type || ""),
    listing?.rooms != null ? String(listing.rooms) : "",
    listing?.bedrooms != null ? String(listing.bedrooms) : "",
    listing?.surface != null ? String(listing.surface) : "",
    listing?.year_built != null ? String(listing.year_built) : "",
  ];
  return hashParts(parts);
}

/**
 * @param {object|null} row - ligne `listing_enrichments` hydratée
 * @returns {object|null} analyse + métadonnées cache, ou null si absente / périmée
 */
export function photoAnalysisFromCache(row, listing, photos) {
  if (!row || row.status !== "ok" || !row.data?.result) return null;
  if (row.data.inputFingerprint !== photoAnalysisInputFingerprint(listing, photos)) {
    return null;
  }
  return { ...row.data.result, cached: true, cached_at: row.fetched_at || null };
}

export function photoAnalysisCachePayload(listing, photos, result) {
  return {
    inputFingerprint: photoAnalysisInputFingerprint(listing, photos),
    result,
  };
}

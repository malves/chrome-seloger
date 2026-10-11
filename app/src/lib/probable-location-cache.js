/**
 * Cache de l'estimation « zone probable » par annonce (`listing_enrichments`).
 *
 * On ne relance pas le LLM tant que l'entrée n'a pas changé (description, ville,
 * CP). L'adresse réelle géocodée ne fait pas partie de l'empreinte : elle masque
 * seulement la heatmap à l'affichage ; en l'effaçant on réutilise le même cache.
 */

import crypto from "node:crypto";

export const PROBABLE_LOCATION_PROVIDER = "probable-location";

function hashParts(parts) {
  return crypto.createHash("sha1").update(parts.join("\x1e")).digest("hex");
}

/** Empreinte des champs qui influencent le moteur (texte d'annonce). */
export function probableLocationInputFingerprint(listing) {
  const parts = [
    String(listing?.description || "").trim(),
    String(listing?.city || "").trim().toLowerCase(),
    String(listing?.postal_code || "").trim(),
  ];
  return hashParts(parts);
}

/** Ancienne empreinte (incluait lat/lng) — lecture seule pour les entrées déjà en base. */
export function probableLocationInputFingerprintLegacy(listing) {
  const parts = [
    String(listing?.description || "").trim(),
    String(listing?.city || "").trim().toLowerCase(),
    String(listing?.postal_code || "").trim(),
    listing?.user_lat != null ? String(listing.user_lat) : "",
    listing?.user_lng != null ? String(listing.user_lng) : "",
  ];
  return hashParts(parts);
}

function fingerprintMatchesStored(stored, listing) {
  if (!stored) return false;
  if (stored === probableLocationInputFingerprint(listing)) return true;
  if (stored === probableLocationInputFingerprintLegacy(listing)) return true;
  return false;
}

/**
 * @param {object|null} row - ligne `listing_enrichments` hydratée
 * @param {object} listing
 * @returns {object|null} résultat API + métadonnées cache, ou null si absent / périmé
 */
export function probableLocationFromCache(row, listing) {
  if (!row || row.status !== "ok" || !row.data?.result) return null;
  if (!fingerprintMatchesStored(row.data.inputFingerprint, listing)) return null;
  return {
    ...row.data.result,
    cached: true,
    cached_at: row.fetched_at || null,
  };
}

export function probableLocationCachePayload(listing, result) {
  return {
    inputFingerprint: probableLocationInputFingerprint(listing),
    result,
  };
}

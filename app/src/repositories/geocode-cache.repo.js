/**
 * Cache des géocodages (Nominatim / BAN) du moteur de localisation probable.
 *
 * On met aussi en cache les résultats négatifs (`found = 0`) pour éviter de
 * re-frapper un fournisseur qui ne connaît pas un lieu. La clé est l'empreinte
 * SHA-1 de `provider + requête normalisée`, calculée par l'appelant.
 */

import crypto from "node:crypto";

/** Empreinte stable d'une requête de géocodage. */
export function geocodeCacheKey(provider, query) {
  return crypto
    .createHash("sha1")
    .update(`${provider}::${String(query || "").trim().toLowerCase()}`)
    .digest("hex");
}

export default function createGeocodeCacheRepository(db) {
  const statements = {
    get: db.prepare("SELECT * FROM geocode_cache WHERE query_hash = ?"),
    upsert: db.prepare(
      `INSERT INTO geocode_cache
         (query_hash, provider, query, found, place, lat, lng, confidence, raw_json, created_at)
       VALUES
         (@query_hash, @provider, @query, @found, @place, @lat, @lng, @confidence, @raw_json, @created_at)
       ON CONFLICT(query_hash) DO UPDATE SET
         found = excluded.found,
         place = excluded.place,
         lat = excluded.lat,
         lng = excluded.lng,
         confidence = excluded.confidence,
         raw_json = excluded.raw_json,
         created_at = excluded.created_at`
    ),
    clear: db.prepare("DELETE FROM geocode_cache"),
  };

  return {
    /**
     * Retourne l'entrée en cache ou `null`. Une entrée négative existe mais
     * porte `found = 0` : `{ found: false }`.
     */
    get(provider, query) {
      const row = statements.get.get(geocodeCacheKey(provider, query));
      if (!row) return null;
      return {
        found: Boolean(row.found),
        provider: row.provider,
        place: row.place,
        lat: row.lat,
        lng: row.lng,
        confidence: row.confidence,
        raw: row.raw_json ? JSON.parse(row.raw_json) : null,
      };
    },

    /** Enregistre (ou remplace) un résultat, positif ou négatif. */
    set(provider, query, result) {
      const found = Boolean(result && result.found);
      statements.upsert.run({
        query_hash: geocodeCacheKey(provider, query),
        provider,
        query: String(query || ""),
        found: found ? 1 : 0,
        place: found ? result.place ?? null : null,
        lat: found ? result.lat ?? null : null,
        lng: found ? result.lng ?? null : null,
        confidence: found ? result.confidence ?? null : null,
        raw_json: result?.raw ? JSON.stringify(result.raw) : null,
        created_at: new Date().toISOString(),
      });
    },

    clear() {
      statements.clear.run();
    },
  };
}

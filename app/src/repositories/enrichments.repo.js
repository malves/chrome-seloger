/**
 * Accès aux résultats d'enrichissement.
 *
 * Deux portées :
 *  - `listing_enrichments` : résultat propre à une annonce ;
 *  - `commune_data` : cache partagé par code INSEE entre tous les comptes.
 */

import { nowIso } from "../lib/time.js";
import { fromJson, toJson } from "../lib/json.js";

function hydrate(row) {
  if (!row) return null;
  return { ...row, data: fromJson(row.data, null) };
}

export default function createEnrichmentsRepository(db) {
  const statements = {
    upsertListing: db.prepare(
      `INSERT INTO listing_enrichments (listing_id, provider, status, data, error, fetched_at)
       VALUES (@listing_id, @provider, @status, @data, @error, @fetched_at)
       ON CONFLICT(listing_id, provider) DO UPDATE SET
         status = excluded.status,
         data = excluded.data,
         error = excluded.error,
         fetched_at = excluded.fetched_at`
    ),
    listByListing: db.prepare(
      "SELECT * FROM listing_enrichments WHERE listing_id = ?"
    ),
    oneByListing: db.prepare(
      "SELECT * FROM listing_enrichments WHERE listing_id = ? AND provider = ?"
    ),
    removeByListing: db.prepare(
      "DELETE FROM listing_enrichments WHERE listing_id = ? AND provider = ?"
    ),

    getCommune: db.prepare(
      "SELECT * FROM commune_data WHERE insee_code = ? AND provider = ?"
    ),
    upsertCommune: db.prepare(
      `INSERT INTO commune_data (insee_code, provider, data, fetched_at)
       VALUES (@insee_code, @provider, @data, @fetched_at)
       ON CONFLICT(insee_code, provider) DO UPDATE SET
         data = excluded.data,
         fetched_at = excluded.fetched_at`
    ),
  };

  return {
    saveListingResult(listingId, provider, { status, data, error }) {
      statements.upsertListing.run({
        listing_id: listingId,
        provider,
        status,
        data: toJson(data),
        error: error ? String(error).slice(0, 2000) : null,
        fetched_at: nowIso(),
      });
    },

    findByListing(listingId) {
      const results = {};
      for (const row of statements.listByListing.all(listingId)) {
        results[row.provider] = hydrate(row);
      }
      return results;
    },

    findOne(listingId, provider) {
      return hydrate(statements.oneByListing.get(listingId, provider));
    },

    removeOne(listingId, provider) {
      statements.removeByListing.run(listingId, provider);
    },

    findCommune(inseeCode, provider) {
      return hydrate(statements.getCommune.get(inseeCode, provider));
    },

    saveCommune(inseeCode, provider, data) {
      statements.upsertCommune.run({
        insee_code: inseeCode,
        provider,
        data: toJson(data),
        fetched_at: nowIso(),
      });
    },
  };
}

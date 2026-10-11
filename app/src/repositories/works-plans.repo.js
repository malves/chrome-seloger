/**
 * Plans de travaux par annonce (`listing_works_plans`).
 */

import { nowIso } from "../lib/time.js";
import { fromJson, toJson } from "../lib/json.js";

function hydrate(row) {
  if (!row) return null;
  return { ...row, data: fromJson(row.data, null) };
}

export default function createWorksPlansRepository(db) {
  const statements = {
    find: db.prepare("SELECT * FROM listing_works_plans WHERE listing_id = ?"),
    upsert: db.prepare(
      `INSERT INTO listing_works_plans (listing_id, data, ai_analyzed_at, created_at, updated_at)
       VALUES (@listing_id, @data, @ai_analyzed_at, @now, @now)
       ON CONFLICT(listing_id) DO UPDATE SET
         data = excluded.data,
         ai_analyzed_at = excluded.ai_analyzed_at,
         updated_at = excluded.updated_at`
    ),
    remove: db.prepare("DELETE FROM listing_works_plans WHERE listing_id = ?"),
  };

  return {
    find(listingId) {
      return hydrate(statements.find.get(listingId));
    },

    upsert(listingId, data, { aiAnalyzedAt = null } = {}) {
      statements.upsert.run({
        listing_id: listingId,
        data: toJson(data),
        ai_analyzed_at: aiAnalyzedAt,
        now: nowIso(),
      });
      return this.find(listingId);
    },

    remove(listingId) {
      statements.remove.run(listingId);
    },
  };
}

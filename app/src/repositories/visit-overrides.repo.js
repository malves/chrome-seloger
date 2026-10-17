/**
 * Valeurs de champ corrigees par l'utilisateur + fiche de visite
 * (`listing_overrides`). Une ligne par annonce, creee seulement quand
 * l'utilisateur agit. `data` est un JSON (voir visit-sheet.service.js).
 */

import { nowIso } from "../lib/time.js";
import { fromJson, toJson } from "../lib/json.js";

function hydrate(row) {
  if (!row) return null;
  return { ...row, data: fromJson(row.data, null) };
}

export default function createVisitOverridesRepository(db) {
  const statements = {
    find: db.prepare("SELECT * FROM listing_overrides WHERE listing_id = ?"),
    upsert: db.prepare(
      `INSERT INTO listing_overrides (listing_id, data, created_at, updated_at)
       VALUES (@listing_id, @data, @now, @now)
       ON CONFLICT(listing_id) DO UPDATE SET
         data = excluded.data,
         updated_at = excluded.updated_at`
    ),
    remove: db.prepare("DELETE FROM listing_overrides WHERE listing_id = ?"),
  };

  return {
    find(listingId) {
      return hydrate(statements.find.get(listingId));
    },

    upsert(listingId, data) {
      statements.upsert.run({
        listing_id: listingId,
        data: toJson(data),
        now: nowIso(),
      });
      return this.find(listingId);
    },

    remove(listingId) {
      statements.remove.run(listingId);
    },
  };
}

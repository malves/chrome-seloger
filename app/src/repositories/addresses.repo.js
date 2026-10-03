/**
 * Carnet d'adresses du compte (table `addresses`).
 *
 * Source de vérité unique : une adresse y est stockée une seule fois par
 * compte (déduplication garantie par l'index unique `(user_id, address)`), et
 * les projets la réutilisent via `project_address_links`. Toutes les lectures
 * et écritures passent par `user_id` : une adresse d'un autre compte est
 * introuvable.
 */

import { nowIso } from "../lib/time.js";

const SELECT_ADDRESS = `
  SELECT a.id, a.user_id, a.label, a.address, a.lat, a.lng,
         a.created_at, a.updated_at,
         (SELECT COUNT(*) FROM project_address_links l WHERE l.address_id = a.id)
           AS project_count
  FROM addresses a
`;

export default function createAddressesRepository(db) {
  const statements = {
    byUser: db.prepare(
      `${SELECT_ADDRESS} WHERE a.user_id = ? ORDER BY a.label COLLATE NOCASE, a.address COLLATE NOCASE`
    ),
    byId: db.prepare(`${SELECT_ADDRESS} WHERE a.id = ? AND a.user_id = ?`),
    byAddress: db.prepare(
      `${SELECT_ADDRESS} WHERE a.user_id = ? AND a.address = ? COLLATE NOCASE LIMIT 1`
    ),
    insert: db.prepare(
      `INSERT INTO addresses (user_id, label, address, lat, lng, created_at, updated_at)
       VALUES (@user_id, @label, @address, @lat, @lng, @created_at, @updated_at)`
    ),
    update: db.prepare(
      `UPDATE addresses
       SET label = @label, address = @address, lat = @lat, lng = @lng, updated_at = @updated_at
       WHERE id = @id AND user_id = @user_id`
    ),
    remove: db.prepare("DELETE FROM addresses WHERE id = ? AND user_id = ?"),
  };

  return {
    listByUser(userId) {
      return statements.byUser.all(userId);
    },

    findById(userId, id) {
      return statements.byId.get(id, userId) || null;
    },

    findByAddress(userId, address) {
      return statements.byAddress.get(userId, String(address || "").trim()) || null;
    },

    insert({ userId, label = null, address, lat = null, lng = null }) {
      const at = nowIso();
      const info = statements.insert.run({
        user_id: userId,
        label: label || null,
        address,
        lat: lat ?? null,
        lng: lng ?? null,
        created_at: at,
        updated_at: at,
      });
      return statements.byId.get(info.lastInsertRowid, userId);
    },

    update({ id, userId, label = null, address, lat = null, lng = null }) {
      statements.update.run({
        id,
        user_id: userId,
        label: label || null,
        address,
        lat: lat ?? null,
        lng: lng ?? null,
        updated_at: nowIso(),
      });
      return statements.byId.get(id, userId) || null;
    },

    remove(userId, id) {
      return statements.remove.run(id, userId).changes > 0;
    },
  };
}

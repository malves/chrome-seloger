/**
 * Accès à la table `users`. Les routes ne contiennent aucun SQL.
 */

import { nowIso } from "../lib/time.js";
import { fromJson, toJson } from "../lib/json.js";

function hydrate(row) {
  if (!row) return null;
  return { ...row, settings: fromJson(row.settings, {}) };
}

export default function createUsersRepository(db) {
  const statements = {
    insert: db.prepare(
      `INSERT INTO users (email, password_hash, settings, created_at)
       VALUES (?, ?, ?, ?)`
    ),
    byId: db.prepare("SELECT * FROM users WHERE id = ?"),
    byEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
    updatePassword: db.prepare(
      "UPDATE users SET password_hash = ? WHERE id = ?"
    ),
    updateSettings: db.prepare("UPDATE users SET settings = ? WHERE id = ?"),
    remove: db.prepare("DELETE FROM users WHERE id = ?"),
    count: db.prepare("SELECT COUNT(*) AS n FROM users"),
  };

  return {
    create({ email, passwordHash, settings = {} }) {
      const info = statements.insert.run(
        email,
        passwordHash,
        toJson(settings) ?? "{}",
        nowIso()
      );
      return hydrate(statements.byId.get(info.lastInsertRowid));
    },

    findById(id) {
      return hydrate(statements.byId.get(id));
    },

    findByEmail(email) {
      return hydrate(statements.byEmail.get(String(email || "").trim()));
    },

    updatePassword(id, passwordHash) {
      statements.updatePassword.run(passwordHash, id);
    },

    updateSettings(id, settings) {
      statements.updateSettings.run(toJson(settings) ?? "{}", id);
    },

    /** Supprime le compte ; les données liées partent en cascade. */
    remove(id) {
      statements.remove.run(id);
    },

    count() {
      return statements.count.get().n;
    },
  };
}

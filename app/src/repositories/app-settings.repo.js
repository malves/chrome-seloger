/**
 * Paramètres globaux (`app_settings`), distincts des réglages par compte.
 */

import { nowIso } from "../lib/time.js";
import { fromJson, toJson } from "../lib/json.js";

export default function createAppSettingsRepository(db) {
  const getStmt = db.prepare("SELECT value FROM app_settings WHERE key = ?");
  const upsertStmt = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `);

  return {
    get(key) {
      const row = getStmt.get(String(key));
      return row ? fromJson(row.value, null) : null;
    },

    set(key, value) {
      upsertStmt.run(String(key), toJson(value) ?? "null", nowIso());
    },
  };
}

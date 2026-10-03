/**
 * Accès aux tables `extension_sessions` et `extension_auth_codes`.
 *
 * Aucun secret n'est stocké en clair : la clé de session comme le code
 * d'autorisation ne vivent en base que sous forme de SHA-256. Un secret perdu
 * n'est donc pas récupérable, l'extension refait simplement une autorisation.
 */

import crypto from "node:crypto";
import { nowIso } from "../lib/time.js";

const KEY_PREFIX = "ext_";

/** Durée de vie d'un code d'autorisation : le temps d'un aller-retour. */
export const AUTH_CODE_TTL_SECONDS = 300;

/** Secret aléatoire de 32 octets en base64url, préfixé pour la lisibilité des logs. */
export function generateKey() {
  return KEY_PREFIX + crypto.randomBytes(32).toString("base64url");
}

export function generateAuthCode() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashSecret(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export default function createExtensionRepository(db) {
  const statements = {
    insertSession: db.prepare(
      `INSERT INTO extension_sessions (user_id, key_hash, label, created_at)
       VALUES (?, ?, ?, ?)`
    ),
    sessionById: db.prepare("SELECT * FROM extension_sessions WHERE id = ?"),
    activeByHash: db.prepare(
      "SELECT * FROM extension_sessions WHERE key_hash = ? AND revoked_at IS NULL"
    ),
    touch: db.prepare(
      "UPDATE extension_sessions SET last_used_at = ? WHERE id = ?"
    ),
    listByUser: db.prepare(
      `SELECT id, label, last_used_at, created_at
       FROM extension_sessions
       WHERE user_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC`
    ),
    revoke: db.prepare(
      `UPDATE extension_sessions SET revoked_at = ?
       WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
    ),
    revokeByHash: db.prepare(
      `UPDATE extension_sessions SET revoked_at = ?
       WHERE key_hash = ? AND revoked_at IS NULL`
    ),

    insertCode: db.prepare(
      `INSERT INTO extension_auth_codes
         (code_hash, user_id, code_challenge, label, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ),
    codeByHash: db.prepare(
      "SELECT * FROM extension_auth_codes WHERE code_hash = ?"
    ),
    deleteCode: db.prepare("DELETE FROM extension_auth_codes WHERE code_hash = ?"),
    purgeCodes: db.prepare("DELETE FROM extension_auth_codes WHERE expires_at < ?"),
  };

  return {
    /** Crée une session et retourne la clé en clair, que seule l'extension garde. */
    createSession({ userId, label = null }) {
      const key = generateKey();
      const info = statements.insertSession.run(
        userId,
        hashSecret(key),
        label || null,
        nowIso()
      );
      return { key, record: statements.sessionById.get(info.lastInsertRowid) };
    },

    findActiveSession(key) {
      return statements.activeByHash.get(hashSecret(key)) || null;
    },

    touchSession(id) {
      statements.touch.run(nowIso(), id);
    },

    /** Sessions actives d'un compte, pour la page Paramètres. */
    listSessions(userId) {
      return statements.listByUser.all(userId);
    },

    revokeSession(id, userId) {
      return statements.revoke.run(nowIso(), id, userId).changes > 0;
    },

    revokeSessionByKey(key) {
      return (
        statements.revokeByHash.run(nowIso(), hashSecret(key)).changes > 0
      );
    },

    /** Code d'autorisation à usage unique, émis après le consentement. */
    createAuthCode({ userId, codeChallenge, label = null }) {
      const code = generateAuthCode();
      const now = Date.now();
      statements.purgeCodes.run(new Date(now).toISOString());
      statements.insertCode.run(
        hashSecret(code),
        userId,
        codeChallenge,
        label || null,
        new Date(now + AUTH_CODE_TTL_SECONDS * 1000).toISOString(),
        nowIso()
      );
      return { code };
    },

    /**
     * Retire le code et le retourne s'il est encore valide. Un code consommé
     * ou expiré ne ressort jamais : il est supprimé dans les deux cas.
     */
    consumeAuthCode(code) {
      const hash = hashSecret(code);
      const row = statements.codeByHash.get(hash);
      if (!row) return null;
      statements.deleteCode.run(hash);
      if (Date.parse(row.expires_at) < Date.now()) return null;
      return row;
    },
  };
}

/**
 * Correspondance code postal ↔ code INSEE (import HexaSmal).
 */

import { pickCommune } from "../services/enrichment/commune.provider.js";

const BATCH_SIZE = 1000;
const INSEE_RE = /^(\d{5}|2[AB]\d{3})$/i;

function normalizePostal(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 4) return digits.padStart(5, "0");
  if (digits.length === 5) return digits;
  return null;
}

function normalizeInsee(value) {
  const code = String(value || "").trim().toUpperCase();
  return INSEE_RE.test(code) ? code : null;
}

export function cleanPostalInseeQuery(value) {
  const text = String(value || "")
    .trim()
    .replace(/[^0-9A-Za-z]/g, "")
    .slice(0, 12);
  return text || null;
}

export default function createPostalInseeRepository(db) {
  const statements = {
    count: db.prepare("SELECT COUNT(*) AS n FROM postal_insee"),
    clear: db.prepare("DELETE FROM postal_insee"),
    insert: db.prepare(
      "INSERT OR IGNORE INTO postal_insee (postal_code, insee_code) VALUES (?, ?)"
    ),
    byPostal: db.prepare(
      "SELECT insee_code FROM postal_insee WHERE postal_code = ? ORDER BY insee_code"
    ),
    listAll: db.prepare(
      `SELECT postal_code, insee_code FROM postal_insee
       ORDER BY postal_code, insee_code
       LIMIT ? OFFSET ?`
    ),
    search: db.prepare(
      `SELECT postal_code, insee_code FROM postal_insee
       WHERE postal_code LIKE ? OR insee_code LIKE ?
       ORDER BY postal_code, insee_code
       LIMIT ? OFFSET ?`
    ),
    countSearch: db.prepare(
      `SELECT COUNT(*) AS n FROM postal_insee
       WHERE postal_code LIKE ? OR insee_code LIKE ?`
    ),
  };

  function likePattern(query) {
    return `%${query}%`;
  }

  const insertBatch = db.transaction((rows) => {
    let n = 0;
    for (const row of rows) {
      const postal = normalizePostal(row.postal_code);
      const insee = normalizeInsee(row.insee_code);
      if (!postal || !insee) continue;
      const info = statements.insert.run(postal, insee);
      n += info.changes;
    }
    return n;
  });

  const replaceAllTx = db.transaction((rows) => {
    statements.clear.run();
    let imported = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      imported += insertBatch(rows.slice(i, i + BATCH_SIZE));
    }
    return imported;
  });

  return {
    count() {
      return statements.count.get().n;
    },

    findInseeByPostal(postalCode) {
      const postal = normalizePostal(postalCode);
      if (!postal) return [];
      return statements.byPostal.all(postal).map((r) => r.insee_code);
    },

    countBrowse({ q = null } = {}) {
      const query = cleanPostalInseeQuery(q);
      if (!query) return statements.count.get().n;
      const pattern = likePattern(query);
      return statements.countSearch.get(pattern, pattern).n;
    },

    listBrowse({ q = null, limit = 25, offset = 0 } = {}) {
      const query = cleanPostalInseeQuery(q);
      if (!query) {
        return statements.listAll.all(limit, offset);
      }
      const pattern = likePattern(query);
      return statements.search.all(pattern, pattern, limit, offset);
    },

    replaceAll(rows) {
      if (!Array.isArray(rows) || !rows.length) {
        statements.clear.run();
        return 0;
      }
      return replaceAllTx(rows);
    },

    /**
     * Résout un code INSEE à partir du CP (et de la ville si ambiguïté).
     * `fetchJson` : optionnel, requis pour désambiguïser plusieurs communes.
     */
    async resolveInsee(postalCode, city, { fetchJson } = {}) {
      const codes = this.findInseeByPostal(postalCode);
      if (!codes.length) return null;
      if (codes.length === 1) return codes[0];

      if (!fetchJson) return null;

      const communes = [];
      for (const code of codes) {
        try {
          const commune = await fetchJson(
            `https://geo.api.gouv.fr/communes/${encodeURIComponent(code)}?fields=nom,code,population`
          );
          if (commune?.code) communes.push(commune);
        } catch {
          // Candidat ignoré.
        }
      }
      if (!communes.length) return null;
      const picked = pickCommune(communes, city);
      return picked?.code ?? null;
    },

    normalizePostal,
    normalizeInsee,
  };
}

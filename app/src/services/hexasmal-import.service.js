/**
 * Import du fichier HexaSmal (correspondance CP / INSEE).
 */

import { decodeHexasmalBuffer, parseHexasmalCsv } from "../lib/hexasmal-csv.js";
import { nowIso } from "../lib/time.js";

const SETTINGS_KEY = "hexasmal_import";
const MIN_ROWS = 1000;

export default function createHexasmalImportService({ repositories }) {
  const repo = repositories.postalInsee;
  const settings = repositories.appSettings;

  function meta() {
    const stored = settings.get(SETTINGS_KEY);
    return {
      imported_at: stored?.imported_at ?? null,
      row_count: stored?.row_count ?? repo.count(),
    };
  }

  function importBuffer(buffer) {
    if (!buffer || !buffer.length) {
      return { ok: false, error: "Fichier vide ou manquant." };
    }

    const text = decodeHexasmalBuffer(buffer);
    const rows = parseHexasmalCsv(text);
    if (rows.length < MIN_ROWS) {
      return {
        ok: false,
        error: `Fichier invalide ou incomplet (${rows.length} ligne(s) lues, attendu au moins ${MIN_ROWS}).`,
      };
    }

    const rowCount = repo.replaceAll(rows);
    settings.set(SETTINGS_KEY, {
      imported_at: nowIso(),
      row_count: rowCount,
    });

    return { ok: true, rowCount };
  }

  return {
    importBuffer,
    meta,
  };
}

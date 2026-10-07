/**
 * Parse le fichier HexaSmal (La Poste) : INSEE ; nom ; code postal ; …
 */

const INSEE_RE = /^(\d{5}|2[AB]\d{3})$/i;

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ";" && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function normalizePostal(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const digits = text.replace(/\D/g, "");
  if (digits.length === 4) return digits.padStart(5, "0");
  if (digits.length === 5) return digits;
  return null;
}

function normalizeInsee(raw) {
  const code = String(raw || "").trim().toUpperCase();
  return INSEE_RE.test(code) ? code : null;
}

/**
 * @param {string[]} cols
 * @returns {{ postal_code: string, insee_code: string } | null}
 */
export function parseHexasmalRow(cols) {
  if (!cols || cols.length < 3) return null;
  const insee_code = normalizeInsee(cols[0]);
  const postal_code = normalizePostal(cols[2]);
  if (!insee_code || !postal_code) return null;
  return { postal_code, insee_code };
}

/**
 * @param {string} text — contenu UTF-8 ou latin1 du fichier
 * @returns {{ postal_code: string, insee_code: string }[]}
 */
export function parseHexasmalCsv(text) {
  const rows = [];
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const cols = parseCsvLine(trimmed);
    const row = parseHexasmalRow(cols);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Décode un buffer uploadé (UTF-8 puis repli latin1).
 * @param {Buffer} buffer
 */
export function decodeHexasmalBuffer(buffer) {
  if (!buffer || !buffer.length) return "";
  const utf8 = buffer.toString("utf8");
  if (utf8.includes("\uFFFD") && /Libell./i.test(utf8.slice(0, 500))) {
    return buffer.toString("latin1");
  }
  return utf8;
}

/**
 * Validation et métadonnées de saisie des champs canoniques d'une annonce
 * (aligné sur FIELD_DEFS et la fiche de visite).
 */

import { FIELD_DEFS } from "./listing-field-provenance.js";

const MAX_TEXT = 2000;

/**
 * Métadonnées pour la saisie côté client.
 * @returns {{ kind: 'int'|'decimal'|'letter'|'text', unit: string|null, decimals: number|null }|null}
 */
export function fieldInputKind(fieldKey) {
  const def = FIELD_DEFS[fieldKey];
  if (!def) return null;
  if (def.type === "int") {
    return { kind: "int", unit: def.unit, decimals: 0 };
  }
  if (def.type === "number") {
    const currency = def.unit === "€" || def.unit === "€/an";
    return { kind: "decimal", unit: def.unit, decimals: currency ? 0 : 2 };
  }
  if (def.type === "letter") {
    return { kind: "letter", unit: null, decimals: null };
  }
  return { kind: "text", unit: def.unit, decimals: null };
}

/**
 * @param {string} fieldKey
 * @param {unknown} raw
 * @returns {{ ok: true, value: string|number } | { ok: false, message: string }}
 */
export function parseListingFieldValue(fieldKey, raw) {
  const def = FIELD_DEFS[fieldKey];
  if (!def) {
    return { ok: false, message: "Champ inconnu." };
  }

  if (raw === null || raw === undefined || raw === "") {
    return { ok: false, message: "Saisissez une valeur." };
  }

  if (def.type === "number" || def.type === "int") {
    const normalized = String(raw).trim().replace(/\s/g, "").replace(",", ".");
    const n = Number(normalized);
    if (!Number.isFinite(n)) {
      return { ok: false, message: "Saisissez un nombre valide." };
    }
    if (n < 0) {
      return { ok: false, message: "La valeur ne peut pas être négative." };
    }
    const value = def.type === "int" ? Math.round(n) : Math.round(n * 100) / 100;
    return { ok: true, value };
  }

  if (def.type === "letter") {
    const s = String(raw).trim().toUpperCase();
    if (!/^[A-G]$/.test(s)) {
      return { ok: false, message: "Saisissez une lettre de A à G." };
    }
    return { ok: true, value: s };
  }

  const s = String(raw).trim();
  if (!s) {
    return { ok: false, message: "Saisissez une valeur." };
  }
  return { ok: true, value: s.slice(0, MAX_TEXT) };
}

/** Valeur brute utilisée pour préremplir l'édition inline. */
export function coerceFieldValue(fieldKey, value) {
  const parsed = parseListingFieldValue(fieldKey, value);
  return parsed.ok ? parsed.value : null;
}

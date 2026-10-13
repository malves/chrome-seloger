(function () {
  "use strict";
/** Copie synchronisée avec app/src/lib/seloger-ufrn.js (content script). */

const UFRN_SCRIPT_ID = "__UFRN_LIFECYCLE_SERVERREQUEST__";
const UFRN_NEEDLE = "__UFRN_LIFECYCLE_SERVERREQUEST__";
const SALE_PRICE_LABEL = "Prix du bien";

/** Libellés à ignorer (frais annexes, pas le prix du bien). */
const EXCLUDED_PRICE_LABELS =
  /notaire|montant estimé du projet|honoraires|mensualité|crédit/i;

/** `energy.features[].type` SeLoger → colonne `listings`. */
const SELOGER_ENERGY_FIELDS = {
  energySource: "energy_source",
  heatingSystem: "heating_system",
  state: "property_condition",
};

/**
 * Décode le corps d'un script UFRN (`JSON.parse("…")` ou JSON direct).
 * @param {string} source
 * @returns {object|null}
 */
function decodeUfrnPayloadFromScript(source) {
  const text = String(source || "").trim();
  if (!text) return null;

  const parseEnvelope = text.match(/JSON\.parse\s*\(\s*"((?:\\.|[^"\\])*)"\s*\)/);
  if (parseEnvelope) {
    try {
      const jsonText = JSON.parse(`"${parseEnvelope[1]}"`);
      return JSON.parse(jsonText);
    } catch {
      return null;
    }
  }

  const assignment = text.match(
    new RegExp(
      `${UFRN_NEEDLE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?JSON\\.parse\\s*\\(\\s*"((?:\\\\.|[^"\\\\])*)"`
    )
  );
  if (assignment) {
    try {
      const jsonText = JSON.parse(`"${assignment[1]}"`);
      return JSON.parse(jsonText);
    } catch {
      return null;
    }
  }

  const jsonStart = text.indexOf("{");
  if (jsonStart !== -1) {
    const slice = text.slice(jsonStart);
    try {
      return JSON.parse(slice);
    } catch {
      // Objet embarqué dans une expression plus large : on tente le motif historique.
    }
  }

  return null;
}

/**
 * @param {string} html
 * @returns {object|null} payload racine UFRN
 */
function ufrnPayloadFromHtml(html) {
  if (typeof html !== "string" || !html.includes(UFRN_NEEDLE)) return null;

  const idPattern = new RegExp(
    `<script[^>]*\\bid\\s*=\\s*["']${UFRN_SCRIPT_ID}["'][^>]*>([\\s\\S]*?)<\\/script>`,
    "i"
  );
  const byId = html.match(idPattern);
  if (byId) {
    const payload = decodeUfrnPayloadFromScript(byId[1]);
    if (payload) return payload;
  }

  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = match[1];
    if (!body.includes(UFRN_NEEDLE)) continue;
    const payload = decodeUfrnPayloadFromScript(body);
    if (payload) return payload;
  }

  const start = html.indexOf(UFRN_NEEDLE);
  const chunk = html.slice(start, start + 2_000_000);
  const legacy = chunk.match(/JSON\.parse\("((?:\\.|[^"\\])*)"\)/);
  if (legacy) {
    try {
      const jsonText = JSON.parse(`"${legacy[1]}"`);
      return JSON.parse(jsonText);
    } catch {
      return null;
    }
  }

  return null;
}

/** @param {string} html */
function ufrnClassifiedSectionsFromHtml(html) {
  const payload = ufrnPayloadFromHtml(html);
  return payload?.app_cldp?.data?.classified?.sections ?? null;
}

/**
 * « 145 000 € », « 4 880,51 €/m² » → entier euros (145000) ou null.
 * @param {unknown} value
 * @returns {number|null}
 */
function euroFormattedToInteger(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  }
  const text = String(value || "").trim();
  if (!text) return null;
  if (!/€/.test(text)) {
    const plain = text.replace(/[^\d]/g, "");
    if (!plain) return null;
    const number = Number(plain);
    return Number.isFinite(number) && number >= 100 ? Math.round(number) : null;
  }
  const match = text.match(/\d[\d\s\u00a0\u202f.]*/);
  if (!match) return null;
  const digits = match[0].replace(/[^\d]/g, "");
  if (!digits) return null;
  const number = Number(digits);
  return Number.isFinite(number) && number >= 100 ? Math.round(number) : null;
}

function labelMain(node) {
  const label = node?.label?.main;
  return label != null ? String(label).trim() : "";
}

function isExcludedPriceLabel(label) {
  return EXCLUDED_PRICE_LABELS.test(label);
}

/**
 * @param {object} node
 * @returns {{ formatted: string, pricePerM2Formatted: string|null }|null}
 */
function readPriceNode(node) {
  if (!node || typeof node !== "object") return null;
  const label = labelMain(node);
  if (label !== SALE_PRICE_LABEL || isExcludedPriceLabel(label)) return null;
  const formatted =
    node.value?.main?.value != null ? String(node.value.main.value).trim() : "";
  if (!formatted) return null;
  const price = euroFormattedToInteger(formatted);
  if (price == null) return null;
  const alt = node.value?.alt?.value;
  const pricePerM2Formatted =
    alt != null && String(alt).trim() ? String(alt).trim() : null;
  return { price, formatted, pricePerM2Formatted };
}

/**
 * Repère le bloc « Prix du bien » sous `sections.price.base`.
 * @param {object} sections
 */
function salePriceFromSeLogerSections(sections) {
  const base = sections?.price?.base;
  if (!base || typeof base !== "object") return null;
  if (base.type && String(base.type).toUpperCase() !== "SALE") return null;

  const direct = readPriceNode(base.main);
  if (direct) return direct;

  for (const value of Object.values(base)) {
    if (!value || typeof value !== "object") continue;
    const label = labelMain(value);
    if (label === SALE_PRICE_LABEL) {
      const parsed = readPriceNode(value);
      if (parsed) return parsed;
    }
  }

  return findSalePriceByLabel(base);
}

/** Recherche en profondeur limitée à `sections.price.base`. */
function findSalePriceByLabel(base, depth = 0) {
  if (!base || typeof base !== "object" || depth > 8) return null;
  if (labelMain(base) === SALE_PRICE_LABEL) {
    const parsed = readPriceNode(base);
    if (parsed) return parsed;
  }
  for (const value of Object.values(base)) {
    if (!value || typeof value !== "object") continue;
    const label = labelMain(value);
    if (label && isExcludedPriceLabel(label)) continue;
    if (label === SALE_PRICE_LABEL) {
      const parsed = readPriceNode(value);
      if (parsed) return parsed;
    }
    const nested = findSalePriceByLabel(value, depth + 1);
    if (nested) return nested;
  }
  return null;
}

/**
 * @typedef {'ok'|'ufrn_script_missing'|'price_not_found'} SeLogerPriceStatus
 */

/**
 * Résolution du prix de vente SeLoger : JSON-LD puis UFRN (pas de DOM).
 * @param {{ jsonLdPrice?: unknown, sections?: object|null }} args
 * @returns {{
 *   price: number|null,
 *   formatted: string|null,
 *   pricePerM2Formatted: string|null,
 *   source: 'json_ld'|'ufrn'|null,
 *   status: SeLogerPriceStatus
 * }}
 */
function resolveSeLogerSalePrice({ jsonLdPrice, sections }) {
  const fromLd = euroFormattedToInteger(jsonLdPrice);
  if (fromLd != null) {
    return {
      price: fromLd,
      formatted: null,
      pricePerM2Formatted: null,
      source: "json_ld",
      status: "ok",
    };
  }

  if (!sections) {
    return {
      price: null,
      formatted: null,
      pricePerM2Formatted: null,
      source: null,
      status: "ufrn_script_missing",
    };
  }

  const fromUfrn = salePriceFromSeLogerSections(sections);
  if (fromUfrn) {
    return {
      price: fromUfrn.price,
      formatted: fromUfrn.formatted,
      pricePerM2Formatted: fromUfrn.pricePerM2Formatted,
      source: "ufrn",
      status: "ok",
    };
  }

  return {
    price: null,
    formatted: null,
    pricePerM2Formatted: null,
    source: null,
    status: "price_not_found",
  };
}

/**
 * @param {object} sections — `classified.sections`
 * @returns {{energy_source?: string, heating_system?: string, property_condition?: string}}
 */
function energyDetailsFromSeLogerSections(sections) {
  const features = sections?.energy?.features;
  const out = {};
  if (!Array.isArray(features)) return out;
  for (const feature of features) {
    const column = SELOGER_ENERGY_FIELDS[feature?.type];
    const value = feature?.value != null ? String(feature.value).trim() : "";
    if (column && value && !out[column]) out[column] = value;
  }
  return out;
}

/** @param {Document} document */
function ufrnClassifiedSectionsFromDocument(document) {
  if (!document || typeof document.getElementById !== "function") return null;

  const byId = document.getElementById(UFRN_SCRIPT_ID);
  if (byId?.textContent) {
    const payload = decodeUfrnPayloadFromScript(byId.textContent);
    if (payload) return payload?.app_cldp?.data?.classified?.sections ?? null;
  }

  for (const script of document.querySelectorAll("script")) {
    const body = script.textContent || "";
    if (!body.includes(UFRN_NEEDLE)) continue;
    const payload = decodeUfrnPayloadFromScript(body);
    if (payload) return payload?.app_cldp?.data?.classified?.sections ?? null;
  }

  return null;
}

  self.CarnetSeLogerUfrn = {
    decodeUfrnPayloadFromScript,
    ufrnClassifiedSectionsFromDocument,
    resolveSeLogerSalePrice,
    euroFormattedToInteger,
    salePriceFromSeLogerSections,
  };
})();

/**
 * Calculs purs autour de l'estimation locative : loyer mensuel, rendement brut.
 */

import { listingTerritory } from "./listing-territory.js";

export const RENT_ESTIMATE_PROVIDER = "rent-estimate";

/** Clé `commune_data` : estimations sans adresse, partagées par code INSEE. */
export const RENT_ESTIMATE_COMMUNE_PROVIDER = "rent-estimate-commune";

/** Version du payload stocké : incrémenter pour forcer un recalcul. */
export const RENT_ESTIMATE_VERSION = 2;

export const RENT_ESTIMATE_TTL_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

const RENT_ESTIMATE_ERROR_LABELS = {
  llm_not_configured: "Estimation locative non configurée (clé API manquante).",
  rent_empty_response: "Réponse vide du service d'estimation.",
  rent_invalid_response: "Réponse du service d'estimation illisible.",
};

const RENT_HTTP_UNAVAILABLE =
  "Le service d'estimation est momentanément indisponible, réessayez.";

/**
 * Message d'erreur stocké après un échec HTTP (sans corps HTML).
 */
export function buildRentHttpError(status, body = "") {
  const code = `rent_http_${status}`;
  const trimmed = String(body || "").trim();
  if (!trimmed || trimmed.startsWith("<")) return code;
  try {
    const json = JSON.parse(trimmed);
    const msg = json?.error?.message ?? json?.message;
    if (typeof msg === "string" && msg.trim()) {
      const short = msg.trim().replace(/\s+/g, " ").slice(0, 160);
      return `${code}: ${short}`;
    }
  } catch {
    // corps non JSON
  }
  return code;
}

/** Libellé affiché à partir du code d'erreur persisté. */
export function rentEstimateErrorMessage(error) {
  if (!error) return "Estimation locative indisponible.";
  if (RENT_ESTIMATE_ERROR_LABELS[error]) return RENT_ESTIMATE_ERROR_LABELS[error];
  if (/^rent_http_\d+/.test(error)) return RENT_HTTP_UNAVAILABLE;
  return error;
}

const RENT_M2_MIN = 3;
const RENT_M2_MAX = 80;

const GRANULARITY_LABELS = {
  address: "Autour de l'adresse",
  street: "À l'échelle de la rue",
  neighborhood: "À l'échelle du quartier",
  commune: "À l'échelle de la commune",
};

export function granularityLabel(key) {
  return GRANULARITY_LABELS[key] || "Secteur";
}

/** Loyer mensuel hors charges = €/m² × surface, arrondi à l'euro. */
export function monthlyRent(rentM2, surface) {
  if (!(rentM2 > 0) || !(surface > 0)) return null;
  return Math.round(rentM2 * surface);
}

/** Rendement brut annuel en % (2 décimales). */
export function grossYield(annualRent, price) {
  if (!(annualRent > 0) || !(price > 0)) return null;
  return Math.round((annualRent / price) * 10000) / 100;
}

/**
 * Rendement brut affiché dans le financement : loyer annuel estimé ÷ (prix
 * retenu + travaux).
 */
export function financingGrossYield({ monthlyRentMid, price, works = 0 }) {
  if (!(monthlyRentMid > 0)) return null;
  const annualRent = monthlyRentMid * 12;
  const acquisition =
    Math.max(0, Number(price) || 0) + Math.max(0, Number(works) || 0);
  const pct = grossYield(annualRent, acquisition);
  if (pct == null) return null;
  return { annualRent, pct };
}

/** Seuils de la note rendement A–F (A = meilleur rendement pour l'acheteur). */
const YIELD_GRADE_BANDS = [
  { min: 118, grade: "A", grade_label: "Excellent rendement" },
  { min: 109, grade: "B", grade_label: "Très bon rendement" },
  { min: 103, grade: "C", grade_label: "Légèrement au-dessus du marché" },
  { min: 97, grade: "D", grade_label: "Rendement du marché" },
  { min: 87, grade: "E", grade_label: "En dessous du marché" },
  { min: -Infinity, grade: "F", grade_label: "Rendement faible" },
];

/**
 * Note A–F à partir de l'indice 100 = rendement au prix du marché
 * (plus haut = meilleur rendement).
 */
export function yieldGradeFromIndex(index) {
  if (!Number.isFinite(index)) return { grade: null, grade_label: null };
  for (const band of YIELD_GRADE_BANDS) {
    if (index >= band.min) {
      return { grade: band.grade, grade_label: band.grade_label };
    }
  }
  return { grade: "F", grade_label: "Rendement faible" };
}

/**
 * Attractivité du rendement brut face à l'estimation marché (même référence
 * que le positionnement du prix). Indice = estimation ÷ coût d'entrée × 100
 * (prix affiché + travaux retenus).
 */
export function yieldAttractiveness(acquisitionPrice, marketEstimate) {
  if (!(acquisitionPrice > 0) || !(marketEstimate > 0)) return null;
  const index = Math.round((marketEstimate / acquisitionPrice) * 100);
  let tone;
  if (index >= 103) tone = "ok";
  else if (index >= 97) tone = "mid";
  else tone = "high";
  const { grade, grade_label } = yieldGradeFromIndex(index);
  return { index, grade, grade_label, tone };
}

export function clampRentM2(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < RENT_M2_MIN || value > RENT_M2_MAX) return null;
  return Math.round(value * 10) / 10;
}

/** Remet low ≤ mid ≤ high et écarte les valeurs hors bornes. */
export function normalizeRentBand(band) {
  if (!band || typeof band !== "object") return null;
  const raw = [band.low, band.mid, band.high].map(clampRentM2);
  const values = raw.filter((v) => v != null).sort((a, b) => a - b);
  if (!values.length) return null;
  if (values.length === 1) {
    return { low: values[0], mid: values[0], high: values[0] };
  }
  if (values.length === 2) {
    return { low: values[0], mid: values[1], high: values[1] };
  }
  return { low: values[0], mid: values[1], high: values[2] };
}

/** Le loyer au m² dépend du type de bien : une entrée par type dans le cache communal. */
export function communeRentTypeKey(propertyType) {
  return propertyType === "apartment" || propertyType === "house"
    ? propertyType
    : "other";
}

/** Une estimation sans adresse saisie vaut pour toute la commune. */
export function isCommuneScopedRent(listing) {
  return Boolean(listing?.insee_code) && listingTerritory(listing).source !== "user";
}

/** Estimation communale encore valide pour ce type de bien, sinon `null`. */
export function pickCommuneRent(communeData, propertyType, { now = Date.now() } = {}) {
  const entry = communeData?.by_type?.[communeRentTypeKey(propertyType)];
  if (!entry?.data?.rent_m2 || entry.data.version !== RENT_ESTIMATE_VERSION) {
    return null;
  }
  const fetchedAt = Date.parse(entry.fetched_at);
  if (!Number.isFinite(fetchedAt)) return null;
  if (now - fetchedAt > RENT_ESTIMATE_TTL_DAYS * DAY_MS) return null;
  return entry.data;
}

/** Payload communal mis à jour avec l'estimation d'un type de bien. */
export function mergeCommuneRent(communeData, propertyType, data, { now = new Date() } = {}) {
  return {
    by_type: {
      ...(communeData?.by_type || {}),
      [communeRentTypeKey(propertyType)]: { data, fetched_at: now.toISOString() },
    },
  };
}

/**
 * Vue d'affichage à partir du cache listing (aucun appel LLM).
 */
export function buildRentEstimateView({
  listing,
  record = null,
  works = 0,
  marketEstimate = null,
} = {}) {
  if (listing?.transaction_type === "rent") {
    return { visible: false, status: "hidden" };
  }

  const surface = listing?.surface > 0 ? Number(listing.surface) : null;
  if (!surface) {
    return { visible: false, status: "no_surface" };
  }

  if (!record) {
    return {
      visible: true,
      status: "pending",
      listing_id: listing.id,
    };
  }

  if (record.status !== "ok" || !record.data?.rent_m2) {
    const pending = record.status !== "error";
    const error = record.error || null;
    return {
      visible: true,
      status: pending ? "pending" : "error",
      error,
      error_label: pending ? null : rentEstimateErrorMessage(error),
      listing_id: listing.id,
    };
  }

  const data = record.data;
  const rentM2 = data.rent_m2;
  const monthly = {
    low: monthlyRent(rentM2.low, surface),
    mid: monthlyRent(rentM2.mid, surface),
    high: monthlyRent(rentM2.high, surface),
  };
  const annual = monthly.mid != null ? monthly.mid * 12 : null;
  const price = listing.price > 0 ? Number(listing.price) : null;
  const worksAmount = works > 0 ? Number(works) : 0;
  const acquisitionPrice =
    price != null ? price + worksAmount : null;
  const marketValue =
    marketEstimate > 0 ? Math.round(Number(marketEstimate)) : null;
  const yield_attractiveness =
    acquisitionPrice && marketValue
      ? yieldAttractiveness(acquisitionPrice, marketValue)
      : null;

  return {
    visible: true,
    status: "ok",
    listing_id: listing.id,
    fetched_at: record.fetched_at || null,
    granularity: data.granularity,
    granularity_label: granularityLabel(data.granularity),
    rent_m2: rentM2,
    furnished_rent_m2_mid: data.furnished_rent_m2_mid ?? null,
    rent_control: data.rent_control || { applies: false },
    confidence: data.confidence ?? null,
    sources: Array.isArray(data.sources) ? data.sources : [],
    notes: data.notes || "",
    surface,
    monthly,
    yield_gross: grossYield(annual, acquisitionPrice),
    yield_listing: worksAmount > 0 ? grossYield(annual, price) : null,
    works: worksAmount,
    acquisition_price: acquisitionPrice,
    yield_attractiveness,
    has_address: listingTerritory(listing).source === "user",
    web_search: Boolean(data.web_search),
  };
}

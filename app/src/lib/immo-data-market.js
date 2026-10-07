/**
 * Fonctions pures pour l'historique de prix Immo Data (série mensuelle
 * €/m² → points indexés, agrégat annuel, variations 6 mois à 10 ans).
 */

import { buildEvolution, priceVerdict, trendPercent } from "./dvf-stats.js";

/** Badges d'évolution affichés sur la fiche (ordre fixe). */
export const MARKET_VARIATION_HORIZONS = [
  { key: "6m", label: "6 mois" },
  { key: 1, label: "1 an" },
  { key: 2, label: "2 ans" },
  { key: 3, label: "3 ans" },
  { key: 4, label: "4 ans" },
  { key: 5, label: "5 ans" },
  { key: 10, label: "10 ans" },
];

const HISTORY_YEARS = 10;

/** Incrémenter pour forcer le recalcul des caches Immo Data (plage, badges). */
export const IMMO_DATA_MARKET_VERSION = 3;

export function needsImmoDataMarketRefresh(data) {
  if (!data) return false;
  return data.market_version !== IMMO_DATA_MARKET_VERSION;
}

const MONTHS_FR = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
];

/** `92064` → `92`, `2A004` → `2A`, `97101` → `971`. */
export function departmentCodeFromInsee(inseeCode) {
  const code = String(inseeCode || "").trim();
  if (!code) return null;
  if (/^97|^98/.test(code)) return code.slice(0, 3);
  if (/^2[AB]/i.test(code)) return code.slice(0, 2).toUpperCase();
  return code.slice(0, 2) || null;
}

export function formatPeriodFr(period) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period || ""));
  if (!match) return period || null;
  const month = MONTHS_FR[Number(match[2]) - 1];
  return month ? `${month} ${match[1]}` : period;
}

export function parseHistoryPoints(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .map((row) => ({
      period: String(row?.period || "").slice(0, 7),
      value: Number(row?.value),
    }))
    .filter(
      (row) =>
        /^\d{4}-\d{2}$/.test(row.period) &&
        Number.isFinite(row.value) &&
        row.value > 0
    )
    .sort((a, b) => a.period.localeCompare(b.period));
}

export function latestPoint(points) {
  if (!points?.length) return null;
  return points[points.length - 1];
}

/** Dernier mois disponible de chaque année civile. */
export function yearlyFromMonthly(points) {
  const byYear = new Map();
  for (const point of points || []) {
    const year = Number(point.period.slice(0, 4));
    if (!Number.isFinite(year)) continue;
    byYear.set(year, {
      year,
      median_price_m2: point.value,
      count: null,
    });
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

function shiftPeriod(period, years) {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return null;
  const year = Number(match[1]) - years;
  return `${year}-${match[2]}`;
}

function shiftPeriodMonths(period, months) {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  date.setMonth(date.getMonth() - months);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function pointsFromEvolution(evo) {
  return (evo?.points || [])
    .map((point) => ({
      period: point.period || point.year,
      value: point.median_price_m2,
    }))
    .filter(
      (row) =>
        /^\d{4}-\d{2}$/.test(String(row.period)) &&
        Number.isFinite(row.value) &&
        row.value > 0
    )
    .sort((a, b) => String(a.period).localeCompare(String(b.period)));
}

function assignVariationAliases(evo, variations) {
  if (!evo || !variations) return evo;
  evo.variations = variations;
  evo.m6 = variations["6m"];
  evo.y1 = variations[1];
  evo.y2 = variations[2];
  evo.y3 = variations[3];
  evo.y4 = variations[4];
  evo.y5 = variations[5];
  evo.y10 = variations[10];
  return evo;
}

function valueAtOrBefore(points, period) {
  let found = null;
  for (const point of points || []) {
    if (point.period > period) break;
    found = point;
  }
  return found;
}

/**
 * Variations sur la série mensuelle : 6 mois, 1–5 ans et 10 ans (dernier point
 * vs la période cible ; repli sur le point immédiatement antérieur).
 */
export function monthlyHorizons(points) {
  const last = latestPoint(points);
  if (!last) return null;
  const variations = {};

  const target6m = shiftPeriodMonths(last.period, 6);
  const ref6m = target6m ? valueAtOrBefore(points, target6m) : null;
  variations["6m"] =
    ref6m && ref6m.period !== last.period
      ? trendPercent(last.value, ref6m.value)
      : null;

  for (let k = 1; k <= 5; k += 1) {
    const target = shiftPeriod(last.period, k);
    const ref = target ? valueAtOrBefore(points, target) : null;
    variations[k] =
      ref && ref.period !== last.period
        ? trendPercent(last.value, ref.value)
        : null;
  }

  const target10 = shiftPeriod(last.period, 10);
  const ref10 = target10 ? valueAtOrBefore(points, target10) : null;
  variations[10] =
    ref10 && ref10.period !== last.period
      ? trendPercent(last.value, ref10.value)
      : null;

  return variations;
}

/** Recalcule les badges d'évolution Immo Data (série mensuelle en cache). */
export function patchImmoDataMarketHorizons(data) {
  const evolution = data?.evolution;
  if (!evolution?.by_type) return data;
  for (const typeKey of ["apartment", "house"]) {
    const block = evolution.by_type[typeKey];
    if (!block) continue;
    for (const scope of ["commune", "department"]) {
      const evo = block[scope];
      if (!evo) continue;
      const variations = monthlyHorizons(pointsFromEvolution(evo));
      if (variations) assignVariationAliases(evo, variations);
    }
  }
  return data;
}

/** Série mensuelle indexée (base 100 = premier point). */
export function indexMonthlyPoints(points) {
  const rows = points || [];
  if (rows.length < 2) return [];
  const base = rows[0].value;
  if (!base) return [];
  return rows.map((point) => ({
    year: point.period,
    period: point.period,
    median_price_m2: point.value,
    index: Math.round((point.value / base) * 1000) / 10,
  }));
}

export function buildMonthlyEvolution(points, { propertyType } = {}) {
  const yearly = yearlyFromMonthly(points);
  const evo = buildEvolution(yearly, { maxYears: HISTORY_YEARS });
  const indexed = indexMonthlyPoints(points);
  if (!evo && indexed.length < 2) return null;

  const variations = monthlyHorizons(points) || {
    "6m": null,
    1: null,
    2: null,
    3: null,
    4: null,
    5: null,
    10: null,
  };
  const last = latestPoint(points);
  const first = points?.[0];

  const result = evo
    ? { ...evo }
    : {
        points: indexed,
        trend_pct: first && last ? trendPercent(last.value, first.value) : null,
        trend_from_year: first?.period || null,
        trend_to_year: last?.period || null,
        tone: "neutral",
        label: "Marché stable",
      };

  result.points = indexed.length >= 2 ? indexed : result.points;
  assignVariationAliases(result, variations);
  if (propertyType) result.property_type = propertyType;
  return result;
}

export function listingPricePerM2(listing) {
  if (
    listing?.transaction_type === "rent" ||
    !(listing?.price > 0) ||
    !(listing?.surface > 0)
  ) {
    return null;
  }
  return Math.round((listing.price / listing.surface) * 100) / 100;
}

export function marketVerdict(listing, referencePriceM2) {
  const priceM2 = listingPricePerM2(listing);
  const base = priceVerdict(priceM2, referencePriceM2);
  if (!base) return null;
  const overpriced = base.index > 103;
  return {
    ...base,
    listing_price_m2: priceM2,
    reference_price_m2: referencePriceM2,
    reference_scope: "commune",
    delta_amount: Math.round(listing.price - referencePriceM2 * listing.surface),
    negotiation_amount: overpriced
      ? Math.round(listing.price - referencePriceM2 * listing.surface)
      : null,
  };
}

/** Construit l'URL `/v1/market/price/history` avec les paramètres non vides. */
export function buildHistoryUrl(baseUrl, params) {
  const url = new URL("/v1/market/price/history", `${baseUrl}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Appelle l'historique de prix Immo Data et renvoie les points mensuels déjà
 * nettoyés (triés, clipés au dernier mois clos). Partagé par les providers
 * communal, départemental et grand quartier.
 */
export async function fetchHistorySeries(fetchJson, config, params) {
  const payload = await fetchJson(buildHistoryUrl(config.immoData.baseUrl, params), {
    timeoutMs: config.immoData.timeoutMs,
    headers: {
      authorization: authorizationHeader(config.immoData.apiKey),
      "user-agent": config.immoData.userAgent,
    },
  });
  return clipToPreviousMonth(parseHistoryPoints(payload));
}

/** Carte « dernier prix connu » pour un jeu de points mensuels. */
export function latestCard(points) {
  const last = latestPoint(points);
  if (!last) return null;
  return {
    median_price_m2: last.value,
    count: null,
    year: formatPeriodFr(last.period),
    period: last.period,
  };
}

/** Type de bien de l'annonce ramené aux valeurs Immo Data (ou null). */
export function listingRealtyType(listing) {
  if (listing?.property_type === "house") return "house";
  if (listing?.property_type === "apartment") return "apartment";
  return null;
}

export function authorizationHeader(apiKey) {
  const token = String(apiKey || "").trim();
  if (!token) return "";
  return /^bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

/** Dernier mois civil clos (Immo Data publie jusqu'au mois précédent). */
export function previousMonthPeriod(now = new Date()) {
  const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const year = last.getFullYear();
  const month = String(last.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function historyRange(now = new Date()) {
  const endDate = previousMonthPeriod(now);
  const year = Number(endDate.slice(0, 4));
  return {
    startDate: `${year - HISTORY_YEARS}-01`,
    endDate,
  };
}

/** Écarte le mois en cours, encore incomplet côté Immo Data. */
export function clipToPreviousMonth(points, now = new Date()) {
  const endDate = previousMonthPeriod(now);
  return (points || []).filter((point) => point.period <= endDate);
}

/**
 * Ramène des ventes DVF passées au niveau de prix actuel : chaque vente est
 * multipliée par (prix du marché aujourd'hui ÷ prix moyen de son année), à
 * partir d'une série mensuelle de prix au m² (commune ou département). Sans
 * cette correction, les ventes d'années plus chères gonflent la référence
 * dans un marché baissier (et l'inverse en marché haussier).
 */

import { median } from "./dvf-stats.js";

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Coefficient par année civile à partir de points `{ period: "YYYY-MM", median_price_m2 }`.
 * @returns {{ latest_period: string, latest_price_m2: number, years: Map<number, {avg:number, factor:number}> } | null}
 */
export function yearlyMarketFactors(points) {
  const valid = (points || []).filter(
    (p) => /^\d{4}-\d{2}$/.test(String(p?.period)) && p.median_price_m2 > 0
  );
  if (valid.length < 2) return null;
  const latest = valid[valid.length - 1];

  const sums = new Map();
  for (const p of valid) {
    const year = Number(p.period.slice(0, 4));
    const acc = sums.get(year) || { total: 0, n: 0 };
    acc.total += p.median_price_m2;
    acc.n += 1;
    sums.set(year, acc);
  }

  const years = new Map();
  for (const [year, { total, n }] of sums) {
    const avg = total / n;
    years.set(year, { avg, factor: latest.median_price_m2 / avg });
  }
  return { latest_period: latest.period, latest_price_m2: latest.median_price_m2, years };
}

/** Coefficient de l'année, ou de l'année disponible la plus proche. */
function factorForYear(factors, year) {
  if (!Number.isFinite(year) || !factors.years.size) return null;
  if (factors.years.has(year)) return factors.years.get(year).factor;
  let best = null;
  for (const y of factors.years.keys()) {
    if (best == null || Math.abs(y - year) < Math.abs(best - year)) best = y;
  }
  return factors.years.get(best).factor;
}

export const SURFACE_COMPARABLE_TOLERANCE = 0.2;
export const SURFACE_COMPARABLE_MIN_SAMPLE = 3;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function weightedMedian(items) {
  if (!items.length) return null;
  const sorted = [...items].sort((a, b) => a.price - b.price);
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return median(sorted.map((item) => item.price));
  let cum = 0;
  for (const item of sorted) {
    cum += item.weight;
    if (cum >= total / 2) return item.price;
  }
  return sorted[sorted.length - 1].price;
}

/**
 * Recalcule la référence d'un rayon DVF avec des prix corrigés de l'évolution
 * du marché. Conserve le filtre des valeurs atypiques et la pondération
 * récente déjà calculés sur chaque vente.
 *
 * @param {object} radius  `dvf-local.radius` (ventes avec `year`, `recency_weight`, `used_in_reference`)
 * @param {object[]} points série mensuelle de prix au m² du même type de bien
 */
export function adjustRadiusToMarket(radius, points) {
  if (!Array.isArray(radius?.sales) || !radius.sales.length) return null;
  const factors = yearlyMarketFactors(points);
  if (!factors) return null;

  const sales = radius.sales.map((sale) => {
    const factor = factorForYear(factors, Number(sale.year));
    return {
      ...sale,
      market_factor: factor != null ? Math.round(factor * 1000) / 1000 : null,
      adjusted_price_per_m2:
        factor != null && Number.isFinite(sale.price_per_m2)
          ? round2(sale.price_per_m2 * factor)
          : null,
    };
  });

  const items = sales
    .filter((s) => s.used_in_reference && s.adjusted_price_per_m2 != null)
    .map((s) => ({
      price: s.adjusted_price_per_m2,
      weight: Number.isFinite(s.recency_weight) ? s.recency_weight : 1,
    }));
  const adjustedMedian = weightedMedian(items);
  if (adjustedMedian == null) return null;

  const saleYears = [...new Set(sales.map((s) => Number(s.year)).filter(Number.isFinite))].sort();
  const yearFactors = saleYears.map((year) => {
    const factor = factorForYear(factors, year);
    return { year, pct: Math.round((factor - 1) * 1000) / 10 };
  });

  return {
    median_raw: radius.median_price_m2,
    median_price_m2: adjustedMedian,
    reference_period: factors.latest_period,
    year_factors: yearFactors,
    sales,
  };
}

/**
 * Médiane pondérée et fourchette P25–P75 sur les ventes dont la surface est
 * dans ±`tolerance` de celle du bien (défaut ±20 %). Sinon, médiane sur tout
 * le rayon.
 */
export function surfaceComparableReference(
  radius,
  listingSurface,
  marketPoints,
  { tolerance = SURFACE_COMPARABLE_TOLERANCE, minSample = SURFACE_COMPARABLE_MIN_SAMPLE } = {}
) {
  if (!Array.isArray(radius?.sales) || !(listingSurface > 0)) return null;

  const adjusted = marketPoints?.length ? adjustRadiusToMarket(radius, marketPoints) : null;
  const minSurf = listingSurface * (1 - tolerance);
  const maxSurf = listingSurface * (1 + tolerance);

  const sales = (adjusted?.sales || radius.sales)
    .filter((s) => s.used_in_reference)
    .map((sale) => {
      const referencePriceM2 =
        sale.adjusted_price_per_m2 != null
          ? sale.adjusted_price_per_m2
          : sale.price_per_m2;
      return {
        ...sale,
        reference_price_m2: referencePriceM2,
        surface_comparable:
          Number.isFinite(sale.surface) &&
          sale.surface >= minSurf &&
          sale.surface <= maxSurf,
      };
    })
    .filter((s) => Number.isFinite(s.reference_price_m2) && Number.isFinite(s.surface));

  if (!sales.length) return null;

  const inBand = sales.filter((s) => s.surface_comparable);
  let used = inBand;
  let surface_filtered = true;
  if (used.length < minSample) {
    used = sales;
    surface_filtered = false;
  }

  const items = used.map((s) => ({
    price: s.reference_price_m2,
    weight: Number.isFinite(s.recency_weight) ? s.recency_weight : 1,
  }));
  const median_price_m2 = weightedMedian(items);
  if (median_price_m2 == null) return null;

  const sortedM2 = used.map((s) => s.reference_price_m2).sort((a, b) => a - b);

  return {
    adjusted,
    median_price_m2: round2(median_price_m2),
    p25_price_m2: round2(percentile(sortedM2, 0.25)),
    p75_price_m2: round2(percentile(sortedM2, 0.75)),
    surface_band: {
      min: Math.round(minSurf),
      max: Math.round(maxSurf),
      tolerance_pct: Math.round(tolerance * 100),
    },
    count_in_band: inBand.length,
    count_used: used.length,
    surface_filtered,
    sales,
  };
}

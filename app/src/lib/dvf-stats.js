/**
 * Fonctions pures de statistiques DVF : médiane, distance, filtrage par rayon,
 * verdict de négociation et série d'évolution. Isolées ici pour être testées.
 */

/** Médiane d'un tableau de nombres (copie triée), ou null si vide. */
export function median(values) {
  const nums = (values || []).filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Distance approximative en mètres entre deux points (formule haversine). */
export function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Bornes d'une boîte englobante (bbox) autour d'un point, pour un pré-filtre
 * SQL rapide avant le calcul exact de la distance.
 */
export function boundingBox(lat, lng, meters) {
  const dLat = meters / 111_320;
  const cos = Math.cos((lat * Math.PI) / 180);
  const dLng = meters / (111_320 * (Math.abs(cos) < 1e-6 ? 1e-6 : cos));
  return {
    minLat: lat - dLat,
    maxLat: lat + dLat,
    minLng: lng - dLng,
    maxLng: lng + dLng,
  };
}

/**
 * Ventes dans le rayon (prix + date pour pondération).
 * @param {{lat:number,lng:number,price_per_m2:number,mutation_date?:string,year?:number}[]} points
 */
export function salesWithinRadius(points, lat, lng, meters) {
  const out = [];
  for (const p of points || []) {
    if (p.lat == null || p.lng == null) continue;
    const distance = haversineMeters(lat, lng, p.lat, p.lng);
    if (distance <= meters) {
      out.push({
        price: p.price,
        surface: p.surface,
        price_per_m2: p.price_per_m2,
        mutation_date: p.mutation_date ?? null,
        year: p.year ?? null,
        insee_code: p.insee_code ?? null,
        distance_m: Math.round(distance),
      });
    }
  }
  return out;
}

/**
 * Conserve les prix au m² des points réellement situés dans le rayon.
 * @param {{lat:number,lng:number,price_per_m2:number}[]} points
 */
export function pricesWithinRadius(points, lat, lng, meters) {
  return salesWithinRadius(points, lat, lng, meters).map((s) => s.price_per_m2);
}

/** Date de vente exploitable (jour exact ou milieu d'année si seule l'année est connue). */
export function parseMutationDate(sale) {
  const raw = sale?.mutation_date;
  if (raw && /^\d{4}-\d{2}-\d{2}/.test(String(raw))) {
    const d = new Date(`${String(raw).slice(0, 10)}T12:00:00Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const year = Number(sale?.year);
  if (Number.isFinite(year)) {
    return new Date(Date.UTC(year, 6, 1));
  }
  return null;
}

/** Poids décroissant avec l'âge (demi-vie en jours). */
export function recencyWeight(ageDays, halfLifeDays) {
  const age = Number.isFinite(ageDays) && ageDays > 0 ? ageDays : 0;
  const half = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : 540;
  return 0.5 ** (age / half);
}

/**
 * Écarte les ventes dont le €/m² est très en dessous du marché local (erreurs DVF).
 * Seuil : strictement sous `ratio` × médiane brute de l'échantillon (défaut 50 %).
 */
export function filterLowOutlierSales(sales, { lowRatio = 0.5 } = {}) {
  const list = sales || [];
  const countTotal = list.length;
  if (!countTotal) {
    return {
      kept: [],
      countTotal: 0,
      countReference: 0,
      excluded: 0,
      outlier_floor_m2: null,
    };
  }
  const ratio = Number.isFinite(lowRatio) && lowRatio > 0 && lowRatio < 1 ? lowRatio : 0.5;
  const baseMedian = median(list.map((s) => s.price_per_m2));
  if (baseMedian == null) {
    return {
      kept: list,
      countTotal,
      countReference: countTotal,
      excluded: 0,
      outlier_floor_m2: null,
    };
  }
  const floor = Math.round(baseMedian * ratio * 100) / 100;
  const kept = list.filter((s) => Number.isFinite(s.price_per_m2) && s.price_per_m2 >= floor);
  if (!kept.length) {
    return {
      kept: list,
      countTotal,
      countReference: countTotal,
      excluded: 0,
      outlier_floor_m2: null,
    };
  }
  const countReference = kept.length;
  return {
    kept,
    countTotal,
    countReference,
    excluded: countTotal - countReference,
    outlier_floor_m2: floor,
  };
}

/**
 * Agrège le rayon DVF : filtre des valeurs atypiques, médiane pondérée et détail des ventes.
 */
export function buildDvfRadiusReference(
  sales,
  { now = new Date(), halfLifeDays = 540, outlierLowRatio = 0.5 } = {}
) {
  const filtered = filterLowOutlierSales(sales, { lowRatio: outlierLowRatio });
  const medianPrice = recencyWeightedMedian(filtered.kept, { now, halfLifeDays });
  const ref = now.getTime();
  const floor = filtered.outlier_floor_m2;
  const applyFloor = filtered.excluded > 0 && floor != null;

  const detail = (sales || []).map((sale) => {
    const mutDate = parseMutationDate(sale);
    const ageDays = mutDate ? Math.round((ref - mutDate.getTime()) / 86_400_000) : null;
    const weight = mutDate
      ? recencyWeight((ref - mutDate.getTime()) / 86_400_000, halfLifeDays)
      : 1;
    const usedInReference =
      !applyFloor ||
      (Number.isFinite(sale.price_per_m2) && sale.price_per_m2 >= floor);
    return {
      price: sale.price,
      surface: sale.surface,
      price_per_m2: sale.price_per_m2,
      year: sale.year,
      mutation_date: sale.mutation_date,
      insee_code: sale.insee_code,
      distance_m: sale.distance_m,
      recency_weight: Math.round(weight * 1000) / 1000,
      used_in_reference: usedInReference,
    };
  });

  detail.sort((a, b) => {
    const ta = parseMutationDate(a)?.getTime() || 0;
    const tb = parseMutationDate(b)?.getTime() || 0;
    return tb - ta;
  });

  return {
    count: filtered.countTotal,
    count_reference: filtered.countReference,
    outliers_excluded: filtered.excluded,
    median: medianPrice,
    outlier_floor_m2: floor,
    sales: detail,
  };
}

export function recencyWeightedMedian(sales, { now = new Date(), halfLifeDays = 540 } = {}) {
  const ref = now.getTime();
  const items = [];
  for (const sale of sales || []) {
    const price = sale.price_per_m2;
    if (!Number.isFinite(price)) continue;
    const mutDate = parseMutationDate(sale);
    const weight = mutDate
      ? recencyWeight((ref - mutDate.getTime()) / 86_400_000, halfLifeDays)
      : 1;
    items.push({ price, weight });
  }
  if (!items.length) return null;

  items.sort((a, b) => a.price - b.price);
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return median(items.map((item) => item.price));

  let cum = 0;
  for (const item of items) {
    cum += item.weight;
    if (cum >= total / 2) return item.price;
  }
  return items[items.length - 1].price;
}

/**
 * Verdict de positionnement du prix d'un bien par rapport à une référence
 * locale (médiane rayon ou commune). `index` = bien / référence × 100.
 */
export function priceVerdict(listingPricePerM2, referencePricePerM2) {
  if (
    !Number.isFinite(listingPricePerM2) ||
    !Number.isFinite(referencePricePerM2) ||
    referencePricePerM2 <= 0
  ) {
    return null;
  }
  const index = Math.round((listingPricePerM2 / referencePricePerM2) * 100);
  let tone;
  let label;
  if (index <= 85) {
    tone = "ok";
    label = "Sous le prix du marché";
  } else if (index <= 97) {
    tone = "ok";
    label = "Légèrement sous le marché";
  } else if (index <= 103) {
    tone = "mid";
    label = "Dans le prix du marché";
  } else if (index <= 115) {
    tone = "high";
    label = "Au-dessus du marché";
  } else {
    tone = "high";
    label = "Nettement au-dessus du marché";
  }
  return { index, tone, label };
}

/** Variation en pourcentage (une décimale), ou null. */
export function trendPercent(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
    return null;
  }
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function toYear(year) {
  const y = Number(year);
  return Number.isFinite(y) ? y : null;
}

function normalizePriceSeries(rows) {
  return (rows || [])
    .filter((r) => Number.isFinite(r.median_price_m2) && r.median_price_m2 > 0)
    .map((r) => ({ ...r, year: toYear(r.year) }))
    .filter((r) => r.year != null)
    .sort((a, b) => a.year - b.year);
}

/**
 * Variations sur 1 à 5 ans : dernière année vs N−k (année calendaire).
 * Pour k = 5, si N−5 est absent, repli sur la tendance de la fenêtre du graphe.
 */
export function evolutionHorizons(rows, { chartPoints = null } = {}) {
  const series = normalizePriceSeries(rows);
  if (!series.length) return null;

  const last = series[series.length - 1];
  const byYear = new Map(series.map((r) => [r.year, r]));
  const variations = {};
  for (let k = 1; k <= 5; k++) {
    const ref = byYear.get(last.year - k);
    variations[k] = ref
      ? trendPercent(last.median_price_m2, ref.median_price_m2)
      : null;
  }

  const window = chartPoints
    ? normalizePriceSeries(chartPoints)
    : series.slice(-5);
  if (variations[5] == null && window.length >= 2) {
    const first = window[0];
    variations[5] = trendPercent(last.median_price_m2, first.median_price_m2);
  }

  return variations;
}

/** Recalcule y1…y5 à partir des points (cache enrichissement incomplet). */
export function applyEvolutionHorizons(evo) {
  if (!evo?.points?.length) return evo;
  const variations = evolutionHorizons(evo.points, { chartPoints: evo.points });
  if (!variations) return evo;
  evo.variations = variations;
  evo.y1 = variations[1];
  evo.y2 = variations[2];
  evo.y3 = variations[3];
  evo.y4 = variations[4];
  evo.y5 = variations[5];
  return evo;
}

/** Met à jour les horizons commune / département du payload prix-m². */
export function patchPrixM2EvolutionHorizons(data) {
  const evolution = data?.evolution;
  if (!evolution?.by_type) return data;
  for (const typeKey of ["apartment", "house"]) {
    const block = evolution.by_type[typeKey];
    if (!block) continue;
    if (block.commune) applyEvolutionHorizons(block.commune);
    if (block.department) applyEvolutionHorizons(block.department);
  }
  return data;
}

/**
 * Construit la série d'évolution (jusqu'à `maxYears` années) à partir des
 * statistiques communales ou départementales triées par année.
 * Chaque point porte un index base 100 (première année de la fenêtre).
 * `variations[k]` / `y1`…`y5` = dernier vs année calendaire N−k (si présente).
 * `trend_pct` = dernier vs premier point de la fenêtre affichée (libellé marché).
 * @param {{year:number, median_price_m2:number, count:number}[]} stats
 */
export function buildEvolution(stats, { maxYears = 5 } = {}) {
  const rows = (stats || [])
    .filter((r) => Number.isFinite(r.median_price_m2) && r.median_price_m2 > 0)
    .sort((a, b) => a.year - b.year);
  if (rows.length < 2) return null;

  const points = rows.slice(-maxYears);
  const first = points[0];
  const last = points[points.length - 1];
  const base = first.median_price_m2;
  const trend = trendPercent(last.median_price_m2, first.median_price_m2);

  const variations =
    evolutionHorizons(rows, { chartPoints: points }) || {
      1: null,
      2: null,
      3: null,
      4: null,
      5: null,
    };
  const y1 = variations[1];

  const indexed = points.map((p) => ({
    year: p.year,
    count: p.count,
    median_price_m2: p.median_price_m2,
    index: Math.round((p.median_price_m2 / base) * 1000) / 10,
  }));

  let tone = "neutral";
  let label = "Marché stable";
  if (trend != null) {
    if (trend >= 15) {
      tone = "ok";
      label = "Marché dynamique";
    } else if (trend >= 3) {
      tone = "ok";
      label = "Marché porteur";
    } else if (trend > -3) {
      tone = "mid";
      label = "Marché stable";
    } else {
      tone = "high";
      label = "Marché en recul";
    }
  }

  return {
    points: indexed,
    trend_pct: trend,
    trend_from_year: first.year,
    trend_to_year: last.year,
    tone,
    label,
    variations,
    y1,
    y2: variations[2],
    y3: variations[3],
    y4: variations[4],
    y5: variations[5],
  };
}

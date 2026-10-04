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
 * Conserve les prix au m² des points réellement situés dans le rayon.
 * @param {{lat:number,lng:number,price_per_m2:number}[]} points
 */
export function pricesWithinRadius(points, lat, lng, meters) {
  const out = [];
  for (const p of points || []) {
    if (p.lat == null || p.lng == null) continue;
    if (haversineMeters(lat, lng, p.lat, p.lng) <= meters) {
      out.push(p.price_per_m2);
    }
  }
  return out;
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

/**
 * Construit la série d'évolution (jusqu'à `maxYears` années) à partir des
 * statistiques communales triées par année, avec tendance globale et verdict
 * de dynamisme.
 * @param {{year:number, median_price_m2:number, count:number}[]} stats
 */
export function buildEvolution(stats, { maxYears = 10 } = {}) {
  const rows = (stats || [])
    .filter((r) => Number.isFinite(r.median_price_m2) && r.median_price_m2 > 0)
    .sort((a, b) => a.year - b.year);
  if (rows.length < 2) return null;

  const points = rows.slice(-maxYears);
  const first = points[0];
  const last = points[points.length - 1];
  const trend = trendPercent(last.median_price_m2, first.median_price_m2);

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
    points,
    trend_pct: trend,
    trend_from_year: first.year,
    trend_to_year: last.year,
    tone,
    label,
  };
}

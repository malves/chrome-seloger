/**
 * Primitives géographiques déterministes du moteur de localisation probable.
 *
 * Aucune dépendance externe : distances, enveloppes, grilles et appartenance
 * à un polygone sont calculées ici afin que le scoring reste testable sans
 * réseau. Les polygones suivent la convention GeoJSON ([lon, lat]) utilisée par
 * OpenRouteService pour les isochrones ; les points « métier » restent en
 * { lat, lon } pour rester cohérents avec le reste du code (travel.service).
 */

const EARTH_RADIUS_M = 6_371_000;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

/** Distance orthodromique (mètres) entre deux points { lat, lon }. */
export function haversineMeters(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Combien de degrés de latitude valent `meters` mètres. */
export function metersToLatDegrees(meters) {
  return toDeg(meters / EARTH_RADIUS_M);
}

/** Combien de degrés de longitude valent `meters` mètres à une latitude donnée. */
export function metersToLonDegrees(meters, lat) {
  const r = EARTH_RADIUS_M * Math.cos(toRad(lat));
  if (r <= 0) return 0;
  return toDeg(meters / r);
}

/**
 * Enveloppe (bounding box) d'une liste de points { lat, lon }, éventuellement
 * élargie d'une marge en mètres.
 * @returns {{ minLat, minLon, maxLat, maxLon } | null}
 */
export function boundingBox(points, paddingMeters = 0) {
  const valid = (points || []).filter(
    (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon)
  );
  if (!valid.length) return null;

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of valid) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  if (paddingMeters > 0) {
    const latPad = metersToLatDegrees(paddingMeters);
    const midLat = (minLat + maxLat) / 2;
    const lonPad = metersToLonDegrees(paddingMeters, midLat);
    minLat -= latPad;
    maxLat += latPad;
    minLon -= lonPad;
    maxLon += lonPad;
  }

  return { minLat, minLon, maxLat, maxLon };
}

/** Centre géométrique d'une bbox. */
export function boundingBoxCenter(bbox) {
  if (!bbox) return null;
  return {
    lat: (bbox.minLat + bbox.maxLat) / 2,
    lon: (bbox.minLon + bbox.maxLon) / 2,
  };
}

/**
 * Découpe une bbox en une grille régulière de `size` × `size` cellules et
 * renvoie leurs centres { lat, lon }. La largeur d'une cellule (mètres) est
 * fournie pour dimensionner la heatmap côté client.
 * @returns {{ cells: Array<{lat, lon}>, cellWidthMeters: number, cellHeightMeters: number }}
 */
export function gridFromBoundingBox(bbox, size = 60) {
  if (!bbox || size < 1) {
    return { cells: [], cellWidthMeters: 0, cellHeightMeters: 0 };
  }
  const cols = Math.max(1, Math.trunc(size));
  const rows = cols;
  const latStep = (bbox.maxLat - bbox.minLat) / rows;
  const lonStep = (bbox.maxLon - bbox.minLon) / cols;
  const midLat = (bbox.minLat + bbox.maxLat) / 2;

  const cells = [];
  for (let r = 0; r < rows; r += 1) {
    const lat = bbox.minLat + latStep * (r + 0.5);
    for (let c = 0; c < cols; c += 1) {
      const lon = bbox.minLon + lonStep * (c + 0.5);
      cells.push({ lat, lon });
    }
  }

  return {
    cells,
    cellWidthMeters: Math.abs(
      lonStep / Math.max(metersToLonDegrees(1, midLat), 1e-12)
    ),
    cellHeightMeters: Math.abs(latStep / Math.max(metersToLatDegrees(1), 1e-12)),
  };
}

/**
 * Appartenance d'un point à un anneau polygonal (ray casting).
 * @param {{lat, lon}} point
 * @param {Array<[number, number]>} ring - sommets GeoJSON [lon, lat]
 */
export function pointInRing(point, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  const x = point.lon;
  const y = point.lat;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi + 0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Teste un polygone (anneau extérieur + trous) : [ring, hole, ...]. */
function pointInSinglePolygon(point, poly) {
  const [outer, ...holes] = poly;
  if (!pointInRing(point, outer)) return false;
  return !holes.some((hole) => pointInRing(point, hole));
}

/**
 * Appartenance à un polygone. Accepte, par détection de profondeur :
 *  - un anneau nu            : [[lon,lat], ...]
 *  - un Polygon GeoJSON      : [ring, hole, ...]
 *  - un MultiPolygon GeoJSON : [polygon, polygon, ...]
 * @param {{lat, lon}} point
 */
export function pointInPolygon(point, polygon) {
  if (!Array.isArray(polygon) || !polygon.length) return false;
  const first = polygon[0];

  // Anneau nu : premier élément = [lon, lat].
  if (typeof first?.[0] === "number") {
    return pointInRing(point, polygon);
  }
  // Polygon : premier élément = anneau de [lon, lat].
  if (typeof first?.[0]?.[0] === "number") {
    return pointInSinglePolygon(point, polygon);
  }
  // MultiPolygon.
  return polygon.some((poly) => pointInSinglePolygon(point, poly));
}

/**
 * Approxime un disque centré sur { lat, lon } par un polygone GeoJSON régulier.
 * Sert de repli quand aucune isochrone de trajet n'est disponible.
 * @returns {Array<[number, number]>} anneau fermé [lon, lat]
 */
export function circlePolygon(center, radiusMeters, segments = 32) {
  const ring = [];
  const latPad = metersToLatDegrees(radiusMeters);
  const lonPad = metersToLonDegrees(radiusMeters, center.lat);
  for (let i = 0; i <= segments; i += 1) {
    const angle = (i / segments) * 2 * Math.PI;
    ring.push([
      center.lon + lonPad * Math.cos(angle),
      center.lat + latPad * Math.sin(angle),
    ]);
  }
  return ring;
}

/** Enveloppe d'un (multi)polygone GeoJSON en bbox { minLat, ... }. */
export function polygonBoundingBox(polygon) {
  const points = [];
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === "number" && typeof node[1] === "number") {
      points.push({ lon: node[0], lat: node[1] });
      return;
    }
    node.forEach(walk);
  };
  walk(polygon);
  return boundingBox(points);
}

export default {
  haversineMeters,
  metersToLatDegrees,
  metersToLonDegrees,
  boundingBox,
  boundingBoxCenter,
  gridFromBoundingBox,
  pointInRing,
  pointInPolygon,
  circlePolygon,
  polygonBoundingBox,
};

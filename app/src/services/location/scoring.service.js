/**
 * Étapes 4 à 7 du moteur de localisation probable : tolérance sur les temps et
 * distances annoncés, distances conventionnelles des formules vagues, poids par
 * nature de contrainte, score spatial sur grille, résultat final + heatmap et
 * détection d'incohérence.
 *
 * Entièrement déterministe et sans réseau : les contraintes arrivent déjà
 * géocodées (latitude/longitude) et, pour les contraintes temporelles, dotées
 * d'un profil d'accessibilité `access` (isochrones ORS ou repli cercle).
 */

import config from "../../config.js";
import {
  haversineMeters,
  boundingBox,
  gridFromBoundingBox,
  pointInPolygon,
} from "../../lib/geo.js";

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/**
 * Score de tolérance « borne haute » pour une valeur annoncée `max` (minutes ou
 * mètres). `<= max + grâce → 1`, puis décroissance (exposant `curve`) jusqu'à 0
 * au seuil `max + grâce + span`. Paramétrable via la config.
 */
export function upperToleranceScore(actual, max, tol) {
  if (!(max > 0)) return 0;
  if (!Number.isFinite(actual)) return 0;
  const grace = max * (tol.graceRatio || 0);
  const span = max * (tol.spanRatio ?? 1);
  const full = max + grace;
  if (actual <= full) return 1;
  const cutoff = full + span;
  if (actual >= cutoff || span <= 0) return 0;
  const x = (actual - full) / span; // 0..1
  return clamp((1 - x) ** (tol.curve ?? 1), 0, 1);
}

/**
 * Score de tolérance « borne basse » (pour « entre X et Y ») : `>= min → 1`,
 * décroissance en dessous. Renvoie 1 si aucune borne basse.
 */
export function lowerToleranceScore(actual, min, tol) {
  if (!(min > 0)) return 1;
  if (!Number.isFinite(actual)) return 0;
  const span = min * (tol.spanRatio ?? 1);
  if (actual >= min) return 1;
  const floor = min - span;
  if (actual <= floor || span <= 0) return 0;
  const x = (min - actual) / span;
  return clamp((1 - x) ** (tol.curve ?? 1), 0, 1);
}

/** Minutes estimées pour atteindre un lieu depuis une cellule (isochrones). */
function minutesFromBands(cell, bands) {
  for (const band of bands) {
    if (pointInPolygon(cell, band.polygon)) return band.minutes;
  }
  return Infinity;
}

export default function createScoringService({
  probableLocation = config.probableLocation,
} = {}) {
  const {
    grid: gridCfg,
    toleranceMinutes,
    toleranceMeters,
    vagueDistances,
    weights,
    speeds,
    consistencyThreshold,
    topCandidates,
  } = probableLocation;

  function isNamedStreetConstraint(constraint) {
    return constraint?.place_type === "address";
  }

  /** Rayon conventionnel (mètres) d'une formule vague. */
  function vagueRadiusFor(constraint) {
    if (isNamedStreetConstraint(constraint) && constraint.relation === "near") {
      return vagueDistances.street ?? vagueDistances.proche ?? vagueDistances.default;
    }
    const kind = constraint.vague_kind;
    return vagueDistances[kind] ?? vagueDistances.default;
  }

  /** Poids d'une contrainte (précis > vague), pondéré par la confiance géocodage. */
  function weightFor(constraint) {
    let base;
    if (constraint.relation === "travel_time") base = weights.travelTimePrecise;
    else if (constraint.relation === "distance") base = weights.distancePrecise;
    else if (isNamedStreetConstraint(constraint)) base = weights.streetNear ?? weights.travelTimePrecise;
    else base = weights[constraint.vague_kind] ?? weights.vagueDefault;
    const geo = Number.isFinite(constraint.geocoding_confidence)
      ? constraint.geocoding_confidence
      : 0.5;
    return base * geo;
  }

  /** Score 0..1 d'une cellule pour une contrainte géocodée. */
  function cellConstraintScore(cell, constraint) {
    const place = { lat: constraint.latitude, lon: constraint.longitude };

    if (constraint.relation === "travel_time") {
      let minutes;
      const access = constraint.access;
      if (access?.mode === "isochrone" && access.bands?.length) {
        minutes = minutesFromBands(cell, access.bands);
      } else {
        const speed = speeds[constraint.transport] || speeds.walking;
        minutes = haversineMeters(cell, place) / speed;
      }
      const upper = upperToleranceScore(minutes, constraint.max_minutes, toleranceMinutes);
      const lower = lowerToleranceScore(minutes, constraint.min_minutes, toleranceMinutes);
      return upper * lower;
    }

    if (constraint.relation === "distance") {
      const d = haversineMeters(cell, place);
      const upper = upperToleranceScore(d, constraint.max_meters, toleranceMeters);
      const lower = lowerToleranceScore(d, constraint.min_meters, toleranceMeters);
      return upper * lower;
    }

    // near (vague) : disque conventionnel avec tolérance distance.
    const d = haversineMeters(cell, place);
    return upperToleranceScore(d, vagueRadiusFor(constraint), toleranceMeters);
  }

  /** Enveloppe convexe (monotone chain) d'une liste de {lat, lon} → [[lat,lng]]. */
  function convexHull(points) {
    const pts = points
      .map((p) => [p.lon, p.lat])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts.map(([lon, lat]) => [lat, lon]);
    const cross = (o, a, b) =>
      (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
        lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i -= 1) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
        upper.pop();
      upper.push(p);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper).map(([lon, lat]) => [lat, lon]);
  }

  /**
   * Cercle centré sur les lieux cités. Sert quand le score est plat sur presque
   * toute la grille (isochrone large) : on n'affiche pas tout le disque de trajet,
   * seulement le paquet de repères, avec un dégradé à l'intérieur.
   */
  function clueFocus(usable) {
    let wsum = 0;
    let lat = 0;
    let lon = 0;
    const parts = [];
    for (const c of usable) {
      const w = Math.max(weightFor(c), 0.05);
      wsum += w;
      lat += c.latitude * w;
      lon += c.longitude * w;
      parts.push({ lat: c.latitude, lon: c.longitude, w });
    }
    if (!wsum) return null;
    const center = { latitude: lat / wsum, longitude: lon / wsum };
    let acc = 0;
    for (const p of parts) {
      const d = haversineMeters(
        { lat: center.latitude, lon: center.longitude },
        { lat: p.lat, lon: p.lon }
      );
      acc += p.w * d * d;
    }
    const rms = Math.sqrt(acc / wsum);
    const radius = Math.round(clamp(Math.max(rms * 1.15, 350), 350, 1500));
    return { center, radius };
  }

  /** Score d'affichage : 1 au centre du cercle, 0 sur le bord. */
  function closenessScore(cell, center, radius) {
    if (!(radius > 0) || !center) return 0;
    const d = haversineMeters(
      { lat: center.latitude, lon: center.longitude },
      { lat: cell.lat, lon: cell.lon }
    );
    return { distance: d, score: clamp(1 - d / radius, 0, 1) };
  }

  /** Voie nommée la mieux géocodée : ancrage du centre affiché sur la carte. */
  function namedStreetAnchor(usable) {
    const streets = (usable || []).filter(isNamedStreetConstraint);
    if (!streets.length) return null;
    const minGeo = weights.streetAnchorMinGeocoding ?? 0.35;
    const ranked = [...streets].sort((a, b) => weightFor(b) - weightFor(a));
    const best = ranked[0];
    const geo = Number.isFinite(best.geocoding_confidence) ? best.geocoding_confidence : 0;
    if (geo < minGeo) return null;
    return { latitude: best.latitude, longitude: best.longitude };
  }

  /**
   * Calcule la zone probable à partir des contraintes géocodées utilisables.
   * @param {object[]} constraints - contraintes avec latitude/longitude (+ access pour les temps)
   * @returns {object} résultat final (voir spec) + heatmap + debug
   */
  function score(constraints) {
    const usable = (constraints || []).filter(
      (c) => Number.isFinite(c.latitude) && Number.isFinite(c.longitude) && !c.rejected
    );
    const rejected = (constraints || []).length - usable.length;

    if (!usable.length) {
      return {
        status: "insufficient",
        confidence: 0,
        center: null,
        estimated_radius_m: null,
        constraints_used: 0,
        constraints_rejected: rejected,
        best_area: { polygon: [] },
        top_candidates: [],
        heatmap: [],
      };
    }

    // Enveloppe des lieux + marge proportionnelle à l'étendue.
    const anchors = usable.map((c) => ({ lat: c.latitude, lon: c.longitude }));
    const rawBox = boundingBox(anchors);
    const diagM = haversineMeters(
      { lat: rawBox.minLat, lon: rawBox.minLon },
      { lat: rawBox.maxLat, lon: rawBox.maxLon }
    );
    const padding = Math.max(1500, diagM * (gridCfg.paddingRatio ?? 0.15) + 1000);
    const bbox = boundingBox(anchors, padding);
    const { cells } = gridFromBoundingBox(bbox, gridCfg.size);

    const totalWeight = usable.reduce((sum, c) => sum + weightFor(c), 0) || 1;
    const weighted = usable.map((c) => ({ constraint: c, weight: weightFor(c) }));

    // Contraintes « dures » (temps / distance précis) : ce sont elles qui
    // décident de la faisabilité conjointe. Les contraintes vagues ne font que
    // moduler le score, jamais déclarer une incohérence.
    const hardCount = usable.filter(
      (c) => c.relation === "travel_time" || c.relation === "distance"
    ).length;

    let maxScore = 0;
    let jointFeasibility = 0; // meilleur min des contraintes dures sur la grille
    const scoredCells = cells.map((cell) => {
      let acc = 0;
      let minHard = Infinity;
      for (const { constraint, weight } of weighted) {
        const s = cellConstraintScore(cell, constraint);
        acc += s * weight;
        if (constraint.relation === "travel_time" || constraint.relation === "distance") {
          if (s < minHard) minHard = s;
        }
      }
      const normalized = acc / totalWeight;
      if (normalized > maxScore) maxScore = normalized;
      const joint = hardCount ? (minHard === Infinity ? 0 : minHard) : normalized;
      if (joint > jointFeasibility) jointFeasibility = joint;
      return { lat: cell.lat, lon: cell.lon, score: normalized };
    });

    // Cluster haute probabilité (>= 80% du max) pour centre, rayon et zone.
    const highCut = maxScore * 0.8;
    const highCells = scoredCells.filter((c) => c.score >= highCut && c.score > 0);

    let center = null;
    let radius = null;
    let polygon = [];
    if (highCells.length) {
      let sw = 0;
      let slat = 0;
      let slon = 0;
      for (const c of highCells) {
        sw += c.score;
        slat += c.lat * c.score;
        slon += c.lon * c.score;
      }
      center = { latitude: slat / sw, longitude: slon / sw };
      const centerPt = { lat: center.latitude, lon: center.longitude };
      radius = Math.round(
        highCells.reduce(
          (m, c) => Math.max(m, haversineMeters(centerPt, { lat: c.lat, lon: c.lon })),
          0
        )
      );
      polygon = convexHull(highCells.map((c) => ({ lat: c.lat, lon: c.lon })));
    }

    const streetAnchor = namedStreetAnchor(usable);
    if (streetAnchor) {
      center = streetAnchor;
      if (highCells.length) {
        const centerPt = { lat: center.latitude, lon: center.longitude };
        radius = Math.round(
          highCells.reduce(
            (m, c) => Math.max(m, haversineMeters(centerPt, { lat: c.lat, lon: c.lon })),
            radius || 0
          )
        );
      }
    }

    const meanGeoConf =
      usable.reduce(
        (s, c) => s + (Number.isFinite(c.geocoding_confidence) ? c.geocoding_confidence : 0.6),
        0
      ) / usable.length;

    const status =
      hardCount && jointFeasibility < consistencyThreshold
        ? "inconsistent"
        : "estimated";

    // Score quasi uniforme sur la grille : le temps de trajet couvre tout le
    // rectangle de recherche. On resserre alors sur le cercle des lieux cités.
    const plateau =
      status === "estimated" &&
      scoredCells.length > 0 &&
      highCells.length / scoredCells.length >= 0.45;
    if (plateau) {
      const focus = clueFocus(usable);
      if (focus) {
        if (!streetAnchor) center = focus.center;
        radius = focus.radius;
      }
    }

    const displayCells =
      plateau && center && radius
        ? scoredCells.map((cell) => {
            const fit = closenessScore(cell, center, radius);
            return { lat: cell.lat, lon: cell.lon, score: fit.score };
          })
        : scoredCells;

    // Candidats distincts : meilleurs scores en évitant les cellules voisines.
    const minSeparationM = plateau
      ? Math.max((radius || 0) / 5, 120)
      : Math.max(radius || 0, 150);
    const ranked = [...displayCells]
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);
    const candidates = [];
    for (const c of ranked) {
      if (candidates.length >= topCandidates) break;
      const tooClose = candidates.some(
        (k) => haversineMeters({ lat: k.latitude, lon: k.longitude }, { lat: c.lat, lon: c.lon }) < minSeparationM
      );
      if (tooClose) continue;
      candidates.push({
        latitude: Number(c.lat.toFixed(6)),
        longitude: Number(c.lon.toFixed(6)),
        score: Number(c.score.toFixed(3)),
      });
    }

    if (streetAnchor && candidates.length) {
      const anchorCandidate = {
        latitude: Number(streetAnchor.latitude.toFixed(6)),
        longitude: Number(streetAnchor.longitude.toFixed(6)),
        score: candidates[0]?.score ?? maxScore,
      };
      const rest = candidates.filter(
        (c) =>
          haversineMeters(
            { lat: c.latitude, lon: c.longitude },
            { lat: anchorCandidate.latitude, lon: anchorCandidate.longitude }
          ) >= minSeparationM
      );
      candidates.length = 0;
      candidates.push(anchorCandidate, ...rest.slice(0, topCandidates - 1));
    }

    // En cas d'incohérence, la confiance reflète la (faible) faisabilité
    // conjointe plutôt que le meilleur score d'une seule contrainte.
    const confidenceBase = status === "inconsistent" ? jointFeasibility : maxScore;
    const confidence = Number(
      (clamp(confidenceBase, 0, 1) * clamp(meanGeoConf, 0, 1)).toFixed(3)
    );

    const heatmap = displayCells
      .filter((c) => c.score >= gridCfg.heatmapMinScore)
      .map((c) => ({
        lat: Number(c.lat.toFixed(6)),
        lng: Number(c.lon.toFixed(6)),
        score: Number(c.score.toFixed(3)),
      }));

    if (plateau && heatmap.length >= 3) {
      polygon = convexHull(heatmap.map((c) => ({ lat: c.lat, lon: c.lng })));
    }

    const result = {
      status,
      confidence,
      center: center
        ? {
            latitude: Number(center.latitude.toFixed(6)),
            longitude: Number(center.longitude.toFixed(6)),
          }
        : null,
      estimated_radius_m: radius,
      constraints_used: usable.length,
      constraints_rejected: rejected,
      best_area: { polygon },
      top_candidates: candidates,
      heatmap,
    };

    if (status === "inconsistent") {
      result.warnings = ["Les contraintes géographiques semblent incompatibles."];
    }

    return result;
  }

  return {
    score,
    vagueRadiusFor,
    weightFor,
    cellConstraintScore,
    upperToleranceScore: (a, m, t = toleranceMinutes) => upperToleranceScore(a, m, t),
  };
}

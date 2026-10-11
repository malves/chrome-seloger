import test from "node:test";
import assert from "node:assert/strict";

import {
  haversineMeters,
  pointInPolygon,
  boundingBox,
  gridFromBoundingBox,
} from "../src/lib/geo.js";
import createScoringService, {
  upperToleranceScore,
  lowerToleranceScore,
} from "../src/services/location/scoring.service.js";

/* --------------------------- Primitives géo ---------------------------- */

test("haversineMeters : ordre de grandeur plausible", () => {
  const d = haversineMeters({ lat: 48.0, lon: 2.0 }, { lat: 48.0, lon: 2.001 });
  assert.ok(d > 60 && d < 85, `distance inattendue : ${d}`);
  assert.equal(haversineMeters({ lat: 1, lon: 1 }, { lat: 1, lon: 1 }), 0);
});

test("pointInPolygon : appartenance à un carré (coordonnées GeoJSON [lon,lat])", () => {
  const square = [
    [0, 0],
    [0, 2],
    [2, 2],
    [2, 0],
    [0, 0],
  ];
  assert.equal(pointInPolygon({ lat: 1, lon: 1 }, square), true);
  assert.equal(pointInPolygon({ lat: 3, lon: 1 }, square), false);
  assert.equal(pointInPolygon({ lat: 1, lon: -1 }, square), false);
});

test("gridFromBoundingBox : size × size cellules à l'intérieur de la bbox", () => {
  const bbox = boundingBox([
    { lat: 48.0, lon: 2.0 },
    { lat: 48.1, lon: 2.1 },
  ]);
  const { cells } = gridFromBoundingBox(bbox, 10);
  assert.equal(cells.length, 100);
  for (const c of cells) {
    assert.ok(c.lat >= bbox.minLat && c.lat <= bbox.maxLat);
    assert.ok(c.lon >= bbox.minLon && c.lon <= bbox.maxLon);
  }
});

/* --------------------------- Tolérance ---------------------------- */

const LINEAR = { graceRatio: 0, spanRatio: 1, curve: 1 };

test("upperToleranceScore : 1 jusqu'à M, décroissance linéaire, 0 au seuil", () => {
  assert.equal(upperToleranceScore(5, 5, LINEAR), 1);
  assert.equal(upperToleranceScore(4, 5, LINEAR), 1);
  assert.ok(Math.abs(upperToleranceScore(6, 5, LINEAR) - 0.8) < 1e-9);
  assert.ok(Math.abs(upperToleranceScore(7, 5, LINEAR) - 0.6) < 1e-9);
  assert.equal(upperToleranceScore(10, 5, LINEAR), 0);
  assert.equal(upperToleranceScore(12, 5, LINEAR), 0);
  assert.equal(upperToleranceScore(Infinity, 5, LINEAR), 0);
});

test("upperToleranceScore : la courbe par défaut (>1) est plus sévère que linéaire", () => {
  const convex = { graceRatio: 0, spanRatio: 1, curve: 1.5 };
  assert.ok(upperToleranceScore(8, 5, convex) < upperToleranceScore(8, 5, LINEAR));
  // Toujours décroissante et bornée 0..1.
  assert.ok(upperToleranceScore(6, 5, convex) <= 1);
  assert.ok(upperToleranceScore(6, 5, convex) > upperToleranceScore(8, 5, convex));
});

test("lowerToleranceScore : borne basse pour « entre X et Y »", () => {
  assert.equal(lowerToleranceScore(3, 3, LINEAR), 1);
  assert.equal(lowerToleranceScore(4, 3, LINEAR), 1);
  assert.ok(Math.abs(lowerToleranceScore(2, 3, LINEAR) - 2 / 3) < 1e-9);
  assert.equal(lowerToleranceScore(0, 3, LINEAR), 0);
  // Pas de borne basse → neutre.
  assert.equal(lowerToleranceScore(1, null, LINEAR), 1);
});

/* --------------------------- Poids & distances vagues ---------------------------- */

test("weightFor : précis > vague, pondéré par la confiance géocodage", () => {
  const scoring = createScoringService();
  const precise = scoring.weightFor({
    relation: "travel_time",
    geocoding_confidence: 1,
  });
  const vague = scoring.weightFor({
    relation: "near",
    vague_kind: "proche",
    geocoding_confidence: 1,
  });
  assert.ok(precise > vague, "une contrainte précise doit peser plus qu'une vague");

  const lowConf = scoring.weightFor({
    relation: "travel_time",
    geocoding_confidence: 0.5,
  });
  assert.ok(lowConf < precise, "une faible confiance géocodage réduit le poids");
});

test("vagueRadiusFor : « à deux pas » plus serré que « à proximité »", () => {
  const scoring = createScoringService();
  const deuxPas = scoring.vagueRadiusFor({ vague_kind: "a deux pas" });
  const proximite = scoring.vagueRadiusFor({ vague_kind: "a proximite" });
  assert.ok(deuxPas < proximite);
  // Formule inconnue → distance par défaut.
  assert.ok(scoring.vagueRadiusFor({ vague_kind: null }) > 0);
});

test("weightFor : rue nommée plus lourde qu'un POI « proche »", () => {
  const scoring = createScoringService();
  const street = scoring.weightFor({
    relation: "near",
    place_type: "address",
    vague_kind: "proche",
    geocoding_confidence: 1,
  });
  const poi = scoring.weightFor({
    relation: "near",
    place_type: "train_station",
    vague_kind: "proche",
    geocoding_confidence: 1,
  });
  assert.ok(street > poi);
});

test("vagueRadiusFor : voie nommée plus serrée qu'un POI proche", () => {
  const scoring = createScoringService();
  const street = scoring.vagueRadiusFor({
    relation: "near",
    place_type: "address",
    vague_kind: "proche",
  });
  const poi = scoring.vagueRadiusFor({
    relation: "near",
    vague_kind: "proche",
  });
  assert.ok(street < poi);
});

test("score : centre ancré sur la voie nommée", () => {
  const scoring = createScoringService();
  const streetLat = 48.866;
  const streetLon = 2.219;
  const result = scoring.score([
    {
      relation: "near",
      place_type: "address",
      vague_kind: "proche",
      latitude: streetLat,
      longitude: streetLon,
      geocoding_confidence: 0.85,
    },
    {
      relation: "near",
      place_type: "train_station",
      vague_kind: "proche",
      latitude: 48.872,
      longitude: 2.235,
      geocoding_confidence: 0.9,
    },
  ]);
  assert.ok(result.center);
  const dToStreet = haversineMeters(
    { lat: result.center.latitude, lon: result.center.longitude },
    { lat: streetLat, lon: streetLon }
  );
  assert.ok(dToStreet < 30, `centre trop loin de la rue : ${dToStreet} m`);
  assert.equal(result.top_candidates[0]?.latitude, result.center.latitude);
});

/* --------------------------- Score spatial ---------------------------- */

test("score : contraintes compatibles → zone estimée resserrée", () => {
  const scoring = createScoringService();
  const result = scoring.score([
    {
      relation: "travel_time",
      transport: "walking",
      max_minutes: 5,
      latitude: 48.84,
      longitude: 2.21,
      geocoding_confidence: 0.95,
    },
    {
      relation: "travel_time",
      transport: "walking",
      max_minutes: 5,
      latitude: 48.8405,
      longitude: 2.211,
      geocoding_confidence: 0.9,
    },
  ]);

  assert.equal(result.status, "estimated");
  assert.equal(result.constraints_used, 2);
  assert.equal(result.constraints_rejected, 0);
  assert.ok(result.center, "un centre doit être estimé");
  assert.ok(result.heatmap.length > 0, "la heatmap ne doit pas être vide");
  assert.ok(result.top_candidates.length > 0);
  assert.ok(result.estimated_radius_m > 0);
  // Le centre tombe près des deux lieux.
  assert.ok(Math.abs(result.center.latitude - 48.8402) < 0.01);
  assert.ok(Math.abs(result.center.longitude - 2.2105) < 0.01);
});

test("score : temps de trajet trop larges → cercle resserré et dégradé", () => {
  const scoring = createScoringService();
  const result = scoring.score([
    {
      relation: "travel_time",
      transport: "driving",
      max_minutes: 15,
      min_minutes: 10,
      latitude: 48.86,
      longitude: 2.18,
      geocoding_confidence: 0.9,
      access: {
        mode: "isochrone",
        bands: [
          {
            minutes: 15,
            polygon: [
              [2.1, 48.8],
              [2.26, 48.8],
              [2.26, 48.92],
              [2.1, 48.92],
              [2.1, 48.8],
            ],
          },
        ],
      },
    },
    {
      relation: "travel_time",
      transport: "driving",
      max_minutes: 15,
      min_minutes: 10,
      latitude: 48.865,
      longitude: 2.19,
      geocoding_confidence: 0.9,
      access: {
        mode: "isochrone",
        bands: [
          {
            minutes: 15,
            polygon: [
              [2.1, 48.8],
              [2.26, 48.8],
              [2.26, 48.92],
              [2.1, 48.92],
              [2.1, 48.8],
            ],
          },
        ],
      },
    },
  ]);

  assert.equal(result.status, "estimated");
  assert.ok(result.estimated_radius_m <= 1500, `rayon trop grand : ${result.estimated_radius_m}`);
  assert.ok(result.estimated_radius_m >= 350);
  const scores = result.heatmap.map((c) => c.score);
  assert.ok(scores.length > 10);
  assert.ok(Math.max(...scores) - Math.min(...scores) > 0.4, "le dégradé doit rester visible");
  const center = result.center;
  for (const cell of result.heatmap) {
    const d = haversineMeters(
      { lat: center.latitude, lon: center.longitude },
      { lat: cell.lat, lon: cell.lng }
    );
    assert.ok(d <= result.estimated_radius_m + 1, `cellule hors cercle : ${d}`);
  }
});

test("score : contraintes incompatibles → statut inconsistent", () => {
  const scoring = createScoringService();
  const result = scoring.score([
    {
      relation: "travel_time",
      transport: "walking",
      max_minutes: 5,
      latitude: 48.84,
      longitude: 2.21,
      geocoding_confidence: 0.95,
    },
    {
      relation: "travel_time",
      transport: "walking",
      max_minutes: 5,
      latitude: 48.84,
      longitude: 2.5, // ~21 km plus loin : aucune zone commune
      geocoding_confidence: 0.95,
    },
  ]);

  assert.equal(result.status, "inconsistent");
  assert.ok(Array.isArray(result.warnings) && result.warnings.length > 0);
  assert.ok(result.confidence < 0.5);
});

test("score : les contraintes rejetées sont comptées, pas utilisées", () => {
  const scoring = createScoringService();
  const result = scoring.score([
    {
      relation: "near",
      vague_kind: "proche",
      latitude: 48.84,
      longitude: 2.21,
      geocoding_confidence: 0.8,
    },
    { place: "Inconnu", rejected: true, reject_reason: "not_found" },
  ]);
  assert.equal(result.constraints_used, 1);
  assert.equal(result.constraints_rejected, 1);
});

test("score : aucune contrainte exploitable → insufficient", () => {
  const scoring = createScoringService();
  const result = scoring.score([{ place: "X", rejected: true }]);
  assert.equal(result.status, "insufficient");
  assert.equal(result.constraints_used, 0);
  assert.deepEqual(result.heatmap, []);
});

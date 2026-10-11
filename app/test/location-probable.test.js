import test from "node:test";
import assert from "node:assert/strict";

import createProbableLocationService from "../src/services/location/probable-location.service.js";
import createScoringService from "../src/services/location/scoring.service.js";

/** Accessibilité en mode cercle (aucun ORS) pour rester déterministe. */
const circleAccess = {
  configured: () => false,
  buildTimeAccess: async (c) => ({
    mode: "circle",
    transport: c.transport,
    center: { lat: c.latitude, lon: c.longitude },
    maxMinutes: c.max_minutes,
    cutoffMinutes: c.max_minutes * 2,
  }),
};

function engineWith({ extraction, geocoded, cityCenter = { lat: 48.84, lon: 2.21 } }) {
  return createProbableLocationService({
    extractor: { configured: () => true, extract: async () => extraction },
    geocoder: {
      geocodeCity: async () => cityCenter,
      geocodeAddress: async () => cityCenter,
      geocodeConstraints: async () => ({ constraints: geocoded, cityCenter }),
    },
    accessibility: circleAccess,
    scoring: createScoringService(),
  });
}

test("estimate : bien déjà localisé → exact_address (court-circuit)", async () => {
  const engine = createProbableLocationService({
    extractor: {
      configured: () => true,
      extract: async () => {
        throw new Error("ne doit pas être appelé");
      },
    },
  });
  const res = await engine.estimate({
    description: "peu importe",
    userLat: 48.8559,
    userLng: 2.2171,
  });
  assert.equal(res.status, "exact_address");
  assert.deepEqual(res.center, { latitude: 48.8559, longitude: 2.2171 });
});

test("estimate : LLM indisponible → unavailable", async () => {
  const engine = createProbableLocationService({
    extractor: {
      configured: () => false,
      extract: async () => ({ available: false, constraints: [], exactAddress: null }),
    },
  });
  const res = await engine.estimate({ description: "à 5 min de la gare" });
  assert.equal(res.status, "unavailable");
});

test("estimate : aucune contrainte extraite → insufficient", async () => {
  const engine = engineWith({
    extraction: { available: true, exactAddress: null, constraints: [] },
    geocoded: [],
  });
  const res = await engine.estimate({ description: "joli T3 lumineux" });
  assert.equal(res.status, "insufficient");
});

test("estimate : pipeline nominal → estimated + heatmap + contraintes debug", async () => {
  const extraction = {
    available: true,
    exactAddress: null,
    constraints: [
      {
        place: "Gare du Val d'Or",
        place_type: "train_station",
        relation: "travel_time",
        max_minutes: 5,
        transport: "walking",
        precision: "approximate",
        confidence: 0.98,
      },
      {
        place: "Monoprix",
        place_type: "shop",
        relation: "near",
        vague_kind: "proche",
        precision: "vague",
        confidence: 0.88,
      },
    ],
  };
  const geocoded = [
    {
      ...extraction.constraints[0],
      latitude: 48.8405,
      longitude: 2.211,
      geocoding_confidence: 0.95,
    },
    {
      ...extraction.constraints[1],
      latitude: 48.842,
      longitude: 2.215,
      geocoding_confidence: 0.85,
    },
  ];

  const engine = engineWith({ extraction, geocoded });
  const res = await engine.estimate({
    description: "À 5 min à pied de la gare du Val d'Or et proche du Monoprix.",
    city: "Saint-Cloud",
    postalCode: "92210",
  });

  assert.equal(res.status, "estimated");
  assert.equal(res.constraints_used, 2);
  assert.equal(res.constraints_rejected, 0);
  assert.ok(res.center);
  assert.ok(res.heatmap.length > 0);
  assert.ok(res.best_area.polygon.length >= 3);
  // Contraintes « spec » renvoyées pour le débogage côté client.
  assert.equal(res.constraints.length, 2);
  assert.equal(res.constraints[0].relation, "travel_time");
  assert.equal(res.constraints[0].access_mode, "circle");
});

test("estimate : contraintes incompatibles → inconsistent", async () => {
  const base = {
    relation: "travel_time",
    place_type: "train_station",
    transport: "walking",
    max_minutes: 5,
    precision: "approximate",
    confidence: 0.95,
  };
  const extraction = {
    available: true,
    exactAddress: null,
    constraints: [
      { ...base, place: "Gare A" },
      { ...base, place: "Gare B" },
    ],
  };
  const geocoded = [
    { ...base, place: "Gare A", latitude: 48.84, longitude: 2.21, geocoding_confidence: 0.95 },
    { ...base, place: "Gare B", latitude: 48.84, longitude: 2.5, geocoding_confidence: 0.95 },
  ];
  const engine = engineWith({ extraction, geocoded });
  const res = await engine.estimate({ description: "..." });
  assert.equal(res.status, "inconsistent");
  assert.ok(res.warnings.length > 0);
});

test("estimate : une contrainte géocodée rejetée est comptée", async () => {
  const extraction = {
    available: true,
    exactAddress: null,
    constraints: [
      { place: "A", place_type: "shop", relation: "near", vague_kind: "proche" },
      { place: "Inconnu", place_type: "other", relation: "near" },
    ],
  };
  const geocoded = [
    {
      place: "A",
      place_type: "shop",
      relation: "near",
      vague_kind: "proche",
      latitude: 48.84,
      longitude: 2.21,
      geocoding_confidence: 0.8,
    },
    { place: "Inconnu", rejected: true, reject_reason: "not_found" },
  ];
  const engine = engineWith({ extraction, geocoded });
  const res = await engine.estimate({ description: "..." });
  assert.equal(res.constraints_used, 1);
  assert.equal(res.constraints_rejected, 1);
});

test("estimate : rue sans numéro → contraintes POI, pas exact_address", async () => {
  const extraction = {
    available: true,
    exactAddress: "rue des Carrières",
    constraints: [
      {
        place: "gare de Suresnes",
        place_type: "train_station",
        relation: "near",
        precision: "approximate",
        confidence: 0.9,
      },
    ],
  };
  const geocoded = [
    {
      place: "rue des Carrières",
      place_type: "address",
      relation: "near",
      latitude: 48.866,
      longitude: 2.219,
      geocoding_confidence: 0.7,
      rejected: false,
    },
    {
      place: "gare de Suresnes",
      place_type: "train_station",
      relation: "near",
      latitude: 48.87,
      longitude: 2.22,
      geocoding_confidence: 0.85,
      rejected: false,
    },
  ];
  const engine = engineWith({ extraction, geocoded });
  const res = await engine.estimate({
    description: "rue des Carrières, proche gare de Suresnes",
    city: "Suresnes",
    postalCode: "92150",
  });
  assert.notEqual(res.status, "exact_address");
  assert.ok(res.constraints_used >= 1);
});

test("estimate : adresse exacte dans le texte → exact_address géocodée", async () => {
  const engine = createProbableLocationService({
    extractor: {
      configured: () => true,
      extract: async () => ({
        available: true,
        exactAddress: "12 rue des Lilas",
        constraints: [],
      }),
    },
    geocoder: {
      geocodeAddress: async () => ({ lat: 48.857, lon: 2.218 }),
    },
    accessibility: circleAccess,
    scoring: createScoringService(),
  });
  const res = await engine.estimate({ description: "12 rue des Lilas, Saint-Cloud" });
  assert.equal(res.status, "exact_address");
  assert.equal(res.exact_address, "12 rue des Lilas");
  assert.deepEqual(res.center, { latitude: 48.857, longitude: 2.218 });
});

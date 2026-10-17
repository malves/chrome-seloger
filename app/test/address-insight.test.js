/**
 * Service « Infos adresse » : géocodage BAN (mocké), agrégation du prix au m²
 * DVF, évolution, ventes et DPE. Aucun appel réseau réel.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import createRepositories from "../src/repositories/index.js";
import createAddressInsightService from "../src/services/address-insight.service.js";

const CONFIG = {
  enrichment: { timeoutMs: 8000 },
  dvf: {
    radiusMeters: 250,
    radiusMinSample: 5,
    radiusYears: 5,
    radiusRecencyHalfLifeDays: 540,
    radiusOutlierLowRatio: 0.5,
  },
};

const LAT = 48.8851;
const LNG = 2.2381;

function banResponse(label, extra = {}) {
  return {
    ok: true,
    async json() {
      return {
        features: [
          {
            geometry: { type: "Point", coordinates: [LNG, LAT] },
            properties: {
              label,
              score: 0.98,
              postcode: "92800",
              citycode: "92062",
              city: "Puteaux",
              type: "housenumber",
              street: "Rue de Paris",
              ...extra,
            },
          },
        ],
      };
    },
  };
}

function seedApartments(repositories, pricePerM2, count) {
  const year = new Date().getFullYear() - 1;
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      insee_code: "92062",
      dept_code: "92",
      year,
      mutation_date: `${year}-06-15`,
      type_local: "apartment",
      price: pricePerM2 * 70,
      surface: 70,
      price_per_m2: pricePerM2,
      lat: LAT + i * 0.00001,
      lng: LNG + i * 0.00001,
    });
  }
  repositories.dvf.insertMutationBatch(rows);
}

test("analyze : adresse introuvable", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const repositories = createRepositories(db);
  const service = createAddressInsightService({
    repositories,
    config: CONFIG,
    fetchImpl: async () => ({ ok: true, async json() { return { features: [] }; } }),
  });

  const result = await service.analyze("adresse inconnue zzz");
  assert.equal(result.status, "not_found");
});

test("analyze : prix au m² DVF autour du point géocodé", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const repositories = createRepositories(db);
  seedApartments(repositories, 6000, 8);
  repositories.dvf.rebuildCommuneStats();

  const service = createAddressInsightService({
    repositories,
    config: CONFIG,
    fetchImpl: async () => banResponse("10 Rue de Paris 92800 Puteaux"),
  });

  const result = await service.analyze("10 rue de Paris, 92800 Puteaux");
  assert.equal(result.status, "ok");
  assert.equal(result.place.postal_code, "92800");
  assert.equal(result.place.insee_code, "92062");
  assert.equal(result.place.department, "92");
  assert.ok(result.dvf_available);
  assert.ok(result.prices.apartment);
  assert.equal(result.prices.apartment.median_price_m2, 6000);
  assert.ok(result.prices.apartment.count >= 5);
  // Pas de ventes de maison : prix nul.
  assert.equal(result.prices.house, null);
  // Ventes détaillées renvoyées pour le type appartement.
  assert.ok(result.sales.apartment.length >= 5);
});

test("analyze : cache le géocodage BAN entre deux appels", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const repositories = createRepositories(db);
  let calls = 0;
  const service = createAddressInsightService({
    repositories,
    config: CONFIG,
    fetchImpl: async () => {
      calls += 1;
      return banResponse("5 Rue Victor Hugo 92800 Puteaux");
    },
  });

  await service.analyze("5 rue victor hugo 92800 puteaux");
  await service.analyze("5 rue victor hugo 92800 puteaux");
  assert.equal(calls, 1, "le second appel vient du cache geocode_cache");
});

test("suggest : proxy BAN renvoie des libellés", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const repositories = createRepositories(db);
  const service = createAddressInsightService({
    repositories,
    config: CONFIG,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          features: [
            { properties: { label: "10 Rue de Paris 92800 Puteaux", context: "92, Hauts-de-Seine", postcode: "92800", city: "Puteaux" } },
          ],
        };
      },
    }),
  });

  const suggestions = await service.suggest("10 rue de paris");
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].postal_code, "92800");

  // Requête trop courte : pas d'appel.
  assert.deepEqual(await service.suggest("ab"), []);
});

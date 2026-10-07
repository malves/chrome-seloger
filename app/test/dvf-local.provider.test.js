import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import createRepositories from "../src/repositories/index.js";
import dvfLocalProvider from "../src/services/enrichment/dvf-local.provider.js";

const CONFIG = {
  dvf: {
    radiusMeters: 250,
    radiusMinSample: 5,
    radiusYears: 5,
    radiusRecencyHalfLifeDays: 540,
    radiusOutlierLowRatio: 0.5,
  },
};

function seedMutations(repositories, { lat, lng, count, pricePerM2, mutationDate }) {
  const year = mutationDate
    ? Number.parseInt(String(mutationDate).slice(0, 4), 10)
    : new Date().getFullYear() - 1;
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    // Points très proches du centre (quelques mètres), donc dans le rayon.
    rows.push({
      insee_code: "92064",
      dept_code: "92",
      year,
      mutation_date: mutationDate || `${year}-06-15`,
      type_local: "apartment",
      price: pricePerM2 * 80,
      surface: 80,
      price_per_m2: pricePerM2,
      lat: lat + i * 0.00001,
      lng: lng + i * 0.00001,
    });
  }
  repositories.dvf.insertMutationBatch(rows);
}

test("provider dvf-local : médiane du rayon autour de l'adresse saisie", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const repositories = createRepositories(db);

  const lat = 48.8851;
  const lng = 2.2381;
  seedMutations(repositories, { lat, lng, count: 7, pricePerM2: 6000 });

  const listing = {
    id: 1,
    property_type: "apartment",
    transaction_type: "sale",
    price: 520000,
    surface: 80,
    user_address: "10 rue de Paris, 92800 Puteaux",
    user_lat: lat,
    user_lng: lng,
  };

  const data = await dvfLocalProvider.fetch({ listing, repositories, config: CONFIG });

  assert.equal(data.source, "dvf");
  assert.equal(data.radius.meters, 250);
  assert.equal(data.radius.median_price_m2, 6000);
  assert.ok(data.radius.count >= 5);
  assert.equal(data.radius.enough, true);
  assert.ok(data.verdict);
  assert.equal(data.verdict.reference_scope, "radius");
  assert.equal(data.verdict.listing_price_m2, 6500);
  assert.equal(data.radius.recency_weighted, true);
  assert.equal(data.radius.count_reference, data.radius.count);
  assert.ok(Array.isArray(data.radius.sales) && data.radius.sales.length >= 5);
});

test("provider dvf-local : écarte les ventes très sous la médiane du rayon", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const repositories = createRepositories(db);

  const lat = 48.8851;
  const lng = 2.2381;
  seedMutations(repositories, {
    lat,
    lng,
    count: 5,
    pricePerM2: 300,
    mutationDate: "2024-01-01",
  });
  seedMutations(repositories, {
    lat,
    lng,
    count: 5,
    pricePerM2: 6000,
    mutationDate: "2025-01-01",
  });

  const listing = {
    id: 3,
    property_type: "apartment",
    transaction_type: "sale",
    price: 520000,
    surface: 80,
    user_address: "10 rue de Paris, 92800 Puteaux",
    user_lat: lat,
    user_lng: lng,
  };

  const data = await dvfLocalProvider.fetch({ listing, repositories, config: CONFIG });

  assert.equal(data.radius.count, 10);
  assert.equal(data.radius.count_reference, 5);
  assert.equal(data.radius.outliers_excluded, 5);
});

test("provider dvf-local : pondération récente sur la médiane du rayon", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const repositories = createRepositories(db);

  const lat = 48.8851;
  const lng = 2.2381;
  seedMutations(repositories, {
    lat,
    lng,
    count: 4,
    pricePerM2: 4000,
    mutationDate: "2021-06-01",
  });
  seedMutations(repositories, {
    lat,
    lng,
    count: 4,
    pricePerM2: 9000,
    mutationDate: "2025-02-01",
  });

  const listing = {
    id: 2,
    property_type: "apartment",
    transaction_type: "sale",
    price: 720000,
    surface: 80,
    user_address: "10 rue de Paris, 92800 Puteaux",
    user_lat: lat,
    user_lng: lng,
  };

  const data = await dvfLocalProvider.fetch({ listing, repositories, config: CONFIG });

  assert.ok(data.radius.median_price_m2 > 6000);
  assert.ok(data.radius.count >= 5);
});

test("provider dvf-local : ignoré sans adresse saisie", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const repositories = createRepositories(db);
  seedMutations(repositories, { lat: 48.88, lng: 2.23, count: 5, pricePerM2: 6000 });

  const listing = {
    id: 1,
    property_type: "apartment",
    transaction_type: "sale",
    price: 520000,
    surface: 80,
    city: "Puteaux",
  };

  await assert.rejects(
    dvfLocalProvider.fetch({ listing, repositories, config: CONFIG }),
    /adresse exacte/
  );
});

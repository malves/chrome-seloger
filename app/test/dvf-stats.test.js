import test from "node:test";
import assert from "node:assert/strict";
import {
  median,
  haversineMeters,
  boundingBox,
  pricesWithinRadius,
  priceVerdict,
  buildEvolution,
} from "../src/lib/dvf-stats.js";

test("median gère tailles paires et impaires", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});

test("pricesWithinRadius ne garde que les points dans le rayon", () => {
  const center = { lat: 44.8378, lng: -0.5792 };
  const points = [
    { lat: 44.8379, lng: -0.5793, price_per_m2: 3000 }, // ~15 m
    { lat: 44.9, lng: -0.6, price_per_m2: 9999 }, // ~7 km
  ];
  const prices = pricesWithinRadius(points, center.lat, center.lng, 500);
  assert.deepEqual(prices, [3000]);
});

test("boundingBox encadre le point", () => {
  const bbox = boundingBox(44.8378, -0.5792, 500);
  assert.ok(bbox.minLat < 44.8378 && bbox.maxLat > 44.8378);
  assert.ok(bbox.minLng < -0.5792 && bbox.maxLng > -0.5792);
});

test("haversineMeters ~ 0 pour le même point", () => {
  assert.ok(haversineMeters(44.8, -0.5, 44.8, -0.5) < 1);
});

test("priceVerdict classe le positionnement du prix", () => {
  assert.equal(priceVerdict(1700, 2000).tone, "ok"); // index 85
  assert.equal(priceVerdict(2000, 2000).tone, "mid"); // index 100
  const high = priceVerdict(4000, 2000); // index 200
  assert.equal(high.index, 200);
  assert.equal(high.tone, "high");
  assert.equal(priceVerdict(2000, 0), null);
});

test("buildEvolution calcule la tendance et le verdict", () => {
  const evo = buildEvolution([
    { year: 2019, median_price_m2: 2000, count: 3 },
    { year: 2023, median_price_m2: 3000, count: 5 },
  ]);
  assert.ok(evo);
  assert.equal(evo.trend_from_year, 2019);
  assert.equal(evo.trend_to_year, 2023);
  assert.equal(evo.trend_pct, 50);
  assert.equal(evo.tone, "ok");
  assert.equal(buildEvolution([{ year: 2023, median_price_m2: 3000 }]), null);
});

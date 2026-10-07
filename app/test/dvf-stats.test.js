import test from "node:test";
import assert from "node:assert/strict";
import {
  median,
  haversineMeters,
  boundingBox,
  pricesWithinRadius,
  recencyWeightedMedian,
  filterLowOutlierSales,
  buildDvfRadiusReference,
  priceVerdict,
  buildEvolution,
  evolutionHorizons,
  applyEvolutionHorizons,
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

test("filterLowOutlierSales retire les ventes très sous la médiane locale", () => {
  const sales = [
    { price_per_m2: 200 },
    { price_per_m2: 300 },
    { price_per_m2: 3000 },
    { price_per_m2: 3100 },
    { price_per_m2: 3200 },
  ];
  const filtered = filterLowOutlierSales(sales, { lowRatio: 0.5 });
  assert.equal(filtered.countTotal, 5);
  assert.equal(filtered.countReference, 3);
  assert.equal(filtered.excluded, 2);
  assert.equal(filtered.kept.length, 3);
});

test("buildDvfRadiusReference expose le détail des ventes", () => {
  const ref = buildDvfRadiusReference(
    [
      { price: 10000, surface: 47, price_per_m2: 212, year: 2025, distance_m: 10 },
      { price: 123500, surface: 40, price_per_m2: 3087.5, year: 2024, distance_m: 50 },
    ],
    { now: new Date("2025-06-01T12:00:00Z"), halfLifeDays: 540, outlierLowRatio: 0.5 }
  );
  assert.equal(ref.count, 2);
  assert.equal(ref.sales.length, 2);
  assert.equal(ref.outliers_excluded, 1);
  assert.equal(ref.sales.find((s) => s.price_per_m2 === 212).used_in_reference, false);
});

test("recencyWeightedMedian favorise les ventes récentes", () => {
  const now = new Date("2025-06-01T12:00:00Z");
  const sales = [
    { price_per_m2: 4000, mutation_date: "2020-01-15" },
    { price_per_m2: 4000, mutation_date: "2020-06-01" },
    { price_per_m2: 4000, mutation_date: "2021-01-01" },
    { price_per_m2: 8000, mutation_date: "2025-03-01" },
    { price_per_m2: 8000, mutation_date: "2025-04-01" },
  ];
  const weighted = recencyWeightedMedian(sales, { now, halfLifeDays: 540 });
  const plain = median(sales.map((s) => s.price_per_m2));
  assert.equal(plain, 4000);
  assert.equal(weighted, 8000);
});

test("priceVerdict classe le positionnement du prix", () => {
  assert.equal(priceVerdict(1700, 2000).tone, "ok"); // index 85
  assert.equal(priceVerdict(2000, 2000).tone, "mid"); // index 100
  const high = priceVerdict(4000, 2000); // index 200
  assert.equal(high.index, 200);
  assert.equal(high.tone, "high");
  assert.equal(priceVerdict(2000, 0), null);
});

test("buildEvolution calcule la tendance, l'index 100 et variations 1–5 ans", () => {
  const evo = buildEvolution([
    { year: 2019, median_price_m2: 2000, count: 3 },
    { year: 2022, median_price_m2: 2200, count: 4 },
    { year: 2023, median_price_m2: 3000, count: 5 },
  ]);
  assert.ok(evo);
  assert.equal(evo.trend_from_year, 2019);
  assert.equal(evo.trend_to_year, 2023);
  assert.equal(evo.trend_pct, 50);
  assert.equal(evo.y1, 36.4); // 3000 vs 2200
  assert.equal(evo.y4, 50); // 3000 vs 2019
  assert.equal(evo.y5, 50); // repli fenêtre 2019 → 2023
  assert.equal(evo.y2, null);
  assert.equal(evo.y3, null);
  assert.equal(evo.variations[4], 50);
  assert.equal(evo.tone, "ok");
  assert.equal(evo.points[0].index, 100);
  assert.equal(evo.points[2].index, 150);
  assert.equal(buildEvolution([{ year: 2023, median_price_m2: 3000 }]), null);
});

test("buildEvolution remplit y1–y5 quand les années de référence existent", () => {
  const evo = buildEvolution([
    { year: 2018, median_price_m2: 2000, count: 1 },
    { year: 2019, median_price_m2: 2100, count: 1 },
    { year: 2020, median_price_m2: 2200, count: 1 },
    { year: 2021, median_price_m2: 2300, count: 1 },
    { year: 2022, median_price_m2: 2400, count: 1 },
    { year: 2023, median_price_m2: 3000, count: 1 },
  ]);
  assert.equal(evo.y1, 25); // 3000 vs 2400
  assert.equal(evo.y2, 30.4); // 3000 vs 2021 (2300)
  assert.equal(evo.y5, 50); // 3000 vs 2018
});

test("applyEvolutionHorizons recalcule y2–y4 depuis un cache incomplet", () => {
  const evo = {
    points: [
      { year: 2021, median_price_m2: 10000, index: 100, count: 10 },
      { year: 2022, median_price_m2: 10100, index: 101, count: 10 },
      { year: 2023, median_price_m2: 9500, index: 95, count: 10 },
      { year: 2024, median_price_m2: 9000, index: 90, count: 10 },
      { year: 2025, median_price_m2: 9081, index: 90.8, count: 10 },
    ],
    y1: 0.9,
    y5: -10.8,
  };
  applyEvolutionHorizons(evo);
  assert.equal(evo.y2, evolutionHorizons(evo.points)[2]);
  assert.ok(evo.y2 != null);
  assert.ok(evo.y3 != null);
  assert.ok(evo.y4 != null);
});

test("buildEvolution borne la fenêtre à 5 ans et ignore y1 sans année N-1", () => {
  const evo = buildEvolution([
    { year: 2016, median_price_m2: 1000, count: 1 },
    { year: 2017, median_price_m2: 1050, count: 1 },
    { year: 2018, median_price_m2: 1100, count: 1 },
    { year: 2019, median_price_m2: 2000, count: 3 },
    { year: 2021, median_price_m2: 2500, count: 4 },
    { year: 2023, median_price_m2: 3000, count: 5 },
  ]);
  assert.equal(evo.points.length, 5);
  assert.equal(evo.trend_from_year, 2017);
  assert.equal(evo.points[0].index, 100);
  assert.equal(evo.y1, null);
  assert.equal(evo.y5, 172.7); // 3000 vs 2018 (1100), pas le trend fenêtre
});

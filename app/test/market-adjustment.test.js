import test from "node:test";
import assert from "node:assert/strict";
import { surfaceComparableReference } from "../src/lib/market-adjustment.js";

function sale(year, surface, pricePerM2) {
  return {
    year,
    surface,
    price_per_m2: pricePerM2,
    recency_weight: 1,
    used_in_reference: true,
  };
}

test("surface comparable : médiane et P25–P75 sur la tranche ±20 %", () => {
  const radius = {
    median_price_m2: 7000,
    sales: [
      sale(2025, 40, 10000),
      sale(2025, 50, 9000),
      sale(2025, 110, 6000),
      sale(2025, 120, 6200),
      sale(2024, 115, 6400),
      sale(2024, 130, 7000),
    ],
  };
  const result = surfaceComparableReference(radius, 120, null);
  assert.equal(result.surface_filtered, true);
  assert.equal(result.count_in_band, 4);
  assert.equal(result.surface_band.min, 96);
  assert.equal(result.surface_band.max, 144);
  assert.equal(result.median_price_m2, 6200);
  assert.equal(result.p25_price_m2, 6150);
  assert.equal(result.p75_price_m2, 6550);
});

test("surface comparable : repli sur tout le rayon si trop peu en tranche", () => {
  const radius = {
    median_price_m2: 8000,
    sales: [sale(2025, 50, 9000), sale(2025, 60, 8500), sale(2025, 110, 6000)],
  };
  const result = surfaceComparableReference(radius, 120, null);
  assert.equal(result.surface_filtered, false);
  assert.equal(result.count_used, 3);
});

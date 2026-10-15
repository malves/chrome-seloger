import test from "node:test";
import assert from "node:assert/strict";
import {
  monthlyRent,
  grossYield,
  normalizeRentBand,
  buildRentEstimateView,
  buildRentHttpError,
  rentEstimateErrorMessage,
  yieldAttractiveness,
  yieldGradeFromIndex,
} from "../src/lib/rent-estimate.js";

test("erreurs HTTP : corps HTML ignoré, JSON exploité", () => {
  assert.equal(
    buildRentHttpError(520, "<!DOCTYPE html><html>"),
    "rent_http_520"
  );
  assert.equal(
    buildRentHttpError(
      429,
      JSON.stringify({ error: { message: "Rate limit exceeded" } })
    ),
    "rent_http_429: Rate limit exceeded"
  );
  assert.equal(
    rentEstimateErrorMessage("rent_http_520: <!DOCTYPE html>"),
    "Le service d'estimation est momentanément indisponible, réessayez."
  );
  assert.equal(
    rentEstimateErrorMessage("rent_invalid_response"),
    "Réponse du service d'estimation illisible."
  );
});

test("vue d'affichage : erreur HTTP avec libellé lisible", () => {
  const view = buildRentEstimateView({
    listing: { id: 3, transaction_type: "sale", surface: 50, price: 200000 },
    record: {
      status: "error",
      error: "rent_http_520: <!DOCTYPE html>",
    },
  });
  assert.equal(view.status, "error");
  assert.equal(
    view.error_label,
    "Le service d'estimation est momentanément indisponible, réessayez."
  );
});

test("attractivité du rendement (indice vs estimation marché)", () => {
  assert.deepEqual(yieldGradeFromIndex(120), {
    grade: "A",
    grade_label: "Excellent rendement",
  });
  assert.deepEqual(yieldAttractiveness(520_000, 400_000), {
    index: 77,
    grade: "F",
    grade_label: "Rendement faible",
    tone: "high",
  });
  assert.deepEqual(yieldAttractiveness(400_000, 400_000), {
    index: 100,
    grade: "D",
    grade_label: "Rendement du marché",
    tone: "mid",
  });
});

test("loyer mensuel et rendement brut", () => {
  assert.equal(monthlyRent(21.4, 80), 1712);
  assert.equal(monthlyRent(null, 80), null);
  assert.equal(grossYield(1712 * 12, 520000), 3.95);
  assert.equal(grossYield(0, 520000), null);
});

test("fourchette €/m² : bornes et remise en ordre", () => {
  assert.deepEqual(normalizeRentBand({ low: 22, mid: 18, high: 20 }), {
    low: 18,
    mid: 20,
    high: 22,
  });
  assert.equal(normalizeRentBand({ low: 1, mid: 200, high: 2 }), null);
  assert.deepEqual(normalizeRentBand({ low: 21, mid: 21, high: 21 }), {
    low: 21,
    mid: 21,
    high: 21,
  });
});

test("vue d'affichage : loyer et rendement", () => {
  const listing = {
    id: 1,
    transaction_type: "sale",
    surface: 80,
    price: 520000,
    user_address: "12 rue Test, 92800 Puteaux",
    user_lat: 48.88,
    user_lng: 2.23,
  };
  const view = buildRentEstimateView({
    listing,
    works: 20000,
    marketEstimate: 550_000,
    record: {
      status: "ok",
      fetched_at: "2026-10-14T00:00:00.000Z",
      data: {
        granularity: "address",
        rent_m2: { low: 18, mid: 21, high: 25 },
        confidence: 0.8,
        sources: [],
        rent_control: { applies: false },
      },
    },
  });
  assert.equal(view.visible, true);
  assert.equal(view.status, "ok");
  assert.equal(view.monthly.mid, 1680);
  assert.equal(view.yield_gross, 3.88);
  assert.ok(view.yield_works < view.yield_gross);
  assert.equal(view.has_address, true);
  assert.equal(view.yield_attractiveness?.grade, "C");
  assert.equal(view.yield_attractiveness?.index, 106);
});

test("vue d'affichage : location masquée, sans cache = en cours", () => {
  assert.equal(
    buildRentEstimateView({
      listing: { id: 1, transaction_type: "rent", surface: 40, price: 1200 },
    }).visible,
    false
  );
  const pending = buildRentEstimateView({
    listing: { id: 2, transaction_type: "sale", surface: 50, price: 200000 },
  });
  assert.equal(pending.visible, true);
  assert.equal(pending.status, "pending");
});

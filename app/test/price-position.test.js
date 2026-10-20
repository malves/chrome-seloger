import test from "node:test";
import assert from "node:assert/strict";
import { buildPricePosition } from "../src/lib/price-position.js";

const listing = {
  transaction_type: "sale",
  property_type: "house",
  price: 750000,
  surface: 120,
  city: "Rueil-Malmaison",
  user_address: "16 Rue Victorien Sardou, 92500 Rueil-Malmaison",
  user_address_source: "manual",
};
const commune = {
  name: "Rueil-Malmaison",
  house: { median_price_m2: 7337, year: "sept. 2026" },
  apartment: { median_price_m2: 6900, year: "sept. 2026" },
};
const dvf = {
  property_type: "house",
  radius: { meters: 250, median_price_m2: 7107, count: 22, years: 5, enough: true },
};

test("prix : le rayon DVF à l'adresse prime sur la commune", () => {
  const pos = buildPricePosition({ listing, commune, dvf });
  assert.equal(pos.primary.key, "radius");
  assert.equal(pos.primary.estimate, 852840);
  assert.equal(pos.primary.delta_amount, -102840);
  assert.equal(pos.primary.index, 88);
  assert.equal(pos.primary.address_source, "adresse saisie");
  // Commune masquée dès qu'une référence à l'adresse est retenue.
  assert.deepEqual(pos.references.map((r) => r.key), ["radius"]);
});

test("prix : échantillon DVF trop faible → la commune sert de référence", () => {
  const weak = { ...dvf, radius: { ...dvf.radius, count: 3, enough: false } };
  const pos = buildPricePosition({ listing, commune, dvf: weak });
  assert.equal(pos.primary.key, "commune");
  assert.deepEqual(pos.references.map((r) => r.key), ["radius", "commune"]);
  assert.equal(pos.references[1].estimate, 880440);
});

test("prix : sans adresse, référence communale", () => {
  const pos = buildPricePosition({
    listing: { ...listing, user_address: null },
    commune,
  });
  assert.equal(pos.primary.key, "commune");
  assert.equal(pos.has_address, false);
});

function monthly(year, value) {
  return Array.from({ length: 12 }, (_, i) => ({
    period: `${year}-${String(i + 1).padStart(2, "0")}`,
    median_price_m2: value,
  }));
}

test("prix : ventes DVF ramenées au marché actuel (année par année)", () => {
  // Marché : 8000 €/m² en 2023, 7200 €/m² aujourd'hui → ventes 2023 corrigées de −10 %.
  const points = [...monthly(2023, 8000), ...monthly(2024, 7600), { period: "2025-01", median_price_m2: 7200 }];
  const sale = (year, m2) => ({
    year,
    surface: 120,
    price_per_m2: m2,
    recency_weight: 1,
    used_in_reference: true,
  });
  const radiusDvf = {
    property_type: "house",
    radius: {
      meters: 250,
      median_price_m2: 8000,
      count: 3,
      years: 5,
      enough: true,
      sales: [sale(2023, 8000), sale(2023, 8000), sale(2024, 7600)],
    },
  };
  const pos = buildPricePosition({
    listing,
    commune,
    dvf: radiusDvf,
    market: { points, label: "Rueil-Malmaison" },
  });
  assert.equal(pos.primary.price_m2, 7200);
  assert.equal(pos.primary.adjustment.median_raw, 8000);
  assert.deepEqual(pos.primary.adjustment.year_factors, [
    { year: 2023, pct: -10 },
    { year: 2024, pct: -5.3 },
  ]);
  const adjustedSales = pos.primary.adjusted_radius.sales;
  assert.equal(adjustedSales[0].adjusted_price_per_m2, 7200);
});

test("prix : surface comparable ±20 % pour l'estimation rayon", () => {
  const radiusDvf = {
    property_type: "house",
    radius: {
      meters: 250,
      median_price_m2: 8000,
      count: 5,
      years: 5,
      enough: true,
      sales: [
        { year: 2025, surface: 50, price_per_m2: 9000, recency_weight: 1, used_in_reference: true },
        { year: 2025, surface: 110, price_per_m2: 6000, recency_weight: 1, used_in_reference: true },
        { year: 2025, surface: 120, price_per_m2: 6200, recency_weight: 1, used_in_reference: true },
        { year: 2024, surface: 115, price_per_m2: 6400, recency_weight: 1, used_in_reference: true },
      ],
    },
  };
  const pos = buildPricePosition({ listing, commune, dvf: radiusDvf });
  assert.equal(pos.primary.price_m2, 6200);
  assert.equal(pos.primary.estimate, 744000);
  assert.equal(pos.primary.estimate_p25, 732000);
  assert.equal(pos.primary.estimate_p75, 756000);
  assert.match(pos.primary.basis, /ventes comparables \(96–144 m²\)/);
});

test("prix + travaux : second positionnement sur chaque référence", () => {
  // Référence rayon : 7107 €/m² × 120 m² = 852 840 €. Prix 750 000 + 60 000 travaux.
  const pos = buildPricePosition({
    listing,
    commune,
    dvf,
    works: 60000,
    worksRange: { min: 40000, max: 80000 },
  });
  assert.equal(pos.works, 60000);
  assert.deepEqual(pos.works_range, { min: 40000, max: 80000 });
  assert.equal(pos.works_edited, false);
  const ww = pos.primary.with_works;
  assert.equal(ww.price, 810000);
  assert.equal(ww.price_m2, 6750);
  assert.equal(ww.index, 95);
  assert.equal(ww.tone, "ok");
  assert.equal(ww.delta_amount, 810000 - 852840);
  assert.equal(ww.delta_pct, -5);
  // Le positionnement « prix seul » reste inchangé.
  assert.equal(pos.primary.index, 88);
  // Les travaux peuvent faire basculer le verdict.
  const heavy = buildPricePosition({ listing, commune, dvf, works: 200000 });
  assert.equal(heavy.primary.with_works.index, 111);
  assert.equal(heavy.primary.with_works.tone, "high");
});

test("prix + travaux : montant saisi au financement signalé", () => {
  const pos = buildPricePosition({
    listing,
    commune,
    dvf,
    works: 35000,
    worksRange: { min: 34000, max: 68000 },
    worksEdited: true,
  });
  assert.equal(pos.works, 35000);
  assert.equal(pos.works_edited, true);
});

test("prix + travaux : sans budget, pas de second positionnement", () => {
  for (const works of [0, null, undefined, -5, "abc"]) {
    const pos = buildPricePosition({ listing, commune, dvf, works });
    assert.equal(pos.works, 0);
    assert.equal(pos.works_range, null);
    assert.equal(pos.primary.with_works, null);
  }
});

test("prix : location ou type inconnu → pas de positionnement", () => {
  assert.equal(
    buildPricePosition({ listing: { ...listing, transaction_type: "rent" }, commune }),
    null
  );
  assert.equal(
    buildPricePosition({ listing: { ...listing, property_type: "other" }, commune }),
    null
  );
});

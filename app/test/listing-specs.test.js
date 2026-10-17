/**
 * Lignes « Caractéristiques » : chaque valeur porte sa provenance.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fmt from "../src/lib/format.js";
import { resolveAll } from "../src/lib/listing-field-provenance.js";
import { buildListingSpecs } from "../src/lib/listing-specs.js";

const LISTING = {
  id: 1,
  property_type: "apartment",
  transaction_type: "sale",
  price: 300000,
  surface: 100,
  rooms: 4,
  floor: 0,
  city: "Rambouillet",
  postal_code: "78120",
  source_id: "123456",
  is_new_build: false,
  agency: { name: "Agence du Centre", phone: "01 02 03 04 05", fees_percent: 4, fees_included: true },
};

function specs(overrides = null, opts = {}) {
  const provenance = resolveAll({ listing: LISTING, overrides, descriptionFacts: {} });
  return buildListingSpecs(LISTING, provenance, fmt, { postalInseeCode: "78517", ...opts });
}

const byLabel = (rows, label) => rows.find((row) => row.label === label);

test("chaque ligne affichée porte une source", () => {
  const rows = specs();
  assert.ok(rows.length > 10);
  for (const row of rows) {
    assert.ok(row.source && row.source.kind, `source manquante : ${row.label}`);
    assert.ok(row.source.short, `libellé court manquant : ${row.label}`);
    assert.ok(row.source.title, `info-bulle manquante : ${row.label}`);
  }
});

test("colonnes brutes de l'annonce : source « Annonce »", () => {
  const rows = specs();
  for (const label of [
    "Type de bien",
    "Transaction",
    "Commune",
    "Code postal",
    "Agence",
    "Téléphone",
    "Honoraires d'agence",
    "Identifiant source",
  ]) {
    assert.equal(byLabel(rows, label).source.kind, "structured", label);
  }
});

test("Code INSEE : source « Référentiel », absent sans code résolu", () => {
  assert.equal(byLabel(specs(), "Code INSEE").source.kind, "reference");
  assert.equal(byLabel(specs(null, { postalInseeCode: null }), "Code INSEE"), undefined);
});

test("Prix : source affichée mais non éditable", () => {
  const price = byLabel(specs(), "Prix");
  assert.equal(price.source.kind, "structured");
  assert.equal(price.fieldKey, null);
});

test("Prix au m² : calculé sur la surface corrigée", () => {
  const rows = specs({ surface: { value: 120, origin: "listing" } });
  const ppm = byLabel(rows, "Prix au m²");
  assert.equal(ppm.source.kind, "computed");
  assert.equal(ppm.key, "price_per_m2");
  assert.deepEqual(ppm.dependsOn, ["price", "surface"]);
  assert.equal(ppm.display, `${fmt.euro(2500)} / m²`);
});

test("correction utilisateur : source « Vous » et ancienne valeur formatée", () => {
  const surface = byLabel(specs({ surface: { value: 120, origin: "listing" } }), "Surface habitable");
  assert.equal(surface.source.kind, "user");
  assert.equal(surface.source.title, "Corrigé depuis la fiche");
  assert.equal(surface.source.previous.display, fmt.surface(100));
  assert.equal(surface.fieldKey, "surface");
});

test("étage 0 affiché", () => {
  assert.equal(byLabel(specs(), "Étage").display, "0");
});

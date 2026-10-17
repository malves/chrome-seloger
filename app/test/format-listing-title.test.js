import { test } from "node:test";
import assert from "node:assert/strict";
import { listingTitle } from "../src/lib/format.js";

test("listingTitle formate le prix SeLoger dans le titre", () => {
  const raw =
    "Appartement à vendre T5/F5 101 m² 720000 € Plateau-Mont Valérien Rueil-Malmaison (92500)";
  const formatted = listingTitle(raw, 720_000);
  assert.match(formatted, /720[\u202f\u00a0 ]000[\u202f\u00a0 ]€/);
  assert.doesNotMatch(formatted, /720000 €/);
  assert.match(formatted, /101 m²/);
  assert.match(formatted, /\(92500\)/);
});

test("listingTitle laisse le titre inchangé sans montant en euros", () => {
  assert.equal(listingTitle("Maison 5 pièces 120 m²"), "Maison 5 pièces 120 m²");
});

test("listingTitle sans prix connu formate tout montant suivi de €", () => {
  assert.match(listingTitle("Studio 25 m² 850 € Paris"), /850[\u202f\u00a0 ]€/);
});

test("listingTitle ignore un montant en € qui ne correspond pas au prix stocké", () => {
  const title = "Bien 500000 € et loyer 1200 €";
  const out = listingTitle(title, 500_000);
  assert.match(out, /500[\u202f\u00a0 ]000[\u202f\u00a0 ]€/);
  assert.match(out, /loyer 1200 €/);
});

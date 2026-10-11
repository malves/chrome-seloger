import test from "node:test";
import assert from "node:assert/strict";
import {
  dpeHeatingEnergy,
  energyFamilies,
  energyFamily,
} from "../src/lib/energy-source.js";

test("energyFamily : valeurs ADEME réelles", () => {
  assert.equal(energyFamily("Gaz naturel"), "gaz");
  assert.equal(energyFamily("GPL"), "gaz");
  assert.equal(energyFamily("Propane"), "gaz");
  assert.equal(energyFamily("Électricité"), "electricite");
  assert.equal(
    energyFamily("Électricité d'origine renouvelable utilisée dans le bâtiment"),
    "electricite"
  );
  assert.equal(energyFamily("Réseau de Chauffage urbain"), "reseau");
  assert.equal(energyFamily("Fioul domestique"), "fioul");
  assert.equal(energyFamily("Bois – Granulés (pellets) ou briquettes"), "bois");
  assert.equal(energyFamily("Charbon"), "charbon");
  assert.equal(energyFamily("Non affecté"), null);
  assert.equal(energyFamily(""), null);
});

test("energyFamilies : valeurs SeLoger, simples ou multiples", () => {
  assert.deepEqual(energyFamilies("Gaz"), ["gaz"]);
  assert.deepEqual(energyFamilies("Electricité"), ["electricite"]);
  assert.deepEqual(energyFamilies("Gaz, Électricité"), ["gaz", "electricite"]);
  assert.deepEqual(energyFamilies("Solaire"), []);
});

test("dpeHeatingEnergy : chauffage principal, puis n1, jamais n2", () => {
  assert.equal(
    dpeHeatingEnergy({ type_energie_principale_chauffage: "Gaz naturel", type_energie_n1: "Électricité" }),
    "Gaz naturel"
  );
  assert.equal(dpeHeatingEnergy({ type_energie_n1: "Fioul domestique" }), "Fioul domestique");
  assert.equal(dpeHeatingEnergy({ type_energie_n2: "Électricité" }), null);
  assert.equal(dpeHeatingEnergy(null), null);
});

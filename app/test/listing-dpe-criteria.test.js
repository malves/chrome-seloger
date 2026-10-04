import test from "node:test";
import assert from "node:assert/strict";
import {
  departmentFromPostalCode,
  listingDpeSearchCriteria,
  propertyTypeToDpeBuildingType,
} from "../src/lib/listing-dpe-criteria.js";

test("departmentFromPostalCode", () => {
  assert.equal(departmentFromPostalCode("75011"), "75");
  assert.equal(departmentFromPostalCode("97100"), "971");
  assert.equal(departmentFromPostalCode("20000"), "2A");
  assert.equal(departmentFromPostalCode("20200"), "2B");
  assert.equal(departmentFromPostalCode(""), null);
});

test("propertyTypeToDpeBuildingType", () => {
  assert.equal(propertyTypeToDpeBuildingType("apartment"), "appartement");
  assert.equal(propertyTypeToDpeBuildingType("house"), "maison");
  assert.equal(propertyTypeToDpeBuildingType("land"), null);
  assert.equal(propertyTypeToDpeBuildingType("other"), null);
});

test("listingDpeSearchCriteria", () => {
  const payload = listingDpeSearchCriteria({
    id: 42,
    postal_code: "69003",
    property_type: "apartment",
    dpe: "d",
    ges: "C",
    surface: 55.5,
    floor: 3,
    year_built: 1978,
  });
  assert.equal(payload.listingId, 42);
  assert.deepEqual(payload.criteres, {
    codePostal: "69003",
    departement: "69",
    typeBien: "apartment",
    typeBatiment: "appartement",
    dpe: "D",
    ges: "C",
    surfaceM2: 55.5,
    anneeConstruction: 1978,
    etage: 3,
  });
  assert.deepEqual(payload.champsManquants, []);
  assert.equal(payload.filtresRechercheDpe.code_postal, "69003");
  assert.equal(payload.filtresRechercheDpe.type_batiment, "appartement");
  assert.equal(payload.filtresRechercheDpe.numero_etage_appartement, 3);
});

test("listingDpeSearchCriteria accepte le rez-de-chaussée (étage 0)", () => {
  const payload = listingDpeSearchCriteria({ id: 1, floor: 0 });
  assert.equal(payload.criteres.etage, 0);
  assert.equal(payload.champsManquants.includes("etage"), false);
});

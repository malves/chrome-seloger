import test from "node:test";
import assert from "node:assert/strict";
import { listingTerritory } from "../src/lib/listing-territory.js";

test("sans adresse réelle, le territoire vient de l'annonce", () => {
  const t = listingTerritory({
    city: "Rambouillet",
    postal_code: "78120",
    lat: 48.64,
    lng: 1.83,
  });
  assert.equal(t.source, "announced");
  assert.equal(t.city, "Rambouillet");
  assert.equal(t.postal_code, "78120");
  assert.equal(t.lat, 48.64);
});

test("une adresse réelle prime sur la localisation annoncée", () => {
  const t = listingTerritory({
    city: "Rambouillet",
    postal_code: "78120",
    lat: 48.64,
    lng: 1.83,
    user_address: "12 rue de Rivoli, 75001 Paris",
    user_lat: 48.86,
    user_lng: 2.34,
    user_address_source: "manual",
  });
  assert.equal(t.source, "user");
  assert.equal(t.city, "Paris");
  assert.equal(t.postal_code, "75001");
  assert.equal(t.lat, 48.86);
  assert.equal(t.lng, 2.34);
});

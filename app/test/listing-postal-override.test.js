/**
 * Code postal corrigé : lecture de l'entrée stockée et application à l'annonce.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fmt from "../src/lib/format.js";
import {
  applyPostalOverride,
  buildPostalOverrideEntry,
  normalizePostalCode,
  parsePostalOverride,
} from "../src/lib/listing-postal-override.js";
import { listingTerritory } from "../src/lib/listing-territory.js";
import { buildListingSpecs } from "../src/lib/listing-specs.js";

const GAZERAN = { insee_code: "78269", name: "Gazeran", lat: 48.63, lng: 1.77 };

function announcedListing(extra = {}) {
  return {
    id: 1,
    property_type: "house",
    transaction_type: "sale",
    city: "Rambouillet",
    postal_code: "78120",
    insee_code: "78517",
    lat: 48.64,
    lng: 1.83,
    ...extra,
  };
}

function storedEntry({ relocate = true } = {}) {
  return JSON.stringify(
    buildPostalOverrideEntry({
      postalCode: "78125",
      commune: GAZERAN,
      relocate,
      updatedAt: "2026-10-18T00:00:00.000Z",
    })
  );
}

test("normalizePostalCode : 5 chiffres uniquement", () => {
  assert.equal(normalizePostalCode("78125"), "78125");
  assert.equal(normalizePostalCode(" 78 125 "), "78125");
  assert.equal(normalizePostalCode("7812"), null);
  assert.equal(normalizePostalCode("78125a"), null);
  assert.equal(normalizePostalCode(null), null);
});

test("parsePostalOverride : entrée absente, invalide ou incomplète → null", () => {
  assert.equal(parsePostalOverride(null), null);
  assert.equal(parsePostalOverride("pas du json"), null);
  assert.equal(parsePostalOverride(JSON.stringify({ value: "78125" })), null);
  assert.equal(parsePostalOverride(JSON.stringify({ value: "abc", insee_code: "78269" })), null);
});

test("sans adresse réelle, la commune corrigée pilote INSEE, commune et point", () => {
  const listing = applyPostalOverride(announcedListing(), parsePostalOverride(storedEntry()));

  assert.equal(listing.postal_code, "78125");
  assert.equal(listing.city, "Gazeran");
  assert.equal(listing.insee_code, "78269");
  assert.equal(listing.lat, 48.63);
  assert.equal(listing.lng, 1.77);
  assert.deepEqual(listing.announced_location, {
    city: "Rambouillet",
    postal_code: "78120",
    insee_code: "78517",
    lat: 48.64,
    lng: 1.83,
  });

  const territory = listingTerritory(listing);
  assert.equal(territory.source, "announced");
  assert.equal(territory.postal_code, "78125");
  assert.equal(territory.city, "Gazeran");
});

test("point annoncé déjà dans la commune : il est conservé", () => {
  const listing = applyPostalOverride(
    announcedListing(),
    parsePostalOverride(storedEntry({ relocate: false }))
  );
  assert.equal(listing.insee_code, "78269");
  assert.equal(listing.lat, 48.64);
  assert.equal(listing.lng, 1.83);
});

test("avec une adresse réelle, l'INSEE et le point restent ceux de l'adresse", () => {
  const listing = applyPostalOverride(
    announcedListing({
      insee_code: "78269",
      user_address: "3 rue de la Mairie, 78125 Gazeran",
      user_lat: 48.632,
      user_lng: 1.771,
    }),
    parsePostalOverride(storedEntry())
  );
  assert.equal(listing.postal_code, "78125");
  assert.equal(listing.insee_code, "78269");
  assert.equal(listing.lat, 48.64);
  assert.equal(listingTerritory(listing).source, "user");
});

test("sans correction, l'annonce est inchangée", () => {
  const listing = applyPostalOverride(announcedListing(), null);
  assert.equal(listing.postal_code, "78120");
  assert.equal(listing.insee_code, "78517");
  assert.equal(listing.postal_override, null);
  assert.equal(listing.announced_location, null);
});

test("caractéristiques : commune et code postal corrigés portent la provenance « Vous »", () => {
  const listing = applyPostalOverride(announcedListing(), parsePostalOverride(storedEntry()));
  const rows = buildListingSpecs(listing, {}, fmt, { postalInseeCode: "78269" });
  const postal = rows.find((row) => row.label === "Code postal");
  const city = rows.find((row) => row.label === "Commune");

  assert.equal(postal.display, "78125");
  assert.equal(postal.editModal, "listing-postal-modal");
  assert.equal(city.editModal, null);
  assert.equal(postal.source.kind, "user");
  assert.equal(postal.source.previous.display, "78120");
  assert.equal(city.display, "Gazeran");
  assert.equal(city.source.kind, "user");
  assert.equal(city.source.previous.display, "Rambouillet");
});

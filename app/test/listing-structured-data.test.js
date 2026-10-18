import { test } from "node:test";
import assert from "node:assert/strict";
import { buildListingStructuredDataView } from "../src/lib/listing-structured-data.js";
import fmt from "../src/lib/format.js";
import {
  createTestApp,
  createUser,
  loginAgent,
  listingPayload,
} from "./helpers.js";
import createListingsService from "../src/services/listings.service.js";

test("buildListingStructuredDataView compte les champs renseignés et vides", () => {
  const view = buildListingStructuredDataView(
    {
      source: "seloger",
      source_id: "1",
      url: "https://www.seloger.com/x",
      title: "Test",
      price: 100000,
      surface: null,
      rooms: 0,
      is_new_build: 0,
      agency: null,
      extension_data: null,
      raw: null,
    },
    { photoCount: 2 },
    fmt
  );
  assert.ok(view.summary.total > 0);
  assert.ok(view.summary.filled >= 5);
  assert.equal(view.summary.empty, view.summary.total - view.summary.filled);

  const priceField = view.sections
    .flatMap((s) => s.fields)
    .find((f) => f.key === "price");
  assert.equal(priceField.filled, true);

  const surfaceField = view.sections
    .flatMap((s) => s.fields)
    .find((f) => f.key === "surface");
  assert.equal(surfaceField.filled, false);

  const photosField = view.sections
    .flatMap((s) => s.fields)
    .find((f) => f.key === "photos");
  assert.match(photosField.display, /2 photo/);
});

test("Code INSEE : référentiel prioritaire, valeur annonce en aide si différente", () => {
  const view = buildListingStructuredDataView(
    { insee_code: "99999", city: "Rambouillet", postal_code: "78120" },
    { postalInseeCode: "78517" },
    fmt
  );
  const insee = view.sections.flatMap((s) => s.fields).find((f) => f.key === "insee_code");
  assert.equal(insee.display, "78517");
  assert.match(insee.help, /99999/);
});

test("la fiche annonce affiche le bouton et la modale des données structurées", async (t) => {
  const { app, repositories, close } = createTestApp();
  t.after(close);
  const listingsService = createListingsService({ repositories });

  const user = await createUser(repositories, "struct@example.com");
  const { id } = listingsService.save(user, listingPayload({ surface: 95, rooms: 4 }));

  const agent = await loginAgent(app, "struct@example.com");
  const res = await agent.get(`/listings/${id}`).expect(200);

  assert.match(res.text, /Voir toutes les données structurées/);
  assert.match(res.text, /id="listing-structured-data-modal"/);
  assert.match(res.text, /Données structurées/);
  assert.match(res.text, /Non renseigné/);
  assert.match(res.text, /95/);
});

/**
 * Trajets web depuis l'adresse réelle : les trajets de l'extension restent la
 * valeur par défaut et ne sont jamais modifiés.
 */

import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import config from "../src/config.js";
import {
  resolveTravelOrigin,
  listingTravelInputFingerprint,
  needsListingTravelRefresh,
  toExtensionTravelTimes,
  webTravelTimesFor,
  LISTING_TRAVEL_PROVIDER,
} from "../src/lib/listing-travel.js";
import {
  createTestApp,
  createUser,
  extractCsrf,
  listingPayload,
  loginAgent,
} from "./helpers.js";
import createListingsService from "../src/services/listings.service.js";
import createProjectsService from "../src/services/projects.service.js";

const WEB_HINT = /Depuis l(?:'|&#39;)adresse enregistrée du bien/;
const EXTENSION_TRIPS = [{ label: "Bureau", mode: "car", minutes: 45, distance_km: 30 }];

test("resolveTravelOrigin : uniquement l'adresse réelle géocodée", () => {
  assert.deepEqual(
    resolveTravelOrigin({ user_address: "12 rue X, 75001 Paris", user_lat: 48.86, user_lng: 2.35 }),
    { lat: 48.86, lon: 2.35 }
  );
  assert.equal(resolveTravelOrigin({ user_address: "12 rue X", user_lat: null }), null);
  assert.equal(resolveTravelOrigin({ lat: 48.8, lng: 2.3, city: "Paris" }), null);
});

test("toExtensionTravelTimes mappe minutes et km", () => {
  const rows = toExtensionTravelTimes([
    { label: "Bureau", duration_seconds: 1860, distance_meters: 24000, lat: 48.86, lon: 2.35 },
    { label: "Échec", error: "no_route" },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].minutes, 31);
  assert.equal(rows[0].distance_km, 24);
});

test("empreinte : change avec les coordonnées de l'adresse", () => {
  const listing = { user_address: "1 rue A", user_lat: 1, user_lng: 2 };
  const destinations = [{ id: 1, label: "B", address: "Y", lat: 3, lon: 4 }];
  const fp = listingTravelInputFingerprint(listing, 9, destinations);
  assert.equal(needsListingTravelRefresh({ inputFingerprint: fp }, listing, 9, destinations), false);
  assert.equal(
    needsListingTravelRefresh({ inputFingerprint: fp }, { ...listing, user_lat: 5 }, 9, destinations),
    true
  );
});

test("webTravelTimesFor : rien sans adresse réelle, même si un cache existe", () => {
  const destinations = [{ id: 1, label: "B", address: "Y", lat: 3, lon: 4 }];
  const withAddress = { user_address: "1 rue A", user_lat: 1, user_lng: 2 };
  const row = {
    status: "ok",
    data: {
      inputFingerprint: listingTravelInputFingerprint(withAddress, 9, destinations),
      travel_times: [{ label: "B", minutes: 10 }],
    },
  };
  assert.equal(webTravelTimesFor(withAddress, row, 9, destinations).length, 1);
  assert.equal(webTravelTimesFor({ user_address: null }, row, 9, destinations), null);
});

/** ORS factice : géocodage + itinéraire de 20 min / 15 km. */
function stubOrs(t) {
  const originalKey = config.openRouteService.apiKey;
  const originalFetch = globalThis.fetch;
  config.openRouteService.apiKey = "cle-test";
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes("/v2/directions/driving-car")
        ? { routes: [{ summary: { duration: 1200, distance: 15000 } }] }
        : { features: [{ geometry: { coordinates: [2.35, 48.86] }, properties: { label: "Paris" } }] },
  });
  t.after(() => {
    config.openRouteService.apiKey = originalKey;
    globalThis.fetch = originalFetch;
  });
}

async function setup(t) {
  stubOrs(t);
  const ctx = createTestApp();
  t.after(ctx.close);
  const user = await createUser(ctx.repositories, "trajet@example.com");
  const projects = createProjectsService({ repositories: ctx.repositories });
  const project = projects.ensureDefault(user.id);
  await projects.addAddress(user.id, project.id, {
    label: "Bureau",
    address: "Paris",
    lat: 48.86,
    lng: 2.35,
  });
  const { id } = createListingsService({ repositories: ctx.repositories }).save(
    user,
    listingPayload({ extension_data: { travel_times: EXTENSION_TRIPS, property_tax_index: 2 } })
  );
  return { ...ctx, user, id };
}

test("sans adresse réelle, la fiche affiche les trajets de l'extension", async (t) => {
  const { app, id } = await setup(t);
  const agent = await loginAgent(app, "trajet@example.com");
  const page = await agent.get(`/listings/${id}`).expect(200);
  assert.match(page.text, /45 min/);
  assert.doesNotMatch(page.text, WEB_HINT);
});

test("adresse réelle : trajets web affichés, extension intacte ; effacement : retour à l'extension", async (t) => {
  const { app, repositories, enrichment, user, id } = await setup(t);
  const agent = await loginAgent(app, "trajet@example.com");
  const csrf = extractCsrf((await agent.get("/listings")).text);

  await agent
    .post(`/listings/${id}/address`)
    .set("HX-Request", "true")
    .type("form")
    .send({ _csrf: csrf, user_address: "12 rue de Rivoli, 75001 Paris" })
    .expect(200);
  await enrichment.runForListing(user.id, id, { only: LISTING_TRAVEL_PROVIDER });

  const withAddress = await agent.get(`/listings/${id}`).expect(200);
  assert.match(withAddress.text, /20 min/);
  assert.match(withAddress.text, WEB_HINT);
  assert.deepEqual(
    repositories.listings.findById(user.id, id).extension_data.travel_times,
    EXTENSION_TRIPS
  );

  await agent
    .post(`/listings/${id}/address`)
    .set("HX-Request", "true")
    .type("form")
    .send({ _csrf: csrf, street: "", postal_code: "", city: "" })
    .expect(200);

  const cleared = await agent.get(`/listings/${id}`).expect(200);
  assert.match(cleared.text, /45 min/);
  assert.doesNotMatch(cleared.text, /20 min/);
  assert.equal(repositories.enrichments.findOne(id, LISTING_TRAVEL_PROVIDER), null);
});

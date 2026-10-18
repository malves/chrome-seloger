/**
 * Vérifie la convention d'ajout d'un provider : un fichier `*.provider.js`
 * et un partial du même nom suffisent, sans toucher au registre ni aux routes.
 *
 * Le provider fictif vit sous `test/fixtures/` (jamais chargé par le serveur).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createUser, listingPayload, loginAgent } from "./helpers.js";
import config from "../src/config.js";
import createListingsService from "../src/services/listings.service.js";
import { pickCommune } from "../src/services/enrichment/commune.provider.js";

const FIXTURE_KEY = "runtime-fixture";

function createFixtureTestApp() {
  return createTestApp({ enrichmentFixture: true });
}

function fixtureTest(name, fn) {
  test(name, async (t) => {
    const ctx = createFixtureTestApp();
    ctx.listingsService = createListingsService({ repositories: ctx.repositories });
    t.after(() => ctx.close());
    await fn(ctx, t);
  });
}

fixtureTest("un nouveau provider est découvert sans inscription", async (ctx) => {
  const keys = (await ctx.enrichment.listProviders()).map((p) => p.key);
  // Trié par `order` : la résolution de commune reste le prérequis initial.
  // Les providers cache-only départementaux / portée annonce sont inclus.
  assert.deepEqual(keys, [
    "commune",
    "probable-location",
    "photo-analysis",
    "financing",
    "delinquance",
    "delinquance-dept",
    "population",
    "immo-data",
    "immo-data-dept",
    "dvf-local",
    "immo-data-quartier",
    "rent-estimate",
    "listing-travel",
    FIXTURE_KEY,
  ]);
});

fixtureTest("une demande identique attend le calcul déjà en cours", async (ctx) => {
  const { repositories, enrichment, listingsService } = ctx;
  const user = await createUser(repositories, "a@example.com");
  const { id } = listingsService.save(user, listingPayload({ title: "LENT" }));
  globalThis.__runtimeFixtureCalls = 0;

  const first = enrichment.runForListing(user.id, id, { only: FIXTURE_KEY });
  const second = enrichment.runForListing(user.id, id, { only: FIXTURE_KEY });
  await second;

  assert.equal(repositories.enrichments.findOne(id, FIXTURE_KEY)?.status, "ok");
  assert.equal(globalThis.__runtimeFixtureCalls, 1);
  await first;
});

fixtureTest("un résultat d'annonce encore valide n'est pas recalculé", async (ctx) => {
  const { repositories, enrichment, listingsService } = ctx;
  const user = await createUser(repositories, "a@example.com");
  const { id } = listingsService.save(user, listingPayload({ title: "CACHE" }));
  globalThis.__runtimeFixtureCalls = 0;

  await enrichment.runForListing(user.id, id, { only: FIXTURE_KEY });
  await enrichment.runForListing(user.id, id, { only: FIXTURE_KEY });
  assert.equal(globalThis.__runtimeFixtureCalls, 1);

  await enrichment.runForListing(user.id, id, { only: FIXTURE_KEY, force: true });
  assert.equal(globalThis.__runtimeFixtureCalls, 2);
});

fixtureTest("un provider en erreur n'empêche pas l'affichage", async (ctx) => {
  const { app, repositories, enrichment, listingsService } = ctx;
  const user = await createUser(repositories, "a@example.com");
  const { id } = listingsService.save(user, listingPayload({ title: "ECHEC" }));

  await enrichment.runForListing(user.id, id, { only: FIXTURE_KEY });

  const stored = repositories.enrichments.findOne(id, FIXTURE_KEY);
  assert.equal(stored.status, "error");
  assert.match(stored.error, /source indisponible/);

  const agent = await loginAgent(app, "a@example.com");
  const page = await agent.get(`/listings/${id}`).expect(200);
  assert.match(page.text, /Donnée indisponible/);
  assert.doesNotMatch(page.text, /Réessayer/);
});

fixtureTest("le bouton Réessayer relance le provider ciblé (admin)", async (ctx) => {
  const { app, repositories, listingsService } = ctx;
  await createUser(repositories, config.adminEmails[0]);
  const user = await createUser(repositories, "a@example.com");
  const { id } = listingsService.save(user, listingPayload());
  const agent = await loginAgent(app, config.adminEmails[0]);

  const page = await agent.get(`/listings/${id}`).expect(200);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];

  const res = await agent
    .post(`/listings/${id}/enrich/${FIXTURE_KEY}`)
    .set("HX-Request", "true")
    .type("form")
    .send({ _csrf: csrf })
    .expect(200);

  assert.doesNotMatch(res.text, /<!DOCTYPE html>/);
  assert.match(res.text, /Marqueur : fixture-ok/);
});

test("Actualiser le territoire recharge tous les providers communaux (admin)", async (t) => {
  const ctx = createTestApp();
  ctx.listingsService = createListingsService({ repositories: ctx.repositories });
  t.after(() => ctx.close());
  const { app, repositories, listingsService, enrichment } = ctx;
  await createUser(repositories, config.adminEmails[0]);
  const user = await createUser(repositories, "a@example.com");
  const { id } = listingsService.save(
    user,
    listingPayload({ city: "Versailles", postal_code: "78000" })
  );
  await enrichment.runForListing(user.id, id, { only: "commune" });

  const listing = repositories.listings.findById(user.id, id);
  repositories.enrichments.saveCommune(listing.insee_code, "commune", {
    insee_code: listing.insee_code,
    name: "Versailles",
    department: { code: "78", name: "Yvelines" },
  });

  const agent = await loginAgent(app, config.adminEmails[0]);
  const page = await agent.get(`/listings/${id}`).expect(200);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];

  const territoryButtons = page.text.match(/enrich\/territoire/g) || [];
  assert.equal(territoryButtons.length, 1);

  const res = await agent
    .post(`/listings/${id}/enrich/territoire`)
    .set("HX-Request", "true")
    .type("form")
    .send({ _csrf: csrf })
    .expect(200);

  assert.doesNotMatch(res.text, /<!DOCTYPE html>/);
  assert.match(res.text, /id="listing-territory"/);
  const territoryEyebrows = res.text.match(/panel__eyebrow">Territoire/g) || [];
  assert.equal(territoryEyebrows.length, 1);
  assert.match(res.text, /panel__title">Rambouillet/);
  assert.match(res.text, /listing-territory__body/);
  assert.match(res.text, /panel__head-aside[\s\S]*Mise à jour/);
  assert.doesNotMatch(res.text, /#provider-commune[\s\S]*<h2 class="panel__title">Commune<\/h2>/);
  assert.match(res.text, /Code INSEE/);
  assert.match(res.text, /Population/);
});

test("Actualiser l'analyse de marché recharge tous les providers marché (admin)", async (t) => {
  const ctx = createTestApp();
  ctx.listingsService = createListingsService({ repositories: ctx.repositories });
  t.after(() => ctx.close());
  const { app, repositories, listingsService, enrichment } = ctx;
  await createUser(repositories, config.adminEmails[0]);
  const user = await createUser(repositories, "a@example.com");
  const { id } = listingsService.save(
    user,
    listingPayload({ city: "Versailles", postal_code: "78000" })
  );
  await enrichment.runForListing(user.id, id, { only: "immo-data" });

  const agent = await loginAgent(app, config.adminEmails[0]);
  const page = await agent.get(`/listings/${id}`).expect(200);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];

  const marketButtons = page.text.match(/enrich\/marche/g) || [];
  assert.equal(marketButtons.length, 1);
  assert.doesNotMatch(page.text, /enrich\/immo-data/);

  const res = await agent
    .post(`/listings/${id}/enrich/marche`)
    .set("HX-Request", "true")
    .type("form")
    .send({ _csrf: csrf })
    .expect(200);

  assert.doesNotMatch(res.text, /<!DOCTYPE html>/);
  assert.match(res.text, /id="listing-market"/);
  assert.match(res.text, /panel__title">Prix de marché/);
  assert.doesNotMatch(res.text, /<h3 class="panel__title">Prix de marché<\/h3>/);
});

test("le financement est ignoré pour une location", async (t) => {
  const ctx = createTestApp();
  const listingsService = createListingsService({ repositories: ctx.repositories });
  t.after(() => ctx.close());

  const user = await createUser(ctx.repositories, "a@example.com");
  const { id } = listingsService.save(
    user,
    listingPayload({ transaction_type: "rent", price: 1200 })
  );

  await ctx.enrichment.runForListing(user.id, id, { only: "financing" });

  const stored = ctx.repositories.enrichments.findOne(id, "financing");
  assert.equal(stored.status, "error");
  assert.match(stored.error, /location/);
});

test("un provider communal attend le code INSEE", async (t) => {
  const ctx = createTestApp();
  const listingsService = createListingsService({ repositories: ctx.repositories });
  t.after(() => ctx.close());

  const user = await createUser(ctx.repositories, "a@example.com");
  const { id } = listingsService.save(user, {
    schema_version: 1,
    source: "pap",
    url: "https://www.pap.fr/annonce/1",
  });
  const listing = ctx.repositories.listings.findById(user.id, id);

  const providers = await ctx.enrichment.viewModel(listing);
  const commune = providers.find((provider) => provider.key === "commune");
  assert.equal(commune.status, "pending");
  assert.equal(commune.partial, "enrichment/commune");

  const financing = providers.find((provider) => provider.key === "financing");
  // Sans partial dédié, le rendu générique prend le relais.
  assert.equal(financing.partial, "enrichment/_generic");
});

test("le cache communal sert les annonces suivantes", async (t) => {
  const ctx = createTestApp();
  const listingsService = createListingsService({ repositories: ctx.repositories });
  t.after(() => ctx.close());

  const user = await createUser(ctx.repositories, "a@example.com");
  ctx.repositories.enrichments.saveCommune("78517", "commune", {
    insee_code: "78517",
    name: "Rambouillet",
    population: 27_724,
  });

  const { id } = listingsService.save(
    user,
    listingPayload({
      location: { city: "Rambouillet", postal_code: "78120", insee_code: "78517" },
    })
  );

  // Aucun appel réseau : le cache suffit.
  await ctx.enrichment.runForListing(user.id, id, { only: "commune" });

  const listing = ctx.repositories.listings.findById(user.id, id);
  const commune = (await ctx.enrichment.viewModel(listing)).find(
    (provider) => provider.key === "commune"
  );
  assert.equal(commune.status, "ok");
  assert.equal(commune.data.name, "Rambouillet");
});

test("isEnrichmentPending détecte les blocs en attente", async (t) => {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  assert.equal(
    ctx.enrichment.isEnrichmentPending([
      { key: "commune", status: "pending" },
      { key: "financing", status: "pending" },
    ]),
    true
  );
  assert.equal(
    ctx.enrichment.isEnrichmentPending([
      { key: "commune", status: "ok" },
      { key: "immo-data", status: "error" },
    ]),
    false
  );
});

test("pickCommune privilégie le nom exact puis la population", () => {
  const list = [
    { nom: "Saint-Denis", code: "93066", population: 112_091 },
    { nom: "Saint-Denis-les-Ponts", code: "28338", population: 1_200 },
  ];

  assert.equal(pickCommune(list, "Saint-Denis-les-Ponts").code, "28338");
  assert.equal(pickCommune(list, "saint denis").code, "93066");
  assert.equal(pickCommune(list, null).code, "93066");
  assert.equal(pickCommune([], "x"), null);
});

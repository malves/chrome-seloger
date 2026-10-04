/**
 * Vérifie la convention d'ajout d'un provider : un fichier `*.provider.js`
 * et un partial du même nom suffisent, sans toucher au registre ni aux routes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTestApp, createUser, listingPayload, loginAgent } from "./helpers.js";
import { rootDir } from "../src/config.js";
import createListingsService from "../src/services/listings.service.js";
import { pickCommune } from "../src/services/enrichment/commune.provider.js";

const FIXTURE_KEY = "zzfixture";
const providerPath = path.join(
  rootDir,
  "src",
  "services",
  "enrichment",
  `${FIXTURE_KEY}.provider.js`
);
const partialPath = path.join(
  rootDir,
  "src",
  "views",
  "partials",
  "enrichment",
  `${FIXTURE_KEY}.ejs`
);

const PROVIDER_SOURCE = `export default {
  key: "${FIXTURE_KEY}",
  scope: "listing",
  order: 50,
  label: "Provider de test",
  source: "Jeu de test",
  async fetch({ listing }) {
    if (listing.title === "ECHEC") throw new Error("source indisponible");
    return { marqueur: "valeur-de-test", ville: listing.city || null };
  },
};
`;

const PARTIAL_SOURCE = `<p class="kv">Marqueur : <%= data.marqueur %></p>\n`;

function writeFixture() {
  fs.writeFileSync(providerPath, PROVIDER_SOURCE);
  fs.writeFileSync(partialPath, PARTIAL_SOURCE);
}

function removeFixture() {
  for (const file of [providerPath, partialPath]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Déjà supprimé : rien à faire.
    }
  }
}

function withFixtureApp(name, fn) {
  test(name, async (t) => {
    writeFixture();
    const ctx = createTestApp();
    ctx.listingsService = createListingsService({ repositories: ctx.repositories });
    t.after(() => {
      ctx.close();
      removeFixture();
    });
    await fn(ctx, t);
  });
}

withFixtureApp("un nouveau provider est découvert sans inscription", async (ctx) => {
  const keys = (await ctx.enrichment.listProviders()).map((p) => p.key);
  // Trié par `order` : la résolution de commune reste le prérequis initial.
  assert.deepEqual(keys, [
    "commune",
    "financing",
    "delinquance",
    "prix-m2",
    FIXTURE_KEY,
  ]);
});

withFixtureApp("son résultat est stocké et affiché par son partial", async (ctx) => {
  const { app, repositories, enrichment, listingsService } = ctx;
  const user = await createUser(repositories, "a@example.com");
  const { id } = listingsService.save(user, listingPayload());

  await enrichment.runForListing(user.id, id, { only: FIXTURE_KEY });

  const stored = repositories.enrichments.findOne(id, FIXTURE_KEY);
  assert.equal(stored.status, "ok");
  assert.deepEqual(stored.data, {
    marqueur: "valeur-de-test",
    ville: "Rambouillet",
  });

  const agent = await loginAgent(app, "a@example.com");
  const page = await agent.get(`/listings/${id}`).expect(200);
  assert.match(page.text, /Provider de test/);
  assert.match(page.text, /Marqueur : valeur-de-test/);
  assert.match(page.text, /Source :\s*Jeu de test/);
});

withFixtureApp("un provider en erreur n'empêche pas l'affichage", async (ctx) => {
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
  assert.match(page.text, /Réessayer/);
});

withFixtureApp("le bouton Réessayer relance le provider ciblé", async (ctx) => {
  const { app, repositories, listingsService } = ctx;
  const user = await createUser(repositories, "a@example.com");
  const { id } = listingsService.save(user, listingPayload());
  const agent = await loginAgent(app, "a@example.com");

  const page = await agent.get(`/listings/${id}`).expect(200);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];

  const res = await agent
    .post(`/listings/${id}/enrich/${FIXTURE_KEY}`)
    .set("HX-Request", "true")
    .type("form")
    .send({ _csrf: csrf })
    .expect(200);

  assert.doesNotMatch(res.text, /<!DOCTYPE html>/);
  assert.match(res.text, /Marqueur : valeur-de-test/);
});

withFixtureApp("Actualiser le territoire recharge tous les providers communaux", async (ctx) => {
  const { app, repositories, listingsService, enrichment } = ctx;
  const user = await createUser(repositories, "a@example.com");
  const { id } = listingsService.save(user, listingPayload({ city: "Versailles", postal_code: "78000" }));
  await enrichment.runForListing(user.id, id, { only: "commune" });

  const listing = repositories.listings.findById(user.id, id);
  repositories.enrichments.saveCommune(listing.insee_code, "commune", {
    insee_code: listing.insee_code,
    name: "Versailles",
    department: { code: "78", name: "Yvelines" },
  });

  const agent = await loginAgent(app, "a@example.com");
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
  assert.match(res.text, /Code INSEE/);
  assert.match(res.text, /Population/);
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

/**
 * Correction du code postal depuis la fiche annonce.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  createTestApp,
  createUser,
  extractCsrf,
  listingPayload,
  loginAgent,
} from "./helpers.js";
import createListingsService from "../src/services/listings.service.js";

const GEO_COMMUNES = {
  "78269": {
    nom: "Gazeran",
    code: "78269",
    codesPostaux: ["78125"],
    population: 1300,
    centre: { type: "Point", coordinates: [1.77, 48.63] },
  },
  "78497": {
    nom: "Poigny-la-Forêt",
    code: "78497",
    codesPostaux: ["78125"],
    population: 950,
    centre: { type: "Point", coordinates: [1.75, 48.68] },
  },
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** geo.api.gouv.fr simulé : recherche par code postal et fiche commune. */
function mockGeoApi(t) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.hostname !== "geo.api.gouv.fr") return jsonResponse({}, 404);
    if (url.pathname === "/communes" && url.searchParams.get("codePostal") === "78125") {
      return jsonResponse(Object.values(GEO_COMMUNES));
    }
    if (url.pathname === "/communes") return jsonResponse([]);
    const code = url.pathname.split("/")[2];
    return GEO_COMMUNES[code] ? jsonResponse(GEO_COMMUNES[code]) : jsonResponse({}, 404);
  });
  return calls;
}

async function setup(t) {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  const email = "cp@example.com";
  const user = await createUser(ctx.repositories, email);
  const listings = createListingsService({ repositories: ctx.repositories });
  const payload = listingPayload({
    location: { city: "Rambouillet", postal_code: "78120", insee_code: "78517", lat: 48.64, lng: 1.83 },
  });
  const { id } = listings.save(user, payload);
  const agent = await loginAgent(ctx.app, email);
  const page = await agent.get(`/listings/${id}`).expect(200);
  return { ...ctx, user, id, agent, listings, payload, page, csrf: extractCsrf(page.text) };
}

const savePostal = (agent, id, body) =>
  agent.post(`/listings/${id}/postal-code`).type("form").send(body);

test("fiche : bouton « Corriger le code postal » et modale de saisie", async (t) => {
  const { page, id } = await setup(t);
  assert.match(page.text, /data-modal-open="listing-postal-modal"/);
  assert.match(page.text, /id="listing-postal-modal"/);
  assert.ok(page.text.includes(`action="/listings/${id}/postal-code"`));
});

test("fiche : la ligne « Code postal » des caractéristiques ouvre la modale au double-clic", async (t) => {
  const { page } = await setup(t);
  const start = page.text.indexOf('id="listing-specs"');
  const specs = page.text.slice(start, page.text.indexOf("</section>", start));
  const row = specs.split('<div class="kv__row"').find((chunk) => chunk.includes(">Code postal<"));
  assert.ok(row, "ligne Code postal absente");
  assert.match(row, /data-modal-dblclick="listing-postal-modal"/);
  assert.match(row, /Double-clic pour corriger le code postal/);
  assert.match(row, /aria-label="Modifier Code postal : 78120"/);
});

test("GET communes : liste des communes du code postal", async (t) => {
  const { agent, id } = await setup(t);
  mockGeoApi(t);
  const res = await agent.get(`/listings/${id}/postal-code/communes?postal_code=78125`).expect(200);
  assert.match(res.text, /name="insee_code"/);
  assert.match(res.text, /value="78269"[^>]*>Gazeran</);
  assert.match(res.text, /Poigny-la-Forêt/);
  assert.match(res.text, /Choisissez la commune/);
});

test("GET communes : code postal incomplet → invitation à saisir, sans appel réseau", async (t) => {
  const { agent, id } = await setup(t);
  const calls = mockGeoApi(t);
  const res = await agent.get(`/listings/${id}/postal-code/communes?postal_code=781`).expect(200);
  assert.match(res.text, /Saisissez les 5 chiffres/);
  assert.equal(calls.length, 0);
});

test("GET communes : code postal inconnu → message d'erreur", async (t) => {
  const { agent, id } = await setup(t);
  mockGeoApi(t);
  const res = await agent.get(`/listings/${id}/postal-code/communes?postal_code=99999`).expect(200);
  assert.match(res.text, /Aucune commune ne correspond/);
});

test("POST : la commune corrigée remplace celle de l'annonce et pilote l'INSEE", async (t) => {
  const { agent, id, csrf, user, repositories, db } = await setup(t);
  mockGeoApi(t);

  const res = await savePostal(agent, id, { _csrf: csrf, postal_code: "78125", insee_code: "78269" }).expect(302);
  assert.equal(res.headers.location, `/listings/${id}#listing-location`);

  const listing = repositories.listings.findById(user.id, id);
  assert.equal(listing.postal_code, "78125");
  assert.equal(listing.city, "Gazeran");
  assert.equal(listing.insee_code, "78269");
  assert.equal(listing.lat, 48.63);
  assert.equal(listing.announced_location.postal_code, "78120");

  // La localisation annoncée reste intacte en base : rétablir suffit à y revenir.
  const raw = db.prepare("SELECT postal_code, insee_code FROM listings WHERE id = ?").get(id);
  assert.deepEqual({ ...raw }, { postal_code: "78120", insee_code: "78517" });

  // Commune résolue avant la redirection : la valorisation part de Gazeran.
  assert.ok(repositories.enrichments.findCommune("78269", "commune"));

  const page = await agent.get(`/listings/${id}`).expect(200);
  assert.match(page.text, /Code postal corrigé : 78125 Gazeran/);
  assert.match(page.text, /Corrigé par vous/);
  assert.match(page.text, /Annonce&nbsp;: Rambouillet \(78120\)/);
});

test("POST : une ré-importation par l'extension ne perd pas la correction", async (t) => {
  const { agent, id, csrf, user, repositories, listings, payload } = await setup(t);
  mockGeoApi(t);
  await savePostal(agent, id, { _csrf: csrf, postal_code: "78125", insee_code: "78269" }).expect(302);

  listings.save(user, { ...payload, price: 375000 });

  const listing = repositories.listings.findById(user.id, id);
  assert.equal(listing.price, 375000);
  assert.equal(listing.postal_code, "78125");
  assert.equal(listing.insee_code, "78269");
});

test("POST reset : retour au code postal de l'annonce", async (t) => {
  const { agent, id, csrf, user, repositories } = await setup(t);
  mockGeoApi(t);
  await savePostal(agent, id, { _csrf: csrf, postal_code: "78125", insee_code: "78269" }).expect(302);

  await agent.post(`/listings/${id}/postal-code/reset`).type("form").send({ _csrf: csrf }).expect(302);

  const listing = repositories.listings.findById(user.id, id);
  assert.equal(listing.postal_code, "78120");
  assert.equal(listing.insee_code, "78517");
  assert.equal(listing.postal_override, null);
});

test("POST : commune hors du code postal → 422, rien n'est enregistré", async (t) => {
  const { agent, id, csrf, repositories } = await setup(t);
  mockGeoApi(t);
  GEO_COMMUNES["78517"] = { nom: "Rambouillet", code: "78517", codesPostaux: ["78120"] };
  t.after(() => delete GEO_COMMUNES["78517"]);

  await savePostal(agent, id, { _csrf: csrf, postal_code: "78125", insee_code: "78517" }).expect(422);
  assert.equal(repositories.visitOverrides.find(id), null);
});

test("POST : code postal invalide → 422", async (t) => {
  const { agent, id, csrf } = await setup(t);
  mockGeoApi(t);
  await savePostal(agent, id, { _csrf: csrf, postal_code: "78A25", insee_code: "78269" }).expect(422);
  await savePostal(agent, id, { _csrf: csrf, postal_code: "78125" }).expect(422);
});

test("POST : geo.api.gouv.fr indisponible → message d'erreur, rien n'est enregistré", async (t) => {
  const { agent, id, csrf, repositories } = await setup(t);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("réseau coupé");
  });
  const res = await savePostal(agent, id, { _csrf: csrf, postal_code: "78125", insee_code: "78269" }).expect(302);
  assert.equal(res.headers.location, `/listings/${id}#listing-location`);
  assert.equal(repositories.visitOverrides.find(id), null);
});

test("annonce d'un autre compte → 404", async (t) => {
  const { app, id, repositories } = await setup(t);
  mockGeoApi(t);
  await createUser(repositories, "autre-cp@example.com");
  const other = await loginAgent(app, "autre-cp@example.com");
  const page = await other.get("/listings").expect(200);
  const csrf = extractCsrf(page.text);

  await other.get(`/listings/${id}/postal-code/communes?postal_code=78125`).expect(404);
  await savePostal(other, id, { _csrf: csrf, postal_code: "78125", insee_code: "78269" }).expect(404);
  await other.post(`/listings/${id}/postal-code/reset`).type("form").send({ _csrf: csrf }).expect(404);
  assert.equal(repositories.visitOverrides.find(id), null);
});

test("CSRF et authentification requis", async (t) => {
  const { app, agent, id } = await setup(t);
  await savePostal(agent, id, { postal_code: "78125", insee_code: "78269" }).expect(403);
  await agent.post(`/listings/${id}/postal-code/reset`).type("form").send({}).expect(403);

  const { default: request } = await import("supertest");
  const anonymous = await request(app).get(`/listings/${id}/postal-code/communes?postal_code=78125`);
  assert.equal(anonymous.status, 302);
});

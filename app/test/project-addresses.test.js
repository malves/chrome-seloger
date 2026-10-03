/**
 * Adresses de référence : carnet central du compte, liaison aux projets, page
 * de paramétrage, page Paramètres (carnet), API et câblage du calcul de trajet.
 */

import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import config from "../src/config.js";
import {
  createTestApp,
  createUser,
  createConnectedUser,
  extractCsrf,
  loginAgent,
} from "./helpers.js";
import createProjectsService from "../src/services/projects.service.js";
import { MAX_ADDRESSES } from "../src/services/projects.service.js";
import createAddressbookService from "../src/services/addressbook.service.js";

/** Service carnet avec un géocodeur neutre (aucun appel réseau en test). */
function createBook(repositories, geocodeAddress = async () => null) {
  return createAddressbookService({ repositories, travel: { geocodeAddress } });
}

/* ------------------------------ Service ------------------------------ */

test("le service relie une adresse au projet et la dépose dans le carnet", async (t) => {
  const { repositories, close } = createTestApp();
  t.after(close);
  const user = await createUser(repositories, "a@example.com");
  const projects = createProjectsService({ repositories });
  const project = projects.ensureDefault(user.id);

  const { address, error } = projects.addAddress(user.id, project.id, {
    label: "  Bureau  ",
    address: "  12 rue de Rivoli, 75001 Paris ",
    lat: 48.86,
    lng: 2.35,
  });
  assert.equal(error, null);
  assert.equal(address.label, "Bureau");
  assert.equal(address.address, "12 rue de Rivoli, 75001 Paris");

  const listed = projects.listAddresses(user.id, project.id);
  assert.equal(listed.length, 1);

  // L'adresse vit dans le carnet du compte.
  assert.equal(repositories.addresses.listByUser(user.id).length, 1);
});

test("retirer une adresse d'un projet la conserve dans le carnet", async (t) => {
  const { repositories, close } = createTestApp();
  t.after(close);
  const user = await createUser(repositories, "a@example.com");
  const projects = createProjectsService({ repositories });
  const project = projects.ensureDefault(user.id);

  const { address } = projects.addAddress(user.id, project.id, {
    address: "10 rue de la Paix, Paris",
  });

  const removed = projects.unlinkAddress(user.id, project.id, address.id);
  assert.equal(removed.removed, true);
  assert.equal(projects.listAddresses(user.id, project.id).length, 0);
  // Détachée du projet, mais toujours dans le carnet.
  assert.equal(repositories.addresses.findById(user.id, address.id) !== null, true);
});

test("une même adresse n'est stockée qu'une fois et réutilisée", async (t) => {
  const { repositories, close } = createTestApp();
  t.after(close);
  const user = await createUser(repositories, "a@example.com");
  const projects = createProjectsService({ repositories });
  const projectA = projects.ensureDefault(user.id);
  const { project: projectB } = projects.create(user.id, "Maison de campagne");

  const first = projects.addAddress(user.id, projectA.id, {
    label: "Bureau",
    address: "1 rue A, Paris",
  });
  const second = projects.addAddress(user.id, projectB.id, {
    label: "Autre libellé",
    address: "1 RUE A, paris", // même adresse, casse différente
  });

  // Une seule entrée de carnet, partagée par les deux projets.
  assert.equal(first.address.id, second.address.id);
  assert.equal(repositories.addresses.listByUser(user.id).length, 1);
  assert.equal(repositories.addresses.listByUser(user.id)[0].project_count, 2);
});

test("une adresse vide est refusée et le quota par projet est appliqué", async (t) => {
  const { repositories, close } = createTestApp();
  t.after(close);
  const user = await createUser(repositories, "a@example.com");
  const projects = createProjectsService({ repositories });
  const project = projects.ensureDefault(user.id);

  assert.equal(projects.addAddress(user.id, project.id, { address: "   " }).error !== null, true);

  for (let i = 0; i < MAX_ADDRESSES; i += 1) {
    assert.equal(projects.addAddress(user.id, project.id, { address: `Adresse ${i}` }).error, null);
  }
  const overflow = projects.addAddress(user.id, project.id, { address: "De trop" });
  assert.match(overflow.error, /limité/);
});

test("le carnet et les adresses d'un autre compte sont inaccessibles", async (t) => {
  const { repositories, close } = createTestApp();
  t.after(close);
  const a = await createUser(repositories, "a@example.com");
  const b = await createUser(repositories, "b@example.com");
  const projects = createProjectsService({ repositories });
  const projectA = projects.ensureDefault(a.id);
  const projectB = projects.ensureDefault(b.id);
  const { address } = projects.addAddress(b.id, projectB.id, { address: "Chez B" });

  // A ne peut pas ajouter à un projet de B, ni voir l'adresse de B dans son carnet.
  assert.equal(projects.addAddress(a.id, projectB.id, { address: "x" }).error, "Projet introuvable.");
  assert.equal(repositories.addresses.findById(a.id, address.id), null);
  // Détacher depuis un projet de A une adresse qu'il n'a pas : sans effet.
  assert.equal(projects.unlinkAddress(a.id, projectA.id, address.id).removed, false);
});

/* ---------------------------- Carnet ---------------------------------- */

test("le carnet refuse les doublons à la création", async (t) => {
  const { repositories, close } = createTestApp();
  t.after(close);
  const user = await createUser(repositories, "a@example.com");
  const book = createBook(repositories);

  assert.equal((await book.create(user.id, { label: "Bureau", address: "1 rue A" })).error, null);
  const dup = await book.create(user.id, { label: "Autre", address: "1 RUE A" });
  assert.match(dup.error, /déjà/);
  assert.equal(repositories.addresses.listByUser(user.id).length, 1);
});

test("modifier une adresse du carnet se répercute sur les projets", async (t) => {
  const { repositories, close } = createTestApp();
  t.after(close);
  const user = await createUser(repositories, "a@example.com");
  const projects = createProjectsService({ repositories });
  const book = createBook(repositories);
  const project = projects.ensureDefault(user.id);

  const { address } = projects.addAddress(user.id, project.id, {
    label: "Bureau",
    address: "1 rue A, Paris",
  });

  const { error } = await book.update(user.id, address.id, {
    label: "Nouveau bureau",
    address: "2 rue B, Lyon",
  });
  assert.equal(error, null);

  const listed = projects.listAddresses(user.id, project.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].label, "Nouveau bureau");
  assert.equal(listed[0].address, "2 rue B, Lyon");
});

test("supprimer une adresse du carnet la retire de tous les projets", async (t) => {
  const { repositories, close } = createTestApp();
  t.after(close);
  const user = await createUser(repositories, "a@example.com");
  const projects = createProjectsService({ repositories });
  const book = createBook(repositories);
  const projectA = projects.ensureDefault(user.id);
  const { project: projectB } = projects.create(user.id, "Maison de campagne");

  const { address } = projects.addAddress(user.id, projectA.id, { address: "1 rue A" });
  projects.addAddress(user.id, projectB.id, { address: "1 rue A" });
  assert.equal(repositories.addresses.listByUser(user.id)[0].project_count, 2);

  const removed = book.remove(user.id, address.id);
  assert.equal(removed.removed, true);
  assert.equal(projects.listAddresses(user.id, projectA.id).length, 0);
  assert.equal(projects.listAddresses(user.id, projectB.id).length, 0);
  assert.equal(repositories.addresses.listByUser(user.id).length, 0);
});

/* --------------------------- Page de projet --------------------------- */

test("la page de paramétrage ajoute puis retire une adresse", async (t) => {
  const { app, repositories, close } = createTestApp();
  t.after(close);
  const user = await createUser(repositories, "a@example.com");
  const projects = createProjectsService({ repositories });
  const project = projects.ensureDefault(user.id);
  const agent = await loginAgent(app, "a@example.com");

  const page = await agent.get(`/projects/${project.id}`).expect(200);
  assert.match(page.text, /Adresses de référence/);
  const csrf = extractCsrf(page.text);

  await agent
    .post(`/projects/${project.id}/addresses`)
    .type("form")
    .send({ _csrf: csrf, label: "Bureau", address: "10 rue de la Paix, Paris" })
    .expect(302);

  let addresses = projects.listAddresses(user.id, project.id);
  assert.equal(addresses.length, 1);
  assert.equal(addresses[0].label, "Bureau");

  await agent
    .post(`/projects/${project.id}/addresses/${addresses[0].id}/delete`)
    .type("form")
    .send({ _csrf: csrf })
    .expect(302);

  addresses = projects.listAddresses(user.id, project.id);
  assert.equal(addresses.length, 0);
  // Retirée du projet mais conservée dans le carnet.
  assert.equal(repositories.addresses.listByUser(user.id).length, 1);
});

/* --------------------------- Page Paramètres -------------------------- */

test("le carnet se gère depuis la page Paramètres", async (t) => {
  const { app, repositories, close } = createTestApp();
  t.after(close);
  const user = await createUser(repositories, "a@example.com");
  const agent = await loginAgent(app, "a@example.com");

  const page = await agent.get("/settings").expect(200);
  assert.match(page.text, /Carnet d'adresses/);
  const csrf = extractCsrf(page.text);

  // Ajout
  await agent
    .post("/settings/addresses")
    .type("form")
    .send({ _csrf: csrf, label: "Bureau", address: "1 rue A, Paris" })
    .expect(302);
  const listed = await agent.get("/settings").expect(200);
  assert.match(listed.text, /Renommer le libellé/);
  assert.match(listed.text, /Modifier l'adresse/);
  assert.match(listed.text, /google\.com\/maps\/search\/\?api=1&amp;query=/);
  assert.match(listed.text, /target="_blank"/);
  assert.equal((listed.text.match(/data-rename-open/g) || []).length, 2);
  let book = repositories.addresses.listByUser(user.id);
  assert.equal(book.length, 1);
  const id = book[0].id;

  // Modification
  await agent
    .post(`/settings/addresses/${id}`)
    .type("form")
    .send({ _csrf: csrf, label: "QG", address: "2 rue B, Lyon" })
    .expect(302);
  book = repositories.addresses.listByUser(user.id);
  assert.equal(book[0].label, "QG");
  assert.equal(book[0].address, "2 rue B, Lyon");

  // Suppression
  await agent
    .post(`/settings/addresses/${id}/delete`)
    .type("form")
    .send({ _csrf: csrf })
    .expect(302);
  assert.equal(repositories.addresses.listByUser(user.id).length, 0);
});

/* -------------------------------- API --------------------------------- */

test("GET /api/v1/projects renvoie les adresses de référence", async (t) => {
  const { app, repositories, close } = createTestApp();
  t.after(close);
  const { user, key } = await createConnectedUser(repositories, "a@example.com");
  const projects = createProjectsService({ repositories });
  const project = projects.ensureDefault(user.id);
  projects.addAddress(user.id, project.id, { label: "Bureau", address: "Paris", lat: 48.8, lng: 2.3 });

  const res = await request(app)
    .get("/api/v1/projects")
    .set("Authorization", `Bearer ${key}`)
    .expect(200);

  const def = res.body.projects.find((p) => p.is_default);
  assert.ok(Array.isArray(def.addresses));
  assert.equal(def.addresses.length, 1);
  assert.deepEqual(def.addresses[0], {
    id: def.addresses[0].id,
    label: "Bureau",
    address: "Paris",
    lat: 48.8,
    lng: 2.3,
  });
});

/* --------------------- Trajet multi-destinations ---------------------- */

test("POST /api/v1/travel-time calcule un trajet par adresse du projet", async (t) => {
  // La clé est lue à la création du routeur : on la pose avant createTestApp.
  const originalKey = config.openRouteService.apiKey;
  const originalFetch = globalThis.fetch;
  config.openRouteService.apiKey = "cle-de-test";

  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes("/v2/directions/driving-car")
        ? { routes: [{ summary: { duration: 1800, distance: 24000 } }] }
        : { features: [{ geometry: { coordinates: [2.35, 48.86] }, properties: { label: "x" } }] },
  });

  const { app, repositories, close } = createTestApp();
  t.after(() => {
    close();
    config.openRouteService.apiKey = originalKey;
    globalThis.fetch = originalFetch;
  });

  const { user, key } = await createConnectedUser(repositories, "a@example.com");
  const projects = createProjectsService({ repositories });
  const project = projects.ensureDefault(user.id);
  projects.addAddress(user.id, project.id, {
    label: "Bureau",
    address: "Paris",
    lat: 48.86,
    lng: 2.35,
  });

  const res = await request(app)
    .post("/api/v1/travel-time")
    .set("Authorization", `Bearer ${key}`)
    .send({ origin: { lat: 48.5, lon: 2.1 }, project_id: project.id })
    .expect(200);

  assert.equal(res.body.project.id, project.id);
  assert.equal(res.body.results.length, 1);
  assert.equal(res.body.results[0].label, "Bureau");
  assert.equal(res.body.results[0].duration_seconds, 1800);
  assert.equal(res.body.results[0].distance_meters, 24000);
});

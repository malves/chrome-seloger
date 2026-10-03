/**
 * Projets de recherche : projet par défaut, gestion, affectation multiple,
 * filtrage, isolation entre comptes, affectation depuis l'API.
 */

import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import {
  createTestApp,
  createUser,
  createConnectedUser,
  listingPayload,
  extractCsrf,
  loginAgent,
  PASSWORD,
} from "./helpers.js";
import createProjectsService from "../src/services/projects.service.js";
import { slugify } from "../src/services/projects.service.js";

/* ------------------------------ Slug ------------------------------ */

test("le slug ignore les accents et la ponctuation", () => {
  assert.equal(slugify("Résidence Principale"), "residence-principale");
  assert.equal(slugify("  Maison de campagne !  "), "maison-de-campagne");
  assert.equal(slugify("***"), "projet");
});

/* --------------------------- Projet par défaut --------------------------- */

test("l'inscription crée un projet par défaut", async (t) => {
  const { app, repositories, close } = createTestApp();
  t.after(close);

  // Un agent est nécessaire : le jeton CSRF est lié au cookie de session.
  const agent = request.agent(app);
  const page = await agent.get("/signup").expect(200);
  await agent
    .post("/signup")
    .type("form")
    .send({
      _csrf: extractCsrf(page.text),
      email: "nouveau@example.com",
      password: PASSWORD,
      password_confirm: PASSWORD,
    })
    .expect(302);

  const user = repositories.users.findByEmail("nouveau@example.com");
  const projects = repositories.projects.listByUser(user.id);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].is_default, true);
});

test("une annonce reçue sans projet rejoint le projet par défaut", async (t) => {
  const { app, repositories, close } = createTestApp();
  t.after(close);
  const { user, key } = await createConnectedUser(repositories, "a@example.com");

  const res = await request(app)
    .post("/api/v1/listings")
    .set("Authorization", `Bearer ${key}`)
    .send(listingPayload())
    .expect(201);

  assert.equal(res.body.projects.length, 1);
  assert.equal(res.body.projects[0].is_default, true);

  const listing = repositories.listings.findById(user.id, res.body.id);
  assert.equal(listing.projects.length, 1);
});

/* ------------------------------ Gestion ------------------------------ */

test("création, renommage et projet par défaut déplaçable", async (t) => {
  const { app, repositories, close } = createTestApp();
  t.after(close);
  const user = await createUser(repositories, "a@example.com");
  const agent = await loginAgent(app, "a@example.com");

  const page = await agent.get("/projects").expect(200);
  assert.match(page.text, /data-rename-open/);
  const csrf = extractCsrf(page.text);

  await agent
    .post("/projects")
    .type("form")
    .send({ _csrf: csrf, name: "Maison de campagne" })
    .expect(302);

  const created = repositories.projects.findBySlug(user.id, "maison-de-campagne");
  assert.ok(created);
  assert.equal(created.is_default, false);

  // Un deuxième projet du même nom est refusé.
  const refused = await agent
    .post("/projects")
    .type("form")
    .send({ _csrf: csrf, name: "maison de campagne" })
    .expect(302);
  assert.equal(refused.headers.location, "/projects");
  assert.equal(repositories.projects.countByUser(user.id), 2);

  await agent
    .post(`/projects/${created.id}`)
    .type("form")
    .send({ _csrf: csrf, action: "rename", name: "Résidence secondaire" })
    .expect(302)
    .expect("location", `/projects/${created.id}`);
  assert.equal(
    repositories.projects.findById(user.id, created.id).slug,
    "residence-secondaire"
  );

  const fromList = await agent
    .post(`/projects/${created.id}`)
    .type("form")
    .send({
      _csrf: csrf,
      action: "rename",
      from: "list",
      name: "Maison de ville",
    })
    .expect(302);
  assert.equal(fromList.headers.location, "/projects");
  assert.equal(
    repositories.projects.findById(user.id, created.id).name,
    "Maison de ville"
  );

  await agent
    .post(`/projects/${created.id}`)
    .type("form")
    .send({ _csrf: csrf, action: "default" })
    .expect(302);
  assert.equal(repositories.projects.findDefault(user.id).id, created.id);
});

test("le projet par défaut ne peut pas être supprimé", async (t) => {
  const { app, repositories, close } = createTestApp();
  t.after(close);
  const user = await createUser(repositories, "a@example.com");
  const agent = await loginAgent(app, "a@example.com");

  const page = await agent.get("/projects").expect(200);
  const fallback = repositories.projects.findDefault(user.id);

  await agent
    .post(`/projects/${fallback.id}/delete`)
    .type("form")
    .send({ _csrf: extractCsrf(page.text) })
    .expect(302);

  assert.ok(repositories.projects.findById(user.id, fallback.id));
});

test("supprimer un projet conserve les annonces et les replace par défaut", async (t) => {
  const { app, repositories, close } = createTestApp();
  t.after(close);
  const { user, key } = await createConnectedUser(repositories, "a@example.com");
  const projects = createProjectsService({ repositories });

  const fallback = projects.ensureDefault(user.id);
  const temporary = projects.create(user.id, "À trier").project;

  const saved = await request(app)
    .post("/api/v1/listings")
    .set("Authorization", `Bearer ${key}`)
    .send(listingPayload({ projects: ["a-trier"] }))
    .expect(201);

  // Seul « À trier » : l'annonce n'est pas dans le projet par défaut.
  repositories.projects.setListingProjects(saved.body.id, [temporary.id]);

  const agent = await loginAgent(app, "a@example.com");
  const page = await agent.get("/projects").expect(200);
  await agent
    .post(`/projects/${temporary.id}/delete`)
    .type("form")
    .send({ _csrf: extractCsrf(page.text) })
    .expect(302);

  const listing = repositories.listings.findById(user.id, saved.body.id);
  assert.ok(listing, "l'annonce survit à la suppression du projet");
  assert.deepEqual(
    listing.projects.map((project) => project.id),
    [fallback.id]
  );
});

test("l'ordre des projets se range à la main et se conserve", async (t) => {
  const { app, repositories, close } = createTestApp();
  t.after(close);
  const user = await createUser(repositories, "a@example.com");
  const projects = createProjectsService({ repositories });
  const fallback = projects.ensureDefault(user.id);
  const campagne = projects.create(user.id, "Maison de campagne").project;
  const locatif = projects.create(user.id, "Investissement locatif").project;

  const agent = await loginAgent(app, "a@example.com");
  const page = await agent.get("/projects").expect(200);
  // La poignée de glisser-déposer est bien présente sur la liste.
  assert.match(page.text, /data-project-reorder/);
  assert.match(page.text, /data-drag-handle/);

  const reordered = await agent
    .post("/projects/reorder")
    .type("form")
    .send({ _csrf: extractCsrf(page.text), order: `${locatif.id},${campagne.id},${fallback.id}` })
    .expect(200);
  assert.equal(reordered.body.ok, true);

  // L'ordre choisi est bien celui renvoyé par la liste, projet par défaut compris.
  assert.deepEqual(
    repositories.projects.listByUser(user.id).map((project) => project.id),
    [locatif.id, campagne.id, fallback.id]
  );

  // Un ordre partiel : les projets omis sont conservés, rangés à la fin.
  await agent
    .post("/projects/reorder")
    .type("form")
    .send({ _csrf: extractCsrf(page.text), order: String(campagne.id) })
    .expect(200);
  assert.deepEqual(
    repositories.projects.listByUser(user.id).map((project) => project.id).slice(0, 1),
    [campagne.id]
  );
  assert.equal(repositories.projects.listByUser(user.id).length, 3);
});

test("réordonner avec le projet d'un autre compte est sans effet", async (t) => {
  const { app, repositories, close } = createTestApp();
  t.after(close);
  const a = await createUser(repositories, "a@example.com");
  const b = await createUser(repositories, "b@example.com");
  const projects = createProjectsService({ repositories });
  const aDefault = projects.ensureDefault(a.id);
  const aExtra = projects.create(a.id, "Maison de campagne").project;
  const bDefault = projects.ensureDefault(b.id);

  const agent = await loginAgent(app, "a@example.com");
  const page = await agent.get("/projects").expect(200);

  // L'identifiant étranger est ignoré ; seuls les projets de A sont rangés.
  const res = await agent
    .post("/projects/reorder")
    .type("form")
    .send({ _csrf: extractCsrf(page.text), order: `${bDefault.id},${aExtra.id},${aDefault.id}` })
    .expect(200);
  assert.deepEqual(res.body.order, [aExtra.id, aDefault.id]);
  assert.deepEqual(
    repositories.projects.listByUser(a.id).map((project) => project.id),
    [aExtra.id, aDefault.id]
  );
  // Le compte B n'a pas bougé.
  assert.deepEqual(
    repositories.projects.listByUser(b.id).map((project) => project.id),
    [bDefault.id]
  );
});

/* --------------------------- Affectation --------------------------- */

test("une annonce peut appartenir à plusieurs projets", async (t) => {
  const { app, repositories, close } = createTestApp();
  t.after(close);
  const { user, key } = await createConnectedUser(repositories, "a@example.com");
  const projects = createProjectsService({ repositories });
  projects.ensureDefault(user.id);
  const country = projects.create(user.id, "Maison de campagne").project;

  const saved = await request(app)
    .post("/api/v1/listings")
    .set("Authorization", `Bearer ${key}`)
    .send(listingPayload())
    .expect(201);

  const agent = await loginAgent(app, "a@example.com");
  const page = await agent.get(`/listings/${saved.body.id}`).expect(200);
  const fallback = repositories.projects.findDefault(user.id);

  await agent
    .post(`/listings/${saved.body.id}/projects`)
    .type("form")
    .send({
      _csrf: extractCsrf(page.text),
      project_ids: [String(fallback.id), String(country.id)],
    })
    .expect(302);

  const listing = repositories.listings.findById(user.id, saved.body.id);
  assert.deepEqual(
    listing.projects.map((project) => project.name).sort(),
    ["Maison de campagne", "Recherche principale"]
  );
});

test("tout décocher ramène l'annonce dans le projet par défaut", async (t) => {
  const { app, repositories, close } = createTestApp();
  t.after(close);
  const { user, key } = await createConnectedUser(repositories, "a@example.com");
  const projects = createProjectsService({ repositories });
  const fallback = projects.ensureDefault(user.id);
  const country = projects.create(user.id, "Maison de campagne").project;

  const saved = await request(app)
    .post("/api/v1/listings")
    .set("Authorization", `Bearer ${key}`)
    .send(listingPayload({ projects: ["maison-de-campagne"] }))
    .expect(201);
  repositories.projects.setListingProjects(saved.body.id, [country.id]);

  const agent = await loginAgent(app, "a@example.com");
  const page = await agent.get(`/listings/${saved.body.id}`).expect(200);

  await agent
    .post(`/listings/${saved.body.id}/projects`)
    .type("form")
    .send({ _csrf: extractCsrf(page.text) })
    .expect(302);

  const listing = repositories.listings.findById(user.id, saved.body.id);
  assert.deepEqual(
    listing.projects.map((project) => project.id),
    [fallback.id]
  );
});

test("une nouvelle capture n'efface pas le classement existant", async (t) => {
  const { app, repositories, close } = createTestApp();
  t.after(close);
  const { user, key } = await createConnectedUser(repositories, "a@example.com");
  const projects = createProjectsService({ repositories });
  projects.ensureDefault(user.id);
  const country = projects.create(user.id, "Maison de campagne").project;

  const saved = await request(app)
    .post("/api/v1/listings")
    .set("Authorization", `Bearer ${key}`)
    .send(listingPayload())
    .expect(201);
  repositories.projects.setListingProjects(saved.body.id, [country.id]);

  await request(app)
    .post("/api/v1/listings")
    .set("Authorization", `Bearer ${key}`)
    .send(listingPayload({ price: 370000 }))
    .expect(200);

  const listing = repositories.listings.findById(user.id, saved.body.id);
  assert.deepEqual(
    listing.projects.map((project) => project.id),
    [country.id]
  );
});

/* ------------------------------ Filtrage ------------------------------ */

test("la liste se filtre par projet", async (t) => {
  const { app, repositories, close } = createTestApp();
  t.after(close);
  const { user, key } = await createConnectedUser(repositories, "a@example.com");
  const projects = createProjectsService({ repositories });
  projects.ensureDefault(user.id);
  projects.create(user.id, "Maison de campagne");

  await request(app)
    .post("/api/v1/listings")
    .set("Authorization", `Bearer ${key}`)
    .send(listingPayload({ title: "Maison principale" }))
    .expect(201);

  await request(app)
    .post("/api/v1/listings")
    .set("Authorization", `Bearer ${key}`)
    .send(
      listingPayload({
        source_id: "999",
        url: "https://www.seloger.com/annonces/achat/maison/campagne-28/999.htm",
        title: "Longère en pierre",
        projects: ["maison-de-campagne"],
      })
    )
    .expect(201);

  const agent = await loginAgent(app, "a@example.com");

  const filtered = await agent
    .get("/listings?project=maison-de-campagne")
    .expect(200);
  assert.match(filtered.text, /Longère en pierre/);
  assert.doesNotMatch(filtered.text, /Maison principale/);

  // Un slug inconnu retombe sur « tous les projets » plutôt qu'une liste vide.
  const unknown = await agent.get("/listings?project=inexistant").expect(200);
  assert.match(unknown.text, /Longère en pierre/);
  assert.match(unknown.text, /Maison principale/);
});

/* ------------------------- Isolation des comptes ------------------------- */

test("un projet d'un autre compte est inutilisable", async (t) => {
  const { app, repositories, close } = createTestApp();
  t.after(close);
  const a = await createConnectedUser(repositories, "a@example.com");
  const b = await createConnectedUser(repositories, "b@example.com");
  const projects = createProjectsService({ repositories });
  projects.ensureDefault(a.user.id);
  const foreign = projects.create(b.user.id, "Projet de B").project;

  // Référence à un projet étranger : ignorée, repli sur le projet par défaut.
  const saved = await request(app)
    .post("/api/v1/listings")
    .set("Authorization", `Bearer ${a.key}`)
    .send(listingPayload({ project_id: foreign.id }))
    .expect(201);

  assert.equal(saved.body.projects.length, 1);
  assert.equal(saved.body.projects[0].is_default, true);

  const listing = repositories.listings.findById(a.user.id, saved.body.id);
  assert.ok(listing.projects.every((project) => project.id !== foreign.id));

  // Et la gestion d'un projet étranger échoue sans rien modifier.
  const agent = await loginAgent(app, "a@example.com");
  const page = await agent.get("/projects").expect(200);
  await agent
    .post(`/projects/${foreign.id}`)
    .type("form")
    .send({ _csrf: extractCsrf(page.text), action: "rename", name: "Volé" })
    .expect(302);
  assert.equal(repositories.projects.findById(b.user.id, foreign.id).name, "Projet de B");
});

/* --------------------------------- API --------------------------------- */

test("l'API liste et crée des projets", async (t) => {
  const { app, repositories, close } = createTestApp();
  t.after(close);
  const { key } = await createConnectedUser(repositories, "a@example.com");

  const initial = await request(app)
    .get("/api/v1/projects")
    .set("Authorization", `Bearer ${key}`)
    .expect(200);
  assert.equal(initial.body.projects.length, 1);
  assert.equal(initial.body.projects[0].is_default, true);

  const created = await request(app)
    .post("/api/v1/projects")
    .set("Authorization", `Bearer ${key}`)
    .send({ name: "Maison de campagne" })
    .expect(201);
  assert.equal(created.body.project.slug, "maison-de-campagne");

  await request(app)
    .post("/api/v1/projects")
    .set("Authorization", `Bearer ${key}`)
    .send({ name: "   " })
    .expect(422);

  const after = await request(app)
    .get("/api/v1/projects")
    .set("Authorization", `Bearer ${key}`)
    .expect(200);
  assert.equal(after.body.projects.length, 2);
});

test("l'extension cible un projet par son nom ou son slug", async (t) => {
  const { app, repositories, close } = createTestApp();
  t.after(close);
  const { user, key } = await createConnectedUser(repositories, "a@example.com");
  const projects = createProjectsService({ repositories });
  projects.ensureDefault(user.id);
  projects.create(user.id, "Maison de campagne");

  const bySlug = await request(app)
    .post("/api/v1/listings")
    .set("Authorization", `Bearer ${key}`)
    .send(listingPayload({ project: "maison-de-campagne" }))
    .expect(201);
  assert.deepEqual(
    bySlug.body.projects.map((project) => project.name),
    ["Maison de campagne"]
  );

  const byName = await request(app)
    .post("/api/v1/listings")
    .set("Authorization", `Bearer ${key}`)
    .send(
      listingPayload({
        source_id: "777",
        url: "https://www.seloger.com/annonces/achat/maison/ailleurs-28/777.htm",
        // Casse et accents libres : le nom est normalisé avant comparaison.
        projects: ["MAISON DE CAMPAGNE"],
      })
    )
    .expect(201);
  assert.deepEqual(
    byName.body.projects.map((project) => project.name),
    ["Maison de campagne"]
  );
});

test("lookup renvoie les projets, et l'API reclasse une annonce", async (t) => {
  const { app, repositories, close } = createTestApp();
  t.after(close);
  const { user, key } = await createConnectedUser(repositories, "a@example.com");
  const projects = createProjectsService({ repositories });
  projects.ensureDefault(user.id);
  const country = projects.create(user.id, "Maison de campagne").project;

  const payload = listingPayload();
  const saved = await request(app)
    .post("/api/v1/listings")
    .set("Authorization", `Bearer ${key}`)
    .send(payload)
    .expect(201);

  const reclassified = await request(app)
    .put(`/api/v1/listings/${saved.body.id}/projects`)
    .set("Authorization", `Bearer ${key}`)
    .send({ projects: [country.id] })
    .expect(200);
  assert.deepEqual(
    reclassified.body.projects.map((project) => project.id),
    [country.id]
  );

  const lookup = await request(app)
    .get(`/api/v1/listings/lookup?url=${encodeURIComponent(payload.url)}`)
    .set("Authorization", `Bearer ${key}`)
    .expect(200);
  assert.equal(lookup.body.saved, true);
  assert.deepEqual(
    lookup.body.projects.map((project) => project.name),
    ["Maison de campagne"]
  );

  // Liste vide : repli sur le projet par défaut, jamais d'annonce orpheline.
  const emptied = await request(app)
    .put(`/api/v1/listings/${saved.body.id}/projects`)
    .set("Authorization", `Bearer ${key}`)
    .send({ projects: [] })
    .expect(200);
  assert.equal(emptied.body.projects.length, 1);
  assert.equal(emptied.body.projects[0].is_default, true);
});

test("reclasser l'annonce d'un autre compte renvoie 404", async (t) => {
  const { app, repositories, close } = createTestApp();
  t.after(close);
  const a = await createConnectedUser(repositories, "a@example.com");
  const b = await createConnectedUser(repositories, "b@example.com");

  const saved = await request(app)
    .post("/api/v1/listings")
    .set("Authorization", `Bearer ${a.key}`)
    .send(listingPayload())
    .expect(201);

  await request(app)
    .put(`/api/v1/listings/${saved.body.id}/projects`)
    .set("Authorization", `Bearer ${b.key}`)
    .send({ projects: [] })
    .expect(404);
});

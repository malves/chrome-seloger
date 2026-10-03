import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import {
  PASSWORD,
  createTestApp,
  createUser,
  extractCsrf,
  listingPayload,
  loginAgent,
} from "./helpers.js";
import createListingsService from "../src/services/listings.service.js";

function withApp(name, fn) {
  test(name, async (t) => {
    const ctx = createTestApp();
    ctx.listingsService = createListingsService({
      repositories: ctx.repositories,
    });
    t.after(() => ctx.close());
    await fn(ctx, t);
  });
}

/* --------------------------- Pages publiques --------------------------- */

withApp("la page d'accueil explique le fonctionnement", async ({ app }) => {
  const res = await request(app).get("/").expect(200);
  assert.match(res.text, /dans un seul carnet/);
  assert.equal(res.headers["x-robots-tag"], "noindex, nofollow");
});

withApp("les pages privées renvoient vers la connexion", async ({ app }) => {
  await request(app).get("/listings").expect(302).expect("location", /\/login/);
  await request(app).get("/settings").expect(302).expect("location", /\/login/);
});

withApp("un mot de passe trop court est refusé", async ({ app }) => {
  const agent = request.agent(app);
  const page = await agent.get("/signup").expect(200);

  const res = await agent
    .post("/signup")
    .type("form")
    .send({
      _csrf: extractCsrf(page.text),
      email: "a@example.com",
      password: "court",
      password_confirm: "court",
    })
    .expect(422);

  assert.match(res.text, /au moins 10 caractères/);
});

withApp("un e-mail déjà utilisé est refusé", async ({ app, repositories }) => {
  await createUser(repositories, "a@example.com");
  const agent = request.agent(app);
  const page = await agent.get("/signup").expect(200);

  const res = await agent
    .post("/signup")
    .type("form")
    .send({
      _csrf: extractCsrf(page.text),
      email: "A@example.com",
      password: PASSWORD,
      password_confirm: PASSWORD,
    })
    .expect(422);

  assert.match(res.text, /existe déjà/);
});

withApp("un formulaire sans jeton CSRF est rejeté", async ({ app }) => {
  const res = await request(app)
    .post("/signup")
    .type("form")
    .send({ email: "a@example.com", password: PASSWORD, password_confirm: PASSWORD })
    .expect(403);

  assert.match(res.text, /Formulaire expiré/);
});

withApp("l'inscription connecte immédiatement", async ({ app }) => {
  const agent = request.agent(app);
  const page = await agent.get("/signup").expect(200);

  await agent
    .post("/signup")
    .type("form")
    .send({
      _csrf: extractCsrf(page.text),
      email: "neuf@example.com",
      password: PASSWORD,
      password_confirm: PASSWORD,
    })
    .expect(302)
    .expect("location", "/listings");

  await agent.get("/listings").expect(200);
});

/* ------------------------------- Liste -------------------------------- */

withApp("le carnet vide explique la démarche", async ({ app, repositories }) => {
  await createUser(repositories, "a@example.com");
  const agent = await loginAgent(app, "a@example.com");

  const res = await agent.get("/listings").expect(200);
  assert.match(res.text, /Votre carnet est vide/);
  assert.match(res.text, /Enregistrez une annonce/);
});

withApp("les annonces écartées restent visibles, en fin de liste", async (ctx) => {
  const { app, repositories, listingsService } = ctx;
  const user = await createUser(repositories, "a@example.com");

  const kept = listingsService.save(user, listingPayload({ title: "À visiter" }));
  const dropped = listingsService.save(
    user,
    listingPayload({
      source_id: "999",
      url: "https://www.seloger.com/annonces/achat/maison/ville-78/999.htm",
      title: "Trop cher",
    })
  );
  repositories.listings.setStatus(user.id, dropped.id, "rejected");

  const agent = await loginAgent(app, "a@example.com");

  const all = await agent.get("/listings").expect(200);
  assert.match(all.text, /À visiter/);
  assert.match(all.text, /Trop cher/);
  assert.ok(all.text.indexOf("À visiter") < all.text.indexOf("Trop cher"));
  assert.doesNotMatch(all.text, /Masquer les écartées/);
  assert.ok(kept.id);
});

withApp("tri et filtres s'appliquent", async (ctx) => {
  const { app, repositories, listingsService } = ctx;
  const user = await createUser(repositories, "a@example.com");

  listingsService.save(
    user,
    listingPayload({ source_id: "1", url: "https://a.example.com/1", price: 200_000, title: "Le moins cher" })
  );
  listingsService.save(
    user,
    listingPayload({
      source_id: "2",
      url: "https://a.example.com/2",
      price: 900_000,
      title: "Le plus cher",
      property_type: "apartment",
      location: { city: "Versailles", postal_code: "78000" },
    })
  );

  const agent = await loginAgent(app, "a@example.com");

  const byPrice = await agent.get("/listings?sort=price").expect(200);
  assert.ok(
    byPrice.text.indexOf("Le moins cher") < byPrice.text.indexOf("Le plus cher")
  );

  const byPriceDesc = await agent.get("/listings?sort=price_desc").expect(200);
  assert.ok(
    byPriceDesc.text.indexOf("Le plus cher") <
      byPriceDesc.text.indexOf("Le moins cher")
  );

  const houses = await agent.get("/listings?type=house").expect(200);
  assert.match(houses.text, /Le moins cher/);
  assert.doesNotMatch(houses.text, /Le plus cher/);

  const city = await agent.get("/listings?city=Versailles").expect(200);
  assert.match(city.text, /Le plus cher/);
  assert.doesNotMatch(city.text, /Le moins cher/);

  const capped = await agent.get("/listings?price_max=300000").expect(200);
  assert.match(capped.text, /Le moins cher/);
  assert.doesNotMatch(capped.text, /Le plus cher/);

  // Un tri inconnu retombe sur le tri par défaut au lieu d'échouer.
  await agent.get("/listings?sort=DROP+TABLE").expect(200);
});

/* ------------------------------- Fiche -------------------------------- */

withApp("une description contenant du HTML s'affiche comme du texte", async (ctx) => {
  const { app, repositories, listingsService } = ctx;
  const user = await createUser(repositories, "a@example.com");
  const { id } = listingsService.save(
    user,
    listingPayload({ description: '<script>alert("xss")</script> Maison & jardin' })
  );

  const agent = await loginAgent(app, "a@example.com");
  const res = await agent.get(`/listings/${id}`).expect(200);

  assert.doesNotMatch(res.text, /<script>alert/);
  assert.match(res.text, /&lt;script&gt;alert/);
  assert.match(res.text, /Maison &amp; jardin/);
});

withApp("la fiche d'un payload minimal s'affiche sans erreur", async (ctx) => {
  const { app, repositories, listingsService } = ctx;
  const user = await createUser(repositories, "a@example.com");
  const { id } = listingsService.save(user, {
    schema_version: 1,
    source: "pap",
    url: "https://www.pap.fr/annonce/1",
  });

  const agent = await loginAgent(app, "a@example.com");
  const res = await agent.get(`/listings/${id}`).expect(200);
  assert.match(res.text, /Caractéristiques/);
  assert.match(res.text, /Notes personnelles/);
});

withApp("une annonce d'un autre compte renvoie 404", async (ctx) => {
  const { app, repositories, listingsService } = ctx;
  const a = await createUser(repositories, "a@example.com");
  await createUser(repositories, "b@example.com");
  const { id } = listingsService.save(a, listingPayload());

  const agentB = await loginAgent(app, "b@example.com");
  const csrf = extractCsrf((await agentB.get("/listings")).text);

  await agentB.get(`/listings/${id}`).expect(404);
  await agentB
    .post(`/listings/${id}`)
    .type("form")
    .send({ _csrf: csrf, status: "offer" })
    .expect(404);

  // Le statut de A est intact.
  assert.equal(repositories.listings.findById(a.id, id).status, "new");
});

withApp("le financement n'est pas proposé pour une location", async (ctx) => {
  const { app, repositories, listingsService } = ctx;
  const user = await createUser(repositories, "a@example.com");
  const rent = listingsService.save(
    user,
    listingPayload({ transaction_type: "rent", price: 1450 })
  );
  const sale = listingsService.save(
    user,
    listingPayload({ source_id: "777", url: "https://a.example.com/777" })
  );

  const agent = await loginAgent(app, "a@example.com");

  const rentPage = await agent.get(`/listings/${rent.id}`).expect(200);
  assert.doesNotMatch(rentPage.text, /Estimation indicative/);

  const salePage = await agent.get(`/listings/${sale.id}`).expect(200);
  assert.match(salePage.text, /Estimation indicative/);
});

/* ---------------------------- Actions htmx ---------------------------- */

withApp("le statut se change depuis la carte", async (ctx) => {
  const { app, repositories, listingsService } = ctx;
  const user = await createUser(repositories, "a@example.com");
  const { id } = listingsService.save(user, listingPayload());
  const agent = await loginAgent(app, "a@example.com");
  const csrf = extractCsrf((await agent.get("/listings")).text);

  const res = await agent
    .post(`/listings/${id}`)
    .set("HX-Request", "true")
    .type("form")
    .send({ _csrf: csrf, view: "card", status: "visited" })
    .expect(200);

  // Réponse partielle : la carte seule, sans layout.
  assert.doesNotMatch(res.text, /<!DOCTYPE html>/);
  assert.match(res.text, /Visitée/);
  assert.equal(repositories.listings.findById(user.id, id).status, "visited");
});

withApp("un statut inconnu est refusé", async (ctx) => {
  const { app, repositories, listingsService } = ctx;
  const user = await createUser(repositories, "a@example.com");
  const { id } = listingsService.save(user, listingPayload());
  const agent = await loginAgent(app, "a@example.com");
  const csrf = extractCsrf((await agent.get("/listings")).text);

  await agent
    .post(`/listings/${id}`)
    .type("form")
    .send({ _csrf: csrf, status: "inconnu" })
    .expect(400);
});

withApp("les notes s'enregistrent et le favori bascule", async (ctx) => {
  const { app, repositories, listingsService } = ctx;
  const user = await createUser(repositories, "a@example.com");
  const { id } = listingsService.save(user, listingPayload());
  const agent = await loginAgent(app, "a@example.com");
  const csrf = extractCsrf((await agent.get("/listings")).text);

  const notes = await agent
    .post(`/listings/${id}`)
    .set("HX-Request", "true")
    .type("form")
    .send({ _csrf: csrf, view: "notes", notes: "Toiture à revoir" })
    .expect(200);
  assert.match(notes.text, /Enregistré à/);
  assert.equal(
    repositories.listings.findById(user.id, id).notes,
    "Toiture à revoir"
  );

  await agent
    .post(`/listings/${id}`)
    .set("HX-Request", "true")
    .type("form")
    .send({ _csrf: csrf, view: "header", is_favorite: "1" })
    .expect(200);
  assert.equal(repositories.listings.findById(user.id, id).is_favorite, true);
});

withApp("le tableau de financement se recalcule", async (ctx) => {
  const { app, repositories, listingsService } = ctx;
  const user = await createUser(repositories, "a@example.com");
  const { id } = listingsService.save(user, listingPayload());
  const agent = await loginAgent(app, "a@example.com");
  const csrf = extractCsrf((await agent.get("/listings")).text);

  const res = await agent
    .post(`/listings/${id}/financing`)
    .set("HX-Request", "true")
    .type("form")
    .send({
      _csrf: csrf,
      negotiated_price: "350000",
      works: "15 000",
      down_payment: "40\u202f000",
      years: "20",
      interest_rate: "3,2",
      insurance_rate: "0.25",
    })
    .expect(200);

  assert.match(res.text, /Estimation indicative/);
  assert.equal((res.text.match(/data-amount-step="1"/g) || []).length, 3);
  assert.equal((res.text.match(/data-amount-step="-1"/g) || []).length, 3);
  assert.match(res.text, /value="350[\u202f\u00a0 ]000"/);
  assert.match(res.text, /value="15[\u202f\u00a0 ]000"/);
  assert.match(res.text, /value="40[\u202f\u00a0 ]000"/);
  const stored = repositories.enrichments.findOne(id, "financing");
  assert.equal(stored.data.params.negotiatedPrice, 350_000);
  assert.equal(stored.data.params.works, 15_000);
  assert.equal(stored.data.params.downPayment, 40_000);
  assert.equal(stored.data.params.years, 20);
  // Un taux saisi avec une virgule est bien interprété.
  assert.ok(Math.abs(stored.data.params.interestRate - 0.032) < 1e-9);
  assert.ok(stored.data.result.totalMonthly > 0);
});

withApp("un provider inconnu ne peut pas être relancé", async (ctx) => {
  const { app, repositories, listingsService } = ctx;
  const user = await createUser(repositories, "a@example.com");
  const { id } = listingsService.save(user, listingPayload());
  const agent = await loginAgent(app, "a@example.com");
  const csrf = extractCsrf((await agent.get("/listings")).text);

  await agent
    .post(`/listings/${id}/enrich/inexistant`)
    .type("form")
    .send({ _csrf: csrf })
    .expect(404);
});

withApp("une annonce se supprime avec ses dépendances", async (ctx) => {
  const { app, repositories, listingsService, db } = ctx;
  const user = await createUser(repositories, "a@example.com");
  const { id } = listingsService.save(user, listingPayload());
  const agent = await loginAgent(app, "a@example.com");
  const csrf = extractCsrf((await agent.get("/listings")).text);

  await agent
    .post(`/listings/${id}/delete`)
    .type("form")
    .send({ _csrf: csrf })
    .expect(302)
    .expect("location", "/listings");

  assert.equal(repositories.listings.findById(user.id, id), null);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM listing_photos").get().n,
    0
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM price_history").get().n, 0);
});

/* ----------------------------- Paramètres ----------------------------- */

withApp("les navigateurs connectés sont listés, sans aucun secret", async ({
  app,
  repositories,
}) => {
  const user = await createUser(repositories, "a@example.com");
  const { key } = repositories.extension.createSession({
    userId: user.id,
    label: "Chrome sur macOS",
  });
  const agent = await loginAgent(app, "a@example.com");

  const page = await agent.get("/settings").expect(200);
  assert.match(page.text, /Chrome sur macOS/);
  assert.ok(!page.text.includes(key), "la clé de session ne doit jamais s'afficher");
});

withApp("déconnecter un navigateur coupe son accès à l'API", async ({
  app,
  repositories,
}) => {
  const user = await createUser(repositories, "a@example.com");
  const { key } = repositories.extension.createSession({ userId: user.id });
  const agent = await loginAgent(app, "a@example.com");
  const csrf = extractCsrf((await agent.get("/settings")).text);
  const id = repositories.extension.listSessions(user.id)[0].id;

  await request(app)
    .get("/api/v1/me")
    .set("Authorization", `Bearer ${key}`)
    .expect(200);

  await agent
    .post(`/settings/extension/${id}/disconnect`)
    .type("form")
    .send({ _csrf: csrf })
    .expect(302);

  await request(app)
    .get("/api/v1/me")
    .set("Authorization", `Bearer ${key}`)
    .expect(401);
  assert.equal(repositories.extension.listSessions(user.id).length, 0);
});

withApp("le mot de passe change après vérification de l'ancien", async ({
  app,
  repositories,
}) => {
  await createUser(repositories, "a@example.com");
  const agent = await loginAgent(app, "a@example.com");
  const csrf = extractCsrf((await agent.get("/settings")).text);

  const refused = await agent
    .post("/settings/password")
    .type("form")
    .send({
      _csrf: csrf,
      current_password: "mauvais-mot-de-passe",
      password: "nouveaumotdepasse",
      password_confirm: "nouveaumotdepasse",
    })
    .expect(422);
  assert.match(refused.text, /Mot de passe actuel incorrect/);

  await agent
    .post("/settings/password")
    .type("form")
    .send({
      _csrf: csrf,
      current_password: PASSWORD,
      password: "nouveaumotdepasse",
      password_confirm: "nouveaumotdepasse",
    })
    .expect(302);

  // Le nouveau mot de passe ouvre bien une session sur le site.
  await loginAgent(app, "a@example.com", "nouveaumotdepasse");
});

withApp("la suppression du compte efface toutes les données", async (ctx) => {
  const { app, repositories, listingsService, db } = ctx;
  const user = await createUser(repositories, "a@example.com");
  listingsService.save(user, listingPayload());
  repositories.extension.createSession({ userId: user.id });

  const agent = await loginAgent(app, "a@example.com");
  const csrf = extractCsrf((await agent.get("/settings")).text);

  // Sans la confirmation explicite, rien n'est supprimé.
  await agent
    .post("/settings/delete")
    .type("form")
    .send({ _csrf: csrf, confirm: "oui" })
    .expect(302);
  assert.ok(repositories.users.findById(user.id));

  await agent
    .post("/settings/delete")
    .type("form")
    .send({ _csrf: csrf, confirm: "supprimer" })
    .expect(302)
    .expect("location", "/");

  assert.equal(repositories.users.findById(user.id), null);
  for (const table of [
    "listings",
    "listing_photos",
    "price_history",
    "extension_sessions",
  ]) {
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
      0,
      `${table} doit être vide`
    );
  }
});

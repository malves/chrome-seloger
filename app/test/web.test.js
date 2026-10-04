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
import config from "../src/config.js";

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

withApp("la liste n'affiche que 9 annonces par page", async (ctx) => {
  const { app, repositories, listingsService } = ctx;
  const user = await createUser(repositories, "pag@example.com");
  for (let i = 0; i < 12; i++) {
    listingsService.save(
      user,
      listingPayload({
        source_id: String(2000 + i),
        url: `https://www.seloger.com/annonces/achat/maison/ville-78/${2000 + i}.htm`,
        title: `Annonce ${i}`,
      })
    );
  }
  const agent = await loginAgent(app, "pag@example.com");
  const page1 = await agent.get("/listings").expect(200);
  assert.equal((page1.text.match(/<article class="card"/g) || []).length, 9);
  assert.match(page1.text, /1–9 sur 12 annonces/);
  const page2 = await agent.get("/listings?page=2").expect(200);
  assert.equal((page2.text.match(/<article class="card"/g) || []).length, 3);
  assert.match(page2.text, /10–12 sur 12 annonces/);
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

withApp("l'adresse réelle se saisit, puis s'efface", async (ctx) => {
  const { app, repositories, listingsService } = ctx;
  const user = await createUser(repositories, "a@example.com");
  const { id } = listingsService.save(user, listingPayload());
  const agent = await loginAgent(app, "a@example.com");
  const csrf = extractCsrf((await agent.get("/listings")).text);

  // Saisie : l'adresse texte est persistée (le géocodage échoue hors-ligne
  // sans faire échouer l'enregistrement).
  const saved = await agent
    .post(`/listings/${id}/address`)
    .set("HX-Request", "true")
    .type("form")
    .send({ _csrf: csrf, user_address: "12 rue de Rivoli, 75001 Paris" })
    .expect(200);
  assert.match(saved.text, /12 rue de Rivoli/);
  assert.match(saved.text, /75001 Paris/);
  assert.match(saved.text, /Adresse saisie manuellement/);
  assert.equal(
    repositories.listings.findById(user.id, id).user_address,
    "12 rue de Rivoli, 75001 Paris"
  );

  const structured = await agent
    .post(`/listings/${id}/address`)
    .set("HX-Request", "true")
    .type("form")
    .send({
      _csrf: csrf,
      street: "8 avenue Foch",
      complement: "Bat. C",
      postal_code: "78120",
      city: "Rambouillet",
    })
    .expect(200);
  assert.match(structured.text, /8 avenue Foch/);
  assert.equal(
    repositories.listings.findById(user.id, id).user_address,
    "8 avenue Foch, Bat. C, 78120 Rambouillet"
  );

  await agent
    .post(`/listings/${id}/address`)
    .set("HX-Request", "true")
    .type("form")
    .send({
      _csrf: csrf,
      street: "177 Boulevard de la République",
      postal_code: "92210",
      city: "Saint-Cloud",
      address_source: "detected",
    })
    .expect(200);
  const fromDpe = repositories.listings.findById(user.id, id);
  assert.equal(fromDpe.user_address_source, "detected");
  assert.match(fromDpe.user_address, /177 Boulevard de la République/);

  // Effacement : une adresse vide remet le champ à null.
  const cleared = await agent
    .post(`/listings/${id}/address`)
    .set("HX-Request", "true")
    .type("form")
    .send({ _csrf: csrf, street: "", postal_code: "", city: "" })
    .expect(200);
  assert.ok(cleared.text);
  assert.equal(repositories.listings.findById(user.id, id).user_address, null);
});

withApp("les critères DPE pour déterminer l'adresse sont exposés en JSON", async (ctx) => {
  const { app, repositories, listingsService } = ctx;
  const user = await createUser(repositories, "a@example.com");
  const payload = listingPayload({
    location: { city: "Paris", postal_code: "75011" },
    property_type: "apartment",
    dpe: "D",
    ges: "C",
    surface: 48,
    floor: 2,
    year_built: 1975,
  });
  const { id } = listingsService.save(user, payload);
  const agent = await loginAgent(app, "a@example.com");
  const csrf = extractCsrf((await agent.get("/listings")).text);

  const res = await agent
    .post(`/listings/${id}/address-ai/criteria`)
    .set("X-CSRF-Token", csrf)
    .set("Accept", "application/json")
    .send({})
    .expect(200);

  assert.equal(res.body.listingId, id);
  assert.equal(res.body.criteres.codePostal, "75011");
  assert.equal(res.body.criteres.dpe, "D");
  assert.equal(res.body.criteres.typeBien, "apartment");
  assert.equal(res.body.criteres.typeBatiment, "appartement");
  assert.equal(res.body.criteres.etage, 2);
  assert.equal(res.body.criteres.anneeConstruction, 1975);
  assert.equal(res.body.filtresRechercheDpe.type_batiment, "appartement");
});

withApp("la recherche DPE renvoie des adresses candidates notées", async (ctx) => {
  const { app, repositories, listingsService } = ctx;
  const user = await createUser(repositories, "a@example.com");

  repositories.dpe.upsertMany([
    {
      numero_dpe: "DPE-TEST-1",
      date_derniere_modification_dpe: "2024-01-02",
      etiquette_dpe: "D",
      etiquette_ges: "C",
      type_batiment: "appartement",
      annee_construction: 1975,
      surface_habitable_logement: 48,
      adresse_ban: "5 Rue de Test 75011 Paris",
      nom_commune_ban: "Paris",
      code_postal_ban: "75011",
      numero_etage_appartement: 2,
      complement_adresse_logement: "2ème étage",
    },
    {
      // Hors fenêtre de surface : ne doit pas ressortir.
      numero_dpe: "DPE-TEST-2",
      date_derniere_modification_dpe: "2024-01-01",
      etiquette_dpe: "A",
      etiquette_ges: "A",
      type_batiment: "appartement",
      surface_habitable_logement: 120,
      adresse_ban: "99 Avenue Autre 75011 Paris",
      nom_commune_ban: "Paris",
      code_postal_ban: "75011",
    },
  ]);

  const payload = listingPayload({
    location: { city: "Paris", postal_code: "75011" },
    property_type: "apartment",
    dpe: "D",
    ges: "C",
    surface: 48,
    floor: 2,
    year_built: 1975,
  });
  const { id } = listingsService.save(user, payload);
  const agent = await loginAgent(app, "a@example.com");
  const csrf = extractCsrf((await agent.get("/listings")).text);

  const res = await agent
    .post(`/listings/${id}/address-ai/search`)
    .set("X-CSRF-Token", csrf)
    .set("Accept", "application/json")
    .send({})
    .expect(200);

  assert.equal(res.body.mode, "precise");
  assert.equal(res.body.candidates.length, 1);
  const candidate = res.body.candidates[0];
  assert.equal(candidate.street, "5 Rue de Test");
  assert.equal(candidate.postalCode, "75011");
  assert.ok(candidate.confidence >= 90);
  assert.equal(candidate.matched.floor, true);
});

withApp("l'adresse réelle d'une annonce d'autrui est inaccessible", async (ctx) => {
  const { app, repositories, listingsService } = ctx;
  const owner = await createUser(repositories, "a@example.com");
  const { id } = listingsService.save(owner, listingPayload());
  await createUser(repositories, "b@example.com");
  const agent = await loginAgent(app, "b@example.com");
  const csrf = extractCsrf((await agent.get("/listings")).text);

  await agent
    .post(`/listings/${id}/address`)
    .set("HX-Request", "true")
    .type("form")
    .send({ _csrf: csrf, user_address: "1 rue Secrète, 75000 Paris" })
    .expect(404);
  assert.equal(repositories.listings.findById(owner.id, id).user_address, null);
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
  assert.equal((res.text.match(/data-amount-step="1"/g) || []).length, 6);
  assert.equal((res.text.match(/data-amount-step="-1"/g) || []).length, 6);
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

withApp("l'admin enregistre le paramétrage financement", async ({ app, repositories }) => {
  await createUser(repositories, config.adminEmail);
  const agent = await loginAgent(app, config.adminEmail);

  const page = await agent.get("/admin").expect(200);
  assert.match(page.text, /Financement/);

  const csrf = extractCsrf(page.text);
  await agent
    .post("/admin/financing")
    .type("form")
    .send({
      _csrf: csrf,
      notary_rate_old: "7",
      notary_rate_new: "2,5",
      guarantee_rate: "1,5",
      interest_rate: "3,5",
      insurance_rate: "0,30",
      years: "22",
      debt_ratio: "35",
    })
    .expect(302)
    .expect("location", "/admin");

  assert.equal(config.financing.notaryRateOld, 0.07);
  assert.equal(config.financing.years, 22);
});

withApp(
  "l'admin clôt un import orphelin au rafraîchissement du statut",
  async ({ app, repositories, db }) => {
    await createUser(repositories, config.adminEmail);
    const agent = await loginAgent(app, config.adminEmail);
    const jobId = repositories.dpe.createJob({
      dateFrom: "2026-09-04",
      dateTo: "2026-09-04",
      daysTotal: 1,
    });
    repositories.dpe.updateJob(jobId, {
      status: "running",
      current_day: "2026-09-04",
    });
    db.prepare("UPDATE dpe_import_jobs SET updated_at = ? WHERE id = ?").run(
      new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      jobId
    );

    const res = await agent
      .get("/admin/dpe/import/status")
      .set("HX-Request", "true")
      .expect(200);

    assert.match(res.text, /plus aucune activité/i);
    assert.equal(repositories.dpe.getJob(jobId).status, "error");
    assert.doesNotMatch(res.text, /hx-get="\/admin\/dpe\/import\/status"/);
  }
);

withApp("l'admin peut interrompre un import en cours", async ({ app, repositories }) => {
  await createUser(repositories, config.adminEmail);
  const agent = await loginAgent(app, config.adminEmail);
  const jobId = repositories.dpe.createJob({
    dateFrom: "2026-09-04",
    dateTo: "2026-09-04",
    daysTotal: 1,
  });
  repositories.dpe.updateJob(jobId, {
    status: "running",
    current_day: "2026-09-04",
    day_rows_total: 8000,
    day_rows_done: 1200,
    rows_imported: 1200,
  });

  const page = await agent.get("/admin").expect(200);
  const csrf = extractCsrf(page.text);

  const res = await agent
    .post("/admin/dpe/import/cancel")
    .set("HX-Request", "true")
    .type("form")
    .send({ _csrf: csrf, job_id: String(jobId) })
    .expect(200);

  assert.match(res.text, /Import interrompu|annulé/i);
  assert.equal(repositories.dpe.getJob(jobId).status, "error");
  assert.match(repositories.dpe.getJob(jobId).error, /annulé/i);
});

withApp("l'admin peut relancer un import en échec", async ({ app, repositories }) => {
  await createUser(repositories, config.adminEmail);
  const agent = await loginAgent(app, config.adminEmail);
  const jobId = repositories.dpe.createJob({
    dateFrom: "2026-09-04",
    dateTo: "2026-09-05",
    daysTotal: 2,
  });
  repositories.dpe.updateJob(jobId, {
    status: "error",
    error: "Import interrompu : plus aucune activité détectée.",
  });

  const page = await agent.get("/admin").expect(200);
  assert.match(page.text, /Relancer/);

  const before = repositories.dpe.listRecentJobs(50).length;

  const csrf = extractCsrf(page.text);
  const res = await agent
    .post("/admin/dpe/import/retry")
    .set("HX-Request", "true")
    .type("form")
    .send({ _csrf: csrf, job_id: String(jobId) })
    .expect(200);

  assert.match(res.text, /Import relancé/i);

  // La relance réutilise la même ligne : aucun nouveau job n'est créé.
  assert.equal(repositories.dpe.listRecentJobs(50).length, before);

  const running = repositories.dpe.listRunningJobs();
  assert.equal(running.length, 1);
  const [reloaded] = running;
  assert.equal(reloaded.id, jobId);
  assert.equal(reloaded.date_from, "2026-09-04");
  assert.equal(reloaded.date_to, "2026-09-05");
  assert.ok(["pending", "running"].includes(reloaded.status));
  // La progression et l'erreur précédentes ont été réinitialisées.
  assert.equal(reloaded.error, null);
  assert.equal(reloaded.days_done, 0);
  assert.equal(reloaded.rows_imported, 0);
});

withApp("l'admin gère les comptes utilisateurs", async ({ app, repositories }) => {
  await createUser(repositories, config.adminEmail);
  const victim = await createUser(repositories, "victime@example.com");
  const agent = await loginAgent(app, config.adminEmail);

  const page = await agent.get("/admin").expect(200);
  assert.match(page.text, /Utilisateurs/);
  assert.match(page.text, /victime@example.com/);

  assert.doesNotMatch(page.text, /Nouveau compte/);

  const detail = await agent.get(`/admin/users/${victim.id}`).expect(200);
  assert.match(detail.text, /Mot de passe/);

  const detailCsrf = extractCsrf(detail.text);
  await agent
    .post(`/admin/users/${victim.id}/password`)
    .set("HX-Request", "true")
    .type("form")
    .send({
      _csrf: detailCsrf,
      password: "nouveaumotdepasse",
      password_confirm: "nouveaumotdepasse",
    })
    .expect(200);

  const guest = request.agent(app);
  const loginPage = await guest.get("/login").expect(200);
  const loginCsrf = extractCsrf(loginPage.text);
  await guest
    .post("/login")
    .type("form")
    .send({
      _csrf: loginCsrf,
      email: "victime@example.com",
      password: PASSWORD,
    })
    .expect(401);

  const loginPage2 = await guest.get("/login").expect(200);
  await guest
    .post("/login")
    .type("form")
    .send({
      _csrf: extractCsrf(loginPage2.text),
      email: "victime@example.com",
      password: "nouveaumotdepasse",
    })
    .expect(302);

  const adminPage = await agent.get("/admin").expect(200);
  const deleteCsrf = extractCsrf(adminPage.text);
  await agent
    .post(`/admin/users/${victim.id}/delete`)
    .set("HX-Request", "true")
    .type("form")
    .send({ _csrf: deleteCsrf })
    .expect(200);

  assert.equal(repositories.users.findById(victim.id), null);
});

withApp("l'admin ne peut pas supprimer son propre compte", async ({ app, repositories }) => {
  const admin = await createUser(repositories, config.adminEmail);
  const agent = await loginAgent(app, config.adminEmail);
  const page = await agent.get("/admin").expect(200);
  const csrf = extractCsrf(page.text);

  const res = await agent
    .post(`/admin/users/${admin.id}/delete`)
    .set("HX-Request", "true")
    .type("form")
    .send({ _csrf: csrf })
    .expect(200);

  assert.match(res.text, /ne pouvez pas supprimer votre propre compte/i);
  assert.ok(repositories.users.findById(admin.id));
});

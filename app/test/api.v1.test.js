import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import config from "../src/config.js";
import { challengeFor } from "../src/services/extension-auth.service.js";
import {
  createTestApp,
  createUser,
  createConnectedUser,
  extractCsrf,
  listingPayload,
  loginAgent,
} from "./helpers.js";

/** Enveloppe chaque test dans une application neuve sur base en mémoire. */
function withApp(name, fn) {
  test(name, async (t) => {
    const ctx = createTestApp();
    t.after(() => ctx.close());
    await fn(ctx, t);
  });
}

const bearer = (key) => ({ Authorization: `Bearer ${key}` });

/* -------------------- Connexion de l'extension ------------------------ */

// L'environnement peut restreindre les extensions autorisées : on prend alors
// la première de la liste pour que le test reste valable.
const EXTENSION_ID = config.extensionIds[0] || "abcdefghijklmnopabcdefghijklmnop";
const REDIRECT_URI = `https://${EXTENSION_ID}.chromiumapp.org/`;

function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: challengeFor(verifier) };
}

/** Rejoue le parcours « S'authentifier » jusqu'à la redirection de Chrome. */
async function consent(app, email, { challenge, decision = "allow", state = "etat-42" }) {
  const agent = await loginAgent(app, email);
  const params = {
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  };

  const page = await agent.get("/extension/connect").query(params).expect(200);
  const res = await agent
    .post("/extension/connect")
    .type("form")
    .send({ _csrf: extractCsrf(page.text), decision, ...params })
    .expect(302);

  return new URL(res.headers.location);
}

withApp("le consentement délivre un code échangeable contre une session", async ({
  app,
  repositories,
}) => {
  const user = await createUser(repositories, "a@example.com");
  const { verifier, challenge } = pkce();

  const redirect = await consent(app, "a@example.com", { challenge });
  assert.equal(redirect.origin, new URL(REDIRECT_URI).origin);
  assert.equal(redirect.searchParams.get("state"), "etat-42");

  const exchanged = await request(app)
    .post("/api/v1/extension/session")
    .send({ code: redirect.searchParams.get("code"), code_verifier: verifier })
    .expect(201);

  assert.equal(exchanged.body.user.email, "a@example.com");

  const me = await request(app)
    .get("/api/v1/me")
    .set(bearer(exchanged.body.key))
    .expect(200);
  assert.equal(me.body.user.id, user.id);

  // La session apparaît dans Paramètres, nommée d'après le navigateur.
  const sessions = repositories.extension.listSessions(user.id);
  assert.equal(sessions.length, 1);
  assert.ok(sessions[0].label);
});

withApp("un code d'autorisation ne vaut qu'une fois", async ({ app, repositories }) => {
  await createUser(repositories, "a@example.com");
  const { verifier, challenge } = pkce();

  const redirect = await consent(app, "a@example.com", { challenge });
  const body = {
    code: redirect.searchParams.get("code"),
    code_verifier: verifier,
  };

  await request(app).post("/api/v1/extension/session").send(body).expect(201);
  const replayed = await request(app)
    .post("/api/v1/extension/session")
    .send(body)
    .expect(401);
  assert.equal(replayed.body.error.code, "unauthorized");
});

withApp("un code sans le vérificateur PKCE est inutilisable", async ({
  app,
  repositories,
}) => {
  await createUser(repositories, "a@example.com");
  const { challenge } = pkce();

  const redirect = await consent(app, "a@example.com", { challenge });

  await request(app)
    .post("/api/v1/extension/session")
    .send({
      code: redirect.searchParams.get("code"),
      code_verifier: crypto.randomBytes(32).toString("base64url"),
    })
    .expect(401);
});

withApp("refuser le consentement ne délivre aucun code", async ({
  app,
  repositories,
}) => {
  await createUser(repositories, "a@example.com");
  const { challenge } = pkce();

  const redirect = await consent(app, "a@example.com", {
    challenge,
    decision: "deny",
  });

  assert.equal(redirect.searchParams.get("code"), null);
  assert.equal(redirect.searchParams.get("error"), "access_denied");
  assert.equal(redirect.searchParams.get("state"), "etat-42");
});

withApp("une adresse de retour étrangère à Chrome est refusée", async ({
  app,
  repositories,
}) => {
  await createUser(repositories, "a@example.com");
  const agent = await loginAgent(app, "a@example.com");

  await agent
    .get("/extension/connect")
    .query({
      redirect_uri: "https://evil.example.com/callback",
      code_challenge: pkce().challenge,
    })
    .expect(400);
});

withApp("la page de consentement exige d'être connecté au site", async ({ app }) => {
  await request(app)
    .get("/extension/connect")
    .query({ redirect_uri: REDIRECT_URI, code_challenge: pkce().challenge })
    .expect(302)
    .expect("location", /^\/login\?next=/);
});

withApp("la clé de session n'est jamais stockée en clair", async ({
  app,
  repositories,
  db,
}) => {
  await createUser(repositories, "a@example.com");
  const { verifier, challenge } = pkce();
  const redirect = await consent(app, "a@example.com", { challenge });

  const res = await request(app)
    .post("/api/v1/extension/session")
    .send({ code: redirect.searchParams.get("code"), code_verifier: verifier })
    .expect(201);

  const rows = db.prepare("SELECT key_hash FROM extension_sessions").all();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].key_hash, res.body.key);
  assert.match(rows[0].key_hash, /^[0-9a-f]{64}$/);
  // Le code consommé ne reste pas en base.
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM extension_auth_codes").get().n,
    0
  );
});

withApp("GET /me exige une session valide", async ({ app, repositories }) => {
  const { user, key } = await createConnectedUser(repositories, "a@example.com");

  await request(app).get("/api/v1/me").expect(401);
  await request(app).get("/api/v1/me").set(bearer("ext_inexistante")).expect(401);

  const res = await request(app).get("/api/v1/me").set(bearer(key)).expect(200);
  assert.deepEqual(res.body.user, { id: user.id, email: "a@example.com" });
});

withApp("DELETE /extension/session déconnecte l'extension", async ({
  app,
  repositories,
}) => {
  const { user, key } = await createConnectedUser(repositories, "a@example.com");

  await request(app)
    .delete("/api/v1/extension/session")
    .set(bearer(key))
    .expect(204);

  await request(app).get("/api/v1/me").set(bearer(key)).expect(401);
  assert.equal(repositories.extension.listSessions(user.id).length, 0);
});

withApp("last_used_at est actualisé à chaque appel", async ({ app, repositories }) => {
  const { user, key } = await createConnectedUser(repositories, "a@example.com");
  assert.equal(repositories.extension.listSessions(user.id)[0].last_used_at, null);

  await request(app).get("/api/v1/me").set(bearer(key)).expect(200);
  assert.ok(repositories.extension.listSessions(user.id)[0].last_used_at);
});

/* ---------------------------- Annonces -------------------------------- */

withApp("POST /listings refuse un appel sans session", async ({ app }) => {
  const res = await request(app)
    .post("/api/v1/listings")
    .send(listingPayload())
    .expect(401);
  assert.equal(res.body.error.code, "unauthorized");
});

withApp("POST /listings détaille les champs manquants", async ({ app, repositories }) => {
  const { key } = await createConnectedUser(repositories, "a@example.com");

  const res = await request(app)
    .post("/api/v1/listings")
    .set(bearer(key))
    .send({})
    .expect(422);

  assert.equal(res.body.error.code, "unprocessable_entity");
  assert.deepEqual(
    res.body.error.details.map((d) => d.field).sort(),
    ["schema_version", "source", "url"]
  );
});

withApp("POST /listings rejette une url non https", async ({ app, repositories }) => {
  const { key } = await createConnectedUser(repositories, "a@example.com");

  const res = await request(app)
    .post("/api/v1/listings")
    .set(bearer(key))
    .send(listingPayload({ url: "http://www.seloger.com/a/1.htm" }))
    .expect(422);

  assert.equal(res.body.error.details[0].field, "url");
});

withApp("POST /listings crée l'annonce et renvoie son URL web", async ({ app, repositories }) => {
  const { user, key } = await createConnectedUser(repositories, "a@example.com");

  const res = await request(app)
    .post("/api/v1/listings")
    .set(bearer(key))
    .send(listingPayload())
    .expect(201);

  assert.equal(res.body.created, true);
  assert.equal(res.body.price_changed, false);
  assert.match(res.body.web_url, new RegExp(`/listings/${res.body.id}$`));

  const listing = repositories.listings.findById(user.id, res.body.id);
  assert.equal(listing.title, "Maison 5 pièces 120 m²");
  assert.equal(listing.price, 385_000);
  assert.equal(listing.status, "new");
  assert.deepEqual(repositories.listings.listPhotos(listing.id), [
    "https://photos.example.com/1.jpg",
  ]);
  // Le prix initial est historisé dès la création.
  assert.equal(repositories.listings.listPriceHistory(listing.id).length, 1);
});

withApp("un payload minimal est accepté", async ({ app, repositories }) => {
  const { user, key } = await createConnectedUser(repositories, "a@example.com");

  const res = await request(app)
    .post("/api/v1/listings")
    .set(bearer(key))
    .send({
      schema_version: 1,
      source: "pap",
      url: "https://www.pap.fr/annonce/1",
    })
    .expect(201);

  const listing = repositories.listings.findById(user.id, res.body.id);
  assert.equal(listing.price, null);
  assert.equal(listing.transaction_type, "sale");
  assert.deepEqual(listing.features, []);
  assert.equal(repositories.listings.listPriceHistory(listing.id).length, 0);
});

withApp("les champs facultatifs invalides sont ignorés", async ({ app, repositories }) => {
  const { user, key } = await createConnectedUser(repositories, "a@example.com");

  const res = await request(app)
    .post("/api/v1/listings")
    .set(bearer(key))
    .send(
      listingPayload({
        price: "pas-un-prix",
        surface: -40,
        dpe: "Z",
        rooms: 9999,
        photos: ["http://insecure/1.jpg", "https://ok.example.com/2.jpg", 42],
      })
    )
    .expect(201);

  const listing = repositories.listings.findById(user.id, res.body.id);
  assert.equal(listing.price, null);
  assert.equal(listing.surface, null);
  assert.equal(listing.dpe, null);
  assert.equal(listing.rooms, null);
  assert.deepEqual(repositories.listings.listPhotos(listing.id), [
    "https://ok.example.com/2.jpg",
  ]);
});

withApp("rejouer le même payload ne crée pas de doublon", async ({ app, repositories }) => {
  const { user, key } = await createConnectedUser(repositories, "a@example.com");

  const first = await request(app)
    .post("/api/v1/listings")
    .set(bearer(key))
    .send(listingPayload())
    .expect(201);

  const second = await request(app)
    .post("/api/v1/listings")
    .set(bearer(key))
    .send(listingPayload())
    .expect(200);

  assert.equal(second.body.id, first.body.id);
  assert.equal(second.body.created, false);
  assert.equal(second.body.price_changed, false);
  assert.equal(repositories.listings.countByUser(user.id), 1);
  assert.equal(repositories.listings.listPriceHistory(first.body.id).length, 1);
});

withApp(
  "un changement de prix est historisé sans toucher au suivi",
  async ({ app, repositories }) => {
    const { user, key } = await createConnectedUser(repositories, "a@example.com");

    const created = await request(app)
      .post("/api/v1/listings")
      .set(bearer(key))
      .send(listingPayload())
      .expect(201);

    repositories.listings.setStatus(user.id, created.body.id, "visit_planned");
    repositories.listings.setNotes(user.id, created.body.id, "Visite samedi");
    repositories.listings.setFavorite(user.id, created.body.id, true);

    const updated = await request(app)
      .post("/api/v1/listings")
      .set(bearer(key))
      .send(listingPayload({ price: 369_000 }))
      .expect(200);

    assert.equal(updated.body.price_changed, true);

    const listing = repositories.listings.findById(user.id, created.body.id);
    assert.equal(listing.price, 369_000);
    assert.equal(listing.status, "visit_planned");
    assert.equal(listing.notes, "Visite samedi");
    assert.equal(listing.is_favorite, true);

    const history = repositories.listings.listPriceHistory(listing.id);
    assert.deepEqual(
      history.map((point) => point.price),
      [385_000, 369_000]
    );
    assert.equal(listing.price_change.direction, "down");
  }
);

withApp(
  "une nouvelle capture incomplète n'efface pas les données connues",
  async ({ app, repositories }) => {
    const { user, key } = await createConnectedUser(repositories, "a@example.com");

    const created = await request(app)
      .post("/api/v1/listings")
      .set(bearer(key))
      .send(listingPayload())
      .expect(201);

    await request(app)
      .post("/api/v1/listings")
      .set(bearer(key))
      .send({
        schema_version: 1,
        source: "seloger",
        source_id: "123456",
        url: "https://www.seloger.com/annonces/achat/maison/ville-78/123456.htm",
      })
      .expect(200);

    const listing = repositories.listings.findById(user.id, created.body.id);
    assert.equal(listing.title, "Maison 5 pièces 120 m²");
    assert.equal(listing.price, 385_000);
    assert.equal(repositories.listings.listPhotos(listing.id).length, 1);
  }
);

withApp(
  "les paramètres de suivi n'empêchent pas la déduplication",
  async ({ app, repositories }) => {
    const { user, key } = await createConnectedUser(repositories, "a@example.com");
    const base = {
      schema_version: 1,
      source: "pap",
      url: "https://www.pap.fr/annonce/42",
    };

    await request(app).post("/api/v1/listings").set(bearer(key)).send(base).expect(201);
    await request(app)
      .post("/api/v1/listings")
      .set(bearer(key))
      .send({ ...base, url: "https://www.pap.fr/annonce/42?utm_source=mail#photo" })
      .expect(200);

    assert.equal(repositories.listings.countByUser(user.id), 1);
  }
);

withApp("deux comptes ne partagent pas leurs annonces", async ({ app, repositories }) => {
  const a = await createConnectedUser(repositories, "a@example.com");
  const b = await createConnectedUser(repositories, "b@example.com");

  await request(app)
    .post("/api/v1/listings")
    .set(bearer(a.key))
    .send(listingPayload())
    .expect(201);

  const res = await request(app)
    .post("/api/v1/listings")
    .set(bearer(b.key))
    .send(listingPayload())
    .expect(201);

  assert.equal(repositories.listings.countByUser(a.user.id), 1);
  assert.equal(repositories.listings.countByUser(b.user.id), 1);
  assert.equal(repositories.listings.findById(a.user.id, res.body.id), null);
});

withApp("DELETE /listings/:id supprime l'annonce du compte", async ({
  app,
  repositories,
}) => {
  const { user, key } = await createConnectedUser(repositories, "a@example.com");

  const created = await request(app)
    .post("/api/v1/listings")
    .set(bearer(key))
    .send(listingPayload())
    .expect(201);

  await request(app)
    .delete(`/api/v1/listings/${created.body.id}`)
    .set(bearer(key))
    .expect(204);

  assert.equal(
    repositories.listings.findById(user.id, created.body.id),
    null
  );

  await request(app)
    .delete(`/api/v1/listings/${created.body.id}`)
    .set(bearer(key))
    .expect(404);
});

withApp("DELETE /listings/:id est cloisonné par compte", async ({
  app,
  repositories,
}) => {
  const a = await createConnectedUser(repositories, "a@example.com");
  const b = await createConnectedUser(repositories, "b@example.com");

  const created = await request(app)
    .post("/api/v1/listings")
    .set(bearer(a.key))
    .send(listingPayload())
    .expect(201);

  await request(app)
    .delete(`/api/v1/listings/${created.body.id}`)
    .set(bearer(b.key))
    .expect(404);

  assert.ok(repositories.listings.findById(a.user.id, created.body.id));
});

/* ----------------------------- Lookup --------------------------------- */

withApp("GET /listings/lookup indique si l'annonce est connue", async ({ app, repositories }) => {
  const { key } = await createConnectedUser(repositories, "a@example.com");
  const url = listingPayload().url;

  const before = await request(app)
    .get("/api/v1/listings/lookup")
    .query({ url })
    .set(bearer(key))
    .expect(200);
  assert.deepEqual(before.body, { saved: false });

  const created = await request(app)
    .post("/api/v1/listings")
    .set(bearer(key))
    .send(listingPayload())
    .expect(201);

  const after = await request(app)
    .get("/api/v1/listings/lookup")
    .query({ url: `${url}?utm_source=mail` })
    .set(bearer(key))
    .expect(200);

  assert.equal(after.body.saved, true);
  assert.equal(after.body.id, created.body.id);
  assert.equal(after.body.status, "new");
});

withApp("GET /listings/lookup est cloisonné par compte", async ({ app, repositories }) => {
  const a = await createConnectedUser(repositories, "a@example.com");
  const b = await createConnectedUser(repositories, "b@example.com");

  await request(app)
    .post("/api/v1/listings")
    .set(bearer(a.key))
    .send(listingPayload())
    .expect(201);

  const res = await request(app)
    .get("/api/v1/listings/lookup")
    .query({ url: listingPayload().url })
    .set(bearer(b.key))
    .expect(200);

  assert.deepEqual(res.body, { saved: false });
});

withApp("GET /listings/lookup exige le paramètre url", async ({ app, repositories }) => {
  const { key } = await createConnectedUser(repositories, "a@example.com");
  const res = await request(app)
    .get("/api/v1/listings/lookup")
    .set(bearer(key))
    .expect(400);
  assert.equal(res.body.error.code, "bad_request");
});

/* ---------------------------- Temps de trajet ------------------------- */

withApp("POST /travel-time exige une session", async ({ app }) => {
  const res = await request(app)
    .post("/api/v1/travel-time")
    .send({ origin: { lat: 48.5, lon: 2.1 } })
    .expect(401);
  assert.equal(res.body.error.code, "unauthorized");
});

withApp(
  "POST /travel-time se déclare indisponible sans clé ORS",
  async ({ app, repositories }) => {
    const { key } = await createConnectedUser(repositories, "a@example.com");
    // En environnement de test, ORS_API_KEY est vide : le calcul est désactivé.
    const res = await request(app)
      .post("/api/v1/travel-time")
      .set(bearer(key))
      .send({ origin: { lat: 48.5, lon: 2.1 } })
      .expect(503);
    assert.equal(res.body.error.code, "travel_unavailable");
  }
);

/* -------------------------- CORS et divers ---------------------------- */

withApp("une origine inconnue n'obtient pas d'en-tête CORS", async ({ app, repositories }) => {
  const { key } = await createConnectedUser(repositories, "a@example.com");

  const res = await request(app)
    .get("/api/v1/me")
    .set({ ...bearer(key), Origin: "https://evil.example.com" })
    .expect(200);

  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

withApp("un endpoint inconnu répond en JSON", async ({ app }) => {
  const res = await request(app).get("/api/v1/inconnu").expect(404);
  assert.equal(res.body.error.code, "not_found");
});

withApp("un corps JSON invalide est refusé proprement", async ({ app, repositories }) => {
  const { key } = await createConnectedUser(repositories, "a@example.com");

  const res = await request(app)
    .post("/api/v1/listings")
    .set({ ...bearer(key), "Content-Type": "application/json" })
    .send("{ pas du json")
    .expect(400);

  assert.equal(res.body.error.code, "bad_request");
});

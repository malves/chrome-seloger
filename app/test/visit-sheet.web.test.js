/**
 * Fiche de préparation de visite (routes) : lien depuis la fiche annonce,
 * page dédiée GET /listings/:id/visite (étapes, cartes, bilan), provenance
 * affichée dans les caractéristiques, persistance via PUT /listings/:id/visite,
 * et répercussion de la surface corrigée sur le chiffrage des travaux lorsque
 * l'utilisateur a donné son consentement.
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
import { surface as fmtSurface } from "../src/lib/format.js";
import { migrate } from "../src/db.js";

const DESCRIPTION =
  "Bel appartement en copropriété. Charges de copropriété : 1 800 €/an. Taxe foncière : 1 200 €.";

async function setup(t, overrides = {}) {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  const email = "visite@example.com";
  const user = await createUser(ctx.repositories, email);
  const service = createListingsService({ repositories: ctx.repositories });
  const { id } = service.save(
    user,
    listingPayload({
      title: "Appartement familial",
      property_type: "apartment",
      surface: 120,
      rooms: 4,
      price: 300000,
      description: DESCRIPTION,
      photos: ["https://p.example.com/1.jpg"],
      ...overrides,
    })
  );
  const listing = ctx.repositories.listings.findById(user.id, id);
  const agent = await loginAgent(ctx.app, email);
  const page = await agent.get(`/listings/${id}`).expect(200);
  return { ...ctx, user, listing, agent, page, csrf: extractCsrf(page.text) };
}

const applySurface = (agent, id, csrf, value, applyToSheet = true) =>
  agent
    .put(`/listings/${id}/visite`)
    .set("X-CSRF-Token", csrf)
    .send({ visit: { applyToSheet, answers: { surface: { response: "no", value } } } });

function initialJson(html) {
  const m = html.match(/<script type="application\/json" id="visit-initial">([\s\S]*?)<\/script>/);
  assert.ok(m, "état initial présent dans la page de visite");
  return JSON.parse(m[1]);
}

test("fiche : lien « Préparer la visite » vers la page dédiée, provenance affichée", async (t) => {
  const { page, listing } = await setup(t);
  assert.match(page.text, new RegExp(`href="/listings/${listing.id}/visite"`), "lien vers la page de visite");
  assert.match(page.text, /Préparer la visite/);
  assert.doesNotMatch(page.text, /visit-sheet\.js/, "le script de la fiche ne charge pas sur l'annonce");
  assert.doesNotMatch(page.text, /visit-modal/, "plus de modale sur la fiche annonce");

  // Charges et taxe foncière extraites de la description → badge « Description ».
  assert.match(page.text, /Charges de copropriété/);
  assert.match(page.text, /Taxe foncière/);
  assert.match(page.text, /visit-source--description/);

  // Surface annoncée : badge « Annonce » (donnée structurée), pas de correction.
  assert.match(page.text, /visit-source--structured/);
  assert.doesNotMatch(page.text, /visit-source--user/);
});

test("fiche : le contenu de la fiche de visite n'est pas inliné dans l'annonce", async (t) => {
  const { page } = await setup(t);
  assert.doesNotMatch(page.text, /loi Carrez/, "les conseils du pro ne sont pas inlinés");
  assert.doesNotMatch(page.text, /visit-initial/, "pas d'état de visite dans la page annonce");
});

test("GET /visite : page dédiée avec étapes, cartes, bilan et état initial", async (t) => {
  const { agent, listing } = await setup(t);
  const res = await agent.get(`/listings/${listing.id}/visite`).expect(200);
  const html = res.text;

  assert.match(html, /visit\.css/, "feuille dédiée");
  assert.match(html, /visit-sheet\.js/, "script dédié");
  assert.match(html, /data-visit-url="\/listings\/\d+\/visite"/);
  assert.match(html, /Appartement familial/, "en-tête repris de l'annonce");
  assert.match(html, /https:\/\/p\.example\.com\/1\.jpg/, "photo reprise");

  // Les cinq étapes du déroulé de visite, numérotées.
  const text = html.replace(/&#39;/g, "'");
  for (const label of ["Avant la visite", "Autour et dehors", "À l'intérieur", "Les chiffres à obtenir", "Mon ressenti"]) {
    assert.ok(text.includes(label), `étape « ${label} »`);
  }
  assert.match(html, /class="visit-step" aria-hidden="true">5</);

  // Étapes en accordéon exclusif : toutes fermées par défaut (y compris « Avant la visite »).
  const collapses = html.match(/<details class="visit-section__collapse"[^>]*>/g) || [];
  assert.equal(collapses.length, 5);
  assert.ok(collapses.every((tag) => /name="visit-steps"/.test(tag)), "même groupe d'accordéon");
  assert.ok(
    collapses.every((tag) => !/\sopen(\s|>)/.test(tag)),
    "aucune étape ouverte au chargement"
  );

  // Filtres par thème dans un bandeau défilant : flèches des deux côtés, pilotées par app.js.
  assert.match(html, /class="scroll-rail visit-filters__rail" data-scroll-rail/);
  assert.match(html, /data-scroll-rail-nav="prev"[\s\S]*?#wi-chevron-left/);
  assert.match(html, /data-scroll-rail-nav="next"[\s\S]*?#wi-chevron-right/);
  assert.match(html, /class="scroll-rail__viewport visit-filters__scroll" data-scroll-rail-viewport/);

  // Cartes : questions phares, conseils du pro, pastilles.
  assert.match(html, /Pourquoi les vendeurs vendent-ils/);
  assert.match(html, /Le prix est-il négociable/);
  assert.match(html, /loi Carrez/, "conseil du pro présent sur la page de visite");
  assert.match(html, /visit-tag--essential/);
  assert.match(text, /À confirmer · déjà renseigné par l'annonce/);
  assert.match(text, /Selon l'annonce[\s\S]{0,200}?120 m²/, "valeur connue à confirmer affichée");

  // Mode interactif : bouton d'entrée + surface plein écran (pilotée côté client).
  assert.match(html, /Lancer le mode interactif/);
  assert.match(html, /visit-mode__deck-icon[\s\S]*?<polygon points="10 8 16 12 10 16 10 8"/, "icône lecture (play) inlinée");
  assert.match(html, /id="wi-lecture"/, "symbole lecture dans le sprite");
  assert.match(html, /data-deck-open/, "bouton d'entrée dans le mode interactif");
  assert.match(html, /class="visit-deck"[^>]*data-deck[^>]*hidden/, "surface repliée par défaut");
  assert.match(html, /data-deck-stage/);
  assert.match(html, /data-deck-act="ask"/);
  assert.match(html, /data-deck-act="later"/);
  assert.match(html, /data-deck-act="next"/);
  assert.match(html, /data-deck-confetti/, "canvas de confettis présent");

  // Bilan : anneau, levier, interrupteur, modale de consentement au 1er lancement.
  assert.match(html, /Bilan de visite/);
  assert.match(html, /Levier de négociation/);
  assert.match(html, /data-apply-toggle/);
  assert.match(html, /data-consent-modal/, "modale de consentement présente");
  assert.doesNotMatch(html, /data-consent-modal[^>]*hidden/, "1er lancement → modale ouverte");

  // État initial : items avec provenance, pas de réponse.
  const initial = initialJson(html);
  const byId = Object.fromEntries(initial.items.map((it) => [it.id, it]));
  assert.equal(byId.surface.known, true);
  assert.equal(byId.surface.value, 120);
  assert.equal(byId.charges_copro.value, 1800, "charges extraites de la description");
  assert.equal(byId.charges_copro.source, "description");
  assert.equal(byId.taxe_fonciere.value, 1200);
  assert.deepEqual(initial.answers, {});
  assert.equal(initial.applyToSheet, null);
  assert.ok(initial.items.length >= 50);
});

test("GET /visite : réponses enregistrées rendues, bandeau de consentement replié", async (t) => {
  const { agent, listing, csrf } = await setup(t);
  await agent
    .put(`/listings/${listing.id}/visite`)
    .set("X-CSRF-Token", csrf)
    .send({
      visit: {
        applyToSheet: false,
        answers: {
          humidity: { response: "yes" },
          quiet: { response: "unknown" },
          crush: { response: null, value: 4 },
          bogus_question: { response: "yes" },
        },
      },
    })
    .expect(200);

  const res = await agent.get(`/listings/${listing.id}/visite`).expect(200);
  const initial = initialJson(res.text);
  assert.equal(initial.applyToSheet, false);
  assert.deepEqual(Object.keys(initial.answers).sort(), ["crush", "humidity", "quiet"]);
  assert.equal(initial.answers.crush.value, 4);
  assert.match(res.text, /data-consent-modal[^>]*hidden/, "choix déjà fait → modale masquée");
  // Bilan rendu côté serveur : une alerte bloquante (humidité) et un point à confirmer.
  assert.match(res.text, /Un point bloquant/);
  assert.match(res.text, /data-out="todo">1</);
});

test("GET /visite d'une annonce d'un autre compte : 404", async (t) => {
  const { app, listing, repositories } = await setup(t);
  await createUser(repositories, "lecteur@example.com");
  const other = await loginAgent(app, "lecteur@example.com");
  await other.get(`/listings/${listing.id}/visite`).expect(404);
});

test("GET /visite sans session : redirection vers la connexion", async (t) => {
  const { app, listing } = await setup(t);
  const { default: request } = await import("supertest");
  const res = await request(app).get(`/listings/${listing.id}/visite`);
  assert.ok([302, 303].includes(res.status), `redirigé (${res.status})`);
  assert.match(res.headers.location, /login/);
});

test("/public/js/visit-insights.js : moteur de bilan servi au navigateur", async (t) => {
  const { agent } = await setup(t);
  const res = await agent.get("/public/js/visit-insights.js").expect(200);
  assert.match(res.headers["content-type"], /javascript/);
  assert.match(res.text, /export function computeInsights/);
});

test("PUT visite : consentement donné → surface corrigée et ancienne valeur sur la fiche", async (t) => {
  const { agent, listing, csrf } = await setup(t);
  const res = await applySurface(agent, listing.id, csrf, 95).expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.applyToSheet, true);

  const page = await agent.get(`/listings/${listing.id}`).expect(200);
  assert.match(page.text, /visit-source--user/, "la surface devient une saisie utilisateur");
  assert.match(page.text, /kv__prev/, "ancienne valeur affichée");
  assert.ok(page.text.includes(fmtSurface(95)), "surface de visite dans les specs");
  // L'ancienne valeur annoncée est conservée dans l'indicateur dédié.
  assert.match(page.text, new RegExp(`kv__prev[\\s\\S]{0,200}?${fmtSurface(120)}`));
});

test("PATCH restore surface après visite : surface annoncée rétablie", async (t) => {
  const { agent, listing, csrf } = await setup(t);
  await applySurface(agent, listing.id, csrf, 95).expect(200);

  await agent
    .patch(`/listings/${listing.id}/fields/surface`)
    .set("X-CSRF-Token", csrf)
    .set("Accept", "application/json")
    .send({ restore: true })
    .expect(200);

  const page = await agent.get(`/listings/${listing.id}`).expect(200);
  assert.ok(page.text.includes(fmtSurface(120)));
  assert.doesNotMatch(page.text, /listing-spec-value__prev/);
});

test("PUT visite : surface acceptée → surface effective dans l'aperçu des travaux", async (t) => {
  const { agent, listing, csrf } = await setup(t);
  const before = await agent.get(`/listings/${listing.id}/works/plan`).expect(200);
  assert.equal(before.body.overview.surface, 120);

  await applySurface(agent, listing.id, csrf, 95).expect(200);

  const after = await agent.get(`/listings/${listing.id}/works/plan`).expect(200);
  assert.equal(after.body.overview.surface, 95, "le chiffrage repart de la surface corrigée");
});

test("PUT visite : sans consentement, la fiche n'est pas modifiée", async (t) => {
  const { agent, listing, csrf } = await setup(t);
  await applySurface(agent, listing.id, csrf, 95, false).expect(200);

  const plan = await agent.get(`/listings/${listing.id}/works/plan`).expect(200);
  assert.equal(plan.body.overview.surface, 120, "surface annoncée conservée");

  const page = await agent.get(`/listings/${listing.id}`).expect(200);
  assert.doesNotMatch(page.text, /visit-source--user/);
});

test("PUT visite : jeton CSRF requis", async (t) => {
  const { agent, listing } = await setup(t);
  await agent
    .put(`/listings/${listing.id}/visite`)
    .send({ visit: { applyToSheet: true, answers: {} } })
    .expect(403);
});

test("visite d'une annonce d'un autre compte : 404", async (t) => {
  const { app, listing, repositories } = await setup(t);
  await createUser(repositories, "autre@example.com");
  const other = await loginAgent(app, "autre@example.com");
  const page = await other.get("/listings").expect(200);
  await other
    .put(`/listings/${listing.id}/visite`)
    .set("X-CSRF-Token", extractCsrf(page.text))
    .send({ visit: { applyToSheet: true, answers: {} } })
    .expect(404);
});

test("repo listing_overrides : upsert / find / remove, une seule ligne par annonce", async (t) => {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  const user = await createUser(ctx.repositories, "repo@example.com");
  const service = createListingsService({ repositories: ctx.repositories });
  const { id } = service.save(user, listingPayload());

  const data = {
    fields: { surface: { value: 95, source: "user", origin: "visit", confirmed: false } },
    visit: { applyToSheet: true, answers: {}, startedAt: null, completedAt: null },
  };
  const saved = ctx.repositories.visitOverrides.upsert(id, data);
  assert.equal(saved.data.fields.surface.value, 95);
  assert.equal(ctx.repositories.visitOverrides.find(id).data.visit.applyToSheet, true);

  ctx.repositories.visitOverrides.upsert(id, {
    ...data,
    visit: { ...data.visit, applyToSheet: false },
  });
  assert.equal(ctx.repositories.visitOverrides.find(id).data.visit.applyToSheet, false);

  ctx.repositories.visitOverrides.remove(id);
  assert.equal(ctx.repositories.visitOverrides.find(id), null);
});

test("migration listing_overrides : table présente et migrate idempotent", (t) => {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  const row = ctx.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='listing_overrides'")
    .get();
  assert.ok(row, "la table est créée par la migration");
  assert.doesNotThrow(() => migrate(ctx.db), "rejouer migrate n'a aucun effet");
});

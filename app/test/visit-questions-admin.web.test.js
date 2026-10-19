/**
 * Mode Essentiel / Expert de la fiche de visite : classement des questions
 * dans l'administration (/admin/visite) et mode mémorisé par annonce.
 */

import test from "node:test";
import assert from "node:assert/strict";
import config from "../src/config.js";
import {
  createTestApp,
  createUser,
  extractCsrf,
  listingPayload,
  loginAgent,
} from "./helpers.js";
import createListingsService from "../src/services/listings.service.js";
import { catalogOrder } from "../src/lib/visit/visit-question-levels.js";
import { computeInsights } from "../src/lib/visit/visit-insights.js";
import { VISIT_QUESTIONS } from "../src/lib/visit/visit-questions.js";

function initialJson(html) {
  const m = html.match(/<script type="application\/json" id="visit-initial">([\s\S]*?)<\/script>/);
  assert.ok(m, "état initial présent");
  return JSON.parse(m[1]);
}

async function setup(t) {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  const email = config.adminEmails[0];
  const user = await createUser(ctx.repositories, email);
  const service = createListingsService({ repositories: ctx.repositories });
  const { id } = service.save(
    user,
    listingPayload({ title: "Appartement test", property_type: "apartment", surface: 60, price: 250000 })
  );
  const agent = await loginAgent(ctx.app, email);
  const page = await agent.get("/admin/visite").expect(200);
  return { ...ctx, user, listingId: id, agent, page, csrf: extractCsrf(page.text) };
}

test("GET /admin/visite : liste des questions par étape avec niveau et ordre", async (t) => {
  const { page } = await setup(t);
  assert.match(page.text, /Questions de visite/);
  assert.match(page.text, /data-visit-questions-admin/);
  assert.match(page.text, /name="level_sale_reason" value="essential" checked/);
  assert.match(page.text, /name="level_time_on_market" value="expert" checked/);
  assert.match(page.text, new RegExp(`name="order_avant"[^>]*value="${catalogOrder().avant.join(",")}"`));
  assert.match(page.text, /data-confirm="Revenir au classement/);
  assert.match(page.text, /data-tooltip="Maisons et appartements"><svg class="wi" aria-hidden="true"><use href="#wi-home">/);
  assert.match(page.text, /data-tooltip="Appartements, et maisons en copropriété"><svg class="wi" aria-hidden="true"><use href="#wi-building">/);
});

test("POST /admin/visite : niveau et ordre appliqués à la fiche de visite", async (t) => {
  const { agent, csrf, listingId } = await setup(t);
  const avant = catalogOrder().avant;
  const reordered = [avant[1], avant[0], ...avant.slice(2)];
  await agent
    .post("/admin/visite")
    .type("form")
    .send({
      _csrf: csrf,
      level_time_on_market: "essential",
      level_sale_reason: "expert",
      order_avant: reordered.join(","),
    })
    .expect(302)
    .expect("location", "/admin/visite");

  const admin = await agent.get("/admin/visite").expect(200);
  assert.match(admin.text, /name="level_time_on_market" value="essential" checked/);

  const visit = await agent.get(`/listings/${listingId}/visite`).expect(200);
  const initial = initialJson(visit.text);
  const byId = Object.fromEntries(initial.items.map((it) => [it.id, it]));
  assert.equal(byId.time_on_market.level, "essential");
  assert.equal(byId.time_on_market.essential, true);
  assert.equal(byId.sale_reason.level, "expert");
  const avantIds = initial.items.filter((it) => it.section === "avant").map((it) => it.id);
  assert.equal(avantIds[0], reordered[0], "ordre admin repris sur la fiche");

  // Réinitialisation : retour au catalogue.
  await agent.post("/admin/visite/reset").type("form").send({ _csrf: csrf }).expect(302);
  const back = await agent.get(`/listings/${listingId}/visite`).expect(200);
  const restored = Object.fromEntries(initialJson(back.text).items.map((it) => [it.id, it]));
  assert.equal(restored.time_on_market.level, "expert");
  assert.equal(restored.sale_reason.level, "essential");
});

test("POST /admin/visite : question déplacée dans une autre étape, reprise sur la fiche", async (t) => {
  const { agent, csrf, listingId } = await setup(t);
  const order = catalogOrder();
  const moved = VISIT_QUESTIONS.find(
    (q) => q.section !== "avant" && !q.audience && !q.photo && !q.showWhen
  );
  await agent
    .post("/admin/visite")
    .type("form")
    .send({
      _csrf: csrf,
      order_avant: [moved.id, ...order.avant].join(","),
      [`order_${moved.section}`]: order[moved.section].filter((id) => id !== moved.id).join(","),
    })
    .expect(302);

  const admin = await agent.get("/admin/visite").expect(200);
  assert.match(admin.text, new RegExp(`name="order_avant"[^>]*value="${moved.id},`));
  assert.match(admin.text, /id="vq-move-modal"/);

  const visit = await agent.get(`/listings/${listingId}/visite`).expect(200);
  const item = initialJson(visit.text).items.find((it) => it.id === moved.id);
  assert.equal(item.section, "avant");
});

test("POST /admin/visite : niveau inconnu → 400", async (t) => {
  const { agent, csrf } = await setup(t);
  await agent
    .post("/admin/visite")
    .type("form")
    .send({ _csrf: csrf, level_sale_reason: "super" })
    .expect(400);
});

test("POST /admin/visite : jeton CSRF requis", async (t) => {
  const { agent } = await setup(t);
  await agent.post("/admin/visite").type("form").send({ level_sale_reason: "expert" }).expect(403);
});

test("/admin/visite : refusé à un compte non administrateur", async (t) => {
  const { app, repositories } = await setup(t);
  await createUser(repositories, "simple@example.com");
  const other = await loginAgent(app, "simple@example.com");
  const res = await other.get("/admin/visite");
  assert.ok([302, 303, 403, 404].includes(res.status), `accès refusé (${res.status})`);
  const listings = await other.get("/listings").expect(200);
  const post = await other
    .post("/admin/visite")
    .type("form")
    .send({ _csrf: extractCsrf(listings.text), level_sale_reason: "expert" });
  assert.ok([302, 303, 403, 404].includes(post.status), `écriture refusée (${post.status})`);
});

test("visite : mode Essentiel par défaut, questions Expert masquées côté serveur", async (t) => {
  const { agent, listingId } = await setup(t);
  const res = await agent.get(`/listings/${listingId}/visite`).expect(200);
  const initial = initialJson(res.text);
  assert.equal(initial.mode, "essential");
  assert.match(res.text, /data-mode="essential"/);
  assert.match(res.text, /role="switch"[^>]*aria-checked="false"/);
  assert.match(res.text, /data-q="time_on_market"[\s\S]{0,300}?hidden/, "question Expert masquée");
  assert.doesNotMatch(res.text, /data-q="sale_reason"[^>]*hidden/, "question essentielle visible");
  assert.match(res.text, /questions? expert masquées? : les afficher/);
});

test("PUT visite : mode Expert mémorisé par annonce", async (t) => {
  const { agent, listingId, csrf } = await setup(t);
  const res = await agent
    .put(`/listings/${listingId}/visite`)
    .set("X-CSRF-Token", csrf)
    .send({ visit: { applyToSheet: false, mode: "expert", answers: {} } })
    .expect(200);
  assert.equal(res.body.mode, "expert");

  const page = await agent.get(`/listings/${listingId}/visite`).expect(200);
  const initial = initialJson(page.text);
  assert.equal(initial.mode, "expert");
  assert.doesNotMatch(page.text, /data-q="time_on_market"[^>]*hidden/);

  // Sans `mode` dans le corps : le mode enregistré est conservé.
  await agent
    .put(`/listings/${listingId}/visite`)
    .set("X-CSRF-Token", csrf)
    .send({ visit: { applyToSheet: false, answers: {} } })
    .expect(200);
  const again = await agent.get(`/listings/${listingId}/visite`).expect(200);
  assert.equal(initialJson(again.text).mode, "expert");
});

test("PUT visite : mode invalide → 422", async (t) => {
  const { agent, listingId, csrf } = await setup(t);
  await agent
    .put(`/listings/${listingId}/visite`)
    .set("X-CSRF-Token", csrf)
    .send({ visit: { applyToSheet: false, mode: "turbo", answers: {} } })
    .expect(422);
});

test("PUT visite : mode d'une annonce d'un autre compte → 404", async (t) => {
  const { app, repositories, listingId } = await setup(t);
  await createUser(repositories, "voisin@example.com");
  const other = await loginAgent(app, "voisin@example.com");
  const page = await other.get("/listings").expect(200);
  await other
    .put(`/listings/${listingId}/visite`)
    .set("X-CSRF-Token", extractCsrf(page.text))
    .send({ visit: { mode: "expert", answers: {} } })
    .expect(404);
});

test("computeInsights : en mode Essentiel, seules les questions du mode comptent", () => {
  const items = [
    { id: "a", essential: true, section: "avant", input: { type: "yesno" }, signals: [] },
    { id: "b", essential: false, section: "avant", input: { type: "yesno" }, signals: [] },
    { id: "c", essential: false, promoted: true, section: "avant", input: { type: "yesno" }, signals: [] },
    { id: "d", essential: false, section: "avant", input: { type: "yesno" }, signals: [] },
  ];
  const answers = { d: { response: "yes" } };
  const expert = computeInsights({ items, answers });
  assert.equal(expert.counts.total, 4);
  const essential = computeInsights({ items, answers, mode: "essential" });
  assert.equal(essential.counts.total, 3, "a (essentiel), c (photo) et d (déjà répondue)");
  assert.equal(essential.counts.answered, 1);
});

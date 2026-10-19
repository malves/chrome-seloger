/**
 * Éditeur des questions de visite (/admin/visite/questions/…) : création,
 * modification, archivage, restauration, rétablissement du catalogue.
 */

import test from "node:test";
import assert from "node:assert/strict";
import config from "../src/config.js";
import { createTestApp, createUser, extractCsrf, listingPayload, loginAgent } from "./helpers.js";
import createListingsService from "../src/services/listings.service.js";
import { QUESTION_BY_ID } from "../src/lib/visit/visit-questions.js";

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
  const { id } = createListingsService({ repositories: ctx.repositories }).save(
    user,
    listingPayload({ title: "Maison test", property_type: "house", surface: 90, price: 300000 })
  );
  const agent = await loginAgent(ctx.app, email);
  const page = await agent.get("/admin/visite").expect(200);
  return { ...ctx, listingId: id, agent, csrf: extractCsrf(page.text) };
}

const NEW_QUESTION = {
  question: "Le portail est-il motorisé ?",
  pro_tip: "Demandez la télécommande et testez-la.",
  section: "exterieur",
  theme: "travaux",
  audience: "house",
  level: "essential",
  input_type: "choice",
  opt_label_0: "Oui, motorisé",
  opt_label_1: "Non, manuel",
  sig_kind_0: "value",
  sig_arg_0: "non_manuel",
  sig_tone_0: "info",
  sig_text_0: "Motorisation : 1 000 à 2 000 €.",
  sig_cost_min_0: "1 000",
  sig_cost_max_0: "2 000",
  sig_lever_0: "",
};

test("GET /admin/visite : liens d'ajout et de modification, archives", async (t) => {
  const { agent } = await setup(t);
  const page = await agent.get("/admin/visite").expect(200);
  assert.match(page.text, /href="\/admin\/visite\/questions\/nouvelle"/);
  assert.match(page.text, /href="\/admin\/visite\/questions\/sale_reason"/);
  assert.match(page.text, /Questions archivées/);
});

test("création : question ajoutée, reprise sur la fiche de visite", async (t) => {
  const { agent, csrf, listingId } = await setup(t);
  const form = await agent.get("/admin/visite/questions/nouvelle").expect(200);
  assert.match(form.text, /data-question-editor/);
  assert.match(form.text, /data-option-template/);

  await agent
    .post("/admin/visite/questions")
    .type("form")
    .send({ _csrf: csrf, ...NEW_QUESTION })
    .expect(302)
    .expect("location", "/admin/visite");

  const visit = await agent.get(`/listings/${listingId}/visite`).expect(200);
  const item = initialJson(visit.text).items.find((it) => it.question === NEW_QUESTION.question);
  assert.ok(item, "question présente sur la fiche");
  assert.equal(item.section, "exterieur");
  assert.equal(item.level, "essential");
  assert.deepEqual(
    item.input.options.map((o) => o.value),
    ["oui_motorise", "non_manuel"]
  );
  assert.deepEqual(item.signals[0].cost, [1000, 2000]);
});

test("création : entrée invalide → 422 avec les erreurs, rien d'enregistré", async (t) => {
  const { agent, csrf, repositories } = await setup(t);
  const before = repositories.visitQuestions.count();
  const res = await agent
    .post("/admin/visite/questions")
    .type("form")
    .send({ _csrf: csrf, ...NEW_QUESTION, question: "", opt_label_1: "" })
    .expect(422);
  assert.match(res.text, /class="form-errors"/);
  assert.match(res.text, /La question est obligatoire/);
  assert.match(res.text, /Au moins deux options/);
  assert.equal(repositories.visitQuestions.count(), before);
});

test("modification : texte et note enregistrés, champ lié verrouillé, rétablissement", async (t) => {
  const { agent, csrf, listingId } = await setup(t);
  const page = await agent.get("/admin/visite/questions/year_built").expect(200);
  assert.match(page.text, /Réponse liée au champ/);
  assert.doesNotMatch(page.text, /id="vq-type"/, "type non modifiable");

  await agent
    .post("/admin/visite/questions/sale_reason")
    .type("form")
    .send({
      _csrf: csrf,
      question: "Pour quelle raison vendent-ils ?",
      pro_tip: QUESTION_BY_ID.sale_reason.proTip,
      section: "avant",
      theme: "negociation",
      audience: "",
      level: "essential",
      input_type: "choice",
      opt_value_0: "mutation",
      opt_label_0: "Mutation professionnelle",
      opt_value_1: "other",
      opt_label_1: "Autre",
      opt_other_1: "1",
    })
    .expect(302);

  const visit = await agent.get(`/listings/${listingId}/visite`).expect(200);
  const item = initialJson(visit.text).items.find((it) => it.id === "sale_reason");
  assert.equal(item.question, "Pour quelle raison vendent-ils ?");
  assert.deepEqual(item.input.options, [
    { value: "mutation", label: "Mutation professionnelle" },
    { value: "other", label: "Autre", other: true },
  ]);
  assert.equal(item.signals.length, 0);

  const edit = await agent.get("/admin/visite/questions/sale_reason").expect(200);
  assert.match(edit.text, /Rétablir la version du catalogue/);
  await agent
    .post("/admin/visite/questions/sale_reason/catalogue")
    .type("form")
    .send({ _csrf: csrf })
    .expect(302)
    .expect("location", "/admin/visite/questions/sale_reason");
  const back = await agent.get(`/listings/${listingId}/visite`).expect(200);
  const restored = initialJson(back.text).items.find((it) => it.id === "sale_reason");
  assert.equal(restored.question, QUESTION_BY_ID.sale_reason.question);
});

test("archivage puis restauration", async (t) => {
  const { agent, csrf, listingId } = await setup(t);
  await agent
    .post("/admin/visite/questions/diagnostics/archiver")
    .type("form")
    .send({ _csrf: csrf })
    .expect(302);
  const visit = await agent.get(`/listings/${listingId}/visite`).expect(200);
  assert.ok(!initialJson(visit.text).items.some((it) => it.id === "diagnostics"));
  const admin = await agent.get("/admin/visite").expect(200);
  assert.match(admin.text, /action="\/admin\/visite\/questions\/diagnostics\/restaurer"/);

  await agent
    .post("/admin/visite/questions/diagnostics/restaurer")
    .type("form")
    .send({ _csrf: csrf })
    .expect(302);
  const again = await agent.get(`/listings/${listingId}/visite`).expect(200);
  assert.ok(initialJson(again.text).items.some((it) => it.id === "diagnostics"));
});

test("question inconnue → 404", async (t) => {
  const { agent, csrf } = await setup(t);
  await agent.get("/admin/visite/questions/inconnue").expect(404);
  await agent.get("/admin/visite/questions/Pas%20valide").expect(404);
  await agent
    .post("/admin/visite/questions/inconnue")
    .type("form")
    .send({ _csrf: csrf, ...NEW_QUESTION })
    .expect(404);
  await agent.post("/admin/visite/questions/inconnue/archiver").type("form").send({ _csrf: csrf }).expect(404);
  await agent
    .post("/admin/visite/questions/custom_rien/catalogue")
    .type("form")
    .send({ _csrf: csrf })
    .expect(404);
});

test("jeton CSRF requis sur chaque écriture", async (t) => {
  const { agent } = await setup(t);
  await agent.post("/admin/visite/questions").type("form").send(NEW_QUESTION).expect(403);
  await agent.post("/admin/visite/questions/sale_reason").type("form").send(NEW_QUESTION).expect(403);
  await agent.post("/admin/visite/questions/sale_reason/archiver").type("form").send({}).expect(403);
  await agent.post("/admin/visite/questions/sale_reason/restaurer").type("form").send({}).expect(403);
  await agent.post("/admin/visite/questions/sale_reason/catalogue").type("form").send({}).expect(403);
});

test("refusé à un compte non administrateur", async (t) => {
  const { app, repositories } = await setup(t);
  await createUser(repositories, "simple@example.com");
  const other = await loginAgent(app, "simple@example.com");
  const res = await other.get("/admin/visite/questions/nouvelle");
  assert.ok([302, 303, 403, 404].includes(res.status), `lecture refusée (${res.status})`);
  const listings = await other.get("/listings").expect(200);
  const csrf = extractCsrf(listings.text);
  const before = repositories.visitQuestions.count();
  const post = await other.post("/admin/visite/questions").type("form").send({ _csrf: csrf, ...NEW_QUESTION });
  assert.ok([302, 303, 403, 404].includes(post.status), `création refusée (${post.status})`);
  const archive = await other.post("/admin/visite/questions/sale_reason/archiver").type("form").send({ _csrf: csrf });
  assert.ok([302, 303, 403, 404].includes(archive.status), `archivage refusé (${archive.status})`);
  assert.equal(repositories.visitQuestions.count(), before);
  assert.ok(repositories.visitQuestions.byId("sale_reason").archivedAt === null);
});

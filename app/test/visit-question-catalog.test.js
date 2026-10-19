/**
 * Catalogue des questions de visite en base : import initial, reprise du
 * classement d'app_settings, édition validée (verrous), archivage.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createUser, listingPayload } from "./helpers.js";
import { VISIT_QUESTIONS, QUESTION_BY_ID } from "../src/lib/visit/visit-questions.js";
import { contentOf, isBuiltinModified } from "../src/lib/visit/visit-question-catalog.js";
import {
  draftFromQuestion,
  normalizeQuestion,
  readQuestionForm,
} from "../src/lib/visit/visit-question-validate.js";
import createVisitQuestionsConfigService, {
  VISIT_QUESTIONS_SETTING_KEY,
} from "../src/services/visit-questions-config.service.js";
import createVisitSheetService from "../src/services/visit-sheet.service.js";
import createListingsService from "../src/services/listings.service.js";

function setup(t) {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  return { ...ctx, service: createVisitQuestionsConfigService({ repositories: ctx.repositories }) };
}

function newDraft(over = {}) {
  return {
    ...draftFromQuestion({ section: "exterieur", theme: "environnement", input: { type: "yesno" } }),
    question: "Le quartier est-il bien éclairé le soir ?",
    proTip: "Repassez à la nuit tombée.",
    ...over,
  };
}

/* ------------------------------ Import ------------------------------ */

test("import : catalogue complet, idempotent, partagé entre instances", (t) => {
  const { service, repositories } = setup(t);
  const catalog = service.getCatalog();
  assert.equal(catalog.questions.length, VISIT_QUESTIONS.length);
  assert.equal(repositories.visitQuestions.count(), VISIT_QUESTIONS.length);
  assert.equal(catalog.customized, false);
  assert.equal(catalog.levels.sale_reason, "essential");
  assert.deepEqual(contentOf(catalog.byId.year_built), contentOf(QUESTION_BY_ID.year_built));

  const other = createVisitQuestionsConfigService({ repositories });
  other.getCatalog();
  assert.equal(repositories.visitQuestions.count(), VISIT_QUESTIONS.length, "pas de doublon");

  other.update("sale_reason", { ...draftFromQuestion(catalog.byId.sale_reason), question: "Pourquoi vendre ?" });
  assert.equal(service.getCatalog().byId.sale_reason.question, "Pourquoi vendre ?", "cache commun invalidé");
});

test("import : reprend niveaux, ordre et étape réglés dans app_settings", (t) => {
  const { service, repositories } = setup(t);
  const avant = VISIT_QUESTIONS.filter((q) => q.section === "avant").map((q) => q.id);
  repositories.appSettings.set(VISIT_QUESTIONS_SETTING_KEY, {
    levels: { time_on_market: "essential", sale_reason: "expert" },
    order: { avant: ["quiet", avant[1], avant[0], ...avant.slice(2)] },
  });
  const catalog = service.getCatalog();
  assert.equal(catalog.levels.time_on_market, "essential");
  assert.equal(catalog.levels.sale_reason, "expert");
  assert.equal(catalog.order.avant[0], "quiet");
  assert.equal(catalog.order.avant[1], avant[1]);
  assert.equal(catalog.byId.quiet.section, "avant");
  assert.equal(catalog.customized, true);
});

test("import : question ajoutée au code depuis → insérée sans écraser les lignes modifiées", (t) => {
  const { service, repositories } = setup(t);
  repositories.visitQuestions.insert({
    id: "sale_reason",
    section: "ressenti",
    position: 0,
    essential: false,
    builtin: true,
    data: { ...contentOf(QUESTION_BY_ID.sale_reason), question: "Texte modifié" },
  });
  const catalog = service.getCatalog();
  assert.equal(catalog.questions.length, VISIT_QUESTIONS.length);
  assert.equal(catalog.byId.sale_reason.question, "Texte modifié");
  assert.equal(catalog.byId.sale_reason.section, "ressenti");
  assert.ok(catalog.byId.ev_charging, "question manquante importée");
});

/* ---------------------------- Validation ---------------------------- */

test("formulaire à plat → brouillon : lignes triées par index, lignes vides ignorées", () => {
  const draft = readQuestionForm({
    question: "Q ?",
    input_type: "choice",
    opt_label_1: "B",
    opt_value_1: "",
    opt_label_0: "A",
    opt_value_0: "a",
    opt_other_0: "1",
    opt_label_2: "  ",
    sig_kind_0: "value",
    sig_arg_0: "a",
    sig_tone_0: "ok",
    sig_text_0: "Bien",
  });
  assert.deepEqual(draft.options, [
    { value: "a", label: "A", other: true },
    { value: "", label: "B", other: false },
  ]);
  assert.equal(draft.signals.length, 1);
  assert.equal(draft.signals[0].kind, "value");
});

test("validation : champs obligatoires, étape, thème et type inconnus", () => {
  const res = normalizeQuestion({ ...newDraft(), question: "", proTip: "", section: "x", theme: "y", inputType: "z" });
  assert.equal(res.ok, false);
  for (const key of ["question", "proTip", "section", "theme", "inputType"]) assert.ok(res.errors[key], key);
});

test("validation : options d'un choix (≥ 2, libellés) et valeurs générées", () => {
  const one = normalizeQuestion(newDraft({ inputType: "choice", options: [{ value: "", label: "Seule", other: false }] }));
  assert.equal(one.ok, false);
  assert.match(one.errors.options, /deux options/);
  const ok = normalizeQuestion(
    newDraft({
      inputType: "choice",
      options: [
        { value: "", label: "Très éclairé", other: false },
        { value: "", label: "Très éclairé", other: false },
        { value: "", label: "Autre", other: true },
      ],
    })
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(
    ok.data.input.options.map((o) => o.value),
    ["tres_eclaire", "tres_eclaire_2", "autre"]
  );
  assert.equal(ok.data.input.options[2].other, true);
});

test("validation : notes au bilan (condition, tonalité, coût, levier)", () => {
  const sig = (over) => ({ kind: "no", arg: "", tone: "warn", text: "Note", costMin: "", costMax: "", lever: "", ...over });
  const bad = [
    sig({ kind: "nope" }),
    sig({ kind: "gte", arg: "abc" }),
    sig({ tone: "rouge" }),
    sig({ text: "", arg: "x" }),
    sig({ costMin: "5000", costMax: "1000" }),
    sig({ lever: "5" }),
  ];
  for (const s of bad) {
    const res = normalizeQuestion(newDraft({ signals: [s] }));
    assert.equal(res.ok, false, JSON.stringify(s));
    assert.ok(res.errors.signals);
  }
  const ok = normalizeQuestion(
    newDraft({ signals: [sig({ kind: "no", costMin: "1 000", costMax: "2 500,4", lever: "2" })] })
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.data.signals, [{ when: "no", tone: "warn", text: "Note", cost: [1000, 2500], lever: 2 }]);

  const unknownOpt = normalizeQuestion(
    newDraft({
      inputType: "choice",
      options: [
        { value: "", label: "A", other: false },
        { value: "", label: "B", other: false },
      ],
      signals: [sig({ kind: "value", arg: "c" })],
    })
  );
  assert.equal(unknownOpt.ok, false);
  assert.match(unknownOpt.errors.signals, /option inconnue/);
});

test("verrous : champ lié, photo, condition d'affichage et valeurs d'options conservés", () => {
  const year = QUESTION_BY_ID.year_built;
  const res = normalizeQuestion({ ...draftFromQuestion(year), inputType: "text" }, year);
  assert.equal(res.ok, true);
  assert.equal(res.data.input.type, "confirm_number", "type figé pour un champ lié");
  assert.equal(res.data.field, "year_built");
  assert.deepEqual(res.data.input.validate, year.input.validate, "réglages avancés conservés");

  const photoQ = QUESTION_BY_ID.photo_claims;
  const draft = draftFromQuestion(photoQ);
  draft.options = [
    { value: "confirmed", label: "Écart vérifié", other: false },
    { value: "pirate", label: "Nouvelle", other: false },
  ];
  const out = normalizeQuestion(draft, photoQ);
  assert.equal(out.ok, true);
  assert.deepEqual(out.data.photo, photoQ.photo);
  assert.deepEqual(
    out.data.input.options.map((o) => o.value),
    ["confirmed", "nouvelle"],
    "valeur existante gardée, valeur inventée remplacée"
  );
  assert.equal(out.data.input.options[0].label, "Écart vérifié");

  const cond = VISIT_QUESTIONS.find((q) => q.showWhen);
  const kept = normalizeQuestion(draftFromQuestion(cond), cond);
  assert.equal(kept.ok, true);
  assert.deepEqual(kept.data.showWhen, cond.showWhen);
});

test("aller-retour : une question du catalogue enregistrée sans changement reste identique", () => {
  for (const q of VISIT_QUESTIONS) {
    const res = normalizeQuestion(draftFromQuestion(q), q);
    assert.equal(res.ok, true, `${q.id} : ${JSON.stringify(res.errors)}`);
    assert.deepEqual(res.data, contentOf(q), q.id);
    assert.equal(isBuiltinModified({ ...res.data, id: q.id, builtin: true }), false, `${q.id} non marquée modifiée`);
  }
});

/* ------------------------- Service : édition ------------------------ */

test("service : création, modification, rétablissement du catalogue", (t) => {
  const { service } = setup(t);
  const created = service.create(newDraft({ level: "essential" }));
  assert.equal(created.ok, true);
  const id = created.question.id;
  assert.match(id, /^custom_le_quartier/);
  const catalog = service.getCatalog();
  assert.equal(catalog.order.exterieur.at(-1), id, "ajoutée en fin d'étape");
  assert.equal(catalog.levels[id], "essential");
  assert.equal(service.create(newDraft()).question.id, `${id}_2`, "id unique");

  const invalid = service.update(id, newDraft({ question: "" }));
  assert.equal(invalid.ok, false);
  assert.equal(service.update("inconnue", newDraft()), null);

  const moved = service.update("sale_reason", {
    ...draftFromQuestion(catalog.byId.sale_reason),
    question: "Raison de la vente ?",
    section: "ressenti",
  });
  assert.equal(moved.ok, true);
  assert.equal(service.getCatalog().order.ressenti.at(-1), "sale_reason");

  assert.equal(service.resetToBuiltin("sale_reason"), true);
  assert.equal(service.getCatalog().byId.sale_reason.question, QUESTION_BY_ID.sale_reason.question);
  assert.equal(service.resetToBuiltin(id), false, "question créée : rien à rétablir");
});

test("service : archivage réversible, réponses déjà saisies conservées", async (t) => {
  const { service, repositories } = setup(t);
  const user = await createUser(repositories, "visite@example.com");
  const { id: listingId } = createListingsService({ repositories }).save(user, listingPayload());
  const listing = repositories.listings.findById(user.id, listingId);
  const sheet = createVisitSheetService({ repositories, visitQuestions: service });
  const answers = { diagnostics: { response: "no", value: null } };
  sheet.saveSheet(listing, { visit: { applyToSheet: false, answers } });

  assert.equal(service.archive("diagnostics"), true);
  const catalog = service.getCatalog();
  assert.equal(catalog.byId.diagnostics, undefined);
  assert.ok(catalog.archived.some((q) => q.id === "diagnostics"));

  const saved = sheet.saveSheet(listing, { visit: { applyToSheet: false, answers } });
  assert.equal(saved.visit.answers.diagnostics.response, "no", "réponse conservée");

  assert.equal(service.restore("diagnostics"), true);
  assert.equal(service.getCatalog().order.avant.at(-1), "diagnostics", "restaurée en fin d'étape");
  assert.equal(service.restore("diagnostics"), false);
});

test("service : classement du formulaire puis retour au catalogue", (t) => {
  const { service } = setup(t);
  const created = service.create(newDraft()).question;
  const avant = service.getCatalog().order.avant;
  service.saveLevelsAndOrder({
    level: { time_on_market: "essential", bogus: "expert" },
    order: { avant: [avant[1], avant[0], "bogus", ...avant.slice(2)].join(",") },
  });
  let catalog = service.getCatalog();
  assert.equal(catalog.order.avant[0], avant[1]);
  assert.equal(catalog.levels.time_on_market, "essential");
  assert.equal(catalog.customized, true);
  assert.ok(catalog.byId[created.id], "question créée non perdue");

  service.reset();
  catalog = service.getCatalog();
  assert.equal(catalog.customized, false);
  assert.equal(catalog.levels.time_on_market, "expert");
  assert.equal(catalog.order.exterieur.at(-1), created.id, "question créée gardée à la suite");
});

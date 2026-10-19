/**
 * Niveaux (Essentiel / Expert) et ordre des questions de visite : fusion des
 * surcharges admin avec le catalogue, et nettoyage du formulaire.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  catalogOrder,
  normalizeVisitMode,
  resolveQuestionLevels,
  sanitizeQuestionLevelsForm,
} from "../src/lib/visit/visit-question-levels.js";
import { VISIT_QUESTIONS } from "../src/lib/visit/visit-questions.js";

test("sans surcharge : niveaux et ordre du catalogue", () => {
  const { levels, order, customized } = resolveQuestionLevels(null);
  assert.equal(customized, false);
  assert.equal(levels.sale_reason, "essential");
  assert.equal(levels.time_on_market, "expert");
  assert.equal(
    Object.values(levels).filter((l) => l === "essential").length,
    VISIT_QUESTIONS.filter((q) => q.essential).length
  );
  assert.deepEqual(order, catalogOrder());
});

test("surcharge : niveau modifié, id et niveau inconnus ignorés", () => {
  const { levels, customized } = resolveQuestionLevels({
    levels: { time_on_market: "essential", sale_reason: "expert", bogus: "essential", quiet: "nimporte" },
  });
  assert.equal(customized, true);
  assert.equal(levels.time_on_market, "essential");
  assert.equal(levels.sale_reason, "expert");
  assert.equal(levels.quiet, "essential", "niveau invalide → catalogue");
  assert.equal(levels.bogus, undefined);
});

test("ordre stocké partiel : questions absentes ajoutées en fin d'étape, intrus ignorés", () => {
  const defaults = catalogOrder().avant;
  const { order } = resolveQuestionLevels({
    order: { avant: ["diagnostics", "bogus", "diagnostics", "sale_reason"] },
  });
  assert.equal(order.avant[0], "diagnostics");
  assert.equal(order.avant[1], "sale_reason");
  assert.equal(order.avant.length, defaults.length);
  assert.deepEqual([...order.avant].sort(), [...defaults].sort());
});

test("question rangée dans une autre étape : elle y reste et quitte son étape du catalogue", () => {
  const defaults = catalogOrder();
  const sectionOfQuiet = Object.keys(defaults).find((id) => defaults[id].includes("quiet"));
  assert.notEqual(sectionOfQuiet, "avant");
  const { order, sections, customized } = resolveQuestionLevels({
    order: { avant: ["quiet", ...defaults.avant] },
  });
  assert.equal(customized, true);
  assert.equal(order.avant[0], "quiet");
  assert.equal(sections.quiet, "avant");
  assert.ok(!order[sectionOfQuiet].includes("quiet"));
  const total = Object.values(order).reduce((n, ids) => n + ids.length, 0);
  assert.equal(total, VISIT_QUESTIONS.length, "aucune question perdue ni dupliquée");
});

test("formulaire : un déplacement entre étapes conserve les deux étapes", () => {
  const defaults = catalogOrder();
  const sectionOfQuiet = Object.keys(defaults).find((id) => defaults[id].includes("quiet"));
  const out = sanitizeQuestionLevelsForm({
    order: {
      avant: ["quiet", ...defaults.avant].join(","),
      [sectionOfQuiet]: defaults[sectionOfQuiet].filter((id) => id !== "quiet").join(","),
    },
  });
  assert.equal(out.order.avant[0], "quiet");
  assert.ok(!out.order[sectionOfQuiet].includes("quiet"));
  const { sections } = resolveQuestionLevels(out);
  assert.equal(sections.quiet, "avant");
});

test("formulaire : ne garde que les écarts au catalogue", () => {
  const defaults = catalogOrder();
  const out = sanitizeQuestionLevelsForm({
    level: { sale_reason: "essential", time_on_market: "essential", bogus: "expert" },
    order: { avant: defaults.avant.join(","), exterieur: [...defaults.exterieur].reverse().join(",") },
  });
  assert.deepEqual(out.levels, { time_on_market: "essential" });
  assert.equal(out.order.avant, undefined, "ordre identique au catalogue non stocké");
  assert.deepEqual(out.order.exterieur, [...defaults.exterieur].reverse());
});

test("mode : repli sur Essentiel", () => {
  assert.equal(normalizeVisitMode("expert"), "expert");
  assert.equal(normalizeVisitMode("essential"), "essential");
  assert.equal(normalizeVisitMode("autre"), "essential");
  assert.equal(normalizeVisitMode(undefined), "essential");
});

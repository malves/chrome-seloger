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
    order: { avant: ["diagnostics", "quiet", "bogus", "diagnostics", "sale_reason"] },
  });
  assert.equal(order.avant[0], "diagnostics");
  assert.equal(order.avant[1], "sale_reason");
  assert.ok(!order.avant.includes("quiet"), "question d'une autre étape ignorée");
  assert.equal(order.avant.length, defaults.length);
  assert.deepEqual([...order.avant].sort(), [...defaults].sort());
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

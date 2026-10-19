import test from "node:test";
import assert from "node:assert/strict";
import { dvfPublicationNotice, dvfPeriodLabel } from "../src/lib/dvf-publication.js";

test("dvfPeriodLabel signale une année dont seul le premier semestre est publié", () => {
  const october2026 = new Date(2026, 9, 18);
  assert.equal(dvfPeriodLabel(2026, october2026), "2026 (S1)");
  assert.equal(dvfPeriodLabel(2025, october2026), "2025");
  const february2027 = new Date(2027, 1, 1);
  assert.equal(dvfPeriodLabel(2026, february2027), "2026 (S1)");
  const june2027 = new Date(2027, 5, 1);
  assert.equal(dvfPeriodLabel(2026, june2027), "2026");
});

test("dvfPublicationNotice décrit le calendrier semestriel sans dates dynamiques", () => {
  const text = dvfPublicationNotice();
  assert.match(text, /deux fois par an/);
  assert.match(text, /fin avril/);
  assert.match(text, /fin octobre/);
  assert.doesNotMatch(text, /Dernière livraison/);
  assert.doesNotMatch(text, /Prochaine publication/);
});

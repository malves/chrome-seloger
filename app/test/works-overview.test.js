/**
 * Récapitulatif « Maison / Appartement » de la modale « Pièces et état » et
 * barème provisoire du chiffrage.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildWorksOverview } from "../src/lib/works/works-overview.js";
import { COST_POSTS, ENERGY_COSTS, costsOptions, validateEstimateBarème } from "../src/lib/works/works-costs.js";
import { ROOM_ISSUE_KEYS, plannerOptions } from "../src/lib/works/works-plan.js";
import { ZONE_IDS } from "../src/lib/dpe-insights.js";

function stored(extra = {}) {
  return {
    ready: true,
    status: "ok",
    summary: "Appartement lumineux, cuisine datée.",
    overall_condition: { score: 58.4, label: "average" },
    renovation: { level: "moderate_renovation", cosmetic_only_suspected: true, note: null },
    strengths: [{ label: "Parquet ancien", confidence: 0.8 }, { label: "  " }],
    visit_questions: ["Date du ravalement ?", ""],
    description_contradictions: [
      { claim: "appartement entièrement rénové", status: "contradicted", reason: "cuisine d'origine" },
      { claim: "très lumineux", status: "supported", reason: "" },
      { claim: "parquet refait", status: "partially_supported", reason: "parquet usé dans la chambre" },
    ],
    possible_photo_inconsistency: { status: true, note: null },
    structured_data_notes: ["Une chambre de plus est visible."],
    rooms: [{ room_id: "room_01", windows: { apparent_age: "very_dated", confidence: 0.9 } }],
    ...extra,
  };
}

function dpe({ letter = "F", windows = "good", expired = false } = {}) {
  return {
    isExpired: expired,
    validUntil: "01/01/2025",
    dateEtablissement: "01/01/2015",
    hero: { dpe: { letter, tone: "poor" }, ges: { letter: "E" }, verdict: "Très forte consommation", budget: { annualLabel: "2 400 €", monthlyLabel: "200 €" } },
    zones: [
      { id: "windows", label: "Fenêtres", state: windows, title: "Double vitrage" },
      { id: "walls", label: "Murs", state: "poor", title: "Murs non isolés" },
    ],
    counts: { good: 1, average: 0, poor: 1, unknown: 0 },
  };
}

const LISTING = { property_type: "apartment", surface: 62, rooms: 3, bedrooms: 2, description: "Bel appartement rénové", dpe: "E" };

test("récapitulatif : sans analyse ni DPE, seul le type de bien est renseigné", () => {
  const o = buildWorksOverview({ property_type: "house" }, { ready: false, status: "pending" }, null);
  assert.equal(o.propertyType, "house");
  assert.equal(o.propertyLabel, "Maison");
  assert.equal(o.analysisReady, false);
  assert.equal(o.condition, null);
  assert.equal(o.dpe, null);
  assert.deepEqual(o.alerts, []);
  assert.equal(buildWorksOverview({ property_type: "land" }, null).propertyLabel, "Logement");
});

test("récapitulatif : état IA et rénovation", () => {
  const o = buildWorksOverview(LISTING, stored(), null);
  assert.equal(o.propertyLabel, "Appartement");
  assert.equal(o.condition.score, 58);
  assert.equal(o.condition.tone, "average");
  assert.equal(o.renovation.tone, "average");
  assert.equal(o.renovation.cosmeticOnly, true);
  assert.equal(o.strengths, undefined);
  assert.equal(o.visitQuestions, undefined);
});

test("récapitulatif : contradictions de la description, photos et données, contredit d'abord", () => {
  const o = buildWorksOverview(LISTING, stored(), null);
  const titles = o.alerts.map((a) => a.title);
  assert.ok(titles.includes("« appartement entièrement rénové »"));
  assert.ok(titles.includes("« parquet refait »"));
  assert.ok(!titles.includes("« très lumineux »"), "une affirmation confirmée n'est pas une alerte");
  assert.ok(titles.includes("Photos difficilement compatibles"));
  assert.ok(o.alerts.some((a) => a.source === "data"));
  assert.equal(o.alerts[0].tone, "poor");
});

test("récapitulatif : DPE lié, incohérences d'étiquette, de rénovation et de fenêtres", () => {
  const o = buildWorksOverview(LISTING, stored(), dpe({ expired: true }));
  assert.equal(o.dpe.letter, "F");
  assert.deepEqual(o.dpe.zones.map((z) => z.id), ["windows", "walls"]);
  const titles = o.alerts.map((a) => a.title);
  assert.ok(titles.includes("DPE expiré"));
  assert.ok(titles.includes("Annonce « rénovée » mais DPE F"));
  assert.ok(titles.includes("Étiquette différente de l'annonce"));
  // Le croisement fenêtres × DPE part du plan (works-coherence.js) : la vue n'en fournit que les signaux photo.
  assert.ok(!titles.some((t) => /Fenêtres/.test(t)));
  assert.ok(o.photoSignals.windowsAge);
});

test("récapitulatif : pas d'alerte de rénovation pour un bon DPE", () => {
  const o = buildWorksOverview({ ...LISTING, dpe: "C" }, null, dpe({ letter: "C" }));
  assert.ok(!o.alerts.some((a) => /rénovée/.test(a.title)));
  assert.ok(!o.alerts.some((a) => /Étiquette différente/.test(a.title)));
});

test("barème : chaque point à signaler a une intensité sur un poste connu", () => {
  assert.equal(validateEstimateBarème(ROOM_ISSUE_KEYS).ok, true);
  const opts = costsOptions();
  const posts = new Set(COST_POSTS.map((p) => p.key));
  for (const key of ROOM_ISSUE_KEYS) {
    const intensity = opts.issueIntensity[key];
    assert.ok(intensity, `point sans intensité : ${key}`);
    assert.ok(posts.has(intensity.post), `poste inconnu pour ${key}`);
    assert.ok(intensity.min > 0 && intensity.max >= intensity.min, `intensité invalide pour ${key}`);
  }
  for (const id of Object.keys(ENERGY_COSTS)) assert.ok(ZONE_IDS.includes(id), `zone DPE inconnue : ${id}`);
  assert.deepEqual(plannerOptions().costs, costsOptions());
});

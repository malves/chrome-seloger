/**
 * Provenance des champs et fiche de visite (unités, sans serveur) :
 * résolveur de source, extracteur de la description, catalogue de questions
 * et construction de la view-model.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveField,
  resolveAll,
  FIELD_KEYS,
  SOURCE_SHORT,
} from "../src/lib/listing-field-provenance.js";
import { extractDescriptionFacts } from "../src/lib/listing-description-facts.js";
import {
  VISIT_QUESTIONS,
  VISIT_SECTION_BY_ID,
  VISIT_THEME_BY_ID,
  QUESTION_BY_ID,
  fieldsFromAnswers,
  questionApplies,
} from "../src/lib/visit/visit-questions.js";
import { buildVisitSheet } from "../src/lib/visit/visit-sheet-view.js";
import {
  computeInsights,
  matchesWhen,
  noteFor,
  isAnswered,
  questionVisible,
  triggeredSignals,
} from "../src/lib/visit/visit-insights.js";
import { FIELD_DEFS } from "../src/lib/listing-field-provenance.js";

const daysAgoIso = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

/* --------------------------- Résolveur de source --------------------------- */

test("résolveur : donnée structurée de l'annonce quand rien d'autre", () => {
  const r = resolveField("surface", { listing: { surface: 120 } });
  assert.equal(r.value, 120);
  assert.equal(r.source, "structured");
  assert.equal(r.known, true);
  assert.equal(r.previous, null);
  assert.equal(r.confirmed, false);
});

test("résolveur : correction utilisateur prioritaire, ancienne valeur conservée", () => {
  const r = resolveField("surface", {
    listing: { surface: 120 },
    overrides: { surface: { value: 95, source: "user", origin: "visit", confirmed: false } },
  });
  assert.equal(r.value, 95);
  assert.equal(r.source, "user");
  assert.equal(r.origin, "visit");
  assert.ok(r.previous, "une correction qui diffère expose l'ancienne valeur");
  assert.equal(r.previous.value, 120);
  assert.equal(r.previous.source, "structured");
});

test("résolveur : valeur confirmée (identique) n'affiche pas d'ancienne valeur", () => {
  const r = resolveField("surface", {
    listing: { surface: 120 },
    overrides: { surface: { value: 120, source: "user", origin: "visit", confirmed: true } },
  });
  assert.equal(r.value, 120);
  assert.equal(r.source, "user");
  assert.equal(r.confirmed, true);
  assert.equal(r.previous, null);
});

test("résolveur : champ sans donnée structurée reste à découvrir", () => {
  const r = resolveField("charges_copro", { listing: {} });
  assert.equal(r.known, false);
  assert.equal(r.value, null);
  assert.equal(r.source, null);
});

test("résolveur : extrait de la description sert de valeur par défaut", () => {
  const r = resolveField("charges_copro", { descriptionFacts: { charges_copro: 1800 } });
  assert.equal(r.value, 1800);
  assert.equal(r.source, "description");
  assert.equal(r.known, true);
});

test("résolveur : l'utilisateur l'emporte sur l'extrait de la description", () => {
  const r = resolveField("charges_copro", {
    descriptionFacts: { charges_copro: 1800 },
    overrides: { charges_copro: { value: 1500, source: "user", origin: "listing" } },
  });
  assert.equal(r.value, 1500);
  assert.equal(r.source, "user");
  assert.equal(r.origin, "listing");
  assert.equal(r.previous.value, 1800);
  assert.equal(r.previous.source, "description");
});

test("résolveur : resolveAll couvre tous les champs, sous-ensemble possible", () => {
  const all = resolveAll({ listing: { surface: 100, rooms: 4 } });
  assert.deepEqual(Object.keys(all).sort(), [...FIELD_KEYS].sort());
  const some = resolveAll({ listing: { surface: 100 } }, ["surface"]);
  assert.deepEqual(Object.keys(some), ["surface"]);
  assert.equal(SOURCE_SHORT.user, "Vous");
});

/* --------------------------- Extraction description --------------------------- */

test("description : charges de copropriété annuelles extraites", () => {
  const f = extractDescriptionFacts("Charges de copropriété : 1 800 €/an. Syndic bénévole.");
  assert.equal(f.charges_copro, 1800);
  assert.equal(f.is_copro, true);
});

test("description : charges mensuelles annualisées", () => {
  const f = extractDescriptionFacts("Charges courantes de 150 €/mois, eau comprise.");
  assert.equal(f.charges_copro, 1800);
});

test("description : taxe foncière extraite", () => {
  const f = extractDescriptionFacts("Taxe foncière : 1 200 €. Chauffage individuel gaz.");
  assert.equal(f.taxe_fonciere, 1200);
});

test("description : prudent, rien d'extrait sans montant", () => {
  const f = extractDescriptionFacts("Bel appartement lumineux, proche commerces.");
  assert.equal(f.charges_copro, null);
  assert.equal(f.taxe_fonciere, null);
  assert.equal(f.is_copro, false);
});

test("description : copropriété détectée au mot, sans montant", () => {
  const f = extractDescriptionFacts("Appartement en copropriété de standing.");
  assert.equal(f.is_copro, true);
  assert.equal(f.charges_copro, null);
});

/* --------------------------- Catalogue & réponses --------------------------- */

const INPUT_TYPES = new Set([
  "yesno",
  "yesno_number",
  "number",
  "confirm_number",
  "confirm_yesno",
  "confirm_letter",
  "choice",
  "count_pair",
  "scale",
  "text",
]);
const TONES = new Set(["ok", "info", "warn", "danger"]);
const WHEN_RE =
  /^(yes|no|unknown|answered|corrected|value:[^,]+(,[^,]+)*|gte:-?\d+(\.\d+)?|lte:-?\d+(\.\d+)?|below_pct:\d+|count_gte:[a-z_]+:\d+)$/;

test("catalogue : riche, cohérent (étape, thème, conseil, type, signaux valides)", () => {
  const ids = VISIT_QUESTIONS.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length, "pas de doublon d'identifiant");
  assert.ok(VISIT_QUESTIONS.length >= 55, `catalogue étoffé (${VISIT_QUESTIONS.length} questions)`);
  for (const q of VISIT_QUESTIONS) {
    assert.ok(VISIT_SECTION_BY_ID[q.section], `étape inconnue pour ${q.id}`);
    assert.ok(VISIT_THEME_BY_ID[q.theme], `thème inconnu pour ${q.id}`);
    assert.ok(q.proTip, `conseil du pro manquant pour ${q.id}`);
    assert.ok(INPUT_TYPES.has(q.input && q.input.type), `type d'input invalide pour ${q.id}`);
    if (q.field) assert.ok(FIELD_DEFS[q.field], `champ canonique inconnu pour ${q.id}`);
    if (q.input.type === "choice") assert.ok(q.input.options.length >= 2, `options manquantes ${q.id}`);
    for (const s of q.signals || []) {
      assert.match(s.when, WHEN_RE, `condition invalide « ${s.when} » sur ${q.id}`);
      assert.ok(TONES.has(s.tone), `tonalité invalide sur ${q.id}`);
      assert.ok(s.text, `texte de signal manquant sur ${q.id}`);
      if (s.cost) assert.ok(s.cost.length === 2 && s.cost[0] <= s.cost[1], `coût invalide ${q.id}`);
    }
    if (q.showWhen) {
      assert.ok(QUESTION_BY_ID[q.showWhen.questionId], `showWhen parent inconnu pour ${q.id}`);
      assert.ok(Array.isArray(q.showWhen.values) && q.showWhen.values.length, `showWhen.values vide pour ${q.id}`);
    }
    if (q.photo) {
      assert.ok(Array.isArray(q.photo.facts) && q.photo.facts.length, `photo.facts vide pour ${q.id}`);
      for (const key of q.photo.facts) {
        assert.match(key, /^(anomaly|kitchen|bathroom|glazing|claim):[a-z_]+$/, `fait photo invalide « ${key} » sur ${q.id}`);
      }
      if (q.photo.required) assert.match(q.id, /^photo_/, `question déclenchée sans préfixe photo_ : ${q.id}`);
    } else {
      assert.doesNotMatch(q.id, /^photo_/, `${q.id} devrait porter photo.required`);
    }
  }
  // Chaque étape a au moins une question, et des essentielles existent.
  for (const sid of Object.keys(VISIT_SECTION_BY_ID)) {
    assert.ok(VISIT_QUESTIONS.some((q) => q.section === sid), `étape vide : ${sid}`);
  }
  assert.ok(VISIT_QUESTIONS.filter((q) => q.essential).length >= 10, "assez d'essentielles");
  // Les questions demandées explicitement doivent exister.
  assert.ok(QUESTION_BY_ID.sale_reason, "« pourquoi vendent-ils » présent");
  assert.ok(QUESTION_BY_ID.negotiation_room, "« le prix est-il négociable » présent");
  assert.ok(QUESTION_BY_ID.time_on_market, "« en vente depuis longtemps » présent");
});

test("catalogue : audience copro / maison filtrée selon le bien", () => {
  const copro = QUESTION_BY_ID.charges_copro;
  const house = QUESTION_BY_ID.roof;
  assert.equal(questionApplies(copro, { propertyType: "apartment" }), true);
  assert.equal(questionApplies(copro, { propertyType: "house" }), false);
  assert.equal(questionApplies(copro, { propertyType: "house", isCopro: true }), true);
  assert.equal(questionApplies(house, { propertyType: "house" }), true);
  assert.equal(questionApplies(house, { propertyType: "apartment" }), false);
  assert.equal(questionApplies(QUESTION_BY_ID.surface, { propertyType: "house" }), true);

  const servitudes = QUESTION_BY_ID.servitudes;
  const litiges = QUESTION_BY_ID.litiges;
  assert.equal(questionApplies(servitudes, { propertyType: "house" }), true);
  assert.equal(questionApplies(servitudes, { propertyType: "apartment" }), false);
  assert.equal(questionApplies(litiges, { propertyType: "apartment" }), true);
  assert.equal(questionApplies(litiges, { propertyType: "house" }), false);
});

test("réponses → corrections : un choix lié à un champ stocke son libellé", () => {
  const fields = fieldsFromAnswers({ heating_type: { response: null, value: "fioul" } });
  assert.equal(fields.heating_system.value, "Fioul");
});

/* --------------------------- Moteur de bilan --------------------------- */

const item = (over) => ({
  id: "x",
  question: "Q ?",
  theme: "travaux",
  section: "interieur",
  essential: false,
  known: false,
  value: null,
  field: null,
  unit: null,
  input: { type: "yesno" },
  signals: [],
  ...over,
});

test("bilan : conditions des signaux (yes/no, valeurs, corrections, écart en %)", () => {
  const yn = item();
  assert.equal(matchesWhen("yes", yn, { response: "yes" }), true);
  assert.equal(matchesWhen("no", yn, { response: "yes" }), false);
  assert.equal(matchesWhen("unknown", yn, { response: "unknown" }), true);

  const surf = item({ field: "surface", known: true, value: 120, unit: "m²", input: { type: "confirm_number" } });
  assert.equal(matchesWhen("corrected", surf, { response: "yes", value: 120 }), false);
  assert.equal(matchesWhen("corrected", surf, { response: "no", value: 112 }), true);
  assert.equal(matchesWhen("below_pct:5", surf, { response: "no", value: 115 }), false, "4 % d'écart");
  assert.equal(matchesWhen("below_pct:5", surf, { response: "no", value: 112 }), true, "6,7 % d'écart");
  assert.equal(matchesWhen("gte:100", surf, { response: "yes", value: null }), true, "valeur confirmée = connue");

  const dpe = item({ field: "dpe", known: true, value: "d", input: { type: "confirm_letter" } });
  assert.equal(matchesWhen("value:F,G", dpe, { response: "no", value: "G" }), true);
  assert.equal(matchesWhen("value:F,G", dpe, { response: "yes", value: null }), false);

  const months = item({ input: { type: "number" } });
  assert.equal(matchesWhen("gte:3", months, { response: null, value: 4 }), true);
  assert.equal(matchesWhen("lte:2", months, { response: null, value: 4 }), false);
  assert.equal(isAnswered(surf, { response: "no", value: null }), false, "« à corriger » sans valeur n'est pas répondu");
  assert.equal(isAnswered(yn, { response: "no", value: null }), true);

  const nego = item({ input: { type: "yesno_number" } });
  assert.equal(isAnswered(nego, { response: "no" }), true);
  assert.equal(isAnswered(nego, { response: "yes", value: null }), false);
  assert.equal(isAnswered(nego, { response: "yes", value: 12000 }), true);
});

test("catalogue : validate année de construction (1900 … année en cours)", () => {
  const y = QUESTION_BY_ID.year_built;
  assert.ok(y.input.validate);
  assert.equal(y.input.validate.min, 1900);
  assert.equal(y.input.validate.max, "currentYear");
});

test("catalogue : marge négociable — inférieure au prix affiché", () => {
  const nego = QUESTION_BY_ID.negotiation_room;
  assert.ok(nego.input.validate);
  assert.equal(nego.input.validate.maxExclusive, "listingPrice");
});

test("catalogue : pièces — confirm_yesno avec unité d'affichage", () => {
  const rooms = QUESTION_BY_ID.rooms;
  assert.equal(rooms.input.type, "confirm_yesno");
  assert.equal(rooms.input.unit, "pièces");
});

test("catalogue : chambres — confirm_yesno avec unité d'affichage", () => {
  const bedrooms = QUESTION_BY_ID.bedrooms;
  assert.equal(bedrooms.input.type, "confirm_yesno");
  assert.equal(bedrooms.input.unit, "chambres");
});

test("bilan : salles de bain — compteurs refaire / rafraîchir", () => {
  const q = QUESTION_BY_ID.bathroom;
  assert.equal(
    isAnswered(q, { response: null, value: { full: 0, refresh: 0 } }),
    true,
  );
  assert.equal(isAnswered(q, { response: null, value: { full: 1 } }), false);
  const sigs = triggeredSignals(q, { response: null, value: { full: 2, refresh: 1 } });
  assert.ok(sigs.some((s) => s.when === "count_gte:full:1"));
  assert.ok(sigs.some((s) => s.when === "count_gte:refresh:1"));
  const ins = computeInsights({
    items: [q],
    answers: { bathroom: { response: null, value: { full: 2, refresh: 0 } } },
  });
  assert.equal(ins.works.min, 8000);
  assert.equal(ins.works.max, 24000);
});

test("visibilité : ventilation si présence oui (ancienneté + fonctionnement)", () => {
  const presenceYes = { vmc_presence: { response: "yes", value: null } };
  assert.equal(questionVisible(QUESTION_BY_ID.ventilation, presenceYes), true);
  assert.equal(questionVisible(QUESTION_BY_ID.vmc_age, presenceYes), true);
  assert.equal(questionVisible(QUESTION_BY_ID.ventilation, { vmc_presence: { response: "no" } }), false);
  assert.equal(questionVisible(QUESTION_BY_ID.vmc_age, { vmc_presence: { response: "unknown" } }), false);
});

test("visibilité : ECS ballon seulement si production ballon ou thermodynamique", () => {
  const ballon = QUESTION_BY_ID.water_heater;
  const answers = {
    hot_water_production: { response: null, value: "ballon_electrique" },
  };
  assert.equal(questionVisible(ballon, answers), true);
  assert.equal(questionVisible(ballon, { hot_water_production: { value: "collectif" } }), false);
  assert.equal(questionVisible(ballon, {}), false);
  assert.equal(
    questionVisible(QUESTION_BY_ID.ecs_equipment_age, {
      hot_water_production: { value: "chaudiere" },
    }),
    true,
  );
});

test("catalogue : électricité — oui / non / je ne sais pas", () => {
  const elec = QUESTION_BY_ID.electricity;
  assert.equal(elec.input.type, "yesno");
  assert.equal(elec.input.unknownOption, true);
  assert.equal(elec.input.unknownLabel, "Je ne sais pas");
});

test("bilan : confirm_yesno — oui sans saisie si pas d'annonce, non exige un nombre", () => {
  const q = item({ input: { type: "confirm_yesno" }, known: false });
  assert.equal(isAnswered(q, { response: "yes", value: null }), true);
  assert.equal(isAnswered(q, { response: "no", value: null }), false);
  assert.equal(isAnswered(q, { response: "no", value: 3 }), true);
});

test("bilan : note la plus grave sous la question, « je demanderai » = note neutre", () => {
  const q = item({
    signals: [
      { when: "no", tone: "info", text: "info" },
      { when: "no", tone: "danger", text: "grave" },
    ],
  });
  assert.equal(noteFor(q, { response: "no" }).text, "grave");
  assert.equal(noteFor(q, { response: "yes" }), null);
  assert.equal(noteFor(q, { response: "unknown" }).tone, "muted");
});

test("bilan : raison de vente — pas de +1 systématique, levier selon le motif", () => {
  const q = QUESTION_BY_ID.sale_reason;
  const base = { items: [item({ ...q, essential: true })], answers: {} };
  const neutral = computeInsights({
    ...base,
    answers: { sale_reason: { response: null, value: "life_change" } },
  });
  assert.equal(neutral.lever.score, 0, "motif neutre sans points de levier");

  const mutation = computeInsights({
    ...base,
    answers: { sale_reason: { response: null, value: "mutation" } },
  });
  assert.equal(mutation.lever.score, 2, "mutation = vendeur souvent pressé");

  const loc = computeInsights({
    ...base,
    answers: { sale_reason: { response: null, value: "investment_exit" } },
  });
  assert.equal(loc.lever.score, 1);
});

test("bilan : alertes, levier, coûts, travaux, corrections, à demander, verdict", () => {
  const items = [
    item({ id: "humidity", essential: true, signals: [{ when: "yes", tone: "danger", text: "Humidité", cost: [2000, 12000], lever: 2 }] }),
    item({ id: "windows", essential: true, signals: [{ when: "no", tone: "warn", text: "Vitrage", cost: [2400, 6400], lever: 1 }] }),
    item({ id: "surface", essential: true, field: "surface", known: true, value: 120, unit: "m²", input: { type: "confirm_number" } }),
    item({ id: "charges_copro", field: "charges_copro", unit: "€/an", input: { type: "confirm_number" } }),
    item({ id: "taxe_fonciere", field: "taxe_fonciere", known: true, value: 1200, unit: "€/an", input: { type: "confirm_number" } }),
    item({ id: "energy_bills", input: { type: "number" } }),
    item({ id: "quiet", essential: true }),
  ];
  const empty = computeInsights({ items, answers: {} });
  assert.equal(empty.phase, "preparation");
  assert.equal(empty.verdict.tone, "muted");
  assert.equal(empty.counts.total, 7);
  assert.equal(empty.counts.essentials, 4);
  assert.equal(empty.lever.level, 0);

  const ins = computeInsights({
    items,
    answers: {
      humidity: { response: "yes" },
      windows: { response: "no" },
      surface: { response: "no", value: 110 },
      charges_copro: { response: "no", value: 2400 },
      taxe_fonciere: { response: "yes", value: 1200 },
      energy_bills: { response: null, value: 1800 },
      quiet: { response: "unknown" },
    },
    market: { daysOnMarket: 200, priceDrops: 1 },
    listing: { price: 300000 },
  });
  assert.equal(ins.phase, "visite");
  assert.equal(ins.counts.answered, 6);
  assert.equal(ins.counts.todo, 1);
  assert.equal(ins.counts.essentialsAnswered, 3);
  assert.equal(ins.counts.alerts, 2);
  assert.equal(ins.counts.dangers, 1);
  assert.equal(ins.verdict.tone, "danger", "un point bloquant domine");
  assert.equal(ins.alerts[0].tone, "danger", "les alertes graves en premier");

  // Corrections : surface corrigée + charges découvertes ; taxe confirmée non comptée.
  assert.deepEqual(ins.corrections.map((c) => c.field).sort(), ["charges_copro", "surface"]);
  assert.equal(ins.corrections.find((c) => c.field === "surface").from, 120);

  // Coûts fixes : charges 2400 + taxe 1200 (confirmée) + énergie 1800 = 5400 €/an → 450 €/mois.
  assert.equal(ins.costs.annual, 5400);
  assert.equal(ins.costs.monthly, 450);
  assert.equal(ins.costs.known, 3);

  // Travaux : humidité + vitrage.
  assert.equal(ins.works.min, 4400);
  assert.equal(ins.works.max, 18400);

  // Levier : 2 + 1 (signaux) + 3 (≥ 180 j) + 1 (une baisse) = 7 → « Fort ».
  assert.equal(ins.lever.score, 7);
  assert.equal(ins.lever.label, "Fort");
  assert.equal(ins.lever.reasons.length, 4);

  assert.equal(ins.effective.surface, 110);
  assert.equal(ins.pricePerSqm, Math.round(300000 / 110));
});

test("bilan : phase terminée quand la décision est prise, verdict conforme sans alerte", () => {
  const items = [item({ id: "quiet", essential: true }), item({ id: "decision", input: { type: "choice", options: [{ value: "offer", label: "Offre" }] } })];
  const ins = computeInsights({
    items,
    answers: { quiet: { response: "yes" }, decision: { response: null, value: "offer" } },
  });
  assert.equal(ins.phase, "terminee");
  assert.equal(ins.verdict.tone, "ok");
});

test("réponses → corrections de champ : seules les questions liées à un champ comptent", () => {
  const fields = fieldsFromAnswers(
    {
      surface: { response: "no", value: 95, answeredAt: "2026-01-01T00:00:00.000Z" },
      ceiling_height: { response: "yes", value: null },
      quiet: { response: "yes" },
    },
    { origin: "visit" }
  );
  assert.deepEqual(Object.keys(fields), ["surface"]);
  assert.equal(fields.surface.value, 95);
  assert.equal(fields.surface.source, "user");
  assert.equal(fields.surface.origin, "visit");
  assert.equal(fields.surface.confirmed, false);
});

test("réponses → corrections : OUI marque la valeur comme confirmée, origine paramétrable", () => {
  const fields = fieldsFromAnswers(
    { surface: { response: "yes", value: 120 } },
    { origin: "listing" }
  );
  assert.equal(fields.surface.confirmed, true);
  assert.equal(fields.surface.origin, "listing");
});

/* --------------------------- View-model de la fiche --------------------------- */

function sampleListing() {
  return {
    id: 1,
    title: "Appartement 4 pièces",
    property_type: "apartment",
    transaction_type: "sale",
    status: "to_visit",
    price: 300000,
    surface: 120,
    city: "Rennes",
    postal_code: "35000",
    source: "seloger",
    description: "Bel appartement, proche commerces.",
    first_saved_at: daysAgoIso(120),
  };
}

test("fiche de visite : connu → À confirmer, inconnu → À découvrir", () => {
  const listing = sampleListing();
  const resolved = resolveAll({
    listing,
    overrides: {},
    descriptionFacts: extractDescriptionFacts(listing.description),
  });
  const sheet = buildVisitSheet({
    listing,
    photo: "https://p.example.com/1.jpg",
    resolved,
    photoAnalysis: null,
    priceHistory: [],
    sheet: { visit: { applyToSheet: null, answers: {} } },
  });

  assert.deepEqual(
    sheet.sections.map((s) => s.id),
    ["avant", "exterieur", "interieur", "chiffres", "ressenti"],
    "étapes dans l'ordre du déroulé de visite"
  );
  const interieur = sheet.sections.find((s) => s.id === "interieur");
  const surfaceItem = interieur.items.find((it) => it.id === "surface");
  assert.ok(surfaceItem, "la surface est vérifiée à l'intérieur");
  assert.equal(surfaceItem.known, true, "connue → à confirmer");
  assert.equal(surfaceItem.value, 120);
  assert.ok(surfaceItem.signals.length > 0, "signaux transmis à la vue");

  const chiffres = sheet.sections.find((s) => s.id === "chiffres");
  const charges = chiffres.items.find((it) => it.id === "charges_copro");
  assert.ok(charges && !charges.known, "charges inconnues → à découvrir");
  assert.ok(!sheet.sections.some((s) => s.items.some((it) => it.id === "roof")), "pas de toiture pour un appartement");

  assert.equal(sheet.applyToSheet, null, "consentement non encore donné");
  assert.equal(sheet.listing.photo, "https://p.example.com/1.jpg");
  assert.equal(sheet.listing.surface, 120);
  assert.ok(sheet.counts.total > 0 && sheet.counts.discover > 0 && sheet.counts.confirm > 0);
  assert.ok(sheet.themes.every((t) => t.total > 0));
  assert.equal(sheet.insights.phase, "preparation");
  assert.equal(sheet.market.daysOnMarket >= 119, true);
});

test("fiche de visite : maison → toiture et terrain, pas de copropriété sans mention", () => {
  const listing = { ...sampleListing(), property_type: "house", land_surface: 500 };
  const resolved = resolveAll({ listing, overrides: {}, descriptionFacts: {} });
  const sheet = buildVisitSheet({ listing, resolved, sheet: null });
  const ids = sheet.sections.flatMap((s) => s.items.map((it) => it.id));
  assert.ok(ids.includes("roof"));
  assert.ok(ids.includes("land_surface"));
  assert.ok(!ids.includes("charges_copro"));
  const withCopro = buildVisitSheet({ listing, resolved, sheet: null, isCopro: true });
  assert.ok(withCopro.sections.flatMap((s) => s.items.map((it) => it.id)).includes("charges_copro"));
});

test("fiche de visite : faits photo structurés → questions du catalogue, textes libres en encart", () => {
  const listing = sampleListing();
  const resolved = resolveAll({ listing, overrides: {}, descriptionFacts: {} });
  const photoAnalysis = {
    ready: true,
    rooms: [
      { room_id: "room_01", room_type: "bedroom", label: "Chambre bizarre (texte LLM)" },
      { room_id: "room_02", room_type: "kitchen", kitchen: { condition: "full_replacement_likely" } },
    ],
    anomalies: [{ type: "possible_mold", room_id: "room_01", confidence: 0.8 }],
    contradictions: [{ claim: "entièrement rénové", status: "contradicted" }],
    visitQuestions: ["Pourquoi y a-t-il un éléphant dans le salon ?"],
    visitChecks: ["Contrôler le fonctionnement des équipements de la cuisine."],
    negotiationPoints: [{ label: "Cuisine à rénover" }],
  };
  const sheet = buildVisitSheet({
    listing,
    photo: null,
    resolved,
    photoAnalysis,
    priceHistory: [{ price: 320000 }, { price: 300000 }],
    sheet: { visit: { applyToSheet: null, answers: {} } },
  });

  const allIds = sheet.sections.flatMap((s) => s.items.map((it) => it.id));
  assert.ok(!allIds.some((id) => /^ai_/.test(id)), "plus aucune question rédigée par le modèle");
  assert.ok(
    !sheet.sections.some((s) => s.items.some((it) => /éléphant|Contrôler le fonctionnement/.test(it.question))),
    "le texte libre du modèle n'apparaît jamais dans une question"
  );

  const interieur = sheet.sections.find((s) => s.id === "interieur");
  const mold = interieur.items.find((it) => it.id === "photo_humidity");
  assert.ok(mold, "question humidité déclenchée par l'anomalie possible_mold");
  assert.equal(mold.photoTriggered, true);
  assert.equal(mold.input.type, "choice");
  assert.match(mold.question, /\(chambre\)/, "pièce libellée depuis room_type, pas depuis label");
  assert.doesNotMatch(mold.question, /bizarre/);
  assert.match(mold.photoHint, /chambre/);
  assert.ok(!interieur.items.some((it) => it.id === "photo_cracks"), "pas de fissure : pas de question fissure");

  const humidity = interieur.items.find((it) => it.id === "humidity");
  assert.ok(humidity.photoHint, "question catalogue humidité annotée");
  assert.equal(humidity.photoTriggered, false);
  const kitchen = interieur.items.find((it) => it.id === "kitchen");
  assert.match(kitchen.photoHint, /cuisine/i);
  const windows = interieur.items.find((it) => it.id === "windows");
  assert.equal(windows.photoHint, null, "pas de fait vitrage : pas d'indice");

  const avant = sheet.sections.find((s) => s.id === "avant");
  const claims = avant.items.find((it) => it.id === "photo_claims");
  assert.ok(claims, "contradiction annonce / photos → question avant la visite");
  assert.match(claims.question, /« entièrement rénové »/);

  assert.deepEqual(sheet.photoNotes.checks, ["Contrôler le fonctionnement des équipements de la cuisine."]);
  assert.deepEqual(sheet.photoNotes.questions, ["Pourquoi y a-t-il un éléphant dans le salon ?"]);
  assert.deepEqual(sheet.photoNotes.negotiation, ["Cuisine à rénover"]);
  assert.equal(sheet.photoNotes.total, 3);

  assert.ok(sheet.market.daysOnMarket >= 119, "durée de suivi calculée");
  assert.equal(sheet.market.priceDrops, 1, "baisse de prix détectée");
  assert.equal(sheet.market.priceDelta, 20000);
  assert.ok(sheet.insights.lever.level >= 2, "120 jours + une baisse : levier déjà notable");
  assert.ok(sheet.insights.lever.reasons.some((r) => /120 jours/.test(r.text)));
});

test("fiche de visite : sans analyse photo, aucune question photo_* ni encart", () => {
  const listing = sampleListing();
  const resolved = resolveAll({ listing, overrides: {}, descriptionFacts: {} });
  const sheet = buildVisitSheet({ listing, resolved, photoAnalysis: null, sheet: null });
  const ids = sheet.sections.flatMap((s) => s.items.map((it) => it.id));
  assert.ok(!ids.some((id) => /^photo_/.test(id)));
  assert.ok(ids.includes("humidity"), "la question catalogue reste");
  assert.equal(sheet.photoNotes.total, 0);
  assert.ok(sheet.sections.every((s) => s.items.every((it) => it.photoHint === null && !it.photoTriggered)));
});

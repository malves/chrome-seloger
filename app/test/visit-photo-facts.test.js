/**
 * Faits structurés de l'analyse photo pour la fiche de visite : extraction
 * (seuil de confiance, pire état cuisine / salle de bain, libellés de pièce
 * par room_type, affirmations contredites), déclenchement des questions et
 * remplissage des gabarits.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  photoFactsFrom,
  matchingFacts,
  fillTemplate,
  PHOTO_FACT_MIN_CONFIDENCE,
} from "../src/lib/visit/visit-photo-facts.js";
import {
  QUESTION_BY_ID,
  questionTriggered,
  questionHasPhotoFact,
} from "../src/lib/visit/visit-questions.js";

const rooms = [
  { room_id: "r1", room_type: "bedroom", label: "Chambre parentale (libre)" },
  { room_id: "r2", room_type: "bedroom" },
  { room_id: "r3", room_type: "living_room" },
  { room_id: "r4", room_type: "kitchen", kitchen: { condition: "partial_renovation_likely" } },
  { room_id: "r5", room_type: "open_kitchen", kitchen: { condition: "full_replacement_likely" } },
  { room_id: "r6", room_type: "bathroom", bathroom: { renovation_level: "light" } },
  { room_id: "r7", room_type: "shower_room", bathroom: { renovation_level: "full" } },
  { room_id: "r8", room_type: "office", windows: { glazing: "single_likely" } },
  { room_id: "r9", room_type: "unknown" },
];

test("anomalies : seuil de confiance, type « other » ignoré, pièces dédoublonnées et comptées", () => {
  const facts = photoFactsFrom({
    ready: true,
    rooms,
    anomalies: [
      { type: "possible_mold", room_id: "r1", confidence: 0.9 },
      { type: "possible_mold", room_id: "r2", confidence: 0.7 },
      { type: "possible_mold", room_id: "r3", confidence: PHOTO_FACT_MIN_CONFIDENCE },
      { type: "crack", room_id: "r1", confidence: 0.2 },
      { type: "other", room_id: "r1", confidence: 1 },
      { type: "elephant", room_id: "r1", confidence: 1 },
      { type: "visible_wiring", room_id: "r9", confidence: 0.8 },
      { type: "visible_wiring", room_id: "nope", confidence: 0.8 },
    ],
  });
  assert.deepEqual(facts["anomaly:possible_mold"].rooms, ["2 chambres", "séjour"]);
  assert.equal(facts["anomaly:possible_mold"].count, 3);
  assert.equal(facts["anomaly:crack"], undefined, "sous le seuil de confiance");
  assert.equal(facts["anomaly:other"], undefined);
  assert.equal(facts["anomaly:elephant"], undefined, "type hors vocabulaire ignoré");
  assert.deepEqual(facts["anomaly:visible_wiring"].rooms, [], "pièce inconnue : pas de libellé inventé");
  assert.equal(facts["anomaly:visible_wiring"].count, 2);
  assert.ok(
    !JSON.stringify(facts).includes("parentale"),
    "le label libre du modèle n'est jamais repris"
  );
});

test("cuisine, salle de bain : pire état retenu ; vitrage simple", () => {
  const facts = photoFactsFrom({ ready: true, rooms, anomalies: [] });
  assert.ok(facts["kitchen:full_replacement_likely"]);
  assert.equal(facts["kitchen:partial_renovation_likely"], undefined, "une seule clé cuisine, la pire");
  assert.deepEqual(facts["kitchen:full_replacement_likely"].rooms, ["cuisine", "cuisine ouverte"]);
  assert.ok(facts["bathroom:full"]);
  assert.equal(facts["bathroom:medium"], undefined);
  assert.deepEqual(facts["bathroom:full"].rooms, ["salle d'eau"], "« light » ne compte pas");
  assert.deepEqual(facts["glazing:single_likely"].rooms, ["bureau"]);
});

test("contradictions : seules les « contradicted », 3 max, dédoublonnées ; les deux noms de champ", () => {
  const list = [
    { claim: "entièrement rénové", status: "contradicted" },
    { claim: "entièrement rénové", status: "contradicted" },
    { claim: "très lumineux", status: "supported" },
    { claim: "cuisine récente", status: "contradicted" },
    { claim: "vue dégagée", status: "contradicted" },
    { claim: "aucun travaux", status: "contradicted" },
  ];
  const a = photoFactsFrom({ ready: true, contradictions: list });
  assert.deepEqual(a["claim:contradicted"].claims, ["entièrement rénové", "cuisine récente", "vue dégagée"]);
  const b = photoFactsFrom({ description_contradictions: list });
  assert.deepEqual(b["claim:contradicted"].claims, a["claim:contradicted"].claims);
});

test("analyse absente ou non prête : aucun fait", () => {
  assert.deepEqual(photoFactsFrom(null), {});
  assert.deepEqual(photoFactsFrom({ ready: false, anomalies: [{ type: "crack", confidence: 1 }] }), {});
  assert.deepEqual(photoFactsFrom({ ready: true, status: "ok" }), {});
});

test("matchingFacts fusionne plusieurs clés ; fillTemplate remplit {rooms} et {claims}", () => {
  const facts = {
    "anomaly:possible_mold": { rooms: ["chambre"], claims: [], count: 1 },
    "anomaly:possible_humidity": { rooms: ["chambre", "séjour"], claims: [], count: 2 },
    "claim:contradicted": { rooms: [], claims: ["refait à neuf", "cuisine récente"], count: 2 },
  };
  const merged = matchingFacts(["anomaly:possible_mold", "anomaly:possible_humidity", "anomaly:crack"], facts);
  assert.deepEqual(merged.rooms, ["chambre", "séjour"]);
  assert.equal(merged.count, 3);

  assert.equal(fillTemplate("Traces ({rooms}) ?", merged), "Traces (chambre et séjour) ?");
  assert.equal(
    fillTemplate("Traces ({rooms}) ?", { rooms: [], claims: [], count: 0 }),
    "Traces ?",
    "parenthèses supprimées quand la pièce est inconnue"
  );
  assert.equal(
    fillTemplate("L'annonce affirme {claims}.", matchingFacts(["claim:contradicted"], facts)),
    "L'annonce affirme « refait à neuf » et « cuisine récente »."
  );
  assert.equal(fillTemplate("Sans slot.", merged), "Sans slot.");
});

test("questionTriggered : photo.required exige un fait, les autres passent toujours", () => {
  const facts = photoFactsFrom({
    ready: true,
    rooms,
    anomalies: [{ type: "crack", room_id: "r3", confidence: 0.9 }],
  });
  assert.equal(questionTriggered(QUESTION_BY_ID.photo_cracks, facts), true);
  assert.equal(questionTriggered(QUESTION_BY_ID.photo_humidity, facts), false);
  assert.equal(questionTriggered(QUESTION_BY_ID.photo_claims, facts), false);
  assert.equal(questionTriggered(QUESTION_BY_ID.humidity, facts), true, "toujours visible");
  assert.equal(questionHasPhotoFact(QUESTION_BY_ID.humidity, facts), true, "mais annotée (fissure)");
  assert.equal(questionHasPhotoFact(QUESTION_BY_ID.windows, facts), true, "vitrage simple dans le bureau");
  assert.equal(questionHasPhotoFact(QUESTION_BY_ID.sale_reason, facts), false);
  assert.equal(questionTriggered(QUESTION_BY_ID.photo_cracks, {}), false);
  assert.equal(questionTriggered(QUESTION_BY_ID.photo_cracks, null), false);
});

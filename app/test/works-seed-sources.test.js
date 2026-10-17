/**
 * Points à refaire proposés par l'IA : fusion des sorties de l'analyse et
 * cohérence avec l'état général de la pièce.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { WORK_TYPES } from "../src/lib/photo-analysis/enums.js";
import { ANALYSIS_ISSUE_KEYS, ROOM_ISSUE_KEYS } from "../src/lib/works/works-issues.js";
import {
  WORK_TYPE_TO_ISSUES,
  reconcileRoomCondition,
  roomIssuesFromAnalysis,
} from "../src/lib/works/works-seed-sources.js";
import { emptyRoom, reconcileWorksPlan, seedWorksPlan } from "../src/lib/works/works-plan.js";
import { normalizeRoomIssues } from "../src/services/photo-analysis/synthesis-pass.service.js";

const PHOTO = "https://p.example.com/sdb.jpg";

/** Cas de l'annonce 46 : salle de bain « Moyen », surfaces jugées bonnes, travaux listés à part. */
function listing46() {
  return {
    status: "ok",
    ready: true,
    images: [
      {
        id: "img_007",
        order: 1,
        url: PHOTO,
        usable_for_condition_analysis: true,
        observations: { walls: { condition: "worn", notes: "Murs usés avec des taches" } },
      },
    ],
    rooms: [
      {
        room_id: "room_03",
        room_type: "bathroom",
        label: "Salle de bain",
        image_ids: ["img_007"],
        condition: "average",
        summary: "Sol, murs et plafond en bon état. L'éclairage semble insuffisant.",
        floor: { condition: "good" },
        walls: { condition: "good" },
        ceiling: { condition: "good" },
      },
    ],
    potential_works: [
      {
        work_type: "bathroom_refresh",
        room_id: "room_03",
        necessity: "possible",
        rationale: "La salle de bain présente des murs usés avec des taches visibles.",
      },
    ],
    anomalies: [],
  };
}

test("chaque type de travail de l'analyse a une correspondance vers des points connus", () => {
  for (const type of WORK_TYPES) {
    assert.ok(Array.isArray(WORK_TYPE_TO_ISSUES[type]), `type non couvert : ${type}`);
    for (const key of WORK_TYPE_TO_ISSUES[type]) assert.ok(ANALYSIS_ISSUE_KEYS.includes(key), `${type} → ${key}`);
  }
});

test("annonce 46 : la salle de bain « Moyen » reçoit les travaux listés et vus sur la photo", () => {
  const plan = seedWorksPlan(listing46(), [PHOTO]);
  const [bath] = plan.rooms;
  assert.ok(bath.issues.includes("bathroom_refresh"));
  assert.ok(bath.issues.includes("paint"), "fiche photo « murs usés » → peinture");
  assert.match(bath.issue_reasons.bathroom_refresh, /murs usés/);
  assert.equal(bath.condition, "average");
  assert.equal(bath.needs_review, false);
  assert.equal(bath.summary, "", "la note reste à l'utilisateur");
  assert.match(bath.ai_summary, /éclairage/);
});

test("pièce « Moyen » sans aucun défaut relevé : l'avis de l'IA n'est pas retenu, rien n'est inventé", () => {
  const stored = listing46();
  stored.potential_works = [];
  stored.images[0].observations = {};
  const [bath] = seedWorksPlan(stored, [PHOTO]).rooms;
  assert.deepEqual(bath.issues, []);
  assert.equal(bath.condition, "good");
  assert.equal(bath.needs_review, false);
  assert.match(bath.ai_summary, /sans aucun défaut précis relevé/);
});

test("état de l'IA aligné sur ses constats, dans les deux sens", () => {
  assert.deepEqual(reconcileRoomCondition("good", ["paint"]), { condition: "average", needsReview: false, adjusted: true, unsupported: null });
  assert.deepEqual(reconcileRoomCondition("renovation_needed", []), { condition: "good", needsReview: false, adjusted: true, unsupported: "renovation_needed" });
  assert.equal(reconcileRoomCondition("average", ["humidity"]).condition, "average");
  assert.equal(reconcileRoomCondition("not_assessable", []).condition, "not_assessable");
  assert.equal(reconcileRoomCondition("not_assessable", ["bathroom_refresh"]).condition, "average");
});

test("plan enregistré : seul un état encore proposé par l'IA, sans point retouché, est aligné", () => {
  const base = { groups: { unassigned: [], exterior: [], excluded: [] }, captions: {} };
  const room = (over) => ({ ...emptyRoom("r", "bedroom", "Chambre"), photos: [], issues: [], issues_ai: [], ...over });
  const [ai, user, unchecked] = reconcileWorksPlan({
    ...base,
    rooms: [
      room({ id: "a", condition: "average", condition_source: "ai" }),
      room({ id: "b", condition: "average", condition_source: "user" }),
      room({ id: "c", condition: "average", condition_source: "ai", issues_ai: ["paint"] }),
    ],
  }, []).rooms;
  assert.equal(ai.condition, "good");
  assert.equal(user.condition, "average");
  assert.equal(user.needs_review, true, "choix de l'utilisateur : à préciser, jamais corrigé");
  assert.equal(unchecked.condition, "average");
  assert.equal(unchecked.needs_review, true, "points décochés par l'utilisateur : à préciser");
});

test("travaux jugés peu probables ou d'une autre pièce : ignorés", () => {
  const stored = listing46();
  stored.images[0].observations = {};
  stored.potential_works = [
    { work_type: "bathroom_full_renovation", room_id: "room_03", necessity: "unlikely" },
    { work_type: "painting", room_id: "room_99", necessity: "very_likely" },
  ];
  const out = roomIssuesFromAnalysis(stored.rooms[0], stored, "bathroom");
  assert.deepEqual(out.issues, []);
});

test("points de cuisine refusés dans une salle d'eau, et inversement", () => {
  const raw = { room_id: "r", issues: ["kitchen_redo", "bathroom_redo", "paint"], issue_reasons: { kitchen_redo: "x" } };
  assert.deepEqual(roomIssuesFromAnalysis(raw, {}, "bathroom").issues, ["paint", "bathroom_redo"].sort((a, b) => ROOM_ISSUE_KEYS.indexOf(a) - ROOM_ISSUE_KEYS.indexOf(b)));
  assert.deepEqual(roomIssuesFromAnalysis(raw, {}, "kitchen").issues.includes("bathroom_redo"), false);
  assert.deepEqual(roomIssuesFromAnalysis(raw, {}, "bedroom").issues, ["paint"]);
});

test("blocs cuisine et salle d'eau de la synthèse", () => {
  const kitchen = { room_id: "k", kitchen: { condition: "full_replacement_likely", notes: "meubles très datés" } };
  const out = roomIssuesFromAnalysis(kitchen, {}, "kitchen");
  assert.deepEqual(out.issues, ["kitchen_redo"]);
  assert.match(out.reasons.kitchen_redo, /Meubles très datés/);
  const bath = { room_id: "b", bathroom: { renovation_level: "full" } };
  assert.deepEqual(roomIssuesFromAnalysis(bath, {}, "shower_room").issues, ["bathroom_redo"]);
});

test("synthèse : points inconnus écartés, raisons limitées aux points retenus", () => {
  const out = normalizeRoomIssues(["paint", "piscine", "paint"], { paint: "  Murs tachés ", piscine: "x", mold: "y" });
  assert.deepEqual(out, { issues: ["paint"], issue_reasons: { paint: "Murs tachés" } });
  assert.deepEqual(normalizeRoomIssues(null, null), { issues: [], issue_reasons: {} });
});

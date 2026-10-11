/**
 * Planchers d'état : surfaces, pièces et état global ne peuvent pas être
 * meilleurs que les fiches par image et les anomalies relevées.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  applyConditionFloors,
  escalateRoomSurfaces,
  floorGlobalCondition,
  floorRoomCondition,
  HEAVY_RENOVATION_SCORE_CAP,
} from "../src/lib/photo-analysis/condition-floor.js";

function record(id, observations, usable = true) {
  return { id, usable_for_condition_analysis: usable, observations };
}

function room(overrides = {}) {
  return {
    room_id: "room_01",
    room_type: "living_room",
    image_ids: ["img_001"],
    condition: "average",
    floor: { material: "wood_parquet", condition: "worn", apparent_age: "dated", potential_work: null, confidence: 0.7 },
    walls: { condition: "worn", notes: null, confidence: 0.7 },
    ceiling: { condition: "good", notes: null, confidence: 0.7 },
    ...overrides,
  };
}

const AVERAGE = { score: 55, label: "average", confidence: 0.7 };
const MODERATE = { level: "moderate_renovation", confidence: 0.7 };

test("sol « usé » en synthèse mais décollé sur la fiche image → remplacement, rénovation lourde", () => {
  const byId = new Map([
    ["img_001", record("img_001", {
      floor: { material: "wood_parquet", condition: "replacement_likely" },
      walls: { condition: "damaged" },
      possible_defects: [{ type: "possible_mold", severity: "high", confidence: 0.8 }],
    })],
  ]);
  const anomalies = [{ type: "possible_mold", room_id: "room_01", severity: "high", confidence: 0.8, image_ids: ["img_001"] }];
  const result = applyConditionFloors({
    rooms: [room()],
    recordsById: byId,
    anomalies,
    condition: AVERAGE,
    renovation: MODERATE,
  });
  const [salon] = result.rooms;
  assert.equal(salon.floor.condition, "replacement_likely");
  assert.equal(salon.walls.condition, "damaged");
  assert.equal(salon.condition, "heavy_renovation_likely");
  assert.equal(result.condition.label, "heavy_renovation_likely");
  assert.equal(result.condition.score, HEAVY_RENOVATION_SCORE_CAP);
  assert.equal(result.renovation.level, "heavy_renovation_possible");
  assert.ok(result.adjustments.some((a) => a.scope === "room_01.floor" && a.from === "worn" && a.to === "replacement_likely"));
});

test("notes « lames soulevées » : sol au moins à remplacer, murs taches → abîmés", () => {
  const byId = new Map([
    [
      "img_001",
      record("img_001", {
        floor: { condition: "damaged", notes: "some tiles are lifted" },
        walls: { condition: "worn", defects: ["stains"] },
      }),
    ],
  ]);
  const { room: escalated, adjustments } = escalateRoomSurfaces(room(), byId);
  assert.equal(escalated.floor.condition, "replacement_likely");
  assert.equal(escalated.walls.condition, "damaged");
  assert.ok(adjustments.some((a) => a.to === "replacement_likely"));
  const { room: floored } = floorRoomCondition(escalated, []);
  assert.equal(floored.condition, "heavy_renovation_likely");
});

test("défaut « sol abîmé » de sévérité moyenne → sol au moins damaged", () => {
  const byId = new Map([
    ["img_001", record("img_001", {
      floor: { condition: "worn" },
      possible_defects: [{ type: "damaged_floor", severity: "medium", confidence: 0.7 }],
    })],
  ]);
  const { room: escalated } = escalateRoomSurfaces(room(), byId);
  assert.equal(escalated.floor.condition, "damaged");
});

test("sol absent de la synthèse : créé à partir de la fiche image", () => {
  const byId = new Map([["img_001", record("img_001", { floor: { material: "tiles", condition: "damaged" } })]]);
  const { room: escalated } = escalateRoomSurfaces(room({ floor: null }), byId);
  assert.equal(escalated.floor.condition, "damaged");
  assert.equal(escalated.floor.material, "tiles");
});

test("fiches non exploitables ignorées", () => {
  const byId = new Map([["img_001", record("img_001", { floor: { condition: "replacement_likely" } }, false)]]);
  const { room: escalated, adjustments } = escalateRoomSurfaces(room(), byId);
  assert.equal(escalated.floor.condition, "worn");
  assert.deepEqual(adjustments, []);
});

test("pièce saine : inchangée, aucun ajustement", () => {
  const healthy = room({
    condition: "good",
    floor: { condition: "good" },
    walls: { condition: "good" },
    ceiling: { condition: "good" },
  });
  const byId = new Map([["img_001", record("img_001", { floor: { condition: "good" } })]]);
  const result = applyConditionFloors({
    rooms: [healthy],
    recordsById: byId,
    anomalies: [],
    condition: { score: 75, label: "good", confidence: 0.8 },
    renovation: { level: "none", confidence: 0.8 },
  });
  assert.equal(result.rooms[0].condition, "good");
  assert.equal(result.condition.score, 75);
  assert.equal(result.condition.label, "good");
  assert.equal(result.renovation.level, "none");
  assert.deepEqual(result.adjustments, []);
});

test("jamais d'amélioration : une surface ou une pièce pire que les fiches reste telle quelle", () => {
  const byId = new Map([["img_001", record("img_001", { floor: { condition: "good" } })]]);
  const bad = room({ condition: "heavy_renovation_likely", floor: { condition: "replacement_likely" } });
  const { room: escalated } = escalateRoomSurfaces(bad, byId);
  assert.equal(escalated.floor.condition, "replacement_likely");
  const { room: floored, adjustment } = floorRoomCondition(escalated, []);
  assert.equal(floored.condition, "heavy_renovation_likely");
  assert.equal(adjustment, null);

  const global = floorGlobalCondition(
    { score: 10, label: "heavy_renovation_likely", confidence: 0.8 },
    { level: "heavy_renovation_possible" },
    [floored],
    []
  );
  assert.equal(global.condition.score, 10);
  assert.deepEqual(global.adjustments, []);
});

test("anomalie de faible sévérité ou peu fiable : pas de plancher", () => {
  const anomalies = [
    { type: "possible_humidity", room_id: "room_01", severity: "low", confidence: 0.9 },
    { type: "possible_mold", room_id: "room_01", severity: "high", confidence: 0.3 },
  ];
  const { adjustment } = floorRoomCondition(room(), anomalies);
  assert.equal(adjustment, null);
});

test("anomalie sans room_id rattachée par ses images", () => {
  const anomalies = [{ type: "possible_water_damage", room_id: null, severity: "medium", confidence: 0.7, image_ids: ["img_001"] }];
  const { room: floored } = floorRoomCondition(room(), anomalies);
  assert.equal(floored.condition, "renovation_needed");
});

test("global : minorité de pièces à rénover → pas de plancher ; humidité élevée → rénovation", () => {
  const rooms = [
    room({ room_id: "a", condition: "renovation_needed" }),
    room({ room_id: "b", condition: "good" }),
    room({ room_id: "c", condition: "good" }),
    room({ room_id: "terrasse", room_type: "terrace", condition: "heavy_renovation_likely" }),
  ];
  const quiet = floorGlobalCondition(AVERAGE, MODERATE, rooms, []);
  assert.deepEqual(quiet.adjustments, []);

  const humid = floorGlobalCondition(AVERAGE, MODERATE, rooms, [
    { type: "possible_mold", severity: "high", confidence: 0.8 },
  ]);
  assert.equal(humid.condition.label, "renovation_needed");
  assert.equal(humid.condition.score, 40);
  assert.equal(humid.renovation.level, "significant_renovation");
});

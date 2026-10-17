import test from "node:test";
import assert from "node:assert/strict";
import {
  placeUnplacedWorks,
  reconcileRoomCondition,
  roomNeedsReview,
} from "../src/lib/works/works-coherence.js";
import { unplacedWorkSources } from "../src/lib/works/works-seed-sources.js";

const name = (r) => r.label || r.type;

test("roomNeedsReview : état qui suppose des travaux sans point coché", () => {
  assert.equal(roomNeedsReview({ condition: "average", issues: [] }), true);
  assert.equal(roomNeedsReview({ condition: "average", issues: ["paint"] }), false);
  assert.equal(roomNeedsReview({ condition: "good", issues: [] }), false);
});

test("reconcileRoomCondition : un point de pièce dégrade un état « bon »", () => {
  assert.equal(reconcileRoomCondition("good", []).condition, "good");
  assert.equal(reconcileRoomCondition("good", ["paint"]).condition, "average");
});

test("placeUnplacedWorks : extérieur, sans photo placée, à cocher, couvert", () => {
  const sources = [
    { id: "w1", label: "Ravalement", kind: "exterior", photos: ["p9"], issues: [] },
    { id: "w2", label: "Peinture", kind: "interior", photos: ["p1"], issues: ["paint"] },
    { id: "w3", label: "Sol", kind: "interior", photos: ["p2"], issues: ["floor_redo"] },
    { id: "w4", label: "Plafond", kind: "interior", photos: ["p3"], issues: ["ceiling_paint"] },
    { id: "w5", label: "Divers", kind: "interior", photos: ["p3"], issues: [] },
  ];
  const rooms = [
    { id: "r1", type: "bedroom", label: "Chambre", photos: ["p2"], issues: [] },
    { id: "r2", type: "living_room", label: "Séjour", photos: ["p3"], issues: ["ceiling_paint"] },
  ];
  const placed = placeUnplacedWorks(sources, rooms, name);
  const byId = Object.fromEntries(placed.map((w) => [w.id, w]));
  assert.equal(byId.w1.status, "exterior");
  assert.equal(byId.w2.status, "unassigned");
  assert.equal(byId.w3.status, "to_check");
  assert.deepEqual(byId.w3.rooms, [{ id: "r1", name: "Chambre" }]);
  assert.deepEqual(byId.w3.missingIssues, ["floor_redo"]);
  assert.equal(byId.w4, undefined, "un travail dont les points sont cochés disparaît");
  assert.equal(byId.w5.status, "note");
});

test("unplacedWorkSources : travaux sans pièce de l'analyse, extérieurs reconnus", () => {
  const stored = {
    ready: true,
    status: "ok",
    images: [
      { id: "img_1", url: "u1", order: 1 },
      { id: "img_2", url: "u2", order: 2 },
    ],
    rooms: [{ room_id: "room_01", room_type: "bedroom" }],
    potential_works: [
      { work_type: "facade_renovation", label: "Ravalement de façade", room_id: null, necessity: "likely", image_ids: ["img_2"] },
      { work_type: "wall_painting", label: "Peinture", room_id: "room_01", necessity: "likely", image_ids: ["img_1"] },
    ],
  };
  const sources = unplacedWorkSources(stored, ["u1", "u2"]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].kind, "exterior");
  assert.deepEqual(sources[0].photos, ["u2"]);
  assert.deepEqual(unplacedWorkSources(null, []), []);
});

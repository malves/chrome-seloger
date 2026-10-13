/**
 * Chiffrage travaux basé sur la surface du bien.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ZONE_IDS } from "../src/lib/dpe-insights.js";
import { ROOM_ISSUE_KEYS, applyHeavyRenovationIssues } from "../src/lib/works/works-plan.js";
import {
  COST_POSTS,
  ENERGY_COSTS,
  costsOptions,
  estimateWorksCosts,
  validateEstimateBarème,
} from "../src/lib/works/works-costs.js";

const costs = costsOptions();

function room(id, type, issues, condition = "average", label = "") {
  return { id, type, label, condition, issues };
}

test("barème : intensités et parts valides pour chaque point à signaler", () => {
  const v = validateEstimateBarème(ROOM_ISSUE_KEYS);
  assert.equal(v.ok, true);
  const posts = new Set(COST_POSTS.map((p) => p.key));
  for (const key of ROOM_ISSUE_KEYS) {
    const intensity = costs.issueIntensity[key];
    assert.ok(intensity, `intensité manquante : ${key}`);
    assert.ok(posts.has(intensity.post), `poste UI inconnu pour ${key}`);
    assert.ok(intensity.min > 0 && intensity.max >= intensity.min);
  }
  for (const id of Object.keys(ENERGY_COSTS)) assert.ok(ZONE_IDS.includes(id), `zone DPE inconnue : ${id}`);
});

test("sans surface : pas de montants", () => {
  const est = estimateWorksCosts({
    surface: null,
    propertyType: "apartment",
    rooms: [room("e1", "entrance", ["floor_worn"])],
    dpeZones: {},
    costs,
  });
  assert.equal(est.unavailableReason, "missing_surface");
  assert.equal(est.min, null);
  assert.equal(est.posts.length, 0);
});

test("cases cochées : montant nul si aucun point", () => {
  const est = estimateWorksCosts({
    surface: 80,
    propertyType: "apartment",
    rooms: [room("e1", "entrance", []), room("k1", "kitchen", [])],
    dpeZones: {},
    costs,
  });
  assert.equal(est.min, 0);
  assert.equal(est.max, 0);
});

test("80 m² vs 30 m² : même case, ordre de grandeur proportionnel à la surface", () => {
  const plan = [room("e1", "entrance", ["floor_worn"]), room("k1", "kitchen", [])];
  const big = estimateWorksCosts({ surface: 80, propertyType: "apartment", rooms: plan, dpeZones: {}, costs });
  const small = estimateWorksCosts({ surface: 30, propertyType: "apartment", rooms: plan, dpeZones: {}, costs });
  assert.ok(big.min > small.min);
  assert.ok(big.max > small.max);
  const ratio = big.min / small.min;
  assert.ok(ratio > 2 && ratio < 3.5, `ratio surface ${ratio}`);
});

test("cuisine rénovation lourde > entrée sol usé seul", () => {
  const entranceOnly = estimateWorksCosts({
    surface: 80,
    propertyType: "apartment",
    rooms: [room("e1", "entrance", ["floor_worn"]), room("k1", "kitchen", [])],
    dpeZones: {},
    costs,
  });
  const heavyIssues = applyHeavyRenovationIssues([], "kitchen").issues;
  assert.ok(heavyIssues.includes("kitchen_redo"));
  assert.ok(!heavyIssues.includes("bathroom_redo"));
  const kitchenHeavy = estimateWorksCosts({
    surface: 80,
    propertyType: "apartment",
    rooms: [room("e1", "entrance", []), room("k1", "kitchen", heavyIssues, "heavy_renovation_likely")],
    dpeZones: {},
    costs,
  });
  assert.ok(kitchenHeavy.min > entranceOnly.min);
  assert.ok(kitchenHeavy.min >= 15000, `cuisine lourde 80 m² : ${kitchenHeavy.min}`);
});

test("cuisine à refaire : tout le budget cuisine du logement, sans dilution par le séjour", () => {
  const surface = 80;
  const est = estimateWorksCosts({
    surface,
    propertyType: "apartment",
    rooms: [room("l1", "living_room", ["paint"]), room("k1", "kitchen", ["kitchen_redo"])],
    dpeZones: {},
    costs,
  });
  const kitchen = est.items.find((i) => i.id === "issue:kitchen_redo");
  const intensity = costs.issueIntensity.kitchen_redo;
  assert.equal(Math.round(kitchen.min), Math.round(surface * 1500 * costs.interiorPostShares.kitchen * intensity.min));
  assert.deepEqual(kitchen.roomIds, ["k1"]);
  assert.ok(est.byRoom.k1.min > 0);
});

test("salle d'eau : une case cochée compte dans le budget (cas de la salle de bain « Moyen »)", () => {
  const est = estimateWorksCosts({
    surface: 60,
    propertyType: "apartment",
    rooms: [room("b1", "bathroom", ["bathroom_refresh", "paint"])],
    dpeZones: {},
    costs,
  });
  assert.ok(est.min > 0);
  assert.ok(est.byRoom.b1.min === est.items.reduce((s, i) => s + i.min, 0));
});

test("même poste dans une pièce : plafonné à 100 % du poste", () => {
  const one = estimateWorksCosts({ surface: 50, propertyType: "apartment", rooms: [room("r", "living_room", ["walls_damaged"])], dpeZones: {}, costs });
  const all = estimateWorksCosts({ surface: 50, propertyType: "apartment", rooms: [room("r", "living_room", ["walls_damaged", "paint", "cracks"])], dpeZones: {}, costs });
  assert.ok(Math.abs(one.byRoom.r.max - all.byRoom.r.max) < 1);
});

test("plafond intérieur : total max ≤ surface × 2000 (+ énergie éventuelle)", () => {
  const allIssues = [...ROOM_ISSUE_KEYS];
  const rooms = [
    room("r1", "living_dining_room", allIssues, "heavy_renovation_likely"),
    room("r2", "kitchen", allIssues, "heavy_renovation_likely"),
    room("r3", "bathroom", allIssues, "heavy_renovation_likely"),
  ];
  const est = estimateWorksCosts({
    surface: 80,
    propertyType: "apartment",
    rooms,
    dpeZones: { windows: { state: "poor" } },
    costs,
  });
  const interiorMax = est.posts.filter((p) => p.key !== "energy").reduce((s, p) => s + p.max, 0);
  assert.ok(interiorMax <= 80 * 2000 + 1, `intérieur max ${interiorMax}`);
  const roomsMax = Object.values(est.byRoom).reduce((s, r) => s + r.max, 0);
  assert.ok(Math.abs(roomsMax - interiorMax) < 1);
});

test("DPE fenêtres poor sans case pièce : ligne énergie mise à l'échelle", () => {
  const est = estimateWorksCosts({
    surface: 120,
    propertyType: "apartment",
    rooms: [room("e1", "entrance", [])],
    dpeZones: { windows: { state: "poor" } },
    costs,
  });
  const win = est.items.find((i) => i.id === "energy:windows");
  assert.ok(win);
  const ref = estimateWorksCosts({
    surface: 70,
    propertyType: "apartment",
    rooms: [room("e1", "entrance", [])],
    dpeZones: { windows: { state: "poor" } },
    costs,
  });
  const winRef = ref.items.find((i) => i.id === "energy:windows");
  assert.ok(win.min > winRef.min);
});

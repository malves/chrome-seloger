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
import { computeHomeHealth } from "../src/lib/works/works-estimate.js";
import { estimateQuantities, globalVariant, globalWork } from "../src/lib/works/works-global.js";

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
  assert.equal(Math.round(kitchen.min), Math.round(surface * costs.renovationRates.min * costs.interiorPostShares.kitchen * intensity.min));
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
  const all = estimateWorksCosts({ surface: 50, propertyType: "apartment", rooms: [room("r", "living_room", ["walls_damaged", "paint"])], dpeZones: {}, costs });
  assert.ok(Math.abs(one.byRoom.r.max - all.byRoom.r.max) < 1);
});

test("plafond intérieur : total max des pièces ≤ surface × enveloppe pièces (+ énergie éventuelle)", () => {
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
  assert.ok(interiorMax <= 80 * costs.renovationRates.max + 1, `intérieur max ${interiorMax}`);
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

/* --------------------------- Logement entier --------------------------- */

const homeRooms = [room("l", "living_room", []), room("b1", "bedroom", []), room("b2", "bedroom", []), room("k", "kitchen", [])];
const globalItem = (key, over = {}) => ({ key, enabled: true, variant: undefined, quantity: null, source: "user", reason: "", ...over });

function estimateGlobal(globalItems, extra = {}) {
  return estimateWorksCosts({ surface: 70, propertyType: "apartment", rooms: homeRooms, globalItems, dpeZones: {}, costs, ...extra });
}

test("fenêtres : « Toutes » chiffre le nombre estimé, un nombre précis le remplace", () => {
  const { windows } = estimateQuantities({ rooms: homeRooms, surface: 70 });
  const variant = globalVariant(globalWork("windows"), "double");
  const all = estimateGlobal([globalItem("windows", { variant: "double" })]).items.find((i) => i.id === "global:windows");
  assert.equal(all.quantity, windows.count);
  assert.equal(all.estimated, true);
  assert.equal(all.min, variant.min * windows.count);
  assert.equal(all.max, variant.max * windows.count);

  const two = estimateGlobal([globalItem("windows", { variant: "double", quantity: 2 })]).items.find((i) => i.id === "global:windows");
  assert.equal(two.quantity, 2);
  assert.equal(two.estimated, false);
  assert.equal(two.min, variant.min * 2);
  assert.match(globalWork("windows").note, /prix moyen/i);
});

test("électricité : mise en sécurité au forfait, réfection complète au m²", () => {
  const safety = estimateGlobal([globalItem("electricity", { variant: "safety" })]).items.find((i) => i.key === "electricity");
  const full = estimateGlobal([globalItem("electricity", { variant: "full" })]).items.find((i) => i.key === "electricity");
  const fullVariant = globalVariant(globalWork("electricity"), "full");
  assert.equal(safety.mode, "flat");
  assert.equal(full.mode, "surface");
  assert.equal(full.min, fullVariant.min * 70);
  assert.ok(full.min > safety.max);
  assert.equal(full.roomIds.length, 0, "chantier global : rattaché à aucune pièce");
});

test("chantier global hors plafond des pièces, décoché = non chiffré", () => {
  const all = [...ROOM_ISSUE_KEYS];
  const rooms = [room("r1", "living_dining_room", all), room("r2", "kitchen", all), room("r3", "bathroom", all)];
  const base = estimateGlobal([], { rooms });
  const withElec = estimateGlobal([globalItem("electricity", { variant: "full" })], { rooms });
  assert.ok(withElec.items.some((i) => i.key === "electricity"));
  assert.deepEqual(withElec.byRoom, base.byRoom, "l'électricité s'ajoute sans réduire les pièces");
  assert.ok(withElec.max > base.max);
  const off = estimateGlobal([globalItem("electricity", { enabled: false, variant: "full" })], { rooms });
  assert.equal(off.max, base.max);
});

test("préparation et imprévus : pourcentages appliqués en dernier, sans cumul", () => {
  const works = [globalItem("electricity", { variant: "full" }), globalItem("windows", { variant: "double" })];
  const sum = (est, k) => est.items.reduce((s, i) => s + i[k], 0);
  const base = estimateGlobal(works);
  const est = estimateGlobal([...works, globalItem("preparation"), globalItem("contingency")]);
  const prep = est.items.find((i) => i.key === "preparation");
  const cont = est.items.find((i) => i.key === "contingency");
  assert.ok(prep.rate && cont.rate);
  assert.equal(prep.min, sum(base, "min") * prep.rate.min, "préparation : sur les travaux, pas sur les imprévus");
  assert.equal(cont.max, sum(base, "max") * cont.rate.max);
  assert.equal(est.items.at(-1).key, "contingency");
  assert.ok(Math.abs(sum(est, "max") - sum(base, "max") * (1 + prep.rate.max + cont.rate.max)) < 1);
  assert.equal(estimateGlobal([globalItem("preparation"), globalItem("contingency")]).max, 0, "sans travaux : rien à majorer");
});

test("DPE fenêtres faibles : la ligne énergie s'efface dès que le chantier est coché ou écarté", () => {
  const dpeZones = { windows: { state: "poor" }, ventilation: { state: "poor" } };
  const ids = (globalItems) => estimateGlobal(globalItems, { dpeZones }).items.map((i) => i.id);
  assert.ok(ids([]).includes("energy:windows"));
  assert.ok(!ids([globalItem("windows")]).includes("energy:windows"));
  const declined = ids([globalItem("windows", { enabled: false })]);
  assert.ok(!declined.includes("energy:windows"), "écarté : l'utilisateur a tranché");
  assert.ok(!declined.includes("global:windows"));
  assert.ok(declined.includes("energy:ventilation"), "les autres zones DPE restent en repli");
});

test("état général : électricité et plomberie à refaire pèsent sur le score", () => {
  const rooms = [room("l", "living_room", [], "good")];
  const base = computeHomeHealth({ rooms }).score;
  const safety = computeHomeHealth({ rooms, globalItems: [globalItem("electricity", { variant: "safety" })] }).score;
  const full = computeHomeHealth({ rooms, globalItems: [globalItem("electricity", { variant: "full" }), globalItem("plumbing")] }).score;
  assert.ok(base > safety && safety > full);
  assert.equal(computeHomeHealth({ rooms, globalItems: [globalItem("electricity", { enabled: false })] }).score, base);
});

test("eau chaude : trois variantes cliquables, thermodynamique nettement plus cher que le ballon électrique", () => {
  const line = (variant) =>
    estimateGlobal([globalItem("hot_water", { variant })]).items.find((i) => i.key === "hot_water");
  const electric = line("electric");
  const thermo = line("thermodynamic");
  const gas = line("gas");
  assert.equal(electric.variant, "electric");
  assert.ok(thermo.min > electric.max);
  assert.ok(gas.min >= electric.min && gas.max <= thermo.min);
});

test("maison : chantiers propres à la maison proposés, absents en appartement", () => {
  const house = estimateGlobal([globalItem("sanitation"), globalItem("heating", { variant: "heat_pump" })], { propertyType: "house" });
  assert.ok(house.items.some((i) => i.key === "sanitation"));
  assert.ok(house.items.some((i) => i.key === "heating" && i.variant === "heat_pump"));
  const flat = estimateGlobal([globalItem("sanitation")]);
  assert.ok(!flat.items.some((i) => i.key === "sanitation"));
});

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
  fixtureSurfaceFactor,
  roomFloorArea,
  validateEstimateBarème,
  wallArea,
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

test("surface de pièce : part du logement ramenée à une fourchette plausible pour son type", () => {
  const plan = [room("b1", "bedroom", ["paint"]), room("l1", "living_room", [])];
  const big = estimateWorksCosts({ surface: 80, propertyType: "apartment", rooms: plan, dpeZones: {}, costs });
  const small = estimateWorksCosts({ surface: 30, propertyType: "apartment", rooms: plan, dpeZones: {}, costs });
  assert.ok(big.max > small.max, "plus grand logement : chambre plus grande");
  assert.equal(roomFloorArea("bedroom", 80, 1 / 2.4), 16, "plafond du type");
  assert.equal(roomFloorArea("bedroom", 30, 1 / 2.4), 12.5);
  assert.equal(roomFloorArea("bedroom", 10, 0.1), 9, "plancher du type");
  assert.equal(roomFloorArea("bedroom", 5, 1), 5, "jamais plus que le logement");
});

test("chambre de 12 m², murs à repeindre : environ 600 à 1 000 €", () => {
  const est = estimateWorksCosts({
    surface: 12,
    propertyType: "apartment",
    rooms: [room("b1", "bedroom", ["paint"])],
    dpeZones: {},
    costs,
  });
  const paint = est.items.find((i) => i.id === "issue:paint");
  const walls = wallArea(12);
  assert.ok(walls > 28 && walls < 31, `murs ${walls} m²`);
  assert.equal(paint.min, 20 * walls);
  assert.equal(paint.max, 35 * walls);
  assert.ok(est.min >= 500 && est.max <= 1100, `${est.min}–${est.max}`);
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
  assert.ok(kitchenHeavy.min >= 10000, `cuisine lourde 80 m² : ${kitchenHeavy.min}`);
});

test("cuisine à refaire : forfait modulé par la surface, sans dilution par le séjour", () => {
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
  const factor = fixtureSurfaceFactor(surface);
  assert.equal(kitchen.min, costs.fixtureRates.kitchen.min * factor * intensity.min);
  assert.equal(kitchen.max, costs.fixtureRates.kitchen.max * factor * intensity.max);
  assert.deepEqual(kitchen.roomIds, ["k1"]);
  assert.equal(est.byRoom.k1.min, kitchen.min);
});

function kitchenRedo(surface) {
  const est = estimateWorksCosts({
    surface,
    propertyType: surface > 100 ? "house" : "apartment",
    rooms: [room("k1", "kitchen", ["kitchen_redo"])],
    dpeZones: {},
    costs,
  });
  return est.items.find((i) => i.id === "issue:kitchen_redo");
}

test("forfait cuisine : un studio coûte moins, une grande maison plus, de façon sous-linéaire", () => {
  const studio = kitchenRedo(20);
  const ref = kitchenRedo(70);
  const house = kitchenRedo(400);
  assert.ok(studio.max < ref.max && ref.max < house.max);
  assert.ok(house.max / studio.max < 5, `rapport ${house.max / studio.max}`);
  assert.equal(fixtureSurfaceFactor(70), 1);
  assert.equal(fixtureSurfaceFactor(5), 0.6);
  assert.equal(fixtureSurfaceFactor(2000), 2.5);
});

test("salles d'eau : un forfait par pièce, WC moins cher qu'une salle de bain", () => {
  const est = (rooms) => estimateWorksCosts({ surface: 120, propertyType: "house", rooms, dpeZones: {}, costs });
  const one = est([room("b1", "bathroom", ["bathroom_redo"])]);
  const two = est([room("b1", "bathroom", ["bathroom_redo"]), room("b2", "bathroom", ["bathroom_redo"])]);
  const line = (e) => e.items.find((i) => i.id === "issue:bathroom_redo");
  assert.equal(line(two).max, 2 * line(one).max);
  const wc = est([room("b1", "bathroom", ["bathroom_redo"]), room("w1", "toilet", ["bathroom_redo"])]);
  assert.ok(wc.byRoom.w1.max < wc.byRoom.b1.max);
});

test("sol, murs, plafond, humidité : prix unitaire × surface estimée de la pièce", () => {
  const surface = 80;
  const est = estimateWorksCosts({
    surface,
    propertyType: "apartment",
    rooms: [room("l1", "living_room", ["floor_redo", "walls_damaged", "ceiling_paint", "humidity"])],
    dpeZones: {},
    costs,
  });
  const floor = roomFloorArea("living_room", surface, 1);
  const line = (k) => est.items.find((i) => i.id === "issue:" + k);
  const { floor_redo: f, walls_damaged: w, ceiling_paint: c, humidity: h } = costs.issueIntensity;
  assert.equal(floor, 40);
  assert.equal(line("floor_redo").max, f.max * floor);
  assert.equal(line("walls_damaged").min, w.min * wallArea(floor));
  assert.equal(line("ceiling_paint").max, c.max * floor);
  assert.equal(line("humidity").min, h.min, "forfait par pièce");
});

test("forfait cuisine : refaire et rafraîchir cochés ne dépassent pas le forfait", () => {
  const all = [...ROOM_ISSUE_KEYS];
  const est = estimateWorksCosts({
    surface: 30,
    propertyType: "apartment",
    rooms: [room("k1", "kitchen", all, "heavy_renovation_likely")],
    dpeZones: {},
    costs,
  });
  const kitchen = est.items.filter((i) => i.post === "kitchen").reduce((s, i) => s + i.max, 0);
  assert.ok(Math.abs(kitchen - costs.fixtureRates.kitchen.max * fixtureSurfaceFactor(30)) < 0.01);
});

test("salle d'eau à refaire : sol, murs et plafond inclus, pas facturés en plus", () => {
  const est = (issues) =>
    estimateWorksCosts({ surface: 70, propertyType: "apartment", rooms: [room("b1", "bathroom", issues)], dpeZones: {}, costs });
  const alone = est(["bathroom_redo"]);
  const withSurfaces = est(["bathroom_redo", "floor_redo", "walls_damaged", "ceiling_paint", "humidity"]);
  const humidity = withSurfaces.items.find((i) => i.id === "issue:humidity");
  assert.ok(humidity, "l'humidité reste chiffrée à part");
  assert.equal(withSurfaces.byRoom.b1.max - humidity.max, alone.byRoom.b1.max);
  assert.ok(!withSurfaces.items.some((i) => ["issue:floor_redo", "issue:walls_damaged", "issue:ceiling_paint"].includes(i.id)));
});

test("salle d'eau à rafraîchir : peinture incluse, murs à refaire toujours chiffrés", () => {
  const est = (issues) =>
    estimateWorksCosts({ surface: 70, propertyType: "apartment", rooms: [room("b1", "bathroom", issues)], dpeZones: {}, costs });
  assert.equal(est(["bathroom_refresh", "paint", "ceiling_paint"]).byRoom.b1.max, est(["bathroom_refresh"]).byRoom.b1.max);
  const damaged = est(["bathroom_refresh", "walls_damaged"]);
  assert.ok(damaged.items.some((i) => i.id === "issue:walls_damaged"));
  assert.ok(damaged.byRoom.b1.max > est(["bathroom_refresh"]).byRoom.b1.max);
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

test("pièces : la somme par pièce égale celle des postes intérieurs", () => {
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
  const roomPosts = est.posts.filter((p) => p.key !== "energy");
  const interiorMax = roomPosts.reduce((s, p) => s + p.max, 0);
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

test("eau chaude cochée : forfait modulé par la surface, borné pour une grande maison", () => {
  const variant = globalVariant(globalWork("hot_water"), "electric");
  const line = (surface) =>
    estimateGlobal([globalItem("hot_water", { variant: "electric" })], { surface }).items.find((i) => i.key === "hot_water");
  assert.equal(line(70).max, variant.max);
  assert.equal(line(20).max, variant.max * 0.6);
  assert.equal(line(400).max, variant.max * 1.6);
  assert.equal(line(400).detail, "forfait pour 400 m²");
});

test("DPE en repli : équipements modulés et bornés, isolation proportionnelle à la surface", () => {
  const dpeZones = { hotWater: { state: "poor" }, walls: { state: "poor" } };
  const line = (surface, id) =>
    estimateWorksCosts({ surface, propertyType: "house", rooms: [room("e1", "entrance", [])], dpeZones, costs }).items.find(
      (i) => i.id === "energy:" + id
    );
  assert.equal(line(400, "hotWater").max, ENERGY_COSTS.hotWater.max * 1.6);
  assert.equal(line(20, "hotWater").min, ENERGY_COSTS.hotWater.min * 0.6);
  assert.ok(Math.abs(line(140, "walls").max - ENERGY_COSTS.walls.max * 2) < 0.01);
});

test("maison : chantiers propres à la maison proposés, absents en appartement", () => {
  const house = estimateGlobal([globalItem("sanitation"), globalItem("heating", { variant: "heat_pump" })], { propertyType: "house" });
  assert.ok(house.items.some((i) => i.key === "sanitation"));
  assert.ok(house.items.some((i) => i.key === "heating" && i.variant === "heat_pump"));
  const flat = estimateGlobal([globalItem("sanitation")]);
  assert.ok(!flat.items.some((i) => i.key === "sanitation"));
});

import test from "node:test";
import assert from "node:assert/strict";
import { buildDpeInsights } from "../src/lib/dpe-insights.js";
import { dominantApparentAge } from "../src/lib/photo-analysis/dpe-correlation.js";
import { dpeCoherence } from "../src/lib/works/works-coherence.js";

function dpeOf(raw, extra = {}) {
  const insights = buildDpeInsights({ numero_dpe: "DPE-T", raw, ...extra });
  return { letter: null, zones: insights.zones, date: insights.dateEtablissement };
}

const room = (issues = []) => ({ id: "r1", type: "living_room", condition: "average", issues });

test("dominantApparentAge : pondère par la confiance", () => {
  const age = dominantApparentAge(
    [
      { windows: { apparent_age: "dated", confidence: 0.4 } },
      { windows: { apparent_age: "recent", confidence: 0.9 } },
      { windows: { apparent_age: "unknown", confidence: 1 } },
    ],
    "windows"
  );
  assert.equal(age, "recent");
  assert.equal(dominantApparentAge([], "windows"), "unknown");
});

const windowsPlanned = (enabled = true) => [{ key: "windows", enabled }];

test("fenêtres prévues (logement entier) + menuiseries insuffisantes → cohérent", () => {
  const [windows] = dpeCoherence({
    rooms: [room()],
    globalItems: windowsPlanned(),
    dpe: dpeOf({ qualite_isolation_menuiseries: "insuffisante" }),
  });
  assert.equal(windows.topic, "windows");
  assert.equal(windows.status, "consistent");
  assert.equal(windows.title, "Fenêtres et DPE");
  assert.equal(windows.tone, "good");
});

test("fenêtres écartées dans le plan : le plan prime sur l'âge vu en photo", () => {
  const [windows] = dpeCoherence({
    rooms: [room()],
    globalItems: windowsPlanned(false),
    dpe: dpeOf({ qualite_isolation_menuiseries: "insuffisante" }),
    photoSignals: { windowsAge: "dated" },
  });
  assert.equal(windows.status, "to_check");
  assert.match(windows.text, /n'est pas prévu dans « Général »/);
});

test("ventilation prévue : plus d'alerte humidité × DPE", () => {
  const dpe = dpeOf({ qualite_isolation_menuiseries: "bonne" });
  dpe.zones = [{ id: "ventilation", state: "poor" }];
  const humid = [room(["humidity"])];
  assert.ok(dpeCoherence({ rooms: humid, dpe }).some((c) => c.topic === "ventilation"));
  assert.ok(!dpeCoherence({ rooms: humid, globalItems: [{ key: "ventilation", enabled: true }], dpe }).some((c) => c.topic === "ventilation"));
});

test("fenêtres récentes en photo, rien dans le plan + DPE faible → rénovation possible après le DPE", () => {
  const [windows] = dpeCoherence({
    rooms: [room()],
    dpe: dpeOf({ qualite_isolation_menuiseries: "insuffisante", date_etablissement_dpe: "2019-03-04" }),
    photoSignals: { windowsAge: "recent" },
  });
  assert.equal(windows.status, "possible_post_dpe_renovation");
  assert.match(windows.text, /2019/);
});

test("sans DPE → rien", () => {
  assert.deepEqual(dpeCoherence({ rooms: [room()], globalItems: windowsPlanned(), dpe: null }), []);
});

test("chauffage : radiateurs à eau visibles + DPE électrique → écart à vérifier", () => {
  const heating = dpeCoherence({
    rooms: [room()],
    dpe: dpeOf({ type_energie_principale_chauffage: "Électricité" }),
    photoSignals: { heatingEquipments: ["water_radiator"] },
  }).find((c) => c.topic === "heating");
  assert.equal(heating.status, "possible_post_dpe_renovation");
});

test("chauffage : convecteurs visibles + DPE électrique → cohérent", () => {
  const heating = dpeCoherence({
    rooms: [room()],
    dpe: dpeOf({ type_energie_principale_chauffage: "Électricité" }),
    photoSignals: { heatingEquipments: ["electric_convector"] },
  }).find((c) => c.topic === "heating");
  assert.equal(heating.status, "consistent");
});

test("score des pièces élevé et DPE G → rénovation surtout esthétique", () => {
  const checks = dpeCoherence({
    rooms: [room()],
    health: { score: 85, fromPlan: true },
    dpe: { letter: "G", zones: [] },
  });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].topic, "label");
  assert.equal(checks[0].status, "to_check");
});

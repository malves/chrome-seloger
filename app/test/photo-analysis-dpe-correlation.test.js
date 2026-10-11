import test from "node:test";
import assert from "node:assert/strict";
import { buildDpeInsights } from "../src/lib/dpe-insights.js";
import {
  dpeCorrelations,
  dominantApparentAge,
} from "../src/lib/photo-analysis/dpe-correlation.js";

function analysisWith(windowsAge, heating = null) {
  return {
    rooms: [
      {
        room_id: "room_01",
        room_type: "living_room",
        windows: { apparent_age: windowsAge, confidence: 0.8 },
        heating,
      },
    ],
  };
}

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

test("fenêtres anciennes + menuiseries insuffisantes → cohérent", () => {
  const dpe = buildDpeInsights({
    numero_dpe: "DPE-1",
    raw: { qualite_isolation_menuiseries: "insuffisante" },
  });
  const [windows] = dpeCorrelations(analysisWith("dated"), dpe);
  assert.equal(windows.topic, "windows");
  assert.equal(windows.status, "consistent");
  assert.match(windows.text, /cohérent/);
});

test("fenêtres récentes + DPE faible → rénovation possible après le DPE", () => {
  const dpe = buildDpeInsights({
    numero_dpe: "DPE-2",
    raw: {
      qualite_isolation_menuiseries: "insuffisante",
      date_etablissement_dpe: "2019-03-04",
    },
  });
  const [windows] = dpeCorrelations(analysisWith("recent"), dpe);
  assert.equal(windows.status, "possible_post_dpe_renovation");
  assert.match(windows.text, /4 mars 2019/);
});

test("fenêtres non évaluables → non concluant ; sans DPE → rien", () => {
  const dpe = buildDpeInsights({
    numero_dpe: "DPE-3",
    raw: { qualite_isolation_menuiseries: "bonne" },
  });
  const [windows] = dpeCorrelations(analysisWith("unknown"), dpe);
  assert.equal(windows.status, "inconclusive");
  assert.deepEqual(dpeCorrelations(analysisWith("dated"), null), []);
  assert.deepEqual(dpeCorrelations({ rooms: [] }, dpe), []);
});

test("chauffage : convecteurs anciens + DPE électrique → cohérent, modernisation possible", () => {
  const dpe = buildDpeInsights({
    numero_dpe: "DPE-4",
    type_batiment: "appartement",
    raw: { type_energie_principale_chauffage: "Électricité" },
  });
  const correlations = dpeCorrelations(
    analysisWith("unknown", { equipment: "electric_convector", apparent_age: "very_dated", confidence: 0.9 }),
    dpe
  );
  const heating = correlations.find((c) => c.topic === "heating");
  assert.equal(heating.status, "consistent");
  assert.match(heating.text, /modernisation/);
});

test("chauffage : radiateurs à eau visibles + DPE électrique → écart à vérifier", () => {
  const dpe = buildDpeInsights({
    numero_dpe: "DPE-5",
    raw: { type_energie_principale_chauffage: "Électricité" },
  });
  const heating = dpeCorrelations(
    analysisWith("unknown", { equipment: "water_radiator", apparent_age: "unknown", confidence: 0.8 }),
    dpe
  ).find((c) => c.topic === "heating");
  assert.equal(heating.status, "possible_post_dpe_renovation");
});

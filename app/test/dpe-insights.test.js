import test from "node:test";
import assert from "node:assert/strict";
import { buildDpeInsights, ZONE_IDS } from "../src/lib/dpe-insights.js";

function zone(insights, id) {
  return insights.zones.find((z) => z.id === id);
}

test("buildDpeInsights : une zone par partie du logement, dans l'ordre", () => {
  const insights = buildDpeInsights({ numero_dpe: "DPE-0", raw: {} });
  assert.deepEqual(
    insights.zones.map((z) => z.id),
    ZONE_IDS
  );
  assert.ok(insights.zones.every((z) => z.state === "unknown"));
  assert.equal(insights.counts.unknown, ZONE_IDS.length);
  assert.equal(insights.hero.budget, null);
});

test("buildDpeInsights : logement énergivore", () => {
  const insights = buildDpeInsights({
    numero_dpe: "DPE-1",
    etiquette_dpe: "F",
    etiquette_ges: "E",
    type_batiment: "maison",
    raw: {
      qualite_isolation_murs: "insuffisante",
      qualite_isolation_menuiseries: "moyenne",
      type_energie_principale_chauffage: "Fioul domestique",
      deperditions_enveloppe: 200,
      deperditions_murs: 90,
      cout_total_5_usages: 3210,
    },
  });

  assert.equal(insights.hero.dpe.letter, "F");
  assert.equal(insights.hero.tone, "poor");
  assert.equal(zone(insights, "walls").state, "poor");
  assert.match(zone(insights, "walls").detail, /45 %/);
  assert.equal(zone(insights, "windows").state, "average");
  assert.equal(zone(insights, "heating").state, "poor");
  assert.equal(zone(insights, "floor").state, "unknown");
  assert.equal(insights.hero.budget.annual, 3200);
  assert.equal(insights.hero.budget.monthly, 270);
  assert.equal(insights.hero.budget.tone, "poor");
  assert.equal(insights.counts.poor, 2);
});

test("buildDpeInsights : bon bilan et appartement sans toit renseigné", () => {
  const insights = buildDpeInsights({
    numero_dpe: "DPE-2",
    etiquette_dpe: "B",
    etiquette_ges: "A",
    type_batiment: "appartement",
    raw: {
      qualite_isolation_enveloppe: "bonne",
      type_energie_principale_chauffage: "Réseau de Chauffage urbain",
      ventilation_posterieure_2012: "1",
      cout_total_5_usages: 640,
    },
  });

  assert.equal(insights.hero.tone, "good");
  assert.equal(zone(insights, "walls").state, "good");
  assert.equal(zone(insights, "heating").state, "good");
  assert.equal(zone(insights, "ventilation").state, "good");
  assert.match(zone(insights, "roof").title, /Non concerné/);
  assert.equal(insights.hero.budget.tone, "good");
  assert.equal(insights.counts.poor, 0);
});

test("buildDpeInsights : chauffage gaz en appartement collectif — pas de PAC air/eau", () => {
  const insights = buildDpeInsights({
    numero_dpe: "DPE-3",
    type_batiment: "appartement",
    raw: {
      type_energie_principale_chauffage: "Gaz naturel",
      type_installation_chauffage: "installation collective",
    },
  });

  const heating = zone(insights, "heating");
  assert.equal(heating.state, "average");
  assert.match(heating.advice, /copropriété|chaufferie/i);
  assert.doesNotMatch(heating.advice, /air\/eau/i);
});

test("buildDpeInsights : murs mal isolés en appartement — ITI et copro, pas ITE maison", () => {
  const insights = buildDpeInsights({
    numero_dpe: "DPE-4",
    type_batiment: "appartement",
    raw: {
      qualite_isolation_murs: "insuffisante",
      deperditions_enveloppe: 100,
      deperditions_murs: 40,
    },
  });

  const walls = zone(insights, "walls");
  assert.equal(walls.state, "poor");
  assert.match(walls.advice, /intérieur|ITI/i);
  assert.match(walls.advice, /copropriété/i);
  assert.doesNotMatch(walls.advice, /par l'extérieur \(ITE\) idéalement/i);
});

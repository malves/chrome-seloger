import test from "node:test";
import assert from "node:assert/strict";
import createAddressAiService, {
  needsDepartmentFallback,
  periodContainsYear,
} from "../src/services/address-ai.service.js";

/** Repo factice : capture les filtres reçus et renvoie des DPE prédéfinis. */
function stubRepositories(records, capture) {
  return {
    dpe: {
      searchAddressCandidates(filters) {
        if (capture) capture.filters = filters;
        return records;
      },
    },
  };
}

function dpeRecord(overrides = {}) {
  const { raw, ...columns } = overrides;
  return {
    numero_dpe: "DPE-" + Math.random().toString(36).slice(2),
    etiquette_dpe: null,
    etiquette_ges: null,
    type_batiment: "appartement",
    annee_construction: null,
    surface_habitable_logement: null,
    adresse_ban: null,
    adresse_brut: null,
    nom_commune_ban: null,
    code_postal_ban: "75011",
    ...columns,
    raw: raw || {},
  };
}

const APARTMENT = {
  id: 1,
  property_type: "apartment",
  postal_code: "75011",
  surface: 50,
  dpe: "D",
  ges: "C",
  floor: 3,
  year_built: 1970,
};

test("search : prérequis manquants (pas de surface) → aucun candidat", () => {
  const service = createAddressAiService({
    repositories: stubRepositories([]),
  });
  const result = service.search({
    id: 1,
    property_type: "house",
    postal_code: "75011",
  });
  assert.equal(result.mode, "precise");
  assert.ok(result.champsRequisManquants.includes("surfaceM2"));
  assert.deepEqual(result.candidates, []);
});

test("search : filtres stricts transmis au repo (appartement + immeuble, surface ±3%)", () => {
  const capture = { calls: [] };
  const service = createAddressAiService({
    repositories: {
      dpe: {
        searchAddressCandidates(filters) {
          capture.calls.push({ ...filters });
          return [];
        },
      },
    },
  });
  service.search(APARTMENT);
  assert.equal(capture.calls[0].codePostal, "75011");
  assert.deepEqual(capture.calls[0].typeBatiments, ["appartement", "immeuble"]);
  assert.equal(capture.calls[0].surfaceMin, 50 * 0.97);
  assert.equal(capture.calls[0].surfaceMax, 50 * 1.03);
  assert.equal(capture.calls[1].departement, "75");
});

test("search : regroupement par adresse, meilleur score retenu, tri décroissant", () => {
  const records = [
    // Adresse A, concordance totale.
    dpeRecord({
      adresse_ban: "10 Rue A 75011 Paris",
      nom_commune_ban: "Paris",
      surface_habitable_logement: 50,
      etiquette_dpe: "D",
      etiquette_ges: "C",
      annee_construction: 1970,
      raw: { complement_adresse_logement: "3ème étage" },
    }),
    // Adresse A, moins bonne (GES et étage différents) → même groupe.
    dpeRecord({
      adresse_ban: "10 Rue A 75011 Paris",
      nom_commune_ban: "Paris",
      surface_habitable_logement: 50,
      etiquette_dpe: "D",
      etiquette_ges: "B",
      annee_construction: 1970,
      raw: { numero_etage_appartement: 2 },
    }),
    // Adresse B, concordance partielle.
    dpeRecord({
      adresse_ban: "20 Rue B 75011 Paris",
      nom_commune_ban: "Paris",
      surface_habitable_logement: 49,
      etiquette_dpe: "E",
      etiquette_ges: "C",
      annee_construction: 2000,
      raw: {},
    }),
  ];
  const service = createAddressAiService({
    repositories: stubRepositories(records),
  });

  const { candidates } = service.search(APARTMENT);
  assert.equal(candidates.length, 2);

  const [first, second] = candidates;
  assert.equal(first.street, "10 Rue A");
  assert.equal(first.locality, "75011 Paris");
  assert.equal(first.confidence, 95);
  assert.equal(first.dpeCount, 2);
  assert.equal(first.matched.floor, true);

  assert.equal(second.street, "20 Rue B");
  assert.ok(second.confidence < first.confidence);
});

test("periodContainsYear : plages et bornes avant/après", () => {
  assert.equal(periodContainsYear("1948-1974", 1960), true);
  assert.equal(periodContainsYear("1948-1974", 1948), true);
  assert.equal(periodContainsYear("1948-1974", 1974), true);
  assert.equal(periodContainsYear("1948-1974", 1975), false);
  assert.equal(periodContainsYear("avant 1948", 1930), true);
  assert.equal(periodContainsYear("avant 1948", 1960), false);
  assert.equal(periodContainsYear("après 2021", 2023), true);
  assert.equal(periodContainsYear("après 2021", 2000), false);
  assert.equal(periodContainsYear(null, 1960), false);
  assert.equal(periodContainsYear("1948-1974", null), false);
});

test("search : l'année approximative matche la période de construction", () => {
  const base = {
    adresse_ban: "1 Rue P 92210 Saint-Cloud",
    nom_commune_ban: "Saint-Cloud",
    code_postal_ban: "92210",
    surface_habitable_logement: 50,
    etiquette_dpe: "D",
    etiquette_ges: "C",
    annee_construction: null,
  };
  const listing = {
    id: 1,
    property_type: "apartment",
    postal_code: "92210",
    surface: 50,
    dpe: "D",
    ges: "C",
    year_built: 1960,
  };

  const withPeriod = createAddressAiService({
    repositories: stubRepositories([
      dpeRecord({ ...base, raw: { periode_construction: "1948-1974" } }),
    ]),
  }).search(listing);

  const withoutPeriod = createAddressAiService({
    repositories: stubRepositories([dpeRecord({ ...base, raw: {} })]),
  }).search(listing);

  assert.equal(withPeriod.candidates[0].matched.year, true);
  assert.equal(withoutPeriod.candidates[0].matched.year, false);
  assert.ok(
    withPeriod.candidates[0].confidence > withoutPeriod.candidates[0].confidence
  );
});

test("search : l'étage parsé depuis le complément d'adresse booste le score", () => {
  const withFloorText = dpeRecord({
    adresse_ban: "1 Rue C 75011 Paris",
    nom_commune_ban: "Paris",
    surface_habitable_logement: 50,
    etiquette_dpe: "D",
    etiquette_ges: "C",
    annee_construction: 1970,
    raw: { complement_adresse_logement: "3ème étage à gauche" },
  });
  const service = createAddressAiService({
    repositories: stubRepositories([withFloorText]),
  });
  const { candidates } = service.search(APARTMENT);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].matched.floor, true);
  assert.equal(candidates[0].confidence, 95);
});

test("needsDepartmentFallback : vide ou confiances toutes basses", () => {
  assert.equal(needsDepartmentFallback([]), true);
  assert.equal(needsDepartmentFallback([{ confidence: 49 }]), true);
  assert.equal(needsDepartmentFallback([{ confidence: 40 }, { confidence: 45 }]), true);
  assert.equal(needsDepartmentFallback([{ confidence: 55 }]), false);
  assert.equal(needsDepartmentFallback([{ confidence: 40 }, { confidence: 60 }]), false);
});

test("search : repli département si le CP ne renvoie rien", () => {
  const deptRecord = dpeRecord({
    adresse_ban: "1 Avenue Dept 92100 Boulogne-Billancourt",
    nom_commune_ban: "Boulogne-Billancourt",
    code_postal_ban: "92100",
    surface_habitable_logement: 50,
    etiquette_dpe: "D",
    etiquette_ges: "C",
    annee_construction: 1970,
    raw: { complement_adresse_logement: "3ème étage" },
  });
  const calls = [];
  const service = createAddressAiService({
    repositories: {
      dpe: {
        searchAddressCandidates(filters) {
          calls.push({ ...filters });
          if (filters.codePostal === "92210") return [];
          if (filters.departement === "92") return [deptRecord];
          return [];
        },
      },
    },
  });

  const listing = { ...APARTMENT, postal_code: "92210" };
  const result = service.search(listing);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].codePostal, "92210");
  assert.equal(calls[1].departement, "92");
  assert.equal(result.mode, "departement");
  assert.equal(result.fallbackFrom, "precise");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].postalCode, "92100");
});

test("search : repli département si toutes les confiances CP sont faibles", () => {
  const weakCp = dpeRecord({
    adresse_ban: "2 Rue Faible 92210 Saint-Cloud",
    nom_commune_ban: "Saint-Cloud",
    code_postal_ban: "92210",
    surface_habitable_logement: 50,
    etiquette_dpe: "G",
    etiquette_ges: "G",
    annee_construction: 2010,
    raw: {},
  });
  const strongDept = dpeRecord({
    adresse_ban: "10 Rue Forte 92100 Boulogne-Billancourt",
    nom_commune_ban: "Boulogne-Billancourt",
    code_postal_ban: "92100",
    surface_habitable_logement: 50,
    etiquette_dpe: "D",
    etiquette_ges: "C",
    annee_construction: 1970,
    raw: { complement_adresse_logement: "3ème étage" },
  });
  const service = createAddressAiService({
    repositories: {
      dpe: {
        searchAddressCandidates(filters) {
          if (filters.codePostal === "92210") return [weakCp];
          if (filters.departement === "92") return [strongDept];
          return [];
        },
      },
    },
  });

  const listing = { ...APARTMENT, postal_code: "92210" };
  const result = service.search(listing);

  assert.equal(result.mode, "departement");
  assert.ok(result.candidates[0].confidence >= 50);
  assert.equal(result.candidates[0].street, "10 Rue Forte");
});

test("search : pas de second appel département si le CP suffit", () => {
  let callCount = 0;
  const good = dpeRecord({
    adresse_ban: "1 Rue OK 92210 Saint-Cloud",
    nom_commune_ban: "Saint-Cloud",
    code_postal_ban: "92210",
    surface_habitable_logement: 50,
    etiquette_dpe: "D",
    etiquette_ges: "C",
    annee_construction: 1970,
    raw: { complement_adresse_logement: "3ème étage" },
  });
  const service = createAddressAiService({
    repositories: {
      dpe: {
        searchAddressCandidates() {
          callCount += 1;
          return [good];
        },
      },
    },
  });

  const result = service.search({ ...APARTMENT, postal_code: "92210" });
  assert.equal(callCount, 1);
  assert.equal(result.mode, "precise");
});

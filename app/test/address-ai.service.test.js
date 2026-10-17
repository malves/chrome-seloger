import test from "node:test";
import assert from "node:assert/strict";
import createAddressAiService, {
  compareDpeDateDesc,
  enrichAddressAiCandidateMaps,
  needsDepartmentFallback,
  periodContainsYear,
} from "../src/services/address-ai.service.js";
import { googleMapsSearchUrl } from "../src/lib/google-maps-url.js";

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
  const result = service.search(APARTMENT);
  assert.equal(capture.calls[0].codePostal, "75011");
  assert.deepEqual(capture.calls[0].typeBatiments, ["appartement", "immeuble"]);
  assert.equal(capture.calls[0].surfaceMin, 50 * 0.97);
  assert.equal(capture.calls[0].surfaceMax, 50 * 1.03);
  assert.equal(capture.calls[1].departement, "75");
  assert.equal(result.recherches.length, 2);
  assert.equal(result.recherches[0].champ_territoire, "code_postal_ban");
  assert.equal(result.recherches[1].champ_territoire, "code_departement_ban");
  assert.ok(result.champsDpeParCritere["Surface (m²)"].includes("surface_habitable"));
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

test("compareDpeDateDesc : plus récent d'abord, dates absentes en dernier", () => {
  assert.ok(compareDpeDateDesc("2024-06-01", "2023-01-01") > 0);
  assert.ok(compareDpeDateDesc("2023-01-01", "2024-06-01") < 0);
  assert.equal(compareDpeDateDesc("2024-01-01", "2024-01-01"), 0);
  assert.ok(compareDpeDateDesc(null, "2024-01-01") < 0);
  assert.ok(compareDpeDateDesc("2024-01-01", null) > 0);
});

test("search : à confiance égale, adresse la plus récente (DPE) en premier", () => {
  const match = {
    surface_habitable_logement: 50,
    etiquette_dpe: "D",
    etiquette_ges: "C",
    annee_construction: 1970,
    raw: { complement_adresse_logement: "3ème étage" },
  };
  const service = createAddressAiService({
    repositories: stubRepositories([
      dpeRecord({
        adresse_ban: "10 Rue Ancienne 75011 Paris",
        nom_commune_ban: "Paris",
        date_derniere_modification_dpe: "2023-01-01",
        ...match,
      }),
      dpeRecord({
        adresse_ban: "20 Rue Récente 75011 Paris",
        nom_commune_ban: "Paris",
        date_derniere_modification_dpe: "2024-06-01",
        ...match,
      }),
    ]),
  });

  const { candidates } = service.search(APARTMENT);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].confidence, candidates[1].confidence);
  assert.equal(candidates[0].street, "20 Rue Récente");
  assert.equal(candidates[0].dpeDateModif, "2024-06-01");
});

test("search : même adresse, confiance égale → DPE modifié le plus récemment retenu", () => {
  const shared = {
    adresse_ban: "10 Rue A 75011 Paris",
    nom_commune_ban: "Paris",
    surface_habitable_logement: 50,
    etiquette_dpe: "D",
    etiquette_ges: "C",
    annee_construction: 1970,
    raw: { complement_adresse_logement: "3ème étage" },
  };
  const service = createAddressAiService({
    repositories: stubRepositories([
      dpeRecord({
        numero_dpe: "DPE-OLD",
        date_derniere_modification_dpe: "2023-01-01",
        ...shared,
      }),
      dpeRecord({
        numero_dpe: "DPE-NEW",
        date_derniere_modification_dpe: "2024-06-01",
        ...shared,
      }),
    ]),
  });

  const { candidates } = service.search(APARTMENT);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].numeroDpe, "DPE-NEW");
  assert.equal(candidates[0].dpeCount, 2);
});

test("search : dates DPE exposées dans source.dates (debug console)", () => {
  const service = createAddressAiService({
    repositories: stubRepositories([
      dpeRecord({
        adresse_ban: "10 Rue A 75011 Paris",
        nom_commune_ban: "Paris",
        surface_habitable_logement: 50,
        etiquette_dpe: "D",
        etiquette_ges: "C",
        date_etablissement_dpe: "2023-01-15",
        date_derniere_modification_dpe: "2024-02-01",
        raw: {
          complement_adresse_logement: "3ème étage",
          date_fin_validite_dpe: "2033-01-15",
          date_reception_dpe: "2023-01-16",
          date_visite_diagnostiqueur: "2023-01-10",
        },
      }),
    ]),
  });

  const { candidates } = service.search(APARTMENT);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].source.dates, {
    date_derniere_modification_dpe: "2024-02-01",
    date_etablissement_dpe: "2023-01-15",
    date_fin_validite_dpe: "2033-01-15",
    date_reception_dpe: "2023-01-16",
    date_visite_diagnostiqueur: "2023-01-10",
  });
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

test("search : la source d'énergie départage deux DPE identiques par ailleurs", () => {
  const base = {
    type_batiment: "maison",
    nom_commune_ban: "Saint-Cloud",
    code_postal_ban: "92210",
    surface_habitable_logement: 135,
    etiquette_dpe: "E",
    etiquette_ges: "E",
  };
  const service = createAddressAiService({
    repositories: stubRepositories([
      dpeRecord({
        ...base,
        adresse_ban: "1 Rue Electrique 92210 Saint-Cloud",
        raw: { type_energie_principale_chauffage: "Électricité" },
      }),
      dpeRecord({
        ...base,
        adresse_ban: "2 Rue du Gaz 92210 Saint-Cloud",
        raw: { type_energie_principale_chauffage: "Gaz naturel" },
      }),
    ]),
  });

  const { criteria, candidates } = service.search({
    id: 7,
    property_type: "house",
    postal_code: "92210",
    surface: 135,
    dpe: "E",
    ges: "E",
    energy_source: "Gaz",
  });

  assert.deepEqual(criteria.famillesEnergie, ["gaz"]);
  assert.equal(candidates[0].street, "2 Rue du Gaz");
  assert.equal(candidates[0].matched.energy, true);
  assert.equal(candidates[0].source.energie, "Gaz naturel");
  assert.equal(candidates[1].matched.energy, false);
  assert.ok(candidates[0].confidence > candidates[1].confidence);
});

test("search : sans source d'énergie dans l'annonce, le critère est ignoré", () => {
  const service = createAddressAiService({
    repositories: stubRepositories([
      dpeRecord({
        adresse_ban: "1 Rue A 75011 Paris",
        surface_habitable_logement: 50,
        raw: { type_energie_principale_chauffage: "Gaz naturel" },
      }),
    ]),
  });
  const { candidates } = service.search({ ...APARTMENT, energy_source: undefined });
  assert.equal(candidates[0].matched.energy, undefined);
});

test("search : consommation et émissions départagent des DPE aux mêmes étiquettes", () => {
  const base = {
    nom_commune_ban: "Suresnes",
    code_postal_ban: "92150",
    surface_habitable_logement: 31,
    etiquette_dpe: "G",
    etiquette_ges: "C",
  };
  const service = createAddressAiService({
    repositories: stubRepositories([
      dpeRecord({
        ...base,
        adresse_ban: "31 Boulevard Henri Sellier 92150 Suresnes",
        raw: { conso_5_usages_par_m2_ep: 544.6, emission_ges_5_usages_par_m2: 21 },
      }),
      dpeRecord({
        ...base,
        adresse_ban: "42 Rue Claude Burgod 92150 Suresnes",
        raw: { conso_5_usages_par_m2_ep: 572, emission_ges_5_usages_par_m2: 23 },
      }),
      dpeRecord({
        ...base,
        adresse_ban: "1 Rue Proche 92150 Suresnes",
        raw: { conso_5_usages_par_m2_ep: "568.4", emission_ges_5_usages_par_m2: "22.6" },
      }),
      dpeRecord({ ...base, adresse_ban: "2 Rue Sans Valeurs 92150 Suresnes" }),
    ]),
  });

  const { criteria, candidates } = service.search({
    id: 38,
    property_type: "apartment",
    postal_code: "92150",
    surface: 31,
    dpe: "G",
    ges: "C",
    dpe_value: 572,
    ges_value: 23,
  });

  assert.equal(criteria.consoM2, 572);
  assert.equal(criteria.emissionsM2, 23);

  const byStreet = Object.fromEntries(candidates.map((c) => [c.street, c]));
  const exact = byStreet["42 Rue Claude Burgod"];
  const close = byStreet["1 Rue Proche"];
  const far = byStreet["31 Boulevard Henri Sellier"];
  const missing = byStreet["2 Rue Sans Valeurs"];

  assert.equal(candidates[0].street, "42 Rue Claude Burgod");
  assert.equal(exact.confidence, 95);
  assert.equal(exact.matched.conso, true);
  assert.equal(exact.matched.emissions, true);
  assert.equal(exact.source.conso, 572);
  assert.equal(exact.source.emissions, 23);

  assert.equal(close.matched.conso, true);
  assert.equal(close.matched.emissions, true);
  assert.ok(close.confidence < exact.confidence);

  assert.equal(far.matched.conso, false);
  assert.ok(far.confidence < close.confidence);

  assert.equal(missing.matched.conso, false);
  assert.equal(missing.matched.emissions, false);
  assert.equal(missing.source.conso, null);
});

test("search : numéro repris depuis numero_voie_brut si numero_voie_ban vide", () => {
  const service = createAddressAiService({
    repositories: stubRepositories([
      dpeRecord({
        adresse_ban: "Rue Gérhard 92800 Puteaux",
        adresse_brut: "118 Rue Guerard",
        nom_commune_ban: "Puteaux",
        code_postal_ban: "92800",
        surface_habitable_logement: 61,
        etiquette_dpe: "E",
        raw: {
          nom_rue_ban: "Rue Gérhard",
          numero_voie_ban: "",
          numero_voie_brut: "118",
        },
      }),
    ]),
  });
  const listing = {
    ...APARTMENT,
    postal_code: "92800",
    surface: 61,
    dpe: "E",
  };
  const [candidate] = service.search(listing).candidates;
  assert.equal(candidate.street, "118 Rue Gérhard");
  assert.equal(candidate.mapsQuery, "118 Rue Gérhard, 92800, Puteaux");
});

test("search : sans valeurs chiffrées dans l'annonce, conso/émissions ignorées", () => {
  const service = createAddressAiService({
    repositories: stubRepositories([
      dpeRecord({
        adresse_ban: "10 Rue A 75011 Paris",
        surface_habitable_logement: 50,
        etiquette_dpe: "D",
        etiquette_ges: "C",
        annee_construction: 1970,
        raw: {
          complement_adresse_logement: "3ème étage",
          conso_5_usages_par_m2_ep: 999,
          emission_ges_5_usages_par_m2: 99,
        },
      }),
    ]),
  });
  const [candidate] = service.search(APARTMENT).candidates;
  assert.equal(candidate.confidence, 95);
  assert.equal("conso" in candidate.matched, false);
  assert.equal("emissions" in candidate.matched, false);
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

test("enrichAddressAiCandidateMaps : lien recherche quand pas de clé Google", async () => {
  let calls = 0;
  const enriched = await enrichAddressAiCandidateMaps(
    [{ street: "5 Rue de Test", mapsQuery: "5 Rue de Test 75011 Paris" }],
    async () => {
      calls += 1;
      return { lat: 48.857832, lon: 2.295226, label: "5 Rue de Test" };
    }
  );
  assert.equal(calls, 1);
  assert.equal(
    enriched[0].mapsUrl,
    googleMapsSearchUrl("5 Rue de Test 75011 Paris")
  );
});

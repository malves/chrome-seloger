import test from "node:test";
import assert from "node:assert/strict";
import populationProvider, {
  parseMelodiPopulation,
  populationVariations,
} from "../src/services/enrichment/population.provider.js";
import ProviderSkipped from "../src/services/enrichment/skipped.js";

function obs(year, measure, value) {
  return {
    dimensions: { GEO: "2025-COM-92063", FREQ: "A", TIME_PERIOD: String(year), POPREF_MEASURE: measure },
    measures: { OBS_VALUE_NIVEAU: { value } },
  };
}

const communeJson = {
  observations: [
    obs(2023, "PMUN", 82874),
    obs(1968, "PSDC", 60804),
    obs(2013, "PMUN", 79762),
    obs(2018, "PMUN", 77986),
    obs(2023, "PTOT", 84409),
    obs(1999, "PSDC", 73469),
  ],
};

const deptJson = {
  observations: [
    obs(1968, "PSDC", 1461619),
    obs(2023, "PMUN", 1640000),
  ],
};

function fakeFetch(map) {
  return async (url) => {
    for (const [geo, value] of Object.entries(map)) {
      if (url.includes(`GEO=${geo}&`)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    throw new Error(`HTTP 400 sur ${url}`);
  };
}

test("parseMelodiPopulation fusionne PSDC et PMUN, ignore les autres mesures et trie", () => {
  const points = parseMelodiPopulation(communeJson);
  assert.deepEqual(
    points.map((p) => p.year),
    [1968, 1999, 2013, 2018, 2023]
  );
  assert.equal(points.at(-1).population, 82874);
});

test("populationVariations calcule 5 ans, 10 ans et depuis la première année", () => {
  const v = populationVariations(parseMelodiPopulation(communeJson));
  assert.equal(v[5], 6.3);
  assert.equal(v[10], 3.9);
  assert.equal(v.since_first, 36.3);
});

test("provider population renvoie commune et département indexés base 100", async () => {
  const repositories = {
    enrichments: {
      findCommune: () => ({
        data: { name: "Rueil-Malmaison", department: { code: "92", name: "Hauts-de-Seine" } },
      }),
    },
  };
  const data = await populationProvider.fetch({
    inseeCode: "92063",
    deptCode: "92",
    fetchJson: fakeFetch({ "COM-92063": communeJson, "DEP-92": deptJson }),
    repositories,
  });

  assert.equal(data.commune_name, "Rueil-Malmaison");
  assert.equal(data.base_year, 1968);
  assert.equal(data.commune.points[0].index, 100);
  assert.equal(data.commune.latest.population, 82874);
  assert.equal(data.department.name, "Hauts-de-Seine");
  assert.equal(data.department_series.points[0].index, 100);
});

test("un échec côté département conserve la série communale", async () => {
  const data = await populationProvider.fetch({
    inseeCode: "92063",
    deptCode: "92",
    fetchJson: fakeFetch({ "COM-92063": communeJson, "DEP-92": new Error("timeout") }),
  });
  assert.equal(data.department_series, null);
  assert.equal(data.department, null);
  assert.equal(data.commune.points.length, 5);
});

test("sans code INSEE ou territoire inconnu, le provider est ignoré", async () => {
  await assert.rejects(
    populationProvider.fetch({ inseeCode: null, fetchJson: fakeFetch({}) }),
    ProviderSkipped
  );
  await assert.rejects(
    populationProvider.fetch({ inseeCode: "75116", fetchJson: fakeFetch({}) }),
    ProviderSkipped
  );
});

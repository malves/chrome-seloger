import test from "node:test";
import assert from "node:assert/strict";
import rentEstimateProvider, {
  findCommuneRentEstimate,
} from "../src/services/enrichment/rent-estimate.provider.js";
import {
  RENT_ESTIMATE_COMMUNE_PROVIDER,
  RENT_ESTIMATE_VERSION,
  mergeCommuneRent,
  pickCommuneRent,
} from "../src/lib/rent-estimate.js";

const COMMUNE_DATA = {
  version: RENT_ESTIMATE_VERSION,
  granularity: "commune",
  rent_m2: { low: 18, mid: 21, high: 24 },
  sources: [],
};

function fakeRepositories({ listingRow = null, communeRow = null } = {}) {
  const saved = [];
  return {
    saved,
    enrichments: {
      findOne: () => listingRow,
      findCommune: (insee, provider) =>
        provider === RENT_ESTIMATE_COMMUNE_PROVIDER ? communeRow : null,
      saveCommune: (insee, provider, data) => saved.push({ insee, provider, data }),
    },
  };
}

const listingWithoutAddress = {
  id: 1,
  transaction_type: "sale",
  property_type: "apartment",
  surface: 60,
  insee_code: "92064",
  city: "Puteaux",
};

test("cache communal : par type de bien, version et durée de validité", () => {
  const data = mergeCommuneRent(null, "apartment", COMMUNE_DATA);
  assert.deepEqual(pickCommuneRent(data, "apartment").rent_m2, COMMUNE_DATA.rent_m2);
  assert.equal(pickCommuneRent(data, "house"), null);

  const old = mergeCommuneRent(null, "apartment", COMMUNE_DATA, {
    now: new Date("2020-01-01"),
  });
  assert.equal(pickCommuneRent(old, "apartment"), null);

  const outdated = mergeCommuneRent(null, "apartment", { ...COMMUNE_DATA, version: 1 });
  assert.equal(pickCommuneRent(outdated, "apartment"), null);

  const both = mergeCommuneRent(data, "house", { ...COMMUNE_DATA, rent_m2: { low: 15, mid: 17, high: 19 } });
  assert.equal(pickCommuneRent(both, "apartment").rent_m2.mid, 21);
  assert.equal(pickCommuneRent(both, "house").rent_m2.mid, 17);
});

test("cache communal ignoré quand l'annonce a une adresse saisie", () => {
  const repositories = fakeRepositories({
    communeRow: { data: mergeCommuneRent(null, "apartment", COMMUNE_DATA) },
  });
  assert.ok(findCommuneRentEstimate(repositories, listingWithoutAddress));
  assert.equal(
    findCommuneRentEstimate(repositories, {
      ...listingWithoutAddress,
      user_address: "12 rue Test, 92800 Puteaux",
    }),
    null
  );
});

test("provider : estimation communale en cache, sans appel LLM", async () => {
  const repositories = fakeRepositories({
    communeRow: { data: mergeCommuneRent(null, "apartment", COMMUNE_DATA) },
  });
  const data = await rentEstimateProvider.fetch({
    listing: listingWithoutAddress,
    repositories,
    config: { rent: { apiKey: "" } },
  });
  assert.equal(data.rent_m2.mid, 21);
  assert.equal(repositories.saved.length, 0);
});

test("provider : commune résolue pendant l'appel LLM, le cache communal est rempli", async (t) => {
  const repositories = fakeRepositories();
  repositories.listings = {
    findByIdOnly: () => ({ ...listingWithoutAddress }),
  };
  const llmJson = {
    granularity: "commune",
    rent_m2: { low: 18, mid: 21, high: 24 },
    furnished_rent_m2_mid: null,
    rent_control: { applies: false, reference_m2: null, reference_max_m2: null },
    confidence: 0.8,
    sources: [],
    notes: "Note propre au bien.",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ output_text: JSON.stringify(llmJson), output: [] }),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const data = await rentEstimateProvider.fetch({
    listing: { ...listingWithoutAddress, insee_code: null },
    repositories,
    config: {
      rent: {
        apiKey: "test",
        baseUrl: "https://llm.test/v1",
        model: "test",
        webSearch: true,
        timeoutMs: 1000,
      },
    },
  });

  assert.equal(data.rent_m2.mid, 21);
  assert.equal(repositories.saved.length, 1);
  assert.equal(repositories.saved[0].insee, "92064");
  const cached = pickCommuneRent(repositories.saved[0].data, "apartment");
  assert.equal(cached.rent_m2.mid, 21);
  assert.equal(cached.notes, "");
});

test("provider : relance forcée, le cache communal est ignoré", async () => {
  const repositories = fakeRepositories({
    communeRow: { data: mergeCommuneRent(null, "apartment", COMMUNE_DATA) },
  });
  await assert.rejects(
    rentEstimateProvider.fetch({
      listing: listingWithoutAddress,
      repositories,
      config: { rent: { apiKey: "" } },
      force: true,
    }),
    /LLM non configuré/
  );
});

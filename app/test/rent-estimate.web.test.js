/**
 * Bloc « Valeur locative » sur la fiche : indicateurs, état en cours,
 * absence pour une location.
 */

import test from "node:test";
import assert from "node:assert/strict";
import createListingsService from "../src/services/listings.service.js";
import immoDataProvider from "../src/services/enrichment/immo-data.provider.js";
import { RENT_ESTIMATE_VERSION } from "../src/lib/rent-estimate.js";
import {
  createTestApp,
  createUser,
  extractCsrf,
  listingPayload,
  loginAgent,
} from "./helpers.js";

const IMMO_CONFIG = {
  immoData: {
    apiKey: "immo_data_live_test",
    baseUrl: "https://api.immo-data.fr",
    timeoutMs: 8000,
    userAgent: "CarnetDeVisites/1.0",
  },
};

function monthlySeries(fromPeriod, values) {
  const [year, month] = fromPeriod.split("-").map(Number);
  return values.map((value, index) => {
    const date = new Date(year, month - 1 + index, 1);
    return {
      period: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`,
      value,
    };
  });
}

function rentPayload() {
  return {
    version: RENT_ESTIMATE_VERSION,
    granularity: "address",
    rent_m2: { low: 18, mid: 21, high: 25 },
    furnished_rent_m2_mid: null,
    rent_control: {
      applies: true,
      reference_m2: 20,
      reference_max_m2: 24,
    },
    confidence: 0.74,
    sources: [
      {
        name: "Observatoire des loyers",
        url: "https://www.observatoires-des-loyers.org/",
        period: "2025",
      },
    ],
    notes: "",
    web_search: true,
  };
}

async function setupSaleListing(ctx, email, { saveRent = false, rent = false } = {}) {
  const user = await createUser(ctx.repositories, email);
  const listingsService = createListingsService({ repositories: ctx.repositories });
  const { id } = listingsService.save(
    user,
    listingPayload({
      property_type: "apartment",
      transaction_type: rent ? "rent" : "sale",
      price: rent ? 1400 : 520000,
      surface: 80,
      location: { city: "Puteaux", postal_code: "92800", insee_code: "92064" },
    })
  );
  ctx.repositories.enrichments.saveCommune("92064", "commune", {
    insee_code: "92064",
    name: "Puteaux",
    department: { code: "92", name: "Hauts-de-Seine" },
  });
  const listing = ctx.repositories.listings.findById(user.id, id);
  const values = [];
  for (let year = 2020; year <= 2025; year += 1) {
    for (let month = 0; month < 12; month += 1) {
      values.push(6000 + (year - 2020) * 80);
    }
  }
  const data = await immoDataProvider.fetch({
    listing,
    inseeCode: "92064",
    repositories: ctx.repositories,
    fetchJson: async () => ({
      metric: "sqm_price",
      data: monthlySeries("2020-01", values),
    }),
    config: IMMO_CONFIG,
  });
  ctx.repositories.enrichments.saveCommune("92064", "immo-data", data);
  if (saveRent) {
    ctx.repositories.enrichments.saveListingResult(id, "rent-estimate", {
      status: "ok",
      data: rentPayload(),
    });
  }
  return { user, id, listing };
}

test("fiche : valeur locative en cours tant que le cache est vide", async (t) => {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  const { id } = await setupSaleListing(ctx, "rent-pending@example.com");

  const agent = await loginAgent(ctx.app, "rent-pending@example.com");
  const res = await agent.get(`/listings/${id}`).expect(200);
  assert.match(res.text, /id="listing-rent-estimate"/);
  assert.match(res.text, /Estimation locative en cours/);
  assert.match(res.text, /hx-get="\/listings\/\d+\/rent-estimate\/panel"/);
});

test("fiche : indicateurs et rendement locatif", async (t) => {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  const { id } = await setupSaleListing(ctx, "rent-ok@example.com", {
    saveRent: true,
  });

  const agent = await loginAgent(ctx.app, "rent-ok@example.com");
  const res = await agent.get(`/listings/${id}`).expect(200);
  const html = res.text;
  assert.match(html, /id="listing-rent-estimate"/);
  assert.match(html, /Valeur locative/);
  assert.match(html, /Loyer au m²/);
  assert.match(html, /Loyer mensuel estimé/);
  assert.match(html, /Rendement brut/);
  assert.match(html, /Autour de l(?:'|&#39;)adresse/);
  assert.match(html, /Encadrement des loyers/);
  assert.match(html, /observatoires-des-loyers/);
  assert.doesNotMatch(html, /data-rent-compare-chart/);
  assert.doesNotMatch(html, /Comparatif loyers/);
});

test("fiche : pas de bloc valeur locative pour une location", async (t) => {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  const { id } = await setupSaleListing(ctx, "rent-loc@example.com", {
    rent: true,
  });

  const agent = await loginAgent(ctx.app, "rent-loc@example.com");
  const res = await agent.get(`/listings/${id}`).expect(200);
  assert.doesNotMatch(res.text, /id="listing-rent-estimate"/);
  assert.doesNotMatch(res.text, /Valeur locative/);
});

test("panneau : relance affiche l'état en cours", async (t) => {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  const { id } = await setupSaleListing(ctx, "rent-run@example.com", {
    saveRent: true,
  });

  const agent = await loginAgent(ctx.app, "rent-run@example.com");
  const csrf = extractCsrf((await agent.get(`/listings/${id}`)).text);
  const res = await agent
    .post(`/listings/${id}/rent-estimate/run`)
    .set("HX-Request", "true")
    .type("form")
    .send({ _csrf: csrf })
    .expect(200);
  assert.match(res.text, /Estimation locative en cours/);
});

test("panneau : estimation OK resynchronise le financement (OOB)", async (t) => {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  const { id } = await setupSaleListing(ctx, "rent-fin-oob@example.com", {
    saveRent: true,
  });

  const agent = await loginAgent(ctx.app, "rent-fin-oob@example.com");
  const res = await agent
    .get(`/listings/${id}/rent-estimate/panel`)
    .set("HX-Request", "true")
    .expect(200);

  assert.match(res.text, /id="listing-rent-estimate"/);
  assert.match(res.text, /id="financing-block"[^>]*hx-swap-oob="true"/);
  assert.match(res.text, /data-financing-annual-rent="/);
  assert.match(res.text, /Rendement brut locatif/);
});

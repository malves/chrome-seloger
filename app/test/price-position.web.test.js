/**
 * Bloc « Positionnement du prix » sur la fiche : rendu visuel (puces,
 * jauge, prix + travaux) et resynchronisation OOB quand le budget travaux
 * change (financement, plan des pièces).
 */

import test from "node:test";
import assert from "node:assert/strict";
import createListingsService from "../src/services/listings.service.js";
import immoDataProvider from "../src/services/enrichment/immo-data.provider.js";
import dvfLocalProvider from "../src/services/enrichment/dvf-local.provider.js";
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
const DVF_CONFIG = {
  dvf: {
    radiusMeters: 250,
    radiusMinSample: 5,
    radiusYears: 5,
    radiusRecencyHalfLifeDays: 540,
    radiusOutlierLowRatio: 0.5,
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

/** Annonce Puteaux 80 m² à 520 000 € avec analyse de marché communale en cache. */
async function setupListing(ctx, email) {
  const user = await createUser(ctx.repositories, email);
  const listingsService = createListingsService({ repositories: ctx.repositories });
  const { id } = listingsService.save(
    user,
    listingPayload({
      property_type: "apartment",
      price: 520000,
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
  const data = await immoDataProvider.fetch({
    listing,
    inseeCode: "92064",
    repositories: ctx.repositories,
    // Référence communale : 6 500 €/m² → estimation 520 000 €, bien au prix.
    fetchJson: async () => ({
      metric: "sqm_price",
      data: monthlySeries("2020-01", [6000, 6200, 6400, 6500, 6500]),
    }),
    config: IMMO_CONFIG,
  });
  ctx.repositories.enrichments.saveCommune("92064", "immo-data", data);
  return { user, id, listing };
}

test("fiche : positionnement visuel, sans travaux chiffrés", async (t) => {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  const { id } = await setupListing(ctx, "pos@example.com");

  const agent = await loginAgent(ctx.app, "pos@example.com");
  const res = await agent.get(`/listings/${id}`).expect(200);
  const html = res.text;

  assert.match(html, /id="listing-price-position"/);
  // Pas d'OOB sur la fiche complète.
  assert.doesNotMatch(html, /id="listing-price-position"[^>]*hx-swap-oob/);
  // Trois repères, dont « Prix + travaux » en attente de chiffrage.
  assert.match(html, /Prix affiché/);
  assert.match(html, /Prix \+ travaux/);
  assert.match(html, /Chiffrez les travaux/);
  assert.match(html, /Estimation marché/);
  // Jauge : repère marché + curseur prix, pas de curseur travaux.
  assert.match(html, /pricepos__marker--price/);
  assert.doesNotMatch(html, /pricepos__marker--works/);
  // Aide repliée, puces de référence et conseil compact.
  assert.match(html, /Comment est calculée l'estimation \?/);
  assert.match(html, /pricepos__chip/);
  assert.match(html, /Prix aligné/);
  // Les anciens blocs textuels ont disparu.
  assert.doesNotMatch(html, /Références comparées/);
  assert.doesNotMatch(html, /pricepos__figures/);
});

test("financement : le montant Travaux resynchronise le positionnement (OOB)", async (t) => {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  const { id } = await setupListing(ctx, "oob@example.com");

  const agent = await loginAgent(ctx.app, "oob@example.com");
  const csrf = extractCsrf((await agent.get(`/listings/${id}`)).text);

  const res = await agent
    .post(`/listings/${id}/financing`)
    .set("HX-Request", "true")
    .type("form")
    .send({
      _csrf: csrf,
      negotiated_price: "520000",
      works: "40 000",
      down_payment: "50 000",
      years: "20",
      interest_rate: "3,2",
      insurance_rate: "0.25",
    })
    .expect(200);
  const html = res.text;

  // Fragment financement + bloc positionnement hors cible.
  assert.match(html, /id="financing-block"/);
  assert.match(html, /id="listing-price-position"[^>]*hx-swap-oob="true"/);
  // 520 000 + 40 000 = 560 000 € soit 7 000 €/m² vs 6 500 → +7,7 %.
  assert.match(html, /560[\u202f\u00a0 ]000[\u202f\u00a0 ]€/);
  assert.match(html, /dont 40[\u202f\u00a0 ]000[\u202f\u00a0 ]€ de travaux/);
  assert.match(html, /\+[\u00a0 ]7,7[\u00a0 ]%/);
  assert.match(html, /pricepos__marker--works/);
  assert.match(html, /Travaux compris/);
  assert.match(html, /Au-dessus du marché/);
  // Le prix seul reste « aligné ».
  assert.match(html, /Prix aligné/);

  // La fiche rechargée reprend le même montant.
  const page = await agent.get(`/listings/${id}`).expect(200);
  assert.match(page.text, /dont 40[\u202f\u00a0 ]000[\u202f\u00a0 ]€ de travaux/);
});

test("plan des pièces : /works/summary renvoie aussi le positionnement (OOB)", async (t) => {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  const { id } = await setupListing(ctx, "plan@example.com");

  const agent = await loginAgent(ctx.app, "plan@example.com");
  const csrf = extractCsrf((await agent.get(`/listings/${id}`)).text);
  await agent
    .post(`/listings/${id}/financing`)
    .set("HX-Request", "true")
    .type("form")
    .send({ _csrf: csrf, works: "25 000" })
    .expect(200);

  const res = await agent.get(`/listings/${id}/works/summary`).expect(200);
  assert.match(res.text, /id="listing-price-position"[^>]*hx-swap-oob="true"/);
  assert.match(res.text, /545[\u202f\u00a0 ]000[\u202f\u00a0 ]€/);
  // Un seul fragment positionnement par réponse.
  assert.equal((res.text.match(/id="listing-price-position"/g) || []).length, 1);
});

test("fiche : référence DVF autour de l'adresse en puces (ventes, méthode)", async (t) => {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  const { user, id } = await setupListing(ctx, "dvf@example.com");

  // Ventes DVF à quelques mètres de l'adresse saisie, 6 000 €/m².
  const lat = 48.8851;
  const lng = 2.2381;
  const year = new Date().getFullYear() - 1;
  ctx.repositories.dvf.insertMutationBatch(
    Array.from({ length: 7 }, (_, i) => ({
      insee_code: "92064",
      dept_code: "92",
      year,
      mutation_date: `${year}-06-15`,
      type_local: "apartment",
      price: 6000 * 80,
      surface: 80,
      price_per_m2: 6000,
      lat: lat + i * 0.00001,
      lng: lng + i * 0.00001,
    }))
  );
  ctx.repositories.listings.setUserAddress(user.id, id, {
    address: "10 rue de Paris, 92800 Puteaux",
    lat,
    lng,
    source: "manual",
  });
  const listing = ctx.repositories.listings.findById(user.id, id);
  const dvf = await dvfLocalProvider.fetch({
    listing,
    repositories: ctx.repositories,
    config: DVF_CONFIG,
  });
  ctx.repositories.enrichments.saveListingResult(id, "dvf-local", {
    status: "ok",
    data: dvf,
  });

  const agent = await loginAgent(ctx.app, "dvf@example.com");
  const html = (await agent.get(`/listings/${id}`).expect(200)).text;

  assert.match(html, /Autour de l(?:'|&#39;)adresse · 250 m/);
  // Puce « ventes » ouvrant la liste DVF, puce DVF · 5 ans.
  assert.match(html, /data-dvf-sales-open="immodata-dvf-sales-modal"[^>]*>\s*7 ventes · rayon 250 m/);
  assert.match(html, /DVF · 5 ans/);
  // 6 500 €/m² affiché vs 6 000 €/m² : au-dessus.
  assert.match(html, /Au-dessus du marché/);
  // La commune est masquée dès qu'une référence à l'adresse est retenue.
  assert.doesNotMatch(html, /Autres références comparées/);
  assert.doesNotMatch(html, /Renseignez l(?:'|&#39;)adresse/);
});

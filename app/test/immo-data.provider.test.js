import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ejs from "ejs";
import { openDatabase } from "../src/db.js";
import createRepositories from "../src/repositories/index.js";
import immoDataProvider from "../src/services/enrichment/immo-data.provider.js";
import immoDataDeptProvider from "../src/services/enrichment/immo-data-dept.provider.js";
import fmt from "../src/lib/format.js";
import createListingsService from "../src/services/listings.service.js";
import {
  createTestApp,
  createUser,
  listingPayload,
  loginAgent,
} from "./helpers.js";
import {
  authorizationHeader,
  buildMonthlyEvolution,
  clipToPreviousMonth,
  departmentCodeFromInsee,
  formatPeriodFr,
  historyRange,
  IMMO_DATA_MARKET_VERSION,
  monthlyHorizons,
  needsImmoDataMarketRefresh,
  parseHistoryPoints,
  yearlyFromMonthly,
} from "../src/lib/immo-data-market.js";

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));

function monthlySeries(fromPeriod, values) {
  const [year, month] = fromPeriod.split("-").map(Number);
  return values.map((value, index) => {
    const date = new Date(year, month - 1 + index, 1);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    return { period: `${y}-${m}`, value };
  });
}

function historyPayload(points) {
  return { metric: "sqm_price", data: points };
}

test("helpers Immo Data : INSEE, parsing et variations mensuelles", () => {
  assert.equal(departmentCodeFromInsee("92064"), "92");
  assert.equal(departmentCodeFromInsee("2A004"), "2A");
  assert.equal(departmentCodeFromInsee("97101"), "971");
  assert.equal(formatPeriodFr("2026-08"), "août 2026");
  assert.equal(
    authorizationHeader("immo_data_live_test"),
    "Bearer immo_data_live_test"
  );
  assert.equal(authorizationHeader("Bearer déjà"), "Bearer déjà");
  assert.equal(needsImmoDataMarketRefresh({}), true);
  assert.equal(
    needsImmoDataMarketRefresh({ market_version: IMMO_DATA_MARKET_VERSION }),
    false
  );

  const points = parseHistoryPoints({
    data: [
      { period: "2024-01", value: 6000 },
      { period: "2025-01", value: 6300 },
      { period: "2026-01", value: 6150 },
    ],
  });
  assert.equal(points.length, 3);
  const yearly = yearlyFromMonthly(points);
  assert.equal(yearly.at(-1).median_price_m2, 6150);

  const horizons = monthlyHorizons(points);
  assert.equal(horizons[1], -2.4);
  assert.equal(horizons[2], 2.5);

  const evo = buildMonthlyEvolution(points, { propertyType: "apartment" });
  assert.ok(evo.points.length >= 2);
  assert.equal(evo.points[0].index, 100);
  assert.equal(evo.points[0].period, "2024-01");
  assert.equal(evo.y1, -2.4);

  assert.deepEqual(historyRange(new Date(2026, 9, 6)), {
    startDate: "2016-01",
    endDate: "2026-09",
  });
  assert.deepEqual(historyRange(new Date(2026, 0, 15)), {
    startDate: "2015-01",
    endDate: "2025-12",
  });

  const longSeries = monthlySeries("2016-01", Array.from({ length: 130 }, (_, i) => 5000 + i * 5));
  const longHorizons = monthlyHorizons(longSeries);
  assert.ok(longHorizons["6m"] != null);
  assert.ok(longHorizons[10] != null);
  const clipped = clipToPreviousMonth(
    [
      { period: "2026-09", value: 6100 },
      { period: "2026-10", value: 6080 },
    ],
    new Date(2026, 9, 6)
  );
  assert.deepEqual(clipped, [{ period: "2026-09", value: 6100 }]);
});

test("provider immo-data : volet communal et série mensuelle", async () => {
  const db = openDatabase(":memory:");
  const repositories = createRepositories(db);
  repositories.enrichments.saveCommune("92064", "commune", {
    insee_code: "92064",
    name: "Puteaux",
    department: { code: "92", name: "Hauts-de-Seine" },
  });

  const cityApt = monthlySeries("2020-01", [
    6692, 6729, 6767, 6805, 6844, 6879, 6912, 6944, 6976, 7004, 7027, 7048,
  ]);
  const later = monthlySeries("2025-01", [
    6247, 6235, 6224, 6214, 6203, 6192, 6182, 6174,
  ]);
  const apartmentCity = [...cityApt, ...later];
  const houseCity = apartmentCity.map((p) => ({
    ...p,
    value: Math.round(p.value * 0.92),
  }));
  const apartmentDept = apartmentCity.map((p) => ({
    ...p,
    value: Math.round(p.value * 0.97),
  }));
  const houseDept = houseCity.map((p) => ({
    ...p,
    value: Math.round(p.value * 0.97),
  }));

  const listing = {
    id: 1,
    property_type: "apartment",
    transaction_type: "sale",
    price: 520000,
    surface: 80,
    city: "Puteaux",
    insee_code: "92064",
  };

  const seen = [];
  const fetchJson = async (url) => {
    seen.push(url);
    const parsed = new URL(url);
    const geo = parsed.searchParams.get("geoLevel");
    const type = parsed.searchParams.get("realtyType");
    if (geo === "city" && type === "apartment") return historyPayload(apartmentCity);
    if (geo === "city" && type === "house") return historyPayload(houseCity);
    if (geo === "department" && type === "apartment") {
      return historyPayload(apartmentDept);
    }
    if (geo === "department" && type === "house") return historyPayload(houseDept);
    throw new Error(`série inattendue ${geo}/${type}`);
  };

  const data = await immoDataProvider.fetch({
    listing,
    inseeCode: "92064",
    repositories,
    fetchJson,
    config: {
      immoData: {
        apiKey: "immo_data_live_test",
        baseUrl: "https://api.immo-data.fr",
        timeoutMs: 8000,
        userAgent: "CarnetDeVisites/1.0",
      },
    },
  });

  // Volet communal uniquement : 2 appels `geoLevel=city` (le département a son
  // propre provider `immo-data-dept`).
  assert.equal(seen.length, 2);
  assert.match(seen[0], /\/v1\/market\/price\/history/);
  assert.match(seen[0], /code=92064/);
  assert.match(seen[0], /geoLevel=city/);
  assert.match(seen[0], /metric=sqm_price/);
  assert.match(seen[0], new RegExp(`endDate=${historyRange().endDate}`));
  assert.equal(data.commune_name, "Puteaux");
  assert.equal(data.commune.apartment.median_price_m2, 6174);
  assert.equal(data.hide_radius, true);
  // Le verdict (prix du bien vs référence) est calculé à l'affichage.
  assert.equal(data.verdict, null);
  assert.equal(data.evolution.by_type.apartment.department, null);
  assert.equal(data.evolution.department.code, "92");
  assert.match(data.evolution.lead, /Puteaux/);
  assert.ok(data.evolution.by_type.apartment.commune.points.length > 2);
  assert.equal(
    data.evolution.by_type.apartment.commune.points[0].period,
    "2020-01"
  );

  const html = await ejs.renderFile(
    path.join(fixturesDir, "../src/views/partials/enrichment/immo-data.ejs"),
    { data, listing, fmt, provider: immoDataProvider }
  );
  assert.match(html, /Évolution des prix/);
  assert.match(html, /id="immodata-tab-apartment"/);
  assert.match(html, /data-pricem2-chart/);
  assert.match(html, /"interval":"monthly"/);
  assert.match(html, /6 mois/);
  assert.match(html, /10 ans/);
  assert.match(html, /Hauts-de-Seine/);
  assert.doesNotMatch(html, /rayon autour de l'adresse/i);

  db.close();
});

test("provider immo-data-dept : séries départementales en cache", async () => {
  const deptApt = monthlySeries("2022-01", [5000, 5100, 5200, 5300]);
  const deptHouse = deptApt.map((p) => ({ ...p, value: Math.round(p.value * 0.9) }));

  const seen = [];
  const fetchJson = async (url) => {
    seen.push(url);
    const type = new URL(url).searchParams.get("realtyType");
    return historyPayload(type === "house" ? deptHouse : deptApt);
  };

  const data = await immoDataDeptProvider.fetch({
    inseeCode: "92064",
    deptCode: "92",
    repositories: { enrichments: { findCommune: () => null } },
    fetchJson,
    config: {
      immoData: {
        apiKey: "immo_data_live_test",
        baseUrl: "https://api.immo-data.fr",
        timeoutMs: 8000,
        userAgent: "CarnetDeVisites/1.0",
      },
    },
  });

  assert.equal(seen.length, 2);
  assert.match(seen[0], /geoLevel=department/);
  assert.match(seen[0], /code=92/);
  assert.equal(data.department.code, "92");
  assert.ok(data.by_type.apartment.points.length >= 2);
});

test("viewModel : facade immo-data assemble commune + département + verdict", async (t) => {
  const ctx = createTestApp();
  t.after(() => ctx.close());

  const user = await createUser(ctx.repositories, "compose@example.com");
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
  const config = {
    immoData: {
      apiKey: "immo_data_live_test",
      baseUrl: "https://api.immo-data.fr",
      timeoutMs: 8000,
      userAgent: "CarnetDeVisites/1.0",
    },
  };
  const cityPoints = monthlySeries("2020-01", [6000, 6100, 6200, 6174]);
  const communeData = await immoDataProvider.fetch({
    listing,
    inseeCode: "92064",
    repositories: ctx.repositories,
    fetchJson: async () => historyPayload(cityPoints),
    config,
  });
  ctx.repositories.enrichments.saveCommune("92064", "immo-data", communeData);

  const deptPoints = monthlySeries("2020-01", [5800, 5900, 5950, 5975]);
  const deptData = await immoDataDeptProvider.fetch({
    inseeCode: "92064",
    deptCode: "92",
    repositories: ctx.repositories,
    fetchJson: async () => historyPayload(deptPoints),
    config,
  });
  ctx.repositories.enrichments.saveDepartment("92", "immo-data-dept", deptData);

  const blocks = await ctx.enrichment.viewModel(listing);
  const immo = blocks.find((b) => b.key === "immo-data");
  assert.equal(immo.status, "ok");
  // Verdict calculé à l'affichage (520000/80 = 6500 €/m² vs référence commune 6174).
  assert.ok(immo.data.verdict);
  assert.equal(immo.data.verdict.listing_price_m2, 6500);
  assert.equal(immo.data.verdict.reference_scope, "commune");
  // Séries départementales fusionnées.
  assert.ok(immo.data.evolution.by_type.apartment.department);
  assert.ok(immo.data.evolution.by_type.apartment.department.points.length >= 2);
});

test("provider immo-data : clé absente est ignorée proprement", async () => {
  await assert.rejects(
    immoDataProvider.fetch({
      listing: { property_type: "apartment" },
      inseeCode: "92064",
      repositories: { enrichments: { findCommune() { return null; } } },
      fetchJson: async () => ({}),
      config: { immoData: { apiKey: "" } },
    }),
    /IMMO_DATA_API_KEY/
  );
});

test("la fiche annonce affiche le bloc Analyse de marché Immo Data", async (t) => {
  const ctx = createTestApp();
  t.after(() => ctx.close());

  const user = await createUser(ctx.repositories, "immo@example.com");
  const listingsService = createListingsService({
    repositories: ctx.repositories,
  });
  const { id } = listingsService.save(
    user,
    listingPayload({
      property_type: "apartment",
      price: 520000,
      surface: 80,
      location: {
        city: "Puteaux",
        postal_code: "92800",
        insee_code: "92064",
      },
    })
  );

  ctx.repositories.enrichments.saveCommune("92064", "commune", {
    insee_code: "92064",
    name: "Puteaux",
    department: { code: "92", name: "Hauts-de-Seine" },
  });

  const points = monthlySeries("2020-01", [6692, 6729, 6767, 7000, 6174]);
  const listing = ctx.repositories.listings.findById(user.id, id);
  const data = await immoDataProvider.fetch({
    listing,
    inseeCode: "92064",
    repositories: ctx.repositories,
    fetchJson: async () => historyPayload(points),
    config: {
      immoData: {
        apiKey: "immo_data_live_test",
        baseUrl: "https://api.immo-data.fr",
        timeoutMs: 8000,
        userAgent: "CarnetDeVisites/1.0",
      },
    },
  });
  // Immo Data vit désormais en portée communale : l'orchestrateur assemble le
  // bloc (verdict, séries) à l'affichage à partir de ce cache.
  ctx.repositories.enrichments.saveCommune("92064", "immo-data", data);

  const agent = await loginAgent(ctx.app, "immo@example.com");
  const res = await agent.get(`/listings/${id}`).expect(200);
  assert.match(res.text, /Analyse de marché/);
  assert.doesNotMatch(res.text, /Immo Data/);
  assert.match(res.text, /id="immodata-tab-apartment"/);
  assert.match(res.text, /Prix de marché ·/);
});

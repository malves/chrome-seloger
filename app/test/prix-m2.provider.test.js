import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.js";
import createRepositories from "../src/repositories/index.js";
import createLogger from "../src/lib/logger.js";
import createDvfImportService from "../src/services/dvf-import.service.js";
import prixM2Provider from "../src/services/enrichment/prix-m2.provider.js";
import config from "../src/config.js";

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));

async function seedDvf(repositories) {
  const logger = createLogger();
  const service = createDvfImportService({ repositories, logger });
  const jobId = repositories.dvf.createJob({
    sourceLabel: "test",
    sourceUrl: "fixture",
    yearFrom: 2019,
    yearTo: 2023,
  });
  await service.runImport(jobId, {
    yearFrom: 2019,
    yearTo: 2023,
    paths: {
      2019: path.join(fixturesDir, "fixtures/dvf-2019-sample.csv"),
      2023: path.join(fixturesDir, "fixtures/dvf-2023-sample.csv"),
    },
  });
  return jobId;
}

test("import DVF depuis fixtures et calcul des médianes communales", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const repositories = createRepositories(db);

  const jobId = await seedDvf(repositories);
  const job = repositories.dvf.getJob(jobId);
  assert.equal(job.status, "done");

  // 2023 : maison (3000), appartement (4000), maison+dépendance (3125).
  // 2019 : appartement (3000), maison (2100).
  assert.equal(repositories.dvf.countMutations(), 5);

  const houses = repositories.dvf.communeSeries("33063", "house");
  const house2023 = houses.find((r) => r.year === 2023);
  assert.equal(house2023.count, 2);
  assert.equal(house2023.median_price_m2, 3062.5);
});

test("provider prix-m2 : commune, rayon, verdict et évolution", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const repositories = createRepositories(db);
  await seedDvf(repositories);

  repositories.enrichments.saveCommune("33063", "commune", {
    insee_code: "33063",
    name: "Bordeaux",
    department: { code: "33", name: "Gironde" },
  });

  const listing = {
    id: 1,
    property_type: "house",
    transaction_type: "sale",
    price: 400000,
    surface: 100,
    city: "Bordeaux",
    insee_code: "33063",
    lat: 44.8378,
    lng: -0.5792,
  };

  const data = await prixM2Provider.fetch({
    listing,
    inseeCode: "33063",
    repositories,
    config,
  });

  assert.equal(data.reference_year, 2023);
  assert.equal(data.commune_name, "Bordeaux");
  assert.equal(data.commune.house.median_price_m2, 3062.5);
  assert.equal(data.commune.apartment.median_price_m2, 4000);

  // Rayon 500 m : 3 maisons proches (2100, 3000, 3125) -> médiane 3000.
  assert.ok(data.radius);
  assert.equal(data.radius.property_type, "house");
  assert.equal(data.radius.count, 3);
  assert.equal(data.radius.median_price_m2, 3000);
  assert.equal(data.radius.enough, false); // < seuil (5) -> référence commune

  // Verdict : 4000 €/m² vs médiane commune maison 3062,5 -> index ~131, à négocier.
  assert.ok(data.verdict);
  assert.equal(data.verdict.reference_scope, "commune");
  assert.equal(data.verdict.index, 131);
  assert.equal(data.verdict.tone, "high");
  assert.ok(data.verdict.negotiation_amount > 0);

  // Évolution maisons 2019 (2100) -> 2023 (3062,5) : marché dynamique.
  assert.ok(data.evolution);
  assert.equal(data.evolution.property_type, "house");
  assert.ok(data.evolution.trend_pct > 15);
  assert.equal(data.evolution.tone, "ok");
});

test("provider prix-m2 : département non couvert est ignoré proprement", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const repositories = createRepositories(db);
  await seedDvf(repositories);

  const listing = {
    id: 2,
    property_type: "apartment",
    transaction_type: "sale",
    price: 150000,
    surface: 50,
    city: "Strasbourg",
    insee_code: "67482",
  };

  await assert.rejects(
    prixM2Provider.fetch({
      listing,
      inseeCode: "67482",
      repositories,
      config,
    }),
    /ne couvre pas ce département/
  );
});

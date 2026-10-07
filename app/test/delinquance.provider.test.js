import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.js";
import createRepositories from "../src/repositories/index.js";
import createLogger from "../src/lib/logger.js";
import createSsmsiImportService from "../src/services/ssmsi-import.service.js";
import delinquanceProvider from "../src/services/enrichment/delinquance.provider.js";
import delinquanceDeptProvider from "../src/services/enrichment/delinquance-dept.provider.js";

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));

test("provider delinquance renvoie des indicateurs pour une commune importée", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const repositories = createRepositories(db);
  const logger = createLogger();
  const ssmsi = createSsmsiImportService({ repositories, logger });
  const jobId = repositories.ssmsi.createJob({ sourceLabel: "t", sourceUrl: "t" });
  await ssmsi.runImport(jobId, {
    communePath: path.join(fixturesDir, "fixtures/ssmsi-commune-sample.csv"),
    depPath: path.join(fixturesDir, "fixtures/ssmsi-dep-sample.csv"),
  });

  repositories.enrichments.saveCommune("78517", "commune", {
    insee_code: "78517",
    name: "Rambouillet",
    department: { code: "78", name: "Yvelines" },
  });

  const listing = {
    id: 1,
    city: "Rambouillet",
    postal_code: "78120",
    insee_code: "78517",
  };

  const data = await delinquanceProvider.fetch({
    listing,
    inseeCode: "78517",
    repositories,
  });

  assert.equal(data.territory_source, "announced");
  assert.equal(data.reference_year, 2023);
  assert.ok(data.indicators.length >= 2);
  // Le volet départemental est désormais produit par `delinquance-dept`.
  assert.deepEqual(data.department_benchmark, []);

  // Indice national : 100 = moyenne France, calculé depuis le fichier dép.
  const cambriolages = data.indicators.find((i) => i.key === "cambriolages_logement");
  assert.ok(cambriolages.national_rate > 0);
  assert.equal(typeof cambriolages.national_index, "number");
  assert.ok(data.score);
  assert.equal(typeof data.score.index, "number");
  assert.equal(typeof data.score.persons_index, "number");
  assert.equal(typeof data.score.property_index, "number");
  assert.ok(["ok", "mid", "high", "neutral"].includes(data.score.tone));
  // L'indice départemental est fusionné à l'affichage (provider delinquance-dept).
  assert.equal(data.score.department_index, null);
  assert.equal(data.commune_name, "Rambouillet");

  assert.equal(cambriolages.trend_from_year, 2022);
  assert.equal(cambriolages.trend_to_year, 2023);
  assert.equal(typeof cambriolages.trend_pct, "number");
});

test("provider delinquance-dept renvoie le benchmark et l'indice du département", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const repositories = createRepositories(db);
  const logger = createLogger();
  const ssmsi = createSsmsiImportService({ repositories, logger });
  const jobId = repositories.ssmsi.createJob({ sourceLabel: "t", sourceUrl: "t" });
  await ssmsi.runImport(jobId, {
    communePath: path.join(fixturesDir, "fixtures/ssmsi-commune-sample.csv"),
    depPath: path.join(fixturesDir, "fixtures/ssmsi-dep-sample.csv"),
  });

  const data = await delinquanceDeptProvider.fetch({
    deptCode: "78",
    repositories,
  });

  assert.equal(data.dept_code, "78");
  assert.ok(data.department_benchmark.length >= 1);
  assert.equal(typeof data.score.department_index, "number");
  const bench = data.department_benchmark[0];
  assert.ok(bench.key && typeof bench.rate_per_1000 === "number");
});

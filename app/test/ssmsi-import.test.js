import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.js";
import createRepositories from "../src/repositories/index.js";
import createLogger from "../src/lib/logger.js";
import createSsmsiImportService from "../src/services/ssmsi-import.service.js";
import {
  parseCommuneRow,
  communeHeaderIndex,
  parseSsmsiCsvLine,
} from "../src/lib/ssmsi-csv.js";

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));

test("parseCommuneRow ignore les lignes non diffusées", () => {
  const header = communeHeaderIndex(
    parseSsmsiCsvLine(
      '"CODGEO_2026";"annee";"indicateur";"nombre";"taux_pour_mille";"est_diffuse"'
    )
  );
  const row = parseCommuneRow(
    parseSsmsiCsvLine(
      '"78517";"2023";"Cambriolages de logement";"10";"1,5";"ndiff"'
    ),
    header
  );
  assert.equal(row, null);
});

test("import SSMSI depuis fixtures locales", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const repositories = createRepositories(db);
  const logger = createLogger();
  const service = createSsmsiImportService({ repositories, logger });

  const jobId = repositories.ssmsi.createJob({
    sourceLabel: "test",
    sourceUrl: "fixture",
  });

  await service.runImport(jobId, {
    communePath: path.join(fixturesDir, "fixtures/ssmsi-commune-sample.csv"),
    depPath: path.join(fixturesDir, "fixtures/ssmsi-dep-sample.csv"),
  });

  const job = repositories.ssmsi.getJob(jobId);
  assert.equal(job.status, "done");
  assert.equal(repositories.ssmsi.countCommuneRows(), 5);
  assert.equal(repositories.ssmsi.countDepartmentRows(), 2);

  const series = repositories.ssmsi.findCommuneSeries("78517", { yearLimit: 2023 });
  assert.ok(series.cambriolages_logement);
  assert.equal(series.cambriolages_logement[0].volume, 42);
});

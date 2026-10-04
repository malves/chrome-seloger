/**
 * Import des fichiers SSMSI (commune csv.gz + département csv) en arrière-plan.
 */

import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import readline from "node:readline";
import { Readable } from "node:stream";
import config from "../config.js";
import {
  communeHeaderIndex,
  departmentHeaderIndex,
  parseCommuneRow,
  parseDepartmentRow,
  parseSsmsiCsvLine,
  SSMSI_EXPECTED_COMMUNE_ROWS,
} from "../lib/ssmsi-csv.js";

const REQUEST_TIMEOUT_MS = 300_000;
const BATCH_SIZE = 800;

function lineReaderFromStream(stream) {
  return readline.createInterface({ input: stream, crlfDelay: Infinity });
}

async function openSource({ url, path, gzip = false }) {
  if (path) {
    const raw = createReadStream(path);
    return gzip || path.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  }
  if (!url) throw new Error("URL ou chemin de fichier requis.");

  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} lors du téléchargement SSMSI.`);
  }
  const web = Readable.fromWeb(response.body);
  return gzip || url.endsWith(".gz") ? web.pipe(createGunzip()) : web;
}

async function importCommuneStream(stream, repo, { onProgress } = {}) {
  repo.clearCommune();
  const rl = lineReaderFromStream(stream);
  let headerIndex = null;
  let batch = [];
  let imported = 0;
  let first = true;

  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = parseSsmsiCsvLine(line);
    if (first) {
      headerIndex = communeHeaderIndex(cols);
      first = false;
      continue;
    }
    const row = parseCommuneRow(cols, headerIndex);
    if (!row) continue;
    batch.push(row);
    if (batch.length >= BATCH_SIZE) {
      imported += repo.insertCommuneBatch(batch);
      batch = [];
      if (onProgress) onProgress(imported);
    }
  }
  if (batch.length) {
    imported += repo.insertCommuneBatch(batch);
    if (onProgress) onProgress(imported);
  }
  return imported;
}

async function importDepartmentStream(stream, repo, { onProgress } = {}) {
  repo.clearDepartment();
  repo.clearNational();
  const rl = lineReaderFromStream(stream);
  let headerIndex = null;
  let batch = [];
  let imported = 0;
  let first = true;

  // Agrégat national : somme des faits et des populations par (année, indicateur).
  const national = new Map();

  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = parseSsmsiCsvLine(line);
    if (first) {
      headerIndex = departmentHeaderIndex(cols);
      first = false;
      continue;
    }
    const row = parseDepartmentRow(cols, headerIndex);
    if (!row) continue;
    batch.push(row);

    if (row.volume != null && row.population != null) {
      const key = `${row.year}::${row.indicator}`;
      const agg = national.get(key) || {
        year: row.year,
        indicator: row.indicator,
        label: row.label,
        volume: 0,
        population: 0,
      };
      agg.volume += row.volume;
      agg.population += row.population;
      national.set(key, agg);
    }

    if (batch.length >= BATCH_SIZE) {
      imported += repo.insertDepartmentBatch(batch);
      batch = [];
      if (onProgress) onProgress(imported);
    }
  }
  if (batch.length) {
    imported += repo.insertDepartmentBatch(batch);
    if (onProgress) onProgress(imported);
  }

  const nationalRows = [...national.values()].map((agg) => ({
    ...agg,
    rate_per_1000: agg.population > 0 ? (agg.volume / agg.population) * 1000 : null,
  }));
  repo.insertNationalBatch(nationalRows);

  return imported;
}

export default function createSsmsiImportService({ repositories, logger }) {
  const repo = repositories.ssmsi;

  function resolveUrl(value, fallback) {
    const text = String(value || "").trim();
    if (!text || text.length < 80 || !/^https:\/\//i.test(text)) return fallback;
    return text;
  }

  async function runImport(jobId, options = {}) {
    const communeUrl = resolveUrl(options.communeUrl, config.ssmsi.communeUrl);
    const depUrl = resolveUrl(options.depUrl, config.ssmsi.depUrl);
    const communePath = options.communePath || null;
    const depPath = options.depPath || null;

    repo.updateJob(jobId, { status: "running" });

    try {
      const communeStream = await openSource({
        url: communePath ? null : communeUrl,
        path: communePath,
        gzip: !communePath || communePath.endsWith(".gz"),
      });
      const rowsCommune = await importCommuneStream(communeStream, repo, {
        onProgress: (n) => repo.updateJob(jobId, { rows_commune: n }),
      });

      const depStream = await openSource({
        url: depPath ? null : depUrl,
        path: depPath,
        gzip: false,
      });
      const rowsDep = await importDepartmentStream(depStream, repo, {
        onProgress: (n) => repo.updateJob(jobId, { rows_dep: n }),
      });

      repo.updateJob(jobId, {
        status: "done",
        rows_commune: rowsCommune,
        rows_dep: rowsDep,
        error: null,
      });
      repositories.enrichments?.clearCommuneProvider?.("delinquance");
      logger.info({ jobId, rowsCommune, rowsDep }, "import SSMSI terminé");
    } catch (err) {
      repo.updateJob(jobId, {
        status: "error",
        error: String(err.message || err).slice(0, 2000),
      });
      logger.error({ err, jobId }, "import SSMSI en échec");
    }
  }

  function startImport(options = {}) {
    const running = repo.getRunningJob();
    if (running) {
      return { ok: false, error: "Un import SSMSI est déjà en cours." };
    }

    const sourceUrl = options.communePath || options.communeUrl || config.ssmsi.communeUrl;
    const jobId = repo.createJob({
      sourceLabel: "SSMSI data.gouv",
      sourceUrl: String(sourceUrl).slice(0, 500),
    });

    setImmediate(() => {
      runImport(jobId, options).catch((err) => {
        logger.error({ err, jobId }, "orchestration import SSMSI");
      });
    });

    return { ok: true, jobId };
  }

  function refreshRunningJob() {
    return repo.getRunningJob();
  }

  function dashboard() {
    const latest = repo.getLatestJob();
    const running = repo.getRunningJob();
    const communeRows = repo.countCommuneRows();
    const expectedIndicators = repo.expectedIndicatorCount();
    const indicatorCount = repo.countDistinctIndicators();
    return {
      running,
      latest,
      communeRows,
      departmentRows: repo.countDepartmentRows(),
      hasData: repo.hasData(),
      indicatorCount,
      expectedIndicators,
      needsReimport: repo.needsFullReimport(),
      importProgressPct: running
        ? Math.min(
            99,
            Math.round(
              ((running.rows_commune || 0) / SSMSI_EXPECTED_COMMUNE_ROWS) * 100
            )
          )
        : latest?.status === "done"
          ? 100
          : null,
    };
  }

  return { startImport, refreshRunningJob, dashboard, runImport };
}

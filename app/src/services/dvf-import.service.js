/**
 * Import des fichiers geo-dvf (Etalab) en arrière-plan : un fichier gzip par
 * année (`{baseUrl}/{année}/full.csv.gz`). Pour chaque année, on lit le flux
 * ligne par ligne, on regroupe les lignes contiguës d'une même mutation
 * (`id_mutation`), on nettoie puis on insère par lots. Une fois toutes les
 * années importées, on recalcule les médianes communales.
 */

import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import readline from "node:readline";
import { Readable } from "node:stream";
import config from "../config.js";
import {
  parseDvfCsvLine,
  dvfHeaderIndex,
  parseDvfRow,
  buildMutation,
} from "../lib/dvf-csv.js";

const REQUEST_TIMEOUT_MS = 600_000;
const BATCH_SIZE = 1000;

/**
 * Au-delà de ce délai sans aucune activité, un job encore « running » est
 * considéré interrompu (serveur redémarré, process tué…) et clôturé en erreur.
 * Le battement de cœur ci-dessous met à jour l'horodatage régulièrement pour
 * ne jamais flaguer un import réellement actif.
 */
const STALE_MS = 180_000;

function jobAgeMs(job) {
  const t = Date.parse(job?.updated_at || "");
  return Number.isFinite(t) ? Date.now() - t : Infinity;
}

function lineReaderFromStream(stream) {
  return readline.createInterface({ input: stream, crlfDelay: Infinity });
}

async function openYearStream({ baseUrl, year, path }) {
  if (path) {
    const raw = createReadStream(path);
    return path.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  }
  const url = `${baseUrl}/${year}/full.csv.gz`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) {
    return null; // Année non publiée : ignorée proprement.
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} lors du téléchargement DVF ${year}.`);
  }
  return Readable.fromWeb(response.body).pipe(createGunzip());
}

/**
 * Importe un flux CSV d'une année : regroupe par `id_mutation`, nettoie et
 * insère par lots. Renvoie le nombre de mutations retenues.
 */
async function importYearStream(stream, repo, { onProgress, cleanOptions } = {}) {
  const rl = lineReaderFromStream(stream);
  let headerIndex = null;
  let first = true;

  let currentId = null;
  let currentRows = [];
  let batch = [];
  let imported = 0;

  const flushMutation = () => {
    if (!currentRows.length) return;
    const mutation = buildMutation(currentRows, cleanOptions);
    currentRows = [];
    if (mutation) batch.push(mutation);
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = parseDvfCsvLine(line);
    if (first) {
      headerIndex = dvfHeaderIndex(cols);
      first = false;
      continue;
    }
    const row = parseDvfRow(cols, headerIndex);
    if (!row) continue;

    if (row.id_mutation !== currentId) {
      flushMutation();
      currentId = row.id_mutation;
    }
    currentRows.push(row);

    if (batch.length >= BATCH_SIZE) {
      imported += repo.insertMutationBatch(batch);
      batch = [];
      if (onProgress) onProgress(imported);
    }
  }
  flushMutation();
  if (batch.length) {
    imported += repo.insertMutationBatch(batch);
    if (onProgress) onProgress(imported);
  }
  return imported;
}

export default function createDvfImportService({ repositories, logger }) {
  const repo = repositories.dvf;

  /**
   * Clôt un job « running »/« pending » resté sans activité (orphelin).
   * Renvoie le job actif restant (ou null).
   */
  function reconcileStaleJob() {
    const job = repo.getRunningJob();
    if (job && jobAgeMs(job) > STALE_MS) {
      repo.updateJob(job.id, {
        status: "error",
        current_year: null,
        error:
          "Import interrompu : plus aucune activité détectée (serveur redémarré ?). Relancez-le.",
      });
      logger.warn({ jobId: job.id }, "import DVF orphelin clôturé");
      return repo.getRunningJob();
    }
    return job;
  }

  function cleanYear(value, fallback) {
    const n = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(n) || n < 2000 || n > 2100) return fallback;
    return n;
  }

  async function runImport(jobId, options = {}) {
    const yearFrom = cleanYear(options.yearFrom, config.dvf.yearFrom);
    const yearTo = cleanYear(options.yearTo, config.dvf.yearTo);
    const baseUrl = options.baseUrl || config.dvf.baseUrl;
    const paths = options.paths || null; // { [year]: filePath }, pour les tests
    const cleanOptions = {
      minPriceM2: config.dvf.minPricePerM2,
      maxPriceM2: config.dvf.maxPricePerM2,
    };

    repo.updateJob(jobId, { status: "running" });

    try {
      repo.clearMutations();
      let total = 0;

      for (let year = yearFrom; year <= yearTo; year += 1) {
        const localPath = paths?.[year] || null;
        // Mode fichiers locaux (tests) : n'importer que les années fournies.
        if (paths && !localPath) continue;
        repo.updateJob(jobId, { current_year: year });
        const stream = await openYearStream({ baseUrl, year, path: localPath });
        if (!stream) {
          logger.warn({ jobId, year }, "année DVF non disponible, ignorée");
          continue;
        }
        const yearRows = await importYearStream(stream, repo, {
          cleanOptions,
          onProgress: (n) =>
            repo.updateJob(jobId, { rows_imported: total + n }),
        });
        total += yearRows;
        repo.updateJob(jobId, { rows_imported: total });
        logger.info({ jobId, year, yearRows, total }, "année DVF importée");
      }

      // Médianes communales (parcours ordonné, mémoire bornée).
      // Battement de cœur : on rafraîchit l'horodatage régulièrement pour que ce
      // job ne soit pas pris pour un orphelin pendant un calcul un peu long.
      repo.updateJob(jobId, { current_year: null });
      let lastBeat = Date.now();
      const statRows = repo.rebuildCommuneStats({
        onProgress: () => {
          if (Date.now() - lastBeat > 5000) {
            repo.updateJob(jobId, { current_year: null });
            lastBeat = Date.now();
          }
        },
      });

      repo.updateJob(jobId, {
        status: "done",
        current_year: null,
        rows_imported: total,
        error: null,
      });
      logger.info(
        { jobId, total, statRows },
        "import DVF terminé"
      );
    } catch (err) {
      repo.updateJob(jobId, {
        status: "error",
        error: String(err.message || err).slice(0, 2000),
      });
      logger.error({ err, jobId }, "import DVF en échec");
    }
  }

  function startImport(options = {}) {
    const running = reconcileStaleJob();
    if (running) {
      return { ok: false, error: "Un import DVF est déjà en cours." };
    }

    const yearFrom = cleanYear(options.yearFrom, config.dvf.yearFrom);
    const yearTo = cleanYear(options.yearTo, config.dvf.yearTo);
    if (yearFrom > yearTo) {
      return { ok: false, error: "L'année de début doit précéder l'année de fin." };
    }

    const jobId = repo.createJob({
      sourceLabel: "geo-dvf Etalab",
      sourceUrl: `${config.dvf.baseUrl}/{année}/full.csv.gz`.slice(0, 500),
      yearFrom,
      yearTo,
    });

    setImmediate(() => {
      runImport(jobId, { yearFrom, yearTo }).catch((err) => {
        logger.error({ err, jobId }, "orchestration import DVF");
      });
    });

    return { ok: true, jobId };
  }

  function refreshRunningJob() {
    return reconcileStaleJob();
  }

  function dashboard() {
    const latest = repo.getLatestJob();
    const running = reconcileStaleJob();

    // Progression déterminée : l'import des années occupe 0→90 %, le calcul des
    // médianes 90→100 %. Au sein d'une année, le compteur de ventes retenues
    // rassure sur l'activité même si la barre avance par paliers d'année.
    let importProgressPct = null;
    let phase = null;
    let yearsDone = null;
    let totalYears = null;
    if (running) {
      const yf = running.year_from ?? config.dvf.yearFrom;
      const yt = running.year_to ?? config.dvf.yearTo;
      totalYears = Math.max(1, yt - yf + 1);
      if (running.current_year) {
        phase = "import";
        yearsDone = Math.max(0, running.current_year - yf);
        importProgressPct = Math.min(
          90,
          Math.round(((yearsDone + 0.5) / totalYears) * 90)
        );
      } else if (running.status === "running") {
        phase = "medians";
        importProgressPct = 95;
      } else {
        phase = "starting";
        importProgressPct = 0;
      }
    } else if (latest?.status === "done") {
      importProgressPct = 100;
    }

    // Historique : 10 derniers imports, en excluant celui affiché « en cours ».
    const recentJobs = repo
      .listRecentJobs(20)
      .filter((j) => !running || j.id !== running.id)
      .slice(0, 10);

    return {
      running,
      latest,
      hasData: repo.hasData(),
      mutationRows: repo.countMutations(),
      statRows: repo.countStats(),
      yearFrom: config.dvf.yearFrom,
      yearTo: config.dvf.yearTo,
      importProgressPct,
      phase,
      yearsDone,
      totalYears,
      recentJobs,
    };
  }

  return { startImport, refreshRunningJob, dashboard, runImport };
}

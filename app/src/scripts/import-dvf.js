#!/usr/bin/env node
/**
 * Import DVF (geo-dvf Etalab) en ligne de commande.
 *
 * Usage :
 *   node src/scripts/import-dvf.js            # plage par défaut (config)
 *   node src/scripts/import-dvf.js 2016 2024  # plage d'années explicite
 */

import { openDatabase } from "../db.js";
import createRepositories from "../repositories/index.js";
import createLogger from "../lib/logger.js";
import createDvfImportService from "../services/dvf-import.service.js";
import config from "../config.js";

const yearFrom = Number.parseInt(process.argv[2], 10) || config.dvf.yearFrom;
const yearTo = Number.parseInt(process.argv[3], 10) || config.dvf.yearTo;

const db = openDatabase();
const repositories = createRepositories(db);
const logger = createLogger();
const dvf = createDvfImportService({ repositories, logger });

const result = dvf.startImport({ yearFrom, yearTo });
if (!result.ok) {
  console.error(result.error);
  process.exit(1);
}

const jobId = result.jobId;
console.log(`Import DVF démarré (job #${jobId}) — années ${yearFrom} à ${yearTo}…`);

const poll = () => {
  const job = repositories.dvf.getJob(jobId);
  if (!job) {
    console.error("Job introuvable.");
    process.exit(1);
  }
  if (job.status === "running" || job.status === "pending") {
    const where = job.current_year ? `année ${job.current_year}` : "calcul des médianes";
    process.stdout.write(
      `\r${job.rows_imported} mutations retenues · ${where}         `
    );
    setTimeout(poll, 500);
    return;
  }
  if (job.status === "done") {
    console.log(
      `\nTerminé : ${job.rows_imported} mutations, ${repositories.dvf.countStats()} lignes de statistiques communales.`
    );
    process.exit(0);
  }
  console.error(`\nÉchec : ${job.error || "erreur inconnue"}`);
  process.exit(1);
};

poll();

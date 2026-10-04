#!/usr/bin/env node
/**
 * Import SSMSI en ligne de commande (même logique que l'administration).
 *
 * Usage :
 *   node src/scripts/import-ssmsi.js
 *   node src/scripts/import-ssmsi.js /chemin/commune.csv.gz /chemin/dep.csv
 */

import { openDatabase } from "../db.js";
import createRepositories from "../repositories/index.js";
import createLogger from "../lib/logger.js";
import createSsmsiImportService from "../services/ssmsi-import.service.js";

const communePath = process.argv[2] || null;
const depPath = process.argv[3] || null;

const db = openDatabase();
const repositories = createRepositories(db);
const logger = createLogger();
const ssmsi = createSsmsiImportService({ repositories, logger });

const result = ssmsi.startImport({ communePath, depPath });
if (!result.ok) {
  console.error(result.error);
  process.exit(1);
}

const jobId = result.jobId;
console.log(`Import SSMSI démarré (job #${jobId})…`);

const poll = () => {
  const job = repositories.ssmsi.getJob(jobId);
  if (!job) {
    console.error("Job introuvable.");
    process.exit(1);
  }
  if (job.status === "running" || job.status === "pending") {
    process.stdout.write(
      `\rCommune: ${job.rows_commune} lignes | Département: ${job.rows_dep} lignes`
    );
    setTimeout(poll, 500);
    return;
  }
  if (job.status === "done") {
    console.log(
      `\nTerminé : ${job.rows_commune} lignes communales, ${job.rows_dep} départementales.`
    );
    process.exit(0);
  }
  console.error(`\nÉchec : ${job.error || "erreur inconnue"}`);
  process.exit(1);
};

poll();

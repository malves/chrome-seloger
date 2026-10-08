#!/usr/bin/env node
/**
 * Import DPE open data (ADEME) en ligne de commande — indépendant du serveur web.
 *
 * Filtre sur la date de dernière modification DPE (comme l'administration).
 *
 * Usage :
 *   node src/scripts/import-dpe.js 2025-12-18
 *   node src/scripts/import-dpe.js 2025-12-01 2025-12-05
 *
 * Ne lancez pas deux imports en parallèle sur la même base (serveur + CLI).
 * Voir aussi : npm run dpe:jobs / npm run dpe:watch
 */

import { openDpeCli, watchDpeJobs } from "../lib/dpe-cli.js";
import { logLine } from "../lib/log-format.js";

const dateFrom = process.argv[2];
const dateTo = process.argv[3] || dateFrom;

if (!dateFrom) {
  console.error(
    "Usage : node src/scripts/import-dpe.js AAAA-MM-JJ [AAAA-MM-JJ]\n" +
      "Ex.   : npm run import:dpe -- 2025-12-18"
  );
  process.exit(1);
}

const rangeLabel =
  dateTo === dateFrom ? dateFrom : `${dateFrom} → ${dateTo}`;

logLine("info", "import DPE — démarrage", {
  période: rangeLabel,
  log: process.env.LOG_LEVEL || "info",
});

logLine("info", "connexion à la base SQLite…");
const { repositories, dpe } = openDpeCli();

logLine("info", "préparation du job d'import…");
const started = dpe.startImportBlocking({
  dateFrom,
  dateTo,
  force: true,
});
if (started.error) {
  logLine("error", started.error);
  console.error(
    "Jobs en cours : npm run dpe:jobs -- --running\n" +
      "Annuler       : npm run dpe:jobs -- cancel --day " +
      dateFrom
  );
  process.exit(1);
}

const { jobIds, skippedDays, run } = started;
logLine("info", "import DPE prêt", {
  jobs: jobIds.join(", "),
});
if (skippedDays > 0) {
  logLine("warn", `${skippedDays} jour(s) déjà en cours d'import, ignoré(s).`);
}

const [result] = await Promise.all([
  run(),
  watchDpeJobs(repositories, jobIds),
]);

if (!result.ok) {
  logLine("error", "import DPE en échec", {
    erreur: result.error || "erreur inconnue",
  });
  process.exit(1);
}

const rows = jobIds.reduce((sum, id) => {
  const j = repositories.dpe.getJob(id);
  return sum + (j?.rows_imported || 0);
}, 0);
logLine("info", "import DPE terminé", {
  lignes: rows.toLocaleString("fr-FR"),
  jours: jobIds.length,
  total_base: repositories.dpe.count().toLocaleString("fr-FR"),
});
process.exit(0);

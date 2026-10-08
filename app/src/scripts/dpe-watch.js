#!/usr/bin/env node
/**
 * Suit la progression d'un import DPE via la base (jobs créés par l'admin ou la CLI).
 *
 * Les logs détaillés (requêtes ADEME, etc.) restent dans le terminal du process
 * qui exécute l'import ; cette commande lit uniquement `dpe_import_jobs`.
 *
 * Usage :
 *   npm run dpe:watch -- 87
 *   npm run dpe:watch -- --day 2025-12-18
 *   npm run dpe:watch -- --running
 */

import { isValidDay } from "../services/dpe-opendata.service.js";
import {
  openDpeCli,
  resolveWatchJobIds,
  watchDpeJobs,
  describeJob,
} from "../lib/dpe-cli.js";
import { logLine } from "../lib/log-format.js";

const argv = process.argv.slice(2);

function usage() {
  console.error(
    "Usage :\n" +
      "  npm run dpe:watch -- <id>\n" +
      "  npm run dpe:watch -- --day AAAA-MM-JJ\n" +
      "  npm run dpe:watch -- --running"
  );
  process.exit(1);
}

if (!argv.length) usage();

let jobId = null;
let day = null;
let allRunning = false;

if (argv[0] === "--running") {
  allRunning = true;
} else if (argv[0] === "--day") {
  day = argv[1];
  if (!isValidDay(day)) {
    logLine("error", "Date invalide (AAAA-MM-JJ).");
    process.exit(1);
  }
} else if (/^\d+$/.test(argv[0])) {
  jobId = Number.parseInt(argv[0], 10);
} else {
  usage();
}

const { repositories } = openDpeCli();
const resolved = resolveWatchJobIds(repositories, { jobId, day, allRunning });
if (resolved.error) {
  logLine("error", resolved.error);
  console.error(
    "Astuce : npm run dpe:jobs -- --running  pour lister les imports actifs."
  );
  process.exit(1);
}

if (resolved.note) {
  logLine("warn", resolved.note);
}

for (const id of resolved.jobIds) {
  const info = describeJob(repositories.dpe.getJob(id));
  logLine("info", "suivi du job", {
    job: id,
    période: info.range,
    statut: info.status,
  });
}

logLine(
  "info",
  "rafraîchissement toutes les 5 s — Ctrl+C pour quitter (l'import continue en arrière-plan)"
);

const result = await watchDpeJobs(repositories, resolved.jobIds);

if (!result.ok) {
  logLine("error", "suivi terminé en échec", {
    erreur: result.error || "erreur inconnue",
  });
  process.exit(1);
}

logLine("info", "import terminé (plus aucun job suivi en cours)");
process.exit(0);

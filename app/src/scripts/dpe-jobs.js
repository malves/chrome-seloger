#!/usr/bin/env node
/**
 * Liste et annule les jobs d'import DPE (état en base SQLite).
 *
 * Usage :
 *   npm run dpe:jobs
 *   npm run dpe:jobs -- --running
 *   npm run dpe:jobs -- 20
 *   npm run dpe:jobs -- cancel 87
 *   npm run dpe:jobs -- cancel --day 2025-12-18
 */

import { isValidDay } from "../services/dpe-opendata.service.js";
import { isJobRunning } from "../lib/dpe-import-job.js";
import {
  openDpeCli,
  printJobsTable,
  jobsForDay,
} from "../lib/dpe-cli.js";
import { logLine } from "../lib/log-format.js";

const argv = process.argv.slice(2);

function usage() {
  console.error(
    "Usage :\n" +
      "  npm run dpe:jobs                    # 15 derniers jobs\n" +
      "  npm run dpe:jobs -- 30              # 30 derniers jobs\n" +
      "  npm run dpe:jobs -- --running       # jobs pending/running\n" +
      "  npm run dpe:jobs -- cancel <id>     # annule un import en cours\n" +
      "  npm run dpe:jobs -- cancel --day AAAA-MM-JJ"
  );
  process.exit(1);
}

const { repositories, dpe } = openDpeCli();

if (argv[0] === "cancel") {
  let jobId = null;
  if (argv[1] === "--day" && argv[2]) {
    if (!isValidDay(argv[2])) {
      logLine("error", "Date invalide (AAAA-MM-JJ).");
      process.exit(1);
    }
    const active = jobsForDay(repositories, argv[2]).find((j) => isJobRunning(j));
    if (!active) {
      logLine("error", `Aucun import en cours pour ${argv[2]}.`);
      process.exit(1);
    }
    jobId = active.id;
  } else {
    jobId = Number.parseInt(argv[1], 10);
  }
  if (!Number.isFinite(jobId) || jobId < 1) {
    usage();
  }
  const result = dpe.cancelRunningImport({ jobId });
  if (result.error) {
    logLine("error", result.error);
    process.exit(1);
  }
  logLine("info", "import annulé", { job: jobId });
  process.exit(0);
}

let limit = 15;
let runningOnly = false;

for (const arg of argv) {
  if (arg === "--running") runningOnly = true;
  else if (/^\d+$/.test(arg)) limit = Number.parseInt(arg, 10);
  else usage();
}

const jobs = runningOnly
  ? repositories.dpe.listRunningJobs()
  : repositories.dpe.listRecentJobs(limit);

printJobsTable(jobs);

/**
 * Utilitaires CLI pour les imports DPE (liste, suivi, formatage).
 */

import { openDatabase } from "../db.js";
import createRepositories from "../repositories/index.js";
import createLogger from "../lib/logger.js";
import createDpeOpendataService from "../services/dpe-opendata.service.js";
import {
  isJobRunning,
  isJobStale,
  jobProgressPercent,
  jobStatusLabel,
  jobRange,
  staleUserMessage,
  activityAgeMs,
} from "./dpe-import-job.js";
import { logLine } from "./log-format.js";

export const WATCH_INTERVAL_MS = 5000;

export function openDpeCli() {
  const db = openDatabase();
  const repositories = createRepositories(db);
  const logger = createLogger({ level: process.env.LOG_LEVEL || "info" });
  const dpe = createDpeOpendataService({ repositories, logger });
  return { db, repositories, dpe };
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "?";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function formatActivityAge(job) {
  const ms = activityAgeMs(job);
  if (!Number.isFinite(ms) || ms === Infinity) return "—";
  return formatDuration(ms / 1000);
}

export function describeJob(job) {
  if (!job) return null;
  const stale = isJobStale(job);
  const label = jobStatusLabel(job.status, { stale });
  const pct = jobProgressPercent(job);
  const day = job.current_day || job.date_from;
  const total = job.day_rows_total || 0;
  const done = job.day_rows_done || 0;
  let progress = "—";
  if (job.status === "done") {
    progress = `${(job.rows_imported || 0).toLocaleString("fr-FR")} lignes`;
  } else if (total > 0) {
    progress = `${done.toLocaleString("fr-FR")}/${total.toLocaleString("fr-FR")} (${pct} %)`;
  } else if (isJobRunning(job)) {
    progress = "préparation…";
  }
  return {
    id: job.id,
    status: label,
    rawStatus: job.status,
    stale,
    range: jobRange(job),
    day,
    progress,
    rows: job.rows_imported || 0,
    updated: job.updated_at,
    inactive: formatActivityAge(job),
    error: job.error || null,
    staleHint: stale ? staleUserMessage(job) : null,
  };
}

/** Jobs récents qui couvrent un jour donné (date de modification DPE). */
export function jobsForDay(repositories, day, scanLimit = 80) {
  return repositories.dpe
    .listRecentJobs(scanLimit)
    .filter((j) => j.date_from <= day && day <= j.date_to);
}

export function resolveWatchJobIds(repositories, { jobId, day, allRunning }) {
  if (jobId) {
    const job = repositories.dpe.getJob(jobId);
    if (!job) return { error: `Job #${jobId} introuvable.` };
    return { jobIds: [jobId] };
  }
  if (day) {
    const matches = jobsForDay(repositories, day);
    const active = matches.find((j) => isJobRunning(j));
    const pick = active || matches[0];
    if (!pick) {
      return { error: `Aucun job trouvé pour le jour ${day}.` };
    }
    return { jobIds: [pick.id], note: active ? null : "Dernier job connu (plus actif)." };
  }
  if (allRunning) {
    const running = repositories.dpe.listRunningJobs();
    if (!running.length) {
      return { error: "Aucun import DPE en cours (pending/running)." };
    }
    return { jobIds: running.map((j) => j.id) };
  }
  return {
    error:
      "Indiquez un numéro de job, un jour (--day AAAA-MM-JJ) ou --running.",
  };
}

/**
 * Affiche la progression des jobs jusqu'à leur fin (lecture base uniquement :
 * ne peut pas rejoindre les logs pino d'un autre process).
 */
export async function watchDpeJobs(repositories, jobIds, { intervalMs = WATCH_INTERVAL_MS } = {}) {
  const ids = [...new Set(jobIds.map((id) => Number(id)).filter((id) => id > 0))];
  if (!ids.length) return { ok: false, error: "Aucun job à suivre." };

  let lastDoneByJob = new Map(ids.map((id) => [id, 0]));
  let lastAt = Date.now();

  const tick = () => {
    const now = Date.now();
    const elapsed = (now - lastAt) / 1000;
    lastAt = now;

    for (const id of ids) {
      const job = repositories.dpe.getJob(id);
      if (!job) {
        logLine("warn", "job introuvable", { id });
        continue;
      }
      const info = describeJob(job);
      const total = job.day_rows_total || 0;
      const done = job.day_rows_done || 0;
      const prev = lastDoneByJob.get(id) ?? 0;
      const rate =
        elapsed > 0 ? Math.max(0, Math.round((done - prev) / elapsed)) : 0;
      lastDoneByJob.set(id, done);

      const fields = {
        job: id,
        statut: info.status,
        jour: info.day,
        progression: info.progress,
        inactif: info.inactive,
      };
      if (info.stale) fields.alerte = "bloqué ?";
      if (total > 0 && isJobRunning(job) && rate > 0) {
        const remaining = Math.max(0, total - done);
        fields.débit = `${rate.toLocaleString("fr-FR")}/s`;
        fields.reste = formatDuration(remaining / rate);
      }
      logLine(isJobRunning(job) ? "info" : "debug", "suivi import DPE", fields);
      if (info.staleHint && isJobRunning(job)) {
        logLine("warn", info.staleHint, { job: id });
      }
      if (job.status === "error" && job.error) {
        logLine("error", job.error.slice(0, 500), { job: id });
      }
    }
  };

  const finishIfDone = (resolve) => {
    const jobs = ids.map((id) => repositories.dpe.getJob(id)).filter(Boolean);
    const anyRunning = jobs.some((j) => isJobRunning(j));
    if (!anyRunning) {
      const failed = jobs.find((j) => j.status === "error");
      if (failed) {
        resolve({ ok: false, error: failed.error || "Import en échec.", jobIds: ids });
      } else {
        resolve({ ok: true, jobIds: ids });
      }
      return true;
    }
    return false;
  };

  tick();
  return await new Promise((resolve) => {
    if (finishIfDone(resolve)) return;

    const timer = setInterval(() => {
      tick();
      if (finishIfDone(resolve)) {
        clearInterval(timer);
      }
    }, intervalMs);
  });
}

export function printJobsTable(jobs) {
  if (!jobs.length) {
    console.log("Aucun job d'import DPE.");
    return;
  }
  console.log(
    "  ID    Statut        Jour(s)           Progression                    MAJ (inactif)  Mis à jour"
  );
  console.log(
    "  ----  ------------  ----------------  -----------------------------  ------------  -------------------"
  );
  for (const job of jobs) {
    const info = describeJob(job);
    const id = String(info.id).padStart(4);
    const status = info.status.padEnd(12).slice(0, 12);
    const range = info.range.padEnd(16).slice(0, 16);
    const progress = info.progress.padEnd(29).slice(0, 29);
    const inactive = info.inactive.padEnd(12).slice(0, 12);
    const updated = (info.updated || "").replace("T", " ").slice(0, 19);
    console.log(`  ${id}  ${status}  ${range}  ${progress}  ${inactive}  ${updated}`);
    if (info.stale) {
      console.log(`        ⚠ ${info.staleHint}`);
    }
    if (info.error && job.status === "error") {
      const err = info.error.replace(/\s+/g, " ").slice(0, 100);
      console.log(`        ✖ ${err}`);
    }
  }
  console.log(
    "\nSuivre un import : npm run dpe:watch -- <id>  ou  npm run dpe:watch -- --day AAAA-MM-JJ"
  );
  console.log(
    "Annuler un job    : npm run dpe:jobs -- cancel <id>"
  );
}

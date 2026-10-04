/**
 * État affiché d'un job d'import DPE : progression, blocage probable, actions.
 */

/** Sans aucune ligne reçue (1ʳᵉ requête ADEME bloquée ou process mort). */
export const STALE_QUIET_MS = 4 * 60 * 1000;

/** Import actif mais sans mise à jour de progression (long insert ou réseau). */
export const STALE_ACTIVE_MS = 12 * 60 * 1000;

const STALE_AUTO_RECONCILE_MS = STALE_QUIET_MS;

export function isJobRunning(job) {
  return Boolean(job && (job.status === "running" || job.status === "pending"));
}

export function activityAgeMs(job) {
  if (!job?.updated_at) return Infinity;
  const t = Date.parse(job.updated_at);
  if (Number.isNaN(t)) return Infinity;
  return Math.max(0, Date.now() - t);
}

/** Vrai si le job semble orphelin ou bloqué (seuils adaptés au stade). */
export function isJobStale(job, now = Date.now()) {
  if (!isJobRunning(job)) return false;
  const age = activityAgeMs(job);
  const quiet =
    job.rows_imported === 0 &&
    job.day_rows_total === 0 &&
    job.days_done === 0;
  const threshold = quiet ? STALE_QUIET_MS : STALE_ACTIVE_MS;
  return age >= threshold;
}

/** Seuil pour clôturer automatiquement un job au prochain rafraîchissement UI. */
export function shouldAutoReconcileStale(job) {
  if (!isJobRunning(job)) return false;
  const quiet =
    job.rows_imported === 0 &&
    job.day_rows_total === 0 &&
    job.days_done === 0;
  if (!quiet) return isJobStale(job);
  return activityAgeMs(job) >= STALE_AUTO_RECONCILE_MS;
}

export function staleUserMessage(job) {
  const quiet =
    job.rows_imported === 0 &&
    job.day_rows_total === 0 &&
    job.days_done === 0;
  if (quiet) {
    return "Aucune donnée reçue depuis longtemps. L'import a probablement été interrompu (redémarrage du serveur ou réseau). Vous pouvez le libérer puis relancer.";
  }
  return "Aucune progression depuis longtemps. L'import est peut‑être bloqué sur le réseau ou une grosse insertion en base. Vous pouvez attendre encore un peu ou l'interrompre.";
}

export function jobProgressPercent(job) {
  if (!job?.days_total) {
    return job?.status === "done" ? 100 : 0;
  }
  const active = isJobRunning(job);
  const dayFrac =
    job.day_rows_total > 0
      ? Math.min(1, job.day_rows_done / job.day_rows_total)
      : 0;
  const done = job.days_done + (active ? dayFrac : 0);
  return Math.max(0, Math.min(100, Math.round((done / job.days_total) * 100)));
}

export function jobBadgeTone(status) {
  if (status === "done") return "accent";
  if (status === "error") return "error";
  return "info";
}

export function jobStatusLabel(status, { stale = false } = {}) {
  if (stale && isJobRunning({ status })) return "Bloqué ?";
  if (status === "running") return "En cours";
  if (status === "pending") return "En attente";
  if (status === "done") return "Terminé";
  return "Erreur";
}

export function jobRange(job) {
  if (!job) return "";
  return job.date_from + (job.date_to !== job.date_from ? ` → ${job.date_to}` : "");
}

/** Données prêtes pour la vue admin (barre, badges, actions). */
export function buildJobView(job) {
  if (!job) {
    return {
      job: null,
      running: false,
      stale: false,
      pct: 0,
      animateProgress: false,
      poll: false,
      showCancel: false,
      showRetry: false,
      showCurrentPanel: false,
      blockNewImport: false,
      badgeTone: "neutral",
      statusLabel: "",
    };
  }

  const running = isJobRunning(job);
  const stale = running && isJobStale(job);

  return {
    job,
    running,
    stale,
    pct: jobProgressPercent(job),
    animateProgress: running && !stale,
    poll: running,
    showCancel: running,
    showRetry: job.status === "error",
    /** Bloc progression : uniquement tant que l'import tourne (pas de doublon avec l'historique). */
    showCurrentPanel: running,
    blockNewImport: running && !stale,
    badgeTone: stale ? "warn" : jobBadgeTone(job.status),
    statusLabel: jobStatusLabel(job.status, { stale }),
    staleMessage: stale ? staleUserMessage(job) : null,
  };
}

/** Agrégat pour la zone « imports en cours » (un worker par jour). */
export function buildImportDashboard(activeJobs = []) {
  const activeJobViews = (activeJobs || []).map((job) => buildJobView(job));
  return {
    activeJobViews,
    poll: activeJobViews.some((v) => v.poll),
    blockNewImport: activeJobViews.some((v) => v.blockNewImport),
    showActivePanel: activeJobViews.some((v) => v.showCurrentPanel),
  };
}

/**
 * Import de la base DPE open data (ADEME, dataset `dpe03existant`).
 *
 * L'API plafonne `size` à 10 000 lignes par page, or il y a ~13 000 DPE par
 * jour : on télécharge donc **jour par jour** (un seul jour par requête, jamais
 * plusieurs jours dans le même GET) puis on suit le curseur `next` jusqu'à
 * épuisement. Avant chaque jour, les lignes déjà en base pour cette date de
 * dernière modification sont supprimées pour éviter les doublons lors d'un ré-import.
 * Chaque page est insérée en base puis libérée : aucune donnée n'est écrite sur
 * disque, seule la base contient le résultat.
 *
 * L'import s'exécute en arrière-plan dans le même process (comme
 * l'orchestration d'enrichissement) et met à jour un job suivi en base, relu
 * par l'interface via un sondage htmx. Chaque jour sélectionné est un job
 * distinct, exécuté en parallèle (un worker par jour).
 */

const DATASET_URL =
  "https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines";

/**
 * Taille de page demandée. L'API accepte jusqu'à 10 000, mais une page aussi
 * volumineuse sature régulièrement la passerelle ADEME (502/503) et allonge
 * chaque requête. Des pages plus petites = requêtes plus légères, beaucoup plus
 * fiables, au prix de quelques requêtes supplémentaires par jour (~7 au lieu de 2).
 */
const PAGE_SIZE = 2000;

/** Délai maximum par requête (une page reste conséquente). */
const REQUEST_TIMEOUT_MS = 90_000;

/** Nombre de tentatives supplémentaires en cas d'échec passager d'une page. */
const REQUEST_RETRIES = 5;

/** Petite pause entre deux requêtes réussies, pour ménager l'API. */
const THROTTLE_MS = 400;

/** Backoff de base entre deux tentatives ratées (croît exponentiellement). */
const RETRY_BACKOFF_MS = 1500;

/** Plafond du backoff entre tentatives, pour ne pas attendre indéfiniment. */
const RETRY_BACKOFF_MAX_MS = 30_000;

/** Statuts HTTP considérés comme passagers (passerelle saturée / limitation). */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Nombre maximum de jours importés simultanément. Au-delà, les jours sont mis
 * en file d'attente (statut « En attente ») et démarrent au fur et à mesure.
 * Limiter la parallélisation évite de saturer la passerelle ADEME (502/503)
 * lorsqu'on importe une grande plage de dates.
 */
const MAX_CONCURRENT_DAYS = 3;

/**
 * Intervalle de « rafraîchissement » des jobs encore en file d'attente : on
 * remet à jour leur horodatage pour qu'ils ne soient pas pris pour des imports
 * bloqués pendant leur attente. Si le process meurt, ce battement s'arrête et
 * les jobs orphelins finissent par être clôturés automatiquement.
 */
const QUEUE_HEARTBEAT_MS = 60_000;

import config from "../config.js";
import {
  isJobRunning,
  isJobStale,
  shouldAutoReconcileStale,
} from "../lib/dpe-import-job.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MSG_STALE_AUTO =
  "Import interrompu : plus aucune activité détectée. Relancez-le depuis le calendrier.";
const MSG_CANCELLED = "Import annulé depuis l'administration.";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Vrai si `YYYY-MM-DD` est une date valide. */
export function isValidDay(value) {
  if (!DATE_RE.test(String(value || ""))) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Liste des jours (inclus) de `from` à `to`, ordre chronologique. */
export function daysBetween(from, to) {
  const days = [];
  const current = new Date(`${from}T00:00:00Z`);
  const last = new Date(`${to}T00:00:00Z`);
  while (current.getTime() <= last.getTime()) {
    days.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return days;
}

/** Erreur HTTP transportant le code de statut et un éventuel délai d'attente. */
class HttpError extends Error {
  constructor(status, url, retryAfterMs) {
    super(`HTTP ${status} sur ${url}`);
    this.name = "HttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Convertit l'en-tête `Retry-After` (secondes ou date HTTP) en millisecondes. */
function parseRetryAfter(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/** Vrai pour les échecs qu'il vaut la peine de réessayer (passagers). */
function isRetryable(err) {
  if (err instanceof HttpError) return RETRYABLE_STATUS.has(err.status);
  // Timeout (AbortError) ou coupure réseau : réessayables.
  return true;
}

/** Délai avant la prochaine tentative : `Retry-After` sinon backoff + jitter. */
function retryDelayMs(err, attempt) {
  if (err instanceof HttpError && err.retryAfterMs != null) {
    return Math.min(err.retryAfterMs, RETRY_BACKOFF_MAX_MS);
  }
  const base = Math.min(RETRY_BACKOFF_MS * 2 ** attempt, RETRY_BACKOFF_MAX_MS);
  // Jitter ±25 % pour éviter de retomber en même temps sur une passerelle saturée.
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/** Échappe une valeur pour l'insérer entre guillemets simples dans un shell. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Commande `wget` reproduisant la 1ʳᵉ requête envoyée pour un jour donné
 * (mêmes paramètres, même en-tête, même timeout). Utile pour rejouer/déboguer
 * l'appel à l'API ADEME à la main. La pagination se poursuit ensuite via le
 * champ `next` de la réponse.
 */
function buildWgetCommand(url, day) {
  const timeoutSec = Math.round(REQUEST_TIMEOUT_MS / 1000);
  return [
    "wget",
    `--tries=${REQUEST_RETRIES + 1}`,
    `--timeout=${timeoutSec}`,
    "--header=" + shellQuote("accept: application/json"),
    "-O " + shellQuote(`dpe_${day}.json`),
    shellQuote(url),
  ].join(" ");
}

/** Message lisible pour l'admin à partir d'une erreur d'import. */
function friendlyErrorMessage(err) {
  if (err instanceof HttpError) {
    if (err.status === 429) {
      return "L'API ADEME limite les téléchargements (HTTP 429). Réessayez un peu plus tard.";
    }
    if (err.status >= 500) {
      return `Le serveur ADEME est momentanément indisponible (HTTP ${err.status}). Réessayez plus tard.`;
    }
    return err.message;
  }
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return "Délai dépassé : l'API ADEME a mis trop de temps à répondre. Réessayez plus tard.";
  }
  return String(err?.message || err);
}

async function fetchJson(url, { logger, onRetry } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new HttpError(
          response.status,
          url,
          parseRetryAfter(response.headers.get("retry-after"))
        );
      }
      return await response.json();
    } catch (err) {
      lastError = err;
      if (attempt >= REQUEST_RETRIES || !isRetryable(err)) break;
      const wait = retryDelayMs(err, attempt);
      logger?.warn(
        { attempt: attempt + 1, retries: REQUEST_RETRIES, wait, err: err.message },
        "requête DPE en échec, nouvelle tentative"
      );
      // Signale que le job est toujours actif (évite qu'il soit vu « bloqué »).
      onRetry?.();
      await sleep(wait);
    }
  }
  throw lastError;
}

export default function createDpeOpendataService({ repositories, logger }) {
  const repo = repositories.dpe;

  /** URL de la première page d'un jour donné. */
  function firstPageUrl(day) {
    const query = new URLSearchParams({
      size: String(PAGE_SIZE),
      date_derniere_modification_dpe_gte: day,
      date_derniere_modification_dpe_lte: day,
    });
    return `${DATASET_URL}?${query}`;
  }

  /**
   * Importe un jour : suit le curseur `next` jusqu'à épuisement, en insérant
   * chaque page puis en la libérant. Renvoie le nombre de lignes insérées.
   *
   * `onTotal(total)` est appelé dès la première page (nombre de lignes attendu
   * pour la journée), `onProgress(done)` après chaque page insérée : de quoi
   * faire avancer une barre de progression même au sein d'une seule journée.
   */
  function jobIsActive(jobId) {
    const job = repo.getJob(jobId);
    return Boolean(job && job.status === "running");
  }

  /** Clôt un job bloqué ou annulé (libère un nouvel import). */
  function interruptJob(jobId, message) {
    repo.updateJob(jobId, {
      status: "error",
      error: String(message || MSG_STALE_AUTO).slice(0, 2000),
      current_day: null,
    });
    logger.warn({ jobId, message }, "import DPE interrompu");
  }

  function reconcileStaleJob(job) {
    if (!job || !shouldAutoReconcileStale(job)) return job;
    interruptJob(job.id, MSG_STALE_AUTO);
    return repo.getJob(job.id);
  }

  async function importDay(
    day,
    { onTotal, onProgress, onRetry, shouldContinue } = {}
  ) {
    if (shouldContinue && !shouldContinue()) return null;

    const removed = repo.deleteByModificationDay(day);
    if (removed) {
      logger.info({ day, removed }, "DPE existants du jour supprimés avant import");
    }

    let url = firstPageUrl(day);
    let imported = 0;
    let first = true;

    while (url) {
      if (shouldContinue && !shouldContinue()) return imported;

      const payload = await fetchJson(url, { logger, onRetry });
      const results = Array.isArray(payload?.results) ? payload.results : [];
      if (first) {
        if (typeof payload?.total === "number" && onTotal) onTotal(payload.total);
        first = false;
      }
      if (results.length) {
        imported += repo.upsertMany(results);
        if (onProgress) onProgress(imported);
      }
      // La page est maintenant en base : on ne garde que le curseur suivant.
      url = results.length && payload?.next ? payload.next : null;
      if (url) await sleep(THROTTLE_MS);
    }

    return imported;
  }

  /** Exécute le job en arrière-plan, jour par jour. */
  async function runJob(jobId, days) {
    repo.updateJob(jobId, { status: "running" });
    let rowsImported = 0;
    const shouldContinue = () => jobIsActive(jobId);

    try {
      for (let i = 0; i < days.length; i += 1) {
        if (!shouldContinue()) {
          logger.info({ jobId }, "import DPE abandonné (job plus actif)");
          return;
        }

        const day = days[i];
        repo.updateJob(jobId, {
          current_day: day,
          day_rows_total: 0,
          day_rows_done: 0,
        });

        const dayRows = await importDay(day, {
          shouldContinue,
          // Bump `updated_at` à chaque tentative pour que le job ne soit pas
          // considéré « bloqué » pendant un backoff ADEME un peu long.
          onRetry: () => {
            repo.updateJob(jobId, { current_day: day });
          },
          onTotal: (total) => {
            repo.updateJob(jobId, { day_rows_total: total });
          },
          onProgress: (done) => {
            repo.updateJob(jobId, {
              day_rows_done: done,
              rows_imported: rowsImported + done,
            });
          },
        });

        if (dayRows === null || !shouldContinue()) {
          logger.info({ jobId, day }, "import DPE abandonné en cours de journée");
          return;
        }

        rowsImported += dayRows;
        repo.updateJob(jobId, {
          days_done: i + 1,
          rows_imported: rowsImported,
          day_rows_done: dayRows,
        });
        logger.info(
          { jobId, day, dayRows, rowsImported },
          "jour DPE importé"
        );
      }

      if (!shouldContinue()) return;

      repo.updateJob(jobId, { status: "done", current_day: null });
      logger.info({ jobId, rowsImported }, "import DPE terminé");
    } catch (err) {
      if (!jobIsActive(jobId)) return;
      repo.updateJob(jobId, {
        status: "error",
        error: friendlyErrorMessage(err).slice(0, 2000),
      });
      logger.error({ jobId, err: err.message }, "import DPE en échec");
    }
  }

  /* ----------------------- Ordonnanceur (pool) ----------------------- */

  // File d'attente partagée : chaque entrée est { jobId, days: [...] }.
  const queue = [];
  let activeWorkers = 0;
  let heartbeat = null;

  /** Remet à jour l'horodatage des jobs encore en file (anti-faux-blocage). */
  function touchQueuedJobs() {
    for (const item of queue) {
      const job = repo.getJob(item.jobId);
      if (job && isJobRunning(job)) {
        repo.updateJob(item.jobId, { current_day: null });
      }
    }
  }

  function startHeartbeat() {
    if (heartbeat || config.isTest) return;
    heartbeat = setInterval(touchQueuedJobs, QUEUE_HEARTBEAT_MS);
    // Ne pas empêcher le process de se terminer à cause de ce timer.
    if (typeof heartbeat.unref === "function") heartbeat.unref();
  }

  function stopHeartbeatIfIdle() {
    if (heartbeat && queue.length === 0 && activeWorkers === 0) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  /** Démarre autant de workers que le plafond l'autorise. */
  function pump() {
    while (activeWorkers < MAX_CONCURRENT_DAYS && queue.length) {
      const { jobId, days } = queue.shift();
      const job = repo.getJob(jobId);
      // Le job a pu être annulé/clôturé pendant son attente en file.
      if (!job || !isJobRunning(job)) continue;

      activeWorkers += 1;
      runJob(jobId, days)
        .catch((err) => {
          logger.error({ jobId, days, err }, "orchestration import DPE");
          repo.updateJob(jobId, {
            status: "error",
            error: friendlyErrorMessage(err).slice(0, 2000),
          });
        })
        .finally(() => {
          activeWorkers -= 1;
          pump();
          stopHeartbeatIfIdle();
        });
    }
  }

  /** Place des jobs en file puis réveille le pool (sauf en test). */
  function enqueueJobs(items) {
    for (const item of items) queue.push(item);
    if (config.isTest) return;
    startHeartbeat();
    pump();
  }

  return {
    refreshRunningJobs() {
      const jobs = repo.listRunningJobs();
      const active = [];
      for (const job of jobs) {
        const reconciled = reconcileStaleJob(job);
        if (reconciled && isJobRunning(reconciled)) {
          active.push(reconciled);
        }
      }
      return active;
    },

    /**
     * Démarre un import sur une plage de jours (inclus). Un job par jour, mais
     * au plus `MAX_CONCURRENT_DAYS` s'exécutent en parallèle : les autres
     * attendent leur tour. Les jours déjà en cours sont ignorés.
     */
    startImport({ dateFrom, dateTo }) {
      if (!isValidDay(dateFrom) || !isValidDay(dateTo)) {
        return { error: "Dates invalides (format attendu AAAA-MM-JJ)." };
      }
      if (dateFrom > dateTo) {
        return { error: "La date de début doit précéder la date de fin." };
      }

      for (const job of repo.listRunningJobs()) {
        if (isJobStale(job)) {
          interruptJob(job.id, MSG_STALE_AUTO);
        }
      }

      const busyDays = repo.runningDays();
      const days = daysBetween(dateFrom, dateTo);
      const toImport = days.filter((day) => !busyDays.has(day));
      const skipped = days.length - toImport.length;

      if (!toImport.length) {
        return {
          error:
            skipped > 0
              ? "Tous les jours sélectionnés sont déjà en cours d'import."
              : "Aucun jour à importer.",
        };
      }

      const jobs = [];
      const items = [];
      for (const day of toImport) {
        const jobId = repo.createJob({
          dateFrom: day,
          dateTo: day,
          daysTotal: 1,
        });
        jobs.push(repo.getJob(jobId));
        items.push({ jobId, days: [day] });
      }

      // Les jours au-delà du plafond restent « En attente » et démarreront seuls.
      enqueueJobs(items);

      return { jobs, skippedDays: skipped };
    },

    getRunningJob() {
      return repo.getRunningJob();
    },

    getLatestJob() {
      return repo.getLatestJob();
    },

    /** Dernier job, en clôturant automatiquement un import orphelin trop ancien. */
    refreshLatestJob() {
      const active = this.refreshRunningJobs();
      if (active.length) return active[active.length - 1];
      return repo.getLatestJob();
    },

    cancelRunningImport({ jobId } = {}) {
      const id = Number.parseInt(String(jobId ?? ""), 10);
      if (!Number.isFinite(id) || id < 1) {
        return { error: "Aucun import en cours pour ce jour." };
      }
      const job = repo.getJob(id);
      if (!job || !isJobRunning(job)) {
        return { error: "Aucun import en cours pour ce jour." };
      }
      interruptJob(id, MSG_CANCELLED);
      return { jobs: [repo.getJob(id)] };
    },

    /**
     * Relance un import terminé en erreur **dans la même ligne** : on
     * réinitialise la progression du job existant puis on le ré-exécute, au lieu
     * de créer un nouveau job (évite d'empiler les lignes dans l'historique).
     */
    retryImport(jobId) {
      const id = Number.parseInt(String(jobId ?? ""), 10);
      if (!Number.isFinite(id) || id < 1) {
        return { error: "Import à relancer introuvable." };
      }

      const job = repo.getJob(id);
      if (!job) {
        return { error: "Import à relancer introuvable." };
      }
      if (job.status !== "error") {
        return { error: "Seuls les imports en échec peuvent être relancés." };
      }
      if (!isValidDay(job.date_from) || !isValidDay(job.date_to)) {
        return { error: "Les dates enregistrées pour cet import sont invalides." };
      }

      const days = daysBetween(job.date_from, job.date_to);

      // Ne pas relancer si un autre import couvre déjà ces jours.
      const busyDays = repo.runningDays();
      if (days.some((day) => busyDays.has(day))) {
        return { error: "Ces jours sont déjà en cours d'import." };
      }

      // On réinitialise le job existant (même ligne) avant de le relancer.
      repo.updateJob(id, {
        status: "pending",
        current_day: null,
        days_total: days.length,
        days_done: 0,
        rows_imported: 0,
        day_rows_total: 0,
        day_rows_done: 0,
        error: null,
      });
      const refreshed = repo.getJob(id);

      // Relance dans la même ligne, en passant par le pool (plafond de parallélisme).
      enqueueJobs([{ jobId: id, days }]);

      return { jobs: [refreshed] };
    },

    getRecentJobs(limit = 10) {
      return repo.listRecentJobs(limit);
    },

    getJob(id) {
      return repo.getJob(id);
    },

    /**
     * Requêtes ADEME correspondant à un job (une par jour couvert) : URL exacte
     * et commande `wget` équivalente, pour inspection/débogage depuis l'admin.
     */
    jobRequests(job) {
      if (!job || !isValidDay(job.date_from) || !isValidDay(job.date_to)) {
        return [];
      }
      return daysBetween(job.date_from, job.date_to).map((day) => {
        const url = firstPageUrl(day);
        return { day, url, wget: buildWgetCommand(url, day) };
      });
    },
  };
}

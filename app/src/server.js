/**
 * Point d'entrée du serveur : ouvre la base, applique les migrations et écoute.
 */

import config from "./config.js";
import createApp from "./app.js";
import createLogger from "./lib/logger.js";

const logger = createLogger();
const app = createApp({ logger });

const server = app.listen(config.port, () => {
  logger.info(
    { port: config.port, env: config.env, baseUrl: config.baseUrl },
    "Carnet de Visites démarré — en écoute (Ctrl+C pour arrêter)"
  );
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    logger.fatal(
      { port: config.port, err },
      `le port ${config.port} est déjà utilisé — arrêtez l'autre instance ou changez PORT dans .env`
    );
  } else {
    logger.fatal({ err }, "impossible de démarrer le serveur");
  }
  process.exit(1);
});

/** Délai HTTP avant fermeture forcée si des requêtes traînent encore. */
const SHUTDOWN_GRACE_MS = 2500;
/** Temps laissé aux enrichissements en arrière-plan (vision ≈ 1–2 min / annonce). */
const SHUTDOWN_ENRICHMENT_MS = 180000;

let shuttingDown = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let shutdownForceTimer;

function closeDatabase() {
  try {
    app.locals.db?.close();
  } catch {
    // La base est peut-être déjà fermée : rien à faire.
  }
}

function exitAfterShutdown(code) {
  if (shutdownForceTimer) clearTimeout(shutdownForceTimer);
  closeDatabase();
  process.exit(code);
}

function destroyOpenConnections() {
  if (typeof server.closeIdleConnections === "function") {
    server.closeIdleConnections();
  }
  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
}

async function shutdown(signal) {
  if (shuttingDown) {
    logger.warn({ signal }, "arrêt forcé (second signal)");
    destroyOpenConnections();
    exitAfterShutdown(signal === "SIGINT" ? 130 : 143);
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, "arrêt demandé");

  destroyOpenConnections();

  await new Promise((resolve) => {
    shutdownForceTimer = setTimeout(() => {
      logger.warn(
        { graceMs: SHUTDOWN_GRACE_MS },
        "fermeture HTTP trop longue — poursuite de l'arrêt"
      );
      resolve();
    }, SHUTDOWN_GRACE_MS);
    server.close((err) => {
      if (err) logger.warn({ err }, "fermeture du serveur HTTP");
      resolve();
    });
  });
  if (shutdownForceTimer) clearTimeout(shutdownForceTimer);

  const enrichment = app.locals?.enrichment;
  if (enrichment?.waitForIdle) {
    try {
      await enrichment.waitForIdle({ timeoutMs: SHUTDOWN_ENRICHMENT_MS });
    } catch (err) {
      logger.warn(
        { err: err.message, timeoutMs: SHUTDOWN_ENRICHMENT_MS },
        "arrêt : enrichissements encore en cours"
      );
    }
  }

  exitAfterShutdown(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

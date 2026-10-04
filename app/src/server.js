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

function shutdown(signal) {
  logger.info({ signal }, "arrêt demandé");
  server.close(() => {
    try {
      app.locals.db?.close();
    } catch {
      // La base est peut-être déjà fermée : rien à faire.
    }
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

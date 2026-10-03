/**
 * Assemblage de l'application Express.
 *
 * `createApp()` ne démarre aucun serveur : `server.js` s'en charge, et les
 * tests l'utilisent avec une base en mémoire.
 */

import path from "node:path";
import express from "express";
import session from "express-session";
import helmet from "helmet";

import config, { rootDir } from "./config.js";
import { openDatabase } from "./db.js";
import createRepositories from "./repositories/index.js";
import SqliteSessionStore from "./session-store.js";
import createLogger from "./lib/logger.js";
import { logActivity } from "./lib/activity.js";
import fmt from "./lib/format.js";

import csrf from "./middlewares/csrf.js";
import { loadUser } from "./middlewares/auth.session.js";
import extensionCors from "./middlewares/cors.extension.js";
import { errorHandler, notFoundHandler } from "./middlewares/errors.js";

import createAuthRouter from "./routes/web.auth.js";
import createExtensionRouter from "./routes/web.extension.js";
import createListingsRouter from "./routes/web.listings.js";
import createProjectsRouter from "./routes/web.projects.js";
import createSettingsRouter from "./routes/web.settings.js";
import createApiRouter from "./routes/api.v1.js";
import createEnrichmentService from "./services/enrichment/index.js";

const BODY_LIMIT = "1mb";

export default function createApp(options = {}) {
  const logger = options.logger || createLogger();
  const db = options.db || openDatabase();
  const repositories = options.repositories || createRepositories(db);
  const enrichment =
    options.enrichment || createEnrichmentService({ repositories, logger });

  const app = express();
  app.locals.config = config;
  app.set("trust proxy", config.isProduction ? 1 : false);
  app.set("views", path.join(rootDir, "src", "views"));
  app.set("view engine", "ejs");
  app.set("x-powered-by", false);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          // Les photos d'annonces viennent de domaines tiers ; aucun script externe.
          "img-src": ["'self'", "https:", "data:"],
          "script-src": ["'self'"],
          "style-src": ["'self'", "'unsafe-inline'"],
          // La page de consentement de l'extension se termine par une
          // redirection vers `chromiumapp.org`, que Chrome intercepte.
          "form-action": ["'self'", "https://*.chromiumapp.org"],
          "frame-ancestors": ["'none'"],
          "upgrade-insecure-requests": null,
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: "no-referrer" },
    })
  );

  // Le carnet est privé : rien n'est indexable.
  app.use((req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });

  app.use(
    "/public",
    express.static(path.join(rootDir, "public"), {
      maxAge: config.isProduction ? "7d" : 0,
    })
  );

  /* --------------------------- API extension --------------------------- */
  // Montée avant les sessions : authentification par Bearer, sans cookie.
  app.use(
    "/api/v1",
    extensionCors(config.extensionOrigins),
    express.json({ limit: BODY_LIMIT }),
    createApiRouter({ repositories, enrichment, logger })
  );

  /* ------------------------------- Site -------------------------------- */
  app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));
  app.use(
    session({
      name: "carnet.sid",
      secret: config.sessionSecret,
      store: new SqliteSessionStore({ db, cleanup: !config.isTest }),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: config.isProduction,
        maxAge: 30 * 24 * 60 * 60 * 1000,
      },
    })
  );

  app.use(loadUser(repositories));
  app.use(csrf());

  // Messages one-shot stockés en session.
  app.use((req, res, next) => {
    res.locals.flash = req.session?.flash || null;
    if (req.session?.flash) delete req.session.flash;
    res.locals.fmt = fmt;
    res.locals.baseUrl = config.baseUrl;
    res.locals.currentPath = req.path;
    res.locals.title = "Carnet de recherche";
    next();
  });

  // Layout : une vue est rendue puis injectée dans `layout.ejs`.
  app.use((req, res, next) => {
    const render = res.render.bind(res);
    res.render = (view, locals = {}) => {
      if (locals.layout === false) return render(view, locals);
      return render(view, locals, (err, body) => {
        if (err) return next(err);
        return render("layout", { ...locals, body }, (layoutErr, html) => {
          if (layoutErr) return next(layoutErr);
          if (res.statusCode < 400) {
            const page = view.split("/").pop();
            logActivity(logger, req, "page chargée", {
              page,
              id: req.params.id,
            });
          }
          return res.send(html);
        });
      });
    };
    next();
  });

  app.use(createAuthRouter({ repositories, logger }));
  app.use(createExtensionRouter({ repositories, logger }));
  app.use(createProjectsRouter({ repositories, logger }));
  app.use(createSettingsRouter({ repositories, logger }));
  app.use(createListingsRouter({ repositories, enrichment, logger }));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  app.locals.db = db;
  return app;
}

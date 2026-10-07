/**
 * Assemblage de l'application Express.
 *
 * `createApp()` ne démarre aucun serveur : `server.js` s'en charge, et les
 * tests l'utilisent avec une base en mémoire.
 */

import path from "node:path";
import fs from "node:fs";
import express from "express";
import session from "express-session";
import helmet from "helmet";
import multer from "multer";

import config, { basemapClientConfig, rootDir } from "./config.js";
import { openDatabase } from "./db.js";
import createRepositories from "./repositories/index.js";
import SqliteSessionStore from "./session-store.js";
import createLogger from "./lib/logger.js";
import { logActivity } from "./lib/activity.js";
import fmt from "./lib/format.js";
import { patchPrixM2EvolutionHorizons } from "./lib/dvf-stats.js";
import {
  MARKET_VARIATION_HORIZONS,
  patchImmoDataMarketHorizons,
} from "./lib/immo-data-market.js";

import csrf from "./middlewares/csrf.js";
import { loadUser } from "./middlewares/auth.session.js";
import extensionCors from "./middlewares/cors.extension.js";
import { errorHandler, notFoundHandler } from "./middlewares/errors.js";

import createAuthRouter from "./routes/web.auth.js";
import createExtensionRouter from "./routes/web.extension.js";
import createListingsRouter from "./routes/web.listings.js";
import createProjectsRouter from "./routes/web.projects.js";
import createSettingsRouter from "./routes/web.settings.js";
import createAdminRouter from "./routes/web.admin.js";
import createApiRouter from "./routes/api.v1.js";
import createEnrichmentService from "./services/enrichment/index.js";
import { loadFinancingRates } from "./services/financing-config.service.js";

const BODY_LIMIT = "1mb";

/** Parse le CSV HexaSmal avant le CSRF pour que `_csrf` soit lu dans le corps multipart. */
const hexasmalUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

/**
 * Version des assets statiques (CSS/JS) pour le cache-busting : date de
 * modification du bundle CSS. Évite qu'un navigateur serve un ancien CSS en
 * cache après une mise à jour (mauvais positionnement d'éléments, etc.).
 */
function computeAssetVersion() {
  try {
    const cssPath = path.join(rootDir, "public", "css", "app.css");
    return String(Math.trunc(fs.statSync(cssPath).mtimeMs));
  } catch {
    return String(Date.now());
  }
}

const STARTUP_ASSET_VERSION = computeAssetVersion();

export default function createApp(options = {}) {
  const logger = options.logger || createLogger();
  const db = options.db || openDatabase();
  const repositories = options.repositories || createRepositories(db);
  loadFinancingRates(repositories);
  if (repositories.dvf?.ensureDepartmentStats) {
    setImmediate(() => {
      try {
        repositories.dvf.ensureDepartmentStats();
      } catch (err) {
        logger.warn({ err }, "reconstruction stats DVF départementales");
      }
    });
  }
  const enrichment =
    options.enrichment || createEnrichmentService({ repositories, logger });

  const app = express();
  app.locals.config = config;
  app.locals.assetVersion = STARTUP_ASSET_VERSION;
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

  // Le carnet est privé : seule la page d'accueil publique est indexable.
  app.use((req, res, next) => {
    if (req.path !== "/") res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });

  app.use(
    "/public",
    express.static(path.join(rootDir, "public"), {
      maxAge: config.isProduction ? "7d" : 0,
    })
  );

  app.get("/robots.txt", (req, res) => {
    res
      .type("text/plain")
      .send(
        `User-agent: *\nDisallow: /api/\n\nSitemap: ${config.baseUrl}/sitemap.xml\n`
      );
  });

  app.get("/sitemap.xml", (req, res) => {
    res
      .type("application/xml")
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
          `  <url><loc>${config.baseUrl}/</loc></url>\n` +
          `</urlset>\n`
      );
  });

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
  app.post(
    "/admin/hexasmal/import",
    hexasmalUpload.single("file"),
    (req, res, next) => next()
  );
  app.use(csrf());

  // Messages one-shot stockés en session.
  app.use((req, res, next) => {
    res.locals.flash = req.session?.flash || null;
    if (req.session?.flash) delete req.session.flash;
    res.locals.fmt = fmt;
    res.locals.patchPrixM2EvolutionHorizons = patchPrixM2EvolutionHorizons;
    res.locals.patchImmoDataMarketHorizons = patchImmoDataMarketHorizons;
    res.locals.marketVariationHorizons = MARKET_VARIATION_HORIZONS;
    // En dev, on relit la date à chaque requête pour refléter les éditions sans
    // redémarrage ; en prod, valeur figée au démarrage (fichiers immuables).
    res.locals.assetVersion = config.isProduction
      ? STARTUP_ASSET_VERSION
      : computeAssetVersion();
    res.locals.basemap = basemapClientConfig();
    res.locals.baseUrl = config.baseUrl;
    res.locals.currentPath = req.path;
    res.locals.title = "Carnet de Visites";
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
  app.use(createAdminRouter({ repositories, enrichment, logger }));
  app.use(createListingsRouter({ repositories, enrichment, logger }));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  app.locals.db = db;
  return app;
}

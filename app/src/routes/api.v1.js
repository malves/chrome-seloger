/**
 * API v1 consommée par l'extension Chrome.
 *
 * La clé de session issue de `/extension/connect` voyage dans l'en-tête
 * `Authorization`, jamais dans un cookie : l'extension ne dépend donc pas des
 * réglages de cookies tiers.
 */

import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import config from "../config.js";
import HttpError from "../lib/http-error.js";
import requireExtensionSession from "../middlewares/auth.extension.js";
import { hashSecret } from "../repositories/extension.repo.js";
import {
  listingPayloadSchema,
  formatIssues,
} from "../schemas/listing.payload.js";
import { verifyChallenge } from "../services/extension-auth.service.js";
import createListingsService from "../services/listings.service.js";
import createProjectsService from "../services/projects.service.js";
import createTravelService from "../services/travel.service.js";
import { logActivity } from "../lib/activity.js";

function jsonLimitHandler(code, message) {
  return (req, res) => {
    res.status(429).json({ error: { code, message } });
  };
}

export default function createApiRouter({ repositories, enrichment, logger }) {
  const router = express.Router();
  const listingsService = createListingsService({ repositories });
  const projectsService = createProjectsService({ repositories });
  const travelService = createTravelService({ logger });
  const requireSession = requireExtensionSession(repositories);

  const webUrl = (id) => `${config.baseUrl}/listings/${id}`;

  // 120 requêtes/minute par session (à défaut par IP, pour les appels anonymes).
  const apiLimiter = rateLimit({
    windowMs: config.rateLimits.api.windowMs,
    limit: config.rateLimits.api.max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => {
      const match = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
      return match ? hashSecret(match[1].trim()) : ipKeyGenerator(req.ip);
    },
    handler: jsonLimitHandler(
      "too_many_requests",
      "Limite de 120 requêtes par minute atteinte."
    ),
  });

  const exchangeLimiter = rateLimit({
    windowMs: config.rateLimits.login.windowMs,
    limit: config.rateLimits.login.max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: jsonLimitHandler(
      "too_many_requests",
      "Trop de tentatives de connexion. Réessayez dans 15 minutes."
    ),
  });

  // La clé ORS est partagée : un garde-fou plus serré protège son quota.
  const travelLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: () => config.isTest,
    keyGenerator: (req) => {
      const match = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
      return match ? hashSecret(match[1].trim()) : ipKeyGenerator(req.ip);
    },
    handler: jsonLimitHandler(
      "too_many_requests",
      "Trop de calculs d'itinéraire. Réessayez dans une minute."
    ),
  });

  if (!config.isTest) router.use(apiLimiter);

  /* --------------------- Connexion de l'extension -------------------- */

  /**
   * Échange du code d'autorisation contre une clé de session. Le code est à
   * usage unique et ne vaut qu'accompagné du vérificateur PKCE.
   */
  router.post("/extension/session", exchangeLimiter, (req, res, next) => {
    const code = String(req.body?.code || "").trim();
    const codeVerifier = String(req.body?.code_verifier || "").trim();

    if (!code || !codeVerifier) {
      return next(
        HttpError.badRequest("« code » et « code_verifier » sont obligatoires.")
      );
    }

    const authorization = repositories.extension.consumeAuthCode(code);
    if (!authorization) {
      return next(
        HttpError.unauthorized("Autorisation expirée ou déjà utilisée.")
      );
    }

    if (!verifyChallenge(codeVerifier, authorization.code_challenge)) {
      return next(HttpError.unauthorized("Vérificateur PKCE invalide."));
    }

    const user = repositories.users.findById(authorization.user_id);
    if (!user) return next(HttpError.unauthorized("Compte introuvable."));

    const { key } = repositories.extension.createSession({
      userId: user.id,
      label: authorization.label,
    });
    logActivity(logger, req, "extension connectée", { userId: user.id });

    return res.status(201).json({
      key,
      user: { id: user.id, email: user.email },
    });
  });

  router.get("/me", requireSession, (req, res) => {
    res.json({ user: { id: req.user.id, email: req.user.email } });
  });

  /** Déconnexion depuis l'extension : la clé conservée devient inutilisable. */
  router.delete("/extension/session", requireSession, (req, res) => {
    repositories.extension.revokeSessionByKey(req.extensionSession.key);
    logActivity(logger, req, "extension déconnectée");
    res.status(204).end();
  });

  /* --------------------------- Projets ------------------------------ */

  // La popup s'en sert pour proposer une destination avant d'enregistrer.
  router.get("/projects", requireSession, (req, res) => {
    projectsService.ensureDefault(req.user.id);
    res.json({
      projects: projectsService.list(req.user.id).map(projectsService.toApi),
    });
  });

  router.post("/projects", requireSession, (req, res, next) => {
    const { project, error } = projectsService.create(
      req.user.id,
      req.body?.name
    );
    if (error) return next(HttpError.unprocessable(error));
    logActivity(logger, req, "projet créé", {
      projectId: project.id,
      name: project.name,
    });
    return res.status(201).json({ project: projectsService.toApi(project) });
  });

  /* --------------------------- Annonces ----------------------------- */

  router.post("/listings", requireSession, (req, res, next) => {
    const parsed = listingPayloadSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return next(
        HttpError.unprocessable(
          "Payload invalide.",
          formatIssues(parsed.error)
        )
      );
    }

    const { id, created, priceChanged, projects } = listingsService.save(
      req.user,
      parsed.data
    );
    logActivity(logger, req, created ? "annonce ajoutée" : "annonce mise à jour", {
      listingId: id,
      ...(priceChanged ? { priceChanged: true } : {}),
    });

    res.status(created ? 201 : 200).json({
      id,
      created,
      price_changed: priceChanged,
      // Confirme la destination : une référence de projet inconnue est ignorée
      // silencieusement, l'extension doit pouvoir le constater.
      projects: projects.map(projectsService.toApi),
      web_url: webUrl(id),
    });

    // Réponse envoyée : l'enrichissement se poursuit en arrière-plan.
    enrichment.schedule(req.user.id, id);
    return undefined;
  });

  router.get("/listings/lookup", requireSession, (req, res, next) => {
    const url = String(req.query.url || "").trim();
    if (!url) {
      return next(
        HttpError.badRequest("Le paramètre « url » est obligatoire.")
      );
    }

    const listing = listingsService.lookup(req.user, url);
    if (!listing) return res.json({ saved: false });

    return res.json({
      saved: true,
      id: listing.id,
      status: listing.status,
      projects: repositories.projects
        .listForListing(listing.id)
        .map(projectsService.toApi),
      web_url: webUrl(listing.id),
    });
  });

  /** Reclasse une annonce déjà enregistrée : remplace l'ensemble de ses projets. */
  router.put(
    "/listings/:id/projects",
    requireSession,
    (req, res, next) => {
      const id = Number(req.params.id);
      const listing = Number.isInteger(id)
        ? repositories.listings.findById(req.user.id, id)
        : null;
      if (!listing) return next(HttpError.notFound("Annonce introuvable."));

      const body = req.body ?? {};
      const references = body.projects ?? body.project ?? body.project_id ?? [];
      const projects = projectsService.setForListing(
        req.user.id,
        listing.id,
        references
      );
      logActivity(logger, req, "projets de l'annonce modifiés", {
        listingId: listing.id,
        projectCount: projects.length,
      });

      return res.json({ projects: projects.map(projectsService.toApi) });
    }
  );

  /* ------------------------- Temps de trajet ------------------------ */

  /**
   * Calcule le trajet voiture entre l'adresse de départ de l'utilisateur et le
   * bien. `start` et `destination` acceptent soit `{ lat, lon }`, soit une
   * chaîne d'adresse (ou `{ address }`) : le serveur géocode ce qu'il faut.
   */
  /**
   * Trajet voiture depuis une annonce (`origin`) vers chaque adresse de
   * référence du projet visé. `origin` est soit `{ lat, lon }`, soit une
   * adresse texte (ou `{ address }`). À défaut de `project_id`, le projet par
   * défaut du compte est utilisé.
   */
  router.post("/travel-time", requireSession, travelLimiter, (req, res, next) => {
    // État attendu (clé non renseignée) : réponse propre, sans trace d'erreur.
    if (!travelService.configured()) {
      return res.status(503).json({
        error: {
          code: "travel_unavailable",
          message: "Le calcul d'itinéraire est momentanément indisponible.",
        },
      });
    }

    const body = req.body ?? {};
    const origin =
      typeof body.origin === "string"
        ? { address: body.origin }
        : body.origin && typeof body.origin === "object"
          ? body.origin
          : {};

    const requested = Number(body.project_id);
    const project = Number.isInteger(requested)
      ? repositories.projects.findById(req.user.id, requested)
      : null;
    const resolved = project || projectsService.ensureDefault(req.user.id);

    const destinations = repositories.projects
      .listAddresses(resolved.id)
      .map((row) => ({
        id: row.id,
        label: row.label || null,
        address: row.address,
        lat: row.lat,
        lon: row.lng,
      }));

    return travelService
      .compute({ origin, destinations })
      .then((result) =>
        res.json({
          ...result,
          project: { id: resolved.id, name: resolved.name, slug: resolved.slug },
        })
      )
      .catch(next);
  });

  router.use((req, res) => {
    res
      .status(404)
      .json({ error: { code: "not_found", message: "Endpoint inconnu." } });
  });

  return router;
}

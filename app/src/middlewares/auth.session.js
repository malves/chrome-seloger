/**
 * Authentification du site par session.
 *
 * `loadUser` est monté globalement et remplit `req.user` / `res.locals.user`.
 * `requireUser` protège les pages privées, `requireAdmin` l'espace d'admin.
 */

import config from "../config.js";
import HttpError from "../lib/http-error.js";

/** Vrai si l'utilisateur est le compte administrateur. */
export function isAdmin(user) {
  return Boolean(user?.email && user.email.toLowerCase() === config.adminEmail);
}

export function loadUser(repositories) {
  return (req, res, next) => {
    const userId = req.session?.userId;
    if (!userId) {
      req.user = null;
      res.locals.user = null;
      res.locals.isAdmin = false;
      return next();
    }

    const user = repositories.users.findById(userId);
    if (!user) {
      // Compte supprimé entre deux requêtes : on referme la session et la
      // requête continue en visiteur anonyme.
      req.user = null;
      res.locals.user = null;
      res.locals.isAdmin = false;
      req.session.destroy(() => next());
      return undefined;
    }

    req.user = user;
    res.locals.user = user;
    res.locals.isAdmin = isAdmin(user);
    return next();
  };
}

export function requireUser(req, res, next) {
  if (req.user) return next();
  const target = req.originalUrl && req.method === "GET" ? req.originalUrl : "/";
  res.redirect(`/login?next=${encodeURIComponent(target)}`);
}

/**
 * Réserve une route au compte administrateur. On renvoie 404 (et non 403) pour
 * ne pas révéler l'existence de l'espace d'administration.
 */
export function requireAdmin(req, res, next) {
  if (isAdmin(req.user)) return next();
  return next(HttpError.notFound());
}

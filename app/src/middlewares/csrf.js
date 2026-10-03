/**
 * Protection CSRF par jeton synchronisé.
 *
 * Un jeton est généré par session et exposé aux vues via `res.locals.csrfToken`.
 * Toute requête mutante du site doit le renvoyer dans le champ `_csrf` ou
 * l'en-tête `X-CSRF-Token`. Les routes `/api/v1/*`, authentifiées par jeton
 * Bearer et sans cookie, en sont exemptées.
 */

import crypto from "node:crypto";
import HttpError from "../lib/http-error.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function ensureToken(req) {
  if (!req.session) return null;
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("base64url");
  }
  return req.session.csrfToken;
}

function matches(expected, received) {
  if (typeof received !== "string" || received.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

export default function csrf() {
  return (req, res, next) => {
    const token = ensureToken(req);
    res.locals.csrfToken = token || "";

    if (SAFE_METHODS.has(req.method)) return next();

    const received =
      (req.body && req.body._csrf) || req.get("x-csrf-token") || "";

    if (!token || !matches(token, received)) {
      return next(
        new HttpError(
          403,
          "invalid_csrf_token",
          "Formulaire expiré. Rechargez la page et réessayez."
        )
      );
    }

    return next();
  };
}

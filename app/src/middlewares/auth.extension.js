/**
 * Authentification de l'extension sur `/api/v1/*`.
 *
 * La clé de session obtenue au terme de l'autorisation voyage dans l'en-tête
 * `Authorization: Bearer …` — jamais dans un cookie, l'extension ne dépend
 * donc pas des réglages de cookies tiers. Elle n'existe en clair que dans
 * l'en-tête : la base n'en garde que le SHA-256.
 */

import HttpError from "../lib/http-error.js";

export default function requireExtensionSession(repositories) {
  return (req, res, next) => {
    const header = req.get("authorization") || "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());

    if (!match) {
      return next(
        HttpError.unauthorized("Extension non connectée : en-tête Authorization absent.")
      );
    }

    const key = match[1].trim();
    const session = repositories.extension.findActiveSession(key);
    if (!session) {
      return next(
        HttpError.unauthorized("Connexion de l'extension expirée ou révoquée.")
      );
    }

    const user = repositories.users.findById(session.user_id);
    if (!user) {
      return next(HttpError.unauthorized("Compte introuvable."));
    }

    repositories.extension.touchSession(session.id);
    req.user = user;
    req.extensionSession = { id: session.id, key };
    return next();
  };
}

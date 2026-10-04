/**
 * Erreur porteuse d'un statut HTTP et d'un code applicatif.
 *
 * Les routes lèvent ces erreurs ; le middleware d'erreurs décide du rendu
 * (page HTML pour le site, enveloppe JSON pour l'API).
 */
export default class HttpError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }

  static badRequest(message, details) {
    return new HttpError(400, "bad_request", message, details);
  }

  static unauthorized(message = "Authentification requise.") {
    return new HttpError(401, "unauthorized", message);
  }

  static forbidden(message = "Accès refusé.") {
    return new HttpError(403, "forbidden", message);
  }

  static notFound(message = "Ressource introuvable.") {
    return new HttpError(404, "not_found", message);
  }

  static unprocessable(message, details) {
    return new HttpError(422, "unprocessable_entity", message, details);
  }

  static tooManyRequests(message = "Trop de requêtes, réessayez plus tard.") {
    return new HttpError(429, "too_many_requests", message);
  }

  static upgradeRequired(message) {
    return new HttpError(
      426,
      "extension_outdated",
      message ||
        "Votre extension n'est plus à jour. Installez la dernière version depuis le Chrome Web Store."
    );
  }
}

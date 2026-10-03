/**
 * Gestion centralisée des erreurs.
 *
 * Les routes `/api/v1/*` reçoivent `{ error: { code, message, details } }`,
 * le site reçoit une page d'erreur.
 */

import HttpError from "../lib/http-error.js";

function isApiRequest(req) {
  return req.path.startsWith("/api/");
}

export function notFoundHandler(req, res, next) {
  next(HttpError.notFound());
}

/** Traduit les erreurs de `body-parser` en codes applicatifs lisibles. */
function normalizeBodyParserError(err) {
  if (err.type === "entity.too.large") {
    return new HttpError(
      413,
      "payload_too_large",
      "Corps de requête trop volumineux (1 Mo maximum)."
    );
  }
  if (err.type === "entity.parse.failed") {
    return HttpError.badRequest("Corps de requête JSON invalide.");
  }
  return err;
}

export function errorHandler(logger) {
  return (rawError, req, res, next) => {
    const err = normalizeBodyParserError(rawError);
    const status = Number.isInteger(err.status) ? err.status : 500;
    const code = err.code || (status === 500 ? "internal_error" : "error");
    const message =
      status === 500 || !err.expose
        ? "Une erreur inattendue est survenue."
        : err.message;

    if (status >= 500) {
      logger.error({ err, url: req.originalUrl }, "erreur serveur");
    } else {
      logger.debug({ code, status, url: req.originalUrl }, "erreur cliente");
    }

    if (res.headersSent) return next(err);

    if (isApiRequest(req)) {
      res.status(status).json({
        error: { code, message, details: err.details || undefined },
      });
      return;
    }

    res.status(status).render("error", {
      title: status === 404 ? "Page introuvable" : "Erreur",
      status,
      message,
    });
  };
}

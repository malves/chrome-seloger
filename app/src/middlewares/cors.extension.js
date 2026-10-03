/**
 * CORS restreint aux origines de l'extension (`EXTENSION_ORIGINS`).
 *
 * Monté uniquement sur `/api/v1/*`. Toute autre origine cross-site reçoit une
 * réponse sans en-tête CORS, donc bloquée par le navigateur. Les appels sans
 * en-tête `Origin` (curl, service worker) passent normalement.
 */

const ALLOWED_HEADERS = "Authorization, Content-Type, X-Requested-With";
const ALLOWED_METHODS = "GET, POST, DELETE, OPTIONS";

export default function extensionCors(allowedOrigins = []) {
  const allowed = new Set(allowedOrigins);

  return (req, res, next) => {
    const origin = req.get("origin");

    if (origin && allowed.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
      res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
      res.setHeader("Access-Control-Max-Age", "86400");
    }

    if (req.method === "OPTIONS") {
      res.sendStatus(origin && allowed.has(origin) ? 204 : 403);
      return;
    }

    next();
  };
}

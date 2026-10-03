/**
 * Autorisation de l'extension, calquée sur OAuth 2.0 + PKCE (RFC 7636).
 *
 * L'utilisateur ne manipule aucun secret : il clique « S'authentifier » dans
 * l'extension, consent sur le site, et l'extension échange le code reçu contre
 * une clé de session qu'elle garde pour elle.
 *
 *   extension ──► GET  /extension/connect?redirect_uri&state&code_challenge
 *   site      ──► POST /extension/connect          (consentement, CSRF)
 *                 302 vers redirect_uri?code&state
 *   extension ──► POST /api/v1/extension/session   { code, code_verifier }
 *                 { key, user }
 */

import crypto from "node:crypto";

/** Redirection gérée par Chrome pour `chrome.identity.launchWebAuthFlow`. */
const REDIRECT_HOST_SUFFIX = ".chromiumapp.org";
const EXTENSION_ID_RE = /^[a-p]{32}$/;

export const MAX_STATE_LENGTH = 512;

/** `code_challenge` = base64url(sha256(code_verifier)), seule méthode acceptée. */
export function challengeFor(codeVerifier) {
  return crypto.createHash("sha256").update(String(codeVerifier)).digest("base64url");
}

/**
 * Compare le vérificateur envoyé à l'échange avec le défi reçu à l'autorisation.
 * Comparaison à temps constant : le défi est un secret dérivé.
 */
export function verifyChallenge(codeVerifier, codeChallenge) {
  if (typeof codeVerifier !== "string" || codeVerifier.length < 43) return false;
  if (typeof codeChallenge !== "string" || !codeChallenge) return false;
  const expected = Buffer.from(codeChallenge);
  const actual = Buffer.from(challengeFor(codeVerifier));
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * Valide l'URL de retour. Seules les redirections `chromiumapp.org` de Chrome
 * sont acceptées, et uniquement pour les identifiants d'extension déclarés
 * dans `EXTENSION_ORIGINS` quand la variable est renseignée.
 */
export function parseRedirectUri(value, allowedExtensionIds = []) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;
  if (!url.hostname.endsWith(REDIRECT_HOST_SUFFIX)) return null;

  const extensionId = url.hostname.slice(0, -REDIRECT_HOST_SUFFIX.length);
  if (!EXTENSION_ID_RE.test(extensionId)) return null;
  if (allowedExtensionIds.length && !allowedExtensionIds.includes(extensionId)) {
    return null;
  }

  return { url, extensionId };
}

/** Ajoute les paramètres de retour sans écraser ceux de `redirect_uri`. */
export function buildRedirect(redirectUri, params) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Libellé lisible de la session, déduit du User-Agent : la page Paramètres
 * doit permettre de reconnaître le navigateur à déconnecter.
 */
export function browserLabel(userAgent) {
  const ua = String(userAgent || "");
  const browser =
    (/\bEdg\//.test(ua) && "Edge") ||
    (/\bOPR\//.test(ua) && "Opera") ||
    (/\bBrave\//.test(ua) && "Brave") ||
    (/\bVivaldi\//.test(ua) && "Vivaldi") ||
    (/\bChrome\//.test(ua) && "Chrome") ||
    null;

  const platform =
    (/Windows/.test(ua) && "Windows") ||
    (/Macintosh|Mac OS X/.test(ua) && "macOS") ||
    (/CrOS/.test(ua) && "ChromeOS") ||
    (/Android/.test(ua) && "Android") ||
    (/Linux/.test(ua) && "Linux") ||
    null;

  if (browser && platform) return `${browser} sur ${platform}`;
  if (browser) return browser;
  if (platform) return `Navigateur sur ${platform}`;
  return "Navigateur";
}

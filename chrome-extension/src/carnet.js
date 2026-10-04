/**
 * Client Carnet de Visites, chargé par le service worker.
 *
 * Authentification : l'utilisateur clique « S'authentifier », Chrome ouvre la
 * page de consentement du site (`chrome.identity.launchWebAuthFlow`), et le
 * code reçu est échangé contre une clé de session — jamais affichée, jamais
 * saisie. L'échange suit PKCE (RFC 7636) : un code intercepté est inutilisable
 * sans le vérificateur gardé ici.
 *
 * La clé vit dans `chrome.storage.local` uniquement : elle ne doit pas être
 * synchronisée entre navigateurs.
 */

const SESSION_STORAGE_KEY = "carnetSession";
const LAST_PROJECT_STORAGE_KEY = "carnetLastProjectId";

/** Version embarquée dans le zip (`build.version.js`) ou lue depuis le manifest. */
function extensionClientVersion() {
  if (typeof EXTENSION_BUILD_VERSION !== "undefined" && EXTENSION_BUILD_VERSION) {
    return String(EXTENSION_BUILD_VERSION);
  }
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return "dev";
  }
}

function apiHeaders(extra = {}) {
  return {
    ...extra,
    "X-Carnet-Extension-Version": extensionClientVersion(),
  };
}

/** Erreur porteuse d'un code, pour que la popup choisisse son message. */
class CarnetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CarnetError";
    this.code = code;
  }
}

/* ----------------------------- Session ----------------------------- */

async function getSession() {
  const stored = await chrome.storage.local.get(SESSION_STORAGE_KEY);
  const session = stored[SESSION_STORAGE_KEY];
  return session && session.key ? session : null;
}

async function clearSession() {
  await chrome.storage.local.remove(SESSION_STORAGE_KEY);
}

/* ------------------------------ PKCE ------------------------------- */

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomSecret() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return base64url(new Uint8Array(digest));
}

/* ---------------------------- Appels API --------------------------- */

async function apiFetch(path, { method = "GET", body = null, auth = true } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";

  if (auth) {
    const session = await getSession();
    if (!session) {
      throw new CarnetError("not_connected", "Extension non authentifiée.");
    }
    headers.Authorization = `Bearer ${session.key}`;
  }

  let response;
  try {
    response = await fetch(`${CARNET_BASE_URL}${path}`, {
      method,
      headers: apiHeaders(headers),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new CarnetError(
      "network",
      "Carnet injoignable. Vérifiez votre connexion."
    );
  }

  if (response.status === 204) return null;

  const data = await response.json().catch(() => null);
  if (response.ok) return data;

  // Session révoquée depuis le site : on repart d'un état propre.
  if (response.status === 401 && auth) {
    await clearSession();
    throw new CarnetError(
      "not_connected",
      "Connexion expirée. Authentifiez-vous à nouveau."
    );
  }

  throw new CarnetError(
    (data && data.error && data.error.code) || "server_error",
    (data && data.error && data.error.message) ||
      `Le carnet a répondu une erreur (HTTP ${response.status}).`
  );
}

/* ------------------------- Authentification ------------------------ */

/**
 * Un service worker MV3 s'arrête après 30 s d'inactivité. L'utilisateur peut
 * passer bien plus de temps sur la page de consentement : un appel d'API
 * périodique garde le worker — et donc le flux en cours — en vie.
 */
function keepAlive() {
  const timer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20_000);
  return () => clearInterval(timer);
}

async function connect() {
  const verifier = randomSecret();
  const state = randomSecret();
  const redirectUri = chrome.identity.getRedirectURL();

  const authUrl = new URL(`${CARNET_BASE_URL}/extension/connect`);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", await challengeFor(verifier));
  authUrl.searchParams.set("code_challenge_method", "S256");

  const stopKeepAlive = keepAlive();
  let redirected;
  try {
    redirected = await chrome.identity.launchWebAuthFlow({
      url: authUrl.toString(),
      interactive: true,
    });
  } catch (e) {
    // Fenêtre refermée par l'utilisateur, ou flux déjà en cours.
    throw new CarnetError("cancelled", "Authentification abandonnée.");
  } finally {
    stopKeepAlive();
  }

  if (!redirected) {
    throw new CarnetError("cancelled", "Authentification abandonnée.");
  }

  const params = new URL(redirected).searchParams;
  if (params.get("error")) {
    throw new CarnetError("denied", "Vous avez refusé l'autorisation.");
  }
  if (params.get("state") !== state) {
    throw new CarnetError("state", "Réponse d'autorisation inattendue.");
  }

  const code = params.get("code");
  if (!code) {
    throw new CarnetError("denied", "Aucune autorisation reçue.");
  }

  const session = await apiFetch("/api/v1/extension/session", {
    method: "POST",
    auth: false,
    body: { code, code_verifier: verifier },
  });

  await chrome.storage.local.set({
    [SESSION_STORAGE_KEY]: {
      key: session.key,
      email: session.user.email,
      connectedAt: Date.now(),
    },
  });

  return { email: session.user.email };
}

async function disconnect() {
  try {
    await apiFetch("/api/v1/extension/session", { method: "DELETE" });
  } catch (e) {
    // Session déjà invalide côté serveur : le nettoyage local suffit.
  }
  await clearSession();
}

/* ------------------------------ Carnet ----------------------------- */

async function listProjects() {
  const [data, stored] = await Promise.all([
    apiFetch("/api/v1/projects"),
    chrome.storage.local.get(LAST_PROJECT_STORAGE_KEY),
  ]);
  const projects = data.projects || [];
  const remembered = stored[LAST_PROJECT_STORAGE_KEY];

  // Le dernier projet utilisé reste sélectionné ; s'il a été supprimé, on
  // retombe sur le projet par défaut du compte.
  const known = projects.some((project) => project.id === remembered);
  const fallback = projects.find((project) => project.is_default) || projects[0];
  return {
    projects,
    selectedId: known ? remembered : fallback ? fallback.id : null,
  };
}

async function createProject(name) {
  const data = await apiFetch("/api/v1/projects", {
    method: "POST",
    body: { name },
  });
  return data.project;
}

async function rememberProject(projectId) {
  await chrome.storage.local.set({
    [LAST_PROJECT_STORAGE_KEY]: projectId || null,
  });
}

async function saveListing(payload, projectId) {
  const data = await apiFetch("/api/v1/listings", {
    method: "POST",
    body: projectId ? { ...payload, projects: [projectId] } : payload,
  });

  // On mémorise la destination réellement appliquée par le serveur.
  const applied = (data.projects || [])[0];
  if (applied) await rememberProject(applied.id);

  return data;
}

async function lookupListing(url) {
  return apiFetch(`/api/v1/listings/lookup?url=${encodeURIComponent(url)}`);
}

/** Identifiant du dernier projet utilisé, ou null (le serveur prendra alors le projet par défaut). */
async function getLastProjectId() {
  const stored = await chrome.storage.local.get(LAST_PROJECT_STORAGE_KEY);
  const id = stored[LAST_PROJECT_STORAGE_KEY];
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Temps de trajet voiture depuis une annonce (`origin`) vers chaque adresse de
 * référence du projet, calculé côté serveur avec la clé ORS partagée.
 * `origin` est soit `{ lat, lon }`, soit `{ address }`.
 */
async function fetchTravelTimes(origin, projectId) {
  return apiFetch("/api/v1/travel-time", {
    method: "POST",
    body: { origin, project_id: projectId || undefined },
  });
}

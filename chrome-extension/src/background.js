/**
 * Service worker (MV3).
 *
 * Centralise :
 *  - la lecture de l'adresse de départ configurée ;
 *  - le calcul du temps de trajet, délégué au carnet (clé ORS côté serveur) ;
 *  - la mise en cache du résultat pour le popup ;
 *  - les échanges avec le carnet (authentification et enregistrement).
 *
 * Toute la communication avec le carnet passe par ici : la clé de session ne
 * quitte pas le service worker, et un enregistrement lancé depuis la popup
 * aboutit même si celle-ci se referme entre-temps. La clé OpenRouteService,
 * elle, ne vit que côté serveur : l'extension demande simplement le trajet.
 */

// Adresse du carnet et client d'API (authentification, projets, trajet, annonces).
importScripts("config.js", "carnet.js");

const GEO_BASE = "https://geo.api.gouv.fr";

// Données communales pré-calculées : INSEE => [gauche%, centre%, droite%, taxe1-5].
importScripts("data/communes-data.js");
const COMMUNES = self.COMMUNES_DATA || {};

// Prix médians au m² : INSEE => [ médianeAppartement, médianeMaison ] (DVF).
importScripts("data/prices-data.js");
const PRICES = self.PRICES_DATA || {};

/* ------------------- Données communales (INSEE) ------------------- */

const inseeMemCache = new Map();

/** Normalise un nom de commune pour comparaison tolérante. */
function normalizeName(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/** Choisit la bonne commune dans la liste renvoyée par geo.api. */
function pickCommune(list, city) {
  if (!Array.isArray(list) || !list.length) return null;
  if (list.length === 1) return list[0].code;
  if (city) {
    const target = normalizeName(city);
    const hit = list.find((c) => normalizeName(c.nom) === target);
    if (hit) return hit.code;
    const partial = list.find(
      (c) =>
        normalizeName(c.nom).startsWith(target) ||
        target.startsWith(normalizeName(c.nom))
    );
    if (partial) return partial.code;
  }
  // À défaut, la commune la plus peuplée (souvent la ville recherchée).
  const byPop = [...list].sort(
    (a, b) => (b.population || 0) - (a.population || 0)
  );
  return byPop[0].code;
}

/** Résout le code INSEE depuis le code postal et/ou le nom de ville. */
async function resolveInsee(city, zipCode) {
  if (!city && !zipCode) return null;
  const key = `${zipCode || ""}|${normalizeName(city)}`;
  if (inseeMemCache.has(key)) return inseeMemCache.get(key);

  const { inseeCache } = await chrome.storage.local.get("inseeCache");
  const store = inseeCache || {};
  if (Object.prototype.hasOwnProperty.call(store, key)) {
    inseeMemCache.set(key, store[key]);
    return store[key];
  }

  let insee = null;
  try {
    const params = new URLSearchParams({
      fields: "nom,code,population",
      format: "json",
    });
    if (zipCode) params.set("codePostal", zipCode);
    else params.set("nom", city);
    const res = await fetch(`${GEO_BASE}/communes?${params.toString()}`);
    if (res.ok) insee = pickCommune(await res.json(), city);
  } catch (e) {
    insee = null;
  }

  inseeMemCache.set(key, insee);
  store[key] = insee;
  await chrome.storage.local.set({ inseeCache: store });
  return insee;
}

/** Libellé d'orientation à partir des blocs gauche/centre/droite. */
function politicsLabel(g, c, d) {
  const sorted = [g, c, d].sort((a, b) => b - a);
  if (sorted[0] - sorted[1] < 5) return "Partagée";
  const max = Math.max(g, c, d);
  if (max === g) return "Plutôt à gauche";
  if (max === d) return "Plutôt à droite";
  return "Plutôt au centre";
}

/** Infos commune depuis les données embarquées (politique, taxe, prix). */
function communeInfo(insee) {
  if (!insee) return null;
  const info = { insee };

  const v = COMMUNES[insee];
  if (v) {
    const [g, c, d, tx] = v;
    if (g + c + d > 0) {
      info.politics = {
        gauche: g,
        centre: c,
        droite: d,
        label: politicsLabel(g, c, d),
      };
    }
    if (tx > 0) info.taxeIndex = tx;
  }

  const pr = PRICES[insee];
  if (pr) {
    const appt = pr[0] > 0 ? pr[0] : null;
    const maison = pr[1] > 0 ? pr[1] : null;
    if (appt || maison) info.prices = { appt, maison };
  }

  if (!info.politics && info.taxeIndex == null && !info.prices) return null;
  return info;
}

/* --------------------------- Formatage ---------------------------- */

function formatDuration(sec) {
  const totalMin = Math.round(sec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")}`;
  return `${m} min`;
}

function formatDistance(meter) {
  const km = meter / 1000;
  return km >= 10 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
}

/**
 * URL Google Maps centrée sur le bien (zoom ville).
 * Sans coordonnées, recherche par nom de ville.
 */
const MAPS_ZOOM = 11; // plus large que la ville seule (12 était trop serré)

function buildMapsUrl(place) {
  const lat = Number(place.lat);
  const lon = Number(place.lon);
  const name =
    [place.city, place.zipCode].filter(Boolean).join(" ") ||
    place.district ||
    place.address ||
    null;

  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    // Format "place" de Google : repère nommé sur la commune + zoom contrôlé.
    if (name) {
      return (
        "https://www.google.com/maps/place/" +
        encodeURIComponent(name) +
        `/@${lat},${lon},${MAPS_ZOOM}z`
      );
    }
    // Sans nom : simple épingle aux coordonnées.
    return (
      "https://www.google.com/maps/search/?api=1&query=" +
      encodeURIComponent(`${lat},${lon}`)
    );
  }

  if (!name) return null;
  return (
    "https://www.google.com/maps/search/?api=1&query=" +
    encodeURIComponent(name)
  );
}

function isGoogleMapsUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "www.google.com" ||
        parsed.hostname === "maps.google.com") &&
      (parsed.pathname === "/maps" || parsed.pathname.startsWith("/maps/"))
    );
  } catch (e) {
    return false;
  }
}

/* --------------------------- Orchestration ------------------------ */

/**
 * Traduit une erreur globale du serveur de trajet en message affichable.
 * (Les échecs par destination arrivent dans `results[].error`, pas ici.)
 */
function travelErrorMessage(err) {
  switch (err && err.code) {
    case "not_connected":
      return "NOT_CONNECTED";
    case "origin_unresolved":
      return "NOT_FOUND";
    case "travel_unavailable":
      return "TRAVEL_UNAVAILABLE";
    default:
      return (err && err.message) || "Calcul d'itinéraire impossible.";
  }
}

/** Un trajet calculé vers une adresse de référence, prêt pour l'affichage. */
function tripFrom(entry) {
  const trip = {
    label: entry.label || null,
    address: entry.address || null,
  };
  if (entry.error) {
    trip.error = entry.error;
    return trip;
  }
  trip.durationSec = entry.duration_seconds;
  trip.distanceMeter = entry.distance_meters;
  trip.durationText = formatDuration(entry.duration_seconds);
  trip.distanceText = formatDistance(entry.distance_meters);
  trip.lat = entry.lat;
  trip.lon = entry.lon;
  trip.mapsUrl = buildMapsUrl({ lat: entry.lat, lon: entry.lon, address: entry.address });
  return trip;
}

async function computeTravel(property) {
  // Origine : coordonnées directes du bien, sinon adresse à géocoder côté serveur.
  let origin;
  if (property.lat != null && property.lon != null) {
    origin = { lat: property.lat, lon: property.lon, label: property.address || null };
  } else if (property.address) {
    origin = { address: property.address };
  } else {
    throw new Error("NOT_FOUND");
  }

  const projectId = await getLastProjectId();

  let travel;
  try {
    travel = await fetchTravelTimes(origin, projectId);
  } catch (err) {
    throw new Error(travelErrorMessage(err));
  }

  const trips = (travel.results || []).map(tripFrom);

  const result = {
    ok: true,
    project: travel.project || null,
    baseUrl: CARNET_BASE_URL,
    trips,
    // Infos du bien et de sa commune (indépendantes des destinations).
    propertyLabel: (travel.origin && travel.origin.label) || property.address || "Ce bien",
    district: property.district || null,
    city: property.city || null,
    zipCode: property.zipCode || null,
    lat: travel.origin ? travel.origin.lat : property.lat,
    lon: travel.origin ? travel.origin.lon : property.lon,
    mapsUrl: buildMapsUrl({
      lat: travel.origin ? travel.origin.lat : property.lat,
      lon: travel.origin ? travel.origin.lon : property.lon,
      city: property.city,
      zipCode: property.zipCode,
      district: property.district,
      address: property.address,
    }),
    approximate: property.approximate === true,
    url: property.url || null,
    timestamp: Date.now(),
  };

  // Enrichissement commune : orientation politique + indice taxe foncière.
  try {
    // Code INSEE fourni par la page (Belles Demeures) s'il est valide,
    // sinon résolution via le code postal + nom de ville (geo.api).
    const raw =
      typeof property.insee === "string"
        ? property.insee.trim().toUpperCase()
        : null;
    const direct = raw && /^(\d{5}|2[AB]\d{3})$/.test(raw) ? raw : null;
    const insee = direct || (await resolveInsee(property.city, property.zipCode));
    const commune = communeInfo(insee);
    if (commune) {
      result.insee = commune.insee;
      result.politics = commune.politics || null;
      result.taxeIndex = commune.taxeIndex != null ? commune.taxeIndex : null;
      result.prices = commune.prices || null;
    }
  } catch (e) {
    // Enrichissement optionnel : on n'échoue jamais le calcul principal.
  }

  // Cache pour le popup.
  await chrome.storage.local.set({ lastResult: result });

  return result;
}

/* ------------------------------ Carnet ---------------------------- */

/** Une annonce ne peut être lue que sur les sites couverts par le manifest. */
function isListingTab(tab) {
  if (!tab || !tab.url) return false;
  try {
    const url = new URL(tab.url);
    return url.protocol === "https:" && CARNET_SUPPORTED_HOSTS.test(url.hostname);
  } catch (e) {
    return false;
  }
}

/** Deux URL désignent le même bien si l'origine et le chemin concordent. */
function sameListing(a, b) {
  try {
    const first = new URL(a);
    const second = new URL(b);
    return first.origin === second.origin && first.pathname === second.pathname;
  } catch (e) {
    return false;
  }
}

/** Demande au content script de lire l'annonce affichée. */
async function readListing(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "EXTRACT_LISTING",
    });
    return (response && response.listing) || null;
  } catch (e) {
    // Content script absent (page ouverte avant l'installation, par exemple).
    return null;
  }
}

/**
 * Joint à l'annonce ce que l'extension a calculé pour ce bien : la fiche du
 * carnet affiche le trajet, le bord politique et l'indice de taxe foncière.
 */
async function withExtensionData(listing) {
  const { lastResult } = await chrome.storage.local.get("lastResult");
  if (!lastResult || !lastResult.ok || !lastResult.url) return listing;
  if (!sameListing(lastResult.url, listing.url)) return listing;

  const data = {};
  const trips = (lastResult.trips || []).filter(
    (trip) => !trip.error && trip.durationSec != null
  );
  if (trips.length) {
    data.travel_times = trips.map((trip) => ({
      label: trip.label || "Adresse de référence",
      mode: "car",
      minutes: Math.round(trip.durationSec / 60),
      distance_km: Math.round(trip.distanceMeter / 1000),
    }));
  }
  if (lastResult.politics) {
    const { label, gauche, centre, droite } = lastResult.politics;
    data.political_leaning = { label, gauche, centre, droite };
  }
  if (lastResult.taxeIndex) data.property_tax_index = lastResult.taxeIndex;

  if (!Object.keys(data).length) return listing;
  return { ...listing, extension_data: data };
}

/** Pastille sur l'icône : repère immédiat d'une annonce déjà enregistrée. */
async function markSaved(tabId, saved) {
  try {
    await chrome.action.setBadgeText({ tabId, text: saved ? "✓" : "" });
    if (saved) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#0b3d2c" });
    }
  } catch (e) {
    // L'onglet a pu disparaître entre-temps.
  }
}

/** Aperçu transmis à la popup : juste de quoi confirmer ce qui sera envoyé. */
function listingPreview(listing) {
  return {
    title: listing.title || null,
    price: listing.price || null,
    city: (listing.location && listing.location.city) || null,
    postalCode: (listing.location && listing.location.postal_code) || null,
    surface: listing.surface || null,
    rooms: listing.rooms || null,
    photo: (listing.photos || [])[0] || null,
    source: listing.source,
    // Sans titre ni prix, l'extraction est à moitié aveugle : la popup le dit.
    partial: !listing.title || !listing.price,
  };
}

/** L'onglet visé, ou `null` : la popup peut s'ouvrir sans onglet accessible. */
async function getTab(tabId) {
  if (!Number.isInteger(tabId)) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch (e) {
    return null;
  }
}

/** État de la page active : annonce lisible, et déjà connue du carnet ou non. */
async function pageState(tabId) {
  const tab = await getTab(tabId);
  if (!isListingTab(tab)) return { supported: false };

  const listing = await readListing(tabId);
  if (!listing) return { supported: true, listing: null };

  const state = { supported: true, listing: listingPreview(listing) };

  const session = await getSession();
  if (!session) return state;

  try {
    const found = await lookupListing(listing.url);
    state.saved = Boolean(found && found.saved);
    if (state.saved) {
      state.webUrl = found.web_url;
      state.projects = found.projects || [];
    }
    await markSaved(tabId, state.saved);
  } catch (e) {
    // Carnet injoignable : l'annonce reste affichée, l'enregistrement dira pourquoi.
    state.lookupFailed = true;
  }

  return state;
}

/** « Sauvegarder l'annonce » : lecture de la page puis envoi au carnet. */
async function saveFromTab(tabId, projectId) {
  const tab = await getTab(tabId);
  if (!isListingTab(tab)) {
    throw new CarnetError(
      "unsupported",
      "Cette page n'est pas une annonce reconnue."
    );
  }

  const listing = await readListing(tabId);
  if (!listing) {
    throw new CarnetError(
      "no_listing",
      "Annonce illisible. Rechargez la page, puis réessayez."
    );
  }

  const saved = await saveListing(await withExtensionData(listing), projectId);
  await markSaved(tabId, true);

  return {
    created: saved.created,
    priceChanged: saved.price_changed,
    webUrl: saved.web_url,
    projects: saved.projects || [],
  };
}

async function carnetState() {
  const session = await getSession();
  return {
    connected: Boolean(session),
    email: session ? session.email : null,
    baseUrl: CARNET_BASE_URL,
  };
}

/**
 * La popup se referme dès que la fenêtre d'autorisation s'ouvre : on la
 * rappelle une fois l'extension connectée, pour reprendre où l'on en était.
 */
async function connectFromPopup() {
  const result = await connect();
  try {
    await chrome.action.openPopup();
  } catch (e) {
    // `openPopup` n'existe pas sur les versions plus anciennes de Chrome.
  }
  return result;
}

const CARNET_HANDLERS = {
  CARNET_STATE: () => carnetState(),
  CARNET_CONNECT: () => connectFromPopup(),
  CARNET_DISCONNECT: () => disconnect(),
  CARNET_PROJECTS: () => listProjects(),
  CARNET_CREATE_PROJECT: (msg) => createProject(msg.name),
  CARNET_REMEMBER_PROJECT: (msg) => rememberProject(msg.projectId),
  CARNET_PAGE: (msg) => pageState(msg.tabId),
  CARNET_SAVE: (msg) => saveFromTab(msg.tabId, msg.projectId),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && CARNET_HANDLERS[msg.type];
  if (!handler) return false;

  Promise.resolve()
    .then(() => handler(msg))
    .then((data) => sendResponse({ ok: true, data: data === undefined ? null : data }))
    .catch((err) =>
      sendResponse({
        ok: false,
        code: err && err.code ? err.code : "error",
        error: (err && err.message) || "Erreur inattendue.",
      })
    );

  return true;
});

/* ----------------------------- Messages --------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === "OPEN_MAPS") {
    if (isGoogleMapsUrl(msg.url)) {
      chrome.tabs.create({ url: msg.url });
    }
    return false;
  }

  if (msg.type !== "COMPUTE_TRAVEL") return false;

  const property = msg.property || {};
  if (sender.tab && sender.tab.url) property.url = sender.tab.url;

  computeTravel(property)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: err.message }));

  // true => réponse asynchrone.
  return true;
});

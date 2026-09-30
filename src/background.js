/**
 * Service worker (MV3).
 *
 * Centralise :
 *  - la lecture de la configuration (clé API OpenRouteService + adresse de départ) ;
 *  - le géocodage (adresse -> coordonnées) via ORS ;
 *  - le calcul d'itinéraire voiture via ORS ;
 *  - la mise en cache du résultat pour le popup.
 *
 * ORS attend les coordonnées au format [longitude, latitude].
 */

const ORS_BASE = "https://api.openrouteservice.org";

/* ----------------------------- Config ----------------------------- */

async function getConfig() {
  const { orsApiKey, startAddress, startCoords } =
    await chrome.storage.local.get([
      "orsApiKey",
      "startAddress",
      "startCoords",
    ]);
  return { orsApiKey, startAddress, startCoords };
}

/* --------------------------- Appels ORS --------------------------- */

/** Géocode une adresse texte -> { lat, lon, label }. */
async function geocode(apiKey, text) {
  const url =
    `${ORS_BASE}/geocode/search?api_key=${encodeURIComponent(apiKey)}` +
    `&text=${encodeURIComponent(text)}` +
    `&boundary.country=FR&size=1`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Géocodage échoué (HTTP ${res.status})`);
  }
  const data = await res.json();
  const feature = data.features && data.features[0];
  if (!feature) {
    throw new Error("NOT_FOUND");
  }
  const [lon, lat] = feature.geometry.coordinates;
  return { lat, lon, label: feature.properties.label };
}

/** Calcule l'itinéraire voiture entre deux points [lon,lat]. */
async function drivingRoute(apiKey, start, end) {
  const res = await fetch(`${ORS_BASE}/v2/directions/driving-car`, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      coordinates: [
        [start.lon, start.lat],
        [end.lon, end.lat],
      ],
    }),
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error("Clé API invalide ou quota dépassé.");
    }
    throw new Error(`Calcul d'itinéraire échoué (HTTP ${res.status})`);
  }

  const data = await res.json();
  const summary =
    data.routes && data.routes[0] && data.routes[0].summary;
  if (!summary) {
    throw new Error("Itinéraire introuvable entre les deux points.");
  }
  return {
    durationSec: summary.duration,
    distanceMeter: summary.distance,
  };
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

/* ------------------------- Point de départ ------------------------ */

/**
 * Retourne les coordonnées du point de départ, en réutilisant le cache si
 * l'adresse configurée n'a pas changé.
 */
async function resolveStart(config) {
  const { orsApiKey, startAddress, startCoords } = config;

  if (
    startCoords &&
    startCoords.forAddress === startAddress &&
    startCoords.lat != null
  ) {
    return { lat: startCoords.lat, lon: startCoords.lon };
  }

  const geo = await geocode(orsApiKey, startAddress);
  await chrome.storage.local.set({
    startCoords: { lat: geo.lat, lon: geo.lon, forAddress: startAddress },
  });
  return { lat: geo.lat, lon: geo.lon };
}

/* --------------------------- Orchestration ------------------------ */

async function computeTravel(property) {
  const config = await getConfig();

  if (!config.orsApiKey || !config.startAddress) {
    throw new Error("NO_CONFIG");
  }

  // Point de départ
  const start = await resolveStart(config);

  // Point d'arrivée (le bien) : coords directes, sinon géocodage de l'adresse.
  let end;
  let endLabel = property.address || "Bien SeLoger";
  if (property.lat != null && property.lon != null) {
    end = { lat: property.lat, lon: property.lon };
  } else if (property.address) {
    const geo = await geocode(config.orsApiKey, property.address);
    end = { lat: geo.lat, lon: geo.lon };
    endLabel = geo.label || endLabel;
  } else {
    throw new Error("NOT_FOUND");
  }

  const route = await drivingRoute(config.orsApiKey, start, end);

  const result = {
    ok: true,
    durationSec: route.durationSec,
    distanceMeter: route.distanceMeter,
    durationText: formatDuration(route.durationSec),
    distanceText: formatDistance(route.distanceMeter),
    propertyLabel: endLabel,
    district: property.district || null,
    city: property.city || null,
    approximate: property.approximate === true,
    startAddress: config.startAddress,
    url: property.url || null,
    timestamp: Date.now(),
  };

  // Cache pour le popup.
  await chrome.storage.local.set({ lastResult: result });

  return result;
}

/* ----------------------------- Messages --------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "COMPUTE_TRAVEL") return false;

  const property = msg.property || {};
  if (sender.tab && sender.tab.url) property.url = sender.tab.url;

  computeTravel(property)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: err.message }));

  // true => réponse asynchrone.
  return true;
});

/**
 * Calcul d'itinéraire voiture via OpenRouteService.
 *
 * La clé ORS est partagée et vit uniquement côté serveur (`ORS_API_KEY`) :
 * l'extension ne la connaît jamais. Le service géocode l'adresse de départ et
 * celle du bien lorsqu'aucune coordonnée n'est fournie, puis renvoie durée et
 * distance en voiture.
 *
 * ORS attend les coordonnées au format [longitude, latitude].
 */

import config from "../config.js";
import HttpError from "../lib/http-error.js";

const BASE = config.openRouteService.baseUrl;

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function unresolved(role) {
  return role === "start" ? "start_unresolved" : "destination_unresolved";
}

export default function createTravelService({ logger } = {}) {
  const { apiKey, timeoutMs } = config.openRouteService;

  function configured() {
    return Boolean(apiKey);
  }

  async function orsJson(url, init) {
    let response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        ...init,
      });
    } catch (err) {
      logger?.warn?.({ err: err.message }, "OpenRouteService injoignable");
      throw new HttpError(502, "travel_upstream", "OpenRouteService injoignable.");
    }

    if (response.status === 401 || response.status === 403) {
      logger?.error?.("Clé OpenRouteService refusée ou quota dépassé.");
      throw new HttpError(
        502,
        "travel_upstream",
        "Calcul d'itinéraire momentanément indisponible."
      );
    }
    if (!response.ok) {
      throw new HttpError(
        502,
        "travel_upstream",
        `OpenRouteService a répondu HTTP ${response.status}.`
      );
    }
    return response.json();
  }

  /** Géocode une adresse texte → { lat, lon, label } ou null. */
  async function geocode(text) {
    const url =
      `${BASE}/geocode/search?api_key=${encodeURIComponent(apiKey)}` +
      `&text=${encodeURIComponent(text)}&boundary.country=FR&size=1`;
    const data = await orsJson(url);
    const feature = data?.features?.[0];
    if (!feature?.geometry?.coordinates) return null;
    const [lon, lat] = feature.geometry.coordinates;
    return { lat, lon, label: feature.properties?.label || text };
  }

  /** Itinéraire voiture entre deux points { lat, lon }. */
  async function route(start, end) {
    const data = await orsJson(`${BASE}/v2/directions/driving-car`, {
      method: "POST",
      headers: { Authorization: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        coordinates: [
          [start.lon, start.lat],
          [end.lon, end.lat],
        ],
      }),
    });
    const summary = data?.routes?.[0]?.summary;
    if (!summary) {
      throw new HttpError(
        422,
        "no_route",
        "Aucun itinéraire routier entre ces deux points."
      );
    }
    return { durationSeconds: summary.duration, distanceMeters: summary.distance };
  }

  /** Résout un point : coordonnées fournies, sinon géocodage de l'adresse. */
  async function resolvePoint(point, role) {
    const lat = toNumber(point?.lat);
    const lon = toNumber(point?.lon);
    if (lat != null && lon != null) {
      return { lat, lon, label: point.label || null };
    }

    const address =
      typeof point?.address === "string" ? point.address.trim() : "";
    if (!address) {
      throw new HttpError(
        422,
        unresolved(role),
        role === "origin"
          ? "Adresse du bien introuvable sur cette page."
          : "Adresse de référence manquante."
      );
    }

    const geo = await geocode(address);
    if (!geo) {
      throw new HttpError(
        422,
        unresolved(role),
        role === "origin"
          ? "Adresse du bien introuvable."
          : "Adresse de référence introuvable."
      );
    }
    return { ...geo, label: point.label || geo.label };
  }

  /**
   * Géocodage « best-effort » pour l'enregistrement d'une adresse de référence :
   * ne lève jamais (coordonnées utiles si disponibles, sinon `null`, et le
   * trajet géocodera plus tard).
   */
  async function geocodeAddress(text) {
    if (!configured() || !text) return null;
    try {
      return await geocode(text);
    } catch (err) {
      return null;
    }
  }

  /**
   * Trajet voiture depuis `origin` vers chaque destination de `destinations`.
   * Un échec sur une destination n'interrompt pas les autres : il est renvoyé
   * dans `results[].error`. Chaque point est soit `{ lat, lon }`, soit
   * `{ address }` ; `id`/`label` sont conservés pour l'affichage.
   */
  async function compute({ origin, destinations = [] } = {}) {
    if (!configured()) {
      throw new HttpError(
        503,
        "travel_unavailable",
        "Le calcul d'itinéraire est momentanément indisponible."
      );
    }

    const from = await resolvePoint(origin, "origin");

    const results = [];
    for (const destination of destinations) {
      const base = {
        id: destination.id ?? null,
        label: destination.label ?? null,
        address: destination.address ?? null,
      };
      try {
        const to = await resolvePoint(destination, "destination");
        const { durationSeconds, distanceMeters } = await route(from, to);
        results.push({
          ...base,
          duration_seconds: Math.round(durationSeconds),
          distance_meters: Math.round(distanceMeters),
          lat: to.lat,
          lon: to.lon,
        });
      } catch (err) {
        results.push({ ...base, error: err.code || "travel_error" });
      }
    }

    return { origin: from, results };
  }

  return { configured, compute, geocodeAddress };
}

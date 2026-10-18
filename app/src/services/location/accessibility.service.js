/**
 * Étape 3 du moteur de localisation probable : zones d'accessibilité réelles
 * pour les contraintes temporelles (« à 5 min à pied de la gare »).
 *
 * Fournisseur principal : isochrones OpenRouteService (`/v2/isochrones/{profile}`,
 * `location_type=destination` — on veut les zones DEPUIS lesquelles le lieu est
 * atteignable). On demande plusieurs paliers de temps en un seul appel pour
 * obtenir des bandes graduées exploitables par le scoring.
 *
 * Repli (clé ORS absente ou API indisponible) : mode « cercle », le scoring
 * estimant alors le temps par distance à vol d'oiseau / vitesse moyenne.
 */

import config from "../../config.js";
import { openRouteServiceAuthorizationHeader } from "../../lib/open-route-service.js";

/** `transport` extrait → profil ORS. */
const PROFILES = {
  walking: "foot-walking",
  cycling: "cycling-regular",
  driving: "driving-car",
  transit: "driving-car", // ORS n'a pas de profil transports en commun : proxy voiture.
};

/** Nombre de bandes d'isochrone demandées entre M et le seuil de tolérance. */
const BAND_COUNT = 5;

function linspace(min, max, n) {
  if (n <= 1 || max <= min) return [max];
  const step = (max - min) / (n - 1);
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(min + step * i);
  return out;
}

/**
 * Seuil (minutes) au-delà duquel une contrainte `M` minutes vaut 0, d'après la
 * config de tolérance. Partagé avec le scoring pour rester cohérent.
 */
export function minutesCutoff(maxMinutes, tol) {
  const grace = maxMinutes * (tol.graceRatio || 0);
  const span = maxMinutes * (tol.spanRatio ?? 1);
  return maxMinutes + grace + span;
}

export default function createAccessibilityService({
  logger,
  orsPost,
  openRouteService = config.openRouteService,
  probableLocation = config.probableLocation,
} = {}) {
  function configured() {
    return Boolean(orsPost || openRouteService.apiKey);
  }

  /** Appel ORS isochrones par défaut. */
  async function defaultOrsPost(profile, body) {
    const response = await fetch(
      `${openRouteService.baseUrl}/v2/isochrones/${profile}`,
      {
        method: "POST",
        headers: {
          Authorization: openRouteServiceAuthorizationHeader(
            openRouteService.apiKey
          ),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(openRouteService.timeoutMs),
      }
    );
    if (!response.ok) throw new Error(`ors_isochrone_http_${response.status}`);
    return response.json();
  }

  const post = orsPost || defaultOrsPost;

  /**
   * Profil d'accessibilité d'une contrainte temporelle géocodée.
   * @returns {Promise<{ mode: 'isochrone'|'circle', transport, center, maxMinutes, cutoffMinutes, bands?: Array<{minutes, polygon}> }>}
   */
  async function buildTimeAccess(constraint) {
    const center = { lat: constraint.latitude, lon: constraint.longitude };
    const transport = constraint.transport || "walking";
    const maxMinutes = constraint.max_minutes;
    const cutoff = minutesCutoff(maxMinutes, probableLocation.toleranceMinutes);
    const base = { transport, center, maxMinutes, cutoffMinutes: cutoff };

    if (!configured()) return { ...base, mode: "circle" };

    const grace = maxMinutes * (probableLocation.toleranceMinutes.graceRatio || 0);
    const minutesPoints = linspace(maxMinutes + grace, cutoff, BAND_COUNT)
      .map((m) => Math.max(1, Math.round(m)))
      .filter((m, i, arr) => arr.indexOf(m) === i)
      .sort((a, b) => a - b);

    const profile = PROFILES[transport] || PROFILES.walking;

    let data;
    try {
      data = await post(profile, {
        locations: [[center.lon, center.lat]],
        range: minutesPoints.map((m) => m * 60),
        range_type: "time",
        location_type: "destination",
        attributes: [],
      });
    } catch (err) {
      logger?.warn?.(
        { err: err.message, place: constraint.place },
        "Isochrone ORS indisponible — repli cercle"
      );
      return { ...base, mode: "circle" };
    }

    const bands = (data?.features || [])
      .map((f) => ({
        minutes: Number(f.properties?.value) / 60,
        polygon: f.geometry?.coordinates || null,
      }))
      .filter((b) => Number.isFinite(b.minutes) && b.polygon)
      .sort((a, b) => a.minutes - b.minutes);

    if (!bands.length) return { ...base, mode: "circle" };
    return { ...base, mode: "isochrone", bands };
  }

  return { configured, buildTimeAccess, minutesCutoff };
}

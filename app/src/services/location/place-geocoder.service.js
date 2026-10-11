/**
 * Étape 2 du moteur de localisation probable : géocodage déterministe des
 * lieux extraits (POI type « Monoprix », « gare du Val d'Or »).
 *
 * Fournisseur principal : Nominatim (OpenStreetMap), bon sur les POI, borné au
 * contexte ville + code postal. Repli : Base Adresse Nationale (adresses). Les
 * résultats (positifs ET négatifs) sont mis en cache (`geocode_cache`) pour
 * respecter le rate-limit Nominatim (~1 req/s).
 *
 * Désambiguïsation : un lieu homonyme est départagé par ville, code postal,
 * type OSM attendu et proximité au centre de la commune. Un lieu qui reste
 * ambigu ou trop peu sûr est REJETÉ (non utilisé dans le calcul principal).
 */

import config from "../../config.js";
import { haversineMeters, metersToLatDegrees, metersToLonDegrees } from "../../lib/geo.js";
import { normalizeText } from "./constraint-extractor.service.js";

const BAN_SEARCH = "https://api-adresse.data.gouv.fr/search/";

/** Rayon (m) autour du centre commune servant de viewbox Nominatim. */
const CITY_VIEWBOX_RADIUS_M = 12_000;
/** Au-delà, un résultat est jugé hors contexte (autre ville homonyme). */
const MAX_DISTANCE_FROM_CITY_M = 25_000;
/** En dessous, le meilleur candidat est trop incertain → rejet. */
const MIN_CONFIDENCE = 0.3;

/** Classes/types OSM acceptables par `place_type` extrait. */
const OSM_EXPECTATIONS = {
  train_station: (r) => r.class === "railway" && /station|halt/.test(r.type || ""),
  metro_station: (r) => r.class === "railway",
  tram_station: (r) => r.class === "railway" && /tram/.test(r.type || ""),
  bus_stop: (r) => r.type === "bus_stop" || r.class === "highway",
  transit: (r) => r.class === "railway" || r.class === "highway",
  school: (r) => r.type === "school" || r.class === "amenity",
  university: (r) => /college|university/.test(r.type || ""),
  shop: (r) => r.class === "shop",
  supermarket: (r) => r.type === "supermarket" || r.class === "shop",
  park: (r) => r.type === "park" || r.class === "leisure",
  hospital: (r) => r.type === "hospital",
  pharmacy: (r) => r.type === "pharmacy",
  church: (r) => r.type === "place_of_worship" || r.class === "amenity",
  landmark: () => true,
  address: () => true,
  other: () => true,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addressCity(address) {
  if (!address) return null;
  return (
    address.city ||
    address.town ||
    address.village ||
    address.municipality ||
    address.suburb ||
    null
  );
}

export default function createPlaceGeocoderService({
  repositories,
  logger,
  httpGetJson,
  nominatim = config.nominatim,
} = {}) {
  const cache = repositories?.geocodeCache || null;
  let lastNominatimCall = 0;

  /** Appel HTTP JSON par défaut (fetch). Respecte le rate-limit Nominatim. */
  async function defaultHttpGetJson(url, { headers = {}, rateLimit = false } = {}) {
    if (rateLimit) {
      const wait = 1100 - (Date.now() - lastNominatimCall);
      if (wait > 0) await sleep(wait);
      lastNominatimCall = Date.now();
    }
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(nominatim.timeoutMs),
    });
    if (!response.ok) throw new Error(`geocode_http_${response.status}`);
    return response.json();
  }

  const getJson = httpGetJson || defaultHttpGetJson;

  function nominatimHeaders() {
    return { "User-Agent": nominatim.userAgent, Accept: "application/json" };
  }

  /** Construit l'URL de recherche Nominatim bornée au contexte. */
  function nominatimUrl(query, { postalCode, cityCenter }) {
    const params = new URLSearchParams({
      q: query,
      format: "jsonv2",
      addressdetails: "1",
      limit: "6",
      countrycodes: "fr",
    });
    if (nominatim.email) params.set("email", nominatim.email);
    if (cityCenter) {
      const latPad = metersToLatDegrees(CITY_VIEWBOX_RADIUS_M);
      const lonPad = metersToLonDegrees(CITY_VIEWBOX_RADIUS_M, cityCenter.lat);
      // viewbox = left,top,right,bottom (lon/lat)
      params.set(
        "viewbox",
        [
          cityCenter.lon - lonPad,
          cityCenter.lat + latPad,
          cityCenter.lon + lonPad,
          cityCenter.lat - latPad,
        ].join(",")
      );
      params.set("bounded", "0");
    }
    // Nominatim refuse la combinaison `q=` + paramètres structurés (`postalcode`,
    // `city`, etc.) → HTTP 400. Le contexte CP/ville est déjà dans `query`.
    return `${nominatim.baseUrl}/search?${params.toString()}`;
  }

  /** Note un résultat Nominatim dans le contexte de la contrainte. */
  function scoreResult(result, { placeType, city, postalCode, cityCenter, peers }) {
    let score = Math.min(0.5, Number(result.importance) || 0.1);

    const addr = result.address || {};
    if (postalCode && addr.postcode && String(addr.postcode) === String(postalCode)) {
      score += 0.3;
    }
    const rCity = normalizeText(addressCity(addr));
    if (city && rCity && rCity === normalizeText(city)) score += 0.2;

    const expect = OSM_EXPECTATIONS[placeType] || OSM_EXPECTATIONS.other;
    if (expect(result)) score += 0.2;

    const point = { lat: Number(result.lat), lon: Number(result.lon) };
    if (cityCenter && Number.isFinite(point.lat)) {
      const d = haversineMeters(cityCenter, point);
      if (d > MAX_DISTANCE_FROM_CITY_M) score -= 0.5;
      else score += 0.1 * (1 - d / MAX_DISTANCE_FROM_CITY_M);
    }
    // Proximité aux lieux déjà résolus (cohérence intra-annonce).
    if (peers?.length && Number.isFinite(point.lat)) {
      const nearest = Math.min(...peers.map((p) => haversineMeters(p, point)));
      if (nearest < 3000) score += 0.1;
    }

    return { point, score, label: result.display_name };
  }

  /** Recherche Nominatim + désambiguïsation → { point, confidence } | null. */
  async function viaNominatim(query, context) {
    const cached = cache?.get("nominatim", query);
    if (cached) {
      return cached.found
        ? {
            point: { lat: cached.lat, lon: cached.lng },
            confidence: cached.confidence,
            label: cached.place,
          }
        : null;
    }

    let results;
    try {
      results = await getJson(nominatimUrl(query, context), {
        headers: nominatimHeaders(),
        rateLimit: true,
      });
    } catch (err) {
      const msg = String(err.message || "");
      const detail = msg.startsWith("geocode_http_")
        ? `Nominatim a répondu ${msg.replace("geocode_http_", "HTTP ")}`
        : "Nominatim injoignable";
      logger?.warn?.({ err: msg, query }, detail);
      return null;
    }

    if (!Array.isArray(results) || !results.length) {
      cache?.set("nominatim", query, { found: false });
      return null;
    }

    const scored = results
      .map((r) => scoreResult(r, context))
      .filter((s) => Number.isFinite(s.point.lat) && Number.isFinite(s.point.lon))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < MIN_CONFIDENCE) {
      cache?.set("nominatim", query, { found: false });
      return null;
    }

    // Ambiguïté : deux candidats quasi ex æquo mais géographiquement éloignés.
    const second = scored[1];
    if (
      second &&
      best.score - second.score < 0.05 &&
      haversineMeters(best.point, second.point) > 2000
    ) {
      logger?.info?.({ query }, "lieu ambigu (Nominatim) — rejeté");
      cache?.set("nominatim", query, { found: false });
      return null;
    }

    const confidence = Math.min(0.99, Math.max(0, best.score));
    cache?.set("nominatim", query, {
      found: true,
      place: best.label,
      lat: best.point.lat,
      lng: best.point.lon,
      confidence,
    });
    return { point: best.point, confidence, label: best.label };
  }

  /** Repli Base Adresse Nationale (surtout adresses) → { point, confidence } | null. */
  async function viaBan(query, context) {
    const cached = cache?.get("ban", query);
    if (cached) {
      return cached.found
        ? {
            point: { lat: cached.lat, lon: cached.lng },
            confidence: cached.confidence,
            label: cached.place,
          }
        : null;
    }

    const params = new URLSearchParams({ q: query, limit: "1" });
    if (context.postalCode) params.set("postcode", context.postalCode);
    let data;
    try {
      data = await getJson(`${BAN_SEARCH}?${params.toString()}`, {});
    } catch (err) {
      logger?.warn?.({ err: err.message, query }, "BAN injoignable");
      return null;
    }

    const feature = data?.features?.[0];
    const coords = feature?.geometry?.coordinates;
    if (!coords) {
      cache?.set("ban", query, { found: false });
      return null;
    }
    const point = { lat: coords[1], lon: coords[0] };
    const confidence = Math.min(0.9, Number(feature.properties?.score) || 0.5);
    cache?.set("ban", query, {
      found: true,
      place: feature.properties?.label,
      lat: point.lat,
      lng: point.lon,
      confidence,
    });
    return { point, confidence, label: feature.properties?.label };
  }

  /** Centre approximatif d'une commune (pour borner les recherches de POI). */
  async function geocodeCity({ city, postalCode }) {
    const query = [postalCode, city].filter(Boolean).join(" ").trim();
    if (!query) return null;
    const result =
      (await viaNominatim(query, { placeType: "landmark", city, postalCode })) ||
      (await viaBan(query, { postalCode }));
    return result?.point || null;
  }

  /** Adresse postale (numéro + voie) dans le contexte ville / CP. */
  async function geocodeAddress({ line, city, postalCode }) {
    const query = [line, postalCode, city].filter(Boolean).join(" ").trim();
    if (!query) return null;
    const cityCenter = await geocodeCity({ city, postalCode });
    const context = { placeType: "address", city, postalCode, cityCenter };
    const hit =
      (await viaBan(query, { postalCode })) ||
      (await viaNominatim(query, context));
    return hit?.point || null;
  }

  /**
   * Géocode toutes les contraintes. Enrichit chaque contrainte avec
   * `latitude`, `longitude`, `geocoding_confidence` ou la marque `rejected`.
   * @returns {Promise<{ constraints: object[], cityCenter: {lat,lon}|null }>}
   */
  async function geocodeConstraints(constraints, { city, postalCode } = {}) {
    const cityCenter = await geocodeCity({ city, postalCode });
    const resolved = [];
    const peers = [];

    for (const constraint of constraints || []) {
      const query = [constraint.place, city].filter(Boolean).join(", ");
      const context = {
        placeType: constraint.place_type,
        city,
        postalCode,
        cityCenter,
        peers,
      };

      const hit =
        (await viaNominatim(query, context)) ||
        (await viaBan(query, { ...context })) ||
        (constraint.place_type === "address"
          ? await viaBan([constraint.place, postalCode, city].filter(Boolean).join(" "), {
              postalCode,
            })
          : null);

      if (!hit) {
        resolved.push({ ...constraint, rejected: true, reject_reason: "not_found" });
        continue;
      }

      peers.push(hit.point);
      resolved.push({
        ...constraint,
        latitude: hit.point.lat,
        longitude: hit.point.lon,
        geocoding_confidence: hit.confidence,
        geocoded_label: hit.label || null,
      });
    }

    return { constraints: resolved, cityCenter };
  }

  return { geocodeConstraints, geocodeCity, geocodeAddress };
}

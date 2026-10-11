const MAPS_ORIGIN = "https://www.google.com/maps";
const STREETVIEW_METADATA =
  "https://maps.googleapis.com/maps/api/streetview/metadata";

/**
 * Recherche ou épingle une adresse / des coordonnées sur Google Maps.
 * @param {string} query
 */
export function googleMapsSearchUrl(query) {
  const q = String(query ?? "").trim();
  return `${MAPS_ORIGIN}/search/?api=1&query=${encodeURIComponent(q)}`;
}

/**
 * Ouvre Street View au panorama le plus proche du point (lat, lng).
 * Sans panorama à proximité, Google Maps peut afficher un écran noir : préférer
 * {@link resolveGoogleMapsListingUrl} ou {@link googleMapsListingUrl}.
 * @see https://developers.google.com/maps/documentation/urls/get-started#street-view-action
 */
export function googleMapsStreetViewUrl(lat, lng) {
  const viewpoint = `${lat},${lng}`;
  return `${MAPS_ORIGIN}/@?api=1&map_action=pano&viewpoint=${encodeURIComponent(viewpoint)}`;
}

/**
 * Street View avec un panorama ID connu (plus fiable que viewpoint seul).
 */
export function googleMapsStreetViewPanoUrl(panoId, lat, lng) {
  const id = String(panoId ?? "").trim();
  if (!id) return null;
  const params = new URLSearchParams({
    api: "1",
    map_action: "pano",
    pano: id,
  });
  if (
    lat != null &&
    lng != null &&
    Number.isFinite(lat) &&
    Number.isFinite(lng)
  ) {
    params.set("viewpoint", `${lat},${lng}`);
  }
  return `${MAPS_ORIGIN}/@?${params.toString()}`;
}

/**
 * Lien sûr « bien immobilier » : recherche texte ou coordonnées (jamais de pano
 * forcé, pour éviter les écrans Street View noirs sans couverture).
 */
export function googleMapsListingUrl({ lat, lng, query }) {
  const q = String(query ?? "").trim();
  if (q) return googleMapsSearchUrl(q);
  if (lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)) {
    return googleMapsSearchUrl(`${lat},${lng}`);
  }
  return googleMapsSearchUrl(q);
}

/**
 * @param {string} location Adresse ou « lat,lng »
 * @param {string} apiKey
 * @returns {Promise<{ status: string, pano_id?: string, location?: { lat: number, lng: number } } | null>}
 */
export async function fetchStreetViewMetadata(location, apiKey, { timeoutMs = 5000 } = {}) {
  const loc = String(location ?? "").trim();
  const key = String(apiKey ?? "").trim();
  if (!loc || !key) return null;

  const url =
    `${STREETVIEW_METADATA}?location=${encodeURIComponent(loc)}` +
    `&key=${encodeURIComponent(key)}`;

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Lien optimal : Street View si la couverture est confirmée (clé Google), sinon
 * recherche Maps classique.
 */
export async function resolveGoogleMapsListingUrl(
  { lat, lng, query },
  { apiKey, metadataFetcher } = {}
) {
  const q = String(query ?? "").trim();
  const fallback = () => googleMapsListingUrl({ lat, lng, query: q });

  const location =
    q ||
    (lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)
      ? `${lat},${lng}`
      : "");
  if (!location) return fallback();

  const key = String(apiKey ?? "").trim();
  if (!key) return fallback();

  const fetchMeta =
    metadataFetcher ||
    ((loc) => fetchStreetViewMetadata(loc, key));
  const meta = await fetchMeta(location);
  if (meta?.status !== "OK" || !meta.pano_id) return fallback();

  const panoLat = meta.location?.lat ?? lat;
  const panoLng = meta.location?.lng ?? lng;
  const panoUrl = googleMapsStreetViewPanoUrl(meta.pano_id, panoLat, panoLng);
  return panoUrl || fallback();
}

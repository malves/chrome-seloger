/**
 * Trajets voiture recalculés par le carnet depuis l'adresse réelle du bien.
 *
 * Les trajets envoyés par l'extension (`extension_data.travel_times`) ne sont
 * jamais modifiés : le calcul web vit dans `listing_enrichments` et ne remplace
 * l'affichage que tant qu'une adresse réelle géocodée est enregistrée.
 */

import crypto from "node:crypto";
import { googleMapsListingUrl } from "./google-maps-url.js";

export const LISTING_TRAVEL_PROVIDER = "listing-travel";

function finiteCoord(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function resolveTravelProject(listing, projectsService, userId) {
  const linked = listing.projects?.[0];
  if (linked?.id) return linked;
  return projectsService.ensureDefault(userId);
}

/** Origine `{ lat, lon }` si l'adresse réelle est saisie et géocodée, sinon `null`. */
export function resolveTravelOrigin(listing) {
  if (!String(listing?.user_address || "").trim()) return null;
  const lat = finiteCoord(listing.user_lat);
  const lon = finiteCoord(listing.user_lng);
  if (lat == null || lon == null) return null;
  return { lat, lon };
}

export function destinationsFromProject(repositories, projectId) {
  return repositories.projects.listAddresses(projectId).map((row) => ({
    id: row.id,
    label: row.label || null,
    address: row.address,
    lat: row.lat,
    lon: row.lng,
  }));
}

export function listingTravelInputFingerprint(listing, projectId, destinations) {
  const parts = [
    String(projectId || ""),
    String(listing.user_lat ?? ""),
    String(listing.user_lng ?? ""),
    ...(destinations || [])
      .map((d) => [d.id, d.label || "", d.address || "", d.lat ?? "", d.lon ?? ""].join("|"))
      .sort(),
  ];
  return crypto.createHash("sha1").update(parts.join("\x1e")).digest("hex");
}

export function needsListingTravelRefresh(cachedData, listing, projectId, destinations) {
  if (!cachedData?.inputFingerprint) return true;
  return (
    cachedData.inputFingerprint !==
    listingTravelInputFingerprint(listing, projectId, destinations)
  );
}

/** Résultats de `travelService.compute` → format de `extension_data.travel_times`. */
export function toExtensionTravelTimes(results) {
  return (results || [])
    .filter((row) => !row.error && row.duration_seconds != null)
    .map((row) => {
      const hasCoords = finiteCoord(row.lat) != null && finiteCoord(row.lon) != null;
      return {
        label: row.label || "Adresse de référence",
        mode: "car",
        minutes: Math.round(row.duration_seconds / 60),
        distance_km:
          row.distance_meters != null ? Math.round(row.distance_meters / 1000) : null,
        maps_url:
          hasCoords || row.address
            ? googleMapsListingUrl({
                lat: hasCoords ? row.lat : null,
                lng: hasCoords ? row.lon : null,
                query: row.address || null,
              })
            : null,
        address: row.address || null,
        lat: row.lat ?? null,
        lon: row.lon ?? null,
      };
    });
}

/**
 * Trajets web à afficher à la place de ceux de l'extension, ou `null` si
 * l'affichage doit rester celui de l'extension (pas d'adresse réelle, calcul
 * absent, en échec ou périmé).
 */
export function webTravelTimesFor(listing, row, projectId, destinations) {
  if (!resolveTravelOrigin(listing)) return null;
  if (row?.status !== "ok" || !Array.isArray(row.data?.travel_times)) return null;
  if (!row.data.travel_times.length) return null;
  if (needsListingTravelRefresh(row.data, listing, projectId, destinations)) return null;
  return row.data.travel_times;
}

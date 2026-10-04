/**
 * Territoire utilisé pour la résolution INSEE et les enrichissements communaux.
 * L'adresse réelle (saisie ou déterminée par IA) prime sur la localisation annoncée.
 */

import { parseUserAddress } from "./user-address.js";

/**
 * @param {object} listing
 * @returns {{ source: 'user' | 'announced', city: string|null, postal_code: string|null, lat: number|null, lng: number|null }}
 */
export function listingTerritory(listing) {
  const userLine = listing?.user_address ? String(listing.user_address).trim() : "";
  if (userLine) {
    const parts = parseUserAddress(userLine);
    return {
      source: "user",
      city: parts.city || listing.city || null,
      postal_code: parts.postalCode || listing.postal_code || null,
      lat: listing.user_lat != null ? listing.user_lat : null,
      lng: listing.user_lng != null ? listing.user_lng : null,
    };
  }

  return {
    source: "announced",
    city: listing?.city || null,
    postal_code: listing?.postal_code || null,
    lat: listing?.lat != null ? listing.lat : null,
    lng: listing?.lng != null ? listing.lng : null,
  };
}

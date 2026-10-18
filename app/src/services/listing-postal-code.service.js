/**
 * Correction du code postal d'une annonce : communes candidates
 * (geo.api.gouv.fr) et enregistrement de la commune choisie.
 *
 * Le code INSEE en base n'est pas modifié : il reste celui de la localisation
 * annoncée, et la correction s'applique à la lecture (voir
 * lib/listing-postal-override.js). L'effacer suffit donc à revenir à l'annonce.
 */

import { nowIso } from "../lib/time.js";
import {
  buildPostalOverrideEntry,
  normalizeInseeCode,
  normalizePostalCode,
} from "../lib/listing-postal-override.js";
import createVisitSheetService from "./visit-sheet.service.js";

const GEO_BASE = "https://geo.api.gouv.fr";
const FIELDS = "nom,code,codesPostaux,centre,population";

function toCommune(raw) {
  // GeoJSON : [longitude, latitude].
  const coords = Array.isArray(raw?.centre?.coordinates) ? raw.centre.coordinates : null;
  return {
    insee_code: raw.code,
    name: raw.nom || raw.code,
    postal_codes: Array.isArray(raw.codesPostaux) ? raw.codesPostaux : [],
    population: raw.population ?? null,
    lat: coords && Number.isFinite(coords[1]) ? coords[1] : null,
    lng: coords && Number.isFinite(coords[0]) ? coords[0] : null,
  };
}

export default function createListingPostalCodeService({ repositories, fetchJson }) {
  const visitSheet = createVisitSheetService({ repositories });

  /**
   * Communes desservies par un code postal, triées par nom.
   * @returns {Promise<{ status: 'invalid'|'none'|'error'|'ok', postalCode: string|null, communes: object[] }>}
   */
  async function communesForPostalCode(value) {
    const postalCode = normalizePostalCode(value);
    if (!postalCode) return { status: "invalid", postalCode: null, communes: [] };
    const query = new URLSearchParams({ codePostal: postalCode, fields: FIELDS, format: "json" });
    let list;
    try {
      list = await fetchJson(`${GEO_BASE}/communes?${query}`);
    } catch {
      return { status: "error", postalCode, communes: [] };
    }
    const communes = (Array.isArray(list) ? list : [])
      .filter((item) => item && item.code)
      .map(toCommune)
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));
    return { status: communes.length ? "ok" : "none", postalCode, communes };
  }

  /**
   * Enregistre la commune choisie après avoir vérifié qu'elle relève bien du
   * code postal saisi.
   */
  async function save(listing, { postalCode, inseeCode }) {
    const postal = normalizePostalCode(postalCode);
    const insee = normalizeInseeCode(inseeCode);
    if (!postal || !insee) {
      return { ok: false, reason: "invalid", message: "Code postal ou commune invalide." };
    }

    let raw;
    try {
      raw = await fetchJson(`${GEO_BASE}/communes/${encodeURIComponent(insee)}?fields=${FIELDS}`);
    } catch {
      return {
        ok: false,
        reason: "unavailable",
        message: "Vérification de la commune impossible pour le moment. Réessayez dans quelques instants.",
      };
    }
    const commune = raw && raw.code ? toCommune(raw) : null;
    if (!commune || !commune.postal_codes.includes(postal)) {
      return {
        ok: false,
        reason: "mismatch",
        message: "Cette commune ne correspond pas au code postal saisi.",
      };
    }

    const announcedInsee = listing.announced_location
      ? listing.announced_location.insee_code
      : listing.insee_code;
    visitSheet.setPostalCodeOverride(
      listing,
      buildPostalOverrideEntry({
        postalCode: postal,
        commune,
        relocate: announcedInsee !== commune.insee_code,
        updatedAt: nowIso(),
      })
    );
    return { ok: true, commune };
  }

  /** Rétablit le code postal et la commune de l'annonce. */
  function clear(listing) {
    visitSheet.setPostalCodeOverride(listing, null);
  }

  return { communesForPostalCode, save, clear };
}

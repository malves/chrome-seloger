/**
 * Résolution de la commune via l'API Découpage administratif (geo.api.gouv.fr).
 *
 * Prérequis de tous les futurs providers communaux : c'est lui qui renseigne
 * `listings.insee_code`. Il s'exécute donc en premier (`order: 0`) et sans
 * code INSEE préalable (`resolvesInsee`).
 */

import { listingTerritory } from "../../lib/listing-territory.js";

const BASE = "https://geo.api.gouv.fr";
const FIELDS = "nom,code,codesPostaux,population,surface,departement,region";

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/**
 * Plusieurs communes partagent un code postal : on privilégie le nom exact,
 * puis une correspondance partielle, puis la plus peuplée.
 */
export function pickCommune(list, city) {
  if (!Array.isArray(list) || !list.length) return null;
  if (list.length === 1) return list[0];

  if (city) {
    const target = normalizeName(city);
    const exact = list.find((item) => normalizeName(item.nom) === target);
    if (exact) return exact;

    const partial = list.find((item) => {
      const name = normalizeName(item.nom);
      return name.startsWith(target) || target.startsWith(name);
    });
    if (partial) return partial;
  }

  return [...list].sort((a, b) => (b.population || 0) - (a.population || 0))[0];
}

function toResult(commune) {
  return {
    insee_code: commune.code,
    name: commune.nom,
    postal_codes: commune.codesPostaux || [],
    population: commune.population ?? null,
    // `surface` est exprimée en hectares par l'API.
    area_km2:
      typeof commune.surface === "number"
        ? Math.round((commune.surface / 100) * 100) / 100
        : null,
    department: commune.departement
      ? { code: commune.departement.code, name: commune.departement.nom }
      : null,
    region: commune.region
      ? { code: commune.region.code, name: commune.region.nom }
      : null,
  };
}

export default {
  key: "commune",
  scope: "commune",
  order: 0,
  ttlDays: 180,
  label: "Commune",
  resolvesInsee: true,

  async fetch({ listing, inseeCode, fetchJson }) {
    const territory = listingTerritory(listing);
    const search = async (params) => {
      const query = new URLSearchParams({ fields: FIELDS, format: "json", ...params });
      return fetchJson(`${BASE}/communes?${query}`);
    };

    if (inseeCode && territory.source !== "user") {
      const commune = await fetchJson(
        `${BASE}/communes/${encodeURIComponent(inseeCode)}?fields=${FIELDS}`
      );
      return toResult(commune);
    }

    if (territory.lat != null && territory.lng != null) {
      const found = pickCommune(
        await search({ lat: String(territory.lat), lon: String(territory.lng) }),
        territory.city
      );
      if (found) return toResult(found);
    }

    if (territory.postal_code) {
      const found = pickCommune(
        await search({ codePostal: territory.postal_code }),
        territory.city
      );
      if (found) return toResult(found);
    }

    if (territory.city) {
      const found = pickCommune(await search({ nom: territory.city }), territory.city);
      if (found) return toResult(found);
    }

    throw new Error(
      "Localisation insuffisante : ni coordonnées, ni code postal, ni commune."
    );
  },
};

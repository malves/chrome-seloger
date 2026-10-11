/**
 * « Déterminer l'adresse » — recherche DPE puis repli département.
 *
 * 1. Mode précis : code postal + type + surface ±3 %, scoring multi-critères.
 * 2. Repli département : mêmes filtres type/surface, territoire = département
 *    (ex. 92 au lieu de 92210) si aucun candidat ou si toutes les confiances
 *    sont très basses.
 */

import {
  listingDpeSearchCriteria,
  dpeBuildingTypesFor,
} from "../lib/listing-dpe-criteria.js";
import { floorFromDpeRaw } from "../lib/dpe-floor.js";
import { dpeHeatingEnergy, energyFamily } from "../lib/energy-source.js";
import {
  fetchStreetViewMetadata,
  resolveGoogleMapsListingUrl,
} from "../lib/google-maps-url.js";
import { dpeAddressKey, dpeMapsQuery, dpeStreetLine } from "../lib/dpe-address.js";

/** Demi-largeur de la fenêtre de surface (±3%). */
export const SURFACE_MARGIN = 0.03;

/**
 * Fenêtres de tolérance des valeurs chiffrées DPE/GES : l'annonce affiche des
 * entiers arrondis, la base ADEME des décimales (ex. 564,5 kWhEP/m².an).
 */
const CONSO_MARGIN = 0.03;
const CONSO_MIN_WINDOW = 5;
const EMISSIONS_MARGIN = 0.1;
const EMISSIONS_MIN_WINDOW = 2;

/** Nombre maximum d'adresses candidates renvoyées. */
const MAX_CANDIDATES = 6;

/** En dessous, on relance la même recherche au niveau département. */
export const LOW_CONFIDENCE_THRESHOLD = 50;

export function needsDepartmentFallback(candidates) {
  if (!candidates?.length) return true;
  return candidates.every((c) => (c.confidence ?? 0) < LOW_CONFIDENCE_THRESHOLD);
}

/** Points attribués par critère concordant (base = appartenance CP + type). */
const WEIGHTS = {
  base: 30,
  surface: 25,
  dpe: 20,
  ges: 15,
  conso: 30,
  emissions: 20,
  floor: 25,
  year: 15,
  energy: 15,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Proximité 0..1 d'une valeur DPE par rapport à celle de l'annonce : 1 si
 * identique, 0 au-delà de la fenêtre (max(cible × marge, plancher)).
 */
function closenessTo(actual, target, margin, minWindow) {
  const value = Number(actual);
  if (actual == null || actual === "" || !Number.isFinite(value)) return 0;
  const window = Math.max(target * margin, minWindow);
  return clamp(1 - Math.abs(value - target) / window, 0, 1);
}

function consoFromRecord(record) {
  return toFiniteNumber(record.raw?.conso_5_usages_par_m2_ep);
}

function emissionsFromRecord(record) {
  return toFiniteNumber(record.raw?.emission_ges_5_usages_par_m2);
}

function toFiniteNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Teste si une année tombe dans une période de construction DPE.
 * Formats gérés : « 1948-1974 », « avant 1948 », « après 2021 ».
 * Utile car l'année des annonces est souvent approximative (ex. « 1960 »)
 * tandis que le DPE ne renseigne qu'une tranche.
 */
export function periodContainsYear(period, year) {
  if (!period || year == null) return false;
  const text = String(period)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  const range = text.match(/(\d{4})\s*[-\u2013]\s*(\d{4})/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    return year >= Math.min(a, b) && year <= Math.max(a, b);
  }
  const before = text.match(/avant\s*(\d{4})/);
  if (before) return year <= Number(before[1]);
  const after = text.match(/apres\s*(\d{4})/);
  if (after) return year >= Number(after[1]);
  const single = text.match(/(\d{4})/);
  if (single) return year === Number(single[1]);
  return false;
}

function floorFromRecord(record) {
  return floorFromDpeRaw(record.raw || {});
}

/** Colonnes date DPE exposées dans le tableau de debug (console navigateur). */
export const DPE_DEBUG_DATE_KEYS = [
  "date_derniere_modification_dpe",
  "date_etablissement_dpe",
  "date_fin_validite_dpe",
  "date_reception_dpe",
  "date_visite_diagnostiqueur",
];

function dpeDateField(record, key) {
  const raw = record.raw || {};
  const column = record[key];
  if (column != null && column !== "") return column;
  const fromRaw = raw[key];
  if (fromRaw != null && fromRaw !== "") return fromRaw;
  return null;
}

function dpeDebugDates(record) {
  const dates = {};
  for (const key of DPE_DEBUG_DATE_KEYS) {
    dates[key] = dpeDateField(record, key);
  }
  return dates;
}

function dpeDateModification(record) {
  return dpeDateField(record, "date_derniere_modification_dpe");
}

/**
 * Compare deux dates DPE (YYYY-MM-DD).
 * Retour positif si `left` est plus récente que `right` (les absentes passent après).
 */
export function compareDpeDateDesc(left, right) {
  const a = left != null && left !== "" ? String(left) : null;
  const b = right != null && right !== "" ? String(right) : null;
  if (a === b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  return a.localeCompare(b);
}

function shouldPreferDpeRecord({ confidence, dateModif }, existing) {
  if (confidence > existing.confidence) return true;
  if (confidence < existing.confidence) return false;
  return compareDpeDateDesc(dateModif, existing.dpeDateModif) > 0;
}

function applyRepresentativeDpe(target, record, { confidence, matched }) {
  target.confidence = confidence;
  target.matched = matched;
  target.numeroDpe = record.numero_dpe;
  target.dpeDateModif = dpeDateModification(record);
  target.source = recordDebug(record);
}

/** Valeurs brutes du DPE utilisées pour le matching (debug console client). */
function recordDebug(record) {
  const raw = record.raw || {};
  return {
    numeroDpe: record.numero_dpe,
    surface: record.surface_habitable_logement ?? null,
    dpe: record.etiquette_dpe ?? null,
    ges: record.etiquette_ges ?? null,
    conso: consoFromRecord(record),
    emissions: emissionsFromRecord(record),
    annee: record.annee_construction ?? null,
    periode: raw.periode_construction ?? null,
    etage: floorFromRecord(record),
    etageComplement: raw.complement_adresse_logement ?? null,
    etageStructure: raw.numero_etage_appartement ?? null,
    etageTexte: raw.complement_adresse_logement ?? null,
    typeBatiment: record.type_batiment ?? null,
    energie: dpeHeatingEnergy(raw),
    dates: dpeDebugDates(record),
  };
}

/**
 * Note un DPE par rapport aux critères de l'annonce.
 * Chaque critère disponible dans l'annonce compte dans le « possible » ; les
 * points réellement gagnés dépendent de la concordance avec le DPE.
 */
export function scoreRecord(record, criteria) {
  let earned = 0;
  let possible = 0;
  const matched = {};

  // Surface : critère requis (toujours présent en mode précis).
  if (criteria.surfaceM2 != null) {
    possible += WEIGHTS.surface;
    const recSurface = Number(record.surface_habitable_logement);
    if (Number.isFinite(recSurface) && recSurface > 0) {
      const diff = Math.abs(recSurface - criteria.surfaceM2);
      const window = criteria.surfaceM2 * SURFACE_MARGIN || 1;
      const closeness = clamp(1 - diff / window, 0, 1);
      earned += WEIGHTS.surface * closeness;
      matched.surface = closeness >= 0.5;
    } else {
      // DPE d'immeuble sans surface de logement : non confirmé.
      matched.surface = false;
    }
  }

  // Étiquette DPE.
  if (criteria.dpe != null) {
    possible += WEIGHTS.dpe;
    const ok = String(record.etiquette_dpe || "").toUpperCase() === criteria.dpe;
    if (ok) earned += WEIGHTS.dpe;
    matched.dpe = ok;
  }

  // Étiquette GES.
  if (criteria.ges != null) {
    possible += WEIGHTS.ges;
    const ok = String(record.etiquette_ges || "").toUpperCase() === criteria.ges;
    if (ok) earned += WEIGHTS.ges;
    matched.ges = ok;
  }

  // Consommation en énergie primaire (kWhEP/m².an) : bien plus discriminante
  // que l'étiquette, qui couvre une large plage (G = plus de 420).
  if (criteria.consoM2 != null) {
    possible += WEIGHTS.conso;
    const closeness = closenessTo(
      consoFromRecord(record),
      criteria.consoM2,
      CONSO_MARGIN,
      CONSO_MIN_WINDOW
    );
    earned += WEIGHTS.conso * closeness;
    matched.conso = closeness >= 0.5;
  }

  // Émissions de gaz à effet de serre (kg CO₂/m².an).
  if (criteria.emissionsM2 != null) {
    possible += WEIGHTS.emissions;
    const closeness = closenessTo(
      emissionsFromRecord(record),
      criteria.emissionsM2,
      EMISSIONS_MARGIN,
      EMISSIONS_MIN_WINDOW
    );
    earned += WEIGHTS.emissions * closeness;
    matched.emissions = closeness >= 0.5;
  }

  // Étage (appartements uniquement : `criteria.etage` n'est renseigné que
  // lorsque l'annonce porte un étage).
  if (criteria.etage != null) {
    possible += WEIGHTS.floor;
    const recFloor = floorFromRecord(record);
    const ok = recFloor != null && recFloor === criteria.etage;
    if (ok) earned += WEIGHTS.floor;
    matched.floor = ok;
  }

  // Année de construction : valeur exacte/proche, sinon appartenance à la
  // période de construction (souvent la seule info côté DPE, ex. « 1948-1974 »).
  if (criteria.anneeConstruction != null) {
    possible += WEIGHTS.year;
    let yearPts = 0;
    const recYear = Number(record.annee_construction);
    if (Number.isFinite(recYear) && recYear > 0) {
      const diff = Math.abs(recYear - criteria.anneeConstruction);
      if (diff === 0) yearPts = WEIGHTS.year;
      else if (diff <= 5) yearPts = WEIGHTS.year * 0.5;
    }
    // Confirmation approximative par la tranche de construction (valeur plus
    // grossière qu'une année exacte : au mieux une demi-pondération).
    if (
      yearPts < WEIGHTS.year * 0.5 &&
      periodContainsYear(record.raw?.periode_construction, criteria.anneeConstruction)
    ) {
      yearPts = WEIGHTS.year * 0.5;
    }
    earned += yearPts;
    matched.year = yearPts > 0;
  }

  // Énergie de chauffage, comparée par famille (« Gaz » ↔ « Gaz naturel »).
  if (criteria.famillesEnergie?.length) {
    possible += WEIGHTS.energy;
    const family = energyFamily(dpeHeatingEnergy(record.raw));
    const ok = family != null && criteria.famillesEnergie.includes(family);
    if (ok) earned += WEIGHTS.energy;
    matched.energy = ok;
  }

  const confidence = clamp(
    Math.round(((WEIGHTS.base + earned) / (WEIGHTS.base + possible)) * 100),
    30,
    95
  );

  return { confidence, matched };
}

function buildCandidates(records, criteria) {
  const byAddress = new Map();
  for (const record of records) {
    const { confidence, matched } = scoreRecord(record, criteria);
    const key = dpeAddressKey(record);
    const postalCode = record.code_postal_ban || criteria.codePostal;
    const city = record.nom_commune_ban || null;
    const street = dpeStreetLine(record);
    const locality = [postalCode, city].filter(Boolean).join(" ");
    const mapsQuery = dpeMapsQuery(record);

    const dateModif = dpeDateModification(record);
    const existing = byAddress.get(key);
    if (!existing) {
      byAddress.set(key, {
        street,
        locality,
        postalCode: postalCode || null,
        city,
        confidence,
        dpeCount: 1,
        mapsQuery,
        matched,
        numeroDpe: record.numero_dpe,
        dpeDateModif: dateModif,
        source: recordDebug(record),
      });
    } else {
      existing.dpeCount += 1;
      if (shouldPreferDpeRecord({ confidence, dateModif }, existing)) {
        applyRepresentativeDpe(existing, record, { confidence, matched });
      }
    }
  }

  return Array.from(byAddress.values())
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        compareDpeDateDesc(b.dpeDateModif, a.dpeDateModif) ||
        b.dpeCount - a.dpeCount
    )
    .slice(0, MAX_CANDIDATES);
}

/**
 * Géocode chaque adresse candidate (cache par requête) et ajoute `mapsUrl`
 * (Street View si le point est connu, sinon recherche texte).
 */
export async function enrichAddressAiCandidateMaps(
  candidates,
  geocodeAddress,
  { mapsApiKey } = {}
) {
  if (!candidates?.length || !geocodeAddress) return candidates ?? [];

  const coordsByQuery = new Map();
  const metadataByLocation = new Map();
  const enriched = [];

  for (const candidate of candidates) {
    const query = String(candidate.mapsQuery || candidate.street || "").trim();
    let lat = null;
    let lng = null;

    if (query) {
      if (!coordsByQuery.has(query)) {
        try {
          const geo = await geocodeAddress(query);
          coordsByQuery.set(
            query,
            geo && geo.lat != null && geo.lon != null
              ? { lat: geo.lat, lng: geo.lon }
              : null
          );
        } catch {
          coordsByQuery.set(query, null);
        }
      }
      const coords = coordsByQuery.get(query);
      if (coords) {
        lat = coords.lat;
        lng = coords.lng;
      }
    }

    const mapsUrl = await resolveGoogleMapsListingUrl(
      { lat, lng, query },
      {
        apiKey: mapsApiKey,
        metadataFetcher: mapsApiKey
          ? async (loc) => {
              if (!metadataByLocation.has(loc)) {
                metadataByLocation.set(
                  loc,
                  await fetchStreetViewMetadata(loc, mapsApiKey)
                );
              }
              return metadataByLocation.get(loc);
            }
          : undefined,
      }
    );

    enriched.push({
      ...candidate,
      mapsUrl,
    });
  }

  return enriched;
}

export default function createAddressAiService({ repositories, logger } = {}) {
  const repo = repositories.dpe;

  function runTerritorySearch({
    criteria,
    typeBatiments,
    territory,
    listingId,
    userId,
  }) {
    const surfaceMin = criteria.surfaceM2 * (1 - SURFACE_MARGIN);
    const surfaceMax = criteria.surfaceM2 * (1 + SURFACE_MARGIN);
    const filters = {
      typeBatiments,
      surfaceMin,
      surfaceMax,
      ...(territory === "departement"
        ? { departement: criteria.departement }
        : { codePostal: criteria.codePostal }),
    };
    const records = repo.searchAddressCandidates(filters);
    const candidates = buildCandidates(records, criteria);
    logger?.info?.(
      {
        ...(userId != null ? { userId } : {}),
        listingId,
        mode: territory,
        records: records.length,
        candidates: candidates.length,
        ...(territory === "departement"
          ? { departement: criteria.departement }
          : { codePostal: criteria.codePostal }),
      },
      territory === "departement"
        ? "address-ai/search (mode département)"
        : "address-ai/search (mode précis)"
    );
    return { records, candidates };
  }

  /**
   * Recherche des adresses candidates pour une annonce (CP puis repli département).
   * @returns {{ mode: string, criteria: object, champsRequisManquants: string[], candidates: object[], fallbackFrom?: string }}
   */
  function search(listing, { userId } = {}) {
    const payload = listingDpeSearchCriteria(listing);
    const criteria = payload.criteres;
    const typeBatiments = dpeBuildingTypesFor(listing.property_type);

    // Prérequis : code postal, type de bien, surface.
    const champsRequisManquants = [];
    if (!criteria.codePostal) champsRequisManquants.push("codePostal");
    if (!typeBatiments.length) champsRequisManquants.push("typeBatiment");
    if (criteria.surfaceM2 == null) champsRequisManquants.push("surfaceM2");

    if (champsRequisManquants.length) {
      return { mode: "precise", criteria, champsRequisManquants, candidates: [] };
    }

    const precise = runTerritorySearch({
      criteria,
      typeBatiments,
      territory: "precise",
      listingId: listing.id,
      userId,
    });

    if (
      !needsDepartmentFallback(precise.candidates) ||
      !criteria.departement
    ) {
      return {
        mode: "precise",
        criteria,
        champsRequisManquants: [],
        candidates: precise.candidates,
      };
    }

    const dept = runTerritorySearch({
      criteria,
      typeBatiments,
      territory: "departement",
      listingId: listing.id,
      userId,
    });

    return {
      mode: "departement",
      fallbackFrom: "precise",
      criteria,
      champsRequisManquants: [],
      candidates: dept.candidates,
    };
  }

  return { search };
}

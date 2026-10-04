/**
 * « Déterminer l'adresse » — mode de recherche précis.
 *
 * À partir des critères d'une annonce (code postal, type de bien, surface,
 * étiquettes DPE/GES, étage, année), on interroge la base DPE open data avec
 * des filtres stricts (CP + type + surface ±3%), puis on note chaque DPE selon
 * le nombre de critères concordants et on regroupe les résultats par adresse.
 *
 * C'est le premier maillon : des modes de recherche élargis (moins de critères)
 * viendront en repli plus tard.
 */

import {
  listingDpeSearchCriteria,
  dpeBuildingTypesFor,
} from "../lib/listing-dpe-criteria.js";
import { floorFromDpeRaw } from "../lib/dpe-floor.js";

/** Demi-largeur de la fenêtre de surface (±3%). */
const SURFACE_MARGIN = 0.03;

/** Nombre maximum d'adresses candidates renvoyées. */
const MAX_CANDIDATES = 6;

/** Points attribués par critère concordant (base = appartenance CP + type). */
const WEIGHTS = {
  base: 30,
  surface: 25,
  dpe: 20,
  ges: 15,
  floor: 25,
  year: 15,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

/** Valeurs brutes du DPE utilisées pour le matching (debug console client). */
function recordDebug(record) {
  const raw = record.raw || {};
  return {
    numeroDpe: record.numero_dpe,
    surface: record.surface_habitable_logement ?? null,
    dpe: record.etiquette_dpe ?? null,
    ges: record.etiquette_ges ?? null,
    annee: record.annee_construction ?? null,
    periode: raw.periode_construction ?? null,
    etage: floorFromRecord(record),
    etageComplement: raw.complement_adresse_logement ?? null,
    etageStructure: raw.numero_etage_appartement ?? null,
    etageTexte: raw.complement_adresse_logement ?? null,
    typeBatiment: record.type_batiment ?? null,
  };
}

/** Retire la localité (CP + commune) de l'adresse BAN pour isoler la voie. */
function streetFromBan(ban, postalCode, city) {
  if (!ban) return null;
  let street = String(ban);
  if (postalCode) {
    street = street.replace(new RegExp(`\\s*${postalCode}.*$`), "");
  } else if (city) {
    street = street.replace(new RegExp(`\\s*${city}\\s*$`, "i"), "");
  }
  street = street.replace(/[\s,]+$/, "").trim();
  return street || String(ban);
}

/**
 * Note un DPE par rapport aux critères de l'annonce.
 * Chaque critère disponible dans l'annonce compte dans le « possible » ; les
 * points réellement gagnés dépendent de la concordance avec le DPE.
 */
function scoreRecord(record, criteria) {
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

  const confidence = clamp(
    Math.round(((WEIGHTS.base + earned) / (WEIGHTS.base + possible)) * 100),
    30,
    95
  );

  return { confidence, matched };
}

/** Clé de regroupement : une adresse (BAN sinon brute). */
function addressKey(record) {
  return (
    record.adresse_ban ||
    record.adresse_brut ||
    `${record.code_postal_ban || ""}-${record.numero_dpe}`
  ).trim();
}

export default function createAddressAiService({ repositories, logger } = {}) {
  const repo = repositories.dpe;

  /**
   * Recherche précise des adresses candidates pour une annonce.
   * @returns {{ mode: string, criteria: object, champsRequisManquants: string[], candidates: object[] }}
   */
  function search(listing) {
    const payload = listingDpeSearchCriteria(listing);
    const criteria = payload.criteres;
    const typeBatiments = dpeBuildingTypesFor(listing.property_type);

    // Prérequis du mode précis : code postal, type de bien, surface.
    const champsRequisManquants = [];
    if (!criteria.codePostal) champsRequisManquants.push("codePostal");
    if (!typeBatiments.length) champsRequisManquants.push("typeBatiment");
    if (criteria.surfaceM2 == null) champsRequisManquants.push("surfaceM2");

    if (champsRequisManquants.length) {
      return { mode: "precise", criteria, champsRequisManquants, candidates: [] };
    }

    const surfaceMin = criteria.surfaceM2 * (1 - SURFACE_MARGIN);
    const surfaceMax = criteria.surfaceM2 * (1 + SURFACE_MARGIN);

    const records = repo.searchAddressCandidates({
      codePostal: criteria.codePostal,
      typeBatiments,
      surfaceMin,
      surfaceMax,
    });

    // Regroupement par adresse : on retient le meilleur score et le nombre de
    // DPE rattachés.
    const byAddress = new Map();
    for (const record of records) {
      const { confidence, matched } = scoreRecord(record, criteria);
      const key = addressKey(record);
      const postalCode = record.code_postal_ban || criteria.codePostal;
      const city = record.nom_commune_ban || null;
      const street =
        streetFromBan(record.adresse_ban, postalCode, city) ||
        record.adresse_brut ||
        null;
      const locality = [postalCode, city].filter(Boolean).join(" ");
      const mapsQuery =
        record.adresse_ban ||
        [street, postalCode, city].filter(Boolean).join(", ");

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
          source: recordDebug(record),
        });
      } else {
        existing.dpeCount += 1;
        if (confidence > existing.confidence) {
          existing.confidence = confidence;
          existing.matched = matched;
          existing.numeroDpe = record.numero_dpe;
          existing.source = recordDebug(record);
        }
      }
    }

    const candidates = Array.from(byAddress.values())
      .sort((a, b) => b.confidence - a.confidence || b.dpeCount - a.dpeCount)
      .slice(0, MAX_CANDIDATES);

    logger?.info?.(
      {
        listingId: listing.id,
        records: records.length,
        candidates: candidates.length,
      },
      "address-ai/search (mode précis)"
    );

    return { mode: "precise", criteria, champsRequisManquants: [], candidates };
  }

  return { search };
}

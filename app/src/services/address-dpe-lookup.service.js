/**
 * DPE d'une adresse saisie à la main.
 *
 * 1. Repérer la voie parmi les DPE du code postal, de façon tolérante (BAN
 *    d'abord, saisie du diagnostiqueur ensuite). Le numéro ne filtre pas : il
 *    distingue les DPE du numéro saisi de ceux du reste de la rue.
 * 2. Classer les logements avec les critères de l'annonce, comme la recherche
 *    IA (type de bâtiment, surface ±3 %, étiquettes, étage…), avant toute
 *    limitation : sans numéro saisi, c'est ce classement qui retrouve le bon.
 *
 * Verdict :
 * - `match`  : adresse identique à la BAN une fois normalisée **et** un DPE du
 *   numéro saisi se détache nettement → association sans rien demander ;
 * - `choose` : faute possible dans la voie (`address`), numéro non saisi
 *   (`number`), ou plusieurs logements plausibles (`dwelling`) → l'utilisateur
 *   confirme. Un logement d'un autre numéro de la rue qui correspond à
 *   l'annonce est alors proposé aussi (`otherNumber`) ;
 * - `none`   : rien d'approchant.
 */

import { scoreRecord, compareDpeDateDesc, SURFACE_MARGIN } from "./address-ai.service.js";
import {
  listingDpeSearchCriteria,
  dpeBuildingTypesFor,
} from "../lib/listing-dpe-criteria.js";
import { stripLocalityFromBanAddress } from "../lib/dpe-address.js";
import { floorFromDpeRaw } from "../lib/dpe-floor.js";
import {
  compareStreetNames,
  normalizeStreetName,
  parseStreetLine,
} from "../lib/street-match.js";

/** En dessous, la voie n'est pas proposée. */
const MIN_ADDRESS_SCORE = 0.72;
/** Une autre voie au-dessus de ce score rend l'adresse ambiguë. */
const RIVAL_ADDRESS_SCORE = 0.85;
/** La saisie brute du diagnostiqueur est moins fiable que la BAN. */
const BRUT_NAME_WEIGHT = 0.97;
/** Numéro absent du DPE, ou suffixe (bis/ter) différent. */
const NUMBER_UNCERTAIN_WEIGHT = 0.88;
/** DPE d'un autre numéro de la rue que celui saisi. */
const OTHER_NUMBER_WEIGHT = 0.8;

/** Association silencieuse : confiance minimale et avance sur le suivant. */
const AUTO_MIN_CONFIDENCE = 70;
const AUTO_MIN_GAP = 15;
/** Un autre numéro n'est proposé que s'il correspond à l'annonce. */
const OTHER_NUMBER_MIN_CONFIDENCE = 70;
/** Logement d'un autre type que l'annonce (maison ↔ appartement). */
const TYPE_MISMATCH_PENALTY = 25;
/** Logements trop en retrait du meilleur : non proposés (bruit). */
const MAX_CONFIDENCE_DROP = 45;

/** Voies retenues quand la saisie est ambiguë. */
const MAX_STREETS = 3;
const MAX_CANDIDATES = 6;
/** DPE du numéro saisi, chargés sans filtre de surface. */
const MAX_SAME_NUMBER_LOADED = 200;
/** DPE du reste de la rue, chargés avec les filtres de la recherche IA. */
const MAX_STREET_LOADED = 3000;

/** UTF-8 relu en Latin-1 dans la BAN (« GÃ©rhard ») : libellé inexploitable. */
const MOJIBAKE = /[ÃÂ]/;

/** Un code postal compte des dizaines de milliers de DPE, mais bien moins de libellés. */
function createCache() {
  return { lines: new Map(), names: new Map() };
}

function streetPartsOf(cache, text, postalCode) {
  const key = `${postalCode}\u0000${text}`;
  if (!cache.lines.has(key)) {
    const line = text ? stripLocalityFromBanAddress(text, postalCode, null) : null;
    const parts = line ? parseStreetLine(line) : null;
    cache.lines.set(key, parts?.name ? parts : null);
  }
  return cache.lines.get(key);
}

function compareNameCached(cache, typed, name) {
  if (!cache.names.has(name)) cache.names.set(name, compareStreetNames(typed.name, name));
  return cache.names.get(name);
}

/**
 * Compare la saisie à l'adresse d'un DPE.
 * `relation` : `same` (numéro saisi), `other` (autre numéro), `unknown` (DPE
 * sans numéro) ou `none` (aucun numéro saisi).
 */
function matchRow(typed, row, cache) {
  const ban = MOJIBAKE.test(row.adresse_ban || "")
    ? null
    : streetPartsOf(cache, row.adresse_ban, row.code_postal_ban);
  const brut = streetPartsOf(cache, row.adresse_brut, row.code_postal_ban);
  if (!ban && !brut) return null;

  const byBan = ban ? compareNameCached(cache, typed, ban.name) : { score: 0, exact: false };
  const byBrut = brut ? compareNameCached(cache, typed, brut.name) : { score: 0, exact: false };
  const nameScore = Math.max(byBan.score, byBrut.score * BRUT_NAME_WEIGHT);
  if (nameScore < MIN_ADDRESS_SCORE) return null;

  // BAN sans rapport avec la saisie (géocodage raté, encodage cassé) : seule
  // la saisie du diagnostiqueur décrit l'adresse.
  const reference = byBan.score >= MIN_ADDRESS_SCORE || !brut ? ban : null;
  const recNumber = reference?.number ? reference : brut?.number ? brut : null;
  let relation = "none";
  let numberWeight = 1;
  let numberExact = false;
  if (typed.digits) {
    if (!recNumber) {
      relation = "unknown";
      numberWeight = NUMBER_UNCERTAIN_WEIGHT;
    } else if (recNumber.digits !== typed.digits) {
      relation = "other";
      numberWeight = OTHER_NUMBER_WEIGHT;
    } else {
      relation = "same";
      numberExact = recNumber.numberKey === typed.numberKey;
      if (!numberExact) numberWeight = NUMBER_UNCERTAIN_WEIGHT;
    }
  }

  // Toujours afficher la voie BAN (orthographe de référence), numéro repris
  // de la saisie du diagnostiqueur si la BAN n'en a pas.
  const number =
    recNumber?.number || (relation === "unknown" ? typed.number : null) || null;
  const streetName = reference?.name || brut.name;
  const streetNameKey = normalizeStreetName(streetName);
  return {
    score: nameScore * numberWeight,
    nameScore,
    banScore: byBan.score,
    nameExact: byBan.exact,
    exact: byBan.exact && numberExact,
    relation,
    numberKnown: Boolean(recNumber),
    street: [number, streetName].filter(Boolean).join(" "),
    streetNameKey,
    addressKey: `${recNumber?.numberKey || ""}|${streetNameKey}`,
  };
}

/** Une voie par nom normalisé, avec son meilleur score de nom. */
function streetsOf(matches) {
  const streets = new Map();
  for (const match of matches) {
    const street = streets.get(match.streetNameKey);
    if (!street) {
      streets.set(match.streetNameKey, {
        key: match.streetNameKey,
        score: match.nameScore,
        banScore: match.banScore,
        exact: match.nameExact,
        hasSameNumber: match.relation === "same",
      });
    } else {
      street.score = Math.max(street.score, match.nameScore);
      street.banScore = Math.max(street.banScore, match.banScore);
      street.exact ||= match.nameExact;
      street.hasSameNumber ||= match.relation === "same";
    }
  }
  return [...streets.values()].sort((a, b) => b.score - a.score);
}

function dpeDate(record) {
  return (
    record.date_etablissement_dpe ||
    record.raw?.date_etablissement_dpe ||
    record.date_derniere_modification_dpe ||
    null
  );
}

/**
 * Un même logement re-diagnostiqué apparaît plusieurs fois : on ne garde que
 * le DPE le plus récent (même adresse, surface, étage et complément).
 */
function latestPerDwelling(entries) {
  const byDwelling = new Map();
  for (const entry of entries) {
    const { record, match } = entry;
    const surface = Math.round(Number(record.surface_habitable_logement) || 0);
    const floor = floorFromDpeRaw(record.raw || {});
    const complement = String(record.raw?.complement_adresse_logement || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    const key = `${match.addressKey}|${record.type_batiment}|${surface}|${floor ?? ""}|${complement}`;
    const existing = byDwelling.get(key);
    if (!existing || compareDpeDateDesc(dpeDate(record), dpeDate(existing.record)) > 0) {
      byDwelling.set(key, entry);
    }
  }
  return [...byDwelling.values()];
}

function candidateView(record, match, scored, city) {
  return {
    numeroDpe: record.numero_dpe,
    street: match.street,
    postalCode: record.code_postal_ban || null,
    city: record.nom_commune_ban || city || null,
    addressExact: match.exact,
    addressScore: Math.round(match.score * 100),
    numberUnknown: !match.numberKnown,
    otherNumber: match.relation === "other",
    confidence: scored.confidence,
    matched: scored.matched,
    surface: Number(record.surface_habitable_logement) || null,
    etiquetteDpe: record.etiquette_dpe || null,
    etiquetteGes: record.etiquette_ges || null,
    floor: floorFromDpeRaw(record.raw || {}),
    complement: record.raw?.complement_adresse_logement || null,
    typeBatiment: record.type_batiment || null,
    dateEtablissement: dpeDate(record),
  };
}

/** Critères de l'annonce d'abord, proximité de l'adresse ensuite. */
function rankKey(candidate) {
  return candidate.confidence * 0.6 + candidate.addressScore * 0.4;
}

function byRank(a, b) {
  return (
    rankKey(b) - rankKey(a) ||
    compareDpeDateDesc(b.dateEtablissement, a.dateEtablissement)
  );
}

export default function createAddressDpeLookupService({ repositories, logger } = {}) {
  const repo = repositories.dpe;

  /**
   * @param {object} listing
   * @param {{ street: string, postalCode: string, city?: string }} address
   */
  function lookup(listing, { street, postalCode, city } = {}) {
    const typed = parseStreetLine(street);
    const cp = String(postalCode || "").trim();
    if (!typed.name || !/^\d{5}$/.test(cp)) return { status: "none", candidates: [] };

    // Un même libellé revient des centaines de fois dans un code postal.
    const rows = repo.addressLookupRows({ codePostal: cp });
    const memo = new Map();
    const cache = createCache();
    const matched = [];
    for (const row of rows) {
      const key = `${row.adresse_ban}\u0000${row.adresse_brut}`;
      if (!memo.has(key)) memo.set(key, matchRow(typed, row, cache));
      const match = memo.get(key);
      if (match) matched.push({ row, match });
    }
    const streets = streetsOf(matched.map((m) => m.match));
    if (!streets.length) return { status: "none", candidates: [] };

    // Concurrente : une autre voie BAN proche (avec le même numéro s'il est
    // saisi). Une voie reconnue par la seule saisie brute (BAN mal géocodée ou
    // mal encodée) ne rend pas l'adresse ambiguë et reste candidate.
    const top = streets[0];
    const rival = streets
      .slice(1)
      .find(
        (s) => s.banScore >= RIVAL_ADDRESS_SCORE && (!typed.digits || s.hasSameNumber)
      );
    const addressCertain = top.exact && !rival;
    const keptStreets = new Set(
      (addressCertain
        ? streets.filter((s) => s === top || s.banScore < RIVAL_ADDRESS_SCORE)
        : streets.slice(0, MAX_STREETS)
      ).map((s) => s.key)
    );
    const kept = matched.filter((m) => keptStreets.has(m.match.streetNameKey));

    const criteria = listingDpeSearchCriteria(listing).criteres;
    const expectedTypes = dpeBuildingTypesFor(listing.property_type);
    const matchOf = new Map(kept.map((m) => [m.row.numero_dpe, m.match]));
    const isSameNumber = (m) => m.relation === "same" || m.relation === "unknown";

    const sameNumeros = kept
      .filter((m) => isSameNumber(m.match))
      .map((m) => m.row.numero_dpe)
      .slice(0, MAX_SAME_NUMBER_LOADED);
    const streetNumeros = kept
      .filter((m) => !isSameNumber(m.match))
      .map((m) => m.row.numero_dpe)
      .slice(0, MAX_STREET_LOADED);
    const records = [
      ...repo.findManyByNumero(sameNumeros),
      ...(streetNumeros.length && expectedTypes.length
        ? repo.findAddressCandidates(streetNumeros, {
            typeBatiments: expectedTypes,
            ...(criteria.surfaceM2 != null
              ? {
                  surfaceMin: criteria.surfaceM2 * (1 - SURFACE_MARGIN),
                  surfaceMax: criteria.surfaceM2 * (1 + SURFACE_MARGIN),
                }
              : {}),
          })
        : []),
    ];

    const scoreOf = (record) => {
      const scored = scoreRecord(record, criteria);
      if (expectedTypes.length && !expectedTypes.includes(record.type_batiment)) {
        return { ...scored, confidence: Math.max(0, scored.confidence - TYPE_MISMATCH_PENALTY) };
      }
      return scored;
    };

    const entries = records
      .filter((record) => matchOf.has(record.numero_dpe))
      .map((record) => ({ record, match: matchOf.get(record.numero_dpe) }));
    const candidates = latestPerDwelling(entries)
      .map(({ record, match }) => candidateView(record, match, scoreOf(record), city))
      .sort(byRank);

    const surfaceConfirmed = (c) => criteria.surfaceM2 == null || c.matched?.surface === true;
    const fitsListing = (c) =>
      c.confidence >= OTHER_NUMBER_MIN_CONFIDENCE && surfaceConfirmed(c);

    let status = "choose";
    let reason;
    let pool;
    let winner = null;
    if (typed.digits) {
      const sameCandidates = candidates.filter((c) => !c.otherNumber);
      const [best, second] = sameCandidates;
      const clearWinner =
        Boolean(best) &&
        best.addressExact &&
        best.confidence >= AUTO_MIN_CONFIDENCE &&
        surfaceConfirmed(best) &&
        (!second || best.confidence - second.confidence >= AUTO_MIN_GAP);
      if (addressCertain && clearWinner) {
        status = "match";
        winner = best;
      }
      reason = !addressCertain ? "address" : "dwelling";
      pool = [...sameCandidates, ...candidates.filter((c) => c.otherNumber && fitsListing(c))].sort(
        byRank
      );
    } else {
      reason = addressCertain ? "number" : "address";
      pool = candidates;
    }
    if (!pool.length) status = "none";

    logger?.info?.(
      {
        listingId: listing.id,
        status,
        reason: status === "choose" ? reason : undefined,
        rows: rows.length,
        streets: streets.length,
        candidates: candidates.length,
      },
      "address-dpe/lookup"
    );

    if (status === "none") return { status, candidates: [] };
    if (winner) {
      return {
        status,
        reason: null,
        numeroDpe: winner.numeroDpe,
        street: winner.street,
        candidates: [winner],
      };
    }

    // Le meilleur logement du numéro saisi reste visible, même distancé.
    const bestSame = pool.find((c) => !c.otherNumber);
    const topConfidence = Math.max(...pool.map((c) => c.confidence));
    const proposed = pool.filter(
      (c, i) =>
        i === 0 || c === bestSame || c.confidence >= topConfidence - MAX_CONFIDENCE_DROP
    );
    return {
      status,
      reason,
      numeroDpe: null,
      street: null,
      candidates: proposed.slice(0, MAX_CANDIDATES),
    };
  }

  return { lookup };
}

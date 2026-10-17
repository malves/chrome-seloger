/**
 * Faits structurés de l'analyse photo utiles à la fiche de visite.
 *
 * On ne lit QUE les champs à vocabulaire fermé de l'analyse (anomalies,
 * état de la cuisine et de la salle de bain, vitrage, affirmations de
 * l'annonce contredites) : jamais les textes libres rédigés par le modèle.
 * Les libellés de pièce viennent de `ROOM_LABELS` (room_type), pas du
 * `label` proposé par le modèle.
 *
 * Résultat : une map `clé -> { rooms: string[], claims: string[], count }`
 * où la clé vaut `anomaly:<type>`, `kitchen:<condition>`,
 * `bathroom:<renovation_level>`, `glazing:single_likely` ou
 * `claim:contradicted`.
 */

import { ROOM_LABELS } from "../photo-analysis/labels.js";
import {
  ANOMALY_TYPES,
  KITCHEN_CONDITIONS,
  BATHROOM_RENOVATION_LEVELS,
} from "../photo-analysis/enums.js";

/** Sous ce seuil, une anomalie n'ouvre pas de question (trop incertaine). */
export const PHOTO_FACT_MIN_CONFIDENCE = 0.5;

const MAX_CLAIMS = 3;

/** États de cuisine qui méritent un indice, du moins au plus grave. */
const KITCHEN_SEVERITY = ["partial_renovation_likely", "full_replacement_likely"];
/** Niveaux de rénovation de salle de bain qui méritent un indice. */
const BATHROOM_SEVERITY = ["medium", "medium_to_full", "full"];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function roomLabel(room) {
  if (!room) return null;
  const label = ROOM_LABELS[room.room_type];
  if (!label || room.room_type === "unknown") return null;
  return label.toLowerCase();
}

/** Liste de pièces dédoublonnée, comptée (« 2 chambres »). */
function roomList(labels) {
  const counts = new Map();
  for (const l of labels) {
    if (!l) continue;
    counts.set(l, (counts.get(l) || 0) + 1);
  }
  return [...counts.entries()].map(([label, n]) => (n > 1 ? `${n} ${pluralize(label)}` : label));
}

function pluralize(label) {
  if (/s$/i.test(label) || /^wc$/i.test(label)) return label;
  // « salle de bain » → « salles de bain », « chambre d'enfant » → « chambres d'enfant »
  const parts = label.split(" ");
  parts[0] = `${parts[0]}s`;
  return parts.join(" ");
}

function makeFact() {
  return { rooms: [], claims: [], count: 0 };
}

/**
 * @param {object|null} photoAnalysis view-model (`photoAnalysisViewModel`) ou
 *   résultat brut : on lit `anomalies`, `rooms`, `contradictions` /
 *   `description_contradictions`.
 * @returns {Record<string, { rooms: string[], claims: string[], count: number }>}
 */
export function photoFactsFrom(photoAnalysis) {
  const facts = {};
  if (!photoAnalysis || typeof photoAnalysis !== "object") return facts;
  if (photoAnalysis.ready === false) return facts;

  const rooms = Array.isArray(photoAnalysis.rooms) ? photoAnalysis.rooms : [];
  const roomById = new Map(rooms.map((r) => [r && r.room_id, r]));
  const anomalyLabels = {};

  for (const a of Array.isArray(photoAnalysis.anomalies) ? photoAnalysis.anomalies : []) {
    if (!a || !ANOMALY_TYPES.includes(a.type) || a.type === "other") continue;
    const conf = num(a.confidence);
    if (conf === null || conf < PHOTO_FACT_MIN_CONFIDENCE) continue;
    const key = `anomaly:${a.type}`;
    if (!anomalyLabels[key]) anomalyLabels[key] = [];
    anomalyLabels[key].push(roomLabel(roomById.get(a.room_id)));
  }
  for (const [key, labels] of Object.entries(anomalyLabels)) {
    facts[key] = { ...makeFact(), rooms: roomList(labels), count: labels.length };
  }

  let kitchenWorst = -1;
  const kitchenRooms = [];
  let bathroomWorst = -1;
  const bathroomRooms = [];
  const glazingRooms = [];
  for (const r of rooms) {
    if (!r) continue;
    const k = r.kitchen && r.kitchen.condition;
    if (k && KITCHEN_CONDITIONS.includes(k)) {
      const rank = KITCHEN_SEVERITY.indexOf(k);
      if (rank >= 0) {
        kitchenWorst = Math.max(kitchenWorst, rank);
        kitchenRooms.push(roomLabel(r));
      }
    }
    const b = r.bathroom && r.bathroom.renovation_level;
    if (b && BATHROOM_RENOVATION_LEVELS.includes(b)) {
      const rank = BATHROOM_SEVERITY.indexOf(b);
      if (rank >= 0) {
        bathroomWorst = Math.max(bathroomWorst, rank);
        bathroomRooms.push(roomLabel(r));
      }
    }
    if (r.windows && r.windows.glazing === "single_likely") glazingRooms.push(roomLabel(r));
  }
  if (kitchenWorst >= 0) {
    facts[`kitchen:${KITCHEN_SEVERITY[kitchenWorst]}`] = {
      ...makeFact(),
      rooms: roomList(kitchenRooms),
      count: kitchenRooms.length,
    };
  }
  if (bathroomWorst >= 0) {
    facts[`bathroom:${BATHROOM_SEVERITY[bathroomWorst]}`] = {
      ...makeFact(),
      rooms: roomList(bathroomRooms),
      count: bathroomRooms.length,
    };
  }
  if (glazingRooms.length) {
    facts["glazing:single_likely"] = {
      ...makeFact(),
      rooms: roomList(glazingRooms),
      count: glazingRooms.length,
    };
  }

  const contradictions = Array.isArray(photoAnalysis.contradictions)
    ? photoAnalysis.contradictions
    : Array.isArray(photoAnalysis.description_contradictions)
      ? photoAnalysis.description_contradictions
      : [];
  const claims = [];
  for (const c of contradictions) {
    if (!c || c.status !== "contradicted") continue;
    const claim = typeof c.claim === "string" ? c.claim.trim() : "";
    if (!claim || claims.includes(claim)) continue;
    claims.push(claim);
    if (claims.length >= MAX_CLAIMS) break;
  }
  if (claims.length) {
    facts["claim:contradicted"] = { ...makeFact(), claims, count: claims.length };
  }

  return facts;
}

/** Faits de `facts` correspondant à une liste de clés, fusionnés. */
export function matchingFacts(keys, facts) {
  const out = makeFact();
  if (!Array.isArray(keys) || !facts) return out;
  for (const key of keys) {
    const f = facts[key];
    if (!f) continue;
    for (const r of f.rooms) if (!out.rooms.includes(r)) out.rooms.push(r);
    for (const c of f.claims) if (!out.claims.includes(c)) out.claims.push(c);
    out.count += f.count;
  }
  return out;
}

function joinFr(list) {
  if (list.length <= 1) return list.join("");
  return `${list.slice(0, -1).join(", ")} et ${list[list.length - 1]}`;
}

/**
 * Remplace `{rooms}` et `{claims}` dans un gabarit. Les parenthèses qui
 * entourent un slot vide disparaissent (« … possibles ({rooms}). » → « … possibles. »).
 */
export function fillTemplate(template, fact) {
  if (typeof template !== "string" || !template) return template || "";
  const rooms = fact && fact.rooms && fact.rooms.length ? joinFr(fact.rooms) : "";
  const claims =
    fact && fact.claims && fact.claims.length ? joinFr(fact.claims.map((c) => `« ${c} »`)) : "";
  return template
    .replace(/\s*\(\{rooms\}\)/g, rooms ? ` (${rooms})` : "")
    .replace(/\s*\(\{claims\}\)/g, claims ? ` (${claims})` : "")
    .replace(/\{rooms\}/g, rooms)
    .replace(/\{claims\}/g, claims)
    .replace(/\s{2,}/g, " ")
    .trim();
}

export default photoFactsFrom;

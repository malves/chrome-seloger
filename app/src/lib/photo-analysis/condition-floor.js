/**
 * Planchers d'état : l'état d'une surface, d'une pièce ou du logement ne peut
 * pas être meilleur que ce que montrent les fiches par image et les anomalies
 * relevées. Ces règles ne font que dégrader, jamais améliorer, et chaque
 * ajustement est tracé (`{ scope, from, to, reason }`).
 *
 * Elles s'appliquent à la sortie brute de l'analyse. L'état des pièces du plan
 * (aligné sur les points à refaire, pièce « à préciser ») relève uniquement de
 * works-coherence.js.
 */

import { EXTERIOR_ROOM_TYPES } from "./enums.js";

const SURFACE_RANK = ["good", "dated", "worn", "damaged", "replacement_likely"];
const BROKEN_SURFACES = new Set(["damaged", "replacement_likely"]);
const SURFACES = ["floor", "walls", "ceiling"];

const ROOM_RANK = [
  "new_or_recently_renovated",
  "very_good",
  "good",
  "average",
  "dated",
  "refresh_needed",
  "renovation_needed",
  "heavy_renovation_likely",
];

const GLOBAL_RANK = [
  "very_good",
  "good",
  "average",
  "dated",
  "poor",
  "renovation_needed",
  "heavy_renovation_likely",
];

const RENOVATION_RANK = [
  "none",
  "light_refresh",
  "moderate_renovation",
  "significant_renovation",
  "heavy_renovation_possible",
];

/** Défauts par image qui imposent un état minimal à une surface. */
const DEFECT_SURFACE = { damaged_floor: "floor", ceiling_damage: "ceiling" };

const SEVERE_ANOMALIES = new Set([
  "possible_mold",
  "possible_water_damage",
  "possible_humidity",
  "damaged_floor",
  "ceiling_damage",
]);
const MOISTURE_ANOMALIES = new Set(["possible_mold", "possible_water_damage", "possible_humidity"]);

/** Indices textuels ou défauts muraux : sol décollé / inondation / humidité. */
const FLOOR_CATASTROPHIC_RE =
  /décoll|soulev|gondol|bouff|lifted|buckl|warp|inond|dégât.{0,12}eau|humid|moisiss/i;
const WALL_HUMIDITY_DEFECTS = new Set(["stains", "damp_marks", "blisters", "peeling_paint", "mold"]);

export const ANOMALY_MIN_CONFIDENCE = 0.5;
export const RENOVATION_SCORE_CAP = 40;
export const HEAVY_RENOVATION_SCORE_CAP = 25;

/** Rang d'une valeur ; -1 pour une valeur hors échelle (`unknown`, `not_assessable`…). */
const rank = (scale, value) => scale.indexOf(value);
const worse = (scale, a, b) => (rank(scale, b) > rank(scale, a) ? b : a);

function severeAnomaly(a) {
  return (
    SEVERE_ANOMALIES.has(a?.type) &&
    a.severity !== "low" &&
    (a.confidence ?? 0) >= ANOMALY_MIN_CONFIDENCE
  );
}

function anomaliesOfRoom(room, anomalies) {
  const images = new Set(room.image_ids || []);
  return (anomalies || []).filter(
    (a) => a?.room_id === room.room_id || (!a?.room_id && (a?.image_ids || []).some((id) => images.has(id)))
  );
}

function defectText(record) {
  return (record.observations?.possible_defects || [])
    .map((d) => d?.observation || "")
    .join(" ");
}

/** Condition d'une surface sur une fiche image, avec heuristiques si le modèle a sous-noté. */
function observedSurfaceCondition(record, surface) {
  const obs = record.observations?.[surface];
  if (!obs?.condition) return null;
  let cond = obs.condition;
  const notes = `${obs.notes || ""} ${defectText(record)}`;

  if (surface === "floor") {
    if (rank(SURFACE_RANK, cond) >= rank(SURFACE_RANK, "worn") && FLOOR_CATASTROPHIC_RE.test(notes)) {
      cond = worse(SURFACE_RANK, cond, "replacement_likely");
    }
    for (const defect of record.observations?.possible_defects || []) {
      if (defect?.type !== "damaged_floor" && defect?.type !== "possible_water_damage") continue;
      if (defect.severity === "low") continue;
      const min = defect.severity === "high" ? "replacement_likely" : "damaged";
      cond = worse(SURFACE_RANK, cond, min);
    }
  }

  if (surface === "walls") {
    const defects = obs.defects || [];
    const floorCond = observedSurfaceCondition(record, "floor");
    const floorBad =
      rank(SURFACE_RANK, floorCond) >= rank(SURFACE_RANK, "damaged") ||
      rank(SURFACE_RANK, record.observations?.floor?.condition) >= rank(SURFACE_RANK, "damaged");
    if (
      floorBad &&
      (defects.some((d) => WALL_HUMIDITY_DEFECTS.has(d)) ||
        (record.observations?.possible_defects || []).some((d) =>
          ["possible_humidity", "possible_mold", "possible_water_damage"].includes(d?.type)
        ))
    ) {
      cond = worse(SURFACE_RANK, cond, "damaged");
    }
  }

  return cond;
}

/**
 * Sol, murs, plafond : la pire condition entre la synthèse et les fiches des
 * images de la pièce ; un défaut « sol abîmé » (sévérité >= medium) impose au
 * moins « damaged ».
 * @param {object} room - pièce de la synthèse
 * @param {Map<string, object>} recordsById - fiches de la passe A
 * @returns {{ room: object, adjustments: object[] }}
 */
export function escalateRoomSurfaces(room, recordsById) {
  const records = (room.image_ids || [])
    .map((id) => recordsById.get(id))
    .filter((r) => r?.usable_for_condition_analysis);
  const next = { ...room };
  const adjustments = [];

  for (const surface of SURFACES) {
    const current = room[surface]?.condition ?? "unknown";
    let target = current;
    let source = null;
    for (const record of records) {
      const observed = observedSurfaceCondition(record, surface);
      if (rank(SURFACE_RANK, observed) > rank(SURFACE_RANK, target)) {
        target = observed;
        source = record.id;
      }
      for (const defect of record.observations?.possible_defects || []) {
        if (DEFECT_SURFACE[defect?.type] !== surface || defect.severity === "low") continue;
        const min = defect.severity === "high" ? "replacement_likely" : "damaged";
        if (rank(SURFACE_RANK, min) > rank(SURFACE_RANK, target)) {
          target = min;
          source = record.id;
        }
      }
    }
    if (target === current) continue;
    next[surface] = room[surface]
      ? { ...room[surface], condition: target }
      : { condition: target, confidence: 0.5 };
    if (surface === "floor" && !room.floor) {
      next.floor = {
        material: recordsById.get(source)?.observations?.floor?.material || "unknown",
        apparent_age: "unknown",
        potential_work: null,
        ...next.floor,
      };
    }
    adjustments.push({
      scope: `${room.room_id}.${surface}`,
      from: current,
      to: target,
      reason: `Fiche image ${source}`,
    });
  }
  return { room: next, adjustments };
}

/**
 * État minimal d'une pièce d'après ses surfaces dégradées et ses anomalies
 * sévères.
 * @returns {{ room: object, adjustment: object|null }}
 */
export function floorRoomCondition(room, anomalies) {
  const broken = SURFACES.filter((s) => BROKEN_SURFACES.has(room[s]?.condition)).length;
  const severe = anomaliesOfRoom(room, anomalies).filter(severeAnomaly).length;
  const floorReplace = room.floor?.condition === "replacement_likely";
  let min = null;
  if (floorReplace || broken >= 2 || (broken >= 1 && severe >= 1)) min = "heavy_renovation_likely";
  else if (broken >= 1 || severe >= 1) min = "renovation_needed";
  if (!min || rank(ROOM_RANK, room.condition) >= rank(ROOM_RANK, min)) {
    return { room, adjustment: null };
  }
  return {
    room: { ...room, condition: min },
    adjustment: {
      scope: `${room.room_id}.condition`,
      from: room.condition,
      to: min,
      reason: `${broken} surface(s) dégradée(s), ${severe} anomalie(s) sévère(s)`,
    },
  };
}

/**
 * État global minimal : majorité de pièces intérieures à rénover, ou
 * humidité / moisissure de sévérité élevée.
 * @param {{ score: number|null, label: string, confidence: number }} condition
 * @param {{ level: string }} renovation
 * @returns {{ condition: object, renovation: object, adjustments: object[] }}
 */
export function floorGlobalCondition(condition, renovation, rooms, anomalies) {
  const interior = (rooms || []).filter((r) => !EXTERIOR_ROOM_TYPES.has(r.room_type));
  const atLeast = (min) => interior.filter((r) => rank(ROOM_RANK, r.condition) >= rank(ROOM_RANK, min)).length;
  const heavy = atLeast("heavy_renovation_likely");
  const toRenovate = atLeast("renovation_needed");
  const moisture = (anomalies || []).some(
    (a) => MOISTURE_ANOMALIES.has(a?.type) && a.severity === "high" && (a.confidence ?? 0) >= ANOMALY_MIN_CONFIDENCE
  );

  let label = null;
  let cap = null;
  let level = null;
  let reason = null;
  if (heavy > 0 && heavy * 2 >= interior.length) {
    label = "heavy_renovation_likely";
    cap = HEAVY_RENOVATION_SCORE_CAP;
    level = "heavy_renovation_possible";
    reason = `${heavy}/${interior.length} pièce(s) en rénovation lourde probable`;
  } else if ((toRenovate > 0 && toRenovate * 2 >= interior.length) || moisture) {
    label = "renovation_needed";
    cap = RENOVATION_SCORE_CAP;
    level = "significant_renovation";
    reason = moisture
      ? "Humidité ou moisissure de sévérité élevée"
      : `${toRenovate}/${interior.length} pièce(s) à rénover`;
  }
  if (!label) return { condition, renovation, adjustments: [] };

  const adjustments = [];
  const nextCondition = { ...condition };
  const nextLabel = worse(GLOBAL_RANK, condition.label, label);
  if (nextLabel !== condition.label) {
    nextCondition.label = nextLabel;
    adjustments.push({ scope: "overall.label", from: condition.label, to: nextLabel, reason });
  }
  if (typeof condition.score === "number" && condition.score > cap) {
    nextCondition.score = cap;
    adjustments.push({ scope: "overall.score", from: condition.score, to: cap, reason });
  }
  const nextRenovation = { ...renovation };
  const nextLevel = worse(RENOVATION_RANK, renovation.level, level);
  if (nextLevel !== renovation.level) {
    nextRenovation.level = nextLevel;
    adjustments.push({ scope: "renovation.level", from: renovation.level, to: nextLevel, reason });
  }
  return { condition: nextCondition, renovation: nextRenovation, adjustments };
}

/**
 * Applique les trois planchers dans l'ordre : surfaces, pièces, global.
 * @returns {{ rooms: object[], condition: object, renovation: object, adjustments: object[] }}
 */
export function applyConditionFloors({ rooms, recordsById, anomalies, condition, renovation }) {
  const adjustments = [];
  const floored = (rooms || []).map((raw) => {
    const escalated = escalateRoomSurfaces(raw, recordsById);
    adjustments.push(...escalated.adjustments);
    const { room, adjustment } = floorRoomCondition(escalated.room, anomalies);
    if (adjustment) adjustments.push(adjustment);
    return room;
  });
  const global = floorGlobalCondition(condition, renovation, floored, anomalies);
  adjustments.push(...global.adjustments);
  return {
    rooms: floored,
    condition: global.condition,
    renovation: global.renovation,
    adjustments,
  };
}

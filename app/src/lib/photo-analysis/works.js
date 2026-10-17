/**
 * Travaux potentiels : post-traitements déterministes de la synthèse.
 *
 *  - les travaux hors logement sont retirés de la liste et renvoyés vers les
 *    points à vérifier en copropriété. Pour un appartement : parties communes
 *    ET bâti (façade, toiture…). Pour une maison, le bâti et les extérieurs
 *    sont à la charge de l'acheteur : seules les parties communes sont retirées ;
 *  - les photos exploitables que la synthèse n'a rattachées ni à une pièce ni
 *    à un travail produisent des travaux de repli, déduits de leur fiche par
 *    image (une chambre non reconnue reste une pièce à travaux possibles).
 */

import { EXTERIOR_ROOM_TYPES } from "./enums.js";
import { WORK_TYPE_LABELS } from "./labels.js";

/** Travaux hors périmètre « chantier » (info déjà portée par `rooms[].storage` ou vigilances). */
export const EXCLUDED_POTENTIAL_WORK_TYPES = new Set(["storage_creation"]);

const STORAGE_WORK_TEXT = /création de rangements|rangements à créer/i;

export function filterPotentialWorks(works) {
  return (works || []).filter((w) => {
    if (!w) return false;
    if (EXCLUDED_POTENTIAL_WORK_TYPES.has(w.work_type)) return false;
    const text = [w.label, w.rationale].filter(Boolean).join(" ");
    if (STORAGE_WORK_TEXT.test(text)) return false;
    return true;
  });
}

/** Maison : façade, toiture, jardin et extérieurs relèvent de l'acheteur. */
export function ownsBuildingExterior(propertyType) {
  return propertyType === "house";
}

/**
 * Une image peut-elle servir de preuve à un travail ? Les photos intérieures
 * exploitables toujours ; les photos du bâti extérieur seulement pour une maison.
 */
export function usableForWorks(record, propertyType) {
  if (!record) return false;
  if (record.usable_for_condition_analysis) return true;
  return (
    ownsBuildingExterior(propertyType) &&
    record.exterior_kind === "building" &&
    record.analysis_reliability !== "low"
  );
}

/** Mentions d'immeuble sans ambiguïté, cherchées dans le libellé et la justification. */
const COMMON_AREA_TEXT =
  /parties?\s+communes?|cage\s+d['’]\s*escaliers?|escaliers?\s+(?:communs?|de\s+l['’]\s*immeuble|d['’]\s*immeuble)|hall\s+(?:d['’]\s*entrée\s+)?(?:de\s+l['’]\s*|d['’]\s*)immeuble|ascenseur|local\s+(?:vélos?|poubelles?)/i;

/**
 * Maison : escalier, couloir et hall sont ceux du logement. Seules les
 * mentions explicites d'immeuble ou de copropriété désignent du commun.
 */
const HOUSE_COMMON_TEXT =
  /parties?\s+communes?|copropri[ée]t[ée]|(?:de\s+l['’]\s*|d['’]\s*)immeuble|ascenseur|(?:escaliers?|couloirs?|hall|paliers?|cour)\s+communs?e?s?\b/i;

/** Mentions d'enveloppe du bâtiment, cherchées dans le libellé seulement. */
const BUILDING_LABEL_TEXT = /fa[cç]ade|ravalement|toiture|couverture\s+du\s+toit|copropri[ée]t[ée]/i;

/**
 * Un travail concerne-t-il l'immeuble plutôt que le logement ?
 * @param {object} work - travail normalisé (avant traçabilité)
 * @param {Map<string, object>} recordsById - fiches par image
 * @param {Map<string, string>} roomTypeById - `room_id` → `room_type` de la synthèse
 * @param {string|null} propertyType - `house`, `apartment`…
 */
export function isCommonAreaWork(work, recordsById, roomTypeById, propertyType = null) {
  const house = ownsBuildingExterior(propertyType);
  if (work.area === "common") return true;
  // Maison : toutes les pièces de la synthèse appartiennent au logement.
  if (!house && work.room_id && EXTERIOR_ROOM_TYPES.has(roomTypeById.get(work.room_id))) return true;
  const evidence = (work.image_ids || []).map((id) => recordsById.get(id)).filter(Boolean);
  const outside = (r) => (house ? r.exterior_kind === "common" : r.exterior_kind != null);
  if (evidence.length && evidence.every(outside)) return true;
  const text = `${work.label || ""} ${work.rationale || ""}`;
  if (house) return HOUSE_COMMON_TEXT.test(text);
  if (COMMON_AREA_TEXT.test(text)) return true;
  return BUILDING_LABEL_TEXT.test(work.label || "");
}

/**
 * Sépare les travaux du logement de ceux de l'immeuble.
 * @returns {{ works: object[], commonAreaWorks: object[] }}
 */
export function splitCommonAreaWorks(works, records, rooms, propertyType = null) {
  const recordsById = new Map((records || []).map((r) => [r.id, r]));
  const roomTypeById = new Map((rooms || []).map((r) => [r.room_id, r.room_type]));
  const kept = [];
  const common = [];
  for (const work of works || []) {
    (isCommonAreaWork(work, recordsById, roomTypeById, propertyType) ? common : kept).push(work);
  }
  return { works: kept, commonAreaWorks: common };
}

const ELECTRICAL_ITEMS = new Set(["old_sockets", "old_switches", "exposed_wiring"]);
const HUMIDITY_DEFECTS = new Set(["possible_humidity", "possible_water_damage", "possible_mold"]);

/**
 * Travaux plausibles d'après la fiche d'une image (passe A). Volontairement
 * prudents : nécessité « possible » au mieux, une seule photo sans contexte.
 * @returns {{ work_type: string, category: string, scope: string, reason: string, confidence: number }[]}
 */
export function worksFromObservations(observations) {
  const o = observations || {};
  const out = [];
  const add = (work_type, category, scope, reason, confidence) =>
    out.push({ work_type, category, scope, reason, confidence: confidence ?? 0.5 });

  const floor = o.floor;
  if (floor && ["damaged", "replacement_likely"].includes(floor.condition)) {
    add("floor_replacement", "cosmetic", "partial", "sol abîmé ou à remplacer", floor.confidence);
  } else if (floor && floor.condition === "worn" && /parquet/.test(floor.material || "")) {
    add("floor_sanding", "cosmetic", "partial", "parquet usé", floor.confidence);
  }

  const walls = o.walls;
  if (walls && ["damaged", "worn", "dated"].includes(walls.condition)) {
    add("painting", "cosmetic", walls.condition === "damaged" ? "medium" : "light", "murs défraîchis ou abîmés", walls.confidence);
  }
  if ((walls?.defects || []).includes("cracks")) {
    add("crack_investigation", "necessary", "unknown", "fissure visible sur un mur", walls.confidence);
  }

  const ceiling = o.ceiling;
  const ceilingDefects = ceiling?.defects || [];
  if (
    ceiling &&
    (["damaged", "replacement_likely"].includes(ceiling.condition) ||
      ceilingDefects.some((d) => ["cracks", "possible_water_damage", "sagging"].includes(d)))
  ) {
    add("ceiling_repair", "necessary", "partial", "plafond dégradé", ceiling.confidence);
  }

  const windows = o.windows;
  if (
    windows &&
    (windows.apparent_age === "very_dated" ||
      windows.glazing === "single_likely" ||
      ["damaged", "replacement_likely"].includes(windows.frame_condition))
  ) {
    add("window_replacement", "comfort", "partial", "menuiseries anciennes", windows.confidence);
  }

  const heating = o.heating;
  if (heating && heating.apparent_age === "very_dated" && !["none_visible", "unknown"].includes(heating.equipment)) {
    add("radiator_replacement", "comfort", "partial", "émetteurs de chauffage anciens", heating.confidence);
  }

  const electrical = o.electrical;
  if (electrical && (electrical.visible_items || []).some((i) => ELECTRICAL_ITEMS.has(i))) {
    add("visible_electrical_modernization", "necessary", "partial", "appareillage électrique ancien visible", electrical.confidence);
  }

  const kitchen = o.kitchen;
  if (kitchen?.condition === "full_replacement_likely") {
    add("kitchen_replacement", "necessary", "full", "cuisine à remplacer", kitchen.confidence);
  } else if (kitchen?.condition === "partial_renovation_likely") {
    add("kitchen_refresh", "cosmetic", "partial", "cuisine à rafraîchir", kitchen.confidence);
  }

  const bathroom = o.bathroom;
  if (bathroom && ["medium", "medium_to_full", "full"].includes(bathroom.renovation_level)) {
    add("bathroom_full_renovation", "necessary", bathroom.renovation_level, "salle d'eau à rénover", bathroom.confidence);
  } else if (bathroom?.renovation_level === "light") {
    add("bathroom_refresh", "cosmetic", "light", "salle d'eau à rafraîchir", bathroom.confidence);
  }

  const exterior = o.exterior;
  if (exterior && ["dated", "poor"].includes(exterior.condition)) {
    if (["facade", "building_entrance"].includes(exterior.subject)) {
      add(
        "facade_renovation",
        exterior.condition === "poor" ? "necessary" : "cosmetic",
        "unknown",
        "façade datée ou dégradée",
        exterior.confidence
      );
    } else if (["garden", "terrace", "balcony", "courtyard"].includes(exterior.subject)) {
      add("exterior_refresh", "cosmetic", "partial", "extérieurs à remettre en état", exterior.confidence);
    }
  }

  for (const defect of o.possible_defects || []) {
    if (HUMIDITY_DEFECTS.has(defect.type)) {
      add("humidity_investigation", "necessary", "unknown", "trace d'humidité possible", defect.confidence);
    } else if (defect.type === "crack") {
      add("crack_investigation", "necessary", "unknown", "fissure visible", defect.confidence);
    }
  }
  return out;
}

/** Une photo de repli ne vaut pas une pièce identifiée : confiance réduite. */
const FALLBACK_CONFIDENCE_FACTOR = 0.8;

/**
 * Travaux de repli pour les photos exploitables oubliées par la synthèse :
 * ni dans une pièce logique, ni citées par un travail. Un travail par type,
 * regroupant toutes les photos concernées.
 *
 * @param {object[]} records - fiches par image
 * @param {Set<string>} assigned - images rattachées à une pièce
 * @param {object[]} works - travaux déjà retenus (après filtrage immeuble)
 * @param {string|null} propertyType - les photos extérieures ne comptent que pour une maison
 * @returns {object[]} travaux au format de la synthèse, `source: "unassigned_photo"`
 */
export function worksForUnassignedPhotos(records, assigned, works, propertyType = null) {
  const cited = new Set((works || []).flatMap((w) => w.image_ids || []));
  const byType = new Map();
  for (const record of records || []) {
    if (!usableForWorks(record, propertyType)) continue;
    if (cited.has(record.id)) continue;
    // Les extérieurs d'une maison sont décrits à part (bloc extérieur), sans pièce ni travaux.
    if (!record.exterior_kind && assigned.has(record.id)) continue;
    for (const w of worksFromObservations(record.observations)) {
      const key = `${record.exterior_kind ? "outdoor" : "indoor"}:${w.work_type}`;
      const entry = byType.get(key) || {
        ...w,
        image_ids: [],
        reasons: new Set(),
        outdoor: Boolean(record.exterior_kind),
      };
      entry.image_ids.push(record.id);
      entry.reasons.add(w.reason);
      entry.confidence = Math.max(entry.confidence, w.confidence);
      byType.set(key, entry);
    }
  }

  const offset = (works || []).length;
  return [...byType.values()].map((w, i) => ({
    work_id: `work_${String(offset + i + 1).padStart(2, "0")}`,
    work_type: w.work_type,
    label: `${WORK_TYPE_LABELS[w.work_type] || w.work_type} (${w.outdoor ? "extérieur" : "pièce non identifiée"})`,
    room_id: null,
    necessity: "possible",
    scope: w.scope,
    category: w.category,
    area: "private",
    outdoor: w.outdoor,
    quantity: null,
    confidence: Math.round(w.confidence * FALLBACK_CONFIDENCE_FACTOR * 100) / 100,
    image_ids: w.image_ids,
    rationale: w.outdoor
      ? `Extérieur à la charge de l'acheteur (maison) : ${[...w.reasons].join(", ")}.`
      : `Photo${w.image_ids.length > 1 ? "s" : ""} non rattachée${w.image_ids.length > 1 ? "s" : ""} à une pièce : ${[...w.reasons].join(", ")}.`,
    source: "unassigned_photo",
  }));
}

/**
 * Points à refaire d'une pièce proposés par l'IA : fusion de toutes les
 * sorties de l'analyse qui parlent de cette pièce, avec pour chaque point la
 * raison la plus parlante. Aucun point n'est déduit du seul état général :
 * une pièce jugée « Moyen » ou pire sans aucun point est signalée à préciser.
 */

import { WORK_TYPE_LABELS } from "../photo-analysis/labels.js";
import { worksFromObservations } from "../photo-analysis/works.js";
import { LEGACY_ROOM_TO_GLOBAL, globalItemsFromRoomIssues } from "./works-global.js";
import { canonicalIssue, cleanIssues, issueAppliesTo } from "./works-issues.js";

export { reconcileRoomCondition, roomNeedsReview } from "./works-coherence.js";

/**
 * Type de travail (analyse) → points à refaire de la pièce. `[]` : hors pièce.
 * `windows`, `heating`, `electricity` et `joinery` deviennent des chantiers
 * « Logement entier » (`LEGACY_ROOM_TO_GLOBAL`).
 */
export const WORK_TYPE_TO_ISSUES = {
  painting: ["paint"],
  wallpaper_removal: ["paint"],
  floor_replacement: ["floor_redo"],
  floor_sanding: ["floor_worn"],
  kitchen_refresh: ["kitchen_refresh"],
  kitchen_replacement: ["kitchen_redo"],
  bathroom_refresh: ["bathroom_refresh"],
  bathroom_full_renovation: ["bathroom_redo"],
  toilet_renovation: ["bathroom_redo"],
  window_replacement: ["windows"],
  radiator_replacement: ["heating"],
  visible_electrical_modernization: ["electricity"],
  ceiling_repair: ["ceiling_damaged"],
  humidity_investigation: ["humidity"],
  crack_investigation: ["walls_damaged"],
  general_refresh: ["paint", "ceiling_paint"],
  facade_renovation: [],
  roof_repair: [],
  exterior_refresh: [],
  other: [],
};

const RETAINED_NECESSITIES = new Set(["possible", "likely", "very_likely"]);

const WORN = ["worn", "dated"];
const BROKEN = ["damaged", "replacement_likely"];
const SURFACE_STATE = {
  singular: { worn: "usé", dated: "daté", damaged: "abîmé", replacement_likely: "à remplacer" },
  plural: { worn: "usés", dated: "datés", damaged: "abîmés", replacement_likely: "à remplacer" },
};
const SURFACE_NAMES = { floor: "Sol", walls: "Murs", ceiling: "Plafond" };
const SURFACE_ISSUES = {
  floor: { worn: "floor_worn", broken: "floor_redo" },
  walls: { worn: "paint", broken: "walls_damaged" },
  ceiling: { worn: "ceiling_paint", broken: "ceiling_damaged" },
};

const ANOMALY_ISSUES = {
  possible_humidity: "humidity",
  possible_water_damage: "humidity",
  possible_mold: "mold",
  crack: "walls_damaged",
  ceiling_damage: "ceiling_damaged",
  peeling_paint: "paint",
  damaged_floor: "floor_redo",
  damaged_joinery: "joinery",
  visible_wiring: "electricity",
};

function sentence(text) {
  const t = String(text || "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  return t.charAt(0).toUpperCase() + t.slice(1).replace(/[.\s]+$/, "");
}

function surfaceIssues(raw, add) {
  for (const surface of ["floor", "walls", "ceiling"]) {
    const s = raw[surface];
    if (!s?.condition) continue;
    const kind = WORN.includes(s.condition) ? "worn" : BROKEN.includes(s.condition) ? "broken" : null;
    if (!kind) continue;
    const note = sentence(surface === "floor" ? s.potential_work : s.notes);
    add(
      SURFACE_ISSUES[surface][kind],
      `${SURFACE_NAMES[surface]} ${SURFACE_STATE[surface === "walls" ? "plural" : "singular"][s.condition]}${note ? ` : ${note.charAt(0).toLowerCase()}${note.slice(1)}` : ""}`
    );
  }
  if (BROKEN.includes(raw.floor?.condition) && (BROKEN.includes(raw.walls?.condition) || raw.floor?.condition === "replacement_likely")) {
    add("humidity", "Sol et murs dégradés : humidité possible, à vérifier en visite");
  }
}

function blockIssues(raw, add) {
  const b = raw.bathroom;
  if (b?.renovation_level === "light") add("bathroom_refresh", sentence(b.notes) || "Salle d'eau à rafraîchir");
  if (["medium", "medium_to_full", "full"].includes(b?.renovation_level)) {
    add("bathroom_redo", sentence(b.notes) || "Salle d'eau à rénover");
  }
  const k = raw.kitchen;
  if (k?.condition === "partial_renovation_likely") add("kitchen_refresh", sentence(k.notes) || "Cuisine à rafraîchir");
  if (k?.condition === "full_replacement_likely") add("kitchen_redo", sentence(k.notes) || "Cuisine à remplacer");
  if (raw.windows?.replacement_may_be_relevant) add("windows", "Fenêtres anciennes : remplacement à envisager");
  if (raw.heating?.modernization_may_be_relevant) add("heating", "Chauffage ancien : modernisation à envisager");
}

/**
 * @param {object} raw - pièce de la synthèse (`stored.rooms[]`)
 * @param {object} stored - analyse complète (`potential_works`, `anomalies`, `images`)
 * @param {string} roomType - type retenu pour la pièce du plan
 * @returns {{ issues: string[], reasons: Record<string, string>, global: Record<string, string> }}
 *   `global` : points du logement entier relevés dans la pièce, avec leur raison
 */
export function roomIssuesFromAnalysis(raw, stored, roomType) {
  const reasons = {};
  const keys = [];
  const global = {};
  const add = (rawKey, reason) => {
    const key = canonicalIssue(rawKey);
    if (LEGACY_ROOM_TO_GLOBAL[key]) {
      if (!(key in global)) global[key] = "";
      if (!global[key] && reason) global[key] = sentence(reason).slice(0, 160);
      return;
    }
    if (!issueAppliesTo(key, roomType)) return;
    if (!keys.includes(key)) keys.push(key);
    if (!reasons[key] && reason) reasons[key] = sentence(reason).slice(0, 160);
  };

  for (const key of raw.issues || []) add(key, raw.issue_reasons?.[key]);

  for (const work of stored?.potential_works || []) {
    if (!work || work.room_id !== raw.room_id) continue;
    if (!RETAINED_NECESSITIES.has(work.necessity)) continue;
    for (const key of WORK_TYPE_TO_ISSUES[work.work_type] || []) add(key, work.rationale || work.label);
  }

  blockIssues(raw, add);
  surfaceIssues(raw, add);

  for (const a of stored?.anomalies || []) {
    if (a?.room_id !== raw.room_id) continue;
    const key = ANOMALY_ISSUES[a.type];
    if (key) add(key, a.observation);
  }

  const roomImages = new Set(raw.image_ids || []);
  for (const image of stored?.images || []) {
    if (!roomImages.has(image.id) || !image.usable_for_condition_analysis) continue;
    if ((image.observations?.walls?.defects || []).includes("damp_marks")) {
      add("walls_damaged", "Photo : traces d'humidité marquées sur un mur");
    }
    for (const w of worksFromObservations(image.observations)) {
      for (const key of WORK_TYPE_TO_ISSUES[w.work_type] || []) add(key, `Photo : ${w.reason}`);
    }
  }

  const issues = cleanIssues(keys, roomType);
  const kept = {};
  for (const key of issues) if (reasons[key]) kept[key] = reasons[key];
  return { issues, reasons: kept, global };
}

const DIAGNOSTICS_ASBESTOS_BEFORE = 1997;
const DIAGNOSTICS_LEAD_BEFORE = 1949;

function heatingVariantFrom(stored) {
  const equipments = new Set();
  for (const room of stored?.rooms || []) if (room?.heating?.equipment) equipments.add(room.heating.equipment);
  for (const image of stored?.images || []) {
    const e = image?.observations?.heating?.equipment;
    if (e) equipments.add(e);
  }
  return equipments.has("water_radiator") ? "boiler" : "radiators";
}

/**
 * Chantiers « Logement entier » proposés par l'IA :
 * - électricité, fenêtres, chauffage relevés dans les pièces ou sur des photos non classées ;
 * - diagnostics amiante / plomb d'après l'année de construction ;
 * - préparation et imprévus dès qu'il y a des travaux.
 * @param {object|null} stored - analyse des photos
 * @param {object|null} listing
 * @param {{ roomId: string, key: string, reason: string }[]} roomSignals - `roomIssuesFromAnalysis(...).global` par pièce
 * @param {object[]} rooms - pièces du plan proposé
 */
export function seedGlobalWorks(stored, listing, roomSignals = [], rooms = []) {
  const entries = roomSignals.map((s) => ({ ...s, ai: true }));
  const roomIds = new Set((stored?.rooms || []).map((r) => r.room_id));
  for (const work of stored?.potential_works || []) {
    if (!work || (work.room_id && roomIds.has(work.room_id))) continue;
    if (work.necessity && !RETAINED_NECESSITIES.has(work.necessity)) continue;
    for (const key of WORK_TYPE_TO_ISSUES[work.work_type] || []) {
      if (LEGACY_ROOM_TO_GLOBAL[key]) {
        entries.push({ roomId: null, key, reason: sentence(work.rationale || work.label).slice(0, 160), ai: true });
      }
    }
  }
  const items = globalItemsFromRoomIssues(entries, rooms, { mode: "seed", heatingVariant: heatingVariantFrom(stored) });

  const anyWork = items.length > 0 || rooms.some((r) => (r.issues || []).length);
  if (!anyWork) return items;

  const year = Number(listing?.year_built);
  if (Number.isFinite(year) && year > 1800 && year < DIAGNOSTICS_ASBESTOS_BEFORE) {
    items.push({
      key: "diagnostics",
      enabled: true,
      variant: "standard",
      quantity: null,
      source: "ai",
      reason:
        year < DIAGNOSTICS_LEAD_BEFORE
          ? `Construit en ${year} : repérages amiante et plomb obligatoires avant travaux`
          : `Construit en ${year} : repérage amiante obligatoire avant travaux`,
    });
  }
  items.push(
    { key: "preparation", enabled: true, variant: "standard", quantity: null, source: "ai", reason: "Des travaux sont prévus : protections et évacuation des gravats" },
    { key: "contingency", enabled: true, variant: "standard", quantity: null, source: "ai", reason: "Des travaux sont prévus : provision pour les imprévus de chantier" }
  );
  return items;
}

const EXTERIOR_WORK_TYPES = new Set(["facade_renovation", "roof_repair", "exterior_refresh"]);

/**
 * Travaux que l'analyse n'a rattachés à aucune pièce (photos non classées,
 * extérieurs d'une maison). Ils sont situés par rapport au plan avec
 * `placeUnplacedWorks` (works-coherence.js) pour n'être jamais perdus.
 * @param {object|null} stored - analyse des photos
 * @param {string[]} photos - URLs de la galerie
 */
export function unplacedWorkSources(stored, photos = []) {
  if (!stored?.ready || stored.status !== "ok") return [];
  const roomIds = new Set((stored.rooms || []).map((r) => r.room_id));
  const gallery = new Set(photos);
  const urlById = new Map();
  for (const image of stored.images || []) {
    const url = gallery.has(image.url) ? image.url : photos[image.order - 1] || image.url;
    if (url) urlById.set(image.id, url);
  }
  const out = [];
  for (const work of stored.potential_works || []) {
    if (!work || (work.room_id && roomIds.has(work.room_id))) continue;
    if (work.necessity && !RETAINED_NECESSITIES.has(work.necessity)) continue;
    const urls = (work.image_ids || []).map((id) => urlById.get(id)).filter(Boolean);
    const exterior =
      EXTERIOR_WORK_TYPES.has(work.work_type) || work.outdoor === true || /\(extérieur\)/.test(work.label || "");
    const label = String(work.label || WORK_TYPE_LABELS[work.work_type] || "Travaux").replace(/\s*\((?:extérieur|pièce non identifiée)\)$/, "");
    out.push({
      id: work.work_id || `${work.work_type}_${out.length + 1}`,
      label: sentence(label),
      kind: exterior ? "exterior" : "indoor",
      photos: urls,
      photoNumbers: urls.map((u) => photos.indexOf(u) + 1).filter((n) => n > 0),
      issues: exterior ? [] : cleanIssues(WORK_TYPE_TO_ISSUES[work.work_type] || []),
      reason: sentence(work.rationale || (work.reasons || []).join(", ")).slice(0, 200),
    });
  }
  return out;
}

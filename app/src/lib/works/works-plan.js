/**
 * Plan de travaux d'une annonce : pièces, état des surfaces et rattachement
 * des photos.
 *
 * L'analyse des photos fournit une proposition (`seedWorksPlan`) ; une fois
 * corrigé par l'utilisateur, le plan est stocké tel quel et seulement
 * réconcilié avec la galerie (`reconcileWorksPlan`) : les photos sont
 * référencées par URL car les identifiants `img_XX` changent à chaque analyse.
 */

import { z } from "zod";
import * as E from "../photo-analysis/enums.js";
import {
  CONDITION_TONES,
  FLOOR_MATERIAL_LABELS,
  ROOM_LABELS,
} from "../photo-analysis/labels.js";

export const WORKS_PLAN_VERSION = 1;

export const GROUP_KEYS = ["unassigned", "exterior", "excluded"];

export const STORAGE_LEVELS = ["good", "some", "none_visible", "unknown"];

const SOURCES = ["ai", "user"];

const LIMITS = {
  rooms: 40,
  label: 60,
  note: 400,
  caption: 400,
  url: 2000,
  photos: 300,
};

/* ----------------------------- Libellés ----------------------------- */

export const PLANNER_ROOM_LABELS = { ...ROOM_LABELS, unknown: "Autre pièce" };

/** États proposés dans la modale « Pièces et état » (hors valeurs IA historiques). */
export const PLANNER_SELECTABLE_ROOM_CONDITIONS = [
  "new_or_recently_renovated",
  "very_good",
  "good",
  "average",
  "renovation_needed",
  "heavy_renovation_likely",
  "not_assessable",
];

const ROOM_CONDITION_TO_PLANNER = {
  dated: "average",
  refresh_needed: "average",
};

/** Ramène une condition (IA ou ancien plan) au vocabulaire de la modale. */
export function normalizePlannerRoomCondition(condition) {
  if (PLANNER_SELECTABLE_ROOM_CONDITIONS.includes(condition)) return condition;
  return ROOM_CONDITION_TO_PLANNER[condition] ?? "not_assessable";
}

export const PLANNER_ROOM_CONDITION_LABELS = {
  new_or_recently_renovated: "Neuf / Rénové",
  very_good: "Très bon",
  good: "Bon",
  average: "Moyen",
  dated: "Daté",
  refresh_needed: "À rafraîchir",
  renovation_needed: "À rénover",
  heavy_renovation_likely: "Rénovation lourde",
  not_assessable: "Non évalué",
};

export const PLANNER_SURFACE_CONDITION_LABELS = {
  good: "Bon",
  worn: "Usé",
  damaged: "Abîmé",
  dated: "Daté",
  replacement_likely: "À remplacer",
  unknown: "Non évalué",
};

export const SURFACE_CONDITION_TONES = {
  good: "good",
  worn: "average",
  dated: "average",
  damaged: "poor",
  replacement_likely: "poor",
  unknown: "unknown",
};

export const PLANNER_BRIGHTNESS_LABELS = {
  very_bright: "Très lumineux",
  bright: "Lumineux",
  average: "Moyenne",
  dark: "Sombre",
  not_assessable: "Non évaluée",
};

export const PLANNER_CEILING_HEIGHT_LABELS = {
  high: "Haute",
  standard: "Standard",
  low: "Basse",
  unknown: "Non évaluée",
};

export const PLANNER_STORAGE_LABELS = {
  good: "Intégrés",
  some: "Quelques-uns",
  none_visible: "Aucun",
  unknown: "Non évalués",
};

/** Icône (symbole du sprite `works-icons.ejs`) par type de pièce. */
export const ROOM_ICONS = {
  living_room: "sofa",
  dining_room: "dining",
  living_dining_room: "sofa",
  kitchen: "kitchen",
  open_kitchen: "kitchen",
  bedroom: "bed",
  master_bedroom: "bed",
  child_bedroom: "bed-single",
  office: "briefcase",
  bathroom: "bath",
  shower_room: "shower",
  toilet: "toilet",
  entrance: "door",
  hallway: "hallway",
  dressing: "shirt",
  laundry: "washer",
  cellar: "archive",
  garage: "car",
  balcony: "sun",
  terrace: "sun",
  garden: "sprout",
  common_area: "building",
  building_exterior: "building",
  unknown: "home",
};

export function roomIcon(type) {
  return ROOM_ICONS[type] || "home";
}

export const GROUP_LABELS = {
  unassigned: "À classer",
  exterior: "Extérieur et immeuble",
  excluded: "Écartées",
};

const VIEW_NOTES = {
  open_view: "Vue dégagée",
  street_view: "Vue sur rue",
  courtyard: "Vue sur cour",
  garden: "Vue sur jardin",
  building_opposite: "Immeuble en face",
  strong_overlooking: "Vis-à-vis important",
  limited_overlooking: "Vis-à-vis limité",
};

/** Catégories des points à signaler (icône du sprite `works-icons.ejs`). */
export const ROOM_ISSUE_CATEGORIES = [
  { key: "floor", label: "Sol", icon: "floor" },
  { key: "walls", label: "Murs", icon: "walls" },
  { key: "ceiling", label: "Plafond", icon: "ceiling" },
  { key: "humidity", label: "Humidité", icon: "droplet" },
  { key: "equipment", label: "Fenêtres et équipements", icon: "window" },
];

/**
 * Points à signaler par pièce : uniquement ce qu'on peut corriger par des
 * travaux. `tone` colore l'étiquette cochée.
 */
export const ROOM_ISSUES = [
  { key: "floor_worn", category: "floor", label: "Sol usé", tone: "average" },
  { key: "floor_redo", category: "floor", label: "Sol à refaire", tone: "poor" },
  { key: "paint", category: "walls", label: "Peinture à refaire", tone: "average" },
  { key: "walls_damaged", category: "walls", label: "Murs à refaire", tone: "poor" },
  { key: "cracks", category: "walls", label: "Fissures", tone: "poor" },
  { key: "ceiling_paint", category: "ceiling", label: "Plafond à repeindre", tone: "average" },
  { key: "ceiling_damaged", category: "ceiling", label: "Plafond à refaire", tone: "poor" },
  { key: "humidity", category: "humidity", label: "Traces d'humidité", tone: "poor" },
  { key: "mold", category: "humidity", label: "Moisissures", tone: "poor" },
  { key: "windows", category: "equipment", label: "Fenêtres à changer", tone: "average" },
  { key: "joinery", category: "equipment", label: "Menuiseries abîmées", tone: "average" },
  { key: "electricity", category: "equipment", label: "Électricité à revoir", tone: "poor" },
  { key: "heating", category: "equipment", label: "Chauffage à moderniser", tone: "average" },
];

export const ROOM_ISSUE_KEYS = ROOM_ISSUES.map((i) => i.key);

const TONE_RANK = { unknown: 0, good: 1, average: 2, poor: 3 };

/**
 * Tags les plus graves par catégorie (sol, murs, plafond, humidité, équipements),
 * appliqués lorsque l'état de la pièce est « Rénovation lourde ».
 */
export const HEAVY_RENOVATION_WORST_ISSUES = ROOM_ISSUE_CATEGORIES.flatMap(({ key: category }) => {
  const inCategory = ROOM_ISSUES.filter((i) => i.category === category);
  const maxTone = Math.max(...inCategory.map((i) => TONE_RANK[i.tone] ?? 0));
  return inCategory.filter((i) => (TONE_RANK[i.tone] ?? 0) === maxTone).map((i) => i.key);
});

/**
 * Ajoute les pires tags par catégorie.
 * @returns {{ issues: string[], added: string[] }} `added` = clés nouvellement cochées (pour annulation au changement d'état).
 */
export function applyHeavyRenovationIssues(issues) {
  const before = new Set(cleanIssues(issues || []));
  const next = cleanIssues([...(issues || []), ...HEAVY_RENOVATION_WORST_ISSUES]);
  const added = next.filter((k) => !before.has(k));
  return { issues: next, added };
}

/** Retire uniquement les tags ajoutés automatiquement en « Rénovation lourde ». */
export function revertHeavyRenovationAutoIssues(issues, autoKeys) {
  const auto = new Set((autoKeys || []).filter((k) => ROOM_ISSUE_KEYS.includes(k)));
  if (!auto.size) return cleanIssues(issues || []);
  return cleanIssues((issues || []).filter((k) => !auto.has(k)));
}

/**
 * Caractéristiques de la pièce qu'aucun travaux ne change : conservées dans
 * `ambiance` pour l'analyse globale du bien, hors points à signaler.
 */
export const ROOM_TRAITS = [
  { key: "bright", field: "brightness", label: "Lumineuse", values: ["bright", "very_bright"], set: "bright", reset: "not_assessable" },
  { key: "dark", field: "brightness", label: "Sombre", values: ["dark"], set: "dark", reset: "not_assessable" },
  { key: "high_ceiling", field: "ceiling_height", label: "Belle hauteur sous plafond", values: ["high"], set: "high", reset: "unknown" },
  { key: "low_ceiling", field: "ceiling_height", label: "Plafond bas", values: ["low"], set: "low", reset: "unknown" },
];

/** Étiquettes qui s'excluent (la seconde l'emporte). */
const EXCLUSIVE_ISSUES = [
  ["floor_worn", "floor_redo"],
  ["ceiling_paint", "ceiling_damaged"],
];

const WORN = ["worn", "dated"];
const BROKEN = ["damaged", "replacement_likely"];

const ANOMALY_ISSUES = {
  possible_humidity: "humidity",
  possible_water_damage: "humidity",
  possible_mold: "mold",
  crack: "cracks",
  ceiling_damage: "ceiling_damaged",
  peeling_paint: "paint",
  damaged_floor: "floor_redo",
  damaged_joinery: "joinery",
  visible_wiring: "electricity",
};

function cleanIssues(keys) {
  const set = new Set(keys.filter((k) => ROOM_ISSUE_KEYS.includes(k)));
  for (const [weak, strong] of EXCLUSIVE_ISSUES) if (set.has(strong)) set.delete(weak);
  return ROOM_ISSUE_KEYS.filter((k) => set.has(k));
}

/** Points déduits de l'état des surfaces d'une pièce. */
export function issuesFromRoom(room) {
  const keys = [];
  if (WORN.includes(room.floor?.condition)) keys.push("floor_worn");
  if (BROKEN.includes(room.floor?.condition)) keys.push("floor_redo");
  if (WORN.includes(room.walls?.condition)) keys.push("paint");
  if (BROKEN.includes(room.walls?.condition)) keys.push("walls_damaged");
  if (WORN.includes(room.ceiling?.condition)) keys.push("ceiling_paint");
  if (BROKEN.includes(room.ceiling?.condition)) keys.push("ceiling_damaged");
  if (
    BROKEN.includes(room.floor?.condition) &&
    (BROKEN.includes(room.walls?.condition) || room.floor?.condition === "replacement_likely")
  ) {
    keys.push("humidity");
  }
  return cleanIssues(keys);
}

/** Les anciens plans stockaient « sombre » et « plafond bas » parmi les points. */
function migrateLegacyTraits(room) {
  if (!Array.isArray(room.issues) || !room.ambiance) return room.ambiance;
  const ambiance = { ...room.ambiance };
  if (room.issues.includes("dark")) ambiance.brightness = "dark";
  if (room.issues.includes("low_ceiling")) ambiance.ceiling_height = "low";
  return ambiance;
}

function options(values, labels) {
  return values.map((value) => ({ value, label: labels[value] ?? value }));
}

/** Vocabulaires proposés par la modale (valeur + libellé + ton). */
export function plannerOptions() {
  return {
    roomTypes: options(E.ROOM_TYPES, PLANNER_ROOM_LABELS).map((o) => ({
      ...o,
      icon: roomIcon(o.value),
    })),
    roomConditions: options(PLANNER_SELECTABLE_ROOM_CONDITIONS, PLANNER_ROOM_CONDITION_LABELS).map((o) => ({
      ...o,
      tone: CONDITION_TONES[o.value] || "unknown",
    })),
    surfaceConditions: options(E.SURFACE_CONDITIONS, PLANNER_SURFACE_CONDITION_LABELS).map(
      (o) => ({ ...o, tone: SURFACE_CONDITION_TONES[o.value] || "unknown" })
    ),
    floorMaterials: options(E.FLOOR_MATERIALS, FLOOR_MATERIAL_LABELS),
    brightness: options(E.BRIGHTNESS_LEVELS, PLANNER_BRIGHTNESS_LABELS),
    ceilingHeights: options(E.CEILING_HEIGHTS, PLANNER_CEILING_HEIGHT_LABELS),
    storage: options(STORAGE_LEVELS, PLANNER_STORAGE_LABELS),
    issueCategories: ROOM_ISSUE_CATEGORIES.map((c) => ({ value: c.key, label: c.label, icon: c.icon })),
    issues: ROOM_ISSUES.map((i) => ({ value: i.key, label: i.label, tone: i.tone, category: i.category })),
    traits: ROOM_TRAITS.map((t) => ({ value: t.key, label: t.label, field: t.field, values: t.values, set: t.set, reset: t.reset })),
    groups: GROUP_KEYS.map((key) => ({ value: key, label: GROUP_LABELS[key] })),
    heavyRenovationWorstIssues: HEAVY_RENOVATION_WORST_ISSUES,
  };
}

/* ------------------------------ Schéma ------------------------------ */

const text = (max) => z.string().trim().max(max).default("");
const enumOf = (values, fallback) => z.enum(values).default(fallback);
const source = enumOf(SOURCES, "user");
const url = z.string().min(1).max(LIMITS.url);
const urls = z.array(url).max(LIMITS.photos);

const surfaceBase = { condition: enumOf(E.SURFACE_CONDITIONS, "unknown"), note: text(LIMITS.note), source };
const issueList = z.array(z.enum(ROOM_ISSUE_KEYS)).max(ROOM_ISSUE_KEYS.length).default([]);

const roomSchema = z.object({
  id: z.string().regex(/^[\w-]{1,40}$/),
  type: enumOf(E.ROOM_TYPES, "unknown"),
  label: text(LIMITS.label),
  condition: enumOf(E.ROOM_CONDITIONS, "not_assessable"),
  condition_source: source,
  summary: text(LIMITS.note),
  source,
  issues: issueList,
  issues_ai: issueList,
  issues_heavy_auto: issueList,
  floor: z.object({ material: enumOf(E.FLOOR_MATERIALS, "unknown"), ...surfaceBase }),
  walls: z.object(surfaceBase),
  ceiling: z.object(surfaceBase),
  ambiance: z.object({
    brightness: enumOf(E.BRIGHTNESS_LEVELS, "not_assessable"),
    ceiling_height: enumOf(E.CEILING_HEIGHTS, "unknown"),
    storage: enumOf(STORAGE_LEVELS, "unknown"),
    note: text(LIMITS.note),
    source,
  }),
  photos: urls,
});

const planSchema = z.object({
  rooms: z.array(roomSchema).max(LIMITS.rooms),
  groups: z.object({
    unassigned: urls.default([]),
    exterior: urls.default([]),
    excluded: urls.default([]),
  }),
  captions: z
    .record(url, z.object({ text: text(LIMITS.caption), source }))
    .default({}),
});

/**
 * Valide un plan reçu du client.
 * @returns {{ ok: true, plan: object } | { ok: false, error: string }}
 */
export function parseWorksPlan(input) {
  const result = planSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { ok: false, error: `Données du plan invalides (${issue.path.join(".") || "plan"}).` };
  }
  const ids = new Set();
  for (const room of result.data.rooms) {
    if (ids.has(room.id)) return { ok: false, error: `Données du plan invalides (pièce en double : ${room.id}).` };
    ids.add(room.id);
    room.issues = cleanIssues(room.issues);
  }
  return { ok: true, plan: { version: WORKS_PLAN_VERSION, ...result.data } };
}

/* ------------------------------- Seed ------------------------------- */

function emptySurface(extra = {}) {
  return { condition: "unknown", note: "", source: "ai", ...extra };
}

export function emptyRoom(id, type = "unknown", label = "") {
  return {
    id,
    type,
    label,
    condition: "average",
    condition_source: "user",
    summary: "",
    source: "user",
    issues: [],
    issues_ai: [],
    issues_heavy_auto: [],
    floor: emptySurface({ material: "unknown", source: "user" }),
    walls: emptySurface({ source: "user" }),
    ceiling: emptySurface({ source: "user" }),
    ambiance: {
      brightness: "not_assessable",
      ceiling_height: "unknown",
      storage: "unknown",
      note: "",
      source: "user",
    },
    photos: [],
  };
}

function clip(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function pick(value, values, fallback) {
  return values.includes(value) ? value : fallback;
}

function seedRoom(raw, urlsOf, anomalies = []) {
  const view = raw.view && VIEW_NOTES[raw.view.type];
  const room = {
    id: clip(raw.room_id, 40).replace(/[^\w-]/g, "_") || "room",
    type: pick(raw.room_type, E.ROOM_TYPES, "unknown"),
    label: clip(raw.label, LIMITS.label),
    condition: normalizePlannerRoomCondition(
      pick(raw.condition, E.ROOM_CONDITIONS, "not_assessable")
    ),
    condition_source: "ai",
    summary: clip(raw.summary, LIMITS.note),
    source: "ai",
    floor: emptySurface({
      material: pick(raw.floor?.material, E.FLOOR_MATERIALS, "unknown"),
      condition: pick(raw.floor?.condition, E.SURFACE_CONDITIONS, "unknown"),
      note: clip(raw.floor?.potential_work, LIMITS.note),
    }),
    walls: emptySurface({
      condition: pick(raw.walls?.condition, E.SURFACE_CONDITIONS, "unknown"),
      note: clip(raw.walls?.notes, LIMITS.note),
    }),
    ceiling: emptySurface({
      condition: pick(raw.ceiling?.condition, E.SURFACE_CONDITIONS, "unknown"),
      note: clip(raw.ceiling?.notes, LIMITS.note),
    }),
    ambiance: {
      brightness: pick(raw.brightness, E.BRIGHTNESS_LEVELS, "not_assessable"),
      ceiling_height: pick(raw.ceiling_height, E.CEILING_HEIGHTS, "unknown"),
      storage: pick(raw.storage, STORAGE_LEVELS, "unknown"),
      note: view || "",
      source: "ai",
    },
    photos: urlsOf(raw.image_ids),
  };
  const fromAnomalies = anomalies
    .filter((a) => a?.room_id && a.room_id === raw.room_id)
    .map((a) => ANOMALY_ISSUES[a.type])
    .filter(Boolean);
  if (raw.windows?.replacement_may_be_relevant) fromAnomalies.push("windows");
  if (raw.heating?.modernization_may_be_relevant) fromAnomalies.push("heating");
  room.issues = cleanIssues([...issuesFromRoom(room), ...fromAnomalies]);
  room.issues_heavy_auto = [];
  if (room.condition === "heavy_renovation_likely") {
    const heavy = applyHeavyRenovationIssues(room.issues);
    room.issues = heavy.issues;
    room.issues_heavy_auto = heavy.added;
  }
  room.issues_ai = [...room.issues];
  return room;
}

/** Légende d'une photo à partir des observations de l'IA. */
export function captionFromObservations(o) {
  if (!o || typeof o !== "object") return "";
  const parts = [];
  if (o.floor?.notes) parts.push(`Sol : ${o.floor.notes}`);
  else if (o.floor?.material && o.floor.material !== "unknown") {
    parts.push(`Sol : ${(FLOOR_MATERIAL_LABELS[o.floor.material] || "").toLowerCase()}`);
  }
  if (o.walls?.notes) parts.push(`Murs : ${o.walls.notes}`);
  if (o.ceiling?.notes) parts.push(`Plafond : ${o.ceiling.notes}`);
  if (o.kitchen?.notes) parts.push(`Cuisine : ${o.kitchen.notes}`);
  if (o.bathroom?.notes) parts.push(`Salle de bain : ${o.bathroom.notes}`);
  for (const d of o.possible_defects || []) {
    if (d?.observation) parts.push(d.observation);
  }
  return parts.join(" · ").slice(0, LIMITS.caption);
}

/**
 * Plan proposé par l'IA.
 * @param {object|null} stored - sortie de `readStored` (analyse des photos)
 * @param {string[]} photos - URLs de la galerie
 */
export function seedWorksPlan(stored, photos = []) {
  const plan = {
    version: WORKS_PLAN_VERSION,
    rooms: [],
    groups: { unassigned: [], exterior: [], excluded: [] },
    captions: {},
  };
  if (stored?.ready && stored.status === "ok") {
    const gallery = new Set(photos);
    const urlById = new Map();
    for (const image of stored.images || []) {
      const resolved = gallery.has(image.url) ? image.url : photos[image.order - 1];
      if (!resolved) continue;
      urlById.set(image.id, resolved);
      const caption = captionFromObservations(image.observations);
      if (caption) plan.captions[resolved] = { text: caption, source: "ai" };
    }
    const urlsOf = (ids) => (ids || []).map((id) => urlById.get(id)).filter(Boolean);

    const seenIds = new Set();
    for (const raw of stored.rooms || []) {
      const room = seedRoom(raw, urlsOf, stored.anomalies || []);
      while (seenIds.has(room.id)) room.id = `${room.id}_b`;
      seenIds.add(room.id);
      plan.rooms.push(room);
    }
    plan.groups.unassigned = urlsOf(stored.unassigned_usable_image_ids);
    plan.groups.exterior = (stored.images || [])
      .filter((img) => img.exclusion_reason === "exterior")
      .map((img) => urlById.get(img.id))
      .filter(Boolean);
    plan.groups.excluded = (stored.excluded_images || [])
      .filter((x) => x.reason !== "exterior")
      .map((x) => urlById.get(x.image_id))
      .filter(Boolean);
  }
  return reconcileWorksPlan(plan, photos);
}

/* -------------------------- Réconciliation -------------------------- */

/**
 * Aligne le plan sur la galerie : chaque photo apparaît une seule fois, les
 * photos disparues sont retirées et les nouvelles arrivent dans « À classer ».
 */
export function reconcileWorksPlan(plan, photos = []) {
  const gallery = new Set(photos);
  const placed = new Set();
  const keep = (list) =>
    (list || []).filter((u) => {
      if (!gallery.has(u) || placed.has(u)) return false;
      placed.add(u);
      return true;
    });

  const rooms = (plan.rooms || []).map((room) => ({
    ...room,
    ambiance: migrateLegacyTraits(room),
    photos: keep(room.photos),
    condition: normalizePlannerRoomCondition(room.condition),
    issues: Array.isArray(room.issues) ? cleanIssues(room.issues) : issuesFromRoom(room),
    issues_ai: Array.isArray(room.issues_ai) ? cleanIssues(room.issues_ai) : [],
    issues_heavy_auto: Array.isArray(room.issues_heavy_auto) ? cleanIssues(room.issues_heavy_auto) : [],
  }));
  const groups = {};
  for (const key of GROUP_KEYS) groups[key] = keep(plan.groups?.[key]);
  for (const u of photos) {
    if (!placed.has(u)) {
      groups.unassigned.push(u);
      placed.add(u);
    }
  }

  const captions = {};
  for (const [u, caption] of Object.entries(plan.captions || {})) {
    if (gallery.has(u) && caption?.text) captions[u] = caption;
  }

  return { version: WORKS_PLAN_VERSION, rooms, groups, captions };
}

/* ------------------------- Résumé du widget ------------------------- */

/**
 * Données de la bande de pièces affichée dans le widget « Travaux ».
 * @param {{ plan: object, stored: boolean, aiStatus: string }} state
 */
export function worksRoomsSummary(state) {
  const plan = state.plan;
  const rooms = plan.rooms.map((room) => {
    const surfaces = [
      ["Sol", room.floor.condition],
      ["Murs", room.walls.condition],
      ["Plafond", room.ceiling.condition],
    ].map(([name, condition]) => ({
      name,
      tone: SURFACE_CONDITION_TONES[condition] || "unknown",
      label: PLANNER_SURFACE_CONDITION_LABELS[condition] || "",
    }));
    return {
      id: room.id,
      type: room.type,
      icon: roomIcon(room.type),
      label: room.label || PLANNER_ROOM_LABELS[room.type] || "Pièce",
      condition: room.condition,
      conditionLabel: PLANNER_ROOM_CONDITION_LABELS[room.condition] || "",
      tone: CONDITION_TONES[room.condition] || "unknown",
      thumb: room.photos[0] || null,
      photoCount: room.photos.length,
      surfaces,
      issues: ROOM_ISSUES.filter((i) => room.issues.includes(i.key)).map((i) => ({ label: i.label, tone: i.tone })),
    };
  });
  return {
    rooms,
    unassignedCount: plan.groups.unassigned.length,
    stored: Boolean(state.stored),
    aiStatus: state.aiStatus,
    aiPending: state.aiStatus === "pending",
  };
}

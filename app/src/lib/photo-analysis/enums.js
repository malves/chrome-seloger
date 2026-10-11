/**
 * Vocabulaires fermés de l'analyse des photos.
 *
 * Le modèle de vision renvoie du JSON libre : toute valeur hors liste est
 * ramenée à `unknown` (ou à la valeur de repli indiquée) plutôt que de laisser
 * passer une catégorie inventée. Les confiances sont bornées dans [0, 1].
 */

export const IMAGE_CLASSIFICATIONS = [
  "real_interior",
  "real_exterior",
  "building_exterior",
  "common_area",
  "balcony",
  "terrace",
  "garden",
  "view",
  "neighborhood",
  "floor_plan",
  "map",
  "document",
  "virtual_staging",
  "real_photo_with_virtual_staging",
  "architect_projection",
  "ai_generated",
  "heavily_retouched",
  "decorative_or_marketing",
  "duplicate",
  "unknown",
];

/** Classifications qui n'apportent rien sur l'état réel du logement. */
export const NON_CONDITION_CLASSIFICATIONS = new Set([
  "floor_plan",
  "map",
  "document",
  "virtual_staging",
  "architect_projection",
  "ai_generated",
  "decorative_or_marketing",
  "duplicate",
  "unknown",
]);

/**
 * Extérieur du bâti (façade, jardin, terrasse…) : à la charge de la
 * copropriété pour un appartement, de l'acheteur pour une maison.
 */
export const BUILDING_EXTERIOR_CLASSIFICATIONS = new Set([
  "real_exterior",
  "building_exterior",
  "balcony",
  "terrace",
  "garden",
]);

/** Parties communes et environnement : jamais des travaux du logement. */
export const COMMON_CLASSIFICATIONS = new Set(["common_area", "view", "neighborhood"]);

/** Extérieur au sens large : exclu de l'état intérieur, analysé à part. */
export const EXTERIOR_CLASSIFICATIONS = new Set([
  ...BUILDING_EXTERIOR_CLASSIFICATIONS,
  ...COMMON_CLASSIFICATIONS,
]);

export const BUILDING_EXTERIOR_ROOM_TYPES = new Set([
  "building_exterior",
  "balcony",
  "terrace",
  "garden",
]);
export const COMMON_ROOM_TYPES = new Set(["common_area"]);

/** Types de pièce qui désignent l'immeuble ou l'extérieur, pas l'intérieur du logement. */
export const EXTERIOR_ROOM_TYPES = new Set([...BUILDING_EXTERIOR_ROOM_TYPES, ...COMMON_ROOM_TYPES]);

/** Images virtuelles / projetées : à présenter séparément, jamais comme état actuel. */
export const VIRTUAL_CLASSIFICATIONS = new Set([
  "virtual_staging",
  "architect_projection",
  "ai_generated",
]);

export const ROOM_TYPES = [
  "living_room",
  "dining_room",
  "living_dining_room",
  "kitchen",
  "open_kitchen",
  "bedroom",
  "master_bedroom",
  "child_bedroom",
  "office",
  "bathroom",
  "shower_room",
  "toilet",
  "entrance",
  "hallway",
  "dressing",
  "laundry",
  "cellar",
  "garage",
  "balcony",
  "terrace",
  "garden",
  "common_area",
  "building_exterior",
  "unknown",
];

/** Pièces intérieures comptant pour la couverture photographique du logement. */
export const INTERIOR_ROOM_TYPES = new Set([
  "living_room",
  "dining_room",
  "living_dining_room",
  "kitchen",
  "open_kitchen",
  "bedroom",
  "master_bedroom",
  "child_bedroom",
  "office",
  "bathroom",
  "shower_room",
  "toilet",
  "entrance",
  "hallway",
  "dressing",
  "laundry",
  "cellar",
  "garage",
]);

export const ROOM_CONDITIONS = [
  "new_or_recently_renovated",
  "very_good",
  "good",
  "average",
  "dated",
  "refresh_needed",
  "renovation_needed",
  "heavy_renovation_likely",
  "not_assessable",
];

export const VIRTUAL_STATUSES = ["none", "suspected", "confirmed"];
export const VIRTUAL_REASONS = ["explicit_text", "visual_indicators", "none"];

export const RELIABILITIES = ["high", "medium", "low"];

export const APPARENT_AGES = [
  "recent",
  "relatively_recent",
  "dated",
  "very_dated",
  "unknown",
];

export const FLOOR_MATERIALS = [
  "wood_parquet",
  "old_wood_parquet",
  "solid_parquet",
  "floating_parquet",
  "tiles",
  "carpet",
  "vinyl",
  "concrete",
  "other",
  "unknown",
];

export const SURFACE_CONDITIONS = [
  "good",
  "worn",
  "damaged",
  "dated",
  "replacement_likely",
  "unknown",
];

export const WINDOW_MATERIALS = ["wood", "pvc", "aluminium", "unknown"];
export const GLAZINGS = ["single_likely", "double_likely", "unknown"];

export const HEATING_EQUIPMENTS = [
  "electric_convector",
  "electric_radiator",
  "water_radiator",
  "underfloor",
  "fireplace",
  "stove",
  "air_conditioning",
  "heat_pump",
  "none_visible",
  "unknown",
];

export const BRIGHTNESS_LEVELS = [
  "very_bright",
  "bright",
  "average",
  "dark",
  "not_assessable",
];

export const VIEW_TYPES = [
  "open_view",
  "street_view",
  "courtyard",
  "garden",
  "building_opposite",
  "strong_overlooking",
  "limited_overlooking",
  "not_assessable",
];

export const CEILING_HEIGHTS = ["high", "standard", "low", "unknown"];
export const SPACE_FEELINGS = [
  "spacious",
  "normal",
  "compact",
  "cramped",
  "not_assessable",
];

export const SIZE_CLASSES = ["small", "medium", "large", "unknown"];

export const KITCHEN_CONDITIONS = [
  "recent",
  "functional",
  "dated_but_usable",
  "partial_renovation_likely",
  "full_replacement_likely",
  "not_assessable",
];

export const KITCHEN_LAYOUTS = ["open", "closed", "semi_open", "unknown"];

export const BATHROOM_RENOVATION_LEVELS = [
  "none",
  "light",
  "medium",
  "medium_to_full",
  "full",
  "unknown",
];

export const ANOMALY_TYPES = [
  "possible_humidity",
  "possible_water_damage",
  "possible_mold",
  "crack",
  "ceiling_damage",
  "peeling_paint",
  "damaged_floor",
  "damaged_joinery",
  "visible_wiring",
  "other",
];

export const CRACK_LEVELS = [
  "hairline_crack",
  "visible_crack",
  "significant_visible_crack",
  "unknown",
];

export const SEVERITIES = ["low", "medium", "high"];

export const WORK_TYPES = [
  "painting",
  "wallpaper_removal",
  "floor_replacement",
  "floor_sanding",
  "kitchen_refresh",
  "kitchen_replacement",
  "bathroom_refresh",
  "bathroom_full_renovation",
  "toilet_renovation",
  "window_replacement",
  "radiator_replacement",
  "visible_electrical_modernization",
  "ceiling_repair",
  "humidity_investigation",
  "crack_investigation",
  "general_refresh",
  "facade_renovation",
  "roof_repair",
  "exterior_refresh",
  "other",
];

export const WORK_NECESSITIES = [
  "unlikely",
  "optional",
  "possible",
  "likely",
  "very_likely",
];

export const WORK_SCOPES = ["light", "partial", "medium", "medium_to_full", "full", "unknown"];
export const WORK_CATEGORIES = ["necessary", "cosmetic", "comfort"];
/** Périmètre d'un travail : logement (privatif) ou immeuble (parties communes, façade…). */
export const WORK_AREAS = ["private", "common"];

export const RENOVATION_LEVELS = [
  "none",
  "light_refresh",
  "moderate_renovation",
  "significant_renovation",
  "heavy_renovation_possible",
  "unknown",
];

export const CONDITION_LABELS = [
  "very_good",
  "good",
  "average",
  "dated",
  "poor",
  "renovation_needed",
  "heavy_renovation_likely",
  "unknown",
];

/** Ce sur quoi porte une affirmation de l'annonce. */
export const CLAIM_SUBJECTS = ["dwelling", "building", "surroundings", "unclear"];

export const CLAIM_STATUSES = [
  "supported",
  "partially_supported",
  "contradicted",
  "not_verifiable",
];

export const RELATIONSHIP_TYPES = [
  "current_vs_projected",
  "near_duplicate",
  "same_room",
];

export const BRIGHTNESS_EDITS = [
  "none",
  "strong_brightness_edit",
  "strong_hdr",
  "heavy_filter",
  "very_dark_photo",
  "overexposed_photo",
];

/** Ramène une valeur libre dans une liste fermée. */
export function coerceEnum(value, allowed, fallback = "unknown") {
  if (typeof value !== "string") return fallback;
  const v = value.trim().toLowerCase();
  if (allowed.includes(v)) return v;
  // Tolérance : « heavily_retouch » (spec) ⇄ « heavily_retouched ».
  if (v === "heavily_retouch" && allowed.includes("heavily_retouched")) {
    return "heavily_retouched";
  }
  return allowed.includes(fallback) ? fallback : allowed[allowed.length - 1];
}

/** Confiance bornée dans [0, 1] ; valeur de repli si absente / invalide. */
export function clampConfidence(value, fallback = 0.5) {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  // Un modèle qui répond « 85 » voulait dire 85 % ; « 1.2 » est un léger dépassement.
  if (n >= 5 && n <= 100) return Math.round(n) / 100;
  return Math.min(1, Math.max(0, n));
}

/** Score entier borné dans [0, 100] ; `null` si absent. */
export function clampScore(value) {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  if (n >= 0 && n <= 1) return Math.round(n * 100);
  return Math.round(Math.min(100, Math.max(0, n)));
}

/** Chaîne nettoyée et tronquée ; `null` si vide. */
export function cleanText(value, max = 600) {
  if (typeof value !== "string") return null;
  const s = value.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

/** Liste de chaînes nettoyées (dédoublonnée, bornée). */
export function cleanTextList(value, { max = 20, maxLength = 300 } = {}) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const text =
      typeof item === "string"
        ? cleanText(item, maxLength)
        : cleanText(item?.label || item?.text || item?.question || null, maxLength);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

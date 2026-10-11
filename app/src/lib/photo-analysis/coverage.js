/**
 * Couverture photographique : calculs déterministes à partir des fiches par
 * image et des pièces logiques (§12, 13, 54, 61, 62 de la spec).
 *
 *  - distribution des photos par famille de pièce ;
 *  - pièces attendues (déclarées ou implicites) mais non photographiées ;
 *  - score de couverture et niveau ;
 *  - avertissement de distribution (ex. moitié des photos sur le séjour,
 *    aucune de la salle de bain) ;
 *  - score de qualité de l'analyse.
 */

import { INTERIOR_ROOM_TYPES, VIRTUAL_CLASSIFICATIONS } from "./enums.js";

/** Famille d'affichage d'un type de pièce. */
export function roomFamily(roomType) {
  switch (roomType) {
    case "living_room":
    case "dining_room":
    case "living_dining_room":
      return "living_room";
    case "kitchen":
    case "open_kitchen":
      return "kitchen";
    case "bedroom":
    case "master_bedroom":
    case "child_bedroom":
      return "bedroom";
    case "bathroom":
    case "shower_room":
      return "bathroom";
    case "toilet":
      return "toilet";
    case "entrance":
    case "hallway":
      return "entrance";
    case "office":
    case "dressing":
    case "laundry":
    case "cellar":
    case "garage":
      return "other_interior";
    case "balcony":
    case "terrace":
    case "garden":
    case "building_exterior":
    case "common_area":
      return "exterior";
    default:
      return "unknown";
  }
}

export const FAMILY_LABELS = {
  living_room: "Séjour",
  kitchen: "Cuisine",
  bedroom: "Chambres",
  bathroom: "Salle de bain / d'eau",
  toilet: "WC",
  entrance: "Entrée / couloir",
  other_interior: "Autres pièces",
  exterior: "Extérieur / immeuble",
  unknown: "Indéterminé",
};

/** Répartition des photos par famille (images réelles seulement). */
export function photoDistribution(records) {
  const counts = {};
  for (const r of records || []) {
    if (r.classification === "duplicate") continue;
    if (VIRTUAL_CLASSIFICATIONS.has(r.classification)) continue;
    if (["floor_plan", "map", "document", "decorative_or_marketing", "unknown"].includes(r.classification)) {
      continue;
    }
    const family =
      r.usable_for_condition_analysis || INTERIOR_ROOM_TYPES.has(r.room_type)
        ? roomFamily(r.room_type)
        : "exterior";
    counts[family] = (counts[family] || 0) + 1;
  }
  return counts;
}

/**
 * Pièces attendues d'après les données structurées de l'annonce.
 * @returns {{ family: string, count: number, importance: "high"|"medium"|"low", reason: string }[]}
 */
export function expectedRooms(listing) {
  const type = listing?.property_type || null;
  if (type === "land") return [];
  const rooms = Number.isFinite(listing?.rooms) ? listing.rooms : null;
  const bedrooms = Number.isFinite(listing?.bedrooms) ? listing.bedrooms : null;

  const expected = [
    { family: "living_room", count: 1, importance: "high", reason: "implicit" },
    { family: "kitchen", count: 1, importance: "high", reason: "implicit" },
    { family: "bathroom", count: 1, importance: "high", reason: "implicit" },
  ];
  if (bedrooms != null && bedrooms > 0) {
    expected.push({ family: "bedroom", count: bedrooms, importance: "high", reason: "declared" });
  } else if (rooms != null && rooms >= 2) {
    expected.push({ family: "bedroom", count: rooms - 1, importance: "medium", reason: "inferred_from_rooms" });
  }
  // Un studio n'a souvent ni WC séparé ni entrée distincte : importance basse.
  const small = rooms != null && rooms <= 1;
  expected.push({ family: "toilet", count: 1, importance: small ? "low" : "medium", reason: "implicit" });
  expected.push({ family: "entrance", count: 1, importance: "low", reason: "implicit" });
  return expected;
}

/** Nombre de pièces logiques vues par famille (pièces réelles uniquement). */
export function seenRoomsByFamily(rooms) {
  const counts = {};
  for (const room of rooms || []) {
    const family = roomFamily(room.room_type);
    counts[family] = (counts[family] || 0) + 1;
  }
  return counts;
}

/**
 * Pièces déclarées / attendues mais non photographiées.
 * @returns {{ room_type: string, label: string, missing_count: number, reason: string, importance: string }[]}
 */
export function missingVisualCoverage(listing, rooms, records) {
  const seen = seenRoomsByFamily(rooms);
  // Repli : si la synthèse n'a pas regroupé, on compte les photos classées.
  const fromPhotos = photoDistribution(records);
  const missing = [];
  for (const exp of expectedRooms(listing)) {
    const seenCount = Math.max(seen[exp.family] || 0, fromPhotos[exp.family] ? 1 : 0);
    if (seenCount >= exp.count) continue;
    missing.push({
      room_type: exp.family,
      label: FAMILY_LABELS[exp.family] || exp.family,
      missing_count: exp.count - seenCount,
      reason: exp.reason === "declared" ? "declared_but_not_shown" : "expected_but_not_shown",
      importance: exp.importance,
    });
  }
  return missing;
}

const LEVELS = [
  [80, "excellent"],
  [60, "good"],
  [40, "partial"],
  [0, "poor"],
];

function levelFor(score) {
  for (const [min, level] of LEVELS) if (score >= min) return level;
  return "poor";
}

/**
 * Score de couverture (0-100) : part des pièces attendues réellement vues,
 * pondérée par importance, modulée par le nombre de photos exploitables.
 */
export function photoCoverage(listing, rooms, records) {
  const expected = expectedRooms(listing);
  const seen = seenRoomsByFamily(rooms);
  const fromPhotos = photoDistribution(records);
  const weights = { high: 3, medium: 2, low: 1 };

  let possible = 0;
  let earned = 0;
  for (const exp of expected) {
    const w = weights[exp.importance] || 1;
    const seenCount = Math.max(seen[exp.family] || 0, fromPhotos[exp.family] ? 1 : 0);
    possible += w * exp.count;
    earned += w * Math.min(exp.count, seenCount);
  }
  const roomRatio = possible > 0 ? earned / possible : 0;

  const usable = (records || []).filter((r) => r.usable_for_condition_analysis).length;
  // Peu de photos exploitables = couverture plafonnée, même si chaque pièce a une image.
  const volumeFactor = Math.min(1, 0.4 + usable / 10);

  const score = Math.round(100 * roomRatio * volumeFactor);
  const missing = missingVisualCoverage(listing, rooms, records);
  return {
    score,
    level: levelFor(score),
    room_coverage: Math.round(roomRatio * 100) / 100,
    missing: missing.map((m) => m.label),
  };
}

/**
 * Observation objective sur la répartition (§61) : sans spéculer sur
 * l'intention, on constate quand une famille domine et qu'une pièce
 * importante manque.
 */
export function photoDistributionWarning(records, missing) {
  const dist = photoDistribution(records);
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  if (total < 4) return { status: false, observation: null };
  const [topFamily, topCount] = Object.entries(dist).sort((a, b) => b[1] - a[1])[0] || [];
  if (!topFamily || topFamily === "exterior") return { status: false, observation: null };
  const share = topCount / total;
  const importantMissing = (missing || []).filter((m) => m.importance === "high");
  if (share < 0.4 || importantMissing.length === 0) return { status: false, observation: null };
  const pct = Math.round(share * 100);
  const shown = FAMILY_PHRASES[topFamily] || FAMILY_LABELS[topFamily] || topFamily;
  const missingLabels = importantMissing
    .map((m) => FAMILY_PHRASES[m.room_type] || m.label.toLowerCase())
    .join(", ");
  return {
    status: true,
    observation: `${pct} % des photos montrent ${shown} tandis que ${missingLabels} ${
      importantMissing.length > 1 ? "ne sont pas visibles" : "n'est pas visible"
    }.`,
  };
}

/** Libellés avec article pour les phrases générées. */
const FAMILY_PHRASES = {
  living_room: "le séjour",
  kitchen: "la cuisine",
  bedroom: "les chambres",
  bathroom: "la salle de bain",
  toilet: "les WC",
  entrance: "l'entrée",
  other_interior: "d'autres pièces",
  exterior: "l'extérieur",
};

/**
 * Palier qualitatif (0–100) pour l'affichage « Excellente : 82 % ».
 * Seuils : ≥80 excellente, 55–79 bonne, 45–54 moyenne, 30–44 faible, &lt;30 mauvaise.
 * @param {number} score
 */
export function qualityLevelFromScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return "poor";
  if (n >= 80) return "excellent";
  if (n >= 55) return "good";
  if (n >= 45) return "average";
  if (n >= 30) return "low";
  return "poor";
}

/**
 * Score de qualité de l'analyse (§54) : volume de photos exploitables,
 * couverture des pièces, part de fiches peu fiables, échecs techniques.
 */
export function analysisQuality({ records, coverage, failures = 0, totalBatches = 1 }) {
  const photoCount = (records || []).length;
  const usable = (records || []).filter((r) => r.usable_for_condition_analysis).length;
  const lowReliability = (records || []).filter(
    (r) => r.usable_for_condition_analysis && r.analysis_reliability === "low"
  ).length;

  const volume = Math.min(1, usable / 10); // 10 photos exploitables = plein score
  const roomCoverage = coverage?.room_coverage ?? 0;
  const reliabilityPenalty = usable ? lowReliability / usable : 1;
  const failurePenalty = totalBatches ? failures / totalBatches : 0;

  let score = 100 * (0.45 * volume + 0.45 * roomCoverage + 0.1 * (1 - reliabilityPenalty));
  score *= 1 - 0.5 * failurePenalty;
  score = Math.round(Math.max(0, Math.min(100, score)));

  const confidence = qualityLevelFromScore(score);

  return {
    score,
    photo_count: photoCount,
    usable_photo_count: usable,
    room_coverage: roomCoverage,
    confidence,
    partial: failures > 0,
  };
}

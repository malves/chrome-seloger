/**
 * Points à signaler par pièce : vocabulaire partagé par le plan de travaux,
 * le chiffrage, la fusion des sorties IA et la modale. Électricité, fenêtres
 * et chauffage relèvent du logement entier (works-global.js).
 */

import { LEGACY_ROOM_TO_GLOBAL } from "./works-global.js";

/** Catégories des points à signaler (icône du sprite `works-icons.ejs`). */
export const ROOM_ISSUE_CATEGORIES = [
  { key: "floor", label: "Sol", icon: "floor" },
  { key: "walls", label: "Murs", icon: "walls" },
  { key: "ceiling", label: "Plafond", icon: "ceiling" },
  { key: "humidity", label: "Humidité", icon: "droplet" },
  { key: "fixtures", label: "Cuisine et salle d'eau", icon: "kitchen" },
];

const KITCHEN_ROOMS = ["kitchen", "open_kitchen", "living_room", "living_dining_room", "unknown"];
const WET_ROOMS = ["bathroom", "shower_room", "toilet", "unknown"];
const KITCHEN_CORE = ["kitchen", "open_kitchen"];
const WET_CORE = ["bathroom", "shower_room", "toilet"];

/**
 * Uniquement ce qu'on peut corriger par des travaux. `tone` colore l'étiquette
 * cochée ; `roomTypes` restreint le point à certaines pièces (un séjour peut
 * accueillir une cuisine ouverte) ; `heavyRoomTypes` limite la coche
 * automatique en « Rénovation lourde » aux pièces dédiées.
 */
export const ROOM_ISSUES = [
  {
    key: "floor_worn",
    category: "floor",
    label: "Sol usé",
    tone: "average",
    hint: "Revêtement usé mais sain : un ponçage, une vitrification ou un bon nettoyage suffisent.",
  },
  {
    key: "floor_redo",
    category: "floor",
    label: "Sol à refaire",
    tone: "poor",
    hint: "Revêtement abîmé ou à remplacer : dépose de l'ancien sol et pose d'un nouveau.",
  },
  {
    key: "paint",
    category: "walls",
    label: "Peinture à refaire",
    tone: "average",
    hint: "Murs sains, seule la finition est à reprendre : peinture ancienne ou papier peint.",
  },
  {
    key: "walls_damaged",
    category: "walls",
    label: "Murs à refaire",
    tone: "poor",
    hint: "Murs dégradés : fissures, fortes traces d'humidité, enduit abîmé. La peinture est comprise.",
  },
  {
    key: "ceiling_paint",
    category: "ceiling",
    label: "Plafond à repeindre",
    tone: "average",
    hint: "Plafond sain : seule la peinture est défraîchie ou jaunie.",
  },
  {
    key: "ceiling_damaged",
    category: "ceiling",
    label: "Plafond à refaire",
    tone: "poor",
    hint: "Plafond fissuré, taché par un dégât des eaux ou affaissé : à reprendre avant peinture.",
  },
  {
    key: "humidity",
    category: "humidity",
    label: "Traces d'humidité",
    tone: "poor",
    hint: "Auréoles, salpêtre, peinture qui cloque : l'origine (infiltration, remontées, ventilation) est à identifier en visite.",
  },
  {
    key: "mold",
    category: "humidity",
    label: "Moisissures",
    tone: "poor",
    hint: "Moisissures visibles : traitement des surfaces, et souvent ventilation à revoir.",
  },
  {
    key: "kitchen_refresh",
    category: "fixtures",
    label: "Cuisine à rafraîchir",
    tone: "average",
    hint: "Meubles et équipements conservés : façades, plan de travail, crédence ou peinture.",
    roomTypes: KITCHEN_ROOMS,
    heavyRoomTypes: KITCHEN_CORE,
  },
  {
    key: "kitchen_redo",
    category: "fixtures",
    label: "Cuisine à refaire",
    tone: "poor",
    hint: "Cuisine à remplacer : meubles, plan de travail, électroménager et raccordements.",
    roomTypes: KITCHEN_ROOMS,
    heavyRoomTypes: KITCHEN_CORE,
  },
  {
    key: "bathroom_refresh",
    category: "fixtures",
    label: "Salle d'eau à rafraîchir",
    tone: "average",
    hint: "Équipements conservés : joints, robinetterie, peinture ou faïence partielle.",
    roomTypes: WET_ROOMS,
    heavyRoomTypes: WET_CORE,
  },
  {
    key: "bathroom_redo",
    category: "fixtures",
    label: "Salle d'eau à refaire",
    tone: "poor",
    hint: "Salle d'eau à refaire entièrement : sanitaires, faïence et plomberie apparente.",
    roomTypes: WET_ROOMS,
    heavyRoomTypes: WET_CORE,
  },
];

export const ROOM_ISSUE_KEYS = ROOM_ISSUES.map((i) => i.key);

/** Points que l'IA relève encore mais qui se cochent sous un autre point : une fissure impose de refaire le mur. */
export const ISSUE_ALIASES = { cracks: "walls_damaged" };

export function canonicalIssue(key) {
  return ISSUE_ALIASES[key] || key;
}

/**
 * Vocabulaire de l'analyse des photos : l'IA relève aussi, pièce par pièce,
 * les fissures et les signes qui alimentent les chantiers du logement entier.
 */
export const ANALYSIS_ISSUE_KEYS = [...ROOM_ISSUE_KEYS, ...Object.keys(ISSUE_ALIASES), ...Object.keys(LEGACY_ROOM_TO_GLOBAL)];

const ISSUE_BY_KEY = new Map(ROOM_ISSUES.map((i) => [i.key, i]));

/** Étiquettes qui s'excluent (la seconde l'emporte). */
export const EXCLUSIVE_ISSUES = [
  ["floor_worn", "floor_redo"],
  ["paint", "walls_damaged"],
  ["ceiling_paint", "ceiling_damaged"],
  ["kitchen_refresh", "kitchen_redo"],
  ["bathroom_refresh", "bathroom_redo"],
];

/** Classement des travaux dans le récapitulatif et sur la fiche. */
export const ISSUE_PRIORITY = {
  humidity: "necessary",
  mold: "necessary",
  ceiling_damaged: "necessary",
  kitchen_redo: "necessary",
  bathroom_redo: "necessary",
  kitchen_refresh: "comfort",
  bathroom_refresh: "comfort",
  floor_worn: "cosmetic",
  floor_redo: "cosmetic",
  paint: "cosmetic",
  walls_damaged: "cosmetic",
  ceiling_paint: "cosmetic",
};

export const PRIORITIES = [
  { key: "necessary", label: "Nécessaire", hint: "Sécurité, salubrité, équipements à refaire" },
  { key: "comfort", label: "Confort et énergie", hint: "Factures, confort, équipements à rafraîchir" },
  { key: "cosmetic", label: "Finitions", hint: "Peintures, sols, rafraîchissement" },
];

export function issueLabel(key) {
  return ISSUE_BY_KEY.get(key)?.label || key;
}

/** Le point peut-il être coché dans une pièce de ce type ? */
export function issueAppliesTo(key, roomType) {
  const issue = ISSUE_BY_KEY.get(key);
  if (!issue) return false;
  return !issue.roomTypes || issue.roomTypes.includes(roomType || "unknown");
}

/** Clés connues, dédoublonnées, exclusions appliquées, dans l'ordre du vocabulaire. */
export function cleanIssues(keys, roomType = null) {
  const set = new Set(
    (keys || []).map(canonicalIssue).filter((k) => ISSUE_BY_KEY.has(k) && (roomType == null || issueAppliesTo(k, roomType)))
  );
  for (const [weak, strong] of EXCLUSIVE_ISSUES) if (set.has(strong)) set.delete(weak);
  return ROOM_ISSUE_KEYS.filter((k) => set.has(k));
}

const TONE_RANK = { unknown: 0, good: 1, average: 2, poor: 3 };

/** Tags les plus graves par catégorie, cochés en « Rénovation lourde ». */
export const HEAVY_RENOVATION_WORST_ISSUES = ROOM_ISSUE_CATEGORIES.flatMap(({ key: category }) => {
  const inCategory = ROOM_ISSUES.filter((i) => i.category === category);
  const maxTone = Math.max(...inCategory.map((i) => TONE_RANK[i.tone] ?? 0));
  return inCategory.filter((i) => (TONE_RANK[i.tone] ?? 0) === maxTone).map((i) => i.key);
});

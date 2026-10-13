/**
 * Points à signaler par pièce : vocabulaire partagé par le plan de travaux,
 * le chiffrage, la fusion des sorties IA et la modale.
 */

/** Catégories des points à signaler (icône du sprite `works-icons.ejs`). */
export const ROOM_ISSUE_CATEGORIES = [
  { key: "floor", label: "Sol", icon: "floor" },
  { key: "walls", label: "Murs", icon: "walls" },
  { key: "ceiling", label: "Plafond", icon: "ceiling" },
  { key: "humidity", label: "Humidité", icon: "droplet" },
  { key: "fixtures", label: "Cuisine et salle d'eau", icon: "kitchen" },
  { key: "equipment", label: "Fenêtres et équipements", icon: "window" },
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
  { key: "floor_worn", category: "floor", label: "Sol usé", tone: "average" },
  { key: "floor_redo", category: "floor", label: "Sol à refaire", tone: "poor" },
  { key: "paint", category: "walls", label: "Peinture à refaire", tone: "average" },
  { key: "walls_damaged", category: "walls", label: "Murs à refaire", tone: "poor" },
  { key: "cracks", category: "walls", label: "Fissures", tone: "poor" },
  { key: "ceiling_paint", category: "ceiling", label: "Plafond à repeindre", tone: "average" },
  { key: "ceiling_damaged", category: "ceiling", label: "Plafond à refaire", tone: "poor" },
  { key: "humidity", category: "humidity", label: "Traces d'humidité", tone: "poor" },
  { key: "mold", category: "humidity", label: "Moisissures", tone: "poor" },
  { key: "kitchen_refresh", category: "fixtures", label: "Cuisine à rafraîchir", tone: "average", roomTypes: KITCHEN_ROOMS, heavyRoomTypes: KITCHEN_CORE },
  { key: "kitchen_redo", category: "fixtures", label: "Cuisine à refaire", tone: "poor", roomTypes: KITCHEN_ROOMS, heavyRoomTypes: KITCHEN_CORE },
  { key: "bathroom_refresh", category: "fixtures", label: "Salle d'eau à rafraîchir", tone: "average", roomTypes: WET_ROOMS, heavyRoomTypes: WET_CORE },
  { key: "bathroom_redo", category: "fixtures", label: "Salle d'eau à refaire", tone: "poor", roomTypes: WET_ROOMS, heavyRoomTypes: WET_CORE },
  { key: "windows", category: "equipment", label: "Fenêtres à changer", tone: "average" },
  { key: "joinery", category: "equipment", label: "Menuiseries abîmées", tone: "average" },
  { key: "electricity", category: "equipment", label: "Électricité à revoir", tone: "poor" },
  { key: "heating", category: "equipment", label: "Chauffage à moderniser", tone: "average" },
];

export const ROOM_ISSUE_KEYS = ROOM_ISSUES.map((i) => i.key);

const ISSUE_BY_KEY = new Map(ROOM_ISSUES.map((i) => [i.key, i]));

/** Étiquettes qui s'excluent (la seconde l'emporte). */
export const EXCLUSIVE_ISSUES = [
  ["floor_worn", "floor_redo"],
  ["ceiling_paint", "ceiling_damaged"],
  ["kitchen_refresh", "kitchen_redo"],
  ["bathroom_refresh", "bathroom_redo"],
];

/** Classement des travaux dans le récapitulatif et sur la fiche. */
export const ISSUE_PRIORITY = {
  humidity: "necessary",
  mold: "necessary",
  cracks: "necessary",
  electricity: "necessary",
  ceiling_damaged: "necessary",
  kitchen_redo: "necessary",
  bathroom_redo: "necessary",
  windows: "comfort",
  joinery: "comfort",
  heating: "comfort",
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
    (keys || []).filter((k) => ISSUE_BY_KEY.has(k) && (roomType == null || issueAppliesTo(k, roomType)))
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

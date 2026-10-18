/**
 * Chantiers « Logement entier » : travaux qui portent sur tout le logement
 * (réseaux, ouvertures, chauffage, frais de chantier) plutôt que sur une pièce.
 * Chiffrés à l'unité, au m², au forfait ou en pourcentage du reste des travaux.
 * Montants TTC posés, indicatifs.
 *
 * Module sans import : il est aussi servi tel quel au navigateur.
 */

export const GLOBAL_WORK_CATEGORIES = [
  { key: "networks", label: "Réseaux", icon: "zap" },
  { key: "openings", label: "Ouvertures", icon: "window" },
  { key: "comfort", label: "Chauffage et confort", icon: "flame" },
  { key: "layout", label: "Aménagement", icon: "walls" },
  { key: "site", label: "Chantier", icon: "truck" },
];

const WINDOW_PRICE_NOTE =
  "Prix moyen constaté pour une fenêtre standard posée (PVC, double vitrage). Grandes dimensions, porte-fenêtre, baie, bois ou aluminium peuvent le faire nettement varier.";

export const SURFACE_SCALE_REF_M2 = 70;

/** Bornes de la modulation d'un équipement (chauffe-eau, VMC, générateur). */
export const EQUIPMENT_SURFACE_BOUNDS = { min: 0.6, max: 1.6 };

/**
 * Modulation sous-linéaire d'un prix fixé pour un logement de 70 m² : un
 * logement quatre fois plus grand a un équipement plus puissant ou plus haut
 * de gamme, pas quatre fois plus cher.
 */
export function surfaceScale(surface, bounds) {
  if (!(surface > 0)) return 1;
  const ratio = Math.sqrt(surface / SURFACE_SCALE_REF_M2);
  return Math.min(bounds.max, Math.max(bounds.min, ratio));
}

/**
 * `mode` : "unit" (× quantité), "surface" (× m² du bien), "flat" (forfait),
 * "percent" (part du reste des travaux). `scaled` : forfait modulé par
 * `surfaceScale`. `quantity` : estimateur des lignes à l'unité. `manualQuantity` :
 * pas d'estimation, nombre saisi (1 par défaut).
 * `propertyTypes` : réservé à ces types de bien. `defaultOff` : jamais pré-coché.
 */
export const GLOBAL_WORKS = [
  {
    key: "electricity",
    category: "networks",
    label: "Électricité",
    icon: "zap",
    post: "electricity",
    priority: "necessary",
    hint: "Une installation ancienne se reprend rarement pièce par pièce : tableau, placards et couloirs compris.",
    defaultVariant: "full",
    variants: [
      { key: "safety", label: "Mise en sécurité", hint: "Tableau, différentiels 30 mA, mise à la terre, détecteurs de fumée.", mode: "flat", min: 1500, max: 3500 },
      { key: "full", label: "Réfection complète", hint: "Tout le réseau refait aux normes, y compris placards, couloirs et rangements.", mode: "surface", min: 90, max: 140 },
    ],
  },
  {
    key: "plumbing",
    category: "networks",
    label: "Plomberie",
    icon: "wrench",
    post: "plumbing",
    priority: "necessary",
    hint: "Remplacement des alimentations et évacuations (plomb, acier galvanisé, fuites).",
    defaultVariant: "network",
    variants: [
      { key: "network", label: "Réseau complet", hint: "Alimentation et évacuation, par point d'eau.", mode: "unit", unit: "point d'eau", units: "points d'eau", quantity: "waterPoints", min: 700, max: 1300 },
    ],
  },
  {
    key: "windows",
    category: "openings",
    label: "Fenêtres",
    icon: "window",
    post: "joinery",
    priority: "comfort",
    hint: "Remplacement en double vitrage.",
    note: WINDOW_PRICE_NOTE,
    defaultVariant: "double",
    variants: [
      { key: "double", label: "Double vitrage", hint: "Fenêtre standard posée.", mode: "unit", unit: "fenêtre", units: "fenêtres", feminine: true, quantity: "windows", min: 700, max: 1200 },
    ],
  },
  {
    key: "shutters",
    category: "openings",
    label: "Volets et stores",
    icon: "blinds",
    post: "joinery",
    priority: "comfort",
    hint: "Volets roulants ou battants, alignés par défaut sur le nombre de fenêtres.",
    defaultVariant: "standard",
    variants: [
      { key: "standard", label: "Volets roulants", hint: "Manuels ou motorisés, pose comprise.", mode: "unit", unit: "volet", units: "volets", quantity: "windows", min: 400, max: 900 },
    ],
  },
  {
    key: "entrance_door",
    category: "openings",
    label: "Porte d'entrée",
    icon: "lock",
    post: "doors",
    priority: "comfort",
    hint: "Porte blindée ou bloc-porte isolant.",
    defaultVariant: "armored",
    variants: [{ key: "armored", label: "Porte blindée", hint: "Serrure multipoints, pose comprise.", mode: "flat", min: 1500, max: 3500 }],
  },
  {
    key: "interior_doors",
    category: "openings",
    label: "Portes intérieures",
    icon: "door",
    post: "doors",
    priority: "cosmetic",
    hint: "Une par pièce fermée (chambres, salle d'eau, WC, cuisine fermée).",
    defaultVariant: "standard",
    variants: [
      { key: "standard", label: "Bloc-porte standard", hint: "Huisserie et porte, pose comprise.", mode: "unit", unit: "porte", units: "portes", feminine: true, quantity: "doors", min: 300, max: 700 },
    ],
  },
  {
    key: "heating",
    category: "comfort",
    label: "Chauffage",
    icon: "flame",
    post: "heating",
    priority: "comfort",
    hint: "Remplacement des émetteurs ou du générateur.",
    defaultVariant: "radiators",
    variants: [
      { key: "radiators", label: "Radiateurs électriques performants", hint: "Inertie, programmation, pose comprise.", mode: "unit", unit: "radiateur", units: "radiateurs", quantity: "radiators", min: 500, max: 1000 },
      { key: "boiler", label: "Chaudière à condensation", hint: "Remplacement de la chaudière, radiateurs conservés.", mode: "flat", min: 3500, max: 7000 },
      { key: "heat_pump", label: "Pompe à chaleur", hint: "Air/eau, raccordée aux radiateurs ou au plancher chauffant.", mode: "flat", min: 10000, max: 18000, propertyTypes: ["house"] },
    ],
  },
  {
    key: "hot_water",
    category: "comfort",
    label: "Eau chaude",
    icon: "droplet",
    post: "plumbing",
    priority: "comfort",
    hint: "Choisissez le type de production : l'écart de prix entre ballon électrique et thermodynamique est très important. Le prix suit la taille du logement.",
    defaultVariant: "electric",
    variants: [
      { key: "electric", label: "Ballon électrique", hint: "Capacité adaptée au logement, pose comprise — solution la plus courante.", mode: "flat", scaled: true, min: 900, max: 2200 },
      { key: "thermodynamic", label: "Thermodynamique", hint: "Chauffe-eau thermodynamique sur air ambiant ou extrait.", mode: "flat", scaled: true, min: 3200, max: 6500 },
      { key: "gas", label: "Chauffe-eau gaz", hint: "À accumulation ou instantané, alimentation gaz existante.", mode: "flat", scaled: true, min: 1400, max: 3200 },
    ],
  },
  {
    key: "ventilation",
    category: "comfort",
    label: "Ventilation (VMC)",
    icon: "wind",
    post: "humidity",
    priority: "comfort",
    hint: "Indispensable si des traces d'humidité ou de moisissures sont visibles.",
    defaultVariant: "hygro",
    variants: [{ key: "hygro", label: "VMC simple flux hygroréglable", hint: "Caisson, gaines et bouches.", mode: "flat", min: 1000, max: 2500 }],
  },
  {
    key: "sanitation",
    category: "networks",
    label: "Assainissement",
    icon: "droplet",
    post: "plumbing",
    priority: "necessary",
    hint: "Maison non raccordée au tout-à-l'égout : fosse ou micro-station à mettre aux normes.",
    propertyTypes: ["house"],
    defaultVariant: "standard",
    variants: [{ key: "standard", label: "Mise aux normes", hint: "Fosse toutes eaux ou micro-station.", mode: "flat", min: 6000, max: 12000 }],
  },
  {
    key: "partitions",
    category: "layout",
    label: "Création de cloison",
    icon: "walls",
    post: "walls",
    priority: "comfort",
    hint: "Créer une pièce en cloisonnant un espace existant (chambre, bureau…). Indiquez le nombre de pièces à créer.",
    defaultOff: true,
    defaultVariant: "complete",
    variants: [
      { key: "simple", label: "Cloison simple", hint: "Cloison en plaques de plâtre isolée et bloc-porte, pose comprise.", mode: "unit", unit: "pièce", units: "pièces", feminine: true, manualQuantity: true, min: 1500, max: 3000 },
      { key: "complete", label: "Pièce complète", hint: "Cloison, porte, électricité (prises, interrupteur, point lumineux), enduit et peinture.", mode: "unit", unit: "pièce", units: "pièces", feminine: true, manualQuantity: true, min: 2500, max: 5000 },
    ],
  },
  {
    key: "diagnostics",
    category: "site",
    label: "Diagnostics avant travaux",
    icon: "clipboard",
    post: "site",
    priority: "necessary",
    hint: "Repérage amiante (permis de construire avant 1997) et plomb (avant 1949). Un éventuel retrait est à chiffrer sur devis.",
    defaultVariant: "standard",
    variants: [{ key: "standard", label: "Repérage amiante et plomb", hint: "Avant tout travaux de démolition.", mode: "flat", min: 400, max: 1000 }],
  },
  {
    key: "preparation",
    category: "site",
    label: "Préparation et évacuation",
    icon: "truck",
    post: "site",
    priority: null,
    hint: "Protections, démolition, évacuation des gravats, benne.",
    defaultVariant: "standard",
    variants: [{ key: "standard", label: "Part du chantier", hint: "En pourcentage du reste des travaux.", mode: "percent", min: 0.04, max: 0.07 }],
  },
  {
    key: "contingency",
    category: "site",
    label: "Provision pour imprévus",
    icon: "alert",
    post: "site",
    priority: null,
    hint: "Ce qu'on découvre en ouvrant les murs et les sols.",
    defaultVariant: "standard",
    variants: [{ key: "standard", label: "Provision", hint: "En pourcentage du reste des travaux.", mode: "percent", min: 0.08, max: 0.12 }],
  },
  {
    key: "project_management",
    category: "site",
    label: "Maîtrise d'œuvre",
    icon: "briefcase",
    post: "site",
    priority: null,
    hint: "Architecte ou maître d'œuvre pour coordonner les corps de métier.",
    defaultOff: true,
    defaultVariant: "standard",
    variants: [{ key: "standard", label: "Honoraires", hint: "En pourcentage du reste des travaux.", mode: "percent", min: 0.08, max: 0.12 }],
  },
];

export const GLOBAL_WORK_KEYS = GLOBAL_WORKS.map((w) => w.key);

const WORK_BY_KEY = new Map(GLOBAL_WORKS.map((w) => [w.key, w]));

/** Points autrefois cochés pièce par pièce, désormais chantiers globaux. */
export const LEGACY_ROOM_TO_GLOBAL = {
  electricity: "electricity",
  windows: "windows",
  joinery: "windows",
  heating: "heating",
};

/** Zone DPE → chantier global qui la traite (sinon ligne énergie de repli). */
export const ENERGY_ZONE_TO_GLOBAL = {
  windows: "windows",
  heating: "heating",
  hotWater: "hot_water",
  ventilation: "ventilation",
};

/** Points retirés de l'état général quand le chantier est coché (sécurité, salubrité). */
export const GLOBAL_HEALTH_PENALTIES = {
  electricity: { safety: 3, full: 6 },
  plumbing: { network: 4 },
};

export const MAX_GLOBAL_QUANTITY = 99;

export function globalWork(key) {
  return WORK_BY_KEY.get(key) || null;
}

export function globalWorkApplies(work, propertyType) {
  return !work.propertyTypes || work.propertyTypes.includes(propertyType);
}

/** Variantes proposées pour ce type de bien. */
export function globalVariants(work, propertyType) {
  return work.variants.filter((v) => !v.propertyTypes || v.propertyTypes.includes(propertyType));
}

export function globalVariant(work, key, propertyType) {
  const list = globalVariants(work, propertyType);
  return list.find((v) => v.key === key) || list.find((v) => v.key === work.defaultVariant) || list[0];
}

/* ------------------------- Quantités estimées ------------------------- */

const PER_ROOM = {
  windows: {
    living_room: 2, living_dining_room: 3, dining_room: 1, kitchen: 1, open_kitchen: 1,
    bedroom: 1, master_bedroom: 1, child_bedroom: 1, office: 1, bathroom: 1, shower_room: 1, unknown: 1,
  },
  waterPoints: { kitchen: 2, open_kitchen: 2, bathroom: 3, shower_room: 2, toilet: 1, laundry: 1 },
  doors: {
    kitchen: 1, bedroom: 1, master_bedroom: 1, child_bedroom: 1, office: 1, bathroom: 1,
    shower_room: 1, toilet: 1, dressing: 1, laundry: 1, cellar: 1, dining_room: 1, living_room: 1,
  },
  radiators: {
    living_room: 2, living_dining_room: 2, dining_room: 1, kitchen: 1, open_kitchen: 1,
    bedroom: 1, master_bedroom: 1, child_bedroom: 1, office: 1, bathroom: 1, shower_room: 1, entrance: 1, unknown: 1,
  },
};

/** Repli d'après la surface, faute de pièces qui comptent. */
function fromSurface(kind, surface) {
  const s = surface > 0 ? surface : 60;
  if (kind === "windows") return Math.max(2, Math.round(s / 14));
  if (kind === "waterPoints") return s >= 110 ? 9 : 6;
  if (kind === "doors") return Math.max(2, Math.round(s / 16));
  return Math.max(2, Math.round(s / 13));
}

/** Nombre d'unités estimé dans une seule pièce. */
export function unitsInRoom(kind, roomType) {
  return PER_ROOM[kind]?.[roomType || "unknown"] || 0;
}

/**
 * Quantités estimées d'après les pièces du plan (repli sur la surface).
 * @returns {Record<string, { count: number, basis: number }>} `basis` : pièces prises en compte (0 = surface)
 */
export function estimateQuantities({ rooms = [], surface = null } = {}) {
  const out = {};
  for (const kind of Object.keys(PER_ROOM)) {
    let count = 0;
    let basis = 0;
    for (const room of rooms || []) {
      const n = unitsInRoom(kind, room.type);
      if (!n) continue;
      count += n;
      basis += 1;
    }
    if (kind === "windows" && surface > 0) count = Math.min(count, Math.ceil(surface / 6));
    out[kind] = basis ? { count: Math.max(1, count), basis } : { count: fromSurface(kind, surface), basis: 0 };
  }
  return out;
}

/* ------------------------------ Chiffrage ------------------------------ */

function pluralUnit(variant, n) {
  return `${n} ${n > 1 ? variant.units || variant.unit : variant.unit}`;
}

/**
 * Lignes chiffrées des chantiers cochés. Les pourcentages sont renvoyés à part :
 * ils s'appliquent au total des autres travaux (works-estimate.js).
 * @param {object} params
 * @param {object[]} params.items - `plan.global.items`
 * @param {object[]} params.rooms
 * @param {number|null} params.surface
 * @param {string} params.propertyType
 */
export function globalWorkLines({ items = [], rooms = [], surface = null, propertyType = "" }) {
  const quantities = estimateQuantities({ rooms, surface });
  const lines = [];
  const percents = [];
  for (const work of GLOBAL_WORKS) {
    const item = (items || []).find((i) => i && i.key === work.key);
    if (!item || !item.enabled || !globalWorkApplies(work, propertyType)) continue;
    const variant = globalVariant(work, item.variant, propertyType);
    if (!variant) continue;
    const line = {
      id: "global:" + work.key,
      key: work.key,
      label: work.variants.length > 1 ? `${work.label} : ${variant.label.toLowerCase()}` : work.label,
      post: work.post,
      priority: work.priority,
      icon: work.icon,
      copro: false,
      global: true,
      variant: variant.key,
      mode: variant.mode,
      rooms: [],
      roomIds: [],
      detail: "",
      min: 0,
      max: 0,
    };
    if (variant.mode === "percent") {
      line.rate = { min: variant.min, max: variant.max };
      line.detail = `${Math.round(variant.min * 100)} à ${Math.round(variant.max * 100)} % des travaux`;
      percents.push(line);
      continue;
    }
    let qty = 1;
    if (variant.mode === "unit" && variant.manualQuantity) {
      qty = item.quantity ?? 1;
      line.quantity = qty;
      line.estimated = false;
      line.basis = 0;
      line.detail = pluralUnit(variant, qty);
    } else if (variant.mode === "unit") {
      const est = quantities[variant.quantity] || { count: 1, basis: 0 };
      qty = item.quantity == null ? est.count : item.quantity;
      line.quantity = qty;
      line.estimated = item.quantity == null;
      line.basis = est.basis;
      line.detail = pluralUnit(variant, qty);
    } else if (variant.mode === "surface") {
      if (!(surface > 0)) continue;
      qty = surface;
      line.detail = `${Math.round(surface)} m²`;
    } else if (variant.scaled) {
      qty = surfaceScale(surface, EQUIPMENT_SURFACE_BOUNDS);
      line.detail = surface > 0 ? `forfait pour ${Math.round(surface)} m²` : "forfait";
    } else {
      line.detail = "forfait";
    }
    line.min = variant.min * qty;
    line.max = variant.max * qty;
    lines.push(line);
  }
  return { lines, percents, quantities };
}

/** Pénalité d'état général des chantiers cochés. */
export function globalHealthPenalty(items) {
  let penalty = 0;
  for (const item of items || []) {
    if (!item?.enabled) continue;
    const byVariant = GLOBAL_HEALTH_PENALTIES[item.key];
    if (!byVariant) continue;
    const work = globalWork(item.key);
    const variant = item.variant && byVariant[item.variant] != null ? item.variant : work?.defaultVariant;
    penalty += byVariant[variant] || 0;
  }
  return penalty;
}

/* ---------------------------- Normalisation ---------------------------- */

const SOURCES = ["ai", "user"];

/**
 * Chantiers connus, dédoublonnés, variante et quantité valides, dans l'ordre du catalogue.
 * Un chantier présent mais décoché par l'utilisateur reste : il est « écarté ».
 */
export function normalizeGlobalItems(items) {
  const byKey = new Map();
  for (const raw of Array.isArray(items) ? items : []) {
    if (!raw || typeof raw !== "object" || !WORK_BY_KEY.has(raw.key) || byKey.has(raw.key)) continue;
    const work = WORK_BY_KEY.get(raw.key);
    let variantKey = raw.variant;
    if (raw.key === "hot_water" && variantKey === "standard") variantKey = "electric";
    const variant = work.variants.some((v) => v.key === variantKey) ? variantKey : work.defaultVariant;
    const q = Number(raw.quantity);
    byKey.set(raw.key, {
      key: raw.key,
      enabled: Boolean(raw.enabled),
      variant,
      quantity:
        raw.quantity == null || !Number.isFinite(q) ? null : Math.max(1, Math.min(MAX_GLOBAL_QUANTITY, Math.round(q))),
      source: SOURCES.includes(raw.source) ? raw.source : "user",
      reason: typeof raw.reason === "string" ? raw.reason.trim().slice(0, 160) : "",
    });
  }
  return GLOBAL_WORK_KEYS.filter((k) => byKey.has(k)).map((k) => byKey.get(k));
}

/* ------------------- Conversion des points par pièce ------------------- */

/**
 * Chantiers globaux tirés des points autrefois cochés pièce par pièce
 * (`LEGACY_ROOM_TO_GLOBAL`), ou relevés par l'IA dans les pièces.
 * @param {{ roomId: string|null, roomType?: string, key: string, reason?: string, ai?: boolean }[]} entries
 * @param {object[]} rooms - pièces du plan
 * @param {{ mode?: "migrate" | "seed", heatingVariant?: string }} [options]
 *   `migrate` : électricité en réfection complète, quantités = pièces concernées.
 *   `seed` : réfection complète dès deux pièces ; « Toutes » si la majorité des pièces est concernée.
 */
export function globalItemsFromRoomIssues(entries, rooms, options = {}) {
  const mode = options.mode || "migrate";
  const groups = new Map();
  for (const e of entries || []) {
    const key = LEGACY_ROOM_TO_GLOBAL[e.key];
    if (!key) continue;
    const g = groups.get(key) || { roomIds: new Set(), roomless: false, reasons: [], ai: true };
    if (e.roomId) g.roomIds.add(e.roomId);
    else g.roomless = true;
    if (e.reason && !g.reasons.includes(e.reason)) g.reasons.push(e.reason);
    if (!e.ai) g.ai = false;
    groups.set(key, g);
  }
  const typeOf = new Map((rooms || []).map((r) => [r.id, r.type]));

  function quantityFor(kind, g) {
    const candidates = (rooms || []).filter((r) => unitsInRoom(kind, r.type) > 0);
    const concerned = [...g.roomIds].filter((id) => unitsInRoom(kind, typeOf.get(id)) > 0);
    if (!concerned.length) return null;
    const all = mode === "seed" ? concerned.length * 2 > candidates.length : concerned.length >= candidates.length;
    if (all) return null;
    return Math.max(1, concerned.reduce((s, id) => s + unitsInRoom(kind, typeOf.get(id)), 0));
  }

  const out = [];
  for (const [key, g] of groups) {
    const item = {
      key,
      enabled: true,
      variant: globalWork(key).defaultVariant,
      quantity: null,
      source: g.ai ? "ai" : "user",
      reason: g.reasons[0] || "",
    };
    if (key === "electricity") {
      item.variant = mode === "migrate" || g.roomIds.size >= 2 || g.roomless ? "full" : "safety";
    } else if (key === "windows") {
      item.quantity = quantityFor("windows", g);
    } else if (key === "heating") {
      item.variant = options.heatingVariant || "radiators";
      if (item.variant === "radiators") item.quantity = quantityFor("radiators", g);
    }
    out.push(item);
  }
  return normalizeGlobalItems(out);
}

/** Options du catalogue transmises à la modale. */
export function globalWorksOptions() {
  return {
    categories: GLOBAL_WORK_CATEGORIES,
    works: GLOBAL_WORKS,
    maxQuantity: MAX_GLOBAL_QUANTITY,
  };
}

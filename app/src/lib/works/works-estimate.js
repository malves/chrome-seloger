/**
 * Chiffrage des travaux à partir de la surface du bien, du plan pièces
 * (cases cochées), des chantiers « Logement entier » et du DPE lié.
 * Sols, murs et plafonds sont chiffrés au prix unitaire × surface estimée de
 * la pièce ; humidité au forfait par pièce ; cuisine et salle d'eau au
 * forfait par pièce, modulé par la surface du logement.
 * Montants TTC indicatifs.
 *
 * N'importe que des modules eux-mêmes servis au navigateur.
 */

import {
  ENERGY_ZONE_TO_GLOBAL,
  EQUIPMENT_SURFACE_BOUNDS,
  globalHealthPenalty,
  globalWorkLines,
  surfaceScale,
} from "./works-global.js";

/**
 * Surface au sol plausible par type de pièce (m²). La part de surface du
 * logement imputée à une pièce y est ramenée : une chambre ne vaut jamais
 * 28 m² parce que le plan ne liste que trois pièces.
 */
export const ROOM_AREA_BOUNDS = {
  living_room: { min: 18, max: 40 },
  living_dining_room: { min: 20, max: 50 },
  dining_room: { min: 10, max: 20 },
  kitchen: { min: 6, max: 15 },
  open_kitchen: { min: 6, max: 15 },
  bedroom: { min: 9, max: 16 },
  master_bedroom: { min: 11, max: 20 },
  child_bedroom: { min: 8, max: 13 },
  office: { min: 7, max: 14 },
  bathroom: { min: 4, max: 9 },
  shower_room: { min: 3, max: 7 },
  toilet: { min: 1, max: 3 },
  entrance: { min: 3, max: 10 },
  hallway: { min: 3, max: 10 },
  dressing: { min: 3, max: 8 },
  laundry: { min: 3, max: 7 },
  cellar: { min: 4, max: 15 },
  garage: { min: 12, max: 30 },
  balcony: { min: 3, max: 10 },
  terrace: { min: 8, max: 30 },
  garden: { min: 20, max: 200 },
  building_exterior: { min: 20, max: 200 },
  unknown: { min: 6, max: 20 },
};

const DEFAULT_ROOM_AREA_BOUNDS = { min: 6, max: 20 };

/** Hauteur sous plafond et part des murs hors ouvertures (portes, fenêtres). */
export const WALL_HEIGHT_M = 2.5;
export const WALL_OPENINGS_FACTOR = 0.85;

/** Surface au sol estimée d'une pièce (m²). */
export function roomFloorArea(type, surface, share) {
  const bounds = ROOM_AREA_BOUNDS[type] || DEFAULT_ROOM_AREA_BOUNDS;
  const area = Math.min(bounds.max, Math.max(bounds.min, surface * share));
  return Math.min(area, surface);
}

/** Surface de murs d'une pièce supposée carrée, ouvertures déduites (m²). */
export function wallArea(floorArea) {
  return 4 * Math.sqrt(floorArea) * WALL_HEIGHT_M * WALL_OPENINGS_FACTOR;
}

/** Forfait d'une pièce entièrement refaite dans un logement de référence. */
export const FIXTURE_FLAT_RATES = {
  kitchen: { min: 9000, max: 16000 },
  bathroom: { min: 8000, max: 14000 },
};

/** Bornes de la modulation : un studio comme une très grande maison restent plausibles. */
export const FIXTURE_SURFACE_BOUNDS = { min: 0.6, max: 2.5 };

/** Coefficient du forfait selon le type de pièce (1 par défaut). */
export const FIXTURE_ROOM_FACTORS = {
  kitchen: {},
  bathroom: { shower_room: 0.85, toilet: 0.35, unknown: 0.85 },
};

/** Modulation du forfait cuisine et salle d'eau par la surface du logement. */
export function fixtureSurfaceFactor(surface) {
  return surfaceScale(surface, FIXTURE_SURFACE_BOUNDS);
}

function fixtureRoomFactor(post, type) {
  const f = FIXTURE_ROOM_FACTORS[post]?.[type];
  return typeof f === "number" ? f : 1;
}

/**
 * Barème par point, TTC posé. `basis` : "floor" ou "ceiling" (€/m² de sol),
 * "walls" (€/m² de mur), "room" (€ par pièce). Sans `basis` : part du forfait
 * cuisine ou salle d'eau (`FIXTURE_FLAT_RATES`).
 */
export const ISSUE_INTENSITY = {
  floor_worn: { post: "floor", basis: "floor", min: 25, max: 45 },
  floor_redo: { post: "floor", basis: "floor", min: 50, max: 110 },
  paint: { post: "walls", basis: "walls", min: 20, max: 35 },
  walls_damaged: { post: "walls", basis: "walls", min: 40, max: 70 },
  ceiling_paint: { post: "ceiling", basis: "ceiling", min: 25, max: 40 },
  ceiling_damaged: { post: "ceiling", basis: "ceiling", min: 50, max: 90 },
  humidity: { post: "humidity", basis: "room", min: 600, max: 2000 },
  mold: { post: "humidity", basis: "room", min: 300, max: 900 },
  kitchen_refresh: { post: "kitchen", min: 0.35, max: 0.5 },
  kitchen_redo: { post: "kitchen", min: 0.85, max: 1 },
  bathroom_refresh: { post: "bathroom", min: 0.35, max: 0.5 },
  bathroom_redo: { post: "bathroom", min: 0.85, max: 1 },
};

export const ENERGY_SURFACE_REF_M2 = 70;

export function roundCost(n) {
  const step = n >= 20000 ? 1000 : n >= 5000 ? 500 : n >= 1000 ? 100 : 50;
  return Math.round(n / step) * step;
}

function roomWeight(type, factors) {
  const w = factors[type];
  return typeof w === "number" ? w : 1;
}

/**
 * Part de surface du logement imputée à chaque pièce (somme = 1). Avec
 * `eligible`, la part n'est répartie qu'entre les pièces retenues.
 */
export function roomSurfaceShares(rooms, roomTypeFactors, eligible = null) {
  const entries = [];
  let sum = 0;
  for (const room of rooms || []) {
    if (eligible && !eligible(room)) continue;
    const w = roomWeight(room.type, roomTypeFactors);
    if (w <= 0) continue;
    entries.push({ room, w });
    sum += w;
  }
  if (!sum) return new Map();
  return new Map(entries.map(({ room, w }) => [room.id, w / sum]));
}

/** Isolation : proportionnelle à la surface ; équipement : modulation sous-linéaire. */
function scaleEnergyCost(cost, surface, refM2) {
  const ref = refM2 > 0 ? refM2 : ENERGY_SURFACE_REF_M2;
  const s = surface > 0 ? surface : ref;
  const ratio = cost.equipment ? surfaceScale(s, EQUIPMENT_SURFACE_BOUNDS) : s / ref;
  return { min: cost.min * ratio, max: cost.max * ratio };
}

/**
 * @param {object} params
 * @param {number|null|undefined} params.surface
 * @param {string} params.propertyType
 * @param {object[]} params.rooms
 * @param {object[]} [params.globalItems] - chantiers « Logement entier » (`plan.global.items`)
 * @param {Record<string, { state?: string }>} params.dpeZones
 * @param {object} params.costs - sortie de costsOptions()
 * @param {(key: string) => string} [params.issueLabel]
 * @param {(key: string) => string} [params.issueIcon]
 * @param {(room: object) => string} [params.roomName]
 */
export function estimateWorksCosts(params) {
  const {
    surface,
    propertyType,
    rooms = [],
    globalItems = [],
    dpeZones = {},
    costs,
    issueLabel = (k) => k,
    issueIcon = () => "hammer",
    roomName = (room) => (room.label && String(room.label).trim()) || room.type || "Pièce",
  } = params;

  const surf = typeof surface === "number" && surface > 0 ? surface : null;
  if (surf == null) {
    return {
      min: null,
      max: null,
      posts: [],
      items: [],
      copro: [],
      byRoom: {},
      unavailableReason: "missing_surface",
    };
  }

  const factors = costs.roomTypeFactors || {};
  const priorities = costs.issuePriority || {};
  const covers = costs.issueCovers || {};
  const shares = roomSurfaceShares(rooms, factors);
  const fixtureFactor = fixtureSurfaceFactor(surf);
  const energy = costs.energy || {};
  const energyRef = costs.energySurfaceRefM2 ?? ENERGY_SURFACE_REF_M2;

  const items = {};
  const order = [];
  const byRoom = {};

  function add(id, data, roomId, label, min, max) {
    let item = items[id];
    if (!item) {
      item = items[id] = {
        id,
        label: data.label,
        post: data.post,
        priority: data.priority || "cosmetic",
        icon: data.icon || "hammer",
        copro: Boolean(data.copro),
        fixture: Boolean(data.fixture),
        rooms: [],
        roomIds: [],
        detail: "",
        min: 0,
        max: 0,
      };
      order.push(id);
    }
    if (roomId && !item.roomIds.includes(roomId)) {
      item.roomIds.push(roomId);
      item.rooms.push(label);
    }
    item.min += min;
    item.max += max;
    if (roomId) {
      const r = byRoom[roomId] || (byRoom[roomId] = { min: 0, max: 0 });
      r.min += min;
      r.max += max;
    }
  }

  /** Montant brut d'un point dans une pièce, avant partage au sein du poste. */
  function issueAmount(intensity, room, floor) {
    const flat = FIXTURE_FLAT_RATES[intensity.post];
    if (flat) {
      const base = fixtureFactor * fixtureRoomFactor(intensity.post, room.type);
      return { min: flat.min * base * intensity.min, max: flat.max * base * intensity.max };
    }
    const qty = intensity.basis === "walls" ? wallArea(floor) : intensity.basis === "room" ? 1 : floor;
    return { min: intensity.min * qty, max: intensity.max * qty };
  }

  for (const room of rooms) {
    const share = shares.get(room.id);
    if (share == null) continue;
    const floor = roomFloorArea(room.type, surf, share);
    const issues = room.issues || [];
    // Points compris dans un forfait coché (sol, murs, plafond d'une salle d'eau refaite).
    const covered = new Set(issues.flatMap((k) => covers[k] || []));
    const keys = issues.filter((k) => ISSUE_INTENSITY[k] && !covered.has(k));
    const amounts = new Map(keys.map((k) => [k, issueAmount(ISSUE_INTENSITY[k], room, floor)]));
    // Deux points du même poste ne se cumulent pas : le poste coûte le plus
    // cher des deux, réparti entre eux au prorata.
    const byPost = {};
    for (const k of keys) {
      const { post } = ISSUE_INTENSITY[k];
      const a = amounts.get(k);
      const p = byPost[post] || (byPost[post] = { min: 0, max: 0, sumMin: 0, sumMax: 0 });
      p.min = Math.max(p.min, a.min);
      p.max = Math.max(p.max, a.max);
      p.sumMin += a.min;
      p.sumMax += a.max;
    }
    for (const k of keys) {
      const intensity = ISSUE_INTENSITY[k];
      const a = amounts.get(k);
      const p = byPost[intensity.post];
      add(
        "issue:" + k,
        {
          label: issueLabel(k),
          post: intensity.post,
          priority: priorities[k] || "cosmetic",
          icon: issueIcon(k),
          fixture: Boolean(FIXTURE_FLAT_RATES[intensity.post]),
        },
        room.id,
        roomName(room),
        p.sumMin ? (p.min * a.min) / p.sumMin : 0,
        p.sumMax ? (p.max * a.max) / p.sumMax : 0
      );
    }
  }

  const global = globalWorkLines({ items: globalItems, rooms, surface: surf, propertyType });
  for (const line of global.lines) {
    items[line.id] = { ...line };
    order.push(line.id);
  }

  // Zone DPE faible : chiffrée en repli tant que le chantier correspondant n'a
  // été ni coché ni écarté dans « Logement entier ».
  const evaluated = new Set((globalItems || []).map((i) => i && i.key));
  for (const id of Object.keys(energy)) {
    const zone = dpeZones[id];
    const e = energy[id];
    if (!zone || zone.state !== "poor" || evaluated.has(ENERGY_ZONE_TO_GLOBAL[id])) continue;
    const copro = propertyType === "apartment" && e.building;
    const scaled = scaleEnergyCost(e, surf, energyRef);
    add(
      "energy:" + id,
      { label: e.label, post: "energy", priority: "comfort", icon: "zap", copro },
      null,
      null,
      scaled.min,
      scaled.max
    );
  }

  const list = order.map((id) => items[id]);
  let baseMin = 0;
  let baseMax = 0;
  list.forEach((i) => {
    if (i.copro) return;
    baseMin += i.min;
    baseMax += i.max;
  });

  // Frais de chantier : un pourcentage des autres travaux (copropriété exclue), sans cumul entre eux.
  let percentMin = 0;
  let percentMax = 0;
  if (baseMax > 0) {
    for (const line of global.percents) {
      const item = { ...line, min: baseMin * line.rate.min, max: baseMax * line.rate.max };
      percentMin += item.min;
      percentMax += item.max;
      list.push(item);
    }
  }
  const counted = list.filter((i) => !i.copro);
  const totalMin = baseMin + percentMin;
  const totalMax = baseMax + percentMax;

  const posts = (costs.posts || [])
    .map((p) => {
      const its = counted.filter((i) => i.post === p.key);
      let min = 0;
      let max = 0;
      its.forEach((i) => {
        min += i.min;
        max += i.max;
      });
      return { key: p.key, label: p.label, items: its, min, max };
    })
    .filter((p) => p.items.length);

  return {
    min: roundCost(totalMin),
    max: roundCost(totalMax),
    posts,
    items: list,
    copro: list.filter((i) => i.copro),
    byRoom,
    unavailableReason: null,
  };
}

/** Score de base d'une pièce selon son état général. */
export const CONDITION_SCORES = {
  new_or_recently_renovated: 95,
  very_good: 86,
  good: 74,
  average: 56,
  dated: 46,
  refresh_needed: 46,
  renovation_needed: 32,
  heavy_renovation_likely: 14,
};

/**
 * État général du logement d'après le plan des pièces (moyenne pondérée par
 * pièce, moins une pénalité par point coché), moins une pénalité pour les
 * chantiers de sécurité du logement entier (électricité, plomberie). Le score
 * de l'IA sert de repli tant qu'aucune pièce n'est évaluée.
 * @param {object} params
 * @param {object[]} params.rooms
 * @param {object[]} [params.globalItems] - `plan.global.items`
 * @param {Record<string, number>} [params.roomTypeFactors]
 * @param {Record<string, string>} [params.issueTones] - clé du point → "average" | "poor"
 * @param {number|null} [params.fallbackScore]
 */
export function computeHomeHealth({ rooms = [], globalItems = [], roomTypeFactors = {}, issueTones = {}, fallbackScore = null }) {
  let total = 0;
  let weights = 0;
  let assessed = 0;
  for (const room of rooms) {
    const base = CONDITION_SCORES[room.condition];
    const w = roomWeight(room.type, roomTypeFactors);
    if (base == null || !w) continue;
    let penalty = 0;
    for (const k of room.issues || []) penalty += issueTones[k] === "poor" ? 4 : 1.5;
    total += Math.max(0, base - Math.min(12, penalty)) * w;
    weights += w;
    assessed += 1;
  }
  const score = weights
    ? Math.max(0, Math.round(total / weights) - globalHealthPenalty(globalItems))
    : typeof fallbackScore === "number"
      ? fallbackScore
      : null;
  const tone = score == null ? "unknown" : score >= 68 ? "good" : score >= 45 ? "average" : "poor";
  const verdict =
    score == null
      ? "État général à préciser"
      : score >= 82
        ? "Très bon état général"
        : score >= 68
          ? "Bon état général"
          : score >= 52
            ? "État correct, quelques travaux"
            : score >= 36
              ? "Travaux à prévoir"
              : "Rénovation importante à prévoir";
  return { score, tone, verdict, assessed, fromPlan: Boolean(weights) };
}

const ISSUE_BASES = ["floor", "ceiling", "walls", "room"];

/** Vérifie que chaque point a un prix unitaire ou une part de forfait. */
export function validateEstimateBarème(issueKeys) {
  for (const key of issueKeys) {
    const intensity = ISSUE_INTENSITY[key];
    if (!intensity) return { ok: false, key };
    if (!ISSUE_BASES.includes(intensity.basis) && !FIXTURE_FLAT_RATES[intensity.post]) {
      return { ok: false, key, post: intensity.post };
    }
  }
  return { ok: true };
}

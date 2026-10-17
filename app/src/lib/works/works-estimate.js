/**
 * Chiffrage des travaux à partir de la surface du bien, du plan pièces
 * (cases cochées), des chantiers « Logement entier » et du DPE lié.
 * Montants TTC indicatifs.
 *
 * N'importe que des modules eux-mêmes servis au navigateur.
 */

import {
  ENERGY_ZONE_TO_GLOBAL,
  globalHealthPenalty,
  globalWorkLines,
} from "./works-global.js";

/**
 * Enveloppe des finitions et équipements de pièce « tout refait » : 70 % d'une
 * rénovation complète à 1 500–2 000 €/m², le reste (électricité, chauffage,
 * menuiseries) étant chiffré dans les chantiers du logement entier.
 */
export const ROOM_RENOVATION_EUR_M2 = { min: 1050, max: 1400 };

const POST_WEIGHTS = { floor: 14, walls: 19, ceiling: 7, humidity: 6, kitchen: 12, bathroom: 12 };
const POST_WEIGHT_SUM = Object.values(POST_WEIGHTS).reduce((a, b) => a + b, 0);

/** Parts de l'enveloppe des pièces (somme = 1). */
export const INTERIOR_POST_SHARES = Object.fromEntries(
  Object.entries(POST_WEIGHTS).map(([post, w]) => [post, w / POST_WEIGHT_SUM])
);

/** Intensité sur le budget poste × part de surface de la pièce. */
export const ISSUE_INTENSITY = {
  floor_worn: { post: "floor", min: 0.32, max: 0.42 },
  floor_redo: { post: "floor", min: 0.88, max: 1 },
  paint: { post: "walls", min: 0.48, max: 0.62 },
  walls_damaged: { post: "walls", min: 0.92, max: 1 },
  ceiling_paint: { post: "ceiling", min: 0.45, max: 0.6 },
  ceiling_damaged: { post: "ceiling", min: 0.9, max: 1 },
  humidity: { post: "humidity", min: 0.55, max: 0.75 },
  mold: { post: "humidity", min: 0.4, max: 0.6 },
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

function scaleEnergyCost(min, max, surface, refM2) {
  const ref = refM2 > 0 ? refM2 : ENERGY_SURFACE_REF_M2;
  const s = surface > 0 ? surface : ref;
  const ratio = s / ref;
  return { min: min * ratio, max: max * ratio };
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
  const shares = roomSurfaceShares(rooms, factors);
  // Cuisine et salle d'eau : le budget du logement se partage entre les seules
  // pièces où un point de ce poste est coché.
  const postShares = {};
  for (const post of costs.concentratedPosts || []) {
    postShares[post] = roomSurfaceShares(rooms, factors, (room) =>
      (room.issues || []).some((k) => ISSUE_INTENSITY[k]?.post === post)
    );
  }
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

  for (const room of rooms) {
    if (shares.get(room.id) == null) continue;
    const keys = (room.issues || []).filter((k) => ISSUE_INTENSITY[k]);
    // Une pièce ne peut pas consommer plus que la totalité d'un poste.
    const sumByPost = {};
    for (const k of keys) {
      const { post, min, max } = ISSUE_INTENSITY[k];
      const s = sumByPost[post] || (sumByPost[post] = { min: 0, max: 0 });
      s.min += min;
      s.max += max;
    }
    for (const k of keys) {
      const intensity = ISSUE_INTENSITY[k];
      const roomShare = postShares[intensity.post]
        ? postShares[intensity.post].get(room.id) ?? shares.get(room.id)
        : shares.get(room.id);
      const budget = INTERIOR_POST_SHARES[intensity.post] ?? 0;
      const sum = sumByPost[intensity.post];
      add(
        "issue:" + k,
        {
          label: issueLabel(k),
          post: intensity.post,
          priority: priorities[k] || "cosmetic",
          icon: issueIcon(k),
        },
        room.id,
        roomName(room),
        surf * ROOM_RENOVATION_EUR_M2.min * budget * roomShare * intensity.min / Math.max(1, sum.min),
        surf * ROOM_RENOVATION_EUR_M2.max * budget * roomShare * intensity.max / Math.max(1, sum.max)
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
    const scaled = scaleEnergyCost(e.min, e.max, surf, energyRef);
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
  const isRoomLine = (i) => i.post !== "energy" && !i.global;

  let interiorMin = 0;
  let interiorMax = 0;
  let otherMin = 0;
  let otherMax = 0;
  list.forEach((i) => {
    if (i.copro) return;
    if (isRoomLine(i)) {
      interiorMin += i.min;
      interiorMax += i.max;
    } else {
      otherMin += i.min;
      otherMax += i.max;
    }
  });
  // Au-delà de l'enveloppe « tout refait » des pièces, chaque ligne de pièce est réduite au prorata.
  const capMin = interiorMin > 0 ? Math.min(1, (surf * ROOM_RENOVATION_EUR_M2.min) / interiorMin) : 1;
  const capMax = interiorMax > 0 ? Math.min(1, (surf * ROOM_RENOVATION_EUR_M2.max) / interiorMax) : 1;
  if (capMin < 1 || capMax < 1) {
    list.forEach((i) => {
      if (!isRoomLine(i)) return;
      i.min *= capMin;
      i.max *= capMax;
    });
    Object.values(byRoom).forEach((r) => {
      r.min *= capMin;
      r.max *= capMax;
    });
  }
  const baseMin = interiorMin * capMin + otherMin;
  const baseMax = interiorMax * capMax + otherMax;

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

/** Vérifie que chaque point a une intensité sur un poste connu. */
export function validateEstimateBarème(issueKeys) {
  for (const key of issueKeys) {
    const intensity = ISSUE_INTENSITY[key];
    if (!intensity) return { ok: false, key };
    if (INTERIOR_POST_SHARES[intensity.post] == null) return { ok: false, key, post: intensity.post };
  }
  const shareSum = Object.values(INTERIOR_POST_SHARES).reduce((a, b) => a + b, 0);
  if (Math.abs(shareSum - 1) > 0.001) return { ok: false, reason: "post_shares" };
  return { ok: true };
}

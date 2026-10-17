/**
 * Résumé « Travaux à prévoir » de la fiche annonce. Seule source : le plan des
 * pièces (proposé par l'IA, corrigé par l'utilisateur), chiffré avec le même
 * moteur que la modale « Pièces et état ».
 */

import { CONDITION_TONES, DPE_CORRELATION_STATUS_LABELS } from "../photo-analysis/labels.js";
import { ROOM_TYPE_FACTORS, costsOptions, estimateWorksCosts, roundCost } from "./works-costs.js";
import { computeHomeHealth } from "./works-estimate.js";
import { PRIORITIES, ROOM_ISSUE_CATEGORIES, ROOM_ISSUES, issueLabel } from "./works-issues.js";
import { PLANNER_ROOM_CONDITION_LABELS, PLANNER_ROOM_LABELS } from "./works-plan.js";
import { dpeCoherence, placeUnplacedWorks, roomNeedsReview } from "./works-coherence.js";

const MAX_ROOM_ISSUES = 4;

const range = (min, max) => ({ min: roundCost(min), max: roundCost(max) });

/** Milieu de la fourchette travaux (même arrondi que le budget affiché). */
export function midpointWorksBudget(min, max) {
  if (min == null || max == null || !(max > 0)) return 0;
  const lo = Math.max(0, Number(min) || 0);
  const hi = Math.max(lo, Number(max) || 0);
  return roundCost((lo + hi) / 2);
}

function roomName(room) {
  return (room.label && String(room.label).trim()) || PLANNER_ROOM_LABELS[room.type] || "Pièce";
}

function issueIcon(key) {
  const issue = ROOM_ISSUES.find((i) => i.key === key);
  return ROOM_ISSUE_CATEGORIES.find((c) => c.key === issue?.category)?.icon || "hammer";
}

function dpeZoneMap(overview) {
  const map = {};
  for (const z of overview?.dpe?.zones || []) map[z.id] = z;
  return map;
}

const MAX_NEGOTIATION_ITEMS = 3;

/** Arguments de négociation tirés du plan : budget et travaux nécessaires chiffrés. */
function negotiationFromPlan(est) {
  if (est.unavailableReason || !(est.max > 0)) return [];
  const fmt = (n) => new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(roundCost(n));
  const out = [`Travaux estimés entre ${fmt(est.min)} et ${fmt(est.max)} € d'après l'état des pièces`];
  est.items
    .filter((i) => i.priority === "necessary" && !i.copro)
    .sort((a, b) => b.max - a.max)
    .slice(0, MAX_NEGOTIATION_ITEMS)
    .forEach((i) => {
      const where = i.rooms.length ? i.rooms.join(", ") : i.detail && i.detail !== "forfait" ? i.detail : "";
      out.push(`${i.label}${where ? ` (${where})` : ""} : ${fmt(i.min)} – ${fmt(i.max)} €`);
    });
  return out;
}

/**
 * @param {{ plan: object, overview: object, propertyType?: string, aiStatus?: string, aiNewer?: boolean }} input
 */
export function buildWorksSummary({ plan, overview, propertyType = "", aiStatus = "ready", aiNewer = false }) {
  const rooms = plan?.rooms || [];
  const globalItems = plan?.global?.items || [];
  const est = estimateWorksCosts({
    surface: overview?.surface ?? null,
    propertyType,
    rooms,
    globalItems,
    dpeZones: dpeZoneMap(overview),
    costs: costsOptions(),
    issueLabel,
    issueIcon,
    roomName,
  });

  const roomRows = rooms.map((room) => {
    const issues = ROOM_ISSUES.filter((i) => (room.issues || []).includes(i.key));
    const cost = est.byRoom?.[room.id] || null;
    return {
      id: room.id,
      name: roomName(room),
      condition: PLANNER_ROOM_CONDITION_LABELS[room.condition] || "",
      tone: CONDITION_TONES[room.condition] || "unknown",
      needsReview: roomNeedsReview(room),
      issues: issues.slice(0, MAX_ROOM_ISSUES).map((i) => ({ label: i.label, tone: i.tone })),
      moreIssues: Math.max(0, issues.length - MAX_ROOM_ISSUES),
      cost: cost && cost.max > 0 ? range(cost.min, cost.max) : null,
    };
  });

  const priorities = PRIORITIES.map((p) => {
    const items = est.items.filter((i) => i.priority === p.key && !i.copro);
    return {
      key: p.key,
      label: p.label,
      ...range(items.reduce((s, i) => s + i.min, 0), items.reduce((s, i) => s + i.max, 0)),
      count: items.length,
    };
  }).filter((p) => p.count);

  const withWork = roomRows.filter((r) => r.issues.length);
  const health = computeHomeHealth({
    rooms,
    globalItems,
    roomTypeFactors: ROOM_TYPE_FACTORS,
    issueTones: Object.fromEntries(ROOM_ISSUES.map((i) => [i.key, i.tone])),
    fallbackScore: overview?.condition?.score ?? null,
  });
  const unplaced = placeUnplacedWorks(overview?.unplacedWorks || [], rooms, roomName).map((w) => ({
    ...w,
    missingLabels: w.missingIssues.map(issueLabel),
  }));
  return {
    health,
    aiInitial: overview?.renovation?.text || "",
    aiNewer,
    unplaced,
    dpeChecks: dpeCoherence({ rooms, globalItems, health, dpe: overview?.dpe || null, photoSignals: overview?.photoSignals || {} }).map(
      (c) => ({ ...c, statusLabel: DPE_CORRELATION_STATUS_LABELS[c.status] || "" })
    ),
    negotiation: negotiationFromPlan(est),
    aiPending: aiStatus === "pending",
    hasRooms: rooms.length > 0,
    unavailableReason: est.unavailableReason,
    surface: overview?.surface ?? null,
    min: est.min,
    max: est.max,
    rooms: [...withWork, ...roomRows.filter((r) => !r.issues.length && r.needsReview)],
    cleanRooms: roomRows.filter((r) => !r.issues.length && !r.needsReview).map((r) => r.name),
    reviewCount: roomRows.filter((r) => r.needsReview).length,
    priorities,
    globalWorks: est.items.filter((i) => i.global).map((i) => ({ label: i.label, detail: i.detail, ...range(i.min, i.max) })),
    energy: est.items.filter((i) => i.post === "energy" && !i.copro).map((i) => ({ label: i.label, ...range(i.min, i.max) })),
    copro: est.copro.map((i) => ({ label: i.label, ...range(i.min, i.max) })),
  };
}

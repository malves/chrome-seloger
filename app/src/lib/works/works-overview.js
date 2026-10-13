/**
 * Récapitulatif « Maison / Appartement » de la modale « Pièces et état » :
 * la partie fixe (analyse IA, DPE lié, incohérences relevées côté serveur).
 * Ce qui dépend du plan édité (pièces, travaux, chiffrage) est calculé par
 * la modale elle-même.
 */

import {
  CLAIM_STATUS_LABELS,
  CONDITION_LABELS,
  CONDITION_TONES,
  RENOVATION_LEVEL_LABELS,
  RENOVATION_LEVEL_TONES,
} from "../photo-analysis/labels.js";
import { dominantApparentAge } from "../photo-analysis/dpe-correlation.js";
import { unplacedWorkSources } from "./works-seed-sources.js";

const PROPERTY_LABELS = { house: "Maison", apartment: "Appartement" };

const RENOVATED_CLAIM = /\b(?:r[ée]nov[ée](?:e|s|es)?|refait(?:e|s|es)?\s+à\s+neuf|aucuns?\s+travaux)(?!\p{L})/iu;

const MAX_ALERTS = 12;

function clean(list, max) {
  return (Array.isArray(list) ? list : [])
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean)
    .slice(0, max);
}

function conditionOf(a) {
  const c = a.overall_condition || {};
  const score = typeof c.score === "number" ? Math.max(0, Math.min(100, Math.round(c.score))) : null;
  if (score == null && !c.label) return null;
  return {
    score,
    label: c.label || "unknown",
    text: CONDITION_LABELS[c.label] || "",
    tone: CONDITION_TONES[c.label] || "unknown",
  };
}

function renovationOf(a) {
  const r = a.renovation || {};
  if (!r.level || r.level === "unknown") return null;
  return {
    level: r.level,
    text: RENOVATION_LEVEL_LABELS[r.level] || "",
    tone: RENOVATION_LEVEL_TONES[r.level] || "unknown",
    cosmeticOnly: Boolean(r.cosmetic_only_suspected),
    note: r.note || null,
  };
}

/** Équipements visibles sur les photos, utiles au croisement plan × DPE (works-coherence.js). */
function photoSignalsOf(a) {
  if (!a) return {};
  return {
    windowsAge: dominantApparentAge(a.rooms, "windows"),
    heatingEquipments: [
      ...new Set(
        (a.rooms || [])
          .map((r) => r?.heating?.equipment)
          .filter((e) => e && e !== "unknown" && e !== "none_visible")
      ),
    ],
  };
}

function analysisAlerts(a) {
  const alerts = [];
  for (const c of a.description_contradictions || []) {
    if (c.status !== "contradicted" && c.status !== "partially_supported") continue;
    alerts.push({
      source: "description",
      tone: c.status === "contradicted" ? "poor" : "average",
      title: `« ${c.claim} »`,
      text: [CLAIM_STATUS_LABELS[c.status], c.reason].filter(Boolean).join(" : "),
    });
  }
  const inconsistency = a.possible_photo_inconsistency;
  if (inconsistency?.status) {
    alerts.push({
      source: "photos",
      tone: "average",
      title: "Photos difficilement compatibles",
      text: inconsistency.note || "Certaines photos semblent difficilement compatibles entre elles. À vérifier avec l'agence.",
    });
  }
  for (const note of clean(a.structured_data_notes, 4)) {
    alerts.push({ source: "data", tone: "average", title: "Annonce et photos", text: note });
  }
  return alerts;
}

function dpeAlerts(listing, dpeInsights) {
  const alerts = [];
  if (dpeInsights.isExpired) {
    alerts.push({
      source: "dpe",
      tone: "average",
      title: "DPE expiré",
      text: `Le diagnostic n'est plus valable depuis le ${dpeInsights.validUntil} : demandez un DPE à jour.`,
    });
  }
  const letter = dpeInsights.hero?.dpe?.letter;
  if ((letter === "F" || letter === "G") && RENOVATED_CLAIM.test(listing.description || "")) {
    alerts.push({
      source: "dpe",
      tone: "poor",
      title: `Annonce « rénovée » mais DPE ${letter}`,
      text: "La description met en avant une rénovation alors que l'étiquette énergie reste très basse : la rénovation est probablement cosmétique, ou postérieure au diagnostic.",
    });
  }
  if (listing.dpe && letter && String(listing.dpe).trim().toUpperCase() !== letter) {
    alerts.push({
      source: "dpe",
      tone: "average",
      title: "Étiquette différente de l'annonce",
      text: `L'annonce indique un DPE ${String(listing.dpe).trim().toUpperCase()}, le diagnostic lié à l'adresse un DPE ${letter}.`,
    });
  }
  return alerts;
}

function dpeOf(dpeInsights) {
  if (!dpeInsights) return null;
  const hero = dpeInsights.hero || {};
  return {
    letter: hero.dpe?.letter || null,
    tone: hero.dpe?.tone || "unknown",
    ges: hero.ges?.letter || null,
    verdict: hero.verdict || "",
    budget: hero.budget ? { annual: hero.budget.annualLabel, monthly: hero.budget.monthlyLabel } : null,
    validUntil: dpeInsights.validUntil || null,
    date: dpeInsights.dateEtablissement || null,
    expired: Boolean(dpeInsights.isExpired),
    zones: (dpeInsights.zones || []).map((z) => ({ id: z.id, label: z.label, state: z.state, title: z.title })),
    counts: dpeInsights.counts || null,
  };
}

/**
 * @param {object} listing
 * @param {object|null} stored - sortie de `readStored` (analyse des photos)
 * @param {object|null} dpeInsights - `buildDpeInsights` du DPE lié
 * @param {string[]} [photos] - URLs de la galerie (situer les travaux hors pièces)
 */
export function buildWorksOverview(listing, stored, dpeInsights = null, photos = []) {
  const a = stored?.ready && stored.status === "ok" ? stored : null;
  const propertyType = listing.property_type === "house" || listing.property_type === "apartment" ? listing.property_type : null;
  const alerts = [
    ...(dpeInsights ? dpeAlerts(listing, dpeInsights) : []),
    ...(a ? analysisAlerts(a) : []),
  ];
  alerts.sort((x, y) => (x.tone === "poor" ? 0 : 1) - (y.tone === "poor" ? 0 : 1));

  return {
    propertyType,
    propertyLabel: PROPERTY_LABELS[propertyType] || "Logement",
    surface: listing.surface ?? null,
    roomsAnnounced: listing.rooms ?? null,
    bedrooms: listing.bedrooms ?? null,
    analysisReady: Boolean(a),
    condition: a ? conditionOf(a) : null,
    renovation: a ? renovationOf(a) : null,
    summary: a?.summary || "",
    alerts: alerts.slice(0, MAX_ALERTS),
    dpe: dpeOf(dpeInsights),
    photoSignals: photoSignalsOf(a),
    unplacedWorks: unplacedWorkSources(a, photos),
  };
}

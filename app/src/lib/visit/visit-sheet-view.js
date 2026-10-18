/**
 * Construit la view-model de la page « Préparer la visite ».
 *
 * Combine : le catalogue curé (étapes du déroulé de visite), les valeurs
 * résolues (provenance), les faits structurés de l'analyse photo (qui
 * déclenchent ou annotent des questions du catalogue, jamais de question
 * rédigée par le modèle), et les données de marché (durée de suivi, baisses
 * de prix). Dans chaque étape, les questions dont la valeur est déjà connue
 * portent `known` : l'interface les présente « À confirmer », les autres
 * « À découvrir ». Les textes libres de l'analyse sont relégués dans
 * `photoNotes` (encart informatif du bilan).
 */

import {
  VISIT_SECTIONS,
  VISIT_THEMES,
  VISIT_QUESTIONS,
  questionApplies,
  questionTriggered,
  questionHasPhotoFact,
} from "./visit-questions.js";
import { photoFactsFrom, matchingFacts, fillTemplate } from "./visit-photo-facts.js";
import { computeInsights, questionInMode } from "./visit-insights.js";
import { normalizeVisitMode, resolveQuestionLevels } from "./visit-question-levels.js";
import { SOURCE_LABELS, SOURCE_SHORT, ORIGIN_LABELS } from "../listing-field-provenance.js";
import { daysSince } from "../time.js";

const NF = typeof Intl !== "undefined" ? new Intl.NumberFormat("fr-FR") : null;

function num(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  return NF ? NF.format(v) : String(v);
}

function formatValueLabel(resolved) {
  if (!resolved || resolved.value === null || resolved.value === undefined) return null;
  const v = resolved.value;
  if (resolved.type === "number" || resolved.type === "int") {
    return resolved.unit ? `${num(v)} ${resolved.unit}` : num(v);
  }
  if (resolved.type === "letter") return String(v).toUpperCase();
  return String(v);
}

function pickFmt(fmt, name, fallback) {
  return fmt && typeof fmt[name] === "function" ? fmt[name].bind(fmt) : fallback;
}

function buildItem(q, { resolved, answers, photoFacts, levels }) {
  const info = q.field ? resolved[q.field] || null : null;
  const known = Boolean(info && info.known);
  const answer = (answers && answers[q.id]) || null;
  const photoMatched = questionHasPhotoFact(q, photoFacts);
  const fact = photoMatched ? matchingFacts(q.photo.facts, photoFacts) : null;
  const photoTriggered = Boolean(q.photo && q.photo.required && photoMatched);
  const photoHint = photoMatched && q.photo.hint ? fillTemplate(q.photo.hint, fact) : null;
  const previous =
    known && info.previous
      ? {
          value: info.previous.value,
          source: info.previous.source,
          sourceLabel: SOURCE_LABELS[info.previous.source] || null,
          label: formatValueLabel({ ...info, value: info.previous.value, source: info.previous.source }),
        }
      : null;
  const level = (levels && levels[q.id]) || (q.essential ? "essential" : "expert");
  return {
    id: q.id,
    section: q.section,
    theme: q.theme,
    level,
    essential: level === "essential",
    promoted: Boolean(photoTriggered || photoHint),
    question: fact ? fillTemplate(q.question, fact) : q.question,
    proTip: q.proTip || null,
    field: q.field || null,
    input: q.input,
    showWhen: q.showWhen || null,
    signals: Array.isArray(q.signals) ? q.signals : [],
    photoTriggered,
    photoHint,
    known,
    value: known ? info.value : null,
    valueLabel: known
      ? formatValueLabel({
          ...info,
          unit: (q.input && q.input.unit) || info.unit || null,
        })
      : null,
    unit: (q.input && q.input.unit) || (info && info.unit) || null,
    source: known ? info.source : null,
    sourceLabel: known ? SOURCE_LABELS[info.source] || null : null,
    sourceShort: known ? SOURCE_SHORT[info.source] || null : null,
    confirmed: known ? info.confirmed : false,
    originLabel: known && info.origin ? ORIGIN_LABELS[info.origin] || null : null,
    previous,
    answer,
  };
}

/**
 * Textes libres de l'analyse photo (questions, contrôles, arguments) :
 * affichés tels quels dans un encart du bilan, jamais transformés en
 * questions. Le vocabulaire fermé (anomalies, cuisine, SDB, vitrage,
 * contradictions) passe par visit-photo-facts.js et le catalogue.
 */
function photoNotesFrom(photoAnalysis) {
  const clean = (list, max) =>
    (Array.isArray(list) ? list : [])
      .map((t) => (typeof t === "string" ? t.trim() : ""))
      .filter(Boolean)
      .slice(0, max);
  if (!photoAnalysis || photoAnalysis.ready === false) {
    return { questions: [], checks: [], negotiation: [], total: 0 };
  }
  const questions = clean(photoAnalysis.visitQuestions, 8);
  const checks = clean(photoAnalysis.visitChecks, 8);
  const negotiation = clean(
    (photoAnalysis.negotiationPoints || []).map((p) => p && p.label),
    6
  );
  return { questions, checks, negotiation, total: questions.length + checks.length + negotiation.length };
}

/** Données de marché utiles à la négociation. */
function marketFacts(listing, priceHistory) {
  const days = Math.floor(daysSince(listing.first_saved_at));
  const points = Array.isArray(priceHistory) ? priceHistory : [];
  let drops = 0;
  let firstPrice = null;
  let lastPrice = null;
  if (points.length >= 2) {
    firstPrice = Number(points[0].price) || null;
    lastPrice = Number(points[points.length - 1].price) || null;
    for (let i = 1; i < points.length; i += 1) {
      if (Number(points[i].price) < Number(points[i - 1].price)) drops += 1;
    }
  }
  return {
    daysOnMarket: Number.isFinite(days) && days >= 0 ? days : null,
    priceDrops: drops,
    priceDelta: firstPrice && lastPrice && lastPrice < firstPrice ? firstPrice - lastPrice : 0,
    firstPrice,
    lastPrice,
  };
}

/**
 * @param {object} args
 * @param {object} args.listing
 * @param {string|null} args.photo première photo
 * @param {Record<string,object>} args.resolved sortie de resolveAll
 * @param {object|null} args.photoAnalysis view-model analyse photo
 * @param {Array} args.priceHistory
 * @param {object} args.sheet état stocké { visit: { applyToSheet, answers } }
 * @param {boolean} [args.isCopro] bien signalé en copropriété
 * @param {object} [args.fmt] helpers de formatage (res.locals.fmt)
 * @param {object} [args.questionConfig] { levels, order } (resolveQuestionLevels)
 */
export function buildVisitSheet({
  listing,
  photo = null,
  resolved = {},
  photoAnalysis = null,
  priceHistory = [],
  sheet = null,
  isCopro = false,
  fmt = null,
  questionConfig = null,
}) {
  const euro = pickFmt(fmt, "euro", (n) => `${num(n)} €`);
  const sourceLabel = pickFmt(fmt, "sourceLabel", (s) => s || "Annonce");
  const propertyTypeLabel = pickFmt(fmt, "propertyTypeLabel", () => null);
  const transactionLabel = pickFmt(fmt, "transactionLabel", () => null);
  const statusBadgeLabel = pickFmt(fmt, "statusBadgeLabel", (s) => s || null);

  const answers = (sheet && sheet.visit && sheet.visit.answers) || {};
  const applyToSheet =
    sheet && sheet.visit && typeof sheet.visit.applyToSheet === "boolean"
      ? sheet.visit.applyToSheet
      : null;
  const mode = normalizeVisitMode(sheet && sheet.visit && sheet.visit.mode);
  const expertNudgeSeen = Boolean(sheet && sheet.visit && sheet.visit.expertNudgeSeen);
  const config = questionConfig || resolveQuestionLevels(null);

  const audience = { propertyType: listing.property_type || null, isCopro: Boolean(isCopro) };
  const photoFacts = photoFactsFrom(photoAnalysis);
  const catalog = VISIT_QUESTIONS.filter(
    (q) => questionApplies(q, audience) && questionTriggered(q, photoFacts)
  );
  const rank = {};
  for (const ids of Object.values(config.order || {})) ids.forEach((id, i) => (rank[id] = i));
  const allItems = catalog
    .map((q) => buildItem(q, { resolved, answers, photoFacts, levels: config.levels }))
    .sort((a, b) => (rank[a.id] ?? 1e6) - (rank[b.id] ?? 1e6));
  const photoNotes = photoNotesFrom(photoAnalysis);

  const sections = VISIT_SECTIONS.map((sec, index) => {
    const items = allItems.filter((it) => it.section === sec.id);
    const expertOnly = items.filter((it) => !questionInMode(it, answers, "essential")).length;
    return {
      id: sec.id,
      index: index + 1,
      label: sec.label,
      lead: sec.lead,
      icon: sec.icon,
      items,
      total: items.length,
      discover: items.filter((it) => !it.known).length,
      confirm: items.filter((it) => it.known).length,
      expertOnly,
    };
  }).filter((sec) => sec.total > 0);

  const themes = VISIT_THEMES.map((t) => ({
    ...t,
    total: allItems.filter((it) => it.theme === t.id).length,
  })).filter((t) => t.total > 0);

  const market = marketFacts(listing, priceHistory);
  const insights = computeInsights({
    items: allItems,
    answers,
    market,
    listing: { price: listing.price, surface: resolved.surface && resolved.surface.value },
    mode,
  });

  return {
    listing: {
      id: listing.id,
      title:
        (fmt && typeof fmt.listingTitle === "function"
          ? fmt.listingTitle(listing.title, listing.price)
          : listing.title) ||
        propertyTypeLabel(listing.property_type) ||
        "Annonce",
      address:
        (listing.user_address && String(listing.user_address).trim()) ||
        [listing.postal_code, listing.city].filter(Boolean).join(" ") ||
        listing.city ||
        null,
      city: listing.city || null,
      postalCode: listing.postal_code || null,
      origin: sourceLabel(listing.source),
      price: listing.price ?? null,
      propertyType: listing.property_type || null,
      propertyTypeLabel: propertyTypeLabel(listing.property_type) || null,
      transactionTypeLabel: transactionLabel(listing.transaction_type) || null,
      status: listing.status || null,
      statusLabel: statusBadgeLabel(listing.status),
      photo: photo || null,
      surface: resolved.surface && resolved.surface.known ? resolved.surface.value : null,
      rooms: resolved.rooms && resolved.rooms.known ? resolved.rooms.value : null,
      dpe: resolved.dpe && resolved.dpe.known ? resolved.dpe.value : null,
    },
    applyToSheet,
    mode,
    expertNudgeSeen,
    sections,
    themes,
    photoNotes,
    market: {
      ...market,
      priceDeltaLabel: market.priceDelta > 0 ? euro(market.priceDelta) : null,
    },
    insights,
    counts: {
      discover: insights.counts.discover,
      confirm: insights.counts.confirm,
      answered: insights.counts.answered,
      total: insights.counts.total,
      essentials: insights.counts.essentials,
      all: allItems.length,
      inEssential: allItems.filter((it) => questionInMode(it, {}, "essential")).length,
      hiddenBySection: Object.fromEntries(sections.map((s) => [s.id, s.expertOnly])),
    },
  };
}

export default buildVisitSheet;

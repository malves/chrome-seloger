/**
 * Passe B : synthèse du logement.
 *
 * Un seul appel : contexte de l'annonce + fiches par image (passe A) + images
 * réelles exploitables en basse définition (pour comparer les pièces entre
 * elles). La sortie (pièces logiques, anomalies, travaux, points forts,
 * cohérence, synthèse, visite) est normalisée vers des vocabulaires fermés et
 * chaque conclusion garde la trace des images qui la fondent.
 */

import { z } from "zod";
import * as E from "../../lib/photo-analysis/enums.js";
import { SYNTHESIS_SYSTEM, listingContextText } from "./prompts.js";
import {
  EXCLUDED_POTENTIAL_WORK_TYPES,
  filterPotentialWorks,
  usableForWorks,
} from "../../lib/photo-analysis/works.js";
import { ANALYSIS_ISSUE_KEYS } from "../../lib/works/works-issues.js";

const { coerceEnum, clampConfidence, clampScore, cleanText, cleanTextList } = E;

const loose = z.record(z.string(), z.unknown());
const synthesisSchema = loose;

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const bool = (v, fallback = false) => (typeof v === "boolean" ? v : fallback);
const ids = (v) => cleanTextList(v, { max: 40, maxLength: 20 });

const EXTERIOR_CONDITIONS = ["very_good", "good", "average", "dated", "poor", "not_assessable"];

/** Champ par image recopié depuis la passe A pour alléger le prompt. */
function compactRecord(record) {
  const o = record.observations || {};
  return {
    id: record.id,
    position: record.order,
    classification: record.classification,
    usable_for_condition_analysis: record.usable_for_condition_analysis,
    virtual_content: record.virtual_content,
    room_type: record.room_type,
    room_confidence: record.room_confidence,
    quality: record.quality,
    wide_angle_likely: record.wide_angle_likely,
    brightness_edit: record.brightness_edit,
    observations: {
      floor: o.floor,
      walls: o.walls,
      ceiling: o.ceiling,
      windows: o.windows,
      heating: o.heating,
      electrical: o.electrical,
      storage: o.storage,
      brightness: o.brightness,
      view: o.view,
      ceiling_height: o.ceiling_height,
      space_feeling: o.space_feeling,
      kitchen: o.kitchen,
      bathroom: o.bathroom,
      exterior: o.exterior,
      visible_text: o.visible_text,
      notable_positive: o.notable_positive,
      possible_defects: o.possible_defects,
    },
  };
}

/** Points à refaire d'une pièce, filtrés sur le vocabulaire de l'analyse. */
export function normalizeRoomIssues(rawIssues, rawReasons) {
  const issues = [...new Set(arr(rawIssues).filter((k) => ANALYSIS_ISSUE_KEYS.includes(k)))];
  const reasons = {};
  const source = obj(rawReasons) || {};
  for (const key of issues) {
    const reason = cleanText(source[key], 160);
    if (reason) reasons[key] = reason;
  }
  return { issues, issue_reasons: reasons };
}

function normalizeRoom(raw, index) {
  const r = obj(raw);
  if (!r) return null;
  const imageIds = ids(r.image_ids);
  const roomType = coerceEnum(r.room_type, E.ROOM_TYPES);
  const floor = obj(r.floor);
  const walls = obj(r.walls);
  const ceiling = obj(r.ceiling);
  const windows = obj(r.windows);
  const heating = obj(r.heating);
  const kitchen = obj(r.kitchen);
  const bathroom = obj(r.bathroom);
  const view = obj(r.view);
  return {
    room_id: cleanText(r.room_id, 30) || `room_${String(index + 1).padStart(2, "0")}`,
    room_type: roomType,
    label: cleanText(r.label, 60) || null,
    image_ids: imageIds,
    confidence: clampConfidence(r.confidence),
    condition: coerceEnum(r.condition, E.ROOM_CONDITIONS, "not_assessable"),
    condition_confidence: clampConfidence(r.condition_confidence),
    size_class: coerceEnum(r.size_class, E.SIZE_CLASSES),
    summary: cleanText(r.summary, 500),
    ...normalizeRoomIssues(r.issues, r.issue_reasons),
    floor: floor
      ? {
          material: coerceEnum(floor.material, E.FLOOR_MATERIALS),
          condition: coerceEnum(floor.condition, E.SURFACE_CONDITIONS),
          apparent_age: coerceEnum(floor.apparent_age, E.APPARENT_AGES),
          potential_work: cleanText(floor.potential_work, 120),
          confidence: clampConfidence(floor.confidence),
        }
      : null,
    walls: walls
      ? {
          condition: coerceEnum(walls.condition, E.SURFACE_CONDITIONS),
          notes: cleanText(walls.notes),
          confidence: clampConfidence(walls.confidence),
        }
      : null,
    ceiling: ceiling
      ? {
          condition: coerceEnum(ceiling.condition, E.SURFACE_CONDITIONS),
          notes: cleanText(ceiling.notes),
          confidence: clampConfidence(ceiling.confidence),
        }
      : null,
    windows: windows
      ? {
          material: coerceEnum(windows.material, E.WINDOW_MATERIALS),
          apparent_age: coerceEnum(windows.apparent_age, E.APPARENT_AGES),
          glazing: coerceEnum(windows.glazing, E.GLAZINGS),
          replacement_may_be_relevant: bool(windows.replacement_may_be_relevant),
          confidence: clampConfidence(windows.confidence),
        }
      : null,
    heating: heating
      ? {
          equipment: coerceEnum(heating.equipment, E.HEATING_EQUIPMENTS),
          apparent_age: coerceEnum(heating.apparent_age, E.APPARENT_AGES),
          modernization_may_be_relevant: bool(heating.modernization_may_be_relevant),
          confidence: clampConfidence(heating.confidence),
        }
      : null,
    kitchen: kitchen
      ? {
          layout: coerceEnum(kitchen.layout, E.KITCHEN_LAYOUTS),
          condition: coerceEnum(kitchen.condition, E.KITCHEN_CONDITIONS, "not_assessable"),
          apparent_age: coerceEnum(kitchen.apparent_age, E.APPARENT_AGES),
          notes: cleanText(kitchen.notes),
          confidence: clampConfidence(kitchen.confidence),
        }
      : null,
    bathroom: bathroom
      ? {
          condition: coerceEnum(bathroom.condition, E.ROOM_CONDITIONS, "not_assessable"),
          functional_appearance: coerceEnum(bathroom.functional_appearance, [
            "probably_usable",
            "doubtful",
            "unknown",
          ]),
          renovation_level: coerceEnum(bathroom.renovation_level, E.BATHROOM_RENOVATION_LEVELS),
          notes: cleanText(bathroom.notes),
          confidence: clampConfidence(bathroom.confidence),
        }
      : null,
    brightness: coerceEnum(r.brightness, E.BRIGHTNESS_LEVELS, "not_assessable"),
    view: view
      ? {
          type: coerceEnum(view.type, E.VIEW_TYPES, "not_assessable"),
          overlooking: coerceEnum(view.overlooking, ["high", "medium", "low", "unknown"]),
          confidence: clampConfidence(view.confidence),
        }
      : null,
    ceiling_height: coerceEnum(r.ceiling_height, E.CEILING_HEIGHTS),
    storage: coerceEnum(r.storage, ["good", "some", "none_visible", "unknown"]),
    strengths: cleanTextList(r.strengths, { max: 8, maxLength: 120 }),
  };
}

function normalizeExteriorBlock(raw) {
  const x = obj(raw);
  if (!x) return null;
  return {
    condition: coerceEnum(x.condition, EXTERIOR_CONDITIONS, "not_assessable"),
    notes: cleanText(x.notes),
    image_ids: ids(x.image_ids),
  };
}

function normalizeExterior(raw) {
  const x = obj(raw);
  if (!x) return { facade: null, common_areas: null, outdoor_spaces: [], to_check_in_documents: [] };
  return {
    facade: normalizeExteriorBlock(x.facade),
    common_areas: normalizeExteriorBlock(x.common_areas),
    outdoor_spaces: arr(x.outdoor_spaces)
      .map(obj)
      .filter(Boolean)
      .map((s) => ({
        type: coerceEnum(s.type, ["balcony", "terrace", "garden", "courtyard", "unknown"]),
        condition: coerceEnum(s.condition, EXTERIOR_CONDITIONS, "not_assessable"),
        size_class: coerceEnum(s.size_class, E.SIZE_CLASSES),
        notes: cleanText(s.notes),
        image_ids: ids(s.image_ids),
      }))
      .slice(0, 6),
    to_check_in_documents: cleanTextList(x.to_check_in_documents, { max: 6, maxLength: 200 }),
  };
}

function normalizeRelationships(raw) {
  return arr(raw)
    .map(obj)
    .filter(Boolean)
    .map((r) => {
      const relationship = coerceEnum(r.relationship, E.RELATIONSHIP_TYPES, "near_duplicate");
      const current = cleanText(r.current_image, 20);
      const projected = cleanText(r.projected_image, 20);
      const imageIds = ids(r.image_ids);
      if (relationship === "current_vs_projected") {
        for (const id of [current, projected]) if (id && !imageIds.includes(id)) imageIds.push(id);
      }
      return {
        relationship,
        image_ids: imageIds,
        current_image: current,
        projected_image: projected,
        confidence: clampConfidence(r.confidence),
      };
    })
    .filter((r) => r.image_ids.length >= 2)
    .slice(0, 30);
}

function normalizeAnomalies(raw) {
  return arr(raw)
    .map(obj)
    .filter(Boolean)
    .map((a, i) => ({
      finding_id: `anomaly_${String(i + 1).padStart(2, "0")}`,
      type: coerceEnum(a.type, E.ANOMALY_TYPES, "other"),
      crack_level: a.crack_level ? coerceEnum(a.crack_level, E.CRACK_LEVELS) : null,
      room_id: cleanText(a.room_id, 30),
      severity: coerceEnum(a.severity, E.SEVERITIES, "medium"),
      confidence: clampConfidence(a.confidence),
      image_ids: ids(a.image_ids),
      observation: cleanText(a.observation, 400) || "",
      interpretation: cleanText(a.interpretation, 400),
      needs_confirmation: true,
    }))
    .filter((a) => a.observation)
    .slice(0, 20);
}

function normalizeWorks(raw) {
  return filterPotentialWorks(
    arr(raw)
      .map(obj)
      .filter(Boolean)
      .filter((w) => !EXCLUDED_POTENTIAL_WORK_TYPES.has(String(w.work_type || "")))
      .map((w, i) => {
        const quantity =
          typeof w.quantity === "number" && Number.isFinite(w.quantity) && w.quantity > 0
            ? Math.round(w.quantity * 10) / 10
            : null;
        return {
          work_id: `work_${String(i + 1).padStart(2, "0")}`,
          work_type: coerceEnum(w.work_type, E.WORK_TYPES, "other"),
          label: cleanText(w.label, 120),
          room_id: cleanText(w.room_id, 30),
          necessity: coerceEnum(w.necessity, E.WORK_NECESSITIES, "possible"),
          scope: coerceEnum(w.scope, E.WORK_SCOPES),
          category: coerceEnum(w.category, E.WORK_CATEGORIES, "cosmetic"),
          area: coerceEnum(w.area, E.WORK_AREAS, "private"),
          quantity,
          confidence: clampConfidence(w.confidence),
          image_ids: ids(w.image_ids),
          rationale: cleanText(w.rationale, 400),
        };
      })
      .slice(0, 25)
  );
}

function normalizeLabeled(raw, { withSeverity = false, max = 15 } = {}) {
  return arr(raw)
    .map((item) => (typeof item === "string" ? { label: item } : obj(item)))
    .filter(Boolean)
    .map((s) => ({
      label: cleanText(s.label, 200) || "",
      ...(withSeverity ? { severity: coerceEnum(s.severity, E.SEVERITIES, "medium") } : {}),
      confidence: clampConfidence(s.confidence),
      image_ids: ids(s.image_ids),
    }))
    .filter((s) => s.label)
    .slice(0, max);
}

function normalizeContradictions(raw) {
  return arr(raw)
    .map(obj)
    .filter(Boolean)
    .map((c) => ({
      claim: cleanText(c.claim, 160) || "",
      subject: coerceEnum(c.subject, E.CLAIM_SUBJECTS, "unclear"),
      status: coerceEnum(c.status, E.CLAIM_STATUSES, "not_verifiable"),
      reason: cleanText(c.reason, 400),
      image_ids: ids(c.image_ids),
    }))
    .filter((c) => c.claim)
    .slice(0, 12);
}

/** Normalise la réponse brute de la passe B. */
export function normalizeSynthesis(raw) {
  const s = obj(raw) || {};
  const renovation = obj(s.renovation) || {};
  const inconsistency = obj(s.possible_photo_inconsistency) || {};
  return {
    rooms: arr(s.rooms).map(normalizeRoom).filter(Boolean).slice(0, 30),
    exterior: normalizeExterior(s.exterior),
    image_relationships: normalizeRelationships(s.image_relationships),
    anomalies: normalizeAnomalies(s.anomalies),
    potential_works: normalizeWorks(s.potential_works),
    strengths: normalizeLabeled(s.strengths),
    warnings: normalizeLabeled(s.warnings, { withSeverity: true }),
    description_contradictions: normalizeContradictions(s.description_contradictions),
    structured_data_notes: cleanTextList(s.structured_data_notes, { max: 6, maxLength: 300 }),
    renovation: {
      level: coerceEnum(renovation.level, E.RENOVATION_LEVELS),
      confidence: clampConfidence(renovation.confidence),
      cosmetic_only_suspected: bool(renovation.cosmetic_only_suspected),
      note: cleanText(renovation.note, 400),
    },
    condition_score: clampScore(s.condition_score),
    condition_label: coerceEnum(s.condition_label, E.CONDITION_LABELS),
    condition_confidence: clampConfidence(s.condition_confidence),
    wide_angle_likely: bool(s.wide_angle_likely),
    possible_photo_inconsistency: {
      status: bool(inconsistency.status),
      confidence: clampConfidence(inconsistency.confidence, 0),
      note: cleanText(inconsistency.note, 300),
    },
    architectural_character: cleanText(s.architectural_character, 400),
    renovation_potential: cleanText(s.renovation_potential, 400),
    summary: cleanText(s.summary, 1500) || "",
    visit_questions: cleanTextList(s.visit_questions, { max: 10, maxLength: 300 }),
    visit_checks: cleanTextList(s.visit_checks, { max: 12, maxLength: 300 }),
    negotiation_points: normalizeLabeled(s.negotiation_points, { max: 10 }),
  };
}

export default function createSynthesisPassService({ client, logger, vision = {} } = {}) {
  const detail = vision.synthesisImageDetail || "high";

  /**
   * @param {object} listing
   * @param {object[]} records - fiches de la passe A
   * @param {object[]} images - images téléchargées (pour les data URLs)
   */
  async function run(listing, records, images) {
    const byId = new Map(images.map((img) => [img.id, img]));
    const usable = records.filter(
      (r) =>
        (r.usable_for_structure_analysis || usableForWorks(r, listing?.property_type)) &&
        byId.get(r.id)?.dataUrl
    );

    const parts = [
      { type: "text", text: listingContextText(listing) },
      {
        type: "text",
        text: `FICHES PAR IMAGE (passe précédente, ${records.length} images) :\n${JSON.stringify(
          records.map(compactRecord)
        )}`,
      },
    ];
    if (usable.length) {
      parts.push({
        type: "text",
        text: `IMAGES RÉELLES EXPLOITABLES (${usable.length}, pour regrouper les pièces, comparer et vérifier l'état des surfaces) :`,
      });
      for (const r of usable) {
        parts.push({ type: "text", text: `Image id="${r.id}"` });
        parts.push({ type: "image", dataUrl: byId.get(r.id).dataUrl, detail });
      }
    }

    const json = await client.completeJson({
      system: SYNTHESIS_SYSTEM,
      parts,
      maxTokens: 6000,
    });
    const parsed = synthesisSchema.parse(json);
    const synthesis = normalizeSynthesis(parsed);
    logger?.info?.(
      {
        rooms: synthesis.rooms.length,
        anomalies: synthesis.anomalies.length,
        works: synthesis.potential_works.length,
      },
      "synthèse photos (vision)"
    );
    return synthesis;
  }

  return { run };
}

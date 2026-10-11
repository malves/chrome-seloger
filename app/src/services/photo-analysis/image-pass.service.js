/**
 * Passe A : analyse « par image », par lots.
 *
 * Chaque image téléchargée est envoyée en haute définition avec son
 * identifiant ; le modèle renvoie une fiche par image. La sortie est
 * normalisée champ par champ (énumérations fermées, confiances bornées) :
 * une fiche manquante ou invalide devient `unknown`, jamais une invention.
 */

import { z } from "zod";
import config from "../../config.js";
import * as E from "../../lib/photo-analysis/enums.js";
import { IMAGE_PASS_SYSTEM } from "./prompts.js";

const { coerceEnum, clampConfidence, cleanText, cleanTextList } = E;

const loose = z.record(z.string(), z.unknown());
const passSchema = z.object({ images: z.array(loose).optional() }).passthrough();

const bool = (v, fallback = false) => (typeof v === "boolean" ? v : fallback);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);

function normalizeFloor(raw) {
  const f = obj(raw);
  if (!f) return null;
  return {
    material: coerceEnum(f.material, E.FLOOR_MATERIALS),
    condition: coerceEnum(f.condition, E.SURFACE_CONDITIONS),
    apparent_age: coerceEnum(f.apparent_age, E.APPARENT_AGES),
    notes: cleanText(f.notes),
    confidence: clampConfidence(f.confidence),
  };
}

function normalizeWalls(raw) {
  const w = obj(raw);
  if (!w) return null;
  return {
    covering: cleanText(w.covering, 80),
    condition: coerceEnum(w.condition, E.SURFACE_CONDITIONS),
    defects: cleanTextList(w.defects, { max: 8, maxLength: 60 }),
    notes: cleanText(w.notes),
    confidence: clampConfidence(w.confidence),
  };
}

function normalizeCeiling(raw) {
  const c = obj(raw);
  if (!c) return null;
  return {
    condition: coerceEnum(c.condition, E.SURFACE_CONDITIONS),
    defects: cleanTextList(c.defects, { max: 8, maxLength: 60 }),
    features: cleanTextList(c.features, { max: 8, maxLength: 60 }),
    notes: cleanText(c.notes),
    confidence: clampConfidence(c.confidence),
  };
}

function normalizeWindows(raw) {
  const w = obj(raw);
  if (!w) return null;
  return {
    material: coerceEnum(w.material, E.WINDOW_MATERIALS),
    apparent_age: coerceEnum(w.apparent_age, E.APPARENT_AGES),
    glazing: coerceEnum(w.glazing, E.GLAZINGS),
    shutters: coerceEnum(w.shutters, ["none_visible", "roller", "louvered", "swing", "unknown"]),
    frame_condition: coerceEnum(w.frame_condition, E.SURFACE_CONDITIONS),
    notes: cleanText(w.notes),
    confidence: clampConfidence(w.confidence),
  };
}

function normalizeHeating(raw) {
  const h = obj(raw);
  if (!h) return null;
  return {
    equipment: coerceEnum(h.equipment, E.HEATING_EQUIPMENTS),
    apparent_age: coerceEnum(h.apparent_age, E.APPARENT_AGES),
    notes: cleanText(h.notes),
    confidence: clampConfidence(h.confidence),
  };
}

function normalizeElectrical(raw) {
  const e = obj(raw);
  if (!e) return null;
  return {
    visible_items: cleanTextList(e.visible_items, { max: 8, maxLength: 60 }),
    apparent_age: coerceEnum(e.apparent_age, E.APPARENT_AGES),
    notes: cleanText(e.notes),
    confidence: clampConfidence(e.confidence),
  };
}

function normalizeStorage(raw) {
  const s = obj(raw);
  if (!s) return null;
  return {
    built_in_closets: bool(s.built_in_closets),
    dressing: bool(s.dressing),
    built_in_shelves: bool(s.built_in_shelves),
    notes: cleanText(s.notes),
  };
}

function normalizeView(raw) {
  const v = obj(raw);
  if (!v) return null;
  return {
    type: coerceEnum(v.type, E.VIEW_TYPES, "not_assessable"),
    overlooking: coerceEnum(v.overlooking, ["high", "medium", "low", "unknown"]),
    confidence: clampConfidence(v.confidence),
  };
}

function normalizeKitchen(raw) {
  const k = obj(raw);
  if (!k) return null;
  return {
    layout: coerceEnum(k.layout, E.KITCHEN_LAYOUTS),
    condition: coerceEnum(k.condition, E.KITCHEN_CONDITIONS, "not_assessable"),
    apparent_age: coerceEnum(k.apparent_age, E.APPARENT_AGES),
    visible_appliances: cleanTextList(k.visible_appliances, { max: 10, maxLength: 40 }),
    notes: cleanText(k.notes),
    confidence: clampConfidence(k.confidence),
  };
}

function normalizeBathroom(raw) {
  const b = obj(raw);
  if (!b) return null;
  return {
    equipment: cleanTextList(b.equipment, { max: 10, maxLength: 40 }),
    condition: coerceEnum(b.condition, E.ROOM_CONDITIONS, "not_assessable"),
    functional_appearance: coerceEnum(b.functional_appearance, [
      "probably_usable",
      "doubtful",
      "unknown",
    ]),
    renovation_level: coerceEnum(b.renovation_level, E.BATHROOM_RENOVATION_LEVELS),
    humidity_traces: bool(b.humidity_traces),
    notes: cleanText(b.notes),
    confidence: clampConfidence(b.confidence),
  };
}

const EXTERIOR_SUBJECTS = [
  "facade",
  "building_entrance",
  "courtyard",
  "garden",
  "view",
  "balcony",
  "terrace",
  "street",
  "neighborhood",
  "common_area",
];
const EXTERIOR_CONDITIONS = ["very_good", "good", "average", "dated", "poor", "not_assessable"];

function normalizeExterior(raw) {
  const x = obj(raw);
  if (!x) return null;
  return {
    subject: typeof x.subject === "string" && EXTERIOR_SUBJECTS.includes(x.subject) ? x.subject : null,
    condition: coerceEnum(x.condition, EXTERIOR_CONDITIONS, "not_assessable"),
    notes: cleanText(x.notes),
    confidence: clampConfidence(x.confidence),
  };
}

function normalizeDefects(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((d) => obj(d))
    .filter(Boolean)
    .map((d) => ({
      type: coerceEnum(d.type, E.ANOMALY_TYPES, "other"),
      observation: cleanText(d.observation) || "",
      severity: coerceEnum(d.severity, E.SEVERITIES, "low"),
      confidence: clampConfidence(d.confidence),
    }))
    .filter((d) => d.observation)
    .slice(0, 8);
}

function normalizeObservations(raw) {
  const o = obj(raw) || {};
  return {
    floor: normalizeFloor(o.floor),
    walls: normalizeWalls(o.walls),
    ceiling: normalizeCeiling(o.ceiling),
    windows: normalizeWindows(o.windows),
    heating: normalizeHeating(o.heating),
    electrical: normalizeElectrical(o.electrical),
    storage: normalizeStorage(o.storage),
    brightness: coerceEnum(o.brightness, E.BRIGHTNESS_LEVELS, "not_assessable"),
    view: normalizeView(o.view),
    ceiling_height: coerceEnum(o.ceiling_height, E.CEILING_HEIGHTS),
    space_feeling: coerceEnum(o.space_feeling, E.SPACE_FEELINGS, "not_assessable"),
    kitchen: normalizeKitchen(o.kitchen),
    bathroom: normalizeBathroom(o.bathroom),
    exterior: normalizeExterior(o.exterior),
    visible_text: cleanText(o.visible_text, 300),
    notable_positive: cleanTextList(o.notable_positive, { max: 10, maxLength: 80 }),
    possible_defects: normalizeDefects(o.possible_defects),
  };
}

/** Fiche « inconnue » pour une image sans réponse exploitable. */
export function unknownImageRecord(image, reason = "no_model_output") {
  return {
    id: image.id,
    order: image.order,
    url: image.url,
    classification: "unknown",
    classification_confidence: 0,
    usable_for_condition_analysis: false,
    virtual_content: { status: "none", reason: "none", detected_text: null, confidence: 0 },
    room_type: "unknown",
    room_confidence: 0,
    quality: { reliability: "low", issues: [reason] },
    brightness_edit: "none",
    wide_angle_likely: false,
    wide_angle_confidence: 0,
    observations: normalizeObservations(null),
    analysis_reliability: "low",
    exclusion_reason: reason,
    exterior_kind: null,
  };
}

/**
 * Normalise une fiche brute du modèle pour une image donnée.
 * @param {object} image - image téléchargée (`id`, `order`, `url`)
 * @param {object} raw - fiche brute
 * @param {{ propertyType?: string|null }} [options]
 */
export function normalizeImageRecord(image, raw, { propertyType = null } = {}) {
  const r = obj(raw);
  if (!r) return unknownImageRecord(image);

  let classification = coerceEnum(r.classification, E.IMAGE_CLASSIFICATIONS);
  // Valeur hors vocabulaire ramenée à « unknown » : on la garde pour le diagnostic.
  const rawClassification =
    classification === "unknown" && typeof r.classification === "string" &&
    r.classification.trim().toLowerCase() !== "unknown"
      ? cleanText(r.classification, 60)
      : null;
  let roomType = coerceEnum(r.room_type, E.ROOM_TYPES);
  // Le modèle met parfois la pièce dans `classification` (« bedroom ») : c'est une photo intérieure.
  const rawAsRoom = rawClassification?.toLowerCase();
  if (rawAsRoom && E.INTERIOR_ROOM_TYPES.has(rawAsRoom)) {
    classification = "real_interior";
    if (roomType === "unknown") roomType = rawAsRoom;
  }
  // Une maison n'a pas de parties communes : hall, escalier, palier sont ceux du logement.
  if (propertyType === "house") {
    if (classification === "common_area") classification = "real_interior";
    if (roomType === "common_area") roomType = "hallway";
  }
  const vc = obj(r.virtual_content) || {};
  const virtual = {
    status: coerceEnum(vc.status, E.VIRTUAL_STATUSES, "none"),
    reason: coerceEnum(vc.reason, E.VIRTUAL_REASONS, "none"),
    detected_text: cleanText(vc.detected_text, 200),
    confidence: clampConfidence(vc.confidence, 0),
  };
  // Un texte explicite « projection / IA » prime sur la classification visuelle.
  if (virtual.status === "confirmed" && !E.VIRTUAL_CLASSIFICATIONS.has(classification)) {
    if (classification !== "real_photo_with_virtual_staging") {
      classification = virtual.detected_text && /ia|synth|génér/i.test(virtual.detected_text)
        ? "ai_generated"
        : "virtual_staging";
    }
  }

  const quality = obj(r.quality) || {};
  const reliability = coerceEnum(quality.reliability, E.RELIABILITIES, "medium");
  const issues = cleanTextList(quality.issues, { max: 6, maxLength: 40 });

  let exteriorKind = null;
  if (E.COMMON_CLASSIFICATIONS.has(classification) || E.COMMON_ROOM_TYPES.has(roomType)) {
    exteriorKind = "common";
  } else if (
    E.BUILDING_EXTERIOR_CLASSIFICATIONS.has(classification) ||
    E.BUILDING_EXTERIOR_ROOM_TYPES.has(roomType)
  ) {
    exteriorKind = "building";
  }
  const exterior = exteriorKind !== null;

  const modelUsable = bool(r.usable_for_condition_analysis, false);
  const usable =
    modelUsable &&
    !exterior &&
    !E.NON_CONDITION_CLASSIFICATIONS.has(classification) &&
    classification !== "heavily_retouched" &&
    reliability !== "low";

  let exclusion = null;
  if (!usable) {
    if (E.VIRTUAL_CLASSIFICATIONS.has(classification)) exclusion = "virtual_or_projection";
    else if (classification === "floor_plan") exclusion = "floor_plan";
    else if (classification === "map" || classification === "document") exclusion = "document";
    else if (classification === "decorative_or_marketing") exclusion = "marketing_image";
    else if (classification === "heavily_retouched") exclusion = "heavily_retouched";
    else if (exterior) exclusion = "exterior";
    else if (reliability === "low") exclusion = "poor_image_quality";
    else if (classification === "unknown") exclusion = "unclassified";
    else exclusion = "not_usable";
  }

  return {
    id: image.id,
    order: image.order,
    url: image.url,
    classification,
    classification_confidence: clampConfidence(r.classification_confidence),
    usable_for_condition_analysis: usable,
    usable_for_structure_analysis:
      usable || (classification === "real_photo_with_virtual_staging" && !exterior),
    usable_for_decoration_analysis:
      usable && classification !== "real_photo_with_virtual_staging",
    virtual_content: virtual,
    room_type: roomType,
    room_confidence: clampConfidence(r.room_confidence),
    quality: { reliability, issues },
    brightness_edit: coerceEnum(r.brightness_edit, E.BRIGHTNESS_EDITS, "none"),
    wide_angle_likely: bool(r.wide_angle_likely),
    wide_angle_confidence: clampConfidence(r.wide_angle_confidence, 0),
    observations: normalizeObservations(r.observations),
    analysis_reliability: reliability,
    exclusion_reason: exclusion,
    exterior_kind: exteriorKind,
    ...(rawClassification ? { raw_classification: rawClassification } : {}),
  };
}

/** Motifs pour lesquels une seconde lecture, en plus petit lot, a une chance d'aboutir. */
const RETRYABLE_REASONS = new Set([
  "unclassified",
  "missing_from_model_response",
  "batch_failed",
  "no_model_output",
]);

const RETRY_HINT = `
SECONDE LECTURE : ces images n'ont pas pu être classées au premier passage. Examine-les attentivement une par une.
Choisis la classification et la pièce les PLUS PROBABLES (une pièce vide, en travaux ou mal cadrée reste "real_interior" ; une chambre sans lit reste une pièce intérieure). Utilise "unknown" uniquement si l'image est réellement illisible, et explique pourquoi dans quality.issues.
Les valeurs de "classification" et "room_type" doivent être EXACTEMENT celles des listes autorisées.`;

/** Ce qu'avait donné la première lecture, conservé pour le diagnostic. */
function firstAttemptTrace(record) {
  return {
    classification: record.classification,
    raw_classification: record.raw_classification ?? null,
    exclusion_reason: record.exclusion_reason,
  };
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export default function createImagePassService({
  client,
  logger,
  vision = config.vision,
} = {}) {
  /**
   * Un appel vision pour un lot d'images. Ne lève jamais : un échec est tracé
   * dans `meta` et le lot ne renvoie aucune fiche.
   * @returns {Promise<{ list: object[]|null, meta: object }>}
   */
  async function analyzeBatch(batch, batchIndex, { retry = false } = {}) {
    const expectedIds = batch.map((b) => b.id);
    const parts = [
      {
        type: "text",
        text: `Voici ${batch.length} image(s). Chaque image est précédée de son identifiant. Renvoie une fiche pour CHACUNE.${
          retry ? RETRY_HINT : ""
        }`,
      },
    ];
    for (const img of batch) {
      parts.push({ type: "text", text: `Image id="${img.id}" (position ${img.order} dans l'annonce)` });
      parts.push({ type: "image", dataUrl: img.dataUrl, detail: vision.imageDetail });
    }
    try {
      const json = await client.completeJson({
        system: IMAGE_PASS_SYSTEM,
        parts,
        maxTokens: (retry ? 1200 : 900) * batch.length + 400,
      });
      // Une fiche n'est retenue que pour une image effectivement envoyée dans ce lot.
      const list = (passSchema.parse(json).images || []).filter((raw) =>
        expectedIds.includes(typeof raw?.id === "string" ? raw.id.trim() : null)
      );
      const receivedIds = list.map((raw) => raw.id.trim());
      return {
        list,
        meta: {
          batch_index: batchIndex,
          status: "ok",
          error: null,
          expected_ids: expectedIds,
          received_ids: receivedIds,
          missing_ids: expectedIds.filter((id) => !receivedIds.includes(id)),
        },
      };
    } catch (err) {
      logger?.warn?.(
        { err: err.message, batch: expectedIds, retry },
        retry ? "nouvelle tentative de la passe par image en échec" : "passe par image en échec"
      );
      return {
        list: null,
        meta: {
          batch_index: batchIndex,
          status: "failed",
          error: String(err.message || err),
          expected_ids: expectedIds,
          received_ids: [],
          missing_ids: expectedIds,
        },
      };
    }
  }

  /** Fiche d'une image analysable à partir des réponses brutes et des traces de lots. */
  function recordFor(img, rawById, metas, options) {
    const raw = rawById.get(img.id);
    if (raw) return normalizeImageRecord(img, raw, options);
    const meta = metas.find((m) => m.expected_ids.includes(img.id));
    if (meta?.status === "failed") return unknownImageRecord(img, "batch_failed");
    if (meta?.missing_ids.includes(img.id)) {
      return unknownImageRecord(img, "missing_from_model_response");
    }
    return unknownImageRecord(img);
  }

  /**
   * @param {object[]} images - images téléchargées (voir image-fetcher)
   * @param {{ propertyType?: string|null }} [options]
   * @returns {Promise<{ records: object[], failures: number }>} une fiche par image (ordre conservé)
   */
  async function run(images, { propertyType = null } = {}) {
    const normalizeOptions = { propertyType };
    const analyzable = images.filter((img) => img.dataUrl && !img.duplicate_of);

    const batches = chunk(analyzable, Math.max(1, vision.batchSize));
    const first = await Promise.all(batches.map((batch, i) => analyzeBatch(batch, i)));
    const metas = first.map((r) => r.meta);
    const rawById = new Map();
    for (const { list } of first) {
      for (const raw of list || []) {
        const id = raw.id.trim();
        if (!rawById.has(id)) rawById.set(id, raw);
      }
    }

    const byId = new Map(
      analyzable.map((img) => [img.id, recordFor(img, rawById, metas, normalizeOptions)])
    );

    // Seconde tentative, en petits lots, pour les images sans classification exploitable.
    const toRetry = analyzable
      .filter((img) => RETRYABLE_REASONS.has(byId.get(img.id).exclusion_reason))
      .slice(0, Math.max(0, vision.maxRetryImages ?? 12));
    const retryBatches = chunk(toRetry, Math.max(1, vision.retryBatchSize ?? 2));
    const retried = await Promise.all(
      retryBatches.map((batch, i) => analyzeBatch(batch, i, { retry: true }))
    );
    const recoveredIds = [];
    for (const { list, meta } of retried) {
      const retryRaw = new Map((list || []).map((raw) => [raw.id.trim(), raw]));
      for (const id of meta.expected_ids) {
        const img = analyzable.find((a) => a.id === id);
        const before = byId.get(id);
        const after = recordFor(img, retryRaw, [meta], normalizeOptions);
        if (after.classification !== "unknown") {
          byId.set(id, { ...after, retried: true, first_attempt: firstAttemptTrace(before) });
          recoveredIds.push(id);
        } else {
          // Garde le motif le plus parlant : une fiche reçue mais « unknown » prime sur un échec technique.
          const keep = before.exclusion_reason === "unclassified" ? before : after;
          byId.set(id, { ...keep, retried: true });
        }
      }
    }

    // Un lot initial ne compte comme échec que si ses images n'ont pas été récupérées.
    const failures = metas.filter(
      (m) => m.status === "failed" && m.expected_ids.some((id) => !recoveredIds.includes(id))
    ).length;

    const records = images.map((img) => {
      if (img.duplicate_of) {
        return {
          ...unknownImageRecord(img, "duplicate"),
          classification: "duplicate",
          classification_confidence: 1,
          duplicate_of: img.duplicate_of,
          exclusion_reason: "duplicate",
        };
      }
      if (!img.dataUrl) return unknownImageRecord(img, "download_failed");
      return byId.get(img.id);
    });

    if (toRetry.length) {
      logger?.info?.(
        {
          retried: toRetry.map((img) => img.id),
          recovered: recoveredIds,
          still_unknown: toRetry.length - recoveredIds.length,
        },
        "passe par image : nouvelle tentative sur les images non classées"
      );
    }

    return {
      records,
      failures,
      batches: batches.length,
      debug: {
        image_pass_batches: metas,
        retry_batches: retried.map((r) => r.meta),
        retried_ids: toRetry.map((img) => img.id),
        recovered_ids: recoveredIds,
        image_detail: vision.imageDetail,
        batch_size: vision.batchSize,
        retry_batch_size: vision.retryBatchSize ?? 2,
      },
    };
  }

  return { run };
}

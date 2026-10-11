/**
 * Pipeline complet sans réseau : `fetchImage` et `chatCompletion` injectés.
 * Le faux modèle répond selon le prompt système reçu (passe A ou passe B).
 */

import test from "node:test";
import assert from "node:assert/strict";
import createPhotoAnalysisService from "../src/services/photo-analysis/photo-analysis.service.js";
import { IMAGE_PASS_SYSTEM, SYNTHESIS_SYSTEM } from "../src/services/photo-analysis/prompts.js";
import { normalizeImageRecord } from "../src/services/photo-analysis/image-pass.service.js";

const LISTING = {
  id: 1,
  property_type: "apartment",
  surface: 82,
  rooms: 4,
  bedrooms: 2,
  year_built: 1930,
  description: "Appartement familial entièrement rénové, très lumineux.",
};

const URLS = [
  "https://p.example.com/salon-1.jpg",
  "https://p.example.com/salon-2.jpg",
  "https://p.example.com/cuisine.jpg",
  "https://p.example.com/chambre.jpg",
  "https://p.example.com/sdb.jpg",
  "https://p.example.com/projection.jpg",
  "https://p.example.com/plan.png",
  "https://p.example.com/salon-1-copie.jpg", // doublon exact de salon-1
];

/** Faux téléchargement : contenu déterministe par URL, doublon exact pour la dernière. */
async function fakeFetchImage(url) {
  if (url.endsWith("broken.jpg")) throw new Error("HTTP 403");
  const key = url.endsWith("salon-1-copie.jpg") ? URLS[0] : url;
  return {
    buffer: Buffer.from(`image:${key}`),
    mimeType: url.endsWith(".png") ? "image/png" : "image/jpeg",
  };
}

function imageRecord(id, overrides = {}) {
  return {
    id,
    classification: "real_interior",
    classification_confidence: 0.95,
    usable_for_condition_analysis: true,
    virtual_content: { status: "none", reason: "none", detected_text: null, confidence: 0 },
    room_type: "living_room",
    room_confidence: 0.9,
    quality: { reliability: "high", issues: [] },
    brightness_edit: "none",
    wide_angle_likely: false,
    wide_angle_confidence: 0,
    observations: {
      floor: { material: "old_wood_parquet", condition: "good", apparent_age: "dated", confidence: 0.8 },
      windows: { material: "wood", apparent_age: "dated", glazing: "unknown", confidence: 0.7 },
      brightness: "bright",
    },
    ...overrides,
  };
}

const PASS_A = {
  images: [
    imageRecord("img_001"),
    imageRecord("img_002", { wide_angle_likely: true, wide_angle_confidence: 0.84 }),
    imageRecord("img_003", {
      room_type: "kitchen",
      observations: {
        kitchen: { layout: "closed", condition: "dated_but_usable", apparent_age: "very_dated", confidence: 0.9 },
      },
    }),
    imageRecord("img_004", {
      room_type: "bedroom",
      observations: {
        ceiling: { condition: "damaged", defects: ["stains"], confidence: 0.75 },
        possible_defects: [
          { type: "possible_humidity", observation: "Zone sombre près du plafond.", severity: "medium", confidence: 0.77 },
        ],
      },
    }),
    imageRecord("img_005", {
      room_type: "bathroom",
      observations: {
        bathroom: { condition: "dated", functional_appearance: "probably_usable", renovation_level: "medium_to_full", confidence: 0.88 },
      },
    }),
    imageRecord("img_006", {
      classification: "real_interior",
      usable_for_condition_analysis: true,
      room_type: "kitchen",
      virtual_content: { status: "confirmed", reason: "explicit_text", detected_text: "Projection non contractuelle", confidence: 0.99 },
    }),
    {
      id: "img_007",
      classification: "floor_plan",
      classification_confidence: 0.99,
      usable_for_condition_analysis: false,
      virtual_content: { status: "none", reason: "none", detected_text: null, confidence: 0 },
      room_type: "unknown",
      quality: { reliability: "high", issues: [] },
    },
  ],
};

const PASS_B = {
  rooms: [
    { room_id: "room_01", room_type: "living_room", label: "Séjour", image_ids: ["img_001", "img_002"], confidence: 0.93, condition: "good", condition_confidence: 0.85, floor: { material: "old_wood_parquet", condition: "good", apparent_age: "dated", confidence: 0.8 }, windows: { material: "wood", apparent_age: "dated", glazing: "unknown", replacement_may_be_relevant: true, confidence: 0.76 }, strengths: ["Parquet ancien"] },
    { room_id: "room_02", room_type: "kitchen", label: "Cuisine", image_ids: ["img_003"], confidence: 0.98, condition: "dated", condition_confidence: 0.9, kitchen: { layout: "closed", condition: "dated_but_usable", apparent_age: "very_dated", confidence: 0.9 } },
    { room_id: "room_03", room_type: "bedroom", label: "Chambre 1", image_ids: ["img_004"], confidence: 0.9, condition: "average", condition_confidence: 0.7 },
    { room_id: "room_04", room_type: "bathroom", label: "Salle de bain", image_ids: ["img_005"], confidence: 0.95, condition: "renovation_needed", condition_confidence: 0.91, bathroom: { condition: "dated", functional_appearance: "probably_usable", renovation_level: "medium_to_full", confidence: 0.88 } },
    // Pièce fantôme : ne référence qu'une projection → doit disparaître.
    { room_id: "room_05", room_type: "kitchen", label: "Cuisine projetée", image_ids: ["img_006"], confidence: 0.5, condition: "new_or_recently_renovated" },
  ],
  image_relationships: [
    { relationship: "current_vs_projected", image_ids: ["img_003", "img_006"], current_image: "img_003", projected_image: "img_006", confidence: 0.9 },
  ],
  anomalies: [
    { type: "possible_humidity", room_id: "room_03", severity: "medium", confidence: 0.77, image_ids: ["img_004"], observation: "Zone sombre et peinture dégradée près du plafond.", interpretation: "Peut être compatible avec un ancien dégât des eaux.", needs_confirmation: true },
    // Anomalie sans preuve valable (image de projection) : conservée mais dépréciée.
    { type: "crack", severity: "low", confidence: 0.9, image_ids: ["img_006"], observation: "Fissure fine.", interpretation: null },
  ],
  potential_works: [
    { work_type: "bathroom_full_renovation", label: "Rénovation de la salle de bain", room_id: "room_04", necessity: "likely", scope: "medium_to_full", category: "necessary", quantity: 1, confidence: 0.87, image_ids: ["img_005"], rationale: "Équipements et faïence datés." },
    { work_type: "painting", label: "Peinture", room_id: "room_03", necessity: "possible", scope: "light", category: "cosmetic", confidence: 0.7, image_ids: ["img_004"] },
    { work_type: "invented_type", label: "?", necessity: "whatever", scope: "x", category: "y", confidence: 2, image_ids: [] },
  ],
  strengths: [{ label: "Parquet ancien en bon état apparent", confidence: 0.91, image_ids: ["img_001"] }],
  warnings: [{ label: "Salle de bain probablement à rénover", severity: "medium", confidence: 0.92, image_ids: ["img_005"] }],
  description_contradictions: [
    { claim: "entièrement rénové", status: "partially_supported", reason: "Cuisine et salle de bain visiblement datées.", image_ids: ["img_003", "img_005"] },
  ],
  renovation: { level: "moderate_renovation", confidence: 0.85, cosmetic_only_suspected: false },
  condition_score: 58,
  condition_label: "average",
  condition_confidence: 0.82,
  wide_angle_likely: true,
  possible_photo_inconsistency: { status: false, confidence: 0 },
  summary: "L'appartement semble habitable en l'état mais plusieurs éléments sont datés.",
  visit_questions: ["La trace au plafond de la chambre correspond-elle à un ancien dégât des eaux ?", "Les fenêtres sont-elles en double vitrage ?"],
  visit_checks: ["Vérifier les joints de la salle de bain."],
  negotiation_points: [
    { label: "Salle de bain à rénover", confidence: 0.9, image_ids: ["img_005"] },
    { label: "Fissure possible", confidence: 0.4, image_ids: ["img_004"] },
    { label: "Sans preuve", confidence: 0.95, image_ids: ["img_006"] },
  ],
};

function fakeModel(calls) {
  return async ({ system, parts }) => {
    calls.push({ system, parts });
    if (system === IMAGE_PASS_SYSTEM) {
      // Ne renvoie que les fiches des images réellement envoyées dans ce lot.
      const sent = parts.filter((p) => p.type === "text" && /Image id="/.test(p.text)).map((p) => /id="([^"]+)"/.exec(p.text)[1]);
      return JSON.stringify({ images: PASS_A.images.filter((img) => sent.includes(img.id)) });
    }
    if (system === SYNTHESIS_SYSTEM) return JSON.stringify(PASS_B);
    throw new Error("prompt inconnu");
  };
}

function service(calls, { vision = {} } = {}) {
  return createPhotoAnalysisService({
    chatCompletion: fakeModel(calls),
    fetchImage: fakeFetchImage,
    vision: {
      model: "fake-vision",
      imageDetail: "high",
      maxPhotos: 30,
      batchSize: 4,
      maxImageBytes: 1_000_000,
      downloadTimeoutMs: 1000,
      timeoutMs: 1000,
      apiKey: "",
      baseUrl: "",
      ...vision,
    },
  });
}

test("pipeline complet : doublons, projections, pièces, anomalies, travaux et traçabilité", async () => {
  const calls = [];
  const result = await service(calls).analyze(LISTING, URLS);

  assert.equal(result.status, "ok");
  assert.equal(result.photo_count, 8);

  // Deux lots de 4 images... moins le doublon exact (7 analysables → 2 lots) + 1 synthèse.
  const passA = calls.filter((c) => c.system === IMAGE_PASS_SYSTEM);
  const passB = calls.filter((c) => c.system === SYNTHESIS_SYSTEM);
  assert.equal(passA.length, 2);
  assert.equal(passB.length, 1);
  const sentIds = passA.flatMap((c) => c.parts.filter((p) => p.type === "text" && /Image id=/.test(p.text)));
  assert.equal(sentIds.length, 7, "le doublon exact n'est jamais envoyé au modèle");
  assert.ok(passA.every((c) => c.parts.filter((p) => p.type === "image").every((p) => p.detail === "high")));

  // Doublon exact marqué sans appel modèle.
  const dup = result.images.find((i) => i.id === "img_008");
  assert.equal(dup.classification, "duplicate");
  assert.equal(dup.duplicate_of, "img_001");
  assert.equal(dup.usable_for_condition_analysis, false);

  // Texte « Projection non contractuelle » : image reclassée virtuelle, exclue.
  const projection = result.images.find((i) => i.id === "img_006");
  assert.equal(projection.classification, "virtual_staging");
  assert.equal(projection.usable_for_condition_analysis, false);
  assert.equal(projection.virtual_content.status, "confirmed");
  assert.equal(result.virtual_image_count, 1);
  assert.ok(result.virtual_images.some((v) => v.image_id === "img_006"));

  // La passe B ne reçoit que les images réelles exploitables, en détail « high » par défaut.
  const synthesisImages = passB[0].parts.filter((p) => p.type === "image");
  assert.equal(synthesisImages.length, 5);
  assert.ok(synthesisImages.every((p) => p.detail === "high"));
  const synthesisIds = passB[0].parts.filter((p) => p.type === "text" && /^Image id=/.test(p.text)).map((p) => /id="([^"]+)"/.exec(p.text)[1]);
  assert.ok(!synthesisIds.includes("img_006") && !synthesisIds.includes("img_007") && !synthesisIds.includes("img_008"));

  // Plan : exclu, motif explicite.
  assert.ok(result.excluded_images.some((x) => x.image_id === "img_007" && x.reason === "floor_plan"));
  assert.equal(result.usable_photo_count, 5);

  // Pièces : la pièce fantôme (projection seule) disparaît ; 3 photos de salon = 1 séjour.
  assert.deepEqual(result.rooms.map((r) => r.room_id), ["room_01", "room_02", "room_03", "room_04"]);
  assert.deepEqual(result.rooms[0].image_ids, ["img_001", "img_002"]);
  assert.equal(result.images.find((i) => i.id === "img_002").room_id, "room_01");

  // Relation actuel / projection conservée.
  assert.equal(result.image_relationships.length, 1);
  assert.equal(result.image_relationships[0].projected_image, "img_006");

  // Anomalies : la première est tracée ; la seconde perd sa preuve et sa confiance.
  assert.equal(result.anomalies.length, 2);
  assert.deepEqual(result.anomalies[0].image_ids, ["img_004"]);
  assert.equal(result.anomalies[0].evidence_missing, false);
  assert.equal(result.anomalies[0].needs_confirmation, true);
  assert.equal(result.anomalies[0].room_id, "room_03");
  assert.deepEqual(result.anomalies[1].image_ids, []);
  assert.equal(result.anomalies[1].evidence_missing, true);
  assert.ok(result.anomalies[1].confidence < 0.9);

  // Travaux : valeurs inventées ramenées aux vocabulaires fermés.
  const bad = result.potential_works[2];
  assert.equal(bad.work_type, "other");
  assert.equal(bad.necessity, "possible");
  assert.equal(bad.scope, "unknown");
  assert.equal(bad.category, "cosmetic");
  assert.ok(bad.confidence <= 1);
  assert.equal(result.potential_works[0].room_id, "room_04");
  assert.equal(result.potential_works[0].quantity, 1);

  // Négociation : confiance basse et absence de preuve exclues.
  assert.deepEqual(result.negotiation_points.map((n) => n.label), ["Salle de bain à rénover"]);

  // Couverture : WC et entrée non vus, une chambre manquante.
  const missingTypes = result.missing_visual_coverage.map((m) => m.room_type);
  assert.ok(missingTypes.includes("bedroom"));
  assert.ok(missingTypes.includes("toilet"));
  assert.ok(!missingTypes.includes("bathroom"));
  assert.deepEqual(result.photo_distribution, { living_room: 2, kitchen: 1, bedroom: 1, bathroom: 1 });
  assert.ok(result.photo_coverage.score > 0 && result.photo_coverage.score < 100);

  // Grand-angle, synthèse, qualité, contexte.
  assert.equal(result.wide_angle.likely, true);
  assert.deepEqual(result.wide_angle.image_ids, ["img_002"]);
  // Planchers d'état : plafond abîmé (fiche image) + humidité → chambre en rénovation lourde ;
  // 2 pièces sur 4 à rénover → état global et niveau de travaux relevés.
  const chambre = result.rooms.find((r) => r.room_id === "room_03");
  assert.equal(chambre.ceiling.condition, "damaged");
  assert.equal(chambre.condition, "heavy_renovation_likely");
  assert.equal(result.renovation.level, "significant_renovation");
  assert.equal(result.overall_condition.label, "renovation_needed");
  assert.equal(result.overall_condition.score, 40);
  const scopes = result.analysis_debug.condition_adjustments.map((a) => a.scope);
  assert.ok(scopes.includes("room_03.ceiling") && scopes.includes("room_03.condition"));
  assert.ok(scopes.includes("overall.score"));
  assert.match(result.summary, /habitable/);
  assert.equal(result.description_contradictions[0].status, "partially_supported");
  assert.equal(result.analysis_quality.usable_photo_count, 5);
  assert.equal(result.analysis_quality.partial, false);
  assert.equal(result.visible_equipment.windows_replacement_may_be_relevant, true);
  assert.equal(result.model, "fake-vision");

  // Le contexte de l'annonce est transmis à la synthèse (jamais prescriptif).
  assert.match(passB[0].parts[0].text, /Chambres annoncées : 2/);
  assert.match(passB[0].parts[0].text, /entièrement rénové/);
});

test("synthèse : détail des images configurable (VISION_SYNTHESIS_DETAIL)", async () => {
  const calls = [];
  await service(calls, { vision: { synthesisImageDetail: "low" } }).analyze(LISTING, URLS);
  const passB = calls.find((c) => c.system === SYNTHESIS_SYSTEM);
  assert.ok(passB.parts.filter((p) => p.type === "image").every((p) => p.detail === "low"));
});

test("réponse modèle invalide sur toute la passe A → indisponible, aucune synthèse", async () => {
  const calls = [];
  const engine = createPhotoAnalysisService({
    chatCompletion: async ({ system }) => {
      calls.push(system);
      return "ceci n'est pas du JSON";
    },
    fetchImage: fakeFetchImage,
    vision: { model: "x", imageDetail: "high", maxPhotos: 30, batchSize: 8, maxImageBytes: 1e6, downloadTimeoutMs: 1, timeoutMs: 1, apiKey: "", baseUrl: "" },
  });
  const result = await engine.analyze(LISTING, URLS.slice(0, 3));
  assert.equal(result.status, "unavailable");
  assert.ok(!calls.includes(SYNTHESIS_SYSTEM));
});

test("sans photo téléchargeable → indisponible ; sans photo → insuffisant ; non configuré", async () => {
  const engine = createPhotoAnalysisService({
    chatCompletion: async () => "{}",
    fetchImage: async () => {
      throw new Error("HTTP 403");
    },
    vision: { model: "x", imageDetail: "high", maxPhotos: 30, batchSize: 8, maxImageBytes: 1e6, downloadTimeoutMs: 1, timeoutMs: 1, apiKey: "", baseUrl: "" },
  });
  assert.equal((await engine.analyze(LISTING, ["https://p.example.com/broken.jpg"])).status, "unavailable");
  assert.equal((await engine.analyze(LISTING, [])).status, "insufficient");

  const unconfigured = createPhotoAnalysisService({
    vision: { apiKey: "", baseUrl: "", model: "x", imageDetail: "high", maxPhotos: 30, batchSize: 8, maxImageBytes: 1, downloadTimeoutMs: 1, timeoutMs: 1 },
  });
  assert.equal(unconfigured.configured(), false);
  assert.equal((await unconfigured.analyze(LISTING, URLS)).status, "unavailable");
});

test("échec d'un lot sur deux : analyse partielle, qualité pénalisée", async () => {
  const engine = createPhotoAnalysisService({
    chatCompletion: async ({ system, parts }) => {
      if (system === IMAGE_PASS_SYSTEM) {
        const sent = parts.filter((p) => p.type === "text" && /Image id="/.test(p.text)).map((p) => /id="([^"]+)"/.exec(p.text)[1]);
        // Échec durable : la seconde lecture de img_001 échoue aussi.
        if (sent.includes("img_001")) throw new Error("vision_http_500");
        return JSON.stringify({ images: PASS_A.images.filter((img) => sent.includes(img.id)) });
      }
      return JSON.stringify(PASS_B);
    },
    fetchImage: fakeFetchImage,
    vision: { model: "x", imageDetail: "high", maxPhotos: 30, batchSize: 4, maxImageBytes: 1e6, downloadTimeoutMs: 1, timeoutMs: 1, apiKey: "", baseUrl: "" },
  });
  const result = await engine.analyze(LISTING, URLS);
  assert.equal(result.status, "ok");
  assert.equal(result.analysis_quality.partial, true);
  // Les images du lot en échec sont « inconnues », jamais inventées.
  const lost = result.images.filter((i) => i.exclusion_reason === "batch_failed");
  assert.ok(lost.length >= 1);
  assert.ok(lost.every((i) => i.classification === "unknown" && !i.usable_for_condition_analysis));
  assert.equal(result.analysis_debug.image_pass.failed_batch_count, 1);
  assert.ok(result.analysis_debug.image_pass.image_pass_batches.some((b) => b.status === "failed"));
});

test("normalizeImageRecord : image de faible qualité non exploitable ; staging sur vraie photo", () => {
  const image = { id: "img_001", order: 1, url: "https://x/1.jpg" };
  const low = normalizeImageRecord(image, {
    classification: "real_interior",
    usable_for_condition_analysis: true,
    quality: { reliability: "low", issues: ["blurry"] },
  });
  assert.equal(low.usable_for_condition_analysis, false);
  assert.equal(low.exclusion_reason, "poor_image_quality");
  assert.equal(low.analysis_reliability, "low");

  const staged = normalizeImageRecord(image, {
    classification: "real_photo_with_virtual_staging",
    usable_for_condition_analysis: true,
    virtual_content: { status: "confirmed", reason: "explicit_text", detected_text: "Home staging virtuel", confidence: 0.95 },
    quality: { reliability: "high", issues: [] },
  });
  assert.equal(staged.classification, "real_photo_with_virtual_staging");
  assert.equal(staged.usable_for_structure_analysis, true);
  assert.equal(staged.usable_for_decoration_analysis, false);

  const exterior = normalizeImageRecord(image, {
    classification: "building_exterior",
    usable_for_condition_analysis: false,
    quality: { reliability: "high" },
  });
  assert.equal(exterior.exclusion_reason, "exterior");
});

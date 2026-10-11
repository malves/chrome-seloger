import assert from "node:assert/strict";
import { test } from "node:test";
import createPhotoAnalysisService from "../src/services/photo-analysis/photo-analysis.service.js";
import { normalizeImageRecord } from "../src/services/photo-analysis/image-pass.service.js";
import { normalizeSynthesis } from "../src/services/photo-analysis/synthesis-pass.service.js";
import { filterPotentialWorks, worksFromObservations } from "../src/lib/photo-analysis/works.js";

const LISTING = { id: 1, property_type: "apartment", rooms: 3, bedrooms: 2 };

function record(id, raw) {
  const order = Number(id.slice(-3));
  return normalizeImageRecord(
    { id, order, url: `https://x/${order}.jpg` },
    {
      classification: "real_interior",
      usable_for_condition_analysis: true,
      room_type: "living_room",
      quality: { reliability: "high" },
      ...raw,
    }
  );
}

function assemble(records, synthesis, listing = LISTING) {
  const engine = createPhotoAnalysisService({ chatCompletion: async () => "{}" });
  return engine.assemble(listing, records, normalizeSynthesis(synthesis));
}

const HOUSE = { ...LISTING, property_type: "house" };

test("parties communes jugées exploitables par le modèle : exclues comme extérieur", () => {
  const hall = record("img_001", { classification: "common_area" });
  assert.equal(hall.usable_for_condition_analysis, false);
  assert.equal(hall.exclusion_reason, "exterior");

  const stairs = record("img_002", { room_type: "common_area" });
  assert.equal(stairs.usable_for_condition_analysis, false);
  assert.equal(stairs.exclusion_reason, "exterior");
});

test("pièce écrite dans le champ classification (« bedroom ») → photo intérieure", () => {
  const r = record("img_001", { classification: "bedroom", room_type: "unknown" });
  assert.equal(r.classification, "real_interior");
  assert.equal(r.room_type, "bedroom");
  assert.equal(r.raw_classification, "bedroom");
  assert.equal(r.usable_for_condition_analysis, true);
});

test("maison : « parties communes » = hall ou escalier du logement, exploitable", () => {
  const image = { id: "img_001", order: 1, url: "https://x/1.jpg" };
  const raw = {
    classification: "common_area",
    room_type: "common_area",
    usable_for_condition_analysis: true,
    quality: { reliability: "high" },
  };
  const house = normalizeImageRecord(image, raw, { propertyType: "house" });
  assert.equal(house.classification, "real_interior");
  assert.equal(house.room_type, "hallway");
  assert.equal(house.usable_for_condition_analysis, true);

  const flat = normalizeImageRecord(image, raw, { propertyType: "apartment" });
  assert.equal(flat.exclusion_reason, "exterior");
});

test("travaux d'immeuble retirés de la liste et renvoyés vers la copropriété", () => {
  const records = [
    record("img_001", { room_type: "bedroom" }),
    record("img_002", { classification: "common_area", room_type: "common_area" }),
  ];
  const result = assemble(records, {
    rooms: [
      { room_id: "room_01", room_type: "bedroom", image_ids: ["img_001"] },
      { room_id: "room_02", room_type: "common_area", image_ids: ["img_002"] },
    ],
    potential_works: [
      { work_type: "painting", label: "Peinture de la chambre", room_id: "room_01", image_ids: ["img_001"] },
      { work_type: "painting", label: "Peinture de la cage d'escalier", image_ids: ["img_002"] },
      { work_type: "general_refresh", label: "Rafraîchissement", room_id: "room_02", image_ids: [] },
      { work_type: "other", label: "Ravalement de façade", image_ids: [] },
      { work_type: "other", label: "Reprise du hall", area: "common", image_ids: [] },
      { work_type: "painting", label: "Peinture", rationale: "Murs des parties communes défraîchis.", image_ids: [] },
    ],
  });

  assert.deepEqual(result.potential_works.map((w) => w.label), ["Peinture de la chambre"]);
  assert.equal(result.analysis_debug.common_area_works_excluded.length, 5);
  assert.ok(
    result.exterior.to_check_in_documents.some((t) => /cage d'escalier.*copropriété/.test(t))
  );
});

test("photo exploitable non rattachée : travaux de repli déduits de sa fiche", () => {
  const records = [
    record("img_001", { room_type: "living_room" }),
    record("img_002", {
      room_type: "unknown",
      observations: {
        floor: { material: "carpet", condition: "damaged", confidence: 0.8 },
        walls: { condition: "dated", confidence: 0.7 },
      },
    }),
    record("img_003", {
      room_type: "unknown",
      observations: { walls: { condition: "worn", confidence: 0.9 } },
    }),
    // Déjà citée par un travail de la synthèse : pas de doublon de repli.
    record("img_004", {
      room_type: "unknown",
      observations: { floor: { condition: "damaged", confidence: 0.9 } },
    }),
  ];
  const result = assemble(records, {
    rooms: [{ room_id: "room_01", room_type: "living_room", image_ids: ["img_001"] }],
    potential_works: [
      { work_type: "floor_replacement", label: "Sol de la chambre", image_ids: ["img_004"] },
    ],
  });

  const fallback = result.potential_works.filter((w) => w.source === "unassigned_photo");
  const byType = Object.fromEntries(fallback.map((w) => [w.work_type, w]));
  assert.deepEqual(Object.keys(byType).sort(), ["floor_replacement", "painting"]);
  assert.deepEqual(byType.painting.image_ids, ["img_002", "img_003"]);
  assert.deepEqual(byType.floor_replacement.image_ids, ["img_002"]);
  assert.equal(byType.painting.room_id, null);
  assert.equal(byType.painting.necessity, "possible");
  assert.equal(byType.painting.evidence_missing, false);
  assert.ok(byType.painting.confidence < 0.9);
  assert.match(byType.painting.label, /pièce non identifiée/);
  assert.equal(result.analysis_debug.unassigned_photo_works, 2);
});

test("photo rattachée à une pièce ou extérieure : aucun travail de repli", () => {
  const damaged = { floor: { condition: "damaged", confidence: 0.8 } };
  const records = [
    record("img_001", { room_type: "bedroom", observations: damaged }),
    record("img_002", { classification: "common_area", observations: damaged }),
  ];
  const result = assemble(records, {
    rooms: [{ room_id: "room_01", room_type: "bedroom", image_ids: ["img_001"] }],
    potential_works: [],
  });
  assert.equal(result.potential_works.length, 0);
});

const FACADE_SYNTHESIS = {
  rooms: [],
  potential_works: [
    { work_type: "facade_renovation", label: "Ravalement de façade", image_ids: ["img_001"] },
    { work_type: "other", label: "Reprise de la cage d'escalier commune", image_ids: [] },
  ],
};

function facadeRecords() {
  return [
    record("img_001", {
      classification: "building_exterior",
      usable_for_condition_analysis: false,
      room_type: "building_exterior",
    }),
  ];
}

test("appartement : façade exclue des travaux", () => {
  const result = assemble(facadeRecords(), FACADE_SYNTHESIS);
  assert.equal(result.potential_works.length, 0);
  assert.equal(result.analysis_debug.common_area_works_excluded.length, 2);
});

test("maison : façade conservée avec sa photo de preuve, parties communes toujours exclues", () => {
  const records = facadeRecords();
  assert.equal(records[0].exterior_kind, "building");
  assert.equal(records[0].usable_for_condition_analysis, false, "l'état intérieur ne change pas");

  const result = assemble(records, FACADE_SYNTHESIS, HOUSE);
  assert.deepEqual(result.potential_works.map((w) => w.label), ["Ravalement de façade"]);
  assert.deepEqual(result.potential_works[0].image_ids, ["img_001"]);
  assert.equal(result.potential_works[0].evidence_missing, false);
  assert.equal(result.analysis_debug.common_area_works_excluded.length, 1);
});

test("maison : travaux dans l'escalier et le couloir conservés ; appartement : exclus", () => {
  const records = [record("img_001", { room_type: "hallway" })];
  const synthesis = {
    rooms: [{ room_id: "room_01", room_type: "common_area", label: "Couloir", image_ids: ["img_001"] }],
    potential_works: [
      { work_type: "painting", label: "Peinture de la cage d'escalier", room_id: "room_01", image_ids: ["img_001"] },
      { work_type: "painting", label: "Peinture du couloir", room_id: "room_01", image_ids: ["img_001"] },
      { work_type: "other", label: "Travaux votés en copropriété", image_ids: [] },
    ],
  };

  const house = assemble(records, synthesis, HOUSE);
  assert.deepEqual(house.potential_works.map((w) => w.label), [
    "Peinture de la cage d'escalier",
    "Peinture du couloir",
  ]);
  assert.equal(house.rooms[0].room_type, "hallway");
  assert.equal(house.potential_works[0].room_id, "room_01");

  assert.equal(assemble(records, synthesis).potential_works.length, 0);
});

test("maison : façade dégradée oubliée par la synthèse → travail de repli extérieur", () => {
  const records = [
    record("img_001", {
      classification: "building_exterior",
      usable_for_condition_analysis: false,
      observations: { exterior: { subject: "facade", condition: "poor", confidence: 0.8 } },
    }),
    record("img_002", {
      classification: "common_area",
      usable_for_condition_analysis: false,
      observations: { exterior: { subject: "common_area", condition: "poor", confidence: 0.8 } },
    }),
  ];
  const synthesis = { rooms: [], potential_works: [] };

  const house = assemble(records, synthesis, HOUSE);
  assert.equal(house.potential_works.length, 1);
  assert.equal(house.potential_works[0].work_type, "facade_renovation");
  assert.deepEqual(house.potential_works[0].image_ids, ["img_001"]);
  assert.match(house.potential_works[0].label, /extérieur/);

  assert.equal(assemble(records, synthesis).potential_works.length, 0);
});

test("worksFromObservations : fiche saine → aucun travail", () => {
  assert.deepEqual(
    worksFromObservations({
      floor: { material: "wood_parquet", condition: "good" },
      walls: { condition: "good" },
      windows: { apparent_age: "recent", glazing: "double_likely", frame_condition: "good" },
    }),
    []
  );
});

test("travaux rangements exclus (synthèse et affichage)", () => {
  const synthesis = normalizeSynthesis({
    rooms: [],
    potential_works: [
      { work_type: "storage_creation", label: "Création de rangements", necessity: "possible", category: "comfort" },
      { work_type: "painting", label: "Peinture", necessity: "possible", category: "cosmetic" },
      { work_type: "other", label: "Rangements à créer", necessity: "possible", category: "comfort" },
    ],
  });
  assert.equal(synthesis.potential_works.length, 1);
  assert.equal(synthesis.potential_works[0].work_type, "painting");
  assert.equal(filterPotentialWorks(synthesis.potential_works).length, 1);
});

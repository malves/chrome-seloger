import test from "node:test";
import assert from "node:assert/strict";
import {
  photoDistribution,
  expectedRooms,
  missingVisualCoverage,
  photoCoverage,
  photoDistributionWarning,
  analysisQuality,
  qualityLevelFromScore,
  roomFamily,
} from "../src/lib/photo-analysis/coverage.js";
import { photoAnalysisViewModel } from "../src/lib/photo-analysis/view-model.js";

function record(id, roomType, { classification = "real_interior", usable = true, reliability = "medium" } = {}) {
  return {
    id,
    classification,
    room_type: roomType,
    usable_for_condition_analysis: usable,
    analysis_reliability: reliability,
  };
}

const LISTING = { property_type: "apartment", rooms: 4, bedrooms: 2 };

test("roomFamily : regroupe les types de pièces", () => {
  assert.equal(roomFamily("living_dining_room"), "living_room");
  assert.equal(roomFamily("shower_room"), "bathroom");
  assert.equal(roomFamily("master_bedroom"), "bedroom");
  assert.equal(roomFamily("terrace"), "exterior");
  assert.equal(roomFamily("unknown"), "unknown");
});

test("photoDistribution : ignore doublons, projections, plans et marketing", () => {
  const dist = photoDistribution([
    record("img_001", "living_room"),
    record("img_002", "living_room"),
    record("img_003", "kitchen"),
    record("img_004", "living_room", { classification: "duplicate", usable: false }),
    record("img_005", "living_room", { classification: "virtual_staging", usable: false }),
    record("img_006", "unknown", { classification: "floor_plan", usable: false }),
    record("img_007", "unknown", { classification: "decorative_or_marketing", usable: false }),
    record("img_008", "building_exterior", { classification: "building_exterior", usable: false }),
  ]);
  assert.deepEqual(dist, { living_room: 2, kitchen: 1, exterior: 1 });
});

test("expectedRooms : chambres déclarées, WC et entrée implicites", () => {
  const expected = expectedRooms(LISTING);
  const bedroom = expected.find((e) => e.family === "bedroom");
  assert.equal(bedroom.count, 2);
  assert.equal(bedroom.reason, "declared");
  assert.ok(expected.some((e) => e.family === "bathroom" && e.importance === "high"));
  assert.ok(expected.some((e) => e.family === "toilet"));
  assert.deepEqual(expectedRooms({ property_type: "land" }), []);
  // Sans chambres déclarées : déduit de rooms - 1.
  const inferred = expectedRooms({ rooms: 3 }).find((e) => e.family === "bedroom");
  assert.equal(inferred.count, 2);
  assert.equal(inferred.reason, "inferred_from_rooms");
});

test("missingVisualCoverage : salle de bain déclarée mais absente des photos", () => {
  const rooms = [
    { room_id: "room_01", room_type: "living_room", image_ids: ["img_001"] },
    { room_id: "room_02", room_type: "kitchen", image_ids: ["img_002"] },
    { room_id: "room_03", room_type: "bedroom", image_ids: ["img_003"] },
    { room_id: "room_04", room_type: "bedroom", image_ids: ["img_004"] },
  ];
  const records = [
    record("img_001", "living_room"),
    record("img_002", "kitchen"),
    record("img_003", "bedroom"),
    record("img_004", "bedroom"),
  ];
  const missing = missingVisualCoverage(LISTING, rooms, records);
  const bathroom = missing.find((m) => m.room_type === "bathroom");
  assert.ok(bathroom, "la salle de bain doit manquer");
  assert.equal(bathroom.importance, "high");
  assert.equal(bathroom.missing_count, 1);
  assert.ok(!missing.some((m) => m.room_type === "bedroom"), "les deux chambres sont vues");
  assert.ok(missing.some((m) => m.room_type === "toilet"));
});

test("missingVisualCoverage : une des deux chambres annoncées n'est pas visible", () => {
  const rooms = [
    { room_id: "room_01", room_type: "living_room", image_ids: ["img_001"] },
    { room_id: "room_02", room_type: "bedroom", image_ids: ["img_002"] },
    { room_id: "room_03", room_type: "bathroom", image_ids: ["img_003"] },
    { room_id: "room_04", room_type: "kitchen", image_ids: ["img_004"] },
  ];
  const missing = missingVisualCoverage(LISTING, rooms, []);
  const bedroom = missing.find((m) => m.room_type === "bedroom");
  assert.equal(bedroom.missing_count, 1);
  assert.equal(bedroom.reason, "declared_but_not_shown");
});

test("photoCoverage : trois photos du salon seulement = couverture faible", () => {
  const rooms = [{ room_id: "room_01", room_type: "living_room", image_ids: ["img_001", "img_002", "img_003"] }];
  const records = [record("img_001", "living_room"), record("img_002", "living_room"), record("img_003", "living_room")];
  const coverage = photoCoverage(LISTING, rooms, records);
  assert.ok(coverage.score < 30, `score ${coverage.score}`);
  assert.equal(coverage.level, "poor");
  assert.ok(coverage.missing.includes("Cuisine"));
  assert.ok(coverage.missing.includes("Salle de bain / d'eau"));
});

test("photoCoverage : logement intégralement photographié = couverture élevée", () => {
  const rooms = [
    { room_id: "r1", room_type: "living_room" },
    { room_id: "r2", room_type: "kitchen" },
    { room_id: "r3", room_type: "bedroom" },
    { room_id: "r4", room_type: "bedroom" },
    { room_id: "r5", room_type: "bathroom" },
    { room_id: "r6", room_type: "toilet" },
    { room_id: "r7", room_type: "entrance" },
  ];
  const records = Array.from({ length: 12 }, (_, i) => record(`img_${i}`, "living_room"));
  const coverage = photoCoverage(LISTING, rooms, records);
  assert.equal(coverage.score, 100);
  assert.equal(coverage.level, "excellent");
  assert.deepEqual(coverage.missing, []);
});

test("photoDistributionWarning : séjour surreprésenté et salle de bain absente", () => {
  const records = [
    ...Array.from({ length: 9 }, (_, i) => record(`img_${i}`, "living_room")),
    record("img_k1", "kitchen"),
    record("img_k2", "kitchen"),
    record("img_b1", "bedroom"),
    record("img_b2", "bedroom"),
    record("img_b3", "bedroom"),
  ];
  const missing = [{ room_type: "bathroom", label: "Salle de bain / d'eau", importance: "high" }];
  const warning = photoDistributionWarning(records, missing);
  assert.equal(warning.status, true);
  assert.match(warning.observation, /64 % des photos montrent le séjour/);
  assert.match(warning.observation, /la salle de bain n'est pas visible/);

  // Rien de manquant d'important : pas d'avertissement.
  assert.equal(photoDistributionWarning(records, []).status, false);
  // Trop peu de photos : pas d'avertissement.
  assert.equal(photoDistributionWarning(records.slice(0, 3), missing).status, false);
});

test("photoAnalysisViewModel : palier fiabilité recalculé depuis le score (cache legacy)", () => {
  const vm = photoAnalysisViewModel(
    {
      ready: true,
      status: "ok",
      analysis_quality: { score: 62, confidence: "medium", partial: false },
      images: [],
    },
    []
  );
  assert.equal(vm.quality.confidence, "good");
});

test("qualityLevelFromScore : cinq paliers de mauvaise à excellente", () => {
  assert.equal(qualityLevelFromScore(100), "excellent");
  assert.equal(qualityLevelFromScore(80), "excellent");
  assert.equal(qualityLevelFromScore(79), "good");
  assert.equal(qualityLevelFromScore(55), "good");
  assert.equal(qualityLevelFromScore(54), "average");
  assert.equal(qualityLevelFromScore(45), "average");
  assert.equal(qualityLevelFromScore(44), "low");
  assert.equal(qualityLevelFromScore(30), "low");
  assert.equal(qualityLevelFromScore(29), "poor");
});

test("analysisQuality : 4 photos valent moins que 14, et les échecs pénalisent", () => {
  const few = analysisQuality({
    records: Array.from({ length: 4 }, (_, i) => record(`img_${i}`, "living_room")),
    coverage: { room_coverage: 0.5 },
  });
  const many = analysisQuality({
    records: Array.from({ length: 14 }, (_, i) => record(`img_${i}`, "living_room")),
    coverage: { room_coverage: 0.9 },
  });
  assert.ok(many.score > few.score);
  assert.equal(many.confidence, "excellent");
  assert.equal(many.usable_photo_count, 14);
  assert.equal(many.partial, false);

  const failed = analysisQuality({
    records: Array.from({ length: 14 }, (_, i) => record(`img_${i}`, "living_room")),
    coverage: { room_coverage: 0.9 },
    failures: 1,
    totalBatches: 2,
  });
  assert.ok(failed.score < many.score);
  assert.equal(failed.partial, true);
});

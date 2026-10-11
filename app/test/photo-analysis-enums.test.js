import test from "node:test";
import assert from "node:assert/strict";
import {
  coerceEnum,
  clampConfidence,
  clampScore,
  cleanText,
  cleanTextList,
  IMAGE_CLASSIFICATIONS,
  ROOM_CONDITIONS,
} from "../src/lib/photo-analysis/enums.js";
import {
  imageIndex,
  traceFinding,
  usableForNegotiation,
  MISSING_EVIDENCE_CONFIDENCE_FACTOR,
} from "../src/lib/photo-analysis/traceability.js";

test("coerceEnum : valeur connue, casse, alias et repli", () => {
  assert.equal(coerceEnum("virtual_staging", IMAGE_CLASSIFICATIONS), "virtual_staging");
  assert.equal(coerceEnum(" Floor_Plan ", IMAGE_CLASSIFICATIONS), "floor_plan");
  assert.equal(coerceEnum("heavily_retouch", IMAGE_CLASSIFICATIONS), "heavily_retouched");
  assert.equal(coerceEnum("invented_value", IMAGE_CLASSIFICATIONS), "unknown");
  assert.equal(coerceEnum(null, ROOM_CONDITIONS, "not_assessable"), "not_assessable");
  // Repli absent de la liste : dernière valeur (toujours une valeur « inconnue »).
  assert.equal(coerceEnum("x", ["a", "b", "unknown"], "zzz"), "unknown");
});

test("clampConfidence : borne [0,1], accepte 0-100 et chaînes", () => {
  assert.equal(clampConfidence(0.87), 0.87);
  assert.equal(clampConfidence(1.4), 1);
  assert.equal(clampConfidence(-0.2), 0);
  assert.equal(clampConfidence(85), 0.85);
  assert.equal(clampConfidence("0.6"), 0.6);
  assert.equal(clampConfidence(undefined), 0.5);
  assert.equal(clampConfidence("abc", 0), 0);
});

test("clampScore : entier 0-100, ratio accepté", () => {
  assert.equal(clampScore(58.4), 58);
  assert.equal(clampScore(0.72), 72);
  assert.equal(clampScore(140), 100);
  assert.equal(clampScore(null), null);
});

test("cleanText / cleanTextList : espaces, troncature, dédoublonnage", () => {
  assert.equal(cleanText("  Carrelage   ancien \n visible "), "Carrelage ancien visible");
  assert.equal(cleanText("", 10), null);
  assert.equal(cleanText("abcdefghij", 4), "abcd");
  assert.deepEqual(cleanTextList(["a", "a", { label: "b" }, 3, ""]), ["a", "b"]);
  assert.deepEqual(cleanTextList("pas une liste"), []);
});

test("traceFinding : filtre les images inconnues, abaisse la confiance sans preuve", () => {
  const index = imageIndex([
    { id: "img_001", usable_for_condition_analysis: true },
    { id: "img_002", usable_for_condition_analysis: false },
  ]);
  const traced = traceFinding(
    { label: "Humidité", confidence: 0.8, image_ids: ["img_001", "img_002", "img_999"] },
    index
  );
  assert.deepEqual(traced.image_ids, ["img_001"]);
  assert.equal(traced.evidence_missing, false);
  assert.equal(traced.confidence, 0.8);

  const orphan = traceFinding({ label: "x", confidence: 0.8, image_ids: ["img_002"] }, index);
  assert.deepEqual(orphan.image_ids, []);
  assert.equal(orphan.evidence_missing, true);
  assert.equal(orphan.confidence, Math.round(0.8 * MISSING_EVIDENCE_CONFIDENCE_FACTOR * 100) / 100);
  assert.equal(usableForNegotiation(orphan), false);
  assert.equal(usableForNegotiation(traced), true);
  assert.equal(usableForNegotiation({ confidence: 0.5, evidence_missing: false }), false);
});

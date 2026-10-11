import assert from "node:assert/strict";
import { test } from "node:test";
import createImagePassService from "../src/services/photo-analysis/image-pass.service.js";
import { IMAGE_PASS_SYSTEM } from "../src/services/photo-analysis/prompts.js";

const images = [
  { id: "img_001", order: 1, url: "https://x/1.jpg", dataUrl: "data:image/jpeg;base64,AA==" },
  { id: "img_002", order: 2, url: "https://x/2.jpg", dataUrl: "data:image/jpeg;base64,BB==" },
  { id: "img_003", order: 3, url: "https://x/3.jpg", dataUrl: "data:image/jpeg;base64,CC==" },
];

test("passe image : lot OK mais JSON incomplet → missing_from_model_response", async () => {
  const pass = createImagePassService({
    client: {
      configured: () => true,
      completeJson: async () => ({ images: [{ id: "img_001", classification: "real_interior", usable_for_condition_analysis: true, virtual_content: { status: "none" }, quality: { reliability: "high" } }] }),
    },
    vision: { batchSize: 3, imageDetail: "high" },
  });
  const { records, debug } = await pass.run(images);
  assert.equal(records[0].usable_for_condition_analysis, true);
  assert.equal(records[1].exclusion_reason, "missing_from_model_response");
  assert.equal(records[2].exclusion_reason, "missing_from_model_response");
  assert.deepEqual(debug.image_pass_batches[0].missing_ids, ["img_002", "img_003"]);
});

test("passe image : lot en échec → batch_failed et trace d'erreur", async () => {
  const pass = createImagePassService({
    client: {
      configured: () => true,
      completeJson: async () => {
        throw new Error("vision_invalid_json");
      },
    },
    vision: { batchSize: 3, imageDetail: "high" },
  });
  const { records, failures, debug } = await pass.run(images);
  assert.equal(failures, 1);
  assert.equal(records.every((r) => r.exclusion_reason === "batch_failed"), true);
  assert.equal(debug.image_pass_batches[0].status, "failed");
  assert.match(debug.image_pass_batches[0].error, /vision_invalid_json/);
});

/** Faux modèle : `unknown` au premier passage, vraie classification à la seconde lecture. */
function secondChanceClient(calls, { firstClassification = "unknown" } = {}) {
  return {
    configured: () => true,
    completeJson: async ({ parts }) => {
      const retry = /SECONDE LECTURE/.test(parts[0].text);
      const sent = parts
        .filter((p) => p.type === "text" && /Image id="/.test(p.text))
        .map((p) => /id="([^"]+)"/.exec(p.text)[1]);
      calls.push({ retry, sent });
      return {
        images: sent.map((id) => ({
          id,
          classification: id === "img_001" || retry ? "real_interior" : firstClassification,
          room_type: "bedroom",
          usable_for_condition_analysis: true,
          quality: { reliability: "high" },
        })),
      };
    },
  };
}

test("passe image : images unknown relues en petits lots et récupérées", async () => {
  const calls = [];
  const pass = createImagePassService({
    client: secondChanceClient(calls),
    vision: { batchSize: 3, imageDetail: "high", retryBatchSize: 1 },
  });
  const { records, failures, debug } = await pass.run(images);

  assert.equal(calls.length, 3, "1 lot initial + 2 relectures unitaires");
  assert.deepEqual(calls.filter((c) => c.retry).map((c) => c.sent), [["img_002"], ["img_003"]]);
  assert.equal(records.every((r) => r.usable_for_condition_analysis), true);
  assert.equal(records[1].retried, true);
  assert.equal(records[1].first_attempt.exclusion_reason, "unclassified");
  assert.equal(records[0].retried, undefined);
  assert.equal(failures, 0);
  assert.deepEqual(debug.recovered_ids, ["img_002", "img_003"]);
  assert.equal(debug.retry_batches.length, 2);
});

test("passe image : classification hors vocabulaire tracée, puis relue", async () => {
  const calls = [];
  const pass = createImagePassService({
    client: secondChanceClient(calls, { firstClassification: "chambre_vide" }),
    vision: { batchSize: 3, imageDetail: "high", maxRetryImages: 0 },
  });
  const { records, debug } = await pass.run(images);
  assert.equal(calls.length, 1, "seconde lecture désactivée");
  assert.equal(records[1].classification, "unknown");
  assert.equal(records[1].raw_classification, "chambre_vide");
  assert.deepEqual(debug.retried_ids, []);
});

test("passe image : lot en échec récupéré par la seconde lecture → plus compté en échec", async () => {
  let first = true;
  const pass = createImagePassService({
    client: {
      configured: () => true,
      completeJson: async ({ parts }) => {
        if (first) {
          first = false;
          throw new Error("vision_http_500");
        }
        const sent = parts
          .filter((p) => p.type === "text" && /Image id="/.test(p.text))
          .map((p) => /id="([^"]+)"/.exec(p.text)[1]);
        return {
          images: sent.map((id) => ({
            id,
            classification: "real_interior",
            usable_for_condition_analysis: true,
            quality: { reliability: "high" },
          })),
        };
      },
    },
    vision: { batchSize: 3, imageDetail: "high", retryBatchSize: 2 },
  });
  const { records, failures, debug } = await pass.run(images);
  assert.equal(failures, 0);
  assert.equal(records.every((r) => r.usable_for_condition_analysis), true);
  assert.equal(debug.image_pass_batches[0].status, "failed", "la trace du premier lot reste visible");
});

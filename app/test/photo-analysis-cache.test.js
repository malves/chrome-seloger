import test from "node:test";
import assert from "node:assert/strict";
import {
  PHOTO_ANALYSIS_PROVIDER,
  photoAnalysisInputFingerprint,
  photoAnalysisFromCache,
  photoAnalysisCachePayload,
} from "../src/lib/photo-analysis-cache.js";
import { createTestApp, createUser, listingPayload } from "./helpers.js";
import createListingsService from "../src/services/listings.service.js";

const LISTING = { description: "Bel appartement", property_type: "apartment", rooms: 3, bedrooms: 2 };
const PHOTOS = ["https://p.example.com/1.jpg", "https://p.example.com/2.jpg"];

test("empreinte : change avec les photos (ordre compris) et le contexte, pas avec l'adresse", () => {
  const base = photoAnalysisInputFingerprint(LISTING, PHOTOS);
  assert.equal(photoAnalysisInputFingerprint({ ...LISTING, user_address: "x", user_lat: 1 }, PHOTOS), base);
  assert.notEqual(photoAnalysisInputFingerprint(LISTING, [...PHOTOS].reverse()), base);
  assert.notEqual(photoAnalysisInputFingerprint(LISTING, PHOTOS.slice(0, 1)), base);
  assert.notEqual(photoAnalysisInputFingerprint({ ...LISTING, bedrooms: 3 }, PHOTOS), base);
  assert.notEqual(photoAnalysisInputFingerprint({ ...LISTING, description: "Autre" }, PHOTOS), base);
});

test("fromCache : renvoie le résultat si l'empreinte correspond, sinon null", () => {
  const result = { status: "ok", summary: "ok" };
  const row = {
    status: "ok",
    fetched_at: "2026-01-01T00:00:00.000Z",
    data: photoAnalysisCachePayload(LISTING, PHOTOS, result),
  };
  const hit = photoAnalysisFromCache(row, LISTING, PHOTOS);
  assert.equal(hit.summary, "ok");
  assert.equal(hit.cached, true);
  assert.equal(hit.cached_at, row.fetched_at);

  assert.equal(photoAnalysisFromCache(row, LISTING, PHOTOS.slice(0, 1)), null);
  assert.equal(photoAnalysisFromCache({ ...row, status: "error" }, LISTING, PHOTOS), null);
  assert.equal(photoAnalysisFromCache(null, LISTING, PHOTOS), null);
});

test("listings.service.save : une nouvelle liste de photos invalide le cache d'analyse", async (t) => {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  const user = await createUser(ctx.repositories, "a@example.com");
  const service = createListingsService({ repositories: ctx.repositories });

  const { id } = service.save(user, listingPayload({ photos: PHOTOS }));
  ctx.repositories.enrichments.saveListingResult(id, PHOTO_ANALYSIS_PROVIDER, {
    status: "ok",
    data: { inputFingerprint: "x", result: { status: "ok" } },
  });

  // Même capture (mêmes photos, même texte) : cache conservé.
  service.save(user, listingPayload({ photos: PHOTOS }));
  assert.ok(ctx.repositories.enrichments.findOne(id, PHOTO_ANALYSIS_PROVIDER));

  // Mise à jour : galerie et description déjà stockées ne sont pas réécrites,
  // le cache d'analyse est conservé.
  service.save(user, listingPayload({ photos: [...PHOTOS, "https://p.example.com/3.jpg"] }));
  assert.ok(ctx.repositories.enrichments.findOne(id, PHOTO_ANALYSIS_PROVIDER));

  service.save(
    user,
    listingPayload({ photos: [...PHOTOS, "https://p.example.com/3.jpg"], description: "Nouveau texte" })
  );
  assert.ok(ctx.repositories.enrichments.findOne(id, PHOTO_ANALYSIS_PROVIDER));
  assert.equal(ctx.repositories.listings.findById(user.id, id).description, "Belle maison familiale.");
  assert.deepEqual(ctx.repositories.listings.listPhotos(id), PHOTOS);
});

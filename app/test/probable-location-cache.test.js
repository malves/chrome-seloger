import test from "node:test";
import assert from "node:assert/strict";

import {
  probableLocationInputFingerprint,
  probableLocationInputFingerprintLegacy,
  probableLocationFromCache,
  probableLocationCachePayload,
} from "../src/lib/probable-location-cache.js";

const listing = {
  description: "À 5 min de la gare",
  city: "Saint-Cloud",
  postal_code: "92210",
  user_lat: null,
  user_lng: null,
};

test("empreinte change si description change, pas si adresse réelle change", () => {
  const a = probableLocationInputFingerprint(listing);
  const b = probableLocationInputFingerprint({
    ...listing,
    description: "Autre texte",
  });
  const c = probableLocationInputFingerprint({
    ...listing,
    user_lat: 48.85,
    user_lng: 2.21,
  });
  assert.notEqual(a, b);
  assert.equal(a, c);
});

test("cache encore valide avec empreinte legacy (lat/lng vides)", () => {
  const legacyFp = probableLocationInputFingerprintLegacy(listing);
  const row = {
    status: "ok",
    fetched_at: "2026-01-01T12:00:00.000Z",
    data: {
      inputFingerprint: legacyFp,
      result: { status: "estimated", confidence: 0.5, center: { latitude: 1, longitude: 2 } },
    },
  };
  const hit = probableLocationFromCache(row, listing);
  assert.equal(hit?.status, "estimated");
});

test("cache valide uniquement si empreinte correspond", () => {
  const fp = probableLocationInputFingerprint(listing);
  const row = {
    status: "ok",
    fetched_at: "2026-01-01T12:00:00.000Z",
    data: {
      inputFingerprint: fp,
      result: { status: "estimated", confidence: 0.5, center: { latitude: 1, longitude: 2 } },
    },
  };
  const hit = probableLocationFromCache(row, listing);
  assert.equal(hit.cached, true);
  assert.equal(hit.status, "estimated");
  assert.equal(hit.cached_at, row.fetched_at);

  const miss = probableLocationFromCache(row, { ...listing, city: "Paris" });
  assert.equal(miss, null);
});

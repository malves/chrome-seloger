import test from "node:test";
import assert from "node:assert/strict";

import createAccessibilityService, {
  minutesCutoff,
} from "../src/services/location/accessibility.service.js";

const CONSTRAINT = {
  place: "Gare",
  latitude: 48.84,
  longitude: 2.21,
  transport: "walking",
  max_minutes: 5,
};

test("minutesCutoff : seuil cohérent avec la tolérance (défaut span = M)", () => {
  assert.equal(minutesCutoff(5, { graceRatio: 0, spanRatio: 1 }), 10);
  assert.equal(minutesCutoff(6, { graceRatio: 0, spanRatio: 0.5 }), 9);
});

test("buildTimeAccess : isochrones ORS → bandes triées par minutes", async () => {
  const seen = {};
  const orsPost = async (profile, body) => {
    seen.profile = profile;
    seen.body = body;
    // ORS renvoie les features, ici volontairement dans le désordre.
    return {
      features: [
        {
          properties: { value: 600 },
          geometry: { coordinates: [[[2.20, 48.83], [2.22, 48.83], [2.22, 48.85], [2.20, 48.85], [2.20, 48.83]]] },
        },
        {
          properties: { value: 300 },
          geometry: { coordinates: [[[2.205, 48.835], [2.215, 48.835], [2.215, 48.845], [2.205, 48.845], [2.205, 48.835]]] },
        },
      ],
    };
  };

  const service = createAccessibilityService({ orsPost });
  assert.equal(service.configured(), true);
  const access = await service.buildTimeAccess(CONSTRAINT);

  assert.equal(access.mode, "isochrone");
  assert.equal(seen.profile, "foot-walking");
  assert.equal(seen.body.location_type, "destination");
  assert.equal(seen.body.range_type, "time");
  // Bandes triées croissant.
  assert.deepEqual(
    access.bands.map((b) => b.minutes),
    [5, 10]
  );
});

test("buildTimeAccess : sans ORS → mode cercle", async () => {
  const service = createAccessibilityService({
    openRouteService: { apiKey: "", baseUrl: "", timeoutMs: 1000 },
  });
  assert.equal(service.configured(), false);
  const access = await service.buildTimeAccess(CONSTRAINT);
  assert.equal(access.mode, "circle");
  assert.equal(access.cutoffMinutes, 10);
});

test("buildTimeAccess : ORS en échec → repli cercle", async () => {
  const service = createAccessibilityService({
    orsPost: async () => {
      throw new Error("ors down");
    },
  });
  const access = await service.buildTimeAccess(CONSTRAINT);
  assert.equal(access.mode, "circle");
});

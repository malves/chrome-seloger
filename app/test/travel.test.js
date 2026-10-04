import test from "node:test";
import assert from "node:assert/strict";
import config from "../src/config.js";
import createTravelService from "../src/services/travel.service.js";

/**
 * Le service parle à OpenRouteService : on remplace `fetch` par un double qui
 * répond selon l'URL (géocodage ou itinéraire), sans aucun appel réseau.
 */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [pattern, make] of routes) {
      if (String(url).includes(pattern)) return make();
    }
    throw new Error(`URL inattendue : ${url}`);
  };
  return calls;
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function geocode(lat, lon, label) {
  return jsonResponse({
    features: [{ geometry: { coordinates: [lon, lat] }, properties: { label } }],
  });
}

function directions(duration, distance) {
  return jsonResponse({ routes: [{ summary: { duration, distance } }] });
}

/** Service configuré avec une clé factice, le temps d'un test. */
function configuredService() {
  const original = config.openRouteService.apiKey;
  config.openRouteService.apiKey = "cle-de-test";
  const service = createTravelService({ logger: console });
  return {
    service,
    restore() {
      config.openRouteService.apiKey = original;
    },
  };
}

const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("sans clé ORS, le calcul se déclare indisponible", async () => {
  const original = config.openRouteService.apiKey;
  config.openRouteService.apiKey = "";
  try {
    const service = createTravelService({ logger: console });
    assert.equal(service.configured(), false);
    await assert.rejects(
      () =>
        service.compute({
          origin: { lat: 48.1, lon: 2 },
          destinations: [{ address: "Paris" }],
        }),
      (err) => err.code === "travel_unavailable" && err.status === 503
    );
    stubFetch([
      [
        "api-adresse.data.gouv.fr",
        () => geocode(48.86, 2.35, "Paris"),
      ],
    ]);
    // Sans clé ORS, repli sur la BAN.
    assert.deepEqual(await service.geocodeAddress("Paris"), {
      lat: 48.86,
      lon: 2.35,
      label: "Paris",
    });
  } finally {
    config.openRouteService.apiKey = original;
  }
});

test("un trajet par adresse de référence, id et libellé conservés", async () => {
  const { service, restore } = configuredService();
  stubFetch([
    ["text=Bien", () => geocode(48.5, 2.1, "Bien, Rambouillet")],
    ["text=Bureau", () => geocode(48.86, 2.35, "Bureau, Paris")],
    ["/v2/directions/driving-car", () => directions(2700, 42000)],
  ]);

  try {
    const result = await service.compute({
      origin: { address: "Bien" },
      destinations: [{ id: 7, label: "Bureau", address: "Bureau" }],
    });
    assert.equal(result.origin.label, "Bien, Rambouillet");
    assert.equal(result.results.length, 1);
    assert.deepEqual(result.results[0], {
      id: 7,
      label: "Bureau",
      address: "Bureau",
      duration_seconds: 2700,
      distance_meters: 42000,
      lat: 48.86,
      lon: 2.35,
    });
  } finally {
    restore();
  }
});

test("des coordonnées stockées évitent le géocodage de la destination", async () => {
  const { service, restore } = configuredService();
  const calls = stubFetch([
    ["/v2/directions/driving-car", () => directions(1200, 15000)],
  ]);

  try {
    const result = await service.compute({
      origin: { lat: 48.86, lon: 2.35 },
      destinations: [{ id: 1, label: "Maison", lat: 48.5, lon: 2.1 }],
    });
    assert.equal(result.results[0].duration_seconds, 1200);
    // Aucun géocodage : seul l'itinéraire est appelé.
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes("/v2/directions/driving-car"));
  } finally {
    restore();
  }
});

test("une destination en échec n'empêche pas les autres", async () => {
  const { service, restore } = configuredService();
  stubFetch([
    ["text=introuvable", () => jsonResponse({ features: [] })],
    ["/geocode/search", () => geocode(48.9, 2.4, "OK")],
    ["/v2/directions/driving-car", () => directions(600, 8000)],
  ]);

  try {
    const result = await service.compute({
      origin: { lat: 48.86, lon: 2.35 },
      destinations: [
        { id: 1, label: "Introuvable", address: "introuvable" },
        { id: 2, label: "Gare", address: "Gare" },
      ],
    });
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].error, "destination_unresolved");
    assert.equal(result.results[1].duration_seconds, 600);
  } finally {
    restore();
  }
});

test("l'absence d'itinéraire routier est signalée sur la destination", async () => {
  const { service, restore } = configuredService();
  stubFetch([
    ["/v2/directions/driving-car", () => jsonResponse({ routes: [] })],
  ]);

  try {
    const result = await service.compute({
      origin: { lat: 48.86, lon: 2.35 },
      destinations: [{ id: 1, lat: 48.5, lon: 2.1 }],
    });
    assert.equal(result.results[0].error, "no_route");
  } finally {
    restore();
  }
});

test("une clé refusée par ORS fait échouer tout le calcul", async () => {
  const { service, restore } = configuredService();
  stubFetch([
    ["/v2/directions/driving-car", () => jsonResponse(null, { ok: false, status: 403 })],
  ]);

  try {
    const result = await service.compute({
      origin: { lat: 48.86, lon: 2.35 },
      destinations: [{ id: 1, lat: 48.5, lon: 2.1 }],
    });
    assert.equal(result.results[0].error, "travel_upstream");
  } finally {
    restore();
  }
});

test("geocodeAddress renvoie des coordonnées quand ORS répond", async () => {
  const { service, restore } = configuredService();
  stubFetch([["/geocode/search", () => geocode(48.86, 2.35, "Paris, France")]]);
  try {
    assert.deepEqual(await service.geocodeAddress("Paris"), {
      lat: 48.86,
      lon: 2.35,
      label: "Paris, France",
    });
  } finally {
    restore();
  }
});

test("geocodeAddress utilise la BAN si ORS refuse le géocodage", async () => {
  const { service, restore } = configuredService();
  stubFetch([
    ["/geocode/search", () => jsonResponse({ error: "disallowed" }, { ok: false, status: 403 })],
    ["api-adresse.data.gouv.fr", () => geocode(48.86, 2.35, "Paris")],
  ]);
  try {
    assert.deepEqual(await service.geocodeAddress("Paris"), {
      lat: 48.86,
      lon: 2.35,
      label: "Paris",
    });
  } finally {
    restore();
  }
});

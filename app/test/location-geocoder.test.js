import test from "node:test";
import assert from "node:assert/strict";

import createPlaceGeocoderService from "../src/services/location/place-geocoder.service.js";

/** Cache en mémoire implémentant l'interface de geocode-cache.repo. */
function fakeCache() {
  const store = new Map();
  const key = (provider, query) =>
    `${provider}::${String(query).trim().toLowerCase()}`;
  return {
    get: (p, q) => store.get(key(p, q)) || null,
    set: (p, q, r) =>
      store.set(key(p, q), { found: Boolean(r?.found), ...r, raw: null }),
  };
}

/** Résultat Nominatim minimal. */
function nominatimHit({ lat, lon, importance = 0.4, cls, type, city, postcode, name }) {
  return {
    lat: String(lat),
    lon: String(lon),
    importance,
    class: cls,
    type,
    display_name: name,
    address: { city, postcode },
  };
}

/** Construit un service avec un httpGetJson routé par le paramètre `q`. */
function serviceWith(handler, { cache } = {}) {
  const calls = { nominatim: 0, ban: 0 };
  const httpGetJson = async (url) => {
    const u = new URL(url);
    const q = u.searchParams.get("q") || "";
    if (url.includes("nominatim")) {
      calls.nominatim += 1;
      return handler("nominatim", q);
    }
    calls.ban += 1;
    return handler("ban", q);
  };
  const service = createPlaceGeocoderService({
    repositories: { geocodeCache: cache || fakeCache() },
    logger: { warn() {}, info() {} },
    httpGetJson,
  });
  return { service, calls };
}

const CITY = { city: "Saint-Cloud", postalCode: "92210" };

test("géocode une gare et la désambiguïse par ville + code postal", async () => {
  const { service } = serviceWith((provider, q) => {
    if (provider !== "nominatim") return { features: [] };
    if (/val d/i.test(q)) {
      return [
        nominatimHit({
          lat: 48.8405,
          lon: 2.211,
          importance: 0.4,
          cls: "railway",
          type: "station",
          city: "Saint-Cloud",
          postcode: "92210",
          name: "Gare du Val d'Or, Saint-Cloud",
        }),
        nominatimHit({
          lat: 45.0,
          lon: 1.0,
          importance: 0.45,
          cls: "railway",
          type: "station",
          city: "Ailleurs",
          postcode: "00000",
          name: "Val d'Or, Ailleurs",
        }),
      ];
    }
    // Requête centre commune.
    return [
      nominatimHit({
        lat: 48.84,
        lon: 2.21,
        importance: 0.5,
        cls: "place",
        type: "city",
        city: "Saint-Cloud",
        postcode: "92210",
        name: "Saint-Cloud",
      }),
    ];
  });

  const { constraints } = await service.geocodeConstraints(
    [
      {
        place: "Gare du Val d'Or",
        place_type: "train_station",
        relation: "travel_time",
        max_minutes: 5,
        transport: "walking",
      },
    ],
    CITY
  );

  assert.equal(constraints.length, 1);
  const gare = constraints[0];
  assert.ok(!gare.rejected, "la gare doit être retenue");
  assert.ok(Math.abs(gare.latitude - 48.8405) < 1e-6);
  assert.ok(Math.abs(gare.longitude - 2.211) < 1e-6);
  assert.ok(gare.geocoding_confidence > 0.3);
});

test("rejette un lieu ambigu (deux candidats ex æquo éloignés)", async () => {
  const { service } = serviceWith((provider, q) => {
    if (provider !== "nominatim") return { features: [] };
    if (/monoprix/i.test(q)) {
      return [
        nominatimHit({
          lat: 48.845,
          lon: 2.215,
          importance: 0.3,
          cls: "shop",
          type: "supermarket",
          city: "Saint-Cloud",
          postcode: "92210",
          name: "Monoprix A",
        }),
        nominatimHit({
          lat: 48.86,
          lon: 2.26, // ~4 km de A : trop loin pour un doublon
          importance: 0.3,
          cls: "shop",
          type: "supermarket",
          city: "Saint-Cloud",
          postcode: "92210",
          name: "Monoprix B",
        }),
      ];
    }
    return [
      nominatimHit({
        lat: 48.84,
        lon: 2.21,
        importance: 0.5,
        cls: "place",
        type: "city",
        city: "Saint-Cloud",
        postcode: "92210",
        name: "Saint-Cloud",
      }),
    ];
  });

  const { constraints } = await service.geocodeConstraints(
    [{ place: "Monoprix", place_type: "shop", relation: "near", vague_kind: "proche" }],
    CITY
  );
  assert.equal(constraints[0].rejected, true);
  assert.equal(constraints[0].reject_reason, "not_found");
});

test("repli BAN quand Nominatim ne trouve rien", async () => {
  const { service } = serviceWith((provider, q) => {
    if (provider === "nominatim") {
      // Centre commune trouvé, mais POI introuvable.
      if (/saint-cloud/i.test(q) && !/rue/i.test(q)) {
        return [
          nominatimHit({
            lat: 48.84,
            lon: 2.21,
            importance: 0.5,
            cls: "place",
            type: "city",
            city: "Saint-Cloud",
            postcode: "92210",
          }),
        ];
      }
      return [];
    }
    // BAN
    return {
      features: [
        {
          geometry: { coordinates: [2.2123, 48.8411] },
          properties: { label: "10 Rue Dailly 92210 Saint-Cloud", score: 0.82 },
        },
      ],
    };
  });

  const { constraints } = await service.geocodeConstraints(
    [{ place: "10 rue Dailly", place_type: "address", relation: "near" }],
    CITY
  );
  const addr = constraints[0];
  assert.ok(!addr.rejected, "l'adresse doit être résolue via la BAN");
  assert.ok(Math.abs(addr.latitude - 48.8411) < 1e-6);
  assert.ok(Math.abs(addr.longitude - 2.2123) < 1e-6);
});

test("le cache évite un second appel réseau pour la même requête", async () => {
  const cache = fakeCache();
  const handler = (provider, q) => {
    if (provider !== "nominatim") return { features: [] };
    if (/val d/i.test(q)) {
      return [
        nominatimHit({
          lat: 48.8405,
          lon: 2.211,
          importance: 0.4,
          cls: "railway",
          type: "station",
          city: "Saint-Cloud",
          postcode: "92210",
        }),
      ];
    }
    return [
      nominatimHit({
        lat: 48.84,
        lon: 2.21,
        importance: 0.5,
        cls: "place",
        type: "city",
        city: "Saint-Cloud",
        postcode: "92210",
      }),
    ];
  };

  const first = serviceWith(handler, { cache });
  await first.service.geocodeConstraints(
    [{ place: "Gare du Val d'Or", place_type: "train_station", relation: "near" }],
    CITY
  );
  const callsFirst = first.calls.nominatim;
  assert.ok(callsFirst >= 1);

  const second = serviceWith(handler, { cache });
  await second.service.geocodeConstraints(
    [{ place: "Gare du Val d'Or", place_type: "train_station", relation: "near" }],
    CITY
  );
  assert.equal(second.calls.nominatim, 0, "tout doit venir du cache au 2e passage");
});

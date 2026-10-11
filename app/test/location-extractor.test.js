import test from "node:test";
import assert from "node:assert/strict";

import createConstraintExtractorService, {
  vagueKindFrom,
} from "../src/services/location/constraint-extractor.service.js";

const NO_LLM = { apiKey: "", baseUrl: "", model: "", timeoutMs: 1000 };

/** Construit un service avec une réponse LLM figée (aucun réseau). */
function withCompletion(content) {
  return createConstraintExtractorService({
    chatCompletion: async () => content,
  });
}

test("vagueKindFrom : normalise les formules vagues (accents inclus)", () => {
  assert.equal(vagueKindFrom("à deux pas"), "a deux pas");
  assert.equal(vagueKindFrom("À proximité"), "a proximite");
  assert.equal(vagueKindFrom("proche"), "proche");
  assert.equal(vagueKindFrom("face à"), "face a");
  assert.equal(vagueKindFrom("inconnu"), null);
});

test("extract : sans LLM configuré → indisponible", async () => {
  const service = createConstraintExtractorService({ llm: NO_LLM });
  assert.equal(service.configured(), false);
  const out = await service.extract({ description: "Proche de la gare." });
  assert.equal(out.available, false);
});

test("extract : parse et normalise les contraintes temporelles et vagues", async () => {
  const service = withCompletion(
    JSON.stringify({
      exact_address: null,
      constraints: [
        {
          place: "Gare du Val d'Or",
          place_type: "train_station",
          relation: "travel_time",
          max_minutes: 5,
          transport: "walking",
          precision: "approximate",
          confidence: 0.98,
        },
        {
          place: "Monoprix",
          place_type: "shop",
          relation: "near",
          max_minutes: null,
          transport: "walking",
          precision: "vague",
          vague_kind: "proche",
          confidence: 0.88,
        },
      ],
    })
  );

  const out = await service.extract({
    description: "À 5 min à pied de la gare du Val d'Or et proche du Monoprix.",
    city: "Saint-Cloud",
    postalCode: "92210",
  });

  assert.equal(out.available, true);
  assert.equal(out.constraints.length, 2);

  const [gare, mono] = out.constraints;
  assert.equal(gare.relation, "travel_time");
  assert.equal(gare.max_minutes, 5);
  assert.equal(gare.transport, "walking");
  assert.equal(gare.place_type, "train_station");

  assert.equal(mono.relation, "near");
  assert.equal(mono.max_minutes, null);
  assert.equal(mono.max_meters, null);
  assert.equal(mono.vague_kind, "proche");
  assert.equal(mono.precision, "vague");
});

test("extract : n'invente pas de distance absente (relation déduite = near)", async () => {
  const service = withCompletion(
    JSON.stringify({
      constraints: [
        { place: "le parc", place_type: "park", confidence: 0.7 },
      ],
    })
  );
  const out = await service.extract({ description: "À côté du parc." });
  assert.equal(out.constraints.length, 1);
  assert.equal(out.constraints[0].relation, "near");
  assert.equal(out.constraints[0].max_minutes, null);
  assert.equal(out.constraints[0].max_meters, null);
});

test("extract : type/transport inconnus repliés sur des valeurs sûres", async () => {
  const service = withCompletion(
    JSON.stringify({
      constraints: [
        {
          place: "Truc",
          place_type: "licorne",
          relation: "travel_time",
          max_minutes: 10,
          transport: "teleportation",
          confidence: 2, // hors bornes → ramené à 1
        },
      ],
    })
  );
  const out = await service.extract({ description: "à 10 min du Truc" });
  const c = out.constraints[0];
  assert.equal(c.place_type, "other");
  assert.equal(c.transport, "walking");
  assert.equal(c.confidence, 1);
});

test("extract : réponse LLM non-JSON → disponible mais sans contraintes", async () => {
  const service = withCompletion("désolé, je ne peux pas répondre en JSON");
  const out = await service.extract({ description: "à 5 min de la gare" });
  assert.equal(out.available, true);
  assert.deepEqual(out.constraints, []);
});

test("extract : LLM injoignable → indisponible", async () => {
  const service = createConstraintExtractorService({
    chatCompletion: async () => {
      throw new Error("network down");
    },
  });
  const out = await service.extract({ description: "à 5 min de la gare" });
  assert.equal(out.available, false);
});

test("extract : adresse exacte détectée est remontée", async () => {
  const service = withCompletion(
    JSON.stringify({ exact_address: "12 rue des Lilas", constraints: [] })
  );
  const out = await service.extract({ description: "12 rue des Lilas, Saint-Cloud" });
  assert.equal(out.exactAddress, "12 rue des Lilas");
});

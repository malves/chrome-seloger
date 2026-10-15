import test from "node:test";
import assert from "node:assert/strict";
import createRentEstimateService, {
  extractResponsesOutput,
  normalizeRentEstimate,
  stripJsonFence,
  buildUserPrompt,
} from "../src/services/rent/rent-estimate.service.js";

const VALID_JSON = {
  granularity: "street",
  rent_m2: { low: 19, mid: 22, high: 26 },
  furnished_rent_m2_mid: 28,
  rent_control: {
    applies: true,
    reference_m2: 21.5,
    reference_max_m2: 25.8,
  },
  confidence: 0.72,
  sources: [
    {
      name: "Observatoire des loyers",
      url: "https://www.observatoires-des-loyers.org/",
      period: "2025",
    },
  ],
  notes: "Encadrement applicable.",
};

function responsesPayload(text, citations = []) {
  return {
    output_text: text,
    output: [
      {
        type: "web_search_call",
        status: "completed",
      },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text,
            annotations: citations.map((c) => ({
              type: "url_citation",
              url: c.url,
              title: c.title,
            })),
          },
        ],
      },
    ],
  };
}

test("extraction Responses : texte JSON et citations", () => {
  const extracted = extractResponsesOutput(
    responsesPayload(JSON.stringify(VALID_JSON), [
      { url: "https://www.anil.org/", title: "ANIL" },
    ])
  );
  assert.match(extracted.text, /"granularity"/);
  assert.equal(extracted.citations[0].url, "https://www.anil.org/");
  assert.equal(extracted.citations[0].name, "ANIL");
});

test("normalisation : bornes et ordre de fourchette", () => {
  const data = normalizeRentEstimate(
    {
      ...VALID_JSON,
      rent_m2: { low: 26, mid: 19, high: 22 },
      furnished_rent_m2_mid: 200,
    },
    {
      citations: [{ name: "ANIL", url: "https://www.anil.org/", period: "" }],
      webSearch: true,
    }
  );
  assert.deepEqual(data.rent_m2, { low: 19, mid: 22, high: 26 });
  assert.equal(data.furnished_rent_m2_mid, null);
  assert.equal(data.sources.length, 2);
  assert.equal(data.web_search, true);
});

test("service : réponse Responses simulée", async () => {
  const service = createRentEstimateService({
    rent: { apiKey: "test", webSearch: true, model: "gpt-5-mini" },
    responsesCall: async () =>
      responsesPayload(JSON.stringify(VALID_JSON), [
        { url: "https://www.anil.org/", title: "ANIL" },
      ]),
  });
  const result = await service.estimate({
    property_type: "apartment",
    surface: 80,
    price: 520000,
    city: "Puteaux",
    postal_code: "92800",
    user_address: "12 rue Jean Jaurès, 92800 Puteaux",
  });
  assert.equal(result.available, true);
  assert.equal(result.data.rent_m2.mid, 22);
  assert.equal(result.data.granularity, "street");
  assert.ok(result.data.sources.some((s) => s.url.includes("anil.org")));
});

test("service : JSON invalide", async () => {
  const service = createRentEstimateService({
    rent: { apiKey: "test", webSearch: true },
    responsesCall: async () => responsesPayload("ce n'est pas du json"),
  });
  const result = await service.estimate({ surface: 50, city: "Paris" });
  assert.equal(result.available, false);
  assert.equal(result.error, "rent_invalid_response");
});

test("service : fourchette hors bornes → réponse invalide", async () => {
  const service = createRentEstimateService({
    rent: { apiKey: "test", webSearch: false },
    chatCompletion: async () =>
      JSON.stringify({
        ...VALID_JSON,
        rent_m2: { low: 0.5, mid: 200, high: 400 },
      }),
  });
  const result = await service.estimate({ surface: 50 });
  assert.equal(result.available, false);
  assert.equal(result.error, "rent_invalid_response");
});

test("service : non configuré", async () => {
  const service = createRentEstimateService({
    rent: { apiKey: "", webSearch: true, baseUrl: "https://api.openai.com/v1" },
  });
  assert.equal(service.configured(), false);
  const result = await service.estimate({ surface: 40 });
  assert.equal(result.available, false);
  assert.equal(result.error, "llm_not_configured");
});

test("prompt utilisateur et clôture markdown", () => {
  const prompt = buildUserPrompt({
    user_address: "10 rue des Lilas, 75011 Paris",
    city: "Paris",
    postal_code: "75011",
    property_type: "apartment",
    surface: 42,
    rooms: 2,
    dpe: "D",
    title: "Appartement meublé",
  });
  assert.match(prompt, /10 rue des Lilas/);
  assert.match(prompt, /appartement/);
  assert.match(prompt, /meublé/);
  assert.equal(
    stripJsonFence("```json\n{\"a\":1}\n```"),
    '{"a":1}'
  );
});

test("prompt sans adresse : commune et type de bien uniquement", () => {
  const prompt = buildUserPrompt({
    city: "Suresnes",
    postal_code: "92150",
    insee_code: "92073",
    property_type: "apartment",
    surface: 42,
    rooms: 2,
    floor: 3,
    dpe: "D",
    price: 380000,
    title: "Appartement meublé",
  });
  assert.match(prompt, /Suresnes/);
  assert.match(prompt, /92073/);
  assert.match(prompt, /appartement/);
  assert.match(prompt, /toutes surfaces confondues/);
  assert.doesNotMatch(prompt, /42 m²|Pièces|Étage|DPE|380000|Meublé/);
});

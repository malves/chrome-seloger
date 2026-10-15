/**
 * Estimation de la valeur locative (€/m²) via un LLM compatible OpenAI.
 *
 * Par défaut : API Responses + outil `web_search` et sortie `json_schema`
 * stricte. Repli `RENT_WEB_SEARCH=false` : `/chat/completions` sans recherche.
 * L'appel réseau est injectable (`responsesCall` / `chatCompletion`) pour
 * tester sans clé ni réseau.
 */

import { z } from "zod";
import config from "../../config.js";
import { listingTerritory } from "../../lib/listing-territory.js";
import {
  RENT_ESTIMATE_VERSION,
  normalizeRentBand,
  clampRentM2,
  buildRentHttpError,
} from "../../lib/rent-estimate.js";

const GRANULARITIES = ["address", "street", "neighborhood", "commune"];

export const RENT_ESTIMATE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "granularity",
    "rent_m2",
    "furnished_rent_m2_mid",
    "rent_control",
    "confidence",
    "sources",
    "notes",
  ],
  properties: {
    granularity: {
      type: "string",
      enum: GRANULARITIES,
    },
    rent_m2: {
      type: "object",
      additionalProperties: false,
      required: ["low", "mid", "high"],
      properties: {
        low: { type: "number" },
        mid: { type: "number" },
        high: { type: "number" },
      },
    },
    furnished_rent_m2_mid: { type: ["number", "null"] },
    rent_control: {
      type: "object",
      additionalProperties: false,
      required: ["applies", "reference_m2", "reference_max_m2"],
      properties: {
        applies: { type: "boolean" },
        reference_m2: { type: ["number", "null"] },
        reference_max_m2: { type: ["number", "null"] },
      },
    },
    confidence: { type: "number" },
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "url", "period"],
        properties: {
          name: { type: "string" },
          url: { type: "string" },
          period: { type: "string" },
        },
      },
    },
    notes: { type: "string" },
  },
};

const nullableNumber = z
  .union([z.number(), z.null()])
  .optional()
  .transform((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));

const outputSchema = z.object({
  granularity: z.string(),
  rent_m2: z.object({
    low: z.number(),
    mid: z.number(),
    high: z.number(),
  }),
  furnished_rent_m2_mid: nullableNumber,
  rent_control: z
    .object({
      applies: z.boolean().optional(),
      reference_m2: nullableNumber,
      reference_max_m2: nullableNumber,
    })
    .optional(),
  confidence: z.number().optional(),
  sources: z
    .array(
      z.object({
        name: z.string().optional(),
        url: z.string().optional(),
        period: z.string().optional(),
      })
    )
    .optional(),
  notes: z.string().optional(),
});

export const SYSTEM_PROMPT = `Tu es un estimateur de valeur locative pour l'immobilier résidentiel en France.
Tu dois estimer le loyer mensuel HORS CHARGES d'un bien, en €/m², à l'adresse la plus précise possible.

Règles :
- Estime la LOCATION NUE (non meublée), hors charges, hors honoraires.
- Privilégie les sources officielles : observatoires locaux des loyers (OLL), carte des loyers de l'État, ANIL, encadrement des loyers (préfecture / mairie), Clameur.
- Complète ensuite avec les observatoires de marché (SeLoger, MeilleursAgents, Seloger, PAP) si besoin.
- Ne JAMAIS inventer un chiffre. Si une valeur est introuvable, renvoie null.
- Si tu ne trouves des données qu'à l'échelle de la commune, dis-le via "granularity": "commune".
- "rent_m2.low" = fourchette basse (environ 1er quartile), "mid" = loyer de marché le plus probable (médiane), "high" = fourchette haute (environ 3e quartile).
- Encadrement des loyers : "applies" true seulement dans une zone réellement encadrée (Paris, Lille, Lyon, Bordeaux, Montpellier, etc.). "reference_m2" = loyer de référence, "reference_max_m2" = loyer de référence majoré.
- "confidence" : 0 à 1 selon la qualité et la fraîcheur des sources.
- "sources" : nom, URL et période des sources réellement utilisées. Distingue clairement observatoire (loyer constaté) et portails d'annonces (loyer demandé).
- Réponds UNIQUEMENT avec le JSON demandé, sans texte autour.`;

function propertyTypeLabel(type) {
  if (type === "house") return "maison";
  if (type === "apartment") return "appartement";
  return type || "logement";
}

function furnishedHint(listing) {
  const text = `${listing?.title || ""} ${listing?.description || ""}`;
  if (/non[\s-]?meubl/i.test(text)) return "non meublé (mentionné dans l'annonce)";
  if (/meubl/i.test(text)) return "meublé (mentionné dans l'annonce) — estime quand même la location nue";
  return "non précisé — estime la location nue";
}

/**
 * Sans adresse saisie, le résultat est partagé par toute la commune (cache
 * par INSEE et type de bien) : aucune caractéristique propre au bien.
 */
function buildCommunePrompt(listing, territory, iso) {
  return [
    `Date du jour : ${iso}`,
    "Échelle : commune entière (pas d'adresse précise)",
    territory.city ? `Ville : ${territory.city}` : null,
    territory.postal_code ? `Code postal : ${territory.postal_code}` : null,
    listing?.insee_code ? `Code INSEE : ${listing.insee_code}` : null,
    `Type de bien : ${propertyTypeLabel(listing?.property_type)}`,
    "Demande : loyer de marché au m² de la commune pour ce type de bien, toutes surfaces confondues, location nue, hors charges.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildUserPrompt(listing, { today = new Date() } = {}) {
  const territory = listingTerritory(listing);
  const iso = today.toISOString().slice(0, 10);
  if (territory.source !== "user") {
    return buildCommunePrompt(listing, territory, iso);
  }
  const address = listing.user_address;
  return [
    `Date du jour : ${iso}`,
    `Adresse : ${address}`,
    territory.city ? `Ville : ${territory.city}` : null,
    territory.postal_code ? `Code postal : ${territory.postal_code}` : null,
    listing?.insee_code ? `Code INSEE : ${listing.insee_code}` : null,
    `Type de bien : ${propertyTypeLabel(listing?.property_type)}`,
    listing?.surface ? `Surface : ${listing.surface} m²` : null,
    listing?.rooms != null ? `Pièces : ${listing.rooms}` : null,
    listing?.bedrooms != null ? `Chambres : ${listing.bedrooms}` : null,
    listing?.floor != null ? `Étage : ${listing.floor}` : null,
    listing?.dpe ? `DPE : ${listing.dpe}` : null,
    `Meublé : ${furnishedHint(listing)}`,
    listing?.price ? `Prix de vente affiché : ${listing.price} €` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function stripJsonFence(text) {
  const raw = String(text || "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw);
  return fenced ? fenced[1].trim() : raw;
}

export function extractResponsesOutput(data) {
  const citations = [];
  const texts = [];
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    texts.push(data.output_text.trim());
  }
  for (const item of data?.output || []) {
    if (item?.type !== "message") continue;
    for (const part of item.content || []) {
      const text = typeof part?.text === "string" ? part.text.trim() : "";
      if (text && !texts.includes(text)) texts.push(text);
      for (const annotation of part?.annotations || []) {
        if (annotation?.type === "url_citation" && annotation.url) {
          citations.push({
            name: String(annotation.title || "").trim(),
            url: String(annotation.url).trim(),
            period: "",
          });
        }
      }
    }
  }
  return { text: texts[0] || "", citations };
}

function mergeSources(fromModel, fromCitations) {
  const seen = new Set();
  const merged = [];
  for (const source of [...(fromModel || []), ...(fromCitations || [])]) {
    const url = String(source?.url || "").trim();
    const name = String(source?.name || "").trim();
    const key = (url || name).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push({
      name: name || url,
      url,
      period: String(source?.period || "").trim(),
    });
  }
  return merged.slice(0, 12);
}

export function normalizeRentEstimate(parsed, { citations = [], webSearch = false } = {}) {
  const rentM2 = normalizeRentBand(parsed.rent_m2);
  if (!rentM2) {
    throw new Error("rent_m2_invalid");
  }
  const granularity = GRANULARITIES.includes(parsed.granularity)
    ? parsed.granularity
    : "commune";
  const furnished = clampRentM2(parsed.furnished_rent_m2_mid);
  const control = parsed.rent_control || {};
  const confidenceRaw = parsed.confidence;
  const confidence =
    typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
      ? Math.min(1, Math.max(0, confidenceRaw))
      : 0.5;

  return {
    version: RENT_ESTIMATE_VERSION,
    granularity,
    rent_m2: rentM2,
    furnished_rent_m2_mid: furnished,
    rent_control: {
      applies: Boolean(control.applies),
      reference_m2: clampRentM2(control.reference_m2),
      reference_max_m2: clampRentM2(control.reference_max_m2),
    },
    confidence,
    sources: mergeSources(parsed.sources, citations),
    notes: String(parsed.notes || "").trim().slice(0, 800),
    web_search: Boolean(webSearch),
  };
}

function failRentHttp(response, body, logger) {
  const message = buildRentHttpError(response.status, body);
  logger?.warn?.(
    { status: response.status, body: String(body || "").slice(0, 4000) },
    "API valeur locative en échec HTTP"
  );
  throw new Error(message);
}

export default function createRentEstimateService({
  logger,
  responsesCall,
  chatCompletion,
  rent = config.rent,
} = {}) {
  async function defaultResponsesCall({ system, user }) {
    const response = await fetch(`${rent.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rent.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: rent.model,
        tools: rent.webSearch ? [{ type: "web_search" }] : [],
        input: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "rent_estimate",
            strict: true,
            schema: RENT_ESTIMATE_JSON_SCHEMA,
          },
        },
      }),
      signal: AbortSignal.timeout(rent.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      failRentHttp(response, body, logger);
    }
    return response.json();
  }

  async function defaultChatCompletion({ system, user }) {
    const response = await fetch(`${rent.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rent.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: rent.model,
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "rent_estimate",
            strict: true,
            schema: RENT_ESTIMATE_JSON_SCHEMA,
          },
        },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(rent.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      failRentHttp(response, body, logger);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("rent_empty_response");
    return content;
  }

  const callResponses = responsesCall || defaultResponsesCall;
  const complete = chatCompletion || defaultChatCompletion;

  function configured() {
    return Boolean(responsesCall || chatCompletion || rent.apiKey);
  }

  async function estimate(listing) {
    if (!configured()) {
      return { available: false, error: "llm_not_configured" };
    }

    const user = buildUserPrompt(listing);
    let rawText = "";
    let citations = [];
    const useWeb = Boolean(rent.webSearch) && !chatCompletion;

    try {
      if (useWeb || responsesCall) {
        const payload = await callResponses({ system: SYSTEM_PROMPT, user });
        if (typeof payload === "string") {
          rawText = payload;
        } else {
          const extracted = extractResponsesOutput(payload);
          rawText = extracted.text;
          citations = extracted.citations;
        }
      } else {
        rawText = await complete({ system: SYSTEM_PROMPT, user });
      }
    } catch (err) {
      logger?.warn?.({ err: err.message }, "LLM injoignable (valeur locative)");
      return { available: false, error: err.message };
    }

    if (!rawText) {
      logger?.warn?.({}, "Réponse LLM vide (valeur locative)");
      return { available: false, error: "rent_empty_response" };
    }

    try {
      const json = JSON.parse(stripJsonFence(rawText));
      const parsed = outputSchema.parse(json);
      const data = normalizeRentEstimate(parsed, {
        citations,
        webSearch: useWeb || Boolean(responsesCall),
      });
      logger?.info?.(
        {
          granularity: data.granularity,
          mid: data.rent_m2.mid,
          sources: data.sources.length,
        },
        "estimation locative (LLM)"
      );
      return { available: true, data };
    } catch (err) {
      logger?.warn?.({ err: err.message }, "Réponse LLM invalide (valeur locative)");
      return { available: false, error: "rent_invalid_response" };
    }
  }

  return { configured, estimate };
}

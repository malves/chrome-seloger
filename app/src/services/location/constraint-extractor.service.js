/**
 * Étape 1 du moteur de localisation probable : « texte libre → contraintes
 * structurées ». C'est le SEUL endroit où intervient un LLM, et il ne fait que
 * de l'extraction : il n'invente jamais de distance, ne géocode pas, ne calcule
 * aucune coordonnée. Toute la partie géographique reste déterministe (étapes
 * suivantes).
 *
 * Client compatible OpenAI (`POST {baseUrl}/chat/completions`, mode JSON). La
 * fonction d'appel est injectable (`chatCompletion`) pour tester sans réseau.
 * Sans clé LLM configurée et sans injection, `extract()` renvoie
 * `{ available: false }` et le moteur répondra `status: "unavailable"`.
 */

import { z } from "zod";
import config from "../../config.js";

const PLACE_TYPES = [
  "train_station",
  "metro_station",
  "tram_station",
  "bus_stop",
  "transit",
  "school",
  "university",
  "shop",
  "supermarket",
  "park",
  "hospital",
  "pharmacy",
  "church",
  "landmark",
  "address",
  "other",
];

const RELATIONS = ["travel_time", "distance", "near"];
const TRANSPORTS = ["walking", "cycling", "driving", "transit"];
const PRECISIONS = ["exact", "approximate", "vague"];

/** Retire les accents et met en minuscule (pour normaliser les formules vagues). */
export function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Mappe une formule vague (« à deux pas », « proche »...) vers une clé stable
 * utilisée par la config (distances conventionnelles et poids).
 */
export function vagueKindFrom(text) {
  const t = normalizeText(text);
  if (!t) return null;
  if (t.includes("deux pas")) return "a deux pas";
  if (t.includes("a proximite") || t.includes("proximite")) return "a proximite";
  if (t.includes("face")) return "face a";
  if (t.includes("proche")) return "proche";
  if (t.includes("pres")) return "pres";
  return null;
}

const nullableNumber = z
  .union([z.number(), z.null()])
  .optional()
  .transform((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));

const constraintSchema = z
  .object({
    place: z.string().trim().min(1),
    place_type: z.string().optional(),
    relation: z.string().optional(),
    max_minutes: nullableNumber,
    min_minutes: nullableNumber,
    max_meters: nullableNumber,
    min_meters: nullableNumber,
    transport: z.union([z.string(), z.null()]).optional(),
    precision: z.string().optional(),
    vague_kind: z.union([z.string(), z.null()]).optional(),
    confidence: z
      .union([z.number(), z.null()])
      .optional()
      .transform((v) =>
        typeof v === "number" && Number.isFinite(v)
          ? Math.min(1, Math.max(0, v))
          : 0.5
      ),
  })
  .passthrough();

const outputSchema = z.object({
  exact_address: z.union([z.string(), z.null()]).optional(),
  constraints: z.array(constraintSchema).optional(),
});

/** Normalise une contrainte brute du LLM vers la forme interne stable. */
function normalizeConstraint(raw) {
  const place = String(raw.place || "").trim();
  if (!place) return null;

  const placeType = PLACE_TYPES.includes(raw.place_type)
    ? raw.place_type
    : "other";

  let relation = RELATIONS.includes(raw.relation) ? raw.relation : null;
  const transport = TRANSPORTS.includes(raw.transport)
    ? raw.transport
    : "walking";

  const maxMinutes = raw.max_minutes;
  const maxMeters = raw.max_meters;

  // On ne déduit la relation que des données réellement présentes : ne jamais
  // inventer une distance absente du texte.
  if (!relation) {
    if (maxMinutes != null || raw.min_minutes != null) relation = "travel_time";
    else if (maxMeters != null || raw.min_meters != null) relation = "distance";
    else relation = "near";
  }

  const vagueKind = vagueKindFrom(raw.vague_kind) || vagueKindFrom(place) || null;

  let precision = PRECISIONS.includes(raw.precision) ? raw.precision : null;
  if (!precision) {
    if (relation === "near") precision = "vague";
    else precision = "approximate";
  }

  return {
    place,
    place_type: placeType,
    relation,
    max_minutes: relation === "travel_time" ? maxMinutes : null,
    min_minutes: relation === "travel_time" ? raw.min_minutes : null,
    max_meters: relation === "distance" ? maxMeters : null,
    min_meters: relation === "distance" ? raw.min_meters : null,
    transport,
    precision,
    vague_kind: relation === "near" ? vagueKind : null,
    confidence: raw.confidence ?? 0.5,
  };
}

const SYSTEM_PROMPT = `Tu es un extracteur d'indices de localisation dans des annonces immobilières françaises.
Ta SEULE tâche : transformer le texte libre en contraintes géographiques structurées.
Tu ne géocodes rien, tu n'inventes aucune coordonnée, aucune distance ni aucun temps absents du texte.

Renvoie un objet JSON STRICT :
{
  "exact_address": string|null,   // adresse postale précise explicitement écrite dans le texte (ex. "12 rue des Lilas"), sinon null
  "constraints": [
    {
      "place": string,            // nom du lieu mentionné (ex. "Gare du Val d'Or", "Monoprix", "école Saint-Joseph")
      "place_type": "train_station"|"metro_station"|"tram_station"|"bus_stop"|"transit"|"school"|"university"|"shop"|"supermarket"|"park"|"hospital"|"pharmacy"|"church"|"landmark"|"address"|"other",
      "relation": "travel_time"|"distance"|"near",
      "max_minutes": number|null, // uniquement si un temps est donné (relation travel_time)
      "min_minutes": number|null, // uniquement pour "entre X et Y minutes"
      "max_meters": number|null,  // uniquement si une distance en mètres est donnée (relation distance)
      "min_meters": number|null,  // uniquement pour "entre X et Y mètres"
      "transport": "walking"|"cycling"|"driving"|"transit", // "à pied"=walking, "en voiture"=driving, "à vélo"=cycling, défaut walking
      "precision": "exact"|"approximate"|"vague",
      "vague_kind": string|null,  // pour relation near : "à deux pas"|"proche"|"à proximité"|"face à"|"près"
      "confidence": number        // 0..1, ta confiance dans l'extraction de cette contrainte
    }
  ]
}

Règles :
- "à X min"/"à X minutes" => relation travel_time, max_minutes=X.
- "à X m"/"à X mètres"/"à X km" => relation distance, max_meters (convertir les km en mètres).
- "entre X et Y min"/"entre X et Y m" => renseigne min_* ET max_*.
- "proche de"/"à proximité de"/"à deux pas de"/"face à"/"près de" SANS chiffre => relation near, vague_kind correspondant, max_minutes et max_meters = null.
- N'ajoute une contrainte que pour un lieu RÉELLEMENT nommé dans le texte.
- Ne déduis jamais une distance ou un temps qui n'est pas écrit.
- Si aucun indice de localisation : "constraints": [].
Réponds UNIQUEMENT avec le JSON, sans texte autour.`;

function buildUserPrompt({ description, city, postalCode }) {
  const context = [
    city ? `Ville : ${city}` : null,
    postalCode ? `Code postal : ${postalCode}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return `${context ? context + "\n\n" : ""}Annonce :\n"""\n${description}\n"""`;
}

export default function createConstraintExtractorService({
  logger,
  chatCompletion,
  llm = config.llm,
} = {}) {
  /** Appel HTTP compatible OpenAI (par défaut). */
  async function defaultChatCompletion({ system, user }) {
    const response = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${llm.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: llm.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(llm.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`llm_http_${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("llm_empty_response");
    return content;
  }

  const complete = chatCompletion || defaultChatCompletion;

  function configured() {
    return Boolean(chatCompletion || llm.apiKey);
  }

  /**
   * Extrait les contraintes d'une annonce.
   * @returns {Promise<{ available: boolean, constraints?: object[], exactAddress?: string|null }>}
   */
  async function extract({ description, city = null, postalCode = null } = {}) {
    const text = typeof description === "string" ? description.trim() : "";
    if (!configured() || !text) {
      return { available: configured() && Boolean(text), constraints: [], exactAddress: null };
    }

    let content;
    try {
      content = await complete({
        system: SYSTEM_PROMPT,
        user: buildUserPrompt({ description: text, city, postalCode }),
      });
    } catch (err) {
      logger?.warn?.({ err: err.message }, "LLM injoignable (extraction localisation)");
      return { available: false, constraints: [], exactAddress: null };
    }

    let parsed;
    try {
      const json = typeof content === "string" ? JSON.parse(content) : content;
      parsed = outputSchema.parse(json);
    } catch (err) {
      logger?.warn?.(
        { err: err.message },
        "Réponse LLM invalide (extraction localisation)"
      );
      return { available: true, constraints: [], exactAddress: null };
    }

    const constraints = (parsed.constraints || [])
      .map(normalizeConstraint)
      .filter(Boolean);

    const exactAddress =
      typeof parsed.exact_address === "string" && parsed.exact_address.trim()
        ? parsed.exact_address.trim()
        : null;

    logger?.info?.(
      { constraints: constraints.length, exactAddress: Boolean(exactAddress) },
      "extraction localisation (LLM)"
    );

    return { available: true, constraints, exactAddress };
  }

  return { configured, extract, normalizeConstraint };
}

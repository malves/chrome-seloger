/**
 * Client « chat completions » compatible OpenAI avec images (vision).
 *
 * Même approche que l'extracteur de localisation : la fonction réseau est
 * injectable (`chatCompletion`) pour tester sans clé ni réseau. Le client ne
 * fait qu'envoyer un prompt système, des blocs texte / image et exiger une
 * réponse JSON ; il ne connaît rien au domaine.
 */

import config from "../../config.js";

/**
 * @typedef {object} VisionPart
 * @property {"text"|"image"} type
 * @property {string} [text]
 * @property {string} [dataUrl]
 * @property {"low"|"high"|"auto"} [detail]
 */

export default function createVisionClient({
  logger,
  chatCompletion,
  vision = config.vision,
} = {}) {
  function toOpenAiParts(parts) {
    return parts.map((part) => {
      if (part.type === "image") {
        return {
          type: "image_url",
          image_url: { url: part.dataUrl, detail: part.detail || vision.imageDetail },
        };
      }
      return { type: "text", text: part.text };
    });
  }

  /**
   * @param {{ system: string, parts: VisionPart[], maxTokens?: number }} input
   * @returns {Promise<string>} contenu JSON brut
   */
  async function defaultChatCompletion({ system, parts, maxTokens }) {
    const response = await fetch(`${vision.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${vision.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: vision.model,
        temperature: 0,
        response_format: { type: "json_object" },
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: toOpenAiParts(parts) },
        ],
      }),
      signal: AbortSignal.timeout(vision.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`vision_http_${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("vision_empty_response");
    return content;
  }

  const complete = chatCompletion || defaultChatCompletion;

  function configured() {
    return Boolean(chatCompletion || vision.apiKey);
  }

  /**
   * Appelle le modèle et parse le JSON renvoyé.
   * @returns {Promise<object>} objet JSON (lève en cas de réponse invalide)
   */
  async function completeJson(input) {
    const content = await complete(input);
    if (content && typeof content === "object") return content;
    const text = String(content || "").trim();
    // Certains modèles entourent le JSON de ``` malgré response_format.
    const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const raw = fenced ? fenced[1] : text;
    try {
      return JSON.parse(raw);
    } catch (err) {
      logger?.warn?.({ err: err.message }, "réponse vision non JSON");
      throw new Error("vision_invalid_json");
    }
  }

  return { configured, completeJson, imageDetail: vision.imageDetail };
}

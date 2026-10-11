/**
 * Téléchargement des photos d'une annonce avant analyse.
 *
 * Les CDN des portails refusent souvent le hotlinking par des tiers : on
 * récupère les images côté serveur et on les transmet au modèle en base64.
 * Le hachage SHA-1 permet d'écarter les doublons exacts avant tout appel
 * payant. `fetchImage` est injectable pour tester sans réseau.
 */

import crypto from "node:crypto";
import config from "../../config.js";

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/** Devine le type MIME d'après l'extension quand l'en-tête manque. */
function mimeFromUrl(url) {
  const path = String(url).split("?")[0].toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

/** Identifiant stable « img_001 », « img_002 »… (ordre de la galerie). */
export function imageIdFor(index) {
  return `img_${String(index + 1).padStart(3, "0")}`;
}

export default function createImageFetcher({
  logger,
  fetchImage,
  vision = config.vision,
} = {}) {
  /**
   * @returns {Promise<{ buffer: Buffer, mimeType: string }>}
   */
  async function defaultFetchImage(url) {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(vision.downloadTimeoutMs),
      headers: {
        accept: "image/*",
        "user-agent": "Mozilla/5.0 (compatible; CarnetDeVisites/1.0)",
      },
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const declared = String(response.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const mimeType = ALLOWED_TYPES.has(declared) ? declared : mimeFromUrl(url);
    if (!ALLOWED_TYPES.has(mimeType)) {
      throw new Error(`type non supporté : ${declared || "inconnu"}`);
    }

    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > vision.maxImageBytes) {
      throw new Error(`image trop lourde (${length} octets)`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > vision.maxImageBytes) {
      throw new Error(`image trop lourde (${buffer.length} octets)`);
    }
    if (buffer.length === 0) throw new Error("image vide");
    return { buffer, mimeType };
  }

  const load = fetchImage || defaultFetchImage;

  /**
   * Télécharge les photos (bornées à `maxPhotos`), calcule le hash et marque
   * les doublons exacts. Une photo injoignable est conservée avec `error`
   * pour rester visible dans la liste des images écartées.
   *
   * @param {string[]} urls
   * @returns {Promise<object[]>} `{ id, order, url, dataUrl|null, sha1|null, bytes, duplicate_of|null, error|null }`
   */
  async function fetchAll(urls) {
    const limited = (urls || []).slice(0, vision.maxPhotos);
    const results = await Promise.all(
      limited.map(async (url, index) => {
        const base = { id: imageIdFor(index), order: index + 1, url };
        try {
          const { buffer, mimeType } = await load(url);
          const sha1 = crypto.createHash("sha1").update(buffer).digest("hex");
          return {
            ...base,
            dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
            mimeType,
            sha1,
            bytes: buffer.length,
            duplicate_of: null,
            error: null,
          };
        } catch (err) {
          logger?.debug?.({ url, err: err.message }, "photo injoignable (analyse)");
          return {
            ...base,
            dataUrl: null,
            mimeType: null,
            sha1: null,
            bytes: 0,
            duplicate_of: null,
            error: err.message || "téléchargement impossible",
          };
        }
      })
    );

    const seen = new Map();
    for (const image of results) {
      if (!image.sha1) continue;
      const first = seen.get(image.sha1);
      if (first) {
        image.duplicate_of = first;
        image.dataUrl = null;
      } else {
        seen.set(image.sha1, image.id);
      }
    }

    return results;
  }

  return { fetchAll, imageIdFor };
}

/**
 * Enregistrement d'une annonce reçue de l'extension.
 *
 * Responsabilités : canonisation de l'URL, clé de déduplication, création ou
 * mise à jour, historique de prix.
 */

import crypto from "node:crypto";
import { nowIso } from "../lib/time.js";
import { projectReferences } from "../schemas/listing.payload.js";
import createProjectsService from "./projects.service.js";

/** Paramètres de suivi retirés de l'URL avant comparaison. */
const TRACKING_PARAMS = new Set([
  "gclid",
  "fbclid",
  "msclkid",
  "dclid",
  "yclid",
  "igshid",
  "twclid",
  "ttclid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "_ga",
  "_gl",
  "cmpid",
  "campaignid",
]);

const TRACKING_PREFIXES = ["utm_", "pk_", "mtm_", "piwik_", "matomo_"];

function isTrackingParam(name) {
  const key = name.toLowerCase();
  if (TRACKING_PARAMS.has(key)) return true;
  return TRACKING_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * URL canonique : hôte en minuscules, fragment supprimé, paramètres de suivi
 * retirés, paramètres restants triés pour que deux URL équivalentes donnent
 * la même clé.
 */
export function canonicalizeUrl(rawUrl) {
  const input = String(rawUrl || "").trim();
  let url;
  try {
    url = new URL(input);
  } catch {
    return input;
  }

  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  url.username = "";
  url.password = "";

  for (const name of [...url.searchParams.keys()]) {
    if (isTrackingParam(name)) url.searchParams.delete(name);
  }
  const entries = [...url.searchParams.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  url.search = "";
  for (const [key, value] of entries) url.searchParams.append(key, value);

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return url.toString();
}

export function dedupKey(source, sourceId, canonicalUrl) {
  if (sourceId) return `${source}:${sourceId}`;
  const hash = crypto.createHash("sha1").update(canonicalUrl).digest("hex");
  return `${source}:${hash}`;
}

/**
 * Identifiant d'annonce extrait du chemin URL quand l'extension ne l'envoie pas.
 *
 * SeLoger place l'identifiant en dernier segment, quel que soit le format :
 *   - court   : `/annonce/26Q9YCW4ZDUN`
 *   - complet : `/annonce/achat/ile-de-france/hauts-de-seine-92/garches-92380/26S3BE9IWZDS`
 *   - ancien  : `/annonces/.../275190123.htm`
 *
 * On ne retombe jamais sur un simple `\d{5,}` : le chemin contient des codes
 * postaux (`garches-92380`) qui feraient collisionner deux annonces d'une même
 * commune. En l'absence d'identifiant sûr, on laisse la clé dériver de l'URL.
 */
export function sourceIdFromUrl(source, rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch {
    return null;
  }

  const path = url.pathname.replace(/\/+$/, "");

  // Anciennes URLs : l'identifiant précède « .htm ».
  const legacy = path.match(/(\d{5,})\.html?$/i);
  if (legacy) return legacy[1];

  // URLs modernes : l'identifiant est le dernier segment de /annonce(s)/…
  if (/\/annonces?\//i.test(path)) {
    const last = path.split("/").filter(Boolean).pop();
    if (last && /^[A-Za-z0-9]+$/.test(last)) return last.toUpperCase();
  }

  return null;
}

/** Garde la valeur reçue si elle est définie, sinon celle déjà stockée. */
function keepOrReplace(incoming, stored) {
  return incoming === undefined || incoming === null ? stored ?? null : incoming;
}

/**
 * Projette un payload validé sur les colonnes de `listings`.
 *
 * `existing` sert de valeur de repli : une nouvelle capture incomplète ne doit
 * pas effacer ce qui avait été extrait auparavant.
 */
export function payloadToFields(payload, canonicalUrl, existing = null) {
  const location = payload.location || {};
  const prev = existing || {};

  return {
    source: payload.source,
    source_id: keepOrReplace(payload.source_id, prev.source_id),
    url: canonicalUrl,
    transaction_type:
      payload.transaction_type || prev.transaction_type || "sale",
    property_type: keepOrReplace(payload.property_type, prev.property_type),
    title: keepOrReplace(payload.title, prev.title),
    description: keepOrReplace(payload.description, prev.description),
    price: keepOrReplace(payload.price, prev.price),
    surface: keepOrReplace(payload.surface, prev.surface),
    land_surface: keepOrReplace(payload.land_surface, prev.land_surface),
    rooms: keepOrReplace(payload.rooms, prev.rooms),
    bedrooms: keepOrReplace(payload.bedrooms, prev.bedrooms),
    floor: keepOrReplace(payload.floor, prev.floor),
    year_built: keepOrReplace(payload.year_built, prev.year_built),
    dpe: keepOrReplace(payload.dpe, prev.dpe),
    ges: keepOrReplace(payload.ges, prev.ges),
    dpe_value: keepOrReplace(payload.dpe_value, prev.dpe_value),
    ges_value: keepOrReplace(payload.ges_value, prev.ges_value),
    is_new_build:
      payload.is_new_build === undefined
        ? prev.is_new_build
          ? 1
          : 0
        : payload.is_new_build
          ? 1
          : 0,
    city: keepOrReplace(location.city, prev.city),
    postal_code: keepOrReplace(location.postal_code, prev.postal_code),
    insee_code: keepOrReplace(location.insee_code, prev.insee_code),
    lat: keepOrReplace(location.lat, prev.lat),
    lng: keepOrReplace(location.lng, prev.lng),
    agency: payload.agency === undefined ? undefined : payload.agency,
    features: payload.features?.length ? payload.features : undefined,
    extension_data:
      payload.extension_data === undefined ? undefined : payload.extension_data,
    raw: payload.raw === undefined ? undefined : payload.raw,
  };
}

export default function createListingsService({ repositories }) {
  const projectsService = createProjectsService({ repositories });

  /**
   * Crée ou met à jour une annonce.
   * `status`, `notes` et `is_favorite` ne sont jamais écrasés, et le
   * classement par projets ne peut que s'enrichir.
   */
  function save(user, payload) {
    const canonicalUrl = canonicalizeUrl(payload.url);
    const sourceId =
      payload.source_id ||
      sourceIdFromUrl(payload.source, canonicalUrl) ||
      null;
    const key = dedupKey(payload.source, sourceId, canonicalUrl);
    const enriched =
      sourceId && !payload.source_id ? { ...payload, source_id: sourceId } : payload;
    const observedAt = payload.captured_at || nowIso();

    return repositories.transaction(() => {
      const existing = repositories.listings.findByDedupKey(user.id, key);
      const fields = payloadToFields(enriched, canonicalUrl, existing);

      // Les colonnes JSON déjà renseignées sont conservées si rien n'arrive.
      for (const column of ["agency", "features", "extension_data", "raw"]) {
        if (fields[column] === undefined && existing) {
          fields[column] = existing[column]
            ? JSON.parse(existing[column])
            : undefined;
        }
      }

      const references = projectReferences(payload);

      if (!existing) {
        const id = repositories.listings.insert(user.id, key, fields, observedAt);
        if (payload.photos?.length) {
          repositories.listings.replacePhotos(id, payload.photos);
        }
        if (fields.price != null) {
          repositories.listings.addPricePoint(id, fields.price, observedAt);
        }
        const projects = projectsService.addToListing(user.id, id, references);
        return { id, created: true, priceChanged: false, projects };
      }

      repositories.listings.update(user.id, existing.id, fields, observedAt);

      if (payload.photos?.length) {
        repositories.listings.replacePhotos(existing.id, payload.photos);
      }

      const priceChanged =
        fields.price != null && fields.price !== existing.price;
      if (priceChanged) {
        repositories.listings.addPricePoint(
          existing.id,
          fields.price,
          observedAt
        );
      }

      // Additif : une nouvelle capture n'enlève jamais un projet choisi à la main.
      const projects = projectsService.addToListing(
        user.id,
        existing.id,
        references
      );

      return { id: existing.id, created: false, priceChanged, projects };
    });
  }

  /** L'annonce affichée dans le navigateur est-elle déjà enregistrée ? */
  function lookup(user, rawUrl) {
    const canonicalUrl = canonicalizeUrl(rawUrl);
    const byUrl = repositories.listings.findByUrl(user.id, canonicalUrl);
    if (byUrl) return byUrl;

    // L'extension peut interroger avant de connaître la source : on retente
    // avec la clé de déduplication construite depuis l'URL seule.
    try {
      const host = new URL(canonicalUrl).hostname.replace(/^www\./, "");
      const source = host.split(".")[0];
      const sourceId = sourceIdFromUrl(source, canonicalUrl);
      if (sourceId) {
        const bySourceId = repositories.listings.findByDedupKey(
          user.id,
          dedupKey(source, sourceId, canonicalUrl)
        );
        if (bySourceId) return bySourceId;
      }
      return repositories.listings.findByDedupKey(
        user.id,
        dedupKey(source, null, canonicalUrl)
      );
    } catch {
      return null;
    }
  }

  return { save, lookup, canonicalizeUrl, dedupKey, sourceIdFromUrl };
}

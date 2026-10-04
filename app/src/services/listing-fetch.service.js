/**
 * Récupération et lecture d'une annonce à partir de sa seule URL, côté serveur.
 *
 * C'est l'équivalent serveur de `chrome-extension/src/listing.js` : là où
 * l'extension lit le DOM d'une page déjà chargée, on récupère ici le HTML par
 * `fetch` puis on en extrait les données structurées (JSON-LD, Open Graph et,
 * pour Leboncoin, `__NEXT_DATA__`).
 *
 * Deux garde-fous :
 *  - seuls les hôtes connus (SeLoger, BellesDemeures, Leboncoin) sont joignables
 *    (anti-SSRF) ;
 *  - rien n'est obligatoire hormis la source et l'URL : un payload partiel est
 *    accepté par `listingPayloadSchema`, comme pour l'extension.
 */

import config from "../config.js";
import { parseFloorFromText } from "../lib/dpe-floor.js";

/* ------------------------------ Sources ------------------------------- */

const SOURCES = [
  [/(^|\.)seloger\.com$/i, "seloger"],
  [/(^|\.)bellesdemeures\.com$/i, "bellesdemeures"],
  [/(^|\.)leboncoin\.fr$/i, "leboncoin"],
];

/** Catégories immobilières de Leboncoin (ventes, locations, colocations, pro). */
const LBC_CATEGORIES = { 9: "sale", 10: "rent", 11: "rent", 13: "sale" };
const LBC_PROPERTY_TYPES = {
  1: "house",
  2: "apartment",
  3: "land",
  4: "other",
  5: "other",
};

export function sourceForHostname(hostname) {
  const match = SOURCES.find(([pattern]) => pattern.test(hostname));
  return match ? match[1] : null;
}

/** Identifiant annonce dans le chemin (aligné sur listings.service.js). */
function listingIdFromPath(pathname) {
  const path = String(pathname || "").replace(/\/+$/, "");
  const legacy = path.match(/(\d{5,})\.htm(?:l)?$/i);
  if (legacy) return legacy[1];
  if (/\/annonces?\//i.test(path)) {
    const last = path.split("/").filter(Boolean).pop();
    if (last && /^[A-Za-z0-9]+$/.test(last)) return last.toUpperCase();
  }
  return null;
}

/**
 * L'URL pointe-t-elle vers une fiche d'annonce exploitable ? (aligné sur
 * `chrome-extension/src/listing-page.js`). Exclut accueil, listes de résultats
 * et pages hors détail.
 */
export function isListingDetailUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;

  const source = sourceForHostname(url.hostname);
  if (!source) return false;

  if (source === "leboncoin") {
    if (!/^\/ad\//i.test(url.pathname)) return false;
    return /\d{6,}/.test(url.pathname);
  }

  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return false;
  if (/\/list\.htm/i.test(path)) return false;
  if (/\/recherche\b/i.test(path)) return false;

  return Boolean(listingIdFromPath(path));
}

/* ---------------------------- Utilitaires ----------------------------- */

/** « 385 000 », « 385.000 » → 385000. Les séparateurs sont ignorés. */
function integerFrom(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value) : null;
  }
  const match = String(value || "").match(/\d[\d\s\u00a0\u202f.]*/);
  if (!match) return null;
  const digits = match[0].replace(/[^\d]/g, "");
  if (!digits) return null;
  const number = Number(digits);
  return Number.isFinite(number) ? number : null;
}

/** « 120,5 m² » → 120.5. */
function decimalFrom(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const match = String(value || "")
    .replace(/[\s\u00a0\u202f]/g, "")
    .match(/\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const number = Number(match[0].replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function httpsOnly(urls) {
  const unique = [];
  for (const url of urls) {
    const text = typeof url === "string" ? url.trim() : "";
    if (/^https:\/\//.test(text) && !unique.includes(text)) unique.push(text);
  }
  return unique;
}

/** Retire les champs vides : un champ absent vaut mieux qu'un champ nul. */
function compact(object) {
  const result = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length) result[key] = value;
      continue;
    }
    if (typeof value === "object") {
      const nested = compact(value);
      if (Object.keys(nested).length) result[key] = nested;
      continue;
    }
    result[key] = value;
  }
  return result;
}

/* ------------------------- Décodage d'entités ------------------------- */

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  ocirc: "ô",
  euro: "€",
  "#39": "'",
};

function decodeEntities(value) {
  if (typeof value !== "string" || value.indexOf("&") === -1) return value;
  return value.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

/* -------------------------- Balises <meta> ---------------------------- */

/**
 * Table des balises `<meta>` de la page : clé `property`/`name`/`itemprop`
 * (en minuscules) → contenu décodé.
 */
function metaMap(html) {
  const map = new Map();
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = {};
    const attrRe = /([a-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let m;
    while ((m = attrRe.exec(tag))) {
      attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? "";
    }
    const key = attrs.property || attrs.name || attrs.itemprop;
    const content = attrs.content;
    if (key && content != null) {
      const normalized = key.trim().toLowerCase();
      if (!map.has(normalized)) map.set(normalized, decodeEntities(content.trim()));
    }
  }
  return map;
}

function metaFrom(map, ...names) {
  for (const name of names) {
    const value = map.get(String(name).toLowerCase());
    if (value && value.trim()) return value.trim();
  }
  return null;
}

/* ------------------------------ JSON-LD ------------------------------- */

/** Aplatit tous les nœuds JSON-LD de la page, graphes compris. */
function jsonLdNodes(html) {
  const nodes = [];
  const stack = [];

  const re =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) {
    const raw = match[1].trim();
    if (!raw) continue;
    try {
      stack.push(JSON.parse(raw));
    } catch {
      // Données structurées cassées : on ignore ce bloc.
    }
  }

  let guard = 0;
  while (stack.length && guard < 500) {
    guard += 1;
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    nodes.push(node);
    if (Array.isArray(node["@graph"])) stack.push(...node["@graph"]);
  }

  return nodes;
}

/**
 * Première valeur scalaire trouvée au bout d'un chemin, tous nœuds confondus.
 * Les listes sont traversées par leur premier élément.
 */
function pick(nodes, path) {
  for (const node of nodes) {
    let value = node;
    for (const key of path) {
      if (Array.isArray(value)) value = value[0];
      if (!value || typeof value !== "object") {
        value = null;
        break;
      }
      value = value[key];
    }
    if (Array.isArray(value)) value = value[0];
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object") continue;
    return value;
  }
  return null;
}

function fromJsonLd(nodes) {
  if (!nodes.length) return {};

  const images = [];
  for (const node of nodes) {
    const image = node.image;
    if (!image) continue;
    for (const entry of Array.isArray(image) ? image : [image]) {
      if (typeof entry === "string") images.push(entry);
      else if (entry && typeof entry === "object") images.push(entry.url);
    }
  }

  return {
    title: pick(nodes, ["name"]),
    description: pick(nodes, ["description"]),
    price:
      integerFrom(pick(nodes, ["offers", "price"])) ??
      integerFrom(pick(nodes, ["offers", "priceSpecification", "price"])),
    surface: decimalFrom(pick(nodes, ["floorSize", "value"])),
    rooms:
      integerFrom(pick(nodes, ["numberOfRooms", "value"])) ??
      integerFrom(pick(nodes, ["numberOfRooms"])),
    bedrooms:
      integerFrom(pick(nodes, ["numberOfBedrooms", "value"])) ??
      integerFrom(pick(nodes, ["numberOfBedrooms"])),
    photos: httpsOnly(images),
    location: {
      city: pick(nodes, ["address", "addressLocality"]),
      postal_code: pick(nodes, ["address", "postalCode"]),
      lat: decimalFrom(pick(nodes, ["geo", "latitude"])),
      lng: decimalFrom(pick(nodes, ["geo", "longitude"])),
    },
  };
}

/* ------------------------------ Leboncoin ----------------------------- */

/** L'annonce consultée, telle que Next.js l'embarque dans la page. */
function leboncoinAd(html, url) {
  const match = html.match(
    /<script\b[^>]*id\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!match) return null;

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return null;
  }

  const pageProps = data && data.props && data.props.pageProps;
  if (!pageProps) return null;

  const urlId = listingIdFromPath(safePathname(url));
  let ad = pageProps.ad || null;
  if (!ad && pageProps.searchData && Array.isArray(pageProps.searchData.ads)) {
    const ads = pageProps.searchData.ads;
    ad =
      (urlId && ads.find((entry) => String(entry.list_id || entry.id) === urlId)) ||
      ads[0] ||
      null;
  }
  return ad || null;
}

function fromLeboncoin(html, url) {
  const ad = leboncoinAd(html, url);
  if (!ad) return {};

  const attributes = new Map(
    (Array.isArray(ad.attributes) ? ad.attributes : []).map((attribute) => [
      attribute.key,
      attribute,
    ])
  );
  const attribute = (key, field = "value") => {
    const found = attributes.get(key);
    return found ? found[field] : null;
  };

  const images = ad.images || {};
  const photos = httpsOnly([...(images.urls_large || []), ...(images.urls || [])]);

  const city =
    ad.location && ad.location.city_label
      ? String(ad.location.city_label).replace(/\s*\d{5}\s*$/, "").trim()
      : (ad.location && ad.location.city) || null;

  const owner = ad.owner || {};
  const sellType = String(attribute("immo_sell_type", "value_label") || "");

  return {
    source_id: String(ad.list_id || ad.id || "") || null,
    title: ad.subject || null,
    description: ad.body || null,
    price: integerFrom(Array.isArray(ad.price) ? ad.price[0] : ad.price),
    surface: decimalFrom(attribute("square")),
    land_surface: decimalFrom(attribute("land_plot_surface")),
    rooms: integerFrom(attribute("rooms")),
    bedrooms: integerFrom(attribute("nb_bedrooms")),
    floor: integerFrom(attribute("floor_number")),
    year_built: integerFrom(attribute("building_year")),
    dpe: attribute("energy_rate"),
    ges: attribute("ges"),
    is_new_build: /neuf/i.test(sellType),
    transaction_type: LBC_CATEGORIES[Number(ad.category_id)] || null,
    property_type: LBC_PROPERTY_TYPES[Number(attribute("real_estate_type"))] || null,
    photos,
    agency: {
      name: owner.type === "pro" ? owner.name : "Particulier",
      phone: owner.phone || null,
    },
    location: {
      city,
      postal_code: (ad.location && ad.location.zipcode) || null,
      lat: decimalFrom(ad.location && ad.location.lat),
      lng: decimalFrom(ad.location && ad.location.lng),
    },
  };
}

/* ------------------------------ SeLoger ------------------------------- */

/** Étage depuis le JSON embarqué `__UFRN_LIFECYCLE_SERVERREQUEST__` (hardFacts). */
function floorFromSeLogerHtml(html) {
  const anchor = html.indexOf("numberOfFloors");
  if (anchor === -1) return null;
  const slice = html.slice(anchor, anchor + 500);
  const decodeQuoted = (match) => {
    if (!match) return null;
    try {
      return JSON.parse(`"${match[1]}"`);
    } catch {
      return match[1];
    }
  };
  const readField = (field) => {
    const match =
      slice.match(new RegExp(`"${field}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`)) ||
      slice.match(new RegExp(`${field}\\\\":\\\\"([^\\\\"]+)`));
    return decodeQuoted(match);
  };
  const label = readField("label");
  const value = readField("value");
  return parseFloorFromText(label) ?? parseFloorFromText(value) ?? null;
}

function fromSeLoger(html) {
  const floor = floorFromSeLogerHtml(html);
  return floor == null ? {} : { floor };
}

/* --------------------------- Secours : texte -------------------------- */

/** Surface, pièces et chambres se lisent presque toujours dans le titre. */
function fromText(title, description) {
  const text = [title, description].filter(Boolean).join(" \n ");
  if (!text) return {};

  const surface = text.match(/(\d+(?:[.,]\d+)?)\s*m²(?!\s*de\s*terrain)/i);
  const land = text.match(/terrain[^.\n]{0,20}?(\d+(?:[.,]\d+)?)\s*m²/i);
  const rooms = text.match(/(\d+)\s*pi[èe]ces?/i);
  const bedrooms = text.match(/(\d+)\s*chambres?/i);
  const dpe = text.match(/\bDPE\s*:?\s*([A-G])\b/i);

  const floor = parseFloorFromText(text);

  return {
    surface: surface ? decimalFrom(surface[1]) : null,
    land_surface: land ? decimalFrom(land[1]) : null,
    rooms: rooms ? integerFrom(rooms[1]) : null,
    bedrooms: bedrooms ? integerFrom(bedrooms[1]) : null,
    dpe: dpe ? dpe[1].toUpperCase() : null,
    floor,
  };
}

function propertyTypeFrom(text) {
  if (/\bterrains?\b/i.test(text)) return "land";
  if (/\b(maison|villa|mas|longère|propriété|ch[âa]teau)/i.test(text)) {
    return "house";
  }
  if (/\b(appartement|studio|loft|duplex|t[1-9]\b)/i.test(text)) {
    return "apartment";
  }
  return null;
}

function transactionTypeFrom(text) {
  if (/\b(location|louer|a-louer|locations)\b/i.test(text)) return "rent";
  if (/\b(achat|vente|vendre|ventes)\b/i.test(text)) return "sale";
  return null;
}

function titleFromHtml(html) {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const text = decodeEntities(h1[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (title) {
    const text = decodeEntities(title[1]).replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return null;
}

function safePathname(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/** URL canonique (fragment supprimé) ; le serveur exige du https. */
function canonicalUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

/* ----------------------------- Assemblage ----------------------------- */

function fromPage(html, map, nodes) {
  const structured = fromJsonLd(nodes);
  const title =
    structured.title ||
    metaFrom(map, "og:title", "twitter:title") ||
    titleFromHtml(html) ||
    null;
  const description =
    structured.description || metaFrom(map, "og:description", "description") || null;

  const text = fromText(title, description);

  return {
    ...structured,
    title: title ? String(title).trim().slice(0, 300) : null,
    description: description ? String(description).trim() : null,
    price:
      structured.price ?? integerFrom(metaFrom(map, "product:price:amount")),
    surface: structured.surface ?? text.surface,
    land_surface: structured.land_surface ?? text.land_surface,
    rooms: structured.rooms ?? text.rooms,
    bedrooms: structured.bedrooms ?? text.bedrooms,
    floor: text.floor,
    dpe: text.dpe,
    photos:
      structured.photos && structured.photos.length
        ? structured.photos
        : httpsOnly([metaFrom(map, "og:image", "twitter:image")]),
  };
}

/**
 * Lit le HTML d'une page d'annonce et en construit un payload prêt pour
 * `listingPayloadSchema`, ou `null` si rien d'exploitable n'a été trouvé.
 */
export function parseListingHtml(html, url) {
  const source = sourceForHostname(safeHostname(url));
  const canonical = canonicalUrl(url);
  if (!source || !canonical || typeof html !== "string") return null;

  const map = metaMap(html);
  const nodes = jsonLdNodes(html);
  const page = fromPage(html, map, nodes);
  const specific =
    source === "leboncoin"
      ? fromLeboncoin(html, url)
      : source === "seloger" || source === "bellesdemeures"
        ? fromSeLoger(html)
        : {};

  const haystack = `${safePathname(url)} ${page.title || ""}`;

  const merged = compact({
    ...page,
    ...specific,
    property_type:
      specific.property_type || page.property_type || propertyTypeFrom(haystack),
    transaction_type:
      specific.transaction_type ||
      page.transaction_type ||
      transactionTypeFrom(haystack),
    location: { ...(page.location || {}), ...(specific.location || {}) },
    schema_version: 1,
    source,
    url: canonical,
    source_id: specific.source_id || listingIdFromPath(safePathname(url)),
    captured_at: new Date().toISOString(),
  });

  // Rien d'exploitable (ni titre, ni prix, ni photo) : probable page anti-bot.
  if (!merged.title && merged.price == null && !(merged.photos || []).length) {
    return null;
  }

  return merged;
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/* ------------------------------ Service ------------------------------- */

const MAX_HTML_BYTES = 3 * 1024 * 1024; // 3 Mo : largement assez pour une fiche.

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/** Messages lisibles associés à chaque motif d'échec. */
export const FAILURE_MESSAGES = {
  invalid_url: "Cette URL n'est pas valide. Collez l'adresse complète de l'annonce.",
  unsupported_host:
    "Ce site n'est pas pris en charge. Seuls SeLoger, Belles Demeures et Leboncoin le sont pour l'instant.",
  not_listing:
    "Cette adresse ne pointe pas vers une annonce précise. Ouvrez le bien puis copiez l'URL de sa fiche.",
  fetch_failed:
    "Impossible de joindre la page. Vérifiez l'URL et votre connexion, puis réessayez.",
  http_error:
    "La page a renvoyé une erreur. L'annonce a peut-être été retirée ou n'existe plus.",
  blocked:
    "Le site a bloqué la lecture automatique de cette page. Vous pouvez l'ajouter via l'extension Chrome depuis l'annonce ouverte.",
  parse_failed:
    "Aucune donnée exploitable n'a été trouvée sur cette page. Vérifiez qu'il s'agit bien d'une fiche d'annonce.",
};

function failure(reason) {
  return { ok: false, reason, message: FAILURE_MESSAGES[reason] || FAILURE_MESSAGES.parse_failed };
}

export default function createListingFetchService({ logger } = {}) {
  /**
   * Récupère et lit une annonce depuis son URL.
   * @returns {Promise<{ok:true, payload:object} | {ok:false, reason:string, message:string}>}
   */
  async function fetchAndParse(rawUrl) {
    const url = String(rawUrl || "").trim();
    const canonical = canonicalUrl(url);
    if (!canonical) return failure("invalid_url");

    if (!sourceForHostname(safeHostname(canonical))) {
      return failure("unsupported_host");
    }
    if (!isListingDetailUrl(canonical)) {
      return failure("not_listing");
    }

    let response;
    try {
      response = await fetch(canonical, {
        redirect: "follow",
        signal: AbortSignal.timeout(config.enrichment.timeoutMs),
        headers: {
          "user-agent": USER_AGENT,
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
        },
      });
    } catch (err) {
      logger?.warn?.({ err: err?.message, url: canonical }, "fetch d'annonce échoué");
      return failure("fetch_failed");
    }

    // 403 / 429 : signature classique d'une protection anti-bot (DataDome…).
    if (response.status === 403 || response.status === 429) {
      return failure("blocked");
    }
    if (!response.ok) {
      return failure("http_error");
    }

    let html;
    try {
      html = await response.text();
    } catch (err) {
      logger?.warn?.({ err: err?.message, url: canonical }, "lecture du HTML échouée");
      return failure("fetch_failed");
    }
    if (html.length > MAX_HTML_BYTES) html = html.slice(0, MAX_HTML_BYTES);

    const payload = parseListingHtml(html, canonical);
    if (!payload) {
      // Pas de données : soit page anti-bot, soit page sans structure.
      if (/datadome|captcha|are you a human|verif/i.test(html.slice(0, 20000))) {
        return failure("blocked");
      }
      return failure("parse_failed");
    }

    return { ok: true, payload };
  }

  return { fetchAndParse, parseListingHtml };
}

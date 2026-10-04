/**
 * Lecture de l'annonce consultée, dans le monde isolé du content script.
 *
 * Trois sources, de la plus fiable à la plus approximative :
 *  1. `__NEXT_DATA__` pour Leboncoin, qui contient l'annonce complète ;
 *  2. les données structurées JSON-LD et les balises Open Graph ;
 *  3. le DOM et le texte du titre pour les chiffres manquants.
 *
 * Rien n'est obligatoire hormis la source et l'URL : le serveur accepte un
 * payload partiel et conserve ce qu'il connaît déjà. Mieux vaut un champ absent
 * qu'un champ inventé.
 */

(function () {
  "use strict";

  const SOURCES = [
    [/(^|\.)seloger\.com$/i, "seloger"],
    [/(^|\.)bellesdemeures\.com$/i, "bellesdemeures"],
    [/(^|\.)leboncoin\.fr$/i, "leboncoin"],
  ];

  /** Catégories immobilières de Leboncoin (ventes, locations, colocations, pro). */
  const LBC_CATEGORIES = {
    9: "sale",
    10: "rent",
    11: "rent",
    13: "sale",
  };

  const LBC_PROPERTY_TYPES = {
    1: "house",
    2: "apartment",
    3: "land",
    4: "other",
    5: "other",
  };

  /* ---------------------------- Utilitaires ---------------------------- */

  function sourceFor(hostname) {
    const match = SOURCES.find(([pattern]) => pattern.test(hostname));
    return match ? match[1] : null;
  }

  /** URL de l'annonce sans fragment ; le serveur exige du https. */
  function canonicalUrl() {
    try {
      const url = new URL(location.href);
      if (url.protocol !== "https:") return null;
      url.hash = "";
      return url.toString();
    } catch (e) {
      return null;
    }
  }

  function idFromUrl() {
    // SeLoger place l'identifiant en dernier segment du chemin, quel que soit
    // le format d'URL. On évite tout repli sur `\d{5,}` : le chemin contient
    // des codes postaux (ex. « garches-92380 ») qui feraient collisionner deux
    // annonces d'une même commune.
    const path = location.pathname.replace(/\/+$/, "");
    const legacy = path.match(/(\d{5,})\.htm(?:l)?$/i);
    if (legacy) return legacy[1];
    if (/\/annonces?\//i.test(path)) {
      const last = path.split("/").filter(Boolean).pop();
      if (last && /^[A-Za-z0-9]+$/.test(last)) return last.toUpperCase();
    }
    return null;
  }

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

  function meta(...names) {
    for (const name of names) {
      const element =
        document.querySelector(`meta[property="${name}"]`) ||
        document.querySelector(`meta[name="${name}"]`) ||
        document.querySelector(`meta[itemprop="${name}"]`);
      const content = element && element.getAttribute("content");
      if (content && content.trim()) return content.trim();
    }
    return null;
  }

  /* ------------------------------ JSON-LD ------------------------------ */

  /** Aplatit tous les nœuds JSON-LD de la page, graphes compris. */
  function jsonLdNodes() {
    const nodes = [];
    const stack = [];

    for (const script of document.querySelectorAll(
      'script[type="application/ld+json"]'
    )) {
      try {
        stack.push(JSON.parse(script.textContent));
      } catch (e) {
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
   * Première valeur scalaire trouvée au bout d'un chemin, tous nœuds
   * confondus. Les listes sont traversées par leur premier élément : JSON-LD
   * écrit indifféremment `offers: {…}` ou `offers: [{…}]`.
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

  function fromJsonLd() {
    const nodes = jsonLdNodes();
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

  /* ------------------------------- Leboncoin --------------------------- */

  /** L'annonce consultée, telle que Next.js l'embarque dans la page. */
  function leboncoinAd() {
    const element = document.getElementById("__NEXT_DATA__");
    if (!element) return null;

    let data;
    try {
      data = JSON.parse(element.textContent);
    } catch (e) {
      return null;
    }

    const pageProps = data && data.props && data.props.pageProps;
    if (!pageProps) return null;

    const urlId = idFromUrl();
    let ad = pageProps.ad || null;
    if (!ad && pageProps.searchData && Array.isArray(pageProps.searchData.ads)) {
      const ads = pageProps.searchData.ads;
      ad =
        (urlId && ads.find((entry) => String(entry.list_id || entry.id) === urlId)) ||
        ads[0] ||
        null;
    }
    if (!ad) return null;

    // Garde anti-SPA : l'annonce doit correspondre à l'URL affichée.
    const adId = String(ad.list_id || ad.id || "");
    if (urlId && adId && urlId !== adId) return null;
    return ad;
  }

  function fromLeboncoin() {
    const ad = leboncoinAd();
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
    const photos = httpsOnly([
      ...(images.urls_large || []),
      ...(images.urls || []),
    ]);

    const city = ad.location && ad.location.city_label
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
      property_type:
        LBC_PROPERTY_TYPES[Number(attribute("real_estate_type"))] || null,
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

  /* --------------------------- Secours : le DOM ------------------------ */

  /**
   * Prix affiché, quand aucune donnée structurée ne le porte. On ne retient
   * que les montants d'un bloc « prix », en écartant les prix au m².
   */
  function priceFromDom() {
    const candidates = document.querySelectorAll(
      '[data-testid*="price" i], [data-test*="price" i], [class*="price" i], [class*="Price"]'
    );

    let best = null;
    for (const element of candidates) {
      const text = (element.textContent || "").slice(0, 120);
      if (!/€/.test(text)) continue;
      if (/\/\s*m|m²|mois\s*\/|au m/i.test(text)) continue;
      const value = integerFrom(text);
      if (value && value >= 100 && (best === null || value > best)) best = value;
    }
    return best;
  }

  /** Surface, pièces et chambres se lisent presque toujours dans le titre. */
  function fromText(title, description) {
    const text = [title, description].filter(Boolean).join(" \n ");
    if (!text) return {};

    const surface = text.match(/(\d+(?:[.,]\d+)?)\s*m²(?!\s*de\s*terrain)/i);
    const land = text.match(/terrain[^.\n]{0,20}?(\d+(?:[.,]\d+)?)\s*m²/i);
    const rooms = text.match(/(\d+)\s*pi[èe]ces?/i);
    const bedrooms = text.match(/(\d+)\s*chambres?/i);
    const dpe = text.match(/\bDPE\s*:?\s*([A-G])\b/i);
    const floorMatch = text.match(/étage\s*(\d{1,2})(?:\s*\/\s*\d+)?/i);

    return {
      surface: surface ? decimalFrom(surface[1]) : null,
      land_surface: land ? decimalFrom(land[1]) : null,
      rooms: rooms ? integerFrom(rooms[1]) : null,
      bedrooms: bedrooms ? integerFrom(bedrooms[1]) : null,
      dpe: dpe ? dpe[1].toUpperCase() : null,
      floor: floorMatch ? integerFrom(floorMatch[1]) : null,
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

  function fromPage() {
    const structured = fromJsonLd();
    const title =
      structured.title ||
      meta("og:title", "twitter:title") ||
      (document.querySelector("h1") || {}).textContent ||
      document.title ||
      null;
    const description =
      structured.description || meta("og:description", "description") || null;

    const haystack = `${location.pathname} ${title || ""}`;
    const text = fromText(title, description);

    return {
      ...structured,
      title: title ? title.trim().slice(0, 300) : null,
      description: description ? description.trim() : null,
      price: structured.price ?? integerFrom(meta("product:price:amount")) ?? priceFromDom(),
      surface: structured.surface ?? text.surface,
      land_surface: structured.land_surface ?? text.land_surface,
      rooms: structured.rooms ?? text.rooms,
      bedrooms: structured.bedrooms ?? text.bedrooms,
      floor: text.floor,
      dpe: text.dpe,
      property_type: propertyTypeFrom(haystack),
      transaction_type: transactionTypeFrom(haystack),
      photos: structured.photos && structured.photos.length
        ? structured.photos
        : httpsOnly([meta("og:image", "twitter:image")]),
    };
  }

  /* ----------------------------- Assemblage ---------------------------- */

  /**
   * Payload prêt pour `POST /api/v1/listings`, ou `null` si la page n'est pas
   * une annonce exploitable.
   */
  function extract() {
    const source = sourceFor(location.hostname);
    const url = canonicalUrl();
    if (!source || !url) return null;
    if (
      self.CarnetListingPage &&
      !self.CarnetListingPage.isListingDetailUrl(location.href)
    ) {
      return null;
    }

    const page = fromPage();
    const specific = source === "leboncoin" ? fromLeboncoin() : {};

    return compact({
      ...page,
      ...specific,
      location: { ...(page.location || {}), ...(specific.location || {}) },
      schema_version: 1,
      source,
      url,
      source_id: specific.source_id || idFromUrl(),
      captured_at: new Date().toISOString(),
    });
  }

  self.CarnetListing = { extract };
})();

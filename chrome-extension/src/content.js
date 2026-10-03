/**
 * Content script (monde isolé) injecté sur les pages seloger.com.
 *
 * Rôle :
 *  1. Recevoir la localisation du bien envoyée par inject.js (monde principal),
 *     qui lit la variable globale `window.__UFRN_LIFECYCLE_SERVERREQUEST__`.
 *     C'est la source la plus fiable (coordonnées GPS + adresse structurée).
 *  2. Fallbacks si la variable est absente : DOM, JSON-LD, URL.
 *  3. Demander au service worker le temps de trajet voiture et injecter un
 *     badge flottant avec le résultat.
 */

(function () {
  "use strict";

  const BADGE_ID = "seloger-travel-badge";
  const CHANNEL = "SELOGER_TRAVEL_LOCATION";
  const PHOTOS_CHANNEL = "SELOGER_LISTING_PHOTOS";
  const DETAILS_CHANNEL = "SELOGER_LISTING_DETAILS";

  let lastPropertyKey = null; // évite de recalculer pour le même bien
  let gotMainWorldData = false; // vrai dès qu'inject.js a fourni des données
  let lastLocation = null; // dernière localisation reçue (pour le recalcul)
  let galleryPhotos = []; // photos complètes fournies par inject.js (SeLoger)
  let lastDetails = null; // DPE/GES/année fournis par inject.js (SeLoger)

  /* ------------------------------------------------------------------ *
   *  Source principale : messages depuis inject.js (monde principal)
   * ------------------------------------------------------------------ */

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data) return;

    // Galerie complète SeLoger (inaccessible depuis le monde isolé).
    if (data.channel === PHOTOS_CHANNEL && Array.isArray(data.photos)) {
      galleryPhotos = data.photos.filter(
        (url) => typeof url === "string" && /^https:\/\//.test(url)
      );
      return;
    }

    // Caractéristiques énergétiques + année de construction (SeLoger).
    if (data.channel === DETAILS_CHANNEL && data.details) {
      lastDetails = data.details;
      return;
    }

    if (data.channel !== CHANNEL || !data.location) return;
    gotMainWorldData = true;
    lastLocation = data.location;
    compute(data.location, false);
  });

  /* ------------------------------------------------------------------ *
   *  Fallbacks d'extraction (si la variable globale est absente)
   * ------------------------------------------------------------------ */

  /** Élément DOM affichant le quartier / la ville. */
  function fromDom() {
    const el =
      document.querySelector('[data-testid="cdp-location-address"]') ||
      document.querySelector('[data-testid*="location"]');
    if (el) {
      const text = el.textContent.trim();
      if (text) return { lat: null, lon: null, address: text };
    }
    return null;
  }

  /** Données structurées JSON-LD (rarement géolocalisées sur SeLoger). */
  function fromJsonLd() {
    const scripts = document.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    for (const script of scripts) {
      let data;
      try {
        data = JSON.parse(script.textContent);
      } catch (e) {
        continue;
      }
      const nodes = Array.isArray(data) ? data : [data];
      for (const node of nodes) {
        const found = scanNodeForGeo(node);
        if (found) return found;
      }
    }
    return null;
  }

  function scanNodeForGeo(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 6) return null;
    if (node.geo && node.geo.latitude && node.geo.longitude) {
      return {
        lat: parseFloat(node.geo.latitude),
        lon: parseFloat(node.geo.longitude),
        address: formatAddress(node.address) || null,
      };
    }
    if (node.address) {
      const address = formatAddress(node.address);
      if (address) return { lat: null, lon: null, address };
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (value && typeof value === "object") {
        const found = scanNodeForGeo(value, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function formatAddress(address) {
    if (!address) return null;
    if (typeof address === "string") return address.trim() || null;
    const parts = [
      address.streetAddress,
      address.postalCode,
      address.addressLocality,
      address.addressRegion,
    ].filter(Boolean);
    return parts.length ? parts.join(" ") : null;
  }

  /**
   * Leboncoin (Next.js) : les données de l'annonce sont dans la balise
   * <script id="__NEXT_DATA__"> du DOM, lisible depuis ce monde isolé.
   * Chemin : props.pageProps.ad.location { city_label, zipcode, lat, lng }.
   * Restreint aux catégories immobilières.
   */
  const LBC_REALESTATE_CATEGORIES = new Set(["9", "10", "11", "13"]);

  function fromLeboncoin() {
    if (!/(^|\.)leboncoin\.fr$/i.test(location.hostname)) return null;
    const el = document.getElementById("__NEXT_DATA__");
    if (!el) return null;

    let data;
    try {
      data = JSON.parse(el.textContent);
    } catch (e) {
      return null;
    }
    const pp = data && data.props && data.props.pageProps;
    if (!pp) return null;

    const urlId = (location.pathname.match(/(\d{6,})/) || [])[1] || null;

    // Deux emplacements possibles selon la version du site :
    //  - ancien : pageProps.ad ;
    //  - actuel : pageProps.searchData.ads[] où l'annonce consultée figure
    //    en première position (suivie d'annonces similaires). On la retrouve
    //    par son identifiant pour ne pas prendre une annonce voisine.
    let ad = pp.ad || null;
    if (!ad && pp.searchData && Array.isArray(pp.searchData.ads)) {
      const ads = pp.searchData.ads;
      ad =
        (urlId && ads.find((a) => String(a.list_id || a.id) === urlId)) ||
        ads[0] ||
        null;
    }
    if (!ad || !ad.location) return null;

    // Catégorie immobilière uniquement (évite le badge sur une annonce de vélo).
    const catId = ad.category_id != null ? String(ad.category_id) : null;
    if (catId && !LBC_REALESTATE_CATEGORIES.has(catId)) return null;

    // Garde anti-SPA : l'annonce doit correspondre à l'URL courante.
    const adId = String(ad.list_id || ad.id || "");
    if (urlId && adId && urlId !== adId) return null;

    const loc = ad.location;
    const lat = toNum(loc.lat);
    const lon = toNum(loc.lng);
    const zipCode = loc.zipcode ? String(loc.zipcode).trim() : null;

    // city_label peut valoir "Paris 11e" ou "Golbey 88190" : on retire le CP.
    let city = loc.city_label || loc.city || null;
    if (city) city = String(city).replace(/\s*\d{5}\s*$/, "").trim() || null;
    const district = loc.district || null;

    if (lat == null && lon == null && !zipCode && !city) return null;

    const address = [city, zipCode].filter(Boolean).join(" ") || null;
    const approximate =
      loc.is_shape === true || loc.source === "city" || lat == null || lon == null;

    return { lat, lon, address, district, city, zipCode, approximate };
  }

  function toNum(v) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim()) {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  /** Dernier recours : titre de la page (souvent "... Quartier Ville (CP)"). */
  function fromTitle() {
    const title = document.title || "";
    const m = title.match(/([A-Za-zÀ-ÿ' -]+)\s*\((\d{5})\)/);
    if (m) {
      return { lat: null, lon: null, address: `${m[1].trim()} ${m[2]}` };
    }
    return null;
  }

  function extractFallback() {
    return fromLeboncoin() || fromDom() || fromJsonLd() || fromTitle() || null;
  }

  /* ------------------------------------------------------------------ *
   *  Badge flottant
   * ------------------------------------------------------------------ */

  /*
   * Feuille de style du badge, isolée dans un Shadow DOM pour qu'aucune règle
   * des sites hôtes (SeLoger, Leboncoin…) ne vienne la casser. Les jetons de
   * couleur, rayons et typographie reprennent ceux de la popup / du carnet
   * (styles/popup.css) : l'extension doit se ressembler partout.
   */
  const BADGE_CSS = `
    :host {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483647;
    }
    .card {
      box-sizing: border-box;
      width: 300px;
      max-width: calc(100vw - 40px);
      background: #ffffff;
      color: #11150f;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
        Helvetica, Arial, sans-serif;
      font-size: 13px;
      line-height: 1.45;
      border: 1px solid #e2ded1;
      border-radius: 16px;
      box-shadow: 0 1px 2px rgba(17, 21, 15, 0.05),
        0 12px 32px rgba(17, 21, 15, 0.16);
      padding: 14px;
      display: grid;
      gap: 10px;
      -webkit-font-smoothing: antialiased;
    }
    .card * { box-sizing: border-box; }
    .hd {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .hd__mark {
      width: 22px;
      height: 22px;
      border-radius: 7px;
      background: #0b3d2c;
      color: #c8f751;
      display: grid;
      place-items: center;
      font-size: 12px;
      font-weight: 700;
    }
    .hd__title {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #6b7280;
    }
    .msg {
      margin: 0;
      font-size: 13px;
      color: #3c433a;
    }
    .trips {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 6px;
    }
    .trip {
      background: #f7f6f2;
      border: 1px solid #e2ded1;
      border-radius: 12px;
      padding: 8px 10px;
      display: grid;
      gap: 2px;
    }
    .trip__row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }
    .trip__label {
      font-weight: 650;
      font-size: 12px;
      color: #11150f;
    }
    .trip__value {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: #0b3d2c;
      white-space: nowrap;
    }
    .trip__meta {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-size: 11px;
      color: #6b7280;
    }
    .trip--off .trip__label { color: #6b7280; }
    .trip--off .trip__value {
      font-size: 12px;
      font-weight: 600;
      color: #6b7280;
    }
    .meta {
      display: grid;
      gap: 6px;
      padding-top: 10px;
      border-top: 1px solid #e2ded1;
    }
    .meta__row {
      display: flex;
      gap: 6px;
      align-items: baseline;
      font-size: 12px;
      color: #3c433a;
    }
    .meta__row .ic { flex: 0 0 auto; }
    .muted { color: #6b7280; }
    .dots {
      letter-spacing: 2px;
      color: #2e8b6b;
    }
    a {
      color: #0b3d2c;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
    }
    a:hover {
      text-decoration: underline;
      text-underline-offset: 2px;
    }
  `;

  const HEADER_HTML =
    `<div class="hd"><span class="hd__mark">C</span>` +
    `<span class="hd__title">Temps de trajet</span></div>`;

  /**
   * Crée (ou récupère) la carte du badge dans un Shadow DOM isolé.
   * Renvoie l'élément `.card` où injecter le contenu.
   */
  function ensureBadge() {
    let host = document.getElementById(BADGE_ID);
    if (host && host.__card) return host.__card;

    host = document.createElement("div");
    host.id = BADGE_ID;
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = BADGE_CSS;

    const card = document.createElement("div");
    card.className = "card";
    card.addEventListener("click", (event) => {
      const link = event.target.closest("a[data-maps]");
      if (!link || !card.contains(link)) return;
      event.preventDefault();
      event.stopPropagation();
      const url = link.getAttribute("href");
      if (url) chrome.runtime.sendMessage({ type: "OPEN_MAPS", url });
    });

    shadow.appendChild(style);
    shadow.appendChild(card);
    document.body.appendChild(host);
    host.__card = card;
    return card;
  }

  function renderBadge(html) {
    ensureBadge().innerHTML = html;
  }

  function renderLoading() {
    renderBadge(`${HEADER_HTML}<p class="msg">🚗 Calcul du trajet…</p>`);
  }

  function escapeHtml(str) {
    return String(str).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]
    );
  }

  /** Un bloc de temps de trajet, une carte par adresse de référence du projet. */
  function renderTripsHtml(result) {
    const trips = Array.isArray(result.trips) ? result.trips : [];
    if (!trips.length) return "";

    const items = trips.map((trip) => {
      const name = escapeHtml(trip.label || "Destination");
      if (trip.error) {
        return (
          `<li class="trip trip--off"><div class="trip__row">` +
          `<span class="trip__label">${name}</span>` +
          `<span class="trip__value">indisponible</span></div></li>`
        );
      }
      const maps = trip.mapsUrl
        ? `<a data-maps href="${escapeHtml(trip.mapsUrl)}" ` +
          `title="Voir le trajet dans Google Maps">Itinéraire ↗</a>`
        : `<span></span>`;
      return (
        `<li class="trip"><div class="trip__row">` +
        `<span class="trip__label">${name}</span>` +
        `<span class="trip__value">${escapeHtml(trip.durationText)}</span>` +
        `</div><div class="trip__meta">` +
        `<span>${escapeHtml(trip.distanceText)}</span>${maps}</div></li>`
      );
    });
    return `<ul class="trips">${items.join("")}</ul>`;
  }

  function renderResult(result) {
    const metaRows = [
      renderLocationLine(result),
      renderPrices(result),
      renderPolitics(result),
      renderTaxe(result),
    ]
      .filter(Boolean)
      .join("");
    const meta = metaRows ? `<div class="meta">${metaRows}</div>` : "";
    renderBadge(HEADER_HTML + renderTripsHtml(result) + meta);
  }

  function formatEuro(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
  }

  /** Prix médians au m² (maison / appartement) de la commune, source DVF. */
  function renderPrices(result) {
    const p = result.prices;
    if (!p) return "";
    const parts = [];
    if (p.maison) parts.push(`🏠 ${formatEuro(p.maison)} €`);
    if (p.appt) parts.push(`🏢 ${formatEuro(p.appt)} €`);
    if (!parts.length) return "";
    return (
      `<div class="meta__row" ` +
      `title="Prix de vente médian au m² sur ~5 ans (données DVF / DGFiP)">` +
      `<span class="ic">💶</span>` +
      `<span>${parts.join(" · ")} <span class="muted">/m²</span></span></div>`
    );
  }

  /** Orientation politique de la commune (1er tour présidentielle 2022). */
  function renderPolitics(result) {
    const p = result.politics;
    if (!p) return "";
    return (
      `<div class="meta__row" ` +
      `title="Blocs au 1er tour de la présidentielle 2022">` +
      `<span class="ic">🗳️</span><span>${escapeHtml(p.label)} ` +
      `<span class="muted">(G ${p.gauche} · C ${p.centre} · D ${p.droite})` +
      `</span></span></div>`
    );
  }

  /** Indice de taxe foncière (1 = parmi les moins chers, 5 = parmi les plus chers). */
  function renderTaxe(result) {
    const t = result.taxeIndex;
    if (!t) return "";
    const dots = "●".repeat(t) + "○".repeat(5 - t);
    return (
      `<div class="meta__row" ` +
      `title="Indice du taux communal de taxe foncière (quintile national). ` +
      `1 = parmi les plus bas, 5 = parmi les plus élevés.">` +
      `<span class="ic">🏠</span><span>Taxe foncière ` +
      `<span class="dots">${dots}</span> ${t}/5</span></div>`
    );
  }

  /** Nom de ville (ou quartier) cliquable : ouvre Google Maps centré dessus. */
  function renderLocationLine(result) {
    const city = result.city || null;
    const district =
      result.district && result.district !== city ? result.district : null;
    const placeName = city || district;
    if (!placeName) return "";

    const url = result.mapsUrl;
    let placeHtml = escapeHtml(placeName);
    if (url) {
      placeHtml =
        `<a data-maps href="${escapeHtml(url)}" ` +
        `title="Ouvrir ${escapeHtml(placeName)} dans Google Maps">` +
        `${escapeHtml(placeName)}</a>`;
    }

    const prefix = city && district ? `${escapeHtml(district)}, ` : "";
    return (
      `<div class="meta__row"><span class="ic">📍</span>` +
      `<span>${prefix}${placeHtml}</span></div>`
    );
  }

  function renderError(error) {
    let msg;
    if (error === "NOT_CONNECTED") {
      msg =
        "🔒 Authentifiez-vous via l'icône de l'extension pour afficher le " +
        "temps de trajet.";
    } else if (error === "TRAVEL_UNAVAILABLE") {
      msg = "🚗 Calcul d'itinéraire momentanément indisponible.";
    } else if (error === "NOT_FOUND") {
      msg = "📍 Adresse du bien introuvable sur cette page.";
    } else {
      msg = `⚠️ Erreur : ${escapeHtml(error || "inconnue")}`;
    }
    renderBadge(`${HEADER_HTML}<p class="msg">${msg}</p>`);
  }

  /* ------------------------------------------------------------------ *
   *  Orchestration
   * ------------------------------------------------------------------ */

  function propertyKey(prop) {
    if (!prop) return null;
    if (prop.lat != null && prop.lon != null) {
      return `${prop.lat.toFixed(5)},${prop.lon.toFixed(5)}`;
    }
    return prop.address || null;
  }

  function compute(property, force) {
    if (!property) return;

    const key = propertyKey(property);
    if (!force && key && key === lastPropertyKey) return;
    lastPropertyKey = key;

    renderLoading();

    chrome.runtime.sendMessage(
      { type: "COMPUTE_TRAVEL", property },
      (response) => {
        if (chrome.runtime.lastError) {
          renderError(chrome.runtime.lastError.message);
          return;
        }
        if (!response) {
          renderError("Pas de réponse du service.");
          return;
        }
        if (response.ok) {
          renderResult(response);
        } else {
          renderError(response.error);
        }
      }
    );
  }

  /**
   * Complète la localisation du payload avec la donnée fiable du monde
   * principal (inject.js). Sur SeLoger, le JSON-LD ne porte ni adresse ni
   * coordonnées : sans cet apport, l'annonce serait enregistrée sans
   * localisation et l'enrichissement communal (code postal, code INSEE,
   * commune) échouerait faute du moindre repère. Au minimum la ville —
   * toujours présente ici — suffit au serveur à retrouver la commune.
   *
   * Les valeurs déjà extraites par le carnet (JSON-LD, Leboncoin) priment :
   * on ne fait que combler les trous.
   */
  function mergeLocation(listing, loc) {
    if (!listing || !loc) return;
    const location = { ...(listing.location || {}) };

    const fill = (key, value) => {
      const empty =
        location[key] === undefined ||
        location[key] === null ||
        location[key] === "";
      if (empty && value !== undefined && value !== null && value !== "") {
        location[key] = value;
      }
    };

    fill("city", loc.city);
    fill("postal_code", loc.zipCode);
    fill("insee_code", loc.insee); // renseigné par Belles Demeures (zone_code)
    if (typeof loc.lat === "number" && Number.isFinite(loc.lat)) {
      fill("lat", loc.lat);
    }
    if (typeof loc.lon === "number" && Number.isFinite(loc.lon)) {
      fill("lng", loc.lon);
    }

    if (Object.keys(location).length) listing.location = location;
  }

  /**
   * Complète l'annonce avec les données fiables du monde principal : la
   * description intégrale, le DPE, le GES (note + valeurs chiffrées) et l'année
   * de construction. Sur SeLoger, ces champs ne figurent ni dans le JSON-LD ni
   * dans les balises Open Graph (qui ne portent qu'un extrait SEO tronqué) :
   * sans cet apport, l'annonce serait enregistrée avec une description amputée
   * et sans performance énergétique ni année de construction. Pour le DPE, le
   * GES et l'année, les valeurs déjà extraites par le carnet priment (on comble
   * les trous) ; la description complète, elle, remplace l'extrait tronqué.
   */
  function mergeDetails(listing, details) {
    if (!listing || !details) return;
    const fill = (key, value) => {
      const empty =
        listing[key] === undefined ||
        listing[key] === null ||
        listing[key] === "";
      if (empty && value !== undefined && value !== null && value !== "") {
        listing[key] = value;
      }
    };
    // La description du monde principal est le texte intégral : elle prime sur
    // l'extrait SEO tronqué extrait par le carnet (JSON-LD / og:description).
    // On ne remplace que si elle est bien plus complète, jamais pour raccourcir.
    if (
      typeof details.description === "string" &&
      details.description.length > String(listing.description || "").length
    ) {
      listing.description = details.description;
    }
    fill("dpe", details.dpe);
    fill("ges", details.ges);
    fill("dpe_value", details.dpe_value);
    fill("ges_value", details.ges_value);
    fill("year_built", details.year_built);
  }

  /** Demandes venues du popup ou du service worker. */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Lecture de l'annonce avant enregistrement dans le carnet.
    if (msg && msg.type === "EXTRACT_LISTING") {
      const listing = self.CarnetListing ? self.CarnetListing.extract() : null;
      // La galerie complète (SeLoger) prime sur l'unique og:image extraite du
      // DOM : on la place en tête, puis on complète sans doublon.
      if (listing && galleryPhotos.length) {
        const merged = [...galleryPhotos];
        for (const url of listing.photos || []) {
          if (!merged.includes(url)) merged.push(url);
        }
        listing.photos = merged;
      }
      // La localisation fiable (coordonnées GPS, ville, code postal) vit dans
      // le monde principal et n'est pas accessible au carnet : on l'injecte ici.
      if (listing) mergeLocation(listing, lastLocation);
      // De même pour la performance énergétique et l'année de construction.
      if (listing) mergeDetails(listing, lastDetails);
      sendResponse({ listing });
      return false;
    }

    if (msg && msg.type === "RECOMPUTE") {
      lastPropertyKey = null;
      // Priorité à la dernière localisation fournie par inject.js (fiable,
      // multi-sites), sinon extraction de secours depuis le DOM.
      const prop = lastLocation || extractFallback();
      if (prop) compute(prop, true);
      sendResponse({ ok: true });
    }
    return false;
  });

  /* ------------------------------------------------------------------ *
   *  Fallback : si inject.js n'a rien fourni après un délai, on tente le DOM.
   * ------------------------------------------------------------------ */

  setTimeout(() => {
    if (gotMainWorldData) return;
    const prop = extractFallback();
    if (prop) compute(prop, false);
  }, 3500);

  /* ------------------------------------------------------------------ *
   *  Leboncoin : extraction immédiate + suivi des navigations SPA.
   * ------------------------------------------------------------------ */

  if (/(^|\.)leboncoin\.fr$/i.test(location.hostname)) {
    let lastUrl = location.href;
    const tryLbc = () => {
      const prop = fromLeboncoin();
      if (prop) {
        lastLocation = prop;
        compute(prop, false);
      }
    };
    tryLbc();
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        lastPropertyKey = null;
        tryLbc();
      }
    }, 1500);
  }
})();

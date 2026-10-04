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

  // État d'affichage du badge : carte déployée ou bulle réduite déplaçable.
  // `side` = bord d'aimantation, `topRatio` = hauteur relative (0 = haut, 1 = bas).
  let badgeState = { collapsed: false, side: "right", topRatio: null };

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
    if (isListingDetailPage()) compute(data.location, false);
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
      z-index: 2147483647;
    }
    .hidden { display: none !important; }
    @keyframes seloger-pop-in {
      from { opacity: 0; transform: translateY(8px) scale(0.96); }
      to { opacity: 1; transform: none; }
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
    .card { animation: seloger-pop-in 0.18s ease; transform-origin: bottom right; }
    .hd__close {
      margin-left: auto;
      flex: 0 0 auto;
      width: 24px;
      height: 24px;
      padding: 0;
      border: none;
      background: transparent;
      color: #9aa0a6;
      border-radius: 8px;
      cursor: pointer;
      display: grid;
      place-items: center;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .hd__close:hover { background: #f1efe8; color: #11150f; }
    .hd__close:active { background: #e7e4da; }
    .launcher {
      -webkit-appearance: none;
      appearance: none;
      margin: 0;
      padding: 0;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      border: 2px solid #ffffff;
      background: #0b3d2c;
      color: #c8f751;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
        Helvetica, Arial, sans-serif;
      font-size: 19px;
      font-weight: 700;
      display: grid;
      place-items: center;
      cursor: grab;
      user-select: none;
      touch-action: none;
      box-shadow: 0 2px 6px rgba(17, 21, 15, 0.18),
        0 8px 24px rgba(17, 21, 15, 0.22);
      animation: seloger-pop-in 0.18s ease;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .launcher:hover {
      transform: scale(1.06);
      box-shadow: 0 3px 8px rgba(17, 21, 15, 0.2),
        0 12px 30px rgba(17, 21, 15, 0.26);
    }
    .launcher:active { cursor: grabbing; }
    .launcher.dragging {
      animation: none;
      transition: none;
      cursor: grabbing;
      transform: scale(1.1);
    }
    .launcher__mark { pointer-events: none; line-height: 1; }
  `;

  const HEADER_HTML =
    `<div class="hd"><span class="hd__mark">C</span>` +
    `<span class="hd__title">Temps de trajet</span>` +
    `<button class="hd__close" type="button" aria-label="Réduire" ` +
    `title="Réduire dans une bulle">` +
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2.4" stroke-linecap="round">` +
    `<path d="M5 12h14"/></svg></button></div>`;

  /* ------------------------------------------------------------------ *
   *  Réduction en bulle déplaçable (façon iGraal / Intercom)
   *
   *  La carte peut se replier en une bulle ronde que l'on déplace à la
   *  souris ; elle s'aimante au bord gauche ou droit le plus proche et
   *  mémorise sa hauteur. Un simple clic la redéploie. L'état (réduit /
   *  déployé + position) est persisté dans chrome.storage.local pour
   *  survivre aux navigations et aux changements d'annonce.
   * ------------------------------------------------------------------ */

  const BADGE_MARGIN = 16; // marge mini entre la bulle et le bord de l'écran
  const LAUNCHER_SIZE = 48;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function saveBadgeState() {
    try {
      chrome.storage?.local?.set({
        badgeUi: {
          collapsed: badgeState.collapsed,
          side: badgeState.side,
          topRatio: badgeState.topRatio,
        },
      });
    } catch (e) {
      /* stockage indisponible : l'état reste au moins en mémoire */
    }
  }

  function loadBadgeState(done) {
    try {
      chrome.storage?.local?.get("badgeUi", (res) => {
        const s = res && res.badgeUi;
        if (s) {
          if (s.side === "left" || s.side === "right") badgeState.side = s.side;
          if (typeof s.topRatio === "number") badgeState.topRatio = s.topRatio;
          if (typeof s.collapsed === "boolean") {
            badgeState.collapsed = s.collapsed;
          }
        }
        done && done();
      });
    } catch (e) {
      done && done();
    }
  }

  /** Place l'hôte sur la bulle réduite (coin, selon le côté mémorisé). */
  function applyCollapsedPosition() {
    const host = document.getElementById(BADGE_ID);
    if (!host) return;
    const travel = window.innerHeight - LAUNCHER_SIZE;
    let top = badgeState.topRatio == null
      ? travel - 20 // par défaut : en bas
      : badgeState.topRatio * travel;
    top = clamp(top, BADGE_MARGIN, travel - BADGE_MARGIN);
    host.style.top = `${Math.round(top)}px`;
    host.style.bottom = "auto";
    if (badgeState.side === "left") {
      host.style.left = `${BADGE_MARGIN}px`;
      host.style.right = "auto";
    } else {
      host.style.right = `${BADGE_MARGIN}px`;
      host.style.left = "auto";
    }
  }

  /** Place l'hôte sur la carte déployée (ancrée en bas, côté mémorisé). */
  function applyExpandedPosition() {
    const host = document.getElementById(BADGE_ID);
    if (!host) return;
    host.style.top = "auto";
    host.style.bottom = "20px";
    if (badgeState.side === "left") {
      host.style.left = "20px";
      host.style.right = "auto";
    } else {
      host.style.right = "20px";
      host.style.left = "auto";
    }
  }

  /** Bascule entre la carte déployée et la bulle réduite. */
  function setCollapsed(collapsed, persist) {
    badgeState.collapsed = collapsed;
    const host = document.getElementById(BADGE_ID);
    if (host && host.__ui) {
      const { card, launcher } = host.__ui;
      if (collapsed) {
        card.classList.add("hidden");
        launcher.classList.remove("hidden");
        applyCollapsedPosition();
      } else {
        launcher.classList.add("hidden");
        card.classList.remove("hidden");
        applyExpandedPosition();
      }
    }
    if (persist !== false) saveBadgeState();
  }

  /**
   * Rend la bulle déplaçable : déplacement libre au doigt / à la souris, puis
   * aimantation au bord le plus proche. Un relâchement sans déplacement notable
   * est interprété comme un clic → redéploiement de la carte.
   */
  function setupLauncherDrag(host, launcher) {
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let dragging = false;

    launcher.addEventListener("pointerdown", (event) => {
      if (event.button != null && event.button !== 0) return;
      const rect = host.getBoundingClientRect();
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      originLeft = rect.left;
      originTop = rect.top;
      dragging = false;
      try {
        launcher.setPointerCapture(pointerId);
      } catch (e) {}
      event.preventDefault();
    });

    launcher.addEventListener("pointermove", (event) => {
      if (pointerId == null) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) < 5) return; // sous le seuil : clic
      if (!dragging) {
        dragging = true;
        launcher.classList.add("dragging");
      }
      const left = clamp(
        originLeft + dx,
        BADGE_MARGIN,
        window.innerWidth - LAUNCHER_SIZE - BADGE_MARGIN
      );
      const top = clamp(
        originTop + dy,
        BADGE_MARGIN,
        window.innerHeight - LAUNCHER_SIZE - BADGE_MARGIN
      );
      host.style.left = `${Math.round(left)}px`;
      host.style.top = `${Math.round(top)}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
    });

    const endDrag = () => {
      if (pointerId == null) return;
      try {
        launcher.releasePointerCapture(pointerId);
      } catch (e) {}
      pointerId = null;
      const wasDragging = dragging;
      dragging = false;
      launcher.classList.remove("dragging");

      if (!wasDragging) {
        // Pas de déplacement notable → c'est un clic : on redéploie la carte.
        setCollapsed(false);
        return;
      }
      // Aimantation : la bulle colle au bord gauche ou droit le plus proche.
      const rect = host.getBoundingClientRect();
      const center = rect.left + rect.width / 2;
      badgeState.side = center < window.innerWidth / 2 ? "left" : "right";
      badgeState.topRatio = clamp(
        rect.top / (window.innerHeight - LAUNCHER_SIZE),
        0,
        1
      );
      applyCollapsedPosition();
      saveBadgeState();
    };

    launcher.addEventListener("pointerup", endDrag);
    launcher.addEventListener("pointercancel", endDrag);
  }

  /**
   * Crée (ou récupère) le badge dans un Shadow DOM isolé : la carte détaillée
   * et la bulle réduite déplaçable. Renvoie l'élément `.card` où injecter le
   * contenu.
   */
  function ensureBadge() {
    let host = document.getElementById(BADGE_ID);
    if (host && host.__card) return host.__card;

    host = document.createElement("div");
    host.id = BADGE_ID;
    host.style.position = "fixed";
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = BADGE_CSS;

    const card = document.createElement("div");
    card.className = "card";
    card.addEventListener("click", (event) => {
      // Bouton « réduire » → repli de la carte vers la bulle.
      const close = event.target.closest(".hd__close");
      if (close && card.contains(close)) {
        event.preventDefault();
        event.stopPropagation();
        setCollapsed(true);
        return;
      }
      // Liens « Itinéraire / ville » → ouverture de Google Maps.
      const link = event.target.closest("a[data-maps]");
      if (!link || !card.contains(link)) return;
      event.preventDefault();
      event.stopPropagation();
      const url = link.getAttribute("href");
      if (url) chrome.runtime.sendMessage({ type: "OPEN_MAPS", url });
    });

    const launcher = document.createElement("button");
    launcher.className = "launcher hidden";
    launcher.type = "button";
    launcher.setAttribute("aria-label", "Ouvrir le temps de trajet");
    launcher.title = "Carnet de Visites — temps de trajet";
    launcher.innerHTML = `<span class="launcher__mark">C</span>`;

    shadow.appendChild(style);
    shadow.appendChild(card);
    shadow.appendChild(launcher);
    document.body.appendChild(host);

    host.__card = card;
    host.__ui = { card, launcher };

    setupLauncherDrag(host, launcher);
    // Applique l'état mémorisé (réduit ou déployé) sans le re-persister.
    setCollapsed(badgeState.collapsed, false);

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

  function isListingDetailPage() {
    return (
      self.CarnetListingPage &&
      self.CarnetListingPage.isListingDetailUrl(location.href)
    );
  }

  function clearTravelBadge() {
    const host = document.getElementById(BADGE_ID);
    if (host) host.remove();
  }

  function compute(property, force) {
    if (!isListingDetailPage()) {
      clearTravelBadge();
      return;
    }
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
    fill("floor", details.floor);
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

  // Restaure l'état d'affichage mémorisé (réduit / déployé + position de la
  // bulle) ; si le badge est déjà à l'écran, on l'applique immédiatement.
  loadBadgeState(() => {
    const host = document.getElementById(BADGE_ID);
    if (host && host.__ui) setCollapsed(badgeState.collapsed, false);
  });

  // La bulle réduite suit le redimensionnement de la fenêtre.
  window.addEventListener("resize", () => {
    if (badgeState.collapsed) applyCollapsedPosition();
  });

  /* ------------------------------------------------------------------ *
   *  Fallback : si inject.js n'a rien fourni après un délai, on tente le DOM.
   * ------------------------------------------------------------------ */

  setTimeout(() => {
    if (!isListingDetailPage()) return;
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
      if (!isListingDetailPage()) {
        clearTravelBadge();
        return;
      }
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
      }
      tryLbc();
    }, 1500);
  }

  // Navigation SPA (SeLoger / Belles Demeures) : retirer le badge hors fiche.
  let lastDetailHref = location.href;
  setInterval(() => {
    if (location.href !== lastDetailHref) {
      lastDetailHref = location.href;
      lastPropertyKey = null;
    }
    if (!isListingDetailPage()) clearTravelBadge();
  }, 1500);
})();

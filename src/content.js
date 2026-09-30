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

  let lastPropertyKey = null; // évite de recalculer pour le même bien
  let gotMainWorldData = false; // vrai dès qu'inject.js a fourni des données

  /* ------------------------------------------------------------------ *
   *  Source principale : messages depuis inject.js (monde principal)
   * ------------------------------------------------------------------ */

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || !data.location) return;
    gotMainWorldData = true;
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
    return fromDom() || fromJsonLd() || fromTitle() || null;
  }

  /* ------------------------------------------------------------------ *
   *  Badge flottant
   * ------------------------------------------------------------------ */

  function ensureBadge() {
    let badge = document.getElementById(BADGE_ID);
    if (badge) return badge;
    badge = document.createElement("div");
    badge.id = BADGE_ID;
    Object.assign(badge.style, {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      zIndex: "2147483647",
      background: "#1d2b4f",
      color: "#fff",
      padding: "10px 14px",
      borderRadius: "10px",
      font: "600 14px/1.35 -apple-system,Segoe UI,Roboto,Arial,sans-serif",
      boxShadow: "0 6px 20px rgba(0,0,0,.25)",
      maxWidth: "260px",
    });
    document.body.appendChild(badge);
    return badge;
  }

  function renderBadge(html) {
    ensureBadge().innerHTML = html;
  }

  function renderLoading() {
    renderBadge("🚗 Calcul du trajet…");
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

  function renderResult(result, approximate) {
    const location = result.district || result.city;
    const locationLine = location
      ? `<br><span style="font-weight:400;opacity:.9;font-size:12px">📍 ${escapeHtml(
          location
        )}</span>`
      : "";
    const note = approximate
      ? '<br><span style="font-weight:400;opacity:.7;font-size:11px">≈ depuis le centre du quartier</span>'
      : "";
    renderBadge(
      `🚗 <span style="font-size:16px">${result.durationText}</span>` +
        ` <span style="opacity:.8">depuis chez vous</span>` +
        `<br><span style="font-weight:400;opacity:.85">${result.distanceText}</span>` +
        locationLine +
        note
    );
  }

  function renderError(error) {
    if (error === "NO_CONFIG") {
      renderBadge(
        "⚙️ Cliquez sur l'icône de l'extension<br>pour configurer votre adresse et la clé API."
      );
    } else if (error === "NOT_FOUND") {
      renderBadge("📍 Adresse du bien introuvable sur cette page.");
    } else {
      renderBadge(`⚠️ Erreur : ${error || "inconnue"}`);
    }
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
          renderResult(response, property.approximate);
        } else {
          renderError(response.error);
        }
      }
    );
  }

  /** Recalcul demandé depuis le popup. */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "RECOMPUTE") {
      lastPropertyKey = null;
      const prop = extractFallback();
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
})();

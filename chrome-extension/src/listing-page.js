/**
 * Détection d'une fiche annonce (URL) — partagée popup, content script et SW.
 * Exclut accueil, listes de résultats et autres pages hors détail d'un bien.
 */
(function (global) {
  const HOSTS = [
    [/(^|\.)seloger\.com$/i, "seloger"],
    [/(^|\.)bellesdemeures\.com$/i, "bellesdemeures"],
    [/(^|\.)leboncoin\.fr$/i, "leboncoin"],
  ];

  function sourceFor(hostname) {
    const match = HOSTS.find(([pattern]) => pattern.test(hostname));
    return match ? match[1] : null;
  }

  /** Identifiant annonce dans le chemin (aligné sur listing.js). */
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

  function isListingDetailUrl(href) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return false;
    }
    if (url.protocol !== "https:") return false;

    const source = sourceFor(url.hostname);
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

  global.CarnetListingPage = { isListingDetailUrl, sourceFor, listingIdFromPath };
})(typeof self !== "undefined" ? self : window);

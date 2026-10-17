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

  function listingIdFromPath(pathname) {
    return global.CarnetListingId
      ? global.CarnetListingId.listingIdFromPath(pathname)
      : null;
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

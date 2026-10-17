/**
 * Identifiant annonce dans le chemin URL SeLoger / Belles Demeures.
 * Copie de `app/src/lib/listing-id-from-path.js` (extension sans build).
 */
(function (global) {
  const SELOGER_SUFFIX_SEGMENTS = new Set(["images", "videos", "plans"]);

  function isModernSelogerIdSegment(segment) {
    if (!segment || !/^[A-Za-z0-9]+$/.test(segment)) return false;
    if (/^\d{5,}$/.test(segment)) return false;
    if (segment.length < 10) return false;
    if (SELOGER_SUFFIX_SEGMENTS.has(segment.toLowerCase())) return false;
    if (/[0-9]/.test(segment)) return true;
    return segment.length >= 12 && /[A-Z]/.test(segment);
  }

  function listingIdFromPath(pathname) {
    const path = String(pathname || "").replace(/\/+$/, "");
    const legacy = path.match(/(\d{5,})\.htm(?:l)?$/i);
    if (legacy) return legacy[1];

    if (!/\/annonces?\//i.test(path)) return null;

    const segments = path.split("/").filter(Boolean);

    const mediasIdx = segments.findIndex((s) => s.toLowerCase() === "medias");
    if (mediasIdx > 0) {
      const candidate = segments[mediasIdx - 1];
      if (isModernSelogerIdSegment(candidate)) {
        return candidate.toUpperCase();
      }
    }

    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (SELOGER_SUFFIX_SEGMENTS.has(seg.toLowerCase())) continue;
      if (seg.toLowerCase() === "medias") continue;
      if (isModernSelogerIdSegment(seg)) return seg.toUpperCase();
    }

    return null;
  }

  function normalizeSelogerListingPathname(pathname) {
    return String(pathname || "")
      .replace(/\/medias(?:\/.*)?$/i, "")
      .replace(/\/+$/, "");
  }

  global.CarnetListingId = {
    listingIdFromPath,
    normalizeSelogerListingPathname,
  };
})(typeof self !== "undefined" ? self : window);

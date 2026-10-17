/**
 * Identifiant annonce dans le chemin URL SeLoger / Belles Demeures.
 *
 * Les fiches modernes utilisent un token alphanumérique (~12 caractères,
 * lettres et chiffres). Les sous-pages (`/medias/images`, etc.) ne doivent
 * pas être prises pour l'identifiant — aligné sur `chrome-extension/src/listing-id.js`.
 */

/** Segments de fin de chemin qui ne sont pas l'id annonce. */
const SELOGER_SUFFIX_SEGMENTS = new Set(["images", "videos", "plans"]);

function isModernSelogerIdSegment(segment) {
  if (!segment || !/^[A-Za-z0-9]+$/.test(segment)) return false;
  if (/^\d{5,}$/.test(segment)) return false;
  if (segment.length < 10) return false;
  if (SELOGER_SUFFIX_SEGMENTS.has(segment.toLowerCase())) return false;
  if (/[0-9]/.test(segment)) return true;
  return segment.length >= 12 && /[A-Z]/.test(segment);
}

export function listingIdFromPath(pathname) {
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

/** Ramène une URL galerie SeLoger vers le chemin de la fiche principale. */
export function normalizeSelogerListingPathname(pathname) {
  return String(pathname || "")
    .replace(/\/medias(?:\/.*)?$/i, "")
    .replace(/\/+$/, "");
}

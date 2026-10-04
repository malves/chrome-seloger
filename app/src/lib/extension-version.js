/**
 * Version sémantique de l'extension Chrome (en-tête `X-Carnet-Extension-Version`).
 */

export const EXTENSION_VERSION_HEADER = "x-carnet-extension-version";

/** @returns {{ major: number, minor: number, patch: number } | null} */
export function parseSemver(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value || "").trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Compare deux versions `x.y.z`.
 * @returns {number | null} négatif si a < b, positif si a > b, 0 si égal ; null si invalide
 */
export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

export function readExtensionVersion(req) {
  const raw = req.get(EXTENSION_VERSION_HEADER);
  const version = String(raw || "").trim();
  return version || null;
}

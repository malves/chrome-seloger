import { compareSemver } from "../lib/extension-version.js";

/**
 * @param {string | null | undefined} clientVersion
 * @param {string | undefined} minVersion
 */
export function isExtensionOutdated(clientVersion, minVersion) {
  const min = String(minVersion || "").trim();
  if (!min) return false;

  const client = String(clientVersion || "").trim();
  if (!client) return true;

  const cmp = compareSemver(client, min);
  if (cmp === null) return true;
  return cmp < 0;
}

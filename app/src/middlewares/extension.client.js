/**
 * Lit la version de l'extension sur `/api/v1/*` et applique éventuellement
 * une version minimale (`EXTENSION_MIN_VERSION`).
 */

import HttpError from "../lib/http-error.js";
import { readExtensionVersion } from "../lib/extension-version.js";
import { isExtensionOutdated } from "../services/extension-version.service.js";

export default function extensionClient({ minVersion = "" } = {}) {
  return (req, res, next) => {
    const clientVersion = readExtensionVersion(req);
    req.extensionClientVersion = clientVersion;

    const outdated = isExtensionOutdated(clientVersion, minVersion);
    if (outdated) {
      return next(
        HttpError.upgradeRequired(
          "Votre extension n'est plus à jour. Installez la dernière version depuis le Chrome Web Store pour continuer."
        )
      );
    }

    return next();
  };
}

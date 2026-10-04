/**
 * Configuration de l'extension.
 *
 * URL du carnet : par défaut production. En développement, copiez
 * `config.local.example.js` vers `config.local.js` (gitignored) pour viser
 * localhost. Ne pas inclure `config.local.js` dans le zip Chrome Web Store
 * (`./package.sh` l'exclut).
 *
 * Doit rester cohérent avec `host_permissions` dans `manifest.json`.
 */

const CARNET_BASE_URL =
  (typeof self !== "undefined" && self.__CARNET_BASE_URL__) ||
  "https://carnetdevisites.fr";

/** Sites d'annonces où l'extension sait lire une annonce. */
const CARNET_SUPPORTED_HOSTS =
  /(^|\.)(seloger\.com|bellesdemeures\.com|leboncoin\.fr)$/i;

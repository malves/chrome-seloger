/**
 * Configuration de compilation de l'extension.
 *
 * `CARNET_BASE_URL` est la seule valeur à changer pour viser un autre serveur.
 * Elle doit rester cohérente avec `host_permissions` dans `manifest.json` :
 * sans permission sur cette origine, les appels à l'API sont bloqués.
 */

const CARNET_BASE_URL = "http://localhost:3000";

/** Sites d'annonces où l'extension sait lire une annonce. */
const CARNET_SUPPORTED_HOSTS =
  /(^|\.)(seloger\.com|bellesdemeures\.com|leboncoin\.fr)$/i;

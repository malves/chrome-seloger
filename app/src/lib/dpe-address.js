/**
 * Reconstitution de la voie à partir des champs DPE (BAN + saisie brute).
 *
 * Quand le géocodage BAN ne fournit pas de `numero_voie_ban`, l'adresse BAN
 * n'inclut souvent que le nom de voie. Le numéro saisi par le diagnostiqueur
 * reste en général dans `numero_voie_brut`, sinon en tête de `adresse_brut`
 * (le nom de rue dans `adresse_brut` est souvent mal orthographié).
 */

/** Numéro seul (ex. 12, 12 bis, 4 ter A). */
const CIVIC_NUMBER_ONLY_RE =
  /^(\d+(?:\s*(?:bis|ter|quater|qua?ter))?(?:\s*[A-Za-z])?)$/i;

/** Numéro en tête d'une saisie plus longue (ex. « 118 Rue … »). */
const CIVIC_NUMBER_PREFIX_RE =
  /^\s*(\d+(?:\s*(?:bis|ter|quater|qua?ter))?)/i;

/**
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function extractCivicNumberFromBrut(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const compact = text.match(CIVIC_NUMBER_ONLY_RE);
  if (compact) return compact[1].replace(/\s+/g, " ").trim();
  const prefix = text.match(CIVIC_NUMBER_PREFIX_RE);
  return prefix ? prefix[1].replace(/\s+/g, " ").trim() : null;
}

/**
 * Retire code postal et commune de l'adresse BAN pour isoler la voie.
 *
 * @param {string|null|undefined} ban
 * @param {string|null|undefined} postalCode
 * @param {string|null|undefined} city
 * @returns {string|null}
 */
export function stripLocalityFromBanAddress(ban, postalCode, city) {
  if (!ban) return null;
  let street = String(ban);
  if (postalCode) {
    street = street.replace(new RegExp(`\\s*${postalCode}.*$`), "");
  } else if (city) {
    street = street.replace(new RegExp(`\\s*${city}\\s*$`, "i"), "");
  }
  street = street.replace(/[\s,]+$/, "").trim();
  return street || String(ban).trim();
}

function rawField(record, key) {
  const fromRaw = record?.raw?.[key];
  if (fromRaw !== undefined && fromRaw !== null && String(fromRaw).trim() !== "") {
    return String(fromRaw).trim();
  }
  const top = record?.[key];
  if (top !== undefined && top !== null && String(top).trim() !== "") {
    return String(top).trim();
  }
  return null;
}

/** Numéro de voirie saisi par le diagnostiqueur quand la BAN n'en a pas. */
function civicNumberFromDiagnostician(record) {
  const fromVoieBrut = extractCivicNumberFromBrut(record.raw?.numero_voie_brut);
  if (fromVoieBrut) return fromVoieBrut;
  const adresseBrut =
    record.adresse_brut || record.raw?.adresse_brut || null;
  return extractCivicNumberFromBrut(adresseBrut);
}

function banStreetName(record) {
  const postalCode = record.code_postal_ban || null;
  const city = record.nom_commune_ban || null;
  const fromBan = stripLocalityFromBanAddress(record.adresse_ban, postalCode, city);
  if (fromBan) return fromBan;
  return rawField(record, "nom_rue_ban");
}

/**
 * Ligne de voie affichable (numéro + nom BAN si possible).
 *
 * @param {{ adresse_ban?: string, adresse_brut?: string, code_postal_ban?: string, nom_commune_ban?: string, raw?: object }} record
 * @returns {string|null}
 */
export function dpeStreetLine(record) {
  if (!record) return null;

  const streetName = banStreetName(record);
  if (!streetName) {
    return record.adresse_brut || null;
  }

  if (/^\d/.test(streetName)) {
    return streetName;
  }

  const numeroBan = rawField(record, "numero_voie_ban");
  if (numeroBan) {
    return `${numeroBan} ${streetName}`;
  }

  const fromBrut = civicNumberFromDiagnostician(record);
  if (fromBrut) {
    return `${fromBrut} ${streetName}`;
  }

  return streetName;
}

/**
 * Requête cartographique : voie reconstituée + localité.
 *
 * @param {object} record
 * @returns {string|null}
 */
export function dpeMapsQuery(record) {
  const street = dpeStreetLine(record);
  const postalCode = record.code_postal_ban || null;
  const city = record.nom_commune_ban || null;
  if (street && (postalCode || city)) {
    return [street, postalCode, city].filter(Boolean).join(", ");
  }
  return record.adresse_ban || record.adresse_brut || street || null;
}

/**
 * Clé de regroupement pour plusieurs DPE à la même adresse.
 *
 * @param {object} record
 * @returns {string}
 */
export function dpeAddressKey(record) {
  const street = dpeStreetLine(record);
  if (street) {
    const locality = [record.code_postal_ban, record.nom_commune_ban]
      .filter(Boolean)
      .join(" ");
    const key = [street, locality].filter(Boolean).join(" ");
    if (key.trim()) return key.trim();
  }
  return (
    record.adresse_ban ||
    record.adresse_brut ||
    `${record.code_postal_ban || ""}-${record.numero_dpe}`
  ).trim();
}

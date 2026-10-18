/**
 * Code postal corrigé par l'utilisateur.
 *
 * Dans les villages, l'annonce affiche souvent le code postal de la grande
 * ville voisine. La correction vit dans `listing_overrides` (champ
 * `postal_code`, origine « listing ») et s'applique à la lecture de l'annonce :
 * une ré-importation par l'extension ne l'écrase donc jamais.
 *
 * Sans adresse réelle (saisie ou détectée), la commune corrigée pilote aussi
 * le code INSEE, donc toute la valorisation communale (prix au m², loyer,
 * positionnement du prix). Avec une adresse réelle, c'est elle qui prime.
 */

const INSEE_RE = /^(\d{5}|2[AB]\d{3})$/;

/** Code postal à 5 chiffres, sinon `null`. */
export function normalizePostalCode(value) {
  const digits = String(value ?? "").replace(/\s/g, "");
  return /^\d{5}$/.test(digits) ? digits : null;
}

/** Code INSEE valide (Corse comprise), sinon `null`. */
export function normalizeInseeCode(value) {
  const code = String(value ?? "").trim().toUpperCase();
  return INSEE_RE.test(code) ? code : null;
}

function finiteOrNull(value) {
  const n = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(n) ? n : null;
}

/**
 * Lit l'entrée stockée (objet ou JSON) ; `null` si absente ou incomplète.
 * @returns {{ postal_code: string, insee_code: string, city: string|null,
 *   lat: number|null, lng: number|null, updated_at: string|null }|null}
 */
export function parsePostalOverride(raw) {
  let entry = raw;
  if (typeof raw === "string") {
    try {
      entry = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!entry || typeof entry !== "object") return null;
  const postal = normalizePostalCode(entry.value);
  const insee = normalizeInseeCode(entry.insee_code);
  if (!postal || !insee) return null;
  const lat = finiteOrNull(entry.lat);
  const lng = finiteOrNull(entry.lng);
  return {
    postal_code: postal,
    insee_code: insee,
    city: typeof entry.city === "string" && entry.city.trim() ? entry.city.trim() : null,
    lat: lat != null && lng != null ? lat : null,
    lng: lat != null && lng != null ? lng : null,
    updated_at: typeof entry.updatedAt === "string" ? entry.updatedAt : null,
  };
}

/**
 * Entrée à stocker dans `listing_overrides.data.fields.postal_code`.
 * `lat`/`lng` : centre de la commune, seulement quand le point annoncé est
 * ailleurs (sinon le point de l'annonce, plus précis, est conservé).
 */
export function buildPostalOverrideEntry({ postalCode, commune, relocate, updatedAt }) {
  return {
    value: postalCode,
    source: "user",
    origin: "listing",
    confirmed: true,
    updatedAt,
    insee_code: commune.insee_code,
    city: commune.name || null,
    lat: relocate ? commune.lat ?? null : null,
    lng: relocate ? commune.lng ?? null : null,
  };
}

/**
 * Applique la correction à une annonce hydratée (mutation en place).
 * Les valeurs de l'annonce restent lisibles dans `listing.announced_location`.
 */
export function applyPostalOverride(listing, override) {
  if (!listing) return listing;
  listing.postal_override = override || null;
  if (!override) {
    listing.announced_location = null;
    return listing;
  }

  listing.announced_location = {
    city: listing.city ?? null,
    postal_code: listing.postal_code ?? null,
    insee_code: listing.insee_code ?? null,
    lat: listing.lat ?? null,
    lng: listing.lng ?? null,
  };
  listing.postal_code = override.postal_code;
  if (override.city) listing.city = override.city;

  const hasUserAddress = Boolean(listing.user_address && String(listing.user_address).trim());
  if (!hasUserAddress) {
    listing.insee_code = override.insee_code;
    if (override.lat != null && override.lng != null) {
      listing.lat = override.lat;
      listing.lng = override.lng;
    }
  }
  return listing;
}

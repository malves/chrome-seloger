/**
 * Critères extraits d'une annonce pour rechercher le bien dans la base DPE.
 */

/** Département à partir d'un code postal français (5 chiffres). */
export function departmentFromPostalCode(postalCode) {
  const raw = String(postalCode ?? "").trim();
  if (!/^\d{5}$/.test(raw)) return null;
  if (raw.startsWith("97") || raw.startsWith("98")) return raw.slice(0, 3);
  if (raw.startsWith("20")) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return "20";
    return n < 20200 ? "2A" : "2B";
  }
  return raw.slice(0, 2);
}

function normalizeLabel(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim().toUpperCase();
  return text || null;
}

function normalizeSurface(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeYear(value) {
  if (value == null || value === "") return null;
  const year = Number.parseInt(String(value), 10);
  return Number.isFinite(year) && year >= 1000 && year <= 2100 ? year : null;
}

/** Numéro d'étage (0 = rez-de-chaussée, négatif = sous-sol). */
function normalizeFloor(value) {
  if (value == null || value === "") return null;
  const floor = Number.parseInt(String(value), 10);
  if (!Number.isFinite(floor) || floor < -10 || floor > 200) return null;
  return floor;
}

/** Type de bien annonce (`listings.property_type`) normalisé. */
function normalizePropertyType(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim().toLowerCase();
  return text || null;
}

/**
 * Traduction vers `type_batiment` ADEME (filtre base DPE).
 * @returns {"maison"|"appartement"|null}
 */
export function propertyTypeToDpeBuildingType(propertyType) {
  const type = normalizePropertyType(propertyType);
  if (type === "apartment") return "appartement";
  if (type === "house") return "maison";
  return null;
}

/**
 * Liste des `type_batiment` ADEME à interroger pour une annonce.
 * Un appartement peut relever d'un DPE « appartement » ou d'un DPE collectif
 * « immeuble » : on cherche donc sur les deux.
 * @returns {string[]}
 */
export function dpeBuildingTypesFor(propertyType) {
  const type = normalizePropertyType(propertyType);
  if (type === "apartment") return ["appartement", "immeuble"];
  if (type === "house") return ["maison"];
  return [];
}

/**
 * @param {object} listing — ligne annonce (SQLite)
 * @returns {object} payload sérialisable pour le client / logs
 */
export function listingDpeSearchCriteria(listing) {
  const codePostal = listing.postal_code
    ? String(listing.postal_code).trim()
    : null;
  const dpe = normalizeLabel(listing.dpe);
  const ges = normalizeLabel(listing.ges);
  const surfaceM2 = normalizeSurface(listing.surface);
  const anneeConstruction = normalizeYear(listing.year_built);
  const etage = normalizeFloor(listing.floor);
  const typeBien = normalizePropertyType(listing.property_type);
  const typeBatiment = propertyTypeToDpeBuildingType(typeBien);

  const criteres = {
    codePostal,
    departement: departmentFromPostalCode(codePostal),
    typeBien,
    typeBatiment,
    dpe,
    ges,
    surfaceM2,
    anneeConstruction,
    etage,
  };

  const missing = [];
  for (const [key, val] of Object.entries(criteres)) {
    if (val == null) missing.push(key);
  }

  const filtresRechercheDpe = {
    code_postal: codePostal,
    type_batiment: typeBatiment,
    etiquette: dpe,
    etiquette_ges: ges,
    surface_min: surfaceM2,
    surface_max: surfaceM2,
    annee_min: anneeConstruction,
    annee_max: anneeConstruction,
    /** Champ DPE open data (`numero_etage_appartement`) — filtre admin à brancher. */
    numero_etage_appartement: etage,
  };

  return {
    listingId: listing.id ?? null,
    criteres,
    filtresRechercheDpe,
    champsManquants: missing,
  };
}

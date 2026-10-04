/**
 * Lecture des fichiers geo-dvf (Etalab) : CSV séparé par des virgules,
 * décimales au point, une ligne par local/parcelle d'une mutation.
 *
 * Colonnes utiles (en-tête geo-dvf) : id_mutation, date_mutation,
 * nature_mutation, valeur_fonciere, code_commune, code_departement,
 * type_local, surface_reelle_bati, longitude, latitude.
 *
 * Une « mutation » (vente) regroupe plusieurs lignes contiguës partageant le
 * même `id_mutation`. La valeur foncière est répétée à l'identique sur chaque
 * ligne : on ne peut l'attribuer à un bien que si la mutation ne contient
 * qu'un seul bâti (une maison OU un appartement), sans autre local (commercial,
 * industriel…). Les dépendances et le terrain sont tolérés.
 */

/** Libellés DVF `type_local` → clés internes stables. */
export const DVF_TYPE_KEYS = {
  Maison: "house",
  Appartement: "apartment",
};

/** Locaux « bâti » qui, s'ils accompagnent le bien, rendent le prix ambigu. */
const AMBIGUOUS_LOCALS = new Set([
  "Local industriel. commercial ou assimilé",
]);

/** Bornes de plausibilité du prix au m² (hors bornes = aberration écartée). */
export const DEFAULT_MIN_PRICE_M2 = 200;
export const DEFAULT_MAX_PRICE_M2 = 25_000;

/** Parse une ligne CSV geo-dvf (`,`, champs éventuellement entre guillemets). */
export function parseDvfCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function parseNumber(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function normalizeInsee(code) {
  const c = String(code ?? "").trim();
  if (!c) return null;
  if (/^\d+$/.test(c)) return c.padStart(5, "0");
  return c;
}

function normalizeDept(code) {
  const c = String(code ?? "").trim();
  if (!c) return null;
  if (/^\d+$/.test(c)) return c.padStart(2, "0");
  return c;
}

/** Index des colonnes à partir de la ligne d'en-tête geo-dvf. */
export function dvfHeaderIndex(headerCols) {
  const map = {};
  for (let i = 0; i < headerCols.length; i++) {
    const name = headerCols[i].trim().replace(/^"|"$/g, "");
    map[name] = i;
  }
  const required = [
    "id_mutation",
    "date_mutation",
    "nature_mutation",
    "valeur_fonciere",
    "code_commune",
    "type_local",
    "surface_reelle_bati",
  ];
  for (const col of required) {
    if (map[col] === undefined) {
      throw new Error(`Colonne « ${col} » manquante dans le fichier geo-dvf.`);
    }
  }
  return {
    id_mutation: map.id_mutation,
    date_mutation: map.date_mutation,
    nature_mutation: map.nature_mutation,
    valeur_fonciere: map.valeur_fonciere,
    code_commune: map.code_commune,
    code_departement: map.code_departement,
    type_local: map.type_local,
    surface_reelle_bati: map.surface_reelle_bati,
    longitude: map.longitude,
    latitude: map.latitude,
  };
}

/** Extrait les champs utiles d'une ligne brute (sans validation métier). */
export function parseDvfRow(cols, h) {
  const id = String(cols[h.id_mutation] ?? "").trim();
  if (!id) return null;
  const date = String(cols[h.date_mutation] ?? "").trim();
  const year = /^(\d{4})/.test(date) ? Number.parseInt(date.slice(0, 4), 10) : null;
  return {
    id_mutation: id,
    year,
    nature: String(cols[h.nature_mutation] ?? "").trim(),
    valeur_fonciere: parseNumber(cols[h.valeur_fonciere]),
    insee_code: normalizeInsee(cols[h.code_commune]),
    dept_code:
      h.code_departement !== undefined
        ? normalizeDept(cols[h.code_departement])
        : null,
    type_local: String(cols[h.type_local] ?? "").trim(),
    surface_reelle_bati: parseNumber(cols[h.surface_reelle_bati]),
    lat: h.latitude !== undefined ? parseNumber(cols[h.latitude]) : null,
    lng: h.longitude !== undefined ? parseNumber(cols[h.longitude]) : null,
  };
}

/**
 * Transforme un groupe de lignes partageant le même `id_mutation` en un
 * enregistrement exploitable, ou `null` si la mutation est ignorée.
 *
 * Règles :
 *  - nature « Vente » (ou VEFA) uniquement ;
 *  - exactement un bâti maison/appartement, sans local commercial/industriel ;
 *  - valeur foncière et surface strictement positives ;
 *  - prix au m² dans les bornes de plausibilité.
 */
export function buildMutation(rows, options = {}) {
  const minPriceM2 = options.minPriceM2 ?? DEFAULT_MIN_PRICE_M2;
  const maxPriceM2 = options.maxPriceM2 ?? DEFAULT_MAX_PRICE_M2;
  if (!rows?.length) return null;

  const nature = rows[0].nature;
  if (!/^Vente/i.test(nature)) return null;

  // Un seul bâti d'habitation, pas de local ambigu dans la même mutation.
  const dwellings = rows.filter((r) => DVF_TYPE_KEYS[r.type_local]);
  if (dwellings.length !== 1) return null;
  if (rows.some((r) => AMBIGUOUS_LOCALS.has(r.type_local))) return null;

  const dwelling = dwellings[0];
  const price = rows[0].valeur_fonciere;
  const surface = dwelling.surface_reelle_bati;
  if (!price || price <= 0 || !surface || surface <= 0) return null;

  const pricePerM2 = price / surface;
  if (pricePerM2 < minPriceM2 || pricePerM2 > maxPriceM2) return null;

  if (!dwelling.insee_code || !dwelling.year) return null;

  // Coordonnées : celles du bâti, sinon n'importe quelle ligne de la mutation.
  const withCoords = dwelling.lat != null && dwelling.lng != null
    ? dwelling
    : rows.find((r) => r.lat != null && r.lng != null) || dwelling;

  return {
    insee_code: dwelling.insee_code,
    dept_code: dwelling.dept_code,
    year: dwelling.year,
    type_local: DVF_TYPE_KEYS[dwelling.type_local],
    price: Math.round(price),
    surface,
    price_per_m2: Math.round(pricePerM2 * 100) / 100,
    lat: withCoords.lat ?? null,
    lng: withCoords.lng ?? null,
  };
}

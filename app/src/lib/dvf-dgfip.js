/**
 * Lecture du fichier brut « Demandes de valeurs foncières » de la DGFiP
 * (data.gouv), utilisé quand Etalab n'a pas encore publié l'année en geo-dvf :
 * séparateur `|`, décimales à la virgule, dates JJ/MM/AAAA, sans identifiant
 * de mutation ni coordonnées.
 *
 * Les lignes d'une même mutation se suivent : on les regroupe par clé
 * (disposition, date, valeur, département), puis on réutilise `buildMutation`.
 * Les coordonnées viennent ensuite du géocodage par lot de la Base Adresse
 * Nationale (`banGeocodeCsv` / `parseBanGeocodeCsv`).
 */

import { parseDvfCsvLine } from "./dvf-csv.js";

const DGFIP_COLUMNS = {
  disposition: "No disposition",
  date_mutation: "Date mutation",
  nature_mutation: "Nature mutation",
  valeur_fonciere: "Valeur fonciere",
  no_voie: "No voie",
  btq: "B/T/Q",
  type_voie: "Type de voie",
  voie: "Voie",
  code_departement: "Code departement",
  code_commune: "Code commune",
  type_local: "Type local",
  surface_reelle_bati: "Surface reelle bati",
};

/** Types BAN assez précis pour situer une vente dans un rayon de quelques centaines de mètres. */
const BAN_PRECISE_TYPES = new Set(["housenumber", "street"]);

export function parseDgfipLine(line) {
  return line.split("|");
}

/** Index des colonnes utiles à partir de l'en-tête DGFiP. */
export function dgfipHeaderIndex(headerCols) {
  const map = new Map(headerCols.map((name, i) => [name.trim(), i]));
  const index = {};
  for (const [key, label] of Object.entries(DGFIP_COLUMNS)) {
    if (!map.has(label)) {
      throw new Error(`Colonne « ${label} » manquante dans le fichier DGFiP.`);
    }
    index[key] = map.get(label);
  }
  return index;
}

/** `01` + `244` → `01244` ; `971` + `101` → `97101` ; `2A` + `4` → `2A004`. */
export function dgfipInseeCode(dept, commune) {
  const d = String(dept ?? "").trim();
  const c = String(commune ?? "").trim();
  if (!d || !c) return null;
  if (d.length === 3) return d.slice(0, 2) + c.padStart(3, "0");
  return d.padStart(2, "0") + c.padStart(3, "0");
}

function normalizeDept(code) {
  const d = String(code ?? "").trim();
  if (!d) return null;
  return /^\d$/.test(d) ? d.padStart(2, "0") : d;
}

function parseFrenchNumber(value) {
  const raw = String(value ?? "").trim().replace(/\s/g, "").replace(",", ".");
  if (!raw) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/** `08/01/2026` → `2026-01-08`. */
export function dgfipIsoDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value ?? "").trim());
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

/** Ligne d'adresse géocodable : « 27 B RUE DE GENEVE ». */
export function dgfipStreetLine(cols, h) {
  const number = String(cols[h.no_voie] ?? "").trim().replace(/^0+(?=\d)/, "");
  const parts = [
    number,
    String(cols[h.btq] ?? "").trim(),
    String(cols[h.type_voie] ?? "").trim(),
    String(cols[h.voie] ?? "").trim(),
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

/**
 * Extrait les champs d'une ligne DGFiP au format attendu par `buildMutation`,
 * plus la clé de regroupement et l'adresse à géocoder.
 */
export function parseDgfipRow(cols, h) {
  const date = dgfipIsoDate(cols[h.date_mutation]);
  if (!date) return null;
  const dept = normalizeDept(cols[h.code_departement]);
  const rawValue = String(cols[h.valeur_fonciere] ?? "").trim();
  return {
    mutation_key: [
      String(cols[h.disposition] ?? "").trim(),
      date,
      rawValue,
      dept,
    ].join("|"),
    year: Number.parseInt(date.slice(0, 4), 10),
    date,
    nature: String(cols[h.nature_mutation] ?? "").trim(),
    valeur_fonciere: parseFrenchNumber(rawValue),
    insee_code: dgfipInseeCode(dept, cols[h.code_commune]),
    dept_code: dept,
    type_local: String(cols[h.type_local] ?? "").trim(),
    surface_reelle_bati: parseFrenchNumber(cols[h.surface_reelle_bati]),
    lat: null,
    lng: null,
    address: dgfipStreetLine(cols, h),
  };
}

/**
 * Ressource DGFiP d'une année dans le jeu data.gouv « demandes-de-valeurs-foncieres ».
 * Titres attendus : « Valeurs foncières 2025 », « Valeurs foncières 2026 - Premier semestre ».
 * @returns {{ url: string, title: string, partial: boolean } | null}
 */
export function pickDgfipResource(resources, year) {
  const pattern = new RegExp(
    `^Valeurs fonci[eè]res ${year}(?:\\s*-\\s*(Premier|Second) semestre)?$`,
    "i"
  );
  for (const resource of resources || []) {
    const title = String(resource?.title || "").trim();
    const match = pattern.exec(title);
    if (match && resource.url) {
      return {
        url: resource.url,
        title,
        partial: /premier/i.test(match[1] || ""),
      };
    }
  }
  return null;
}

function csvField(value) {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Corps CSV pour `POST /search/csv` de la Base Adresse Nationale.
 * @param {{ id: string, address: string, citycode: string }[]} items
 */
export function banGeocodeCsv(items) {
  const lines = ["id,adresse,citycode"];
  for (const item of items) {
    lines.push([item.id, item.address, item.citycode].map(csvField).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Lit la réponse CSV du géocodage BAN et garde les résultats assez fiables.
 * @returns {Map<string, { lat: number, lng: number }>}
 */
export function parseBanGeocodeCsv(text, { minScore = 0.5 } = {}) {
  const out = new Map();
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return out;

  const header = parseDvfCsvLine(lines[0].replace(/^\uFEFF/, ""));
  const col = Object.fromEntries(header.map((name, i) => [name.trim(), i]));
  if (col.id === undefined || col.latitude === undefined || col.longitude === undefined) {
    throw new Error("Réponse du géocodage BAN inattendue (colonnes manquantes).");
  }

  for (const line of lines.slice(1)) {
    const cols = parseDvfCsvLine(line);
    const status = col.result_status !== undefined ? cols[col.result_status] : "ok";
    if (status && status !== "ok") continue;
    const type = cols[col.result_type];
    if (!BAN_PRECISE_TYPES.has(type)) continue;
    const score = Number.parseFloat(cols[col.result_score]);
    if (!Number.isFinite(score) || score < minScore) continue;
    const lat = Number.parseFloat(cols[col.latitude]);
    const lng = Number.parseFloat(cols[col.longitude]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    out.set(cols[col.id], { lat, lng });
  }
  return out;
}

/** `[2021, 2022, 2023, 2025]` → `2021–2023, 2025`. */
export function formatYearRanges(years) {
  const sorted = [...new Set(years)].sort((a, b) => a - b);
  const ranges = [];
  for (const year of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && year === last[1] + 1) last[1] = year;
    else ranges.push([year, year]);
  }
  return ranges
    .map(([from, to]) => (from === to ? String(from) : `${from}–${to}`))
    .join(", ");
}

/**
 * Libellé des sources réellement importées, stocké sur le job.
 * @param {{ geoDvfYears: number[], dgfip: { year: number, partial: boolean, imported: number, geocoded: number }[], skippedYears: number[] }} summary
 */
export function dvfSourceSummary({ geoDvfYears = [], dgfip = [], skippedYears = [] }) {
  const parts = [];
  if (geoDvfYears.length) parts.push(`geo-dvf ${formatYearRanges(geoDvfYears)}`);
  for (const item of dgfip) {
    const period = item.partial ? `${item.year} S1` : String(item.year);
    parts.push(
      `DGFiP ${period} (${item.geocoded.toLocaleString("fr-FR")} ventes géocodées sur ${item.imported.toLocaleString("fr-FR")})`
    );
  }
  if (skippedYears.length) parts.push(`non publiées : ${formatYearRanges(skippedYears)}`);
  return parts.join(" · ") || "aucune année disponible";
}

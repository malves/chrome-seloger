/**
 * Lecture des fichiers SSMSI (séparateur `;`, décimales françaises, gzip pour COM).
 *
 * Colonnes communales (juillet 2026) : CODGEO_2026, annee, indicateur, nombre,
 * taux_pour_mille, est_diffuse, …
 * Colonnes départementales : Code_departement, annee, indicateur, nombre, taux_pour_mille
 */

/** Libellés SSMSI → clés internes stables (affichage / requêtes). */
export const SSMSI_INDICATOR_KEYS = {
  "Violences physiques intrafamiliales": "violences_physiques_intrafamiliales",
  "Violences physiques hors cadre familial": "violences_physiques_hors_famille",
  "Violences sexuelles": "violences_sexuelles",
  "Vols avec armes": "vols_avec_armes",
  "Vols violents sans arme": "vols_violents_sans_arme",
  "Vols sans violence contre des personnes": "vols_sans_violence_personnes",
  "Homicides": "homicides",
  "Tentatives d'homicide": "tentatives_homicide",
  "Trafic de stupéfiants": "trafic_stupefiants",
  "Usage de stupéfiants": "usage_stupefiants",
  "Cambriolages de logement": "cambriolages_logement",
  "Destructions et dégradations volontaires": "degradations_volontaires",
  "Vols dans les véhicules": "vols_dans_vehicules",
  "Vols de véhicule": "vols_vehicule",
  "Vols d'accessoires sur véhicules": "vols_accessoires_vehicules",
  "Escroqueries et fraudes aux moyens de paiement": "escroqueries_fraudes_paiement",
};

/** Groupe d'affichage et de score composite. */
export const SSMSI_INDICATOR_GROUP = {
  violences_physiques_intrafamiliales: "personnes",
  violences_physiques_hors_famille: "personnes",
  violences_sexuelles: "personnes",
  vols_avec_armes: "personnes",
  vols_violents_sans_arme: "personnes",
  vols_sans_violence_personnes: "personnes",
  homicides: "personnes",
  tentatives_homicide: "personnes",
  trafic_stupefiants: "personnes",
  usage_stupefiants: "personnes",
  cambriolages_logement: "biens",
  degradations_volontaires: "biens",
  vols_dans_vehicules: "biens",
  vols_vehicule: "biens",
  vols_accessoires_vehicules: "biens",
  escroqueries_fraudes_paiement: "biens",
};

/** Ordre d'affichage (personnes puis biens). */
export const SSMSI_INDICATOR_ORDER = Object.keys(SSMSI_INDICATOR_GROUP);

/** Libellés d'affichage (plus courts/lisibles) par clé interne. */
export const SSMSI_INDICATOR_DISPLAY_LABELS = {
  violences_physiques_intrafamiliales: "Violences physiques intrafamiliales",
  violences_physiques_hors_famille: "Violences physiques hors cadre familial",
  degradations_volontaires: "Dégradations volontaires",
  vols_accessoires_vehicules: "Vols d'accessoires sur véhicules",
  usage_stupefiants: "Usage de stupéfiants",
};

export const SSMSI_INDICATOR_LIST = SSMSI_INDICATOR_ORDER.map((key) => {
  const label =
    Object.entries(SSMSI_INDICATOR_KEYS).find(([, k]) => k === key)?.[0] || key;
  return {
    key,
    label: SSMSI_INDICATOR_DISPLAY_LABELS[key] || label,
    group: SSMSI_INDICATOR_GROUP[key],
  };
});

/** Ordre de grandeur d'un import communal complet (tous indicateurs). */
export const SSMSI_EXPECTED_COMMUNE_ROWS = 2_100_000;

const INDICATOR_SET = new Set(Object.keys(SSMSI_INDICATOR_KEYS));

/** Parse une ligne CSV SSMSI (`;`, champs entre guillemets). */
export function parseSsmsiCsvLine(line) {
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
    } else if (c === ";") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function parseFrenchNumber(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.toUpperCase() === "NA") return null;
  const n = Number.parseFloat(raw.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function parseInteger(value) {
  const n = parseFrenchNumber(value);
  if (n === null) return null;
  const i = Math.round(n);
  return Number.isFinite(i) ? i : null;
}

function normalizeInsee(code) {
  const c = String(code ?? "").trim().replace(/^"|"$/g, "");
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

/**
 * Transforme une ligne communale en enregistrement normalisé, ou null si ignorée.
 * @param {string[]} cols
 * @param {Record<string, number>} headerIndex
 */
export function parseCommuneRow(cols, headerIndex) {
  const label = cols[headerIndex.indicateur]?.trim();
  if (!label || !INDICATOR_SET.has(label)) return null;

  const diffuse = cols[headerIndex.est_diffuse]?.trim().toLowerCase();
  if (diffuse && diffuse !== "diff") return null;

  const insee = normalizeInsee(cols[headerIndex.codgeo]);
  const year = parseInteger(cols[headerIndex.annee]);
  if (!insee || !year) return null;

  return {
    insee_code: insee,
    year,
    indicator: SSMSI_INDICATOR_KEYS[label],
    label,
    volume: parseInteger(cols[headerIndex.nombre]),
    rate_per_1000: parseFrenchNumber(cols[headerIndex.taux_pour_mille]),
  };
}

/** Ligne départementale → enregistrement ou null. */
export function parseDepartmentRow(cols, headerIndex) {
  const label = cols[headerIndex.indicateur]?.trim();
  if (!label || !INDICATOR_SET.has(label)) return null;

  const dept = normalizeDept(cols[headerIndex.dept]);
  const year = parseInteger(cols[headerIndex.annee]);
  if (!dept || !year) return null;

  return {
    dept_code: dept,
    year,
    indicator: SSMSI_INDICATOR_KEYS[label],
    label,
    volume: parseInteger(cols[headerIndex.nombre]),
    rate_per_1000: parseFrenchNumber(cols[headerIndex.taux_pour_mille]),
    population:
      headerIndex.insee_pop !== undefined
        ? parseInteger(cols[headerIndex.insee_pop])
        : null,
  };
}

/** Index des colonnes à partir de la ligne d'en-tête communale. */
export function communeHeaderIndex(headerCols) {
  const map = {};
  for (let i = 0; i < headerCols.length; i++) {
    const name = headerCols[i].trim().replace(/^"|"$/g, "");
    map[name] = i;
  }
  const codgeo =
    map.CODGEO_2026 ?? map.CODGEO_2025 ?? map.CODGEO_2024 ?? map.CODGEO;
  if (codgeo === undefined) {
    throw new Error("Colonne CODGEO manquante dans le fichier SSMSI communal.");
  }
  return {
    codgeo,
    annee: map.annee,
    indicateur: map.indicateur,
    nombre: map.nombre,
    taux_pour_mille: map.taux_pour_mille,
    est_diffuse: map.est_diffuse,
  };
}

export function departmentHeaderIndex(headerCols) {
  const map = {};
  for (let i = 0; i < headerCols.length; i++) {
    const name = headerCols[i].trim().replace(/^"|"$/g, "");
    map[name] = i;
  }
  const dept = map.Code_departement ?? map.code_departement;
  if (dept === undefined) {
    throw new Error("Colonne Code_departement manquante dans le fichier SSMSI départemental.");
  }
  return {
    dept,
    annee: map.annee,
    indicateur: map.indicateur,
    nombre: map.nombre,
    taux_pour_mille: map.taux_pour_mille,
    insee_pop: map.insee_pop,
  };
}

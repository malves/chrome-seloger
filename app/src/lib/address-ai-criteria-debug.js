/**
 * Correspondance critères annonce ↔ colonnes DPE (debug console « Déterminer l'adresse »).
 */

/** @typedef {"filtre"|"score"|"meta"} AddressAiCriterionUsage */

/**
 * @typedef {object} AddressAiCriterionSpec
 * @property {string} label — libellé du tableau console (`critere`)
 * @property {string|null} column — colonne DPE / champ open data
 * @property {AddressAiCriterionUsage} usage
 * @property {"precise"|"departement"|null} [territoryFilter] — filtre territorial SQL
 */

export const ADDRESS_AI_CRITERION_SPECS = [
  {
    label: "Code postal",
    column: "code_postal_ban",
    usage: "filtre",
    territoryFilter: "precise",
  },
  {
    label: "Département",
    column: "code_departement_ban",
    usage: "filtre",
    territoryFilter: "departement",
  },
  {
    label: "Type (annonce)",
    column: null,
    usage: "meta",
  },
  {
    label: "Type bâtiment",
    column: "type_batiment",
    usage: "filtre",
  },
  {
    label: "Type DPE",
    column: "type_batiment",
    usage: "filtre",
  },
  {
    label: "Surface (m²)",
    column: "surface_habitable_logement",
    usage: "filtre",
  },
  { label: "DPE", column: "etiquette_dpe", usage: "score" },
  { label: "GES", column: "etiquette_ges", usage: "score" },
  {
    label: "Conso (kWhEP/m².an)",
    column: "conso_5_usages_par_m2_ep",
    usage: "score",
  },
  {
    label: "Émissions (kg CO₂/m².an)",
    column: "emission_ges_5_usages_par_m2",
    usage: "score",
  },
  {
    label: "Étage",
    column: "numero_etage_appartement, complement_adresse_logement",
    usage: "score",
  },
  {
    label: "Année",
    column: "annee_construction, periode_construction",
    usage: "score",
  },
  {
    label: "Énergie chauffage",
    column: "type_energie_principale_chauffage, type_energie_n1",
    usage: "score",
  },
];

const SPEC_BY_LABEL = new Map(
  ADDRESS_AI_CRITERION_SPECS.map((spec) => [spec.label, spec])
);

/**
 * Libellé de la colonne DPE pour une ligne du tableau de debug.
 * @param {string} critereLabel
 * @param {{ mode?: string, usage?: AddressAiCriterionUsage }} [options]
 * @returns {string}
 */
export function dpeChampForCritere(critereLabel, { mode, usage } = {}) {
  const spec = SPEC_BY_LABEL.get(critereLabel);
  if (!spec) return "—";
  if (usage && spec.usage !== usage) return "—";

  if (spec.label === "Type (annonce)") {
    return "— (converti en type_batiment)";
  }

  if (!spec.column) return "—";

  if (
    spec.territoryFilter &&
    mode &&
    spec.territoryFilter !== mode
  ) {
    return `${spec.column} (non utilisé en ${mode})`;
  }

  if (spec.usage === "filtre") {
    if (spec.label === "Surface (m²)") {
      return `${spec.column} (filtre SQL ±3 %, immeuble toléré)`;
    }
    return `${spec.column} (filtre SQL)`;
  }

  if (spec.usage === "score") {
    return `${spec.column} (score après requête)`;
  }

  return spec.column;
}

/**
 * Métadonnées d'une requête DPE pour le tableau « recherches » (console).
 * @param {object} args
 * @returns {object}
 */
export function addressAiRechercheMeta({
  mode,
  criteria,
  typeBatiments,
  surfaceMin,
  surfaceMax,
  recordsCount,
  candidatesCount,
  utilise = true,
}) {
  const territoryField =
    mode === "departement" ? "code_departement_ban" : "code_postal_ban";
  const territoryValue =
    mode === "departement" ? criteria.departement : criteria.codePostal;

  return {
    mode,
    utilise,
    champ_territoire: territoryField,
    territoire: territoryValue ?? null,
    champ_type: "type_batiment",
    types: typeBatiments,
    champ_surface: "surface_habitable_logement",
    surface_min: surfaceMin,
    surface_max: surfaceMax,
    lignes_dpe: recordsCount,
    adresses_candidates: candidatesCount,
  };
}

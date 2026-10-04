/**
 * Présentation structurée d'un enregistrement DPE pour la modale admin.
 */

const INTERNAL_KEYS = new Set(["_id", "_i", "_rand", "_score", "_geopoint"]);

const SECTIONS = [
  {
    id: "identity",
    title: "Identité du diagnostic",
    fields: [
      {
        key: "numero_dpe",
        label: "N° DPE",
        help: "Identifiant unique du diagnostic, délivré par l'ADEME.",
      },
      {
        key: "date_etablissement_dpe",
        label: "Date d'établissement",
        help: "Date à laquelle le diagnostiqueur a finalisé le DPE.",
      },
      {
        key: "date_fin_validite_dpe",
        label: "Fin de validité",
        help: "Un DPE est en principe valable 10 ans à partir de cette date.",
      },
      {
        key: "date_reception_dpe",
        label: "Date de réception ADEME",
      },
      {
        key: "date_visite_diagnostiqueur",
        label: "Date de visite sur site",
      },
      {
        key: "date_derniere_modification_dpe",
        label: "Dernière modification",
      },
      {
        key: "methode_application_dpe",
        label: "Méthode d'application",
        help: "Cadre du diagnostic : appartement, maison individuelle, immeuble collectif, etc.",
      },
      {
        key: "modele_dpe",
        label: "Modèle de calcul",
        help: "Référentiel réglementaire utilisé (ex. DPE 3CL 2021).",
      },
      {
        key: "version_dpe",
        label: "Version du DPE",
        kind: "number",
      },
    ],
  },
  {
    id: "location",
    title: "Localisation",
    fields: [
      { key: "adresse_ban", label: "Adresse (Base Adresse Nationale)" },
      { key: "adresse_brut", label: "Adresse saisie (brut)" },
      { key: "adresse_complete_brut", label: "Adresse complète (brut)" },
      { key: "nom_commune_ban", label: "Commune" },
      { key: "nom_commune_brut", label: "Commune (brut)" },
      { key: "code_postal_ban", label: "Code postal" },
      { key: "code_postal_brut", label: "Code postal (brut)" },
      { key: "code_insee_ban", label: "Code INSEE" },
      { key: "code_departement_ban", label: "Département" },
      { key: "code_region_ban", label: "Région" },
      {
        key: "statut_geocodage",
        label: "Statut de géocodage",
        help: "Indique si l'adresse a pu être localisée dans la Base Adresse Nationale.",
      },
      { key: "identifiant_ban", label: "Identifiant BAN" },
      {
        key: "score_ban",
        label: "Score BAN",
        kind: "decimal",
        help: "Indice de confiance du géocodage (plus proche de 1 = plus fiable).",
      },
    ],
  },
  {
    id: "building",
    title: "Bâtiment",
    fields: [
      { key: "type_batiment", label: "Type de bâtiment" },
      {
        key: "annee_construction",
        label: "Année de construction",
        kind: "number",
      },
      { key: "periode_construction", label: "Période de construction" },
      {
        key: "surface_habitable_logement",
        label: "Surface habitable (logement)",
        kind: "surface",
      },
      {
        key: "surface_habitable_immeuble",
        label: "Surface habitable (immeuble)",
        kind: "surface",
      },
      {
        key: "nombre_niveau_immeuble",
        label: "Nombre de niveaux",
        kind: "number",
      },
      {
        key: "nombre_appartement",
        label: "Nombre d'appartements",
        kind: "number",
      },
      {
        key: "numero_etage_appartement",
        label: "Étage de l'appartement",
        kind: "number",
      },
      {
        key: "hauteur_sous_plafond",
        label: "Hauteur sous plafond",
        kind: "decimal",
        unit: " m",
      },
      {
        key: "classe_inertie_batiment",
        label: "Inertie du bâtiment",
        help: "Capacité du bâtiment à lisser les variations de température.",
      },
      { key: "zone_climatique", label: "Zone climatique" },
      { key: "classe_altitude", label: "Classe d'altitude" },
    ],
  },
  {
    id: "performance",
    title: "Performance énergétique",
    fields: [
      {
        key: "etiquette_dpe",
        label: "Étiquette DPE",
        kind: "etiquette",
        help: "Classe énergétique : A (très performant) à G (très énergivore).",
      },
      {
        key: "etiquette_ges",
        label: "Étiquette GES",
        kind: "etiquette",
        help: "Émissions de gaz à effet de serre liées à l'usage du logement.",
      },
      {
        key: "conso_5_usages_ep",
        label: "Consommation totale (énergie primaire)",
        kind: "decimal",
        unit: " kWh EP/an",
        help: "Chauffage, eau chaude, refroidissement, éclairage et auxiliaires, en énergie primaire.",
      },
      {
        key: "conso_5_usages_ef",
        label: "Consommation totale (énergie finale)",
        kind: "decimal",
        unit: " kWh EF/an",
      },
      {
        key: "conso_5_usages_par_m2_ep",
        label: "Consommation au m² (EP)",
        kind: "decimal",
        unit: " kWh EP/m²/an",
      },
      {
        key: "conso_5_usages_par_m2_ef",
        label: "Consommation au m² (EF)",
        kind: "decimal",
        unit: " kWh EF/m²/an",
      },
      {
        key: "emission_ges_5_usages",
        label: "Émissions GES totales",
        kind: "decimal",
        unit: " kg CO₂/an",
      },
      {
        key: "emission_ges_5_usages_par_m2",
        label: "Émissions GES au m²",
        kind: "decimal",
        unit: " kg CO₂/m²/an",
      },
      {
        key: "ubat_w_par_m2_k",
        label: "Ubât",
        kind: "decimal",
        unit: " W/m²·K",
        help: "Déperditions surfaciques du bâtiment : plus la valeur est basse, mieux l'enveloppe isole.",
      },
      {
        key: "besoin_chauffage",
        label: "Besoin de chauffage",
        kind: "decimal",
        unit: " kWh/an",
      },
      {
        key: "besoin_ecs",
        label: "Besoin d'eau chaude sanitaire",
        kind: "decimal",
        unit: " kWh/an",
      },
    ],
  },
  {
    id: "envelope",
    title: "Enveloppe et déperditions",
    fields: [
      {
        key: "qualite_isolation_enveloppe",
        label: "Isolation de l'enveloppe",
      },
      { key: "qualite_isolation_murs", label: "Isolation des murs" },
      {
        key: "qualite_isolation_menuiseries",
        label: "Isolation des menuiseries",
      },
      {
        key: "qualite_isolation_plancher_bas",
        label: "Isolation du plancher bas",
      },
      {
        key: "qualite_isolation_plancher_haut_comble_perdu",
        label: "Isolation du combles perdus",
      },
      {
        key: "deperditions_enveloppe",
        label: "Déperditions totales",
        kind: "decimal",
        unit: " W/K",
      },
      { key: "deperditions_murs", label: "Déperditions murs", kind: "decimal", unit: " W/K" },
      {
        key: "deperditions_baies_vitrees",
        label: "Déperditions vitrages",
        kind: "decimal",
        unit: " W/K",
      },
      {
        key: "deperditions_ponts_thermiques",
        label: "Déperditions ponts thermiques",
        kind: "decimal",
        unit: " W/K",
      },
      {
        key: "deperditions_renouvellement_air",
        label: "Déperditions ventilation",
        kind: "decimal",
        unit: " W/K",
      },
      {
        key: "ventilation_posterieure_2012",
        label: "Ventilation postérieure à 2012",
        help: "1 si un système de ventilation réglementaire récent est pris en compte.",
      },
    ],
  },
  {
    id: "systems",
    title: "Chauffage et eau chaude",
    fields: [
      {
        key: "type_installation_chauffage",
        label: "Chauffage (type global)",
      },
      {
        key: "type_energie_principale_chauffage",
        label: "Énergie principale chauffage",
      },
      {
        key: "type_generateur_chauffage_principal",
        label: "Générateur principal",
      },
      {
        key: "description_installation_chauffage_n1",
        label: "Installation chauffage (descriptif)",
      },
      { key: "type_installation_ecs", label: "ECS (type global)" },
      {
        key: "type_energie_principale_ecs",
        label: "Énergie principale ECS",
      },
      {
        key: "description_installation_ecs_n1",
        label: "Installation ECS (descriptif)",
      },
      {
        key: "conso_chauffage_ef",
        label: "Conso chauffage (EF)",
        kind: "decimal",
        unit: " kWh/an",
      },
      {
        key: "conso_ecs_ef",
        label: "Conso ECS (EF)",
        kind: "decimal",
        unit: " kWh/an",
      },
    ],
  },
  {
    id: "costs",
    title: "Coûts estimés (5 usages)",
    fields: [
      {
        key: "cout_total_5_usages",
        label: "Coût total annuel",
        kind: "euro",
        help: "Estimation des dépenses énergétiques pour l'ensemble des usages.",
      },
      { key: "cout_chauffage", label: "Coût chauffage", kind: "euro" },
      { key: "cout_ecs", label: "Coût eau chaude", kind: "euro" },
      { key: "cout_eclairage", label: "Coût éclairage", kind: "euro" },
      { key: "cout_auxiliaires", label: "Coût auxiliaires", kind: "euro" },
      { key: "cout_refroidissement", label: "Coût refroidissement", kind: "euro" },
    ],
  },
];

function isEmpty(value) {
  return value === null || value === undefined || value === "";
}

function mergeRecord(record) {
  const base = { ...(record.raw || {}) };
  for (const [key, value] of Object.entries(record)) {
    if (key === "raw" || key === "imported_at") continue;
    if (!isEmpty(value)) base[key] = value;
  }
  return base;
}

function formatValue(value, field, fmt) {
  if (isEmpty(value)) return null;

  const kind = field.kind || "text";
  const unit = field.unit || "";

  switch (kind) {
    case "etiquette":
      return { kind: "etiquette", value: String(value).trim() };
    case "surface":
      return { kind: "text", value: fmt.surface(value) };
    case "euro":
      return { kind: "text", value: fmt.euro(value) };
    case "number":
      return { kind: "text", value: fmt.number(value) + unit };
    case "decimal": {
      const n = Number(value);
      if (!Number.isFinite(n)) return { kind: "text", value: String(value) };
      const formatted = new Intl.NumberFormat("fr-FR", {
        maximumFractionDigits: 1,
      }).format(n);
      return { kind: "text", value: formatted + unit };
    }
    default:
      return { kind: "text", value: String(value) };
  }
}

function humanizeKey(key) {
  return key.replace(/_/g, " ");
}

/** Sections et champs prêts pour la vue modale. */
export function buildDetailView(record, fmt) {
  const data = mergeRecord(record);
  const usedKeys = new Set();
  const sections = [];

  for (const section of SECTIONS) {
    const fields = [];
    for (const field of section.fields) {
      const raw = data[field.key];
      if (isEmpty(raw)) continue;
      usedKeys.add(field.key);
      const formatted = formatValue(raw, field, fmt);
      fields.push({
        key: field.key,
        label: field.label,
        help: field.help || null,
        ...formatted,
      });
    }
    if (fields.length) {
      sections.push({ id: section.id, title: section.title, fields });
    }
  }

  const extraFields = Object.keys(data)
    .filter((key) => !usedKeys.has(key) && !INTERNAL_KEYS.has(key))
    .sort((a, b) => a.localeCompare(b, "fr"))
    .map((key) => {
      const formatted = formatValue(data[key], { kind: "text" }, fmt);
      return {
        key,
        label: humanizeKey(key),
        help: null,
        ...formatted,
      };
    })
    .filter((field) => field.value);

  if (extraFields.length) {
    sections.push({
      id: "extra",
      title: "Autres données",
      fields: extraFields,
      help: "Champs additionnels issus de la ligne open data ADEME.",
    });
  }

  const headline = {
    numero: data.numero_dpe || record.numero_dpe || "—",
    date: data.date_etablissement_dpe || record.date_etablissement_dpe || null,
    commune: [data.nom_commune_ban, data.code_postal_ban].filter(Boolean).join(" "),
    adresse: data.adresse_ban || data.adresse_brut || null,
    etiquetteDpe: data.etiquette_dpe || record.etiquette_dpe || null,
    etiquetteGes: data.etiquette_ges || record.etiquette_ges || null,
    importedAt: record.imported_at || null,
  };

  return { headline, sections };
}

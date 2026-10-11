/**
 * Libellés français des vocabulaires de l'analyse photos (affichage).
 */

export const CLASSIFICATION_LABELS = {
  real_interior: "Photo intérieure",
  real_exterior: "Photo extérieure",
  building_exterior: "Immeuble / façade",
  common_area: "Parties communes",
  balcony: "Balcon",
  terrace: "Terrasse",
  garden: "Jardin",
  view: "Vue",
  neighborhood: "Quartier",
  floor_plan: "Plan",
  map: "Carte",
  document: "Document",
  virtual_staging: "Home staging virtuel",
  real_photo_with_virtual_staging: "Photo réelle meublée virtuellement",
  architect_projection: "Projection après travaux",
  ai_generated: "Image générée par IA",
  heavily_retouched: "Photo fortement retouchée",
  decorative_or_marketing: "Image marketing",
  duplicate: "Doublon",
  unknown: "Indéterminée",
};

/** Badge court affiché sur la galerie pour les images non réelles. */
export const GALLERY_BADGES = {
  virtual_staging: "Staging virtuel",
  real_photo_with_virtual_staging: "Meublée virtuellement",
  architect_projection: "Projection",
  ai_generated: "Image IA",
  floor_plan: "Plan",
  duplicate: "Doublon",
};

export const EXCLUSION_LABELS = {
  virtual_or_projection: "Projection ou image virtuelle : exclue de l'état actuel",
  floor_plan: "Plan : n'informe pas sur l'état",
  document: "Document ou carte",
  marketing_image: "Image décorative ou marketing, sans information sur le bien",
  heavily_retouched: "Photo fortement retouchée",
  poor_image_quality: "Qualité insuffisante pour une lecture fiable",
  exterior: "Extérieur ou parties communes : analysés à part",
  duplicate: "Doublon exact d'une autre photo",
  download_failed: "Photo impossible à télécharger",
  no_model_output: "Aucune lecture renvoyée par le modèle",
  batch_failed:
    "Lot vision en échec (timeout, JSON invalide ou erreur API) : aucune fiche pour ce lot",
  missing_from_model_response:
    "Fiche absente dans la réponse (JSON incomplet ou identifiant d'image incorrect)",
  unclassified: "Image non classée",
  not_usable: "Non exploitable pour l'état du logement",
};

export const ROOM_LABELS = {
  living_room: "Séjour",
  dining_room: "Salle à manger",
  living_dining_room: "Séjour / salle à manger",
  kitchen: "Cuisine",
  open_kitchen: "Cuisine ouverte",
  bedroom: "Chambre",
  master_bedroom: "Chambre principale",
  child_bedroom: "Chambre d'enfant",
  office: "Bureau",
  bathroom: "Salle de bain",
  shower_room: "Salle d'eau",
  toilet: "WC",
  entrance: "Entrée",
  hallway: "Couloir",
  dressing: "Dressing",
  laundry: "Buanderie",
  cellar: "Cave",
  garage: "Garage",
  balcony: "Balcon",
  terrace: "Terrasse",
  garden: "Jardin",
  common_area: "Parties communes",
  building_exterior: "Immeuble",
  unknown: "Pièce indéterminée",
};

export const CONDITION_LABELS = {
  new_or_recently_renovated: "Neuf ou récemment rénové",
  very_good: "Très bon état",
  good: "Bon état",
  average: "État moyen",
  dated: "Daté",
  refresh_needed: "Rafraîchissement à prévoir",
  renovation_needed: "Rénovation à prévoir",
  heavy_renovation_likely: "Rénovation lourde probable",
  not_assessable: "Non évaluable",
  poor: "Dégradé",
  unknown: "Non évaluable",
};

/** Tonalité d'affichage (good / average / poor / unknown) par état. */
export const CONDITION_TONES = {
  new_or_recently_renovated: "good",
  very_good: "good",
  good: "good",
  average: "average",
  dated: "average",
  refresh_needed: "average",
  renovation_needed: "poor",
  heavy_renovation_likely: "poor",
  poor: "poor",
  not_assessable: "unknown",
  unknown: "unknown",
};

export const RENOVATION_LEVEL_LABELS = {
  none: "Aucun travaux apparent",
  light_refresh: "Rafraîchissement léger",
  moderate_renovation: "Rénovation modérée probablement nécessaire",
  significant_renovation: "Rénovation importante probable",
  heavy_renovation_possible: "Rénovation lourde possible",
  unknown: "Niveau de travaux non déterminable",
};

export const RENOVATION_LEVEL_TONES = {
  none: "good",
  light_refresh: "good",
  moderate_renovation: "average",
  significant_renovation: "poor",
  heavy_renovation_possible: "poor",
  unknown: "unknown",
};

export const WORK_TYPE_LABELS = {
  painting: "Peinture",
  wallpaper_removal: "Dépose de papier peint",
  floor_replacement: "Remplacement de sol",
  floor_sanding: "Ponçage / vitrification du parquet",
  kitchen_refresh: "Rafraîchissement de la cuisine",
  kitchen_replacement: "Remplacement de la cuisine",
  bathroom_refresh: "Rafraîchissement de la salle de bain",
  bathroom_full_renovation: "Rénovation complète de la salle de bain",
  toilet_renovation: "Rénovation des WC",
  window_replacement: "Remplacement des fenêtres",
  radiator_replacement: "Remplacement des radiateurs",
  visible_electrical_modernization: "Modernisation de l'appareillage électrique visible",
  storage_creation: "Création de rangements",
  ceiling_repair: "Reprise de plafond",
  humidity_investigation: "Vérification d'une humidité possible",
  crack_investigation: "Vérification d'une fissure",
  general_refresh: "Rafraîchissement général",
  facade_renovation: "Ravalement / reprise de façade",
  roof_repair: "Reprise de toiture",
  exterior_refresh: "Remise en état des extérieurs",
  other: "Autre travail",
};

export const NECESSITY_LABELS = {
  unlikely: "Peu probable",
  optional: "Optionnel",
  possible: "Possible",
  likely: "Probable",
  very_likely: "Très probable",
};

export const NECESSITY_TONES = {
  unlikely: "unknown",
  optional: "good",
  possible: "average",
  likely: "poor",
  very_likely: "poor",
};

export const WORK_CATEGORY_LABELS = {
  necessary: "Potentiellement nécessaire",
  cosmetic: "Esthétique",
  comfort: "Confort / valorisation",
};

export const SCOPE_LABELS = {
  light: "ampleur légère",
  partial: "ampleur partielle",
  medium: "ampleur moyenne",
  medium_to_full: "ampleur moyenne à complète",
  full: "ampleur complète",
  unknown: "ampleur indéterminée",
};

export const ANOMALY_LABELS = {
  possible_humidity: "Humidité possible",
  possible_water_damage: "Dégât des eaux possible",
  possible_mold: "Moisissure possible",
  crack: "Fissure visible",
  ceiling_damage: "Plafond dégradé",
  peeling_paint: "Peinture écaillée",
  damaged_floor: "Sol abîmé",
  damaged_joinery: "Menuiserie abîmée",
  visible_wiring: "Câblage apparent",
  other: "Anomalie",
};

export const SEVERITY_LABELS = { low: "Faible", medium: "Moyenne", high: "Élevée" };
export const SEVERITY_TONES = { low: "good", medium: "average", high: "poor" };

export const CLAIM_STATUS_LABELS = {
  supported: "Confirmé par les photos",
  partially_supported: "Partiellement confirmé",
  contradicted: "Contredit par les photos",
  not_verifiable: "Non vérifiable sur photo",
};

export const CLAIM_SUBJECT_LABELS = {
  dwelling: "Logement",
  building: "Immeuble",
  surroundings: "Environnement",
  unclear: "",
};

export const CLAIM_STATUS_TONES = {
  supported: "good",
  partially_supported: "average",
  contradicted: "poor",
  not_verifiable: "unknown",
};

export const FLOOR_MATERIAL_LABELS = {
  wood_parquet: "Parquet",
  old_wood_parquet: "Parquet ancien",
  solid_parquet: "Parquet massif",
  floating_parquet: "Parquet flottant",
  tiles: "Carrelage",
  carpet: "Moquette",
  vinyl: "Lino / vinyle",
  concrete: "Béton",
  other: "Autre",
  unknown: "Non identifié",
};

export const SURFACE_CONDITION_LABELS = {
  good: "bon état",
  worn: "usure visible",
  damaged: "abîmé",
  dated: "aspect daté",
  replacement_likely: "remplacement probable",
  unknown: "non évaluable",
};

export const APPARENT_AGE_LABELS = {
  recent: "récent",
  relatively_recent: "relativement récent",
  dated: "daté",
  very_dated: "très daté",
  unknown: "ancienneté indéterminée",
};

export const WINDOW_MATERIAL_LABELS = {
  wood: "bois",
  pvc: "PVC",
  aluminium: "aluminium",
  unknown: "matériau non identifié",
};

export const GLAZING_LABELS = {
  single_likely: "simple vitrage probable",
  double_likely: "double vitrage probable",
  unknown: "vitrage non identifiable",
};

export const HEATING_LABELS = {
  electric_convector: "Convecteurs électriques",
  electric_radiator: "Radiateurs électriques",
  water_radiator: "Radiateurs à eau",
  underfloor: "Chauffage au sol",
  fireplace: "Cheminée",
  stove: "Poêle",
  air_conditioning: "Climatisation",
  heat_pump: "Pompe à chaleur",
  none_visible: "Aucun émetteur visible",
  unknown: "Non identifié",
};

export const BRIGHTNESS_LABELS = {
  very_bright: "paraît très lumineux sur les photos",
  bright: "paraît lumineux sur les photos",
  average: "luminosité moyenne sur les photos",
  dark: "paraît sombre sur les photos",
  not_assessable: "luminosité non évaluable",
};

export const VIEW_LABELS = {
  open_view: "vue dégagée",
  street_view: "vue sur rue",
  courtyard: "vue sur cour",
  garden: "vue sur jardin",
  building_opposite: "immeuble en face",
  strong_overlooking: "vis-à-vis important",
  limited_overlooking: "vis-à-vis limité",
  not_assessable: "vue non évaluable",
};

export const CEILING_HEIGHT_LABELS = {
  high: "belle hauteur sous plafond",
  standard: "hauteur sous plafond standard",
  low: "hauteur sous plafond réduite",
  unknown: "hauteur non évaluable",
};

export const KITCHEN_CONDITION_LABELS = {
  recent: "cuisine récente",
  functional: "cuisine fonctionnelle",
  dated_but_usable: "cuisine datée mais utilisable",
  partial_renovation_likely: "rénovation partielle probable",
  full_replacement_likely: "remplacement complet probable",
  not_assessable: "état non évaluable",
};

export const BATHROOM_RENOVATION_LABELS = {
  none: "aucune rénovation apparente à prévoir",
  light: "rafraîchissement léger",
  medium: "rénovation moyenne",
  medium_to_full: "rénovation moyenne à complète",
  full: "rénovation complète",
  unknown: "niveau de rénovation indéterminé",
};

export const STORAGE_LABELS = {
  good: "rangements intégrés visibles",
  some: "quelques rangements visibles",
  none_visible: "aucun rangement visible",
  unknown: "rangements non évaluables",
};

export const SIZE_CLASS_LABELS = {
  small: "petite",
  medium: "moyenne",
  large: "grande",
  unknown: "",
};

export const COVERAGE_LEVEL_LABELS = {
  excellent: "Excellente",
  good: "Bonne",
  partial: "Partielle",
  poor: "Faible",
};

/** Niveau qualitatif de la fiabilité de l'analyse (féminin : « fiabilité … »). */
export const QUALITY_CONFIDENCE_LABELS = {
  excellent: "Excellente",
  good: "Bonne",
  average: "Moyenne",
  low: "Faible",
  poor: "Mauvaise",
  /** Anciennes analyses (3 paliers). */
  medium: "Moyenne",
};

export const DPE_CORRELATION_STATUS_LABELS = {
  consistent: "Cohérent avec le DPE",
  possible_post_dpe_renovation: "Rénovation possible après le DPE",
  inconclusive: "Non concluant",
};

export const DPE_CORRELATION_TONES = {
  consistent: "good",
  possible_post_dpe_renovation: "average",
  inconclusive: "unknown",
};

export const DPE_TOPIC_LABELS = { windows: "Fenêtres", heating: "Chauffage" };

export function label(map, key, fallback = null) {
  return map[key] ?? fallback ?? key ?? "";
}

export function percent(confidence) {
  if (typeof confidence !== "number") return null;
  return Math.round(confidence * 100);
}

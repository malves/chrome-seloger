/**
 * Resolveur de provenance des champs d'une annonce.
 *
 * Pour un champ donne, la valeur affichee est choisie par priorite :
 *   1. correction utilisateur (fiche de visite ou edition depuis le listing) ;
 *   2. couche IA (extrait de la description ou analyse des photos) ;
 *   3. donnee structuree de l'annonce (colonne `listings`).
 *
 * On expose la source retenue et, le cas echeant, la valeur precedente
 * (ex. surface annoncee quand l'utilisateur l'a corrigee pendant la visite).
 * Rien n'est stocke ici : la couche utilisateur arrive deja parsee (table
 * `listing_overrides`), les autres couches sont lues au rendu.
 */

/** Libelle long de chaque source (badges, tooltips). */
export const SOURCE_LABELS = {
  structured: "Donnée de l'annonce",
  description: "Extrait de la description",
  ai_photo: "Analyse IA des photos",
  user: "Saisi par vous",
  computed: "Calculé à partir d'autres valeurs",
  reference: "Déduit d'un référentiel public",
};

/** Libelle court (petit badge a cote d'une valeur). */
export const SOURCE_SHORT = {
  structured: "Annonce",
  description: "Description",
  ai_photo: "IA photos",
  user: "Vous",
  computed: "Calculé",
  reference: "Référentiel",
};

/** Precision de la source `user` selon l'endroit de saisie. */
export const ORIGIN_LABELS = {
  visit: "Vérifié pendant la visite",
  listing: "Corrigé depuis la fiche",
};

/**
 * Definition des champs resolvables.
 * `layers` = couches candidates APRES la couche utilisateur, par priorite.
 * `column` = colonne `listings` lue pour la couche `structured`.
 */
export const FIELD_DEFS = {
  surface: { key: "surface", label: "Surface habitable", unit: "m²", type: "number", column: "surface", layers: ["structured"] },
  land_surface: { key: "land_surface", label: "Surface du terrain", unit: "m²", type: "number", column: "land_surface", layers: ["structured"] },
  rooms: { key: "rooms", label: "Pièces", unit: null, type: "int", column: "rooms", layers: ["structured"] },
  bedrooms: { key: "bedrooms", label: "Chambres", unit: null, type: "int", column: "bedrooms", layers: ["structured"] },
  floor: { key: "floor", label: "Étage", unit: null, type: "int", column: "floor", layers: ["structured"] },
  year_built: { key: "year_built", label: "Année de construction", unit: null, type: "int", column: "year_built", layers: ["structured"] },
  dpe: { key: "dpe", label: "DPE", unit: null, type: "letter", column: "dpe", layers: ["structured"] },
  ges: { key: "ges", label: "GES", unit: null, type: "letter", column: "ges", layers: ["structured"] },
  charges_copro: { key: "charges_copro", label: "Charges de copropriété", unit: "€/an", type: "number", column: null, layers: ["description"] },
  taxe_fonciere: { key: "taxe_fonciere", label: "Taxe foncière", unit: "€/an", type: "number", column: null, layers: ["description"] },
  property_condition: { key: "property_condition", label: "État général", unit: null, type: "text", column: "property_condition", layers: ["structured", "ai_photo"] },
  heating_system: { key: "heating_system", label: "Chauffage", unit: null, type: "text", column: "heating_system", layers: ["structured"] },
  energy_source: { key: "energy_source", label: "Source d'énergie", unit: null, type: "text", column: "energy_source", layers: ["structured"] },
  price: { key: "price", label: "Prix", unit: "€", type: "number", column: "price", layers: ["structured"] },
};

export const FIELD_KEYS = Object.keys(FIELD_DEFS);

function isEmpty(value) {
  if (value === null || value === undefined || value === "") return true;
  if (typeof value === "number" && Number.isNaN(value)) return true;
  return false;
}

function layerValue(layer, def, { listing, aiLayers, descriptionFacts }) {
  if (layer === "structured") {
    if (!def.column || !listing) return null;
    const v = listing[def.column];
    return v === undefined ? null : v;
  }
  if (layer === "description") {
    return descriptionFacts ? descriptionFacts[def.key] ?? null : null;
  }
  if (layer === "ai_photo") {
    return aiLayers ? aiLayers[def.key] ?? null : null;
  }
  return null;
}

/** Deux valeurs sont-elles equivalentes pour ce champ (tolerance de format) ? */
function sameValue(a, b, def) {
  if (isEmpty(a) || isEmpty(b)) return false;
  if (def.type === "number") {
    return Math.round(Number(a)) === Math.round(Number(b));
  }
  if (def.type === "int") {
    return Number(a) === Number(b);
  }
  if (def.type === "letter") {
    return String(a).trim().toUpperCase() === String(b).trim().toUpperCase();
  }
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * Resout un champ.
 * @returns {{ field, label, unit, type, value, source, origin, confirmed, updatedAt, previous, known }}
 */
export function resolveField(fieldKey, ctx = {}) {
  const def = FIELD_DEFS[fieldKey];
  if (!def) return null;
  const { listing = null, overrides = null, aiLayers = null, descriptionFacts = null } = ctx;

  // Valeur "naturelle" (hors utilisateur) et sa source.
  let natural = null;
  let naturalSource = null;
  for (const layer of def.layers) {
    const v = layerValue(layer, def, { listing, aiLayers, descriptionFacts });
    if (!isEmpty(v)) {
      natural = v;
      naturalSource = layer;
      break;
    }
  }

  const override = overrides ? overrides[fieldKey] : null;
  if (override && !isEmpty(override.value)) {
    const changed = !isEmpty(natural) && !sameValue(natural, override.value, def);
    return {
      field: fieldKey,
      label: def.label,
      unit: def.unit || null,
      type: def.type,
      value: override.value,
      source: "user",
      origin: override.origin || "visit",
      confirmed: Boolean(override.confirmed),
      updatedAt: override.updatedAt || null,
      previous: changed ? { value: natural, source: naturalSource } : null,
      known: true,
    };
  }

  const empty = isEmpty(natural);
  return {
    field: fieldKey,
    label: def.label,
    unit: def.unit || null,
    type: def.type,
    value: empty ? null : natural,
    source: empty ? null : naturalSource,
    origin: null,
    confirmed: false,
    updatedAt: null,
    previous: null,
    known: !empty,
  };
}

/**
 * Resout plusieurs champs.
 * @param {object} ctx { listing, overrides, aiLayers, descriptionFacts }
 * @param {string[]} [keys] sous-ensemble de champs (defaut : tous)
 * @returns {Record<string, object>}
 */
export function resolveAll(ctx = {}, keys = FIELD_KEYS) {
  const out = {};
  for (const key of keys) {
    const resolved = resolveField(key, ctx);
    if (resolved) out[key] = resolved;
  }
  return out;
}

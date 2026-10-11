/**
 * Lecture du payload SeLoger `__UFRN_LIFECYCLE_SERVERREQUEST__` (sections classified).
 * Partagé entre l'import serveur et les tests ; l'extension duplique la même
 * logique dans `chrome-extension/src/inject.js` (monde MAIN, un seul fichier).
 */

/** @param {string} html */
export function ufrnClassifiedSectionsFromHtml(html) {
  const needle = "__UFRN_LIFECYCLE_SERVERREQUEST__";
  const start = html.indexOf(needle);
  if (start === -1) return null;

  const chunk = html.slice(start, start + 2_000_000);
  const match = chunk.match(/JSON\.parse\("((?:\\.|[^"\\])*)"\)/);
  if (!match) return null;

  try {
    const jsonText = JSON.parse(`"${match[1]}"`);
    const data = JSON.parse(jsonText);
    return data?.app_cldp?.data?.classified?.sections ?? null;
  } catch {
    return null;
  }
}

/** `energy.features[].type` SeLoger → colonne `listings`. */
export const SELOGER_ENERGY_FIELDS = {
  energySource: "energy_source",
  heatingSystem: "heating_system",
  state: "property_condition",
};

/**
 * Valeurs brutes des caractéristiques énergétiques, par colonne.
 * @param {object} sections — `classified.sections`
 * @returns {{energy_source?: string, heating_system?: string, property_condition?: string}}
 */
export function energyDetailsFromSeLogerSections(sections) {
  const features = sections?.energy?.features;
  const out = {};
  if (!Array.isArray(features)) return out;
  for (const feature of features) {
    const column = SELOGER_ENERGY_FIELDS[feature?.type];
    const value = feature?.value != null ? String(feature.value).trim() : "";
    if (column && value && !out[column]) out[column] = value;
  }
  return out;
}

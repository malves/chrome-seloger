/**
 * Familles d'énergie de chauffage, pour comparer une annonce (« Gaz ») à un DPE
 * ADEME (« Gaz naturel », « GPL », « Bois – Bûches »…).
 */

const FAMILY_RULES = [
  ["reseau", /reseau|urbain/],
  ["gaz", /gaz|gpl|propane|butane/],
  ["electricite", /electri|pompe a chaleur|\bpac\b/],
  ["fioul", /fioul|fuel|mazout/],
  ["bois", /bois|granul|pellet|buche/],
  ["charbon", /charbon/],
];

function normalize(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Famille d'une valeur unique, ou null si inconnue (« Non affecté »…). */
export function energyFamily(value) {
  const text = normalize(value);
  if (!text.trim()) return null;
  const rule = FAMILY_RULES.find(([, pattern]) => pattern.test(text));
  return rule ? rule[0] : null;
}

/**
 * Familles déclarées par une annonce ; SeLoger peut en lister plusieurs
 * (« Gaz, Électricité »).
 * @returns {string[]}
 */
export function energyFamilies(value) {
  const families = new Set();
  for (const part of normalize(value).split(/[,;/+]|\bet\b/)) {
    const family = energyFamily(part);
    if (family) families.add(family);
  }
  return [...families];
}

/**
 * Énergie de chauffage d'un DPE. `type_energie_n2` est écarté : c'est presque
 * toujours l'électricité des auxiliaires, sans valeur discriminante.
 */
export function dpeHeatingEnergy(raw) {
  const value =
    raw?.type_energie_principale_chauffage || raw?.type_energie_n1 || null;
  return value ? String(value) : null;
}

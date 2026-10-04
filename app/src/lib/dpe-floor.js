/**
 * Extraction d'un numéro d'étage depuis un texte libre.
 *
 * Le champ DPE `complement_adresse_logement` contient souvent l'étage en toutes
 * lettres plutôt qu'en donnée structurée, par exemple :
 *   « 7ème étage », « 4 », « 4ème étage à droite de l'ascenseur »,
 *   « rez-de-chaussée », « RDC », « 1er étage ».
 * Cette fonction tente d'en déduire un entier (0 = rez-de-chaussée, négatif =
 * sous-sol) et renvoie `null` si rien d'exploitable n'est trouvé.
 */

/** Retire les accents et met en minuscule pour simplifier les expressions. */
function normalize(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** Ordinaux écrits en toutes lettres les plus courants. */
const ORDINAL_WORDS = {
  premier: 1,
  premiere: 1,
  deuxieme: 2,
  second: 2,
  seconde: 2,
  troisieme: 3,
  quatrieme: 4,
  cinquieme: 5,
  sixieme: 6,
  septieme: 7,
  huitieme: 8,
  neuvieme: 9,
  dixieme: 10,
};

/**
 * @param {unknown} value — texte libre (ou nombre déjà structuré)
 * @returns {number|null} numéro d'étage, ou `null` si indéterminé
 */
export function parseFloorFromText(value) {
  if (value == null || value === "") return null;

  // Valeur déjà numérique (ex. champ `numero_etage_appartement`).
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }

  const text = normalize(value);
  if (!text) return null;

  // Rez-de-chaussée sous ses diverses formes.
  if (/\b(rdc|rez[\s-]*de[\s-]*chaussee|rez)\b/.test(text)) return 0;

  // Sous-sol / cave.
  if (/\b(sous[\s-]*sol|ss|s\.?-?sol)\b/.test(text)) return -1;

  // Forme « 7eme etage », « 4e etage », « 1er etage », « etage 3 ».
  const beforeEtage = text.match(/(\d{1,2})\s*(?:e|er|em|eme|ieme|ᵉ)?\s*etage/);
  if (beforeEtage) return Number.parseInt(beforeEtage[1], 10);

  const afterEtage = text.match(/etage\s*:?\s*(?:n[°o]?\s*)?(\d{1,2})\s*(?:e|er|em|eme|ieme)?\b/);
  if (afterEtage) return Number.parseInt(afterEtage[1], 10);

  // Forme SeLoger « Étage 7/7 » ou libellé « 7/7 » (étage courant / total).
  const slashFloor = text.match(/(?:^|\betage\s*)(\d{1,2})\s*\/\s*\d{1,3}\b/);
  if (slashFloor) return Number.parseInt(slashFloor[1], 10);

  // Ordinal en toutes lettres suivi (ou non) d'« étage ».
  for (const [word, floor] of Object.entries(ORDINAL_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) return floor;
  }

  // Entier isolé en tête de chaîne (ex. « 4 », « 4 droite »).
  const leading = text.match(/^(\d{1,2})(?:\b|\s|$)/);
  if (leading) return Number.parseInt(leading[1], 10);

  return null;
}

/**
 * Étage d'une ligne DPE open data.
 *
 * Ordre : `numero_etage_appartement`, puis `complement_adresse_logement`.
 * Le structuré à **0** est souvent un défaut ADEME (pas un RDC avéré) : on
 * consulte alors le complément avant de conclure au rez-de-chaussée.
 *
 * @param {{ complement_adresse_logement?: string, numero_etage_appartement?: unknown }} raw
 * @returns {number|null}
 */
export function floorFromDpeRaw(raw) {
  if (!raw) return null;

  const structured = raw.numero_etage_appartement;
  let fromStructured = null;
  if (structured != null && structured !== "") {
    fromStructured = parseFloorFromText(structured);
    if (fromStructured != null && fromStructured !== 0) return fromStructured;
  }

  const fromComplement = parseFloorFromText(raw.complement_adresse_logement);
  if (fromComplement != null) return fromComplement;

  if (fromStructured === 0) return 0;
  return null;
}

export default parseFloorFromText;

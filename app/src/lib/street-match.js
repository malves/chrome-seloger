/**
 * Comparaison tolérante de deux voies (« 12 bd Saint-Michel » ↔ « 12 Boulevard
 * Saint Michel ») pour retrouver un DPE à partir d'une adresse saisie à la main.
 *
 * La normalisation absorbe casse, accents, ponctuation, tirets et abréviations
 * de type de voie : deux voies normalisées égales désignent la même rue sans
 * ambiguïté. Au-delà (faute de frappe, espace manquant, type de voie oublié),
 * la similarité reste élevée mais la correspondance n'est plus « exacte ».
 */

const ABBREVIATIONS = {
  r: "rue",
  av: "avenue",
  ave: "avenue",
  bd: "boulevard",
  bld: "boulevard",
  blvd: "boulevard",
  boul: "boulevard",
  pl: "place",
  imp: "impasse",
  all: "allee",
  ch: "chemin",
  chem: "chemin",
  rte: "route",
  sq: "square",
  qu: "quai",
  crs: "cours",
  fg: "faubourg",
  fbg: "faubourg",
  pass: "passage",
  res: "residence",
  sen: "sentier",
  st: "saint",
  ste: "sainte",
  gal: "general",
  gen: "general",
  mal: "marechal",
  pdt: "president",
  prof: "professeur",
  dr: "docteur",
};

const STREET_TYPES = new Set([
  "rue",
  "avenue",
  "boulevard",
  "place",
  "impasse",
  "allee",
  "chemin",
  "route",
  "square",
  "quai",
  "cours",
  "faubourg",
  "passage",
  "residence",
  "sentier",
  "villa",
  "cite",
  "hameau",
  "voie",
  "promenade",
  "esplanade",
  "rond",
  "point",
  "parvis",
  "lotissement",
]);

const NUMBER_SUFFIXES = ["bis", "ter", "quater"];

/** Minuscules, sans accents ni ponctuation, abréviations développées. */
export function normalizeStreetName(value) {
  if (value == null) return "";
  const tokens = String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  return tokens.map((t) => ABBREVIATIONS[t] || t).join(" ");
}

/**
 * Découpe « 118 bis rue Guérard » en numéro et nom de voie.
 * `numberKey` sert à comparer (« 118bis »), `number` à afficher (« 118 bis »).
 *
 * @param {string|null|undefined} value
 * @returns {{ number: string|null, numberKey: string|null, digits: string|null, name: string }}
 */
export function parseStreetLine(value) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  const empty = { number: null, numberKey: null, digits: null, name: text };
  if (!text) return empty;

  const suffixes = NUMBER_SUFFIXES.join("|");
  const match = text.match(
    new RegExp(`^(\\d+)(?:\\s*(${suffixes})\\b|([a-z])(?=[\\s,]))?[\\s,]*(.*)$`, "i")
  );
  if (!match) return empty;

  const digits = match[1];
  const suffix = (match[2] || match[3] || "").toLowerCase();
  return {
    number: suffix ? `${digits} ${suffix}` : digits,
    numberKey: `${digits}${suffix}`,
    digits,
    name: match[4].trim(),
  };
}

/** Distance d'édition (insertion, suppression, substitution). */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

function ratio(a, b) {
  const longest = Math.max(a.length, b.length);
  if (!longest) return 0;
  return 1 - levenshtein(a, b) / longest;
}

function withoutStreetType(normalized) {
  const tokens = normalized.split(" ");
  while (tokens.length > 1 && STREET_TYPES.has(tokens[0])) tokens.shift();
  // « de », « du », « des »… après le type de voie.
  while (tokens.length > 1 && /^(de|du|des|la|le|les|l|d)$/.test(tokens[0])) {
    tokens.shift();
  }
  return tokens.join(" ");
}

/**
 * Similarité 0..1 entre deux noms de voie (sans numéro).
 * `exact` : identiques une fois normalisés (accents, casse, tirets, abréviations).
 *
 * @returns {{ score: number, exact: boolean }}
 */
export function compareStreetNames(left, right) {
  const a = normalizeStreetName(left);
  const b = normalizeStreetName(right);
  if (!a || !b) return { score: 0, exact: false };
  if (a === b) return { score: 1, exact: true };

  const compact = ratio(a.replace(/ /g, ""), b.replace(/ /g, ""));
  const coreA = withoutStreetType(a).replace(/ /g, "");
  const coreB = withoutStreetType(b).replace(/ /g, "");
  // Type de voie oublié ou différent : le cœur du nom compte, légèrement décoté.
  const core = coreA && coreB ? ratio(coreA, coreB) * 0.92 : 0;

  return { score: Math.min(Math.max(compact, core), 0.99), exact: false };
}

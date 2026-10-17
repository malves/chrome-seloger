/**
 * Extraction heuristique de faits depuis le texte libre d'une annonce.
 *
 * Objectif : pre-remplir des champs qui ne sont PAS scrapes en donnee
 * structuree (charges de copropriete, taxe fonciere) pour que l'utilisateur
 * n'ait qu'a les confirmer pendant la visite. La provenance de ces valeurs
 * est `description`.
 *
 * Volontairement deterministe (regex, aucun appel LLM) et conservateur :
 * en cas de doute, on renvoie `null` et le champ reste a decouvrir.
 * Remplacable plus tard par un extracteur LLM sans changer le modele.
 */

/** Convertit un montant francais ("1 800", "1.800", "1 200,50") en entier. */
function toNumber(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/[\s\u00a0]/g, "");
  // Points comme separateurs de milliers (suivis de 3 chiffres).
  s = s.replace(/\.(?=\d{3}(?:\D|$))/g, "");
  // Virgule decimale.
  s = s.replace(",", ".");
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

/** Facteur d'annualisation selon la periodicite trouvee dans un fragment. */
function annualFactor(fragment) {
  const t = String(fragment || "").toLowerCase();
  if (/\b(?:mensuel|mensuelle|\/\s*mois|par\s+mois)\b/.test(t) || /\/mois/.test(t)) return 12;
  if (/\b(?:trimestriel|trimestrielle|\/\s*trimestre|par\s+trimestre)\b/.test(t) || /\/trimestre/.test(t)) return 4;
  return 1; // annuel par defaut
}

/**
 * Cherche le premier montant en euros situe apres un libelle, dans une fenetre
 * de `maxGap` caracteres, et l'annualise selon la periodicite voisine.
 */
function amountAfter(text, keywordRe, { maxGap = 70 } = {}) {
  const m = keywordRe.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const window = text.slice(start, start + maxGap);
  const am = /(\d[\d .\u00a0]{0,9}\d|\d)\s*(?:€|euros?|eur\b)/i.exec(window);
  if (!am) return null;
  const value = toNumber(am[1]);
  if (value == null || value <= 0 || value > 1_000_000) return null;
  // Periodicite : fenetre autour du montant (avant + apres).
  const ctx = window.slice(0, am.index + am[0].length + 14);
  return value * annualFactor(ctx);
}

const CHARGES_RE =
  /charges?\s+(?:de\s+)?(?:copropri[ée]t[ée]|courantes?|annuelles?|mensuelles?|trimestrielles?)/i;
const TAXE_RE = /taxe\s+fonci[èe]re/i;
const COPRO_RE = /copropri[ée]t[ée]|\bcopro\b/i;

/**
 * @param {string|null|undefined} description
 * @returns {{ charges_copro: number|null, taxe_fonciere: number|null, is_copro: boolean }}
 */
export function extractDescriptionFacts(description) {
  const text = typeof description === "string" ? description : "";
  if (!text.trim()) {
    return { charges_copro: null, taxe_fonciere: null, is_copro: false };
  }

  const charges = amountAfter(text, CHARGES_RE);
  const taxe = amountAfter(text, TAXE_RE);
  const isCopro = COPRO_RE.test(text) || charges != null;

  return {
    charges_copro: charges,
    taxe_fonciere: taxe,
    is_copro: isCopro,
  };
}

export default extractDescriptionFacts;

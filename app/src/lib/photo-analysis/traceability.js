/**
 * Chaque conclusion doit être rattachée à des photos réelles (§70). Les
 * références inconnues ou pointant vers des images non exploitables sont
 * retirées ; une conclusion sans preuve n'est pas supprimée, mais sa confiance
 * est abaissée et elle est marquée `evidence_missing`, ce qui l'exclut des
 * arguments de négociation.
 */

/** Facteur appliqué à la confiance d'une conclusion sans photo de preuve. */
export const MISSING_EVIDENCE_CONFIDENCE_FACTOR = 0.6;

/** Au-dessous, une conclusion n'est plus un argument de négociation. */
export const NEGOTIATION_MIN_CONFIDENCE = 0.7;

/**
 * @param {object[]} images - images classifiées (`id`, `usable_for_condition_analysis`)
 * @returns {{ known: Set<string>, usable: Set<string> }}
 */
export function imageIndex(images) {
  const known = new Set();
  const usable = new Set();
  for (const image of images || []) {
    if (!image?.id) continue;
    known.add(image.id);
    if (image.usable_for_condition_analysis) usable.add(image.id);
  }
  return { known, usable };
}

/** Filtre une liste d'identifiants d'images sur celles connues (et exploitables). */
export function filterImageIds(ids, index, { usableOnly = true } = {}) {
  if (!Array.isArray(ids)) return [];
  const out = [];
  for (const raw of ids) {
    const id = typeof raw === "string" ? raw.trim() : null;
    if (!id || !index.known.has(id)) continue;
    if (usableOnly && !index.usable.has(id)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Applique la traçabilité à une conclusion : nettoie `image_ids`, abaisse la
 * confiance si aucune preuve, pose `evidence_missing`.
 */
export function traceFinding(finding, index, { field = "image_ids", usableOnly = true } = {}) {
  const ids = filterImageIds(finding[field], index, { usableOnly });
  const evidenceMissing = ids.length === 0;
  const confidence =
    typeof finding.confidence === "number"
      ? evidenceMissing
        ? Math.round(finding.confidence * MISSING_EVIDENCE_CONFIDENCE_FACTOR * 100) / 100
        : finding.confidence
      : finding.confidence;
  return { ...finding, [field]: ids, confidence, evidence_missing: evidenceMissing };
}

/** Une conclusion peut servir d'argument de négociation (§60). */
export function usableForNegotiation(finding) {
  if (!finding || finding.evidence_missing) return false;
  return (finding.confidence ?? 0) >= NEGOTIATION_MIN_CONFIDENCE;
}

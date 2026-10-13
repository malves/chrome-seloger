/**
 * Signaux des photos utiles au croisement avec le DPE. Le croisement lui-même
 * part du plan des pièces (`dpeCoherence`, works-coherence.js) : les photos ne
 * servent qu'à compléter ce que le plan ne dit pas (âge des fenêtres, émetteurs).
 */

/** Âge apparent dominant parmi les pièces (par confiance pondérée). */
export function dominantApparentAge(rooms, key) {
  const scores = {};
  for (const room of rooms || []) {
    const block = room?.[key];
    if (!block || !block.apparent_age || block.apparent_age === "unknown") continue;
    scores[block.apparent_age] = (scores[block.apparent_age] || 0) + (block.confidence ?? 0.5);
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : "unknown";
}

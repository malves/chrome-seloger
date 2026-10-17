/**
 * Champs modifiables depuis la fiche annonce (double-clic).
 * Le prix reste celui de l'annonce / de la visite, pas corrigé inline ici.
 */

import { FIELD_KEYS } from "./listing-field-provenance.js";

const NOT_INLINE = new Set(["price", "dpe", "ges"]);

export const LISTING_INLINE_EDIT_FIELD_KEYS = FIELD_KEYS.filter((key) => !NOT_INLINE.has(key));

export function listingSpecEditFieldKey(canonicalKey) {
  if (!canonicalKey) return null;
  return LISTING_INLINE_EDIT_FIELD_KEYS.includes(canonicalKey) ? canonicalKey : null;
}

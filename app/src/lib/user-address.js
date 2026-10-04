/**
 * Adresse réelle du bien : assemblage pour le géocodage et découpage pour
 * l'affichage dans la modale (stockage toujours en une ligne `user_address`).
 */

import { MAX_ADDRESS_LENGTH } from "../services/projects.service.js";

function cleanPart(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

/** Assemble les champs saisis en une adresse postale française. */
export function formatUserAddressFromParts({ street, complement, postalCode, city }) {
  const line = [cleanPart(street), cleanPart(complement)].filter(Boolean).join(", ");
  const locality = [cleanPart(postalCode), cleanPart(city)].filter(Boolean).join(" ");
  const full = [line, locality].filter(Boolean).join(", ");
  return full.slice(0, MAX_ADDRESS_LENGTH);
}

/**
 * Tente de reconstituer les champs à partir de la ligne stockée.
 * Formats visés : « 12 rue X, 75001 Paris » ou « 12 rue X, Bat B, 75001 Paris ».
 */
export function parseUserAddress(full) {
  const empty = { street: "", complement: "", postalCode: "", city: "" };
  const text = cleanPart(full);
  if (!text) return empty;

  const match = text.match(/^(.+),\s*(\d{5})\s+(.+)$/);
  if (!match) return { ...empty, street: text };

  const beforePostal = match[1].trim();
  const postalCode = match[2];
  const city = match[3].trim();

  const commaParts = beforePostal.split(/\s*,\s*/);
  if (commaParts.length >= 2) {
    return {
      street: commaParts[0],
      complement: commaParts.slice(1).join(", "),
      postalCode,
      city,
    };
  }

  return { street: beforePostal, complement: "", postalCode, city };
}

/** Lit le corps d'une requête (champs structurés ou `user_address` legacy). */
export function userAddressFromBody(body) {
  const raw = body ?? {};
  const hasStructured =
    raw.street !== undefined ||
    raw.postal_code !== undefined ||
    raw.city !== undefined ||
    raw.complement !== undefined;

  if (hasStructured) {
    return formatUserAddressFromParts({
      street: raw.street,
      complement: raw.complement,
      postalCode: raw.postal_code,
      city: raw.city,
    });
  }

  return cleanPart(raw.user_address).slice(0, MAX_ADDRESS_LENGTH);
}

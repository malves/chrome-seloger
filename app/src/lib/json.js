/** Sérialise un objet pour une colonne JSON, `null` si la valeur est vide. */
export function toJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

/** Relit une colonne JSON sans jamais lever d'exception. */
export function fromJson(text, fallback = null) {
  if (text === undefined || text === null || text === "") return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

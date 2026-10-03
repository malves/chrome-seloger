/** Horodatage ISO 8601 UTC, format unique de toutes les dates stockées. */
export function nowIso() {
  return new Date().toISOString();
}

/** Nombre de jours écoulés depuis une date ISO, `Infinity` si absente. */
export function daysSince(iso) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 86_400_000;
}

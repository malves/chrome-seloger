/**
 * Calendrier des publications open data DVF (DGFiP), reprises par Etalab (geo-dvf).
 * Mise à jour semestrielle : fin avril et fin octobre (FAQ app.dvf.etalab.gouv.fr).
 */

/** Texte court pour les vues (modale ventes, aide méthode). */
export function dvfPublicationNotice() {
  return (
    "La base DVF est publiée deux fois par an par la DGFiP (fin avril : mutations jusqu'à fin décembre de l'année précédente ; " +
    "fin octobre : jusqu'à fin juin de l'année en cours)."
  );
}

/**
 * Libellé d'une année de ventes : « 2026 (S1) » tant que seul le premier
 * semestre peut être publié (année en cours, ou année précédente avant la
 * livraison de fin avril), sinon « 2025 ».
 */
export function dvfPeriodLabel(year, now = new Date()) {
  const y = Number(year);
  if (!Number.isFinite(y)) return String(year ?? "");
  const current = now.getFullYear();
  const partial = y >= current || (y === current - 1 && now.getMonth() < 4);
  return partial ? `${y} (S1)` : String(y);
}

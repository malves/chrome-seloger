/**
 * Levée par un provider qui n'a rien à calculer (donnée hors périmètre,
 * prérequis absent). Journalisé en `debug` et non en `warn`.
 */
export default class ProviderSkipped extends Error {
  constructor(message) {
    super(message);
    this.name = "ProviderSkipped";
  }
}

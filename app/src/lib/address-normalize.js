/** Clé de comparaison pour rapprocher deux libellés d'adresse saisis différemment. */
export function normalizeAddressKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

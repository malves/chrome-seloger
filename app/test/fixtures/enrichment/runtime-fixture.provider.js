/** Provider réservé aux tests unitaires (dossier non scanné en production). */

export default {
  key: "runtime-fixture",
  scope: "listing",
  order: 50,
  label: "Fixture runtime",
  source: "Tests unitaires",
  isListingCacheValid(data, listing) {
    return listing.title === "CACHE";
  },
  async fetch({ listing }) {
    globalThis.__runtimeFixtureCalls =
      (globalThis.__runtimeFixtureCalls || 0) + 1;
    if (listing.title === "ECHEC") throw new Error("source indisponible");
    if (listing.title === "LENT") await new Promise((r) => setTimeout(r, 50));
    return { marqueur: "fixture-ok", ville: listing.city || null };
  },
};

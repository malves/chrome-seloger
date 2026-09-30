/**
 * Script injecté dans le "MAIN world" de la page (même contexte JS que
 * SeLoger). C'est le SEUL moyen d'accéder à la variable globale
 * `window.__UFRN_LIFECYCLE_SERVERREQUEST__`, inaccessible depuis un content
 * script classique (monde isolé).
 *
 * Il extrait la localisation du bien et la transmet au content script via
 * window.postMessage. Il interroge périodiquement la variable pour gérer :
 *  - le chargement asynchrone des données ;
 *  - les navigations internes (SPA) où seule la variable change.
 */

(function () {
  "use strict";

  const CHANNEL = "SELOGER_TRAVEL_LOCATION";
  let lastKey = null;

  /** Lit et normalise la localisation depuis la variable globale SeLoger. */
  function extractLocation() {
    try {
      const location =
        window.__UFRN_LIFECYCLE_SERVERREQUEST__?.app_cldp?.data?.classified
          ?.sections?.location;
      if (!location) return null;

      const address = location.address || {};

      // Coordonnées : centroïde du polygone (zone du quartier).
      let lat = null;
      let lon = null;
      const ring = location.geometry?.coordinates?.[0]?.[0];
      if (Array.isArray(ring) && ring.length) {
        let sumLon = 0;
        let sumLat = 0;
        let count = 0;
        for (const point of ring) {
          if (Array.isArray(point) && point.length >= 2) {
            sumLon += point[0]; // GeoJSON = [lon, lat]
            sumLat += point[1];
            count++;
          }
        }
        if (count) {
          lon = sumLon / count;
          lat = sumLat / count;
        }
      }

      const addressParts = [
        address.district,
        address.city,
        address.zipCode,
      ].filter(Boolean);

      return {
        lat,
        lon,
        address: addressParts.join(", ") || null,
        district: address.district || null,
        city: address.city || null,
        zipCode: address.zipCode || null,
        approximate: true, // polygone de quartier, pas un point exact
      };
    } catch (e) {
      return null;
    }
  }

  function keyFor(loc) {
    if (!loc) return null;
    if (loc.lat != null && loc.lon != null) {
      return `${loc.lat.toFixed(5)},${loc.lon.toFixed(5)}`;
    }
    return loc.address || null;
  }

  function publish() {
    const loc = extractLocation();
    if (!loc) return;
    const key = keyFor(loc);
    if (key && key === lastKey) return; // rien de nouveau
    lastKey = key;
    window.postMessage({ channel: CHANNEL, location: loc }, "*");
  }

  // Essai immédiat + interrogation périodique (chargement async / SPA).
  publish();
  setInterval(publish, 1500);
})();

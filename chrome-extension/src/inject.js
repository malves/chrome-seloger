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
  const PHOTOS_CHANNEL = "SELOGER_LISTING_PHOTOS";
  const DETAILS_CHANNEL = "SELOGER_LISTING_DETAILS";
  let lastKey = null;
  let lastPhotosKey = null;
  let lastDetailsKey = null;

  /** Dispatcher : choisit l'extracteur selon le site courant. */
  function extractLocation() {
    const host = location.hostname;
    if (/bellesdemeures\.com$/i.test(host)) return extractBellesDemeures();
    return extractSeLoger();
  }

  /**
   * Belles Demeures (groupe AVIV) expose un objet global `thor_data`
   * (analytics) qui contient la ville, le code postal et surtout le
   * `zone_code` = code INSEE de la commune.
   */
  function extractBellesDemeures() {
    try {
      const data = window.thor_data;
      if (!data || !/detail/i.test(data.pagename || "")) return null;
      const p = Array.isArray(data.products) ? data.products[0] : null;
      if (!p) return null;

      const city = p.city || null;
      const zipCode = p.estate_postalcode || null;
      const insee =
        p.zone_code != null && String(p.zone_code).trim()
          ? String(p.zone_code).trim()
          : null;
      if (!city && !zipCode && !insee) return null;

      const address = [city, zipCode].filter(Boolean).join(" ") || null;
      return {
        lat: null,
        lon: null,
        address,
        district: null,
        city,
        zipCode,
        insee,
        approximate: true, // localisation au niveau commune
      };
    } catch (e) {
      return null;
    }
  }

  /** Lit et normalise la localisation depuis la variable globale SeLoger. */
  function extractSeLoger() {
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

  /**
   * Toutes les photos de l'annonce SeLoger. Contrairement au JSON-LD et à la
   * balise og:image (une seule image), la galerie complète (20 à 40 clichés)
   * vit dans la variable globale, accessible uniquement depuis ce monde.
   * Chemin : classified.sections.gallery.images[].url
   */
  function extractSeLogerPhotos() {
    try {
      const gallery =
        window.__UFRN_LIFECYCLE_SERVERREQUEST__?.app_cldp?.data?.classified
          ?.sections?.gallery;
      const images = gallery && Array.isArray(gallery.images) ? gallery.images : [];
      const urls = [];
      for (const image of images) {
        const url = image && typeof image.url === "string" ? image.url.trim() : "";
        if (/^https:\/\//.test(url) && !urls.includes(url)) urls.push(url);
      }
      return urls;
    } catch (e) {
      return [];
    }
  }

  /** Premier nombre d'une chaîne (« 278 kWh/m².an » → 278). */
  function numberFrom(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const match = String(value || "")
      .replace(/[\s\u00a0\u202f]/g, "")
      .match(/\d+(?:[.,]\d+)?/);
    if (!match) return null;
    const n = Number(match[0].replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }

  /** Note A..G d'une échelle énergétique (DPE/GES). */
  function gradeFrom(scale) {
    const rating = scale && scale.efficiencyClass && scale.efficiencyClass.rating;
    if (typeof rating !== "string") return null;
    const letter = rating.trim().toUpperCase();
    return /^[A-G]$/.test(letter) ? letter : null;
  }

  /** Valeur chiffrée d'une échelle, par libellé (consommation, émissions…). */
  function scaleValue(scale, matcher) {
    const values = scale && Array.isArray(scale.values) ? scale.values : [];
    const found = values.find((v) => v && matcher.test(String(v.label || "")));
    return found ? numberFrom(found.value) : null;
  }

  /**
   * Description intégrale, caractéristiques énergétiques et année de
   * construction, uniquement disponibles dans la variable globale SeLoger (le
   * JSON-LD et les balises Open Graph ne portent qu'un extrait SEO tronqué).
   *  - description : classified.sections.description.description (texte complet) ;
   *  - DPE : échelle de type « FR_ENERGY_* » → note + consommation (kWhEP/m².an) ;
   *  - GES : échelle de type « FR_GHG_* » → note + émissions (kg CO₂/m².an) ;
   *  - année : energy.features[type = "yearOfConstruction"].
   */
  function extractSeLogerDetails() {
    try {
      const sections =
        window.__UFRN_LIFECYCLE_SERVERREQUEST__?.app_cldp?.data?.classified
          ?.sections;
      if (!sections) return null;

      const details = {};

      // Description intégrale (le JSON-LD et og:description ne portent qu'un
      // extrait SEO tronqué). Chemin : classified.sections.description.description.
      const description =
        sections.description?.description ||
        sections.mainDescription?.description ||
        sections.description?.texts?.[0]?.text ||
        null;
      if (typeof description === "string" && description.trim()) {
        details.description = description.trim();
      }

      const energy = sections.energy;
      if (energy) {
        const certificate =
          Array.isArray(energy.certificates) && energy.certificates[0]
            ? energy.certificates[0]
            : null;
        const scales =
          certificate && Array.isArray(certificate.scales) ? certificate.scales : [];

        const isDpe = (s) =>
          /ENERGY/i.test(String(s.type || "")) || /\bDPE\b/i.test(String(s.name || ""));
        const isGes = (s) =>
          /GHG|GES/i.test(String(s.type || "")) || /\bGES\b/i.test(String(s.name || ""));

        const dpeScale = scales.find(isDpe);
        const gesScale = scales.find(isGes);

        if (dpeScale) {
          const dpe = gradeFrom(dpeScale);
          if (dpe) details.dpe = dpe;
          const consumption = scaleValue(dpeScale, /consommation|primaire/i);
          if (consumption != null) details.dpe_value = consumption;
        }

        if (gesScale) {
          const ges = gradeFrom(gesScale);
          if (ges) details.ges = ges;
          const emissions = scaleValue(gesScale, /émission|emission/i);
          if (emissions != null) details.ges_value = emissions;
        }

        const features = Array.isArray(energy.features) ? energy.features : [];
        const yearFeature = features.find(
          (f) => f && f.type === "yearOfConstruction"
        );
        if (yearFeature) {
          const year = numberFrom(yearFeature.value);
          if (year && year >= 800 && year <= new Date().getFullYear() + 10) {
            details.year_built = Math.round(year);
          }
        }
      }

      return Object.keys(details).length ? details : null;
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

  /** Publie la liste des photos vers le content script (monde isolé). */
  function publishPhotos() {
    if (!/seloger\.com$/i.test(location.hostname)) return;
    const photos = extractSeLogerPhotos();
    if (!photos.length) return;
    const key = `${photos.length}|${photos[0]}`;
    if (key === lastPhotosKey) return; // même galerie, rien de nouveau
    lastPhotosKey = key;
    window.postMessage({ channel: PHOTOS_CHANNEL, photos }, "*");
  }

  /** Publie DPE/GES et année de construction vers le content script. */
  function publishDetails() {
    if (!/seloger\.com$/i.test(location.hostname)) return;
    const details = extractSeLogerDetails();
    if (!details) return;
    const key = JSON.stringify(details);
    if (key === lastDetailsKey) return; // même bien, rien de nouveau
    lastDetailsKey = key;
    window.postMessage({ channel: DETAILS_CHANNEL, details }, "*");
  }

  function publish() {
    const loc = extractLocation();
    if (loc) {
      const key = keyFor(loc);
      if (!key || key !== lastKey) {
        lastKey = key;
        window.postMessage({ channel: CHANNEL, location: loc }, "*");
      }
    }
    // Les photos et les caractéristiques vivent dans la même variable globale :
    // on les publie au même rythme (chargement async / navigation SPA).
    publishPhotos();
    publishDetails();
  }

  // Essai immédiat + interrogation périodique (chargement async / SPA).
  publish();
  setInterval(publish, 1500);
})();

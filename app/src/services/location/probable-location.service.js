/**
 * Moteur de localisation probable — orchestrateur.
 *
 * Enchaîne, de façon déterministe hormis l'extraction LLM :
 *   1. court-circuit `exact_address` si le bien est déjà localisé ou si le texte
 *      contient une adresse précise ;
 *   2. extraction des contraintes (LLM) ;
 *   3. géocodage des lieux (Nominatim + repli BAN) ;
 *   4. zones d'accessibilité (isochrones ORS + repli cercle) ;
 *   5. score spatial + résultat final conforme à la spec (+ heatmap).
 *
 * Les sous-services sont injectables pour les tests (sans réseau ni clé).
 */

import createConstraintExtractorService from "./constraint-extractor.service.js";
import createPlaceGeocoderService from "./place-geocoder.service.js";
import createAccessibilityService from "./accessibility.service.js";
import createScoringService from "./scoring.service.js";

/** Représentation « spec » d'une contrainte (pour le débogage côté client). */
/** Numéro de voie explicite (ex. « 12 rue des Lilas »), pas une rue seule. */
function isPreciseStreetAddress(value) {
  const line = String(value || "").trim();
  if (!line) return false;
  return /\b\d{1,5}\s*(?:bis|ter|quater)?\b/i.test(line);
}

function toSpecConstraint(c) {
  return {
    place: c.place,
    place_type: c.place_type,
    relation: c.relation,
    max_minutes: c.max_minutes ?? null,
    min_minutes: c.min_minutes ?? null,
    max_meters: c.max_meters ?? null,
    min_meters: c.min_meters ?? null,
    transport: c.transport ?? null,
    precision: c.precision,
    vague_kind: c.vague_kind ?? null,
    confidence: c.confidence ?? null,
    latitude: Number.isFinite(c.latitude) ? Number(c.latitude.toFixed(6)) : null,
    longitude: Number.isFinite(c.longitude) ? Number(c.longitude.toFixed(6)) : null,
    geocoding_confidence: Number.isFinite(c.geocoding_confidence)
      ? Number(c.geocoding_confidence.toFixed(3))
      : null,
    geocoded_label: c.geocoded_label ?? null,
    access_mode: c.access?.mode ?? null,
    rejected: Boolean(c.rejected),
    reject_reason: c.reject_reason ?? null,
  };
}

export default function createProbableLocationService({
  repositories,
  logger,
  extractor,
  geocoder,
  accessibility,
  scoring,
} = {}) {
  const extract = extractor || createConstraintExtractorService({ logger });
  const geo = geocoder || createPlaceGeocoderService({ repositories, logger });
  const access = accessibility || createAccessibilityService({ logger });
  const scorer = scoring || createScoringService({});

  function configured() {
    return extract.configured();
  }

  /**
   * Estime la zone probable d'un bien.
   * @param {{description, city, postalCode, userLat, userLng, userAddress}} input
   */
  async function estimate(input = {}) {
    const {
      description = "",
      city = null,
      postalCode = null,
      userLat = null,
      userLng = null,
    } = input;

    // 1. Le bien est déjà localisé précisément : inutile de deviner.
    if (Number.isFinite(userLat) && Number.isFinite(userLng)) {
      return {
        status: "exact_address",
        confidence: 1,
        center: { latitude: userLat, longitude: userLng },
        estimated_radius_m: 0,
        constraints_used: 0,
        constraints_rejected: 0,
        best_area: { polygon: [] },
        top_candidates: [
          { latitude: userLat, longitude: userLng, score: 1 },
        ],
        heatmap: [],
        constraints: [],
      };
    }

    // 2. Extraction LLM (seule étape non déterministe).
    const extraction = await extract.extract({ description, city, postalCode });
    if (!extraction.available) {
      return {
        status: "unavailable",
        confidence: 0,
        center: null,
        constraints: [],
        warnings: ["Extraction indisponible (LLM non configuré ou injoignable)."],
      };
    }

    let constraints = [...(extraction.constraints || [])];
    let exactAddress = extraction.exactAddress;

    // Rue sans numéro : indice « proche », pas une adresse exacte — on garde les POI.
    if (exactAddress && !isPreciseStreetAddress(exactAddress)) {
      const vagueStreet = {
        place: exactAddress,
        place_type: "address",
        relation: "near",
        precision: "approximate",
        vague_kind: "proche",
        confidence: 0.75,
        transport: "walking",
        max_minutes: null,
        min_minutes: null,
        max_meters: null,
        min_meters: null,
      };
      const norm = String(exactAddress).trim().toLowerCase();
      if (!constraints.some((c) => String(c.place || "").trim().toLowerCase() === norm)) {
        constraints.unshift(vagueStreet);
      }
      exactAddress = null;
    }

    // Adresse précise trouvée dans le texte : on géocode et on s'arrête.
    if (exactAddress) {
      const point = await geo
        .geocodeAddress({ line: exactAddress, city, postalCode })
        .catch(() => null);
      return {
        status: "exact_address",
        confidence: point ? 0.9 : 0.5,
        center: point ? { latitude: point.lat, longitude: point.lon } : null,
        estimated_radius_m: point ? 0 : null,
        constraints_used: 0,
        constraints_rejected: 0,
        best_area: { polygon: [] },
        top_candidates: point
          ? [{ latitude: point.lat, longitude: point.lon, score: 1 }]
          : [],
        heatmap: [],
        constraints: [],
        exact_address: exactAddress,
      };
    }

    if (!constraints.length) {
      return {
        status: "insufficient",
        confidence: 0,
        center: null,
        estimated_radius_m: null,
        constraints_used: 0,
        constraints_rejected: 0,
        best_area: { polygon: [] },
        top_candidates: [],
        heatmap: [],
        constraints: [],
        warnings: ["Aucun indice de localisation détecté dans l'annonce."],
      };
    }

    // 3. Géocodage des lieux.
    const { constraints: geocoded } = await geo.geocodeConstraints(constraints, {
      city,
      postalCode,
    });

    // 4. Zones d'accessibilité pour les contraintes temporelles géocodées.
    for (const c of geocoded) {
      if (!c.rejected && c.relation === "travel_time" && Number.isFinite(c.latitude)) {
        // eslint-disable-next-line no-await-in-loop
        c.access = await access.buildTimeAccess(c);
      }
    }

    // 5. Score spatial + résultat final.
    const result = scorer.score(geocoded);
    result.constraints = geocoded.map(toSpecConstraint);

    logger?.info?.(
      {
        status: result.status,
        used: result.constraints_used,
        rejected: result.constraints_rejected,
        confidence: result.confidence,
      },
      "localisation probable estimée"
    );

    return result;
  }

  return { configured, estimate };
}

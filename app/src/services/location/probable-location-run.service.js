/**
 * Exécution + persistance de l'estimation « zone probable » (partagée entre la
 * route HTTP et le provider d'enrichissement au moment de l'enregistrement).
 */

import createProbableLocationService from "./probable-location.service.js";
import {
  probableLocationFromCache,
  probableLocationCachePayload,
  probableLocationCacheValid,
  probableLocationInputFingerprint,
  PROBABLE_LOCATION_PROVIDER,
} from "../../lib/probable-location-cache.js";

function listingInput(listing) {
  return {
    description: listing.description || "",
    city: listing.city || null,
    postalCode: listing.postal_code || null,
    userLat: Number.isFinite(listing.user_lat) ? listing.user_lat : null,
    userLng: Number.isFinite(listing.user_lng) ? listing.user_lng : null,
    userAddress: listing.user_address || null,
  };
}

function stripMeta(result) {
  const { cached, cached_at, ...rest } = result;
  return rest;
}

/** On mémorise aussi « insufficient » pour ne pas rappeler le LLM à chaque visite. */
function shouldPersist(result) {
  return result.status !== "unavailable";
}

export default function createProbableLocationRunService({
  repositories,
  logger,
  probableLocation,
} = {}) {
  const engine =
    probableLocation || createProbableLocationService({ repositories, logger });

  /**
   * @returns {Promise<object>} réponse API (avec cached / cached_at si applicable)
   */
  async function runForListing(listing, { force = false, persist = true } = {}) {
    if (!listing?.id) {
      return { status: "unavailable", confidence: 0, warnings: ["Annonce invalide."] };
    }

    const cachedRow = repositories.enrichments.findOne(
      listing.id,
      PROBABLE_LOCATION_PROVIDER
    );
    if (!force) {
      const cached = probableLocationFromCache(cachedRow, listing);
      if (cached) return cached;
    }

    const result = await engine.estimate(listingInput(listing));

    if (persist && shouldPersist(result)) {
      repositories.enrichments.saveListingResult(
        listing.id,
        PROBABLE_LOCATION_PROVIDER,
        {
          status: "ok",
          data: probableLocationCachePayload(listing, stripMeta(result)),
          error: null,
        }
      );
    }

    return { ...result, cached: false, cached_at: null };
  }

  /**
   * Lit le résultat stocké sans recalculer (pour la fiche annonce).
   * @returns {{ ready: boolean, status?: string, ... }}
   */
  function readStored(listing) {
    if (!listing?.id) {
      return { ready: true, status: "unavailable", warnings: ["Annonce invalide."] };
    }

    if (Number.isFinite(listing.user_lat) && Number.isFinite(listing.user_lng)) {
      return {
        ready: true,
        status: "exact_address",
        confidence: 1,
        center: { latitude: listing.user_lat, longitude: listing.user_lng },
        cached: true,
      };
    }

    const row = repositories.enrichments.findOne(
      listing.id,
      PROBABLE_LOCATION_PROVIDER
    );
    const hit = probableLocationFromCache(row, listing);
    if (hit) {
      return { ...hit, ready: true };
    }

    if (row?.status === "error") {
      return {
        ready: true,
        status: "unavailable",
        warnings: [row.error || "Estimation indisponible."],
      };
    }

    return { ready: false, status: "pending" };
  }

  /**
   * Diagnostic admin : données utilisées pour la zone probable (cache enrichissement),
   * indépendamment de l'affichage carte « adresse réelle ».
   */
  function readDebug(listing) {
    const row = repositories.enrichments.findOne(
      listing.id,
      PROBABLE_LOCATION_PROVIDER
    );
    const description = String(listing?.description || "").trim();
    const hasUserGeo =
      Number.isFinite(listing?.user_lat) && Number.isFinite(listing?.user_lng);
    const cachedEstimate =
      row?.status === "ok" && row.data?.result ? row.data.result : null;

    return {
      listingId: listing.id,
      inputs: {
        city: listing.city || null,
        postalCode: listing.postal_code || null,
        descriptionLength: description.length,
        descriptionPreview: description.slice(0, 1200),
        userAddress: listing.user_address || null,
        userGeocoded: hasUserGeo,
        userLat: hasUserGeo ? listing.user_lat : null,
        userLng: hasUserGeo ? listing.user_lng : null,
      },
      mapUi: {
        mode: hasUserGeo ? "precise_address" : "probable_zone",
        note: hasUserGeo
          ? "La carte affiche l'adresse réelle ; le détail ci-dessous correspond au dernier calcul « zone probable » (cache), s'il existe."
          : "La carte affiche la zone probable à partir du cache ci-dessous.",
      },
      enrichment: row
        ? {
            status: row.status,
            error: row.error || null,
            fetchedAt: row.fetched_at || null,
          }
        : null,
      cache: {
        currentFingerprint: probableLocationInputFingerprint(listing),
        storedFingerprint: row?.data?.inputFingerprint || null,
        valid: probableLocationCacheValid(row, listing),
      },
      clientStored: readStored(listing),
      estimate: cachedEstimate,
    };
  }

  return { runForListing, readStored, readDebug, engine };
}

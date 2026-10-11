/**
 * Zone probable : lancée automatiquement à l'enregistrement de l'annonce
 * (orchestration d'enrichissement). Pas de bloc UI dédié (`display: false`).
 */

import ProviderSkipped from "./skipped.js";
import createProbableLocationRunService from "../location/probable-location-run.service.js";
import { probableLocationCachePayload } from "../../lib/probable-location-cache.js";

export default {
  key: "probable-location",
  scope: "listing",
  order: 2,
  ttlDays: 365,
  label: "Zone probable",
  display: false,

  async fetch(ctx) {
    const { listing, repositories, logger } = ctx;
    const runner = createProbableLocationRunService({ repositories, logger });

    if (!runner.engine.configured()) {
      throw new ProviderSkipped("LLM non configuré : zone probable ignorée.");
    }

    if (!String(listing.description || "").trim()) {
      throw new ProviderSkipped(
        "Description absente : zone probable non calculée."
      );
    }

    const result = await runner.runForListing(listing, {
      force: false,
      persist: false,
    });
    if (result.status === "unavailable") {
      throw new ProviderSkipped(
        result.warnings?.[0] || "Estimation de zone indisponible."
      );
    }

    const { cached, cached_at, ...toStore } = result;
    return probableLocationCachePayload(listing, toStore);
  },
};

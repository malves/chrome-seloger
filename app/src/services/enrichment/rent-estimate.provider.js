/**
 * Valeur locative au m² (LLM + recherche web). Lancée automatiquement à
 * l'enregistrement, en parallèle des autres providers (`standalone`), sans
 * bloc générique (`display: false`) : le rendu vit dans le panneau marché.
 *
 * Sans adresse saisie, l'estimation vaut pour toute la commune : elle est
 * aussi stockée dans `commune_data` (par type de bien) et réutilisée sans
 * appel LLM par les autres annonces de la commune ou après effacement
 * d'une adresse.
 */

import ProviderSkipped from "./skipped.js";
import createRentEstimateService from "../rent/rent-estimate.service.js";
import { daysSince } from "../../lib/time.js";
import {
  RENT_ESTIMATE_COMMUNE_PROVIDER,
  RENT_ESTIMATE_PROVIDER,
  RENT_ESTIMATE_TTL_DAYS,
  RENT_ESTIMATE_VERSION,
  isCommuneScopedRent,
  mergeCommuneRent,
  pickCommuneRent,
} from "../../lib/rent-estimate.js";

/** Estimation communale réutilisable pour cette annonce, sinon `null`. */
export function findCommuneRentEstimate(repositories, listing) {
  if (!isCommuneScopedRent(listing)) return null;
  const row = repositories.enrichments.findCommune(
    listing.insee_code,
    RENT_ESTIMATE_COMMUNE_PROVIDER
  );
  return pickCommuneRent(row?.data, listing.property_type);
}

function saveCommuneRentEstimate(repositories, staleListing, data) {
  // L'appel LLM dure jusqu'à une minute : la commune (code INSEE) a pu être
  // résolue entre-temps, ou une adresse saisie.
  const listing =
    repositories.listings?.findByIdOnly(staleListing.id) || staleListing;
  if (!isCommuneScopedRent(listing)) return;
  const row = repositories.enrichments.findCommune(
    listing.insee_code,
    RENT_ESTIMATE_COMMUNE_PROVIDER
  );
  // Les notes du LLM peuvent décrire le bien d'un autre compte.
  repositories.enrichments.saveCommune(
    listing.insee_code,
    RENT_ESTIMATE_COMMUNE_PROVIDER,
    mergeCommuneRent(row?.data, listing.property_type, { ...data, notes: "" })
  );
}

export default {
  key: RENT_ESTIMATE_PROVIDER,
  scope: "listing",
  group: "market",
  order: 31,
  ttlDays: RENT_ESTIMATE_TTL_DAYS,
  label: "Valeur locative",
  display: false,
  standalone: true,
  source: "OpenAI (recherche web)",
  sourceUrl: "https://platform.openai.com/docs/guides/tools-web-search",

  async fetch(ctx) {
    const { listing, repositories, logger, config, force = false } = ctx;

    if (listing.transaction_type === "rent") {
      throw new ProviderSkipped(
        "Annonce en location : estimation de valeur locative ignorée."
      );
    }
    if (!(listing.surface > 0)) {
      throw new ProviderSkipped(
        "Surface absente : estimation de valeur locative impossible."
      );
    }

    const existing = repositories.enrichments.findOne(
      listing.id,
      RENT_ESTIMATE_PROVIDER
    );
    if (!force && existing && daysSince(existing.fetched_at) <= RENT_ESTIMATE_TTL_DAYS) {
      if (
        existing.status === "ok" &&
        existing.data?.rent_m2 &&
        existing.data.version === RENT_ESTIMATE_VERSION
      ) {
        return existing.data;
      }
      if (existing.status === "error") {
        throw new ProviderSkipped(
          existing.error || "Estimation locative déjà tentée."
        );
      }
    }

    if (!force) {
      const communeData = findCommuneRentEstimate(repositories, listing);
      if (communeData) return communeData;
    }

    const service = createRentEstimateService({ logger, rent: config?.rent });
    if (!service.configured()) {
      throw new ProviderSkipped(
        "LLM non configuré : estimation locative ignorée."
      );
    }

    const result = await service.estimate(listing);
    if (!result.available || !result.data) {
      throw new ProviderSkipped(
        result.error || "Estimation locative indisponible."
      );
    }
    saveCommuneRentEstimate(repositories, listing, result.data);
    return result.data;
  },
};

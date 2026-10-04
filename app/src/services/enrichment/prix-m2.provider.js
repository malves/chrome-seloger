/**
 * Prix au m² issu des ventes réelles (DVF / geo-dvf) : prix médian de la
 * commune (maison et appartement), prix dans un rayon autour de l'adresse,
 * verdict de négociation et évolution sur ~10 ans.
 *
 * Portée « listing » : le rayon dépend des coordonnées exactes du bien, non
 * mutualisables par code INSEE. Les lectures tapent directement la base DVF
 * (indexée), le résultat est mis en cache par annonce.
 */

import { listingTerritory } from "../../lib/listing-territory.js";
import {
  boundingBox,
  pricesWithinRadius,
  median,
  priceVerdict,
  buildEvolution,
} from "../../lib/dvf-stats.js";
import ProviderSkipped from "./skipped.js";

const DATASET_URL = "https://files.data.gouv.fr/geo-dvf/latest/csv/";

/** Départements non couverts par DVF (livre foncier / cadastre spécifique). */
const UNCOVERED_DEPTS = new Set(["57", "67", "68", "976"]);

/** Dernière année (médiane) disponible dans une série communale. */
function latestStat(series) {
  if (!series?.length) return null;
  return series[series.length - 1];
}

/** Type de bien de l'annonce ramené aux clés DVF, ou null. */
function listingDvfType(listing) {
  if (listing?.property_type === "house") return "house";
  if (listing?.property_type === "apartment") return "apartment";
  return null;
}

export default {
  key: "prix-m2",
  scope: "listing",
  order: 25,
  ttlDays: 90,
  label: "Estimation du prix au m²",
  source: "DVF — DGFiP (geo-dvf Etalab)",
  sourceUrl: DATASET_URL,

  async fetch({ listing, inseeCode, repositories, config }) {
    const dvf = repositories.dvf;
    if (!dvf?.hasData()) {
      throw new Error(
        "Base DVF non importée : lancez l'import depuis l'administration ou `npm run import:dvf`."
      );
    }
    if (!inseeCode) {
      throw new ProviderSkipped(
        "Commune inconnue : le code INSEE n'a pas encore été résolu."
      );
    }

    const territory = listingTerritory(listing);
    const communeCache = repositories.enrichments.findCommune(inseeCode, "commune");
    const communeName = communeCache?.data?.name || listing.city || null;
    const deptCode =
      communeCache?.data?.department?.code || inseeCode.slice(0, 2);

    if (UNCOVERED_DEPTS.has(deptCode) || UNCOVERED_DEPTS.has(inseeCode.slice(0, 3))) {
      throw new ProviderSkipped(
        "DVF ne couvre pas ce département (Alsace-Moselle ou Mayotte : livre foncier)."
      );
    }

    const houseSeries = dvf.communeSeries(inseeCode, "house");
    const apartmentSeries = dvf.communeSeries(inseeCode, "apartment");
    if (!houseSeries.length && !apartmentSeries.length) {
      throw new ProviderSkipped(
        "Aucune vente DVF exploitable pour cette commune sur la période importée."
      );
    }

    const houseLatest = latestStat(houseSeries);
    const apartmentLatest = latestStat(apartmentSeries);
    const referenceYear = Math.max(
      houseLatest?.year || 0,
      apartmentLatest?.year || 0
    ) || null;

    const commune = {
      insee_code: inseeCode,
      name: communeName,
      house: houseLatest
        ? {
            median_price_m2: houseLatest.median_price_m2,
            count: houseLatest.count,
            year: houseLatest.year,
          }
        : null,
      apartment: apartmentLatest
        ? {
            median_price_m2: apartmentLatest.median_price_m2,
            count: apartmentLatest.count,
            year: apartmentLatest.year,
          }
        : null,
    };

    // Type du bien de l'annonce (pour le rayon, le verdict et l'évolution).
    const type = listingDvfType(listing);

    // --- Rayon autour de l'adresse (si coordonnées + type exploitable) ---
    // Rayon adaptatif : on part du rayon de base (ex. 250 m) et on l'élargit
    // (×2, puis ×4 → 500 m, 1000 m) uniquement si l'échantillon est trop faible.
    const minSample = config.dvf.radiusMinSample;
    const baseRadius = config.dvf.radiusMeters;
    const radiusLadder = [baseRadius, baseRadius * 2, baseRadius * 4];
    const maxRadius = radiusLadder[radiusLadder.length - 1];
    let radius = null;
    if (type && territory.lat != null && territory.lng != null) {
      const yearFrom = referenceYear
        ? referenceYear - (config.dvf.radiusYears - 1)
        : 0;
      // On interroge une seule fois la plus grande emprise, puis on filtre par
      // distance pour chaque palier (le nombre de ventes croît avec le rayon).
      const bbox = boundingBox(territory.lat, territory.lng, maxRadius);
      const candidates = dvf.radiusCandidates(type, bbox, { yearFrom });
      let chosen = null;
      for (const r of radiusLadder) {
        const prices = pricesWithinRadius(
          candidates,
          territory.lat,
          territory.lng,
          r
        );
        chosen = { meters: r, prices };
        if (prices.length >= minSample) break; // échantillon suffisant à ce palier
      }
      if (chosen && chosen.prices.length) {
        radius = {
          meters: chosen.meters,
          property_type: type,
          median_price_m2:
            Math.round((median(chosen.prices) || 0) * 100) / 100,
          count: chosen.prices.length,
          enough: chosen.prices.length >= minSample,
          widened: chosen.meters > baseRadius,
          years: config.dvf.radiusYears,
        };
      }
    }

    // --- Prix du bien et verdict de négociation ---
    let listingPricePerM2 = null;
    if (
      listing.transaction_type !== "rent" &&
      listing.price > 0 &&
      listing.surface > 0
    ) {
      listingPricePerM2 =
        Math.round((listing.price / listing.surface) * 100) / 100;
    }

    let verdict = null;
    if (listingPricePerM2 && type) {
      const typeLatest = type === "house" ? houseLatest : apartmentLatest;
      const useRadius = radius && radius.enough;
      const reference = useRadius
        ? radius.median_price_m2
        : typeLatest?.median_price_m2 || null;
      const base = priceVerdict(listingPricePerM2, reference);
      if (base) {
        const overpriced = base.index > 103;
        verdict = {
          ...base,
          listing_price_m2: listingPricePerM2,
          reference_price_m2: reference,
          reference_scope: useRadius ? "radius" : "commune",
          // Écart au marché (positif = plus cher que la référence).
          delta_amount: Math.round(
            listing.price - reference * listing.surface
          ),
          negotiation_amount: overpriced
            ? Math.round(listing.price - reference * listing.surface)
            : null,
        };
      }
    }

    // --- Évolution sur ~10 ans (type du bien, sinon type le mieux documenté) ---
    const evolutionType =
      type ||
      (apartmentSeries.length >= houseSeries.length ? "apartment" : "house");
    const evolutionSeries =
      evolutionType === "house" ? houseSeries : apartmentSeries;
    const evolution = buildEvolution(evolutionSeries, { maxYears: 10 });
    if (evolution) evolution.property_type = evolutionType;

    return {
      insee_code: inseeCode,
      commune_name: communeName,
      territory_source: territory.source,
      reference_year: referenceYear,
      property_type: type,
      has_coordinates: territory.lat != null && territory.lng != null,
      commune,
      radius,
      verdict,
      evolution,
      import_meta: dvf.importMeta(),
    };
  },
};

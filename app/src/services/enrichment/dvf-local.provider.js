/**
 * Prix local au m² issu des ventes réelles DVF, dans un rayon autour de
 * l'adresse SAISIE sur l'annonce (portée annonce : `listing_enrichments`).
 *
 * Provider cache-only (`display: false`) : l'orchestrateur place ce résultat
 * dans le comparatif « à l'adresse » du bloc Analyse de marché, à côté du grand
 * quartier Immo Data, pour voir quelle source colle le mieux au terrain.
 */

import { listingTerritory } from "../../lib/listing-territory.js";
import {
  boundingBox,
  buildDvfRadiusReference,
  salesWithinRadius,
  priceVerdict,
} from "../../lib/dvf-stats.js";
import { listingPricePerM2, listingRealtyType } from "../../lib/immo-data-market.js";
import ProviderSkipped from "./skipped.js";

const DATASET_URL = "https://files.data.gouv.fr/geo-dvf/latest/csv";

/** Cache listing obsolète (avant pondération récente / filtre des valeurs atypiques). */
export function needsDvfLocalRefresh(data) {
  if (!data?.radius) return true;
  if (data.radius.count_reference == null) return true;
  if (data.radius.outliers_excluded == null) return true;
  if (!data.radius.recency_weighted) return true;
  if (!Array.isArray(data.radius.sales) || !data.radius.sales.length) return true;
  return false;
}

/** Référence €/m² dans un rayon : médiane pondérée (ventes récentes). */
function radiusReference(
  dvf,
  type,
  lat,
  lng,
  meters,
  yearFrom,
  { halfLifeDays, now, outlierLowRatio }
) {
  const bbox = boundingBox(lat, lng, meters);
  const candidates = dvf.radiusCandidates(type, bbox, { yearFrom });
  const sales = salesWithinRadius(candidates, lat, lng, meters);
  const ref = buildDvfRadiusReference(sales, {
    now,
    halfLifeDays,
    outlierLowRatio,
  });
  return {
    count: ref.count,
    count_reference: ref.count_reference,
    outliers_excluded: ref.outliers_excluded,
    median: ref.median,
    outlier_floor_m2: ref.outlier_floor_m2,
    sales: ref.sales,
  };
}

export default {
  key: "dvf-local",
  scope: "listing",
  group: "market",
  display: false,
  order: 28,
  ttlDays: 30,
  label: "Prix local DVF (rayon)",
  source: "DVF — Etalab (geo-dvf)",
  sourceUrl: DATASET_URL,

  async fetch({ listing, repositories, config }) {
    const dvf = repositories.dvf;
    if (!dvf?.hasData()) {
      throw new ProviderSkipped(
        "Base DVF non importée : lancez l'import depuis l'administration."
      );
    }

    const territory = listingTerritory(listing);
    if (territory.source !== "user") {
      throw new ProviderSkipped(
        "Renseignez l'adresse exacte du bien pour obtenir le prix autour de l'adresse."
      );
    }
    if (territory.lat == null || territory.lng == null) {
      throw new ProviderSkipped(
        "Adresse non géocodée : impossible de calculer le prix autour de l'adresse."
      );
    }

    const type = listingRealtyType(listing);
    if (!type) {
      throw new ProviderSkipped(
        "Type de bien inconnu : rayon DVF indisponible."
      );
    }

    const {
      radiusMeters,
      radiusMinSample,
      radiusYears,
      radiusRecencyHalfLifeDays,
      radiusOutlierLowRatio,
    } = config.dvf;
    const halfLifeDays = radiusRecencyHalfLifeDays;
    const outlierLowRatio = radiusOutlierLowRatio;
    const yearFrom = new Date().getFullYear() - radiusYears;
    const { lat, lng } = territory;
    const now = new Date();

    let meters = radiusMeters;
    let {
      count,
      count_reference: countReference,
      outliers_excluded: outliersExcluded,
      median: priceM2,
      outlier_floor_m2: outlierFloorM2,
      sales: radiusSales,
    } = radiusReference(dvf, type, lat, lng, meters, yearFrom, {
      halfLifeDays,
      now,
      outlierLowRatio,
    });
    let widened = false;
    if (count < radiusMinSample) {
      // Peu de ventes : on élargit une fois le rayon pour un échantillon exploitable.
      const wider = radiusReference(dvf, type, lat, lng, meters * 2, yearFrom, {
        halfLifeDays,
        now,
        outlierLowRatio,
      });
      if (wider.count > count) {
        meters *= 2;
        count = wider.count;
        countReference = wider.count_reference;
        outliersExcluded = wider.outliers_excluded;
        priceM2 = wider.median;
        outlierFloorM2 = wider.outlier_floor_m2;
        radiusSales = wider.sales;
        widened = true;
      }
    }

    if (priceM2 == null) {
      throw new ProviderSkipped(
        "Aucune vente DVF exploitable autour de cette adresse."
      );
    }

    const listingPrice = listingPricePerM2(listing);
    const base = priceVerdict(listingPrice, priceM2);
    const verdict = base
      ? {
          ...base,
          listing_price_m2: listingPrice,
          reference_price_m2: priceM2,
          reference_scope: "radius",
        }
      : null;

    return {
      source: "dvf",
      property_type: type,
      radius: {
        meters,
        median_price_m2: priceM2,
        count,
        count_reference: countReference,
        outliers_excluded: outliersExcluded,
        widened,
        enough: count >= radiusMinSample,
        years: radiusYears,
        recency_weighted: true,
        recency_half_life_days: halfLifeDays,
        outlier_floor_m2: outlierFloorM2,
        sales: radiusSales,
      },
      verdict,
    };
  },
};

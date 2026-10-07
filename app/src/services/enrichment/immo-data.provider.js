/**
 * Prix au m² issus de l'API Immo Data — volet COMMUNAL (historique mensuel
 * `geoLevel=city`, appartements et maisons). Mis en cache en portée communale
 * (`commune_data`), partagé par toutes les annonces de la commune.
 *
 * Le verdict (prix du bien vs référence) et la fusion avec le volet
 * départemental (`immo-data-dept`) sont assemblés à l'affichage par
 * l'orchestrateur : ce provider ne produit que la partie commune.
 */

import ProviderSkipped from "./skipped.js";
import {
  buildMonthlyEvolution,
  departmentCodeFromInsee,
  fetchHistorySeries,
  formatPeriodFr,
  historyRange,
  IMMO_DATA_MARKET_VERSION,
  latestCard,
  listingRealtyType,
  MARKET_VARIATION_HORIZONS,
} from "../../lib/immo-data-market.js";

const SOURCE_URL = "https://developer.immo-data.fr";

export default {
  key: "immo-data",
  scope: "commune",
  group: "market",
  order: 26,
  ttlDays: 14,
  label: "Prix de marché",
  source: "Immo Data",
  sourceUrl: SOURCE_URL,

  async fetch({ listing, inseeCode, repositories, fetchJson, config }) {
    if (!config?.immoData?.apiKey) {
      throw new ProviderSkipped(
        "Clé Immo Data absente : renseignez IMMO_DATA_API_KEY."
      );
    }
    if (!inseeCode) {
      throw new ProviderSkipped(
        "Commune inconnue : le code INSEE n'a pas encore été résolu."
      );
    }
    if (typeof fetchJson !== "function") {
      throw new Error("Client HTTP Immo Data indisponible.");
    }

    const communeCache = repositories.enrichments.findCommune(inseeCode, "commune");
    const communeName = communeCache?.data?.name || listing.city || null;
    const deptCode =
      communeCache?.data?.department?.code || departmentCodeFromInsee(inseeCode);
    const deptName = communeCache?.data?.department?.name || null;
    const { startDate, endDate } = historyRange();
    const type = listingRealtyType(listing);

    const shared = {
      marketType: "sales",
      interval: "monthly",
      startDate,
      endDate,
      metric: "sqm_price",
      geoLevel: "city",
      code: inseeCode,
    };

    const [apartmentRes, houseRes] = await Promise.allSettled([
      fetchHistorySeries(fetchJson, config, { ...shared, realtyType: "apartment" }),
      fetchHistorySeries(fetchJson, config, { ...shared, realtyType: "house" }),
    ]);

    const cityApartment = apartmentRes.status === "fulfilled" ? apartmentRes.value : [];
    const cityHouse = houseRes.status === "fulfilled" ? houseRes.value : [];
    if (!cityApartment.length && !cityHouse.length) {
      const firstError =
        apartmentRes.status === "rejected"
          ? apartmentRes.reason
          : houseRes.status === "rejected"
            ? houseRes.reason
            : null;
      if (firstError) throw firstError;
      throw new ProviderSkipped(
        "Aucune série de prix Immo Data pour cette commune."
      );
    }

    const apartmentLatest = latestCard(cityApartment);
    const houseLatest = latestCard(cityHouse);
    const typeLatest =
      type === "house" ? houseLatest : type === "apartment" ? apartmentLatest : null;
    const referencePeriod =
      typeLatest?.period ||
      apartmentLatest?.period ||
      houseLatest?.period ||
      null;

    const defaultType =
      type || (cityApartment.length >= cityHouse.length ? "apartment" : "house");

    const primarySeries = cityApartment.length ? cityApartment : cityHouse;
    const firstPeriod = primarySeries[0]?.period || startDate;
    const evolution = {
      default_type: defaultType,
      commune_name: communeName,
      department: deptCode ? { code: deptCode, name: deptName } : null,
      lead: `Tendances mensuelles à ${communeName || "la commune"}${
        deptName || deptCode
          ? ` et dans le département (${deptName || deptCode})`
          : ""
      }, de ${formatPeriodFr(firstPeriod)} à ${formatPeriodFr(endDate)}.`,
      by_type: {
        apartment: {
          commune: buildMonthlyEvolution(cityApartment, { propertyType: "apartment" }),
          department: null,
        },
        house: {
          commune: buildMonthlyEvolution(cityHouse, { propertyType: "house" }),
          department: null,
        },
      },
    };

    return {
      market_version: IMMO_DATA_MARKET_VERSION,
      market_variation_horizons: MARKET_VARIATION_HORIZONS,
      insee_code: inseeCode,
      commune_name: communeName,
      reference_year: referencePeriod,
      reference_caption: referencePeriod
        ? `Prix de marché · ${formatPeriodFr(referencePeriod)}`
        : "Prix de marché",
      property_type: type,
      hide_radius: true,
      has_coordinates: true,
      commune: {
        insee_code: inseeCode,
        name: communeName,
        house: houseLatest,
        apartment: apartmentLatest,
      },
      radius: null,
      // verdict et séries départementales assemblés à l'affichage.
      verdict: null,
      evolution,
    };
  },
};

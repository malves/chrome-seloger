/**
 * Prix au m² Immo Data — volet DÉPARTEMENTAL (`geoLevel=department`,
 * appartements et maisons). Mis en cache en portée départementale
 * (`department_data`), partagé par toutes les communes du département.
 *
 * Provider cache-only (`display: false`) : l'orchestrateur fusionne ces séries
 * dans le bloc « Analyse de marché » de la facade `immo-data`.
 */

import ProviderSkipped from "./skipped.js";
import {
  buildMonthlyEvolution,
  fetchHistorySeries,
  historyRange,
} from "../../lib/immo-data-market.js";

export default {
  key: "immo-data-dept",
  scope: "department",
  group: "market",
  display: false,
  order: 27,
  ttlDays: 14,
  label: "Prix de marché (département)",
  source: "Immo Data",
  sourceUrl: "https://developer.immo-data.fr",

  async fetch({ inseeCode, deptCode, repositories, fetchJson, config }) {
    if (!config?.immoData?.apiKey) {
      throw new ProviderSkipped(
        "Clé Immo Data absente : renseignez IMMO_DATA_API_KEY."
      );
    }
    if (!deptCode) {
      throw new ProviderSkipped("Département indéterminé pour cette annonce.");
    }
    if (typeof fetchJson !== "function") {
      throw new Error("Client HTTP Immo Data indisponible.");
    }

    const communeCache = inseeCode
      ? repositories.enrichments.findCommune(inseeCode, "commune")
      : null;
    const deptName = communeCache?.data?.department?.name || null;
    const { startDate, endDate } = historyRange();

    const shared = {
      marketType: "sales",
      interval: "monthly",
      startDate,
      endDate,
      metric: "sqm_price",
      geoLevel: "department",
      code: deptCode,
    };

    const [apartmentRes, houseRes] = await Promise.allSettled([
      fetchHistorySeries(fetchJson, config, { ...shared, realtyType: "apartment" }),
      fetchHistorySeries(fetchJson, config, { ...shared, realtyType: "house" }),
    ]);

    const deptApartment = apartmentRes.status === "fulfilled" ? apartmentRes.value : [];
    const deptHouse = houseRes.status === "fulfilled" ? houseRes.value : [];
    if (!deptApartment.length && !deptHouse.length) {
      const firstError =
        apartmentRes.status === "rejected"
          ? apartmentRes.reason
          : houseRes.status === "rejected"
            ? houseRes.reason
            : null;
      if (firstError) throw firstError;
      throw new ProviderSkipped(
        "Aucune série de prix Immo Data pour ce département."
      );
    }

    return {
      department: { code: deptCode, name: deptName },
      by_type: {
        apartment: buildMonthlyEvolution(deptApartment, { propertyType: "apartment" }),
        house: buildMonthlyEvolution(deptHouse, { propertyType: "house" }),
      },
    };
  },
};

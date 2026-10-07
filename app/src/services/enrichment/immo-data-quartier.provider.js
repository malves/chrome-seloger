/**
 * Prix au m² Immo Data au niveau « grand quartier » (codes type `7511453`,
 * `2A00401`), pour l'adresse SAISIE sur l'annonce (portée annonce).
 *
 * Provider cache-only (`display: false`) : affiché à côté du rayon DVF dans le
 * comparatif « à l'adresse » du bloc Analyse de marché.
 *
 * La résolution du code grand quartier à partir du point dépend d'un endpoint
 * Immo Data à confirmer dans la doc (https://developer.immo-data.fr/docs) ;
 * tant que `config.immoData.quartierResolveUrl` n'est pas renseigné, le provider
 * s'ignore proprement sans bloquer le volet DVF.
 */

import { listingTerritory } from "../../lib/listing-territory.js";
import {
  authorizationHeader,
  buildMonthlyEvolution,
  fetchHistorySeries,
  formatPeriodFr,
  historyRange,
  latestCard,
  listingRealtyType,
} from "../../lib/immo-data-market.js";
import ProviderSkipped from "./skipped.js";

const SOURCE_URL = "https://developer.immo-data.fr";

/** Interpole un gabarit d'URL `{lat}` `{lng}` `{insee}` avec le point courant. */
function resolveUrl(template, { lat, lng, insee }) {
  return template
    .replace(/\{lat\}/g, encodeURIComponent(lat))
    .replace(/\{lng\}/g, encodeURIComponent(lng))
    .replace(/\{insee\}/g, encodeURIComponent(insee || ""));
}

/** Appelle l'endpoint de résolution et en extrait un code grand quartier. */
async function resolveGrandQuartier(fetchJson, config, point) {
  const template = config.immoData.quartierResolveUrl;
  if (!template) return null;
  const payload = await fetchJson(resolveUrl(template, point), {
    timeoutMs: config.immoData.timeoutMs,
    headers: {
      authorization: authorizationHeader(config.immoData.apiKey),
      "user-agent": config.immoData.userAgent,
    },
  });
  const code =
    payload?.code ||
    payload?.data?.code ||
    (Array.isArray(payload?.data) ? payload.data[0]?.code : null);
  return code ? String(code) : null;
}

export default {
  key: "immo-data-quartier",
  scope: "listing",
  group: "market",
  display: false,
  order: 29,
  ttlDays: 14,
  label: "Prix de marché (grand quartier)",
  source: "Immo Data",
  sourceUrl: SOURCE_URL,

  async fetch({ listing, inseeCode, fetchJson, config }) {
    if (!config?.immoData?.apiKey) {
      throw new ProviderSkipped(
        "Clé Immo Data absente : renseignez IMMO_DATA_API_KEY."
      );
    }

    const territory = listingTerritory(listing);
    if (territory.source !== "user") {
      throw new ProviderSkipped(
        "Renseignez l'adresse exacte du bien pour le prix du grand quartier."
      );
    }
    if (territory.lat == null || territory.lng == null) {
      throw new ProviderSkipped(
        "Adresse non géocodée : grand quartier indéterminé."
      );
    }

    const code = await resolveGrandQuartier(fetchJson, config, {
      lat: territory.lat,
      lng: territory.lng,
      insee: inseeCode,
    });
    if (!code) {
      throw new ProviderSkipped(
        "Grand quartier non résolu (endpoint Immo Data à configurer)."
      );
    }

    const { startDate, endDate } = historyRange();
    const type = listingRealtyType(listing);
    const shared = {
      marketType: "sales",
      interval: "monthly",
      startDate,
      endDate,
      metric: "sqm_price",
      geoLevel: config.immoData.quartierGeoLevel,
      code,
    };

    const [apartmentRes, houseRes] = await Promise.allSettled([
      fetchHistorySeries(fetchJson, config, { ...shared, realtyType: "apartment" }),
      fetchHistorySeries(fetchJson, config, { ...shared, realtyType: "house" }),
    ]);
    const apartment = apartmentRes.status === "fulfilled" ? apartmentRes.value : [];
    const house = houseRes.status === "fulfilled" ? houseRes.value : [];
    if (!apartment.length && !house.length) {
      throw new ProviderSkipped(
        "Aucune série de prix Immo Data pour ce grand quartier."
      );
    }

    const apartmentLatest = latestCard(apartment);
    const houseLatest = latestCard(house);
    const typeLatest =
      type === "house" ? houseLatest : type === "apartment" ? apartmentLatest : null;
    const referencePeriod =
      typeLatest?.period || apartmentLatest?.period || houseLatest?.period || null;

    return {
      source: "immo-data-quartier",
      quartier_code: code,
      property_type: type,
      reference_period: referencePeriod,
      reference_caption: referencePeriod
        ? `Grand quartier · ${formatPeriodFr(referencePeriod)}`
        : "Grand quartier",
      apartment: apartmentLatest,
      house: houseLatest,
      by_type: {
        apartment: buildMonthlyEvolution(apartment, { propertyType: "apartment" }),
        house: buildMonthlyEvolution(house, { propertyType: "house" }),
      },
    };
  },
};

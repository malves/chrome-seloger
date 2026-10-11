/**
 * Positionnement du prix d'une annonce face aux références de marché
 * disponibles, de la plus précise (ventes DVF autour de l'adresse) à la plus
 * large (commune). La référence retenue pour le verdict est la plus précise
 * dont l'échantillon est exploitable ; les autres restent affichées en
 * comparaison.
 */

import { priceVerdict } from "./dvf-stats.js";
import {
  formatPeriodFr,
  listingPricePerM2,
  listingRealtyType,
} from "./immo-data-market.js";
import { surfaceComparableReference } from "./market-adjustment.js";

const TYPE_PLURAL = { house: "maisons", apartment: "appartements" };

/** Libellés d'affichage (sans répéter maison/appartement sur la fiche). */
function radiusBasisLabels(radius, surfaceComp) {
  if (surfaceComp?.surface_filtered) {
    return {
      compare: `ventes comparables (${surfaceComp.min}–${surfaceComp.max} m²) à moins de ${radius.meters} m de l'adresse`,
      advice: "cette référence locale",
    };
  }
  return {
    compare: `ventes à moins de ${radius.meters} m de l'adresse`,
    advice: "cette référence locale",
  };
}

function round(value) {
  return Math.round(value);
}

function addressSourceLabel(listing) {
  if (!listing?.user_address) return null;
  return listing.user_address_source === "detected"
    ? "adresse détectée et validée"
    : "adresse saisie";
}

function buildReference(base, listing, listingM2) {
  const priceM2 = base.price_m2;
  const estimate = round(priceM2 * listing.surface);
  const estimate_p25 =
    base.p25_price_m2 != null ? round(base.p25_price_m2 * listing.surface) : null;
  const estimate_p75 =
    base.p75_price_m2 != null ? round(base.p75_price_m2 * listing.surface) : null;
  const verdict = priceVerdict(listingM2, priceM2);
  return {
    ...base,
    estimate,
    estimate_p25,
    estimate_p75,
    delta_amount: round(listing.price - estimate),
    delta_pct: Math.round(((listingM2 - priceM2) / priceM2) * 1000) / 10,
    index: verdict ? verdict.index : null,
    tone: verdict ? verdict.tone : "neutral",
    label: verdict ? verdict.label : null,
  };
}

/**
 * @param {object} args
 * @param {object} args.listing   annonce (prix, surface, type, adresse saisie)
 * @param {object} [args.commune] payload Immo Data communal (`commune.house|apartment`)
 * @param {object} [args.dvf]     payload `dvf-local` (rayon autour de l'adresse)
 * @param {object} [args.quartier] payload `immo-data-quartier`
 * @param {{ points: object[], label: string }} [args.market] série mensuelle du
 *   même type de bien servant à ramener les ventes DVF au prix d'aujourd'hui
 * @returns {object|null}
 */
export function buildPricePosition({ listing, commune, dvf, quartier, market }) {
  const listingM2 = listingPricePerM2(listing);
  const type = listingRealtyType(listing);
  if (listingM2 == null || !type) return null;

  const typePlural = TYPE_PLURAL[type];
  const address = listing.user_address ? String(listing.user_address).trim() : null;
  const sourceLabel = addressSourceLabel(listing);
  const candidates = [];

  const radius = dvf?.radius;
  if (radius?.median_price_m2 > 0 && dvf.property_type === type) {
    const comparable = surfaceComparableReference(
      radius,
      listing.surface,
      market?.points || null
    );
    const adjusted = comparable?.adjusted || null;
    const surfaceComp = comparable
      ? {
          ...comparable.surface_band,
          count_in_band: comparable.count_in_band,
          count_used: comparable.count_used,
          surface_filtered: comparable.surface_filtered,
          p25_price_m2: comparable.p25_price_m2,
          p75_price_m2: comparable.p75_price_m2,
        }
      : null;
    const priceM2 =
      comparable?.median_price_m2 ?? adjusted?.median_price_m2 ?? radius.median_price_m2;
    const basisLabels = radiusBasisLabels(radius, surfaceComp);
    candidates.push({
      key: "radius",
      scope_label: `Autour de l'adresse (${radius.meters} m)`,
      basis: basisLabels.compare,
      basis_compare: basisLabels.compare,
      basis_advice: basisLabels.advice,
      address,
      address_source: sourceLabel,
      price_m2: priceM2,
      p25_price_m2: comparable?.p25_price_m2 ?? null,
      p75_price_m2: comparable?.p75_price_m2 ?? null,
      surface_comparable: surfaceComp,
      adjustment: adjusted
        ? {
            label: market.label,
            median_raw: adjusted.median_raw,
            reference_period: formatPeriodFr(adjusted.reference_period),
            year_factors: adjusted.year_factors,
          }
        : null,
      adjusted_radius: comparable
        ? {
            ...radius,
            median_price_m2: priceM2,
            median_raw: adjusted?.median_raw ?? radius.median_price_m2,
            sales: comparable.sales,
            market_adjusted: Boolean(adjusted),
            surface_comparable_filter: surfaceComp,
          }
        : null,
      count: radius.count,
      years: radius.years,
      meters: radius.meters,
      widened: Boolean(radius.widened),
      reliable: Boolean(radius.enough),
    });
  }

  const quartierCard = quartier?.[type];
  if (quartierCard?.median_price_m2 > 0) {
    candidates.push({
      key: "quartier",
      scope_label: "Grand quartier",
      basis: "prix de marché du grand quartier de l'adresse",
      basis_compare: "prix de marché du grand quartier de l'adresse",
      basis_advice: "cette référence",
      address,
      address_source: sourceLabel,
      price_m2: quartierCard.median_price_m2,
      period: quartierCard.year || null,
      reliable: true,
    });
  }

  const communeCard = commune?.[type];
  if (communeCard?.median_price_m2 > 0) {
    const name = commune.name || listing.city || "la commune";
    candidates.push({
      key: "commune",
      scope_label: `Commune · ${name}`,
      basis: `prix de marché sur l'ensemble de ${name}`,
      basis_compare: `prix de marché sur l'ensemble de ${name}`,
      basis_advice: "cette référence communale",
      price_m2: communeCard.median_price_m2,
      period: communeCard.year || null,
      reliable: true,
    });
  }

  if (!candidates.length) return null;

  let references = candidates.map((c) => buildReference(c, listing, listingM2));
  const primary = references.find((r) => r.reliable) || references[0];
  primary.primary = true;
  // Les prix varient trop d'un quartier à l'autre : la moyenne communale
  // n'apporte rien dès qu'une référence à l'adresse est retenue.
  if (primary.key !== "commune") {
    references = references.filter((r) => r.key !== "commune");
  }

  return {
    listing_price: listing.price,
    listing_price_m2: listingM2,
    surface: listing.surface,
    type,
    type_plural: typePlural,
    primary,
    references,
    has_address: Boolean(address),
    has_radius: references.some((r) => r.key === "radius"),
  };
}

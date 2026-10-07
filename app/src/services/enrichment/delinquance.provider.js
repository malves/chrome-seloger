/**
 * Délinquance enregistrée (SSMSI) à l'échelle COMMUNALE, lieu de commission.
 *
 * Le benchmark départemental (séries et indices du département) est produit par
 * le provider `delinquance-dept` (portée départementale) et fusionné à
 * l'affichage par l'orchestrateur : ce provider ne calcule que la commune.
 */

import { listingTerritory } from "../../lib/listing-territory.js";
import {
  SSMSI_INDICATOR_GROUP,
  SSMSI_INDICATOR_LIST,
} from "../../lib/ssmsi-csv.js";
import ProviderSkipped from "./skipped.js";

const DATASET_URL =
  "https://www.data.gouv.fr/datasets/bases-statistiques-communale-departementale-et-regionale-de-la-delinquance-enregistree-par-la-police-et-la-gendarmerie-nationales";

function trendPercent(current, previous) {
  if (current == null || previous == null || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function buildIndicatorSeries(seriesByKey, key, label) {
  const rows = seriesByKey[key];
  if (!rows?.length) return null;
  const sorted = [...rows].sort((a, b) => b.year - a.year);
  const latest = sorted[0];
  const oldest = sorted.length >= 2 ? sorted[sorted.length - 1] : null;
  const canTrend =
    oldest &&
    latest.year > oldest.year &&
    latest.rate_per_1000 != null &&
    oldest.rate_per_1000 != null;
  const rateTrend = canTrend
    ? trendPercent(latest.rate_per_1000, oldest.rate_per_1000)
    : null;
  return {
    key,
    label,
    volume: latest.volume,
    rate_per_1000: latest.rate_per_1000,
    year: latest.year,
    trend_pct: rateTrend,
    trend_from_year: canTrend ? oldest.year : null,
    trend_to_year: canTrend ? latest.year : null,
    trend_from_rate_per_1000: canTrend ? oldest.rate_per_1000 : null,
    trend_to_rate_per_1000: canTrend ? latest.rate_per_1000 : null,
  };
}

/** Indice 100 = moyenne France (commune / national × 100), ou null. */
function nationalIndex(communeRate, nationalRate) {
  if (communeRate == null || nationalRate == null || nationalRate <= 0) {
    return null;
  }
  return Math.round((communeRate / nationalRate) * 100);
}

/** Moyenne des indices nationaux pour un sous-ensemble d'indicateurs. */
function averageIndexForGroup(indicators, group) {
  const indices = indicators
    .filter((ind) => SSMSI_INDICATOR_GROUP[ind.key] === group)
    .map((ind) => ind.national_index)
    .filter((v) => v != null);
  return indices.length
    ? Math.round(indices.reduce((sum, v) => sum + v, 0) / indices.length)
    : null;
}

function averageIndexAll(indicators) {
  const indices = indicators
    .map((ind) => ind.national_index)
    .filter((v) => v != null);
  return indices.length
    ? Math.round(indices.reduce((sum, v) => sum + v, 0) / indices.length)
    : null;
}

/** Libellé qualitatif à partir d'un indice (100 = moyenne France). */
function indexVerdict(index) {
  if (index == null) return { tone: "neutral", label: "Non comparable" };
  if (index <= 70) return { tone: "ok", label: "Bien plus sûr que la moyenne" };
  if (index <= 90) return { tone: "ok", label: "Plus sûr que la moyenne" };
  if (index <= 110) return { tone: "mid", label: "Proche de la moyenne nationale" };
  if (index <= 150) return { tone: "high", label: "Plus exposé que la moyenne" };
  return { tone: "high", label: "Bien plus exposé que la moyenne" };
}

export default {
  key: "delinquance",
  scope: "commune",
  order: 20,
  ttlDays: 365,
  label: "Délinquance",
  source: "SSMSI — Ministère de l'Intérieur",
  sourceUrl: DATASET_URL,

  async fetch({ listing, inseeCode, repositories }) {
    const ssmsi = repositories.ssmsi;
    if (!ssmsi?.hasData()) {
      throw new Error(
        "Base SSMSI non importée : lancez l'import depuis l'administration ou `npm run import:ssmsi`."
      );
    }
    if (!inseeCode) {
      throw new ProviderSkipped(
        "Commune inconnue : le code INSEE n'a pas encore été résolu."
      );
    }

    const territory = listingTerritory(listing);
    const referenceYear = ssmsi.maxYearForCommune(inseeCode);
    if (!referenceYear) {
      throw new ProviderSkipped(
        "Pas de donnée SSMSI diffusée pour cette commune (secret statistique ou commune non couverte)."
      );
    }

    const seriesByKey = ssmsi.findCommuneSeries(inseeCode, {
      yearLimit: referenceYear,
      yearsPerIndicator: 5,
    });

    const national = ssmsi.findNationalForYear(referenceYear) || {};

    const indicators = SSMSI_INDICATOR_LIST.map(({ key, label, group }) => {
      const ind = buildIndicatorSeries(seriesByKey, key, label);
      if (!ind) return null;
      const nationalRate = national[key] ?? null;
      const index = nationalIndex(ind.rate_per_1000, nationalRate);
      return {
        ...ind,
        group,
        national_rate: nationalRate,
        national_index: index,
      };
    }).filter(Boolean);

    if (!indicators.length) {
      throw new ProviderSkipped(
        "Pas de donnée SSMSI diffusée pour cette commune (secret statistique ou commune non couverte)."
      );
    }

    const personsIndex = averageIndexForGroup(indicators, "personnes");
    const propertyIndex = averageIndexForGroup(indicators, "biens");
    const overallIndex = averageIndexAll(indicators);
    const verdict = indexVerdict(overallIndex);
    const indexBasis = indicators.filter((ind) => ind.national_index != null).length;

    const communeCache = repositories.enrichments.findCommune(inseeCode, "commune");
    const importMeta = ssmsi.importMeta();

    return {
      insee_code: inseeCode,
      commune_name: communeCache?.data?.name || null,
      territory_source: territory.source,
      reference_year: referenceYear,
      score: {
        index: overallIndex,
        persons_index: personsIndex,
        property_index: propertyIndex,
        tone: verdict.tone,
        label: verdict.label,
        basis: indexBasis,
        // Volet départemental fusionné à l'affichage (provider delinquance-dept).
        department_index: null,
        department_persons_index: null,
        department_property_index: null,
      },
      indicators,
      department_benchmark: [],
      import_meta: importMeta,
      ssmsi_needs_reimport: ssmsi.needsFullReimport(),
      disclaimer:
        "Faits enregistrés par la police et la gendarmerie, lieu de commission (pas l'adresse du bien). " +
        "Les petites communes peuvent ne pas être diffusées (secret statistique). " +
        "Indice 100 = moyenne nationale pour chaque type d'infraction ; le score global est la moyenne de ces indices (personnes et biens), sans pondération par gravité.",
    };
  },
};

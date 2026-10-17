/**
 * Évolution de la population communale (INSEE, API Melodi, sans clé).
 *
 * Jeu `DS_POPULATIONS_HISTORIQUES` : population sans doubles comptes (PSDC)
 * aux recensements 1968–1999, puis population municipale (PMUN) annuelle
 * depuis 2006. La série du département sert de comparaison (index base 100).
 */

import ProviderSkipped from "./skipped.js";

const BASE = "https://api.insee.fr/melodi/data/DS_POPULATIONS_HISTORIQUES";
const DATASET_URL =
  "https://catalogue-donnees.insee.fr/fr/catalogue/recherche/DS_POPULATIONS_HISTORIQUES";
const MEASURES = new Set(["PMUN", "PSDC"]);
const HORIZONS = [5, 10];

/** Points `{ year, population }` triés, PMUN prioritaire sur PSDC pour une même année. */
export function parseMelodiPopulation(json) {
  const byYear = new Map();
  for (const obs of json?.observations || []) {
    const measure = obs?.dimensions?.POPREF_MEASURE;
    if (!MEASURES.has(measure)) continue;
    const year = Number(obs.dimensions.TIME_PERIOD);
    const value = obs.measures?.OBS_VALUE_NIVEAU?.value;
    if (!Number.isInteger(year) || typeof value !== "number" || !isFinite(value)) {
      continue;
    }
    const existing = byYear.get(year);
    if (existing && existing.measure === "PMUN") continue;
    byYear.set(year, { year, population: Math.round(value), measure });
  }
  return [...byYear.values()]
    .sort((a, b) => a.year - b.year)
    .map(({ year, population }) => ({ year, population }));
}

function variationPercent(current, previous) {
  if (current == null || previous == null || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** Variations à 5 et 10 ans et depuis le premier recensement disponible. */
export function populationVariations(points) {
  if (!points.length) return {};
  const latest = points[points.length - 1];
  const variations = {};
  for (const years of HORIZONS) {
    const past = points.find((p) => p.year === latest.year - years);
    variations[years] = past ? variationPercent(latest.population, past.population) : null;
  }
  const first = points[0];
  variations.since_first =
    first.year < latest.year ? variationPercent(latest.population, first.population) : null;
  return variations;
}

/** Ajoute `index` (base 100 sur `baseYear`) à chaque point. */
function withIndex(points, baseYear) {
  const base = points.find((p) => p.year === baseYear)?.population;
  return points.map((p) => ({
    ...p,
    index: base ? Math.round((p.population / base) * 1000) / 10 : null,
  }));
}

async function fetchSeries(fetchJson, geo) {
  const json = await fetchJson(`${BASE}?GEO=${encodeURIComponent(geo)}&maxResult=500`);
  return parseMelodiPopulation(json);
}

export default {
  key: "population",
  scope: "commune",
  order: 22,
  ttlDays: 365,
  label: "Population",
  source: "INSEE — Populations municipales historiques",
  sourceUrl: DATASET_URL,

  async fetch({ inseeCode, deptCode, fetchJson, repositories, logger }) {
    if (!inseeCode) {
      throw new ProviderSkipped(
        "Commune inconnue : le code INSEE n'a pas encore été résolu."
      );
    }

    let communePoints;
    try {
      communePoints = await fetchSeries(fetchJson, `COM-${inseeCode}`);
    } catch (err) {
      if (/HTTP 400/.test(err.message)) {
        throw new ProviderSkipped(
          "Pas de série de population INSEE pour cette commune (arrondissement ou code non couvert)."
        );
      }
      throw err;
    }
    if (communePoints.length < 2) {
      throw new ProviderSkipped("Série de population INSEE indisponible pour cette commune.");
    }

    let deptPoints = [];
    if (deptCode) {
      try {
        deptPoints = await fetchSeries(fetchJson, `DEP-${deptCode}`);
      } catch (err) {
        logger?.warn?.(
          { deptCode, err: err.message },
          "population départementale indisponible"
        );
      }
    }

    const deptYears = new Set(deptPoints.map((p) => p.year));
    const baseYear =
      communePoints.find((p) => !deptPoints.length || deptYears.has(p.year))?.year ??
      communePoints[0].year;

    const communeCache = repositories?.enrichments?.findCommune(inseeCode, "commune");
    const department = communeCache?.data?.department || (deptCode ? { code: deptCode, name: null } : null);
    const latest = communePoints[communePoints.length - 1];

    return {
      insee_code: inseeCode,
      commune_name: communeCache?.data?.name || null,
      department: deptPoints.length ? department : null,
      base_year: baseYear,
      commune: {
        points: withIndex(communePoints, baseYear),
        variations: populationVariations(communePoints),
        latest,
        first: communePoints[0],
      },
      department_series: deptPoints.length
        ? {
            points: withIndex(deptPoints, baseYear),
            variations: populationVariations(deptPoints),
          }
        : null,
      disclaimer:
        "Population sans doubles comptes aux recensements de 1968 à 1999, population municipale annuelle depuis 2006. " +
        `Index base 100 en ${baseYear}.`,
    };
  },
};

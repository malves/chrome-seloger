/**
 * Délinquance enregistrée (SSMSI) à l'échelle DÉPARTEMENTALE : séries et indices
 * du département (100 = moyenne France). Mis en cache en portée départementale
 * (`department_data`), partagé par toutes les communes du département.
 *
 * Provider cache-only (`display: false`) : l'orchestrateur fusionne ce volet
 * dans le bloc « Délinquance » de la facade `delinquance`.
 */

import {
  SSMSI_INDICATOR_GROUP,
  SSMSI_INDICATOR_LIST,
} from "../../lib/ssmsi-csv.js";
import ProviderSkipped from "./skipped.js";

/** Indice 100 = moyenne France (taux département / national × 100), ou null. */
function nationalIndex(deptRate, nationalRate) {
  if (deptRate == null || nationalRate == null || nationalRate <= 0) return null;
  return Math.round((deptRate / nationalRate) * 100);
}

function averageIndex(rows) {
  const values = rows.map((row) => row.national_index).filter((v) => v != null);
  return values.length
    ? Math.round(values.reduce((sum, v) => sum + v, 0) / values.length)
    : null;
}

export default {
  key: "delinquance-dept",
  scope: "department",
  group: "territory",
  display: false,
  order: 21,
  ttlDays: 365,
  label: "Délinquance (département)",
  source: "SSMSI — Ministère de l'Intérieur",

  async fetch({ deptCode, repositories }) {
    const ssmsi = repositories.ssmsi;
    if (!ssmsi?.hasData()) {
      throw new Error(
        "Base SSMSI non importée : lancez l'import depuis l'administration ou `npm run import:ssmsi`."
      );
    }
    if (!deptCode) {
      throw new ProviderSkipped("Département indéterminé pour cette annonce.");
    }

    const depSeries = ssmsi.findDepartmentSeries(deptCode, { yearsPerIndicator: 1 });
    const years = Object.values(depSeries)
      .map((row) => row.year)
      .filter((y) => y != null);
    if (!years.length) {
      throw new ProviderSkipped(
        "Pas de donnée SSMSI diffusée pour ce département."
      );
    }
    const referenceYear = Math.max(...years);
    const national = ssmsi.findNationalForYear(referenceYear) || {};

    const benchmark = [];
    const indexRows = [];
    for (const { key, label, group } of SSMSI_INDICATOR_LIST) {
      const dep = depSeries[key];
      if (!dep) continue;
      benchmark.push({
        key,
        label,
        rate_per_1000: dep.rate_per_1000,
        year: dep.year,
      });
      const index = nationalIndex(dep.rate_per_1000, national[key] ?? null);
      if (index != null) indexRows.push({ key, national_index: index, group });
    }

    const personsRows = indexRows.filter(
      (row) => SSMSI_INDICATOR_GROUP[row.key] === "personnes"
    );
    const propertyRows = indexRows.filter(
      (row) => SSMSI_INDICATOR_GROUP[row.key] === "biens"
    );

    return {
      dept_code: deptCode,
      reference_year: referenceYear,
      score: {
        department_index: averageIndex(indexRows),
        department_persons_index: averageIndex(personsRows),
        department_property_index: averageIndex(propertyRows),
      },
      department_benchmark: benchmark,
    };
  },
};

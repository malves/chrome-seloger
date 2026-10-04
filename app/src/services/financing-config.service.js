/**
 * Taux forfaitaires du tableau de financement (niveau application).
 *
 * Valeurs par défaut dans `config.js` ; l'administration peut les surcharger
 * via la table `app_settings`. `config.financing` est la source runtime.
 */

import config from "../config.js";
import { parsePercent } from "./settings.service.js";

/** Défauts au démarrage (indépendants des surcharges runtime en mémoire). */
const DEFAULT_FINANCING_RATES = {
  notaryRateOld: config.financing.notaryRateOld,
  notaryRateNew: config.financing.notaryRateNew,
  guaranteeRate: config.financing.guaranteeRate,
  interestRate: config.financing.interestRate,
  insuranceRate: config.financing.insuranceRate,
  years: config.financing.years,
  debtRatio: config.financing.debtRatio,
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function positiveInt(value, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function decimalRate(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, 0, 1) : fallback;
}

/** Taux applicables (hors apport / travaux par annonce). */
export function financingRatesSnapshot() {
  const f = config.financing;
  return {
    notaryRateOld: f.notaryRateOld,
    notaryRateNew: f.notaryRateNew,
    guaranteeRate: f.guaranteeRate,
    interestRate: f.interestRate,
    insuranceRate: f.insuranceRate,
    years: f.years,
    debtRatio: f.debtRatio,
  };
}

/** Fusionne une valeur stockée avec les défauts de `config.js`. */
export function resolveFinancingRates(stored) {
  const base = DEFAULT_FINANCING_RATES;
  if (!stored || typeof stored !== "object") {
    return { ...base };
  }
  return {
    notaryRateOld: decimalRate(stored.notaryRateOld, base.notaryRateOld),
    notaryRateNew: decimalRate(stored.notaryRateNew, base.notaryRateNew),
    guaranteeRate: decimalRate(stored.guaranteeRate, base.guaranteeRate),
    interestRate: decimalRate(stored.interestRate, base.interestRate),
    insuranceRate: decimalRate(stored.insuranceRate, base.insuranceRate),
    years: clamp(positiveInt(stored.years, base.years) || base.years, 1, 40),
    debtRatio: decimalRate(stored.debtRatio, base.debtRatio),
  };
}

export function applyFinancingRates(rates) {
  Object.assign(config.financing, rates);
}

/** Charge les taux depuis la base et les applique à `config.financing`. */
export function loadFinancingRates(repositories) {
  const stored = repositories.appSettings.get("financing");
  applyFinancingRates(resolveFinancingRates(stored));
  return config.financing;
}

export function saveFinancingRates(repositories, rates) {
  const normalized = resolveFinancingRates(rates);
  repositories.appSettings.set("financing", normalized);
  applyFinancingRates(normalized);
  return normalized;
}

/** Lit le formulaire admin (pourcentages saisis, durée en années). */
export function readAdminFinancingForm(body, current) {
  return {
    notaryRateOld: parsePercent(body.notary_rate_old, current.notaryRateOld),
    notaryRateNew: parsePercent(body.notary_rate_new, current.notaryRateNew),
    guaranteeRate: parsePercent(body.guarantee_rate, current.guaranteeRate),
    interestRate: parsePercent(body.interest_rate, current.interestRate),
    insuranceRate: parsePercent(body.insurance_rate, current.insuranceRate),
    years: clamp(positiveInt(body.years, current.years) || current.years, 1, 40),
    debtRatio: parsePercent(body.debt_ratio, current.debtRatio),
  };
}

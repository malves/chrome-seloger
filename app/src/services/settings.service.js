/**
 * Paramètres du compte (colonne JSON `users.settings`).
 *
 * Les taux sont stockés en décimal (0,035 = 3,5 %) ; les formulaires
 * manipulent des pourcentages, la conversion se fait ici.
 */

import config from "../config.js";

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function positiveInt(value, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Lit un pourcentage saisi (« 3,5 ») et retourne un décimal (0,035). */
export function parsePercent(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(String(value).replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return fallback;
  return clamp(n / 100, 0, 1);
}

/** Lit un montant saisi en euros, espaces et symboles tolérés. */
export function parseAmount(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(
    String(value)
      .replace(/[^\d,.-]/g, "")
      .replace(",", ".")
  );
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.round(n);
}

export function defaultUserSettings() {
  return {
    financing: {
      downPayment: config.financing.downPayment,
      years: config.financing.years,
      interestRate: config.financing.interestRate,
      insuranceRate: config.financing.insuranceRate,
    },
  };
}

/** Paramètres de financement du compte, complétés par les valeurs de config. */
export function accountFinancingSettings(user) {
  const stored = user?.settings?.financing || {};
  const base = config.financing;
  return {
    downPayment: positiveInt(stored.downPayment, base.downPayment),
    years: clamp(positiveInt(stored.years, base.years) || base.years, 1, 40),
    interestRate: Number.isFinite(stored.interestRate)
      ? clamp(stored.interestRate, 0, 1)
      : base.interestRate,
    insuranceRate: Number.isFinite(stored.insuranceRate)
      ? clamp(stored.insuranceRate, 0, 1)
      : base.insuranceRate,
  };
}

/** Lit le formulaire des paramètres par défaut du compte. */
export function readAccountFinancingForm(body, current) {
  return {
    downPayment: parseAmount(body.down_payment, current.downPayment),
    years: clamp(positiveInt(body.years, current.years) || current.years, 1, 40),
    interestRate: parsePercent(body.interest_rate, current.interestRate),
    insuranceRate: parsePercent(body.insurance_rate, current.insuranceRate),
  };
}

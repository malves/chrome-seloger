/**
 * Paramètres du compte (colonne JSON `users.settings`).
 *
 * Les taux sont stockés en décimal (0,035 = 3,5 %) ; les formulaires
 * manipulent des pourcentages, la conversion se fait ici.
 */

import config from "../config.js";
import { formatPhone, isPhoneComplete, phoneDigits } from "../lib/phone-format.js";

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

export function defaultProfileSettings() {
  return {
    firstName: "",
    lastName: "",
    phone: "",
  };
}

export function defaultUserSettings() {
  return {
    financing: {
      downPayment: config.financing.downPayment,
      years: config.financing.years,
      interestRate: config.financing.interestRate,
      insuranceRate: config.financing.insuranceRate,
    },
    profile: defaultProfileSettings(),
  };
}

/** Identité optionnelle du compte (préremplissage des documents plus tard). */
export function userProfileSettings(settings = {}) {
  const profile = settings.profile ?? {};
  return {
    firstName: String(profile.firstName ?? "").trim(),
    lastName: String(profile.lastName ?? "").trim(),
    phone: formatPhone(profile.phone ?? ""),
  };
}

/** Lit le formulaire « Profil » des paramètres du compte. */
export function readProfileForm(body) {
  const firstName = String(body.first_name ?? "").trim().slice(0, 80);
  const lastName = String(body.last_name ?? "").trim().slice(0, 80);
  const phoneRaw = String(body.phone ?? "");
  const digits = phoneDigits(phoneRaw);
  let phone = "";
  if (digits) {
    phone = formatPhone(phoneRaw);
    if (!isPhoneComplete(phone)) {
      return {
        profile: { firstName, lastName, phone },
        error: "Le numéro de téléphone semble incomplet.",
      };
    }
  }
  return {
    profile: { firstName, lastName, phone },
    error: null,
  };
}

/**
 * Paramètres de financement par défaut des fiches : ceux de l'administration
 * (`config.financing`, surchargé par `app_settings`), pas un instantané par compte.
 */
export function accountFinancingSettings() {
  const base = config.financing;
  return {
    downPayment: base.downPayment,
    years: base.years,
    interestRate: base.interestRate,
    insuranceRate: base.insuranceRate,
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

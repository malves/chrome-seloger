/**
 * Tableau de financement : fonctions pures, aucun accès à la base.
 *
 * Les taux par défaut viennent de `config.js` ; aucun n'est écrit en dur ici.
 * Les montants sont en euros, les taux en décimal (0,035 = 3,5 %).
 */

import config from "../config.js";
import { parseAmount, parsePercent } from "./settings.service.js";

/**
 * Frais d'agence : nuls quand les honoraires sont déjà inclus dans le prix
 * affiché, ce qui est le cas le plus fréquent en France.
 */
export function agencyFees(price, agency) {
  if (!agency || agency.fees_included !== false) return 0;
  const percent = Number(agency.fees_percent);
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return price * (percent / 100);
}

export function notaryRate(isNewBuild, rates = config.financing) {
  return isNewBuild ? rates.notaryRateNew : rates.notaryRateOld;
}

/**
 * Mensualité d'un prêt amortissable à échéances constantes.
 * Le cas d'un taux nul est traité à part (division par zéro).
 */
export function monthlyPayment(principal, annualRate, years) {
  const months = Math.round(years * 12);
  if (!(principal > 0) || months <= 0) return 0;

  const monthlyRate = annualRate / 12;
  if (monthlyRate === 0) return principal / months;

  return (principal * monthlyRate) / (1 - (1 + monthlyRate) ** -months);
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Tableau d'amortissement mensuel, aligné sur `computeFinancing` (assurance
 * mensuelle constante sur la durée, dernière échéance ajustée).
 */
export function buildAmortizationSchedule(result) {
  const loanAmount = Number(result.loanAmount) || 0;
  const months = Math.max(0, Number(result.months) || 0);
  const interestRate = Math.max(0, Number(result.interestRate) || 0);
  const paymentExcludingInsurance =
    Number(result.paymentExcludingInsurance) || 0;
  const monthlyInsurance = Number(result.monthlyInsurance) || 0;

  if (!(loanAmount > 0) || months <= 0) {
    return {
      rows: [],
      totals: { principal: 0, interest: 0, insurance: 0, total: 0 },
    };
  }

  const monthlyRate = interestRate / 12;
  let balance = loanAmount;
  const rows = [];
  const totals = { principal: 0, interest: 0, insurance: 0, total: 0 };

  for (let month = 1; month <= months; month += 1) {
    const interest =
      monthlyRate === 0 ? 0 : roundMoney(balance * monthlyRate);
    let principal =
      month === months
        ? roundMoney(balance)
        : roundMoney(paymentExcludingInsurance - interest);
    if (principal > balance) principal = roundMoney(balance);

    const payment = roundMoney(principal + interest);
    const insurance = roundMoney(monthlyInsurance);
    const total = roundMoney(payment + insurance);
    balance = roundMoney(balance - principal);

    rows.push({
      month,
      principal,
      interest,
      insurance,
      payment,
      total,
      balance,
    });

    totals.principal = roundMoney(totals.principal + principal);
    totals.interest = roundMoney(totals.interest + interest);
    totals.insurance = roundMoney(totals.insurance + insurance);
    totals.total = roundMoney(totals.total + total);
  }

  return { rows, totals };
}

/**
 * Calcule l'ensemble du tableau.
 *
 * @param {object} input
 * @param {number} input.price          prix retenu (prix négocié ou prix affiché)
 * @param {boolean} input.isNewBuild    bien neuf : frais de notaire réduits
 * @param {object|null} input.agency    { fees_included, fees_percent }
 * @param {number} input.works          montant des travaux
 * @param {number} input.downPayment    apport
 * @param {number} input.years          durée en années
 * @param {number} input.interestRate   taux nominal annuel (décimal)
 * @param {number} input.insuranceRate  taux d'assurance annuel (décimal)
 * @param {object} [rates]              taux forfaitaires (config.financing)
 */
export function computeFinancing(input, rates = config.financing) {
  const price = Math.max(0, Number(input.price) || 0);
  const works = Math.max(0, Number(input.works) || 0);
  const downPayment = Math.max(0, Number(input.downPayment) || 0);
  const years = Math.max(0, Number(input.years) || 0);
  const interestRate = Math.max(0, Number(input.interestRate) || 0);
  const insuranceRate = Math.max(0, Number(input.insuranceRate) || 0);

  const appliedNotaryRate = notaryRate(Boolean(input.isNewBuild), rates);
  const notaryFees = price * appliedNotaryRate;
  const fees = agencyFees(price, input.agency);
  const totalCost = price + notaryFees + fees + works;

  // Un apport supérieur au coût du projet rend le prêt inutile.
  const baseAmount = Math.max(0, totalCost - downPayment);
  const guaranteeFees = baseAmount * rates.guaranteeRate;
  const loanAmount = baseAmount > 0 ? baseAmount + guaranteeFees : 0;

  const months = Math.round(years * 12);
  const paymentExcludingInsurance = monthlyPayment(
    loanAmount,
    interestRate,
    years
  );
  const monthlyInsurance = (loanAmount * insuranceRate) / 12;
  const totalMonthly = paymentExcludingInsurance + monthlyInsurance;
  const creditCost = Math.max(0, totalMonthly * months - loanAmount);
  const minimumIncome = rates.debtRatio > 0 ? totalMonthly / rates.debtRatio : 0;

  return {
    price,
    notaryRate: appliedNotaryRate,
    notaryFees,
    agencyFees: fees,
    works,
    totalCost,
    downPayment,
    guaranteeRate: rates.guaranteeRate,
    guaranteeFees,
    loanAmount,
    years,
    months,
    interestRate,
    insuranceRate,
    paymentExcludingInsurance,
    monthlyInsurance,
    totalMonthly,
    creditCost,
    debtRatio: rates.debtRatio,
    minimumIncome,
    isFullyFunded: loanAmount === 0,
  };
}

/** Apport initial sur une fiche : part du prix affiché dans l'annonce. */
export function defaultDownPaymentForListing(
  listing,
  rates = config.financing
) {
  const rate = Number(rates.defaultDownPaymentRate);
  const price = Math.max(0, Number(listing?.price) || 0);
  if (!(price > 0) || !(rate > 0)) return 0;
  return Math.round(price * rate);
}

const FINANCING_PARAM_KEYS = [
  "negotiatedPrice",
  "works",
  "downPayment",
  "years",
  "interestRate",
  "insuranceRate",
];

/**
 * Paramètres retenus pour une annonce : valeurs par défaut (admin, prix de
 * l'annonce, travaux estimés), sauf celles que l'utilisateur a modifiées sur
 * la fiche (`stored.edited`).
 */
export function listingFinancingParams(
  listing,
  accountDefaults,
  stored = null,
  worksDefault = 0
) {
  const override = stored?.params || {};
  const edited = new Set(Array.isArray(stored?.edited) ? stored.edited : []);
  const pick = (key, fallback) =>
    edited.has(key) && Number.isFinite(Number(override[key]))
      ? Number(override[key])
      : fallback;

  return {
    negotiatedPrice: pick("negotiatedPrice", listing.price ?? 0),
    works: pick("works", Math.max(0, Number(worksDefault) || 0)),
    downPayment: pick(
      "downPayment",
      defaultDownPaymentForListing(listing)
    ),
    years: pick("years", accountDefaults.years),
    interestRate: pick("interestRate", accountDefaults.interestRate),
    insuranceRate: pick("insuranceRate", accountDefaults.insuranceRate),
  };
}

/** Champs modifiés par l'utilisateur, cumulés avec ceux des saisies précédentes. */
export function editedFinancingKeys(previous, current, next) {
  const edited = new Set(Array.isArray(previous) ? previous : []);
  for (const key of FINANCING_PARAM_KEYS) {
    if (Math.abs(Number(next[key]) - Number(current[key])) > 1e-9) edited.add(key);
  }
  return FINANCING_PARAM_KEYS.filter((key) => edited.has(key));
}

/** Lit le formulaire de la fiche (htmx) en repartant des paramètres courants. */
export function readListingFinancingForm(body, current) {
  return {
    negotiatedPrice: parseAmount(body.negotiated_price, current.negotiatedPrice),
    works: parseAmount(body.works, current.works),
    downPayment: parseAmount(body.down_payment, current.downPayment),
    years: Math.min(
      Math.max(Math.round(Number(body.years)) || current.years, 1),
      40
    ),
    interestRate: parsePercent(body.interest_rate, current.interestRate),
    insuranceRate: parsePercent(body.insurance_rate, current.insuranceRate),
  };
}

/** Applique des paramètres à une annonce et retourne le tableau complet. */
export function financingForListing(listing, params, rates = config.financing) {
  return computeFinancing(
    {
      price: params.negotiatedPrice,
      isNewBuild: Boolean(listing.is_new_build),
      agency: listing.agency || null,
      works: params.works,
      downPayment: params.downPayment,
      years: params.years,
      interestRate: params.interestRate,
      insuranceRate: params.insuranceRate,
    },
    rates
  );
}

export default {
  computeFinancing,
  monthlyPayment,
  buildAmortizationSchedule,
  defaultDownPaymentForListing,
  agencyFees,
  notaryRate,
  listingFinancingParams,
  editedFinancingKeys,
  readListingFinancingForm,
  financingForListing,
};

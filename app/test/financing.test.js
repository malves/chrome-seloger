import test from "node:test";
import assert from "node:assert/strict";
import { midpointWorksBudget } from "../src/lib/works/works-summary.js";
import {
  agencyFees,
  buildAmortizationSchedule,
  computeFinancing,
  defaultDownPaymentForListing,
  editedFinancingKeys,
  listingFinancingParams,
  monthlyPayment,
  notaryRate,
} from "../src/services/financing.service.js";

const RATES = {
  notaryRateOld: 0.08,
  notaryRateNew: 0.025,
  guaranteeRate: 0.015,
  debtRatio: 0.35,
};

test("mensualité d'un prêt classique", () => {
  // 200 000 € à 3,5 % sur 25 ans : mensualité de référence 1001,25 €.
  const payment = monthlyPayment(200_000, 0.035, 25);
  assert.ok(Math.abs(payment - 1001.25) < 0.01, `obtenu ${payment}`);
});

test("mensualité à taux nul : simple division du capital", () => {
  assert.equal(monthlyPayment(240_000, 0, 20), 1000);
  assert.equal(monthlyPayment(120_000, 0, 10), 1000);
});

test("mensualité nulle sans capital ou sans durée", () => {
  assert.equal(monthlyPayment(0, 0.035, 25), 0);
  assert.equal(monthlyPayment(200_000, 0.035, 0), 0);
});

test("midpointWorksBudget arrondit comme le budget travaux", () => {
  assert.equal(midpointWorksBudget(12_400, 27_800), 20_000);
  assert.equal(midpointWorksBudget(null, 15_000), 0);
});

test("travaux par défaut : milieu de la fourchette estimée", () => {
  assert.equal(
    listingFinancingParams(
      { price: 300_000 },
      { years: 25, interestRate: 0.035, insuranceRate: 0.003, downPayment: 0 },
      null,
      47_500
    ).works,
    47_500
  );
  assert.equal(
    listingFinancingParams(
      { price: 300_000 },
      { years: 25, interestRate: 0.035, insuranceRate: 0.003, downPayment: 0 },
      { params: { works: 12_000 }, edited: ["works"] },
      47_500
    ).works,
    12_000
  );
});

test("apport par défaut : 10 % du prix affiché de l'annonce", () => {
  assert.equal(
    defaultDownPaymentForListing({ price: 350_000 }),
    35_000
  );
  assert.equal(defaultDownPaymentForListing({ price: 0 }), 0);
  assert.equal(
    listingFinancingParams(
      { price: 400_000 },
      { years: 25, interestRate: 0.035, insuranceRate: 0.003, downPayment: 0 }
    ).downPayment,
    40_000
  );
  assert.equal(
    listingFinancingParams(
      { price: 400_000 },
      { years: 25, interestRate: 0.035, insuranceRate: 0.003, downPayment: 0 },
      { params: { downPayment: 12_000 }, edited: ["downPayment"] }
    ).downPayment,
    12_000
  );
});

test("paramètres enregistrés sans saisie utilisateur : défauts recalculés", () => {
  const defaults = { years: 20, interestRate: 0.035, insuranceRate: 0.003, downPayment: 0 };
  const params = listingFinancingParams(
    { price: 300_000 },
    defaults,
    { params: { years: 25, works: 0 } },
    30_000
  );
  assert.equal(params.years, 20);
  assert.equal(params.works, 30_000);
});

test("champs modifiés : seuls ceux qui changent sont retenus, cumulés", () => {
  const current = { negotiatedPrice: 300_000, works: 30_000, downPayment: 30_000, years: 20, interestRate: 0.035, insuranceRate: 0.003 };
  assert.deepEqual(
    editedFinancingKeys(["works"], current, { ...current, years: 22 }),
    ["works", "years"]
  );
  assert.deepEqual(editedFinancingKeys([], current, { ...current }), []);
});

test("frais de notaire selon ancien ou neuf", () => {
  assert.equal(notaryRate(false, RATES), 0.08);
  assert.equal(notaryRate(true, RATES), 0.025);
});

test("frais d'agence nuls quand les honoraires sont inclus", () => {
  assert.equal(agencyFees(300_000, { fees_included: true, fees_percent: 5 }), 0);
  assert.equal(agencyFees(300_000, null), 0);
  assert.equal(
    agencyFees(300_000, { fees_included: false, fees_percent: 4 }),
    12_000
  );
});

test("enchaînement complet des calculs", () => {
  const r = computeFinancing(
    {
      price: 300_000,
      isNewBuild: false,
      agency: { fees_included: true },
      works: 20_000,
      downPayment: 50_000,
      years: 25,
      interestRate: 0.035,
      insuranceRate: 0.003,
    },
    RATES
  );

  assert.equal(r.notaryFees, 24_000); // 300 000 × 8 %
  assert.equal(r.agencyFees, 0);
  assert.equal(r.totalCost, 344_000); // 300 000 + 24 000 + 0 + 20 000
  assert.equal(r.guaranteeFees, (344_000 - 50_000) * 0.015); // 4 410
  assert.equal(r.loanAmount, 294_000 + 4_410);
  assert.equal(r.months, 300);

  const expected = monthlyPayment(r.loanAmount, 0.035, 25);
  assert.equal(r.paymentExcludingInsurance, expected);
  assert.equal(r.monthlyInsurance, (r.loanAmount * 0.003) / 12);
  assert.equal(
    r.totalMonthly,
    r.paymentExcludingInsurance + r.monthlyInsurance
  );
  assert.equal(r.creditCost, r.totalMonthly * 300 - r.loanAmount);
  assert.equal(r.minimumIncome, r.totalMonthly / 0.35);
  assert.equal(r.isFullyFunded, false);
});

test("frais d'agence ajoutés quand ils sont exclus du prix", () => {
  const r = computeFinancing(
    {
      price: 200_000,
      isNewBuild: false,
      agency: { fees_included: false, fees_percent: 5 },
      works: 0,
      downPayment: 0,
      years: 20,
      interestRate: 0.03,
      insuranceRate: 0,
    },
    RATES
  );

  assert.equal(r.agencyFees, 10_000);
  assert.equal(r.totalCost, 200_000 + 16_000 + 10_000);
});

test("un apport supérieur au coût du projet supprime l'emprunt", () => {
  const r = computeFinancing(
    {
      price: 100_000,
      isNewBuild: true,
      agency: null,
      works: 0,
      downPayment: 500_000,
      years: 25,
      interestRate: 0.035,
      insuranceRate: 0.003,
    },
    RATES
  );

  assert.equal(r.loanAmount, 0);
  assert.equal(r.totalMonthly, 0);
  assert.equal(r.creditCost, 0);
  assert.equal(r.isFullyFunded, true);
});

test("frais de notaire réduits dans le neuf", () => {
  const r = computeFinancing(
    { price: 400_000, isNewBuild: true, years: 25, interestRate: 0.035 },
    RATES
  );
  assert.equal(r.notaryFees, 10_000); // 400 000 × 2,5 %
});

test("tableau d'amortissement : capital remboursé et solde final", () => {
  const r = computeFinancing(
    {
      price: 300_000,
      isNewBuild: false,
      agency: { fees_included: true },
      works: 20_000,
      downPayment: 50_000,
      years: 25,
      interestRate: 0.035,
      insuranceRate: 0.003,
    },
    RATES
  );
  const schedule = buildAmortizationSchedule(r);
  assert.equal(schedule.rows.length, r.months);
  assert.equal(schedule.rows[0].month, 1);
  assert.equal(schedule.rows[schedule.rows.length - 1].balance, 0);
  assert.equal(schedule.totals.principal, r.loanAmount);
  const creditCostParts = schedule.totals.interest + schedule.totals.insurance;
  assert.ok(
    Math.abs(creditCostParts - r.creditCost) < 1,
    `intérêts+assurance ${creditCostParts} vs coût crédit ${r.creditCost}`
  );
});

test("tableau d'amortissement vide sans emprunt", () => {
  const r = computeFinancing(
    {
      price: 100_000,
      isNewBuild: true,
      downPayment: 500_000,
      years: 25,
      interestRate: 0.035,
    },
    RATES
  );
  const schedule = buildAmortizationSchedule(r);
  assert.equal(schedule.rows.length, 0);
});

test("valeurs non numériques traitées comme zéro", () => {
  const r = computeFinancing(
    {
      price: "abc",
      works: null,
      downPayment: undefined,
      years: 25,
      interestRate: 0.035,
    },
    RATES
  );
  assert.equal(r.price, 0);
  assert.equal(r.loanAmount, 0);
  assert.equal(r.totalMonthly, 0);
});

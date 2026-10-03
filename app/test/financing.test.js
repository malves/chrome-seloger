import test from "node:test";
import assert from "node:assert/strict";
import {
  agencyFees,
  computeFinancing,
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

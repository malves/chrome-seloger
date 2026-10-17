/**
 * Tableau d'amortissement : fonctions pures (mensualité, différé partiel).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAmortization,
  sanitizeAmortizationInput,
  monthlyPayment,
} from "../src/lib/amortization.js";

const BASE = {
  amount: 200000,
  years: 20,
  interestRate: 0.03,
  insuranceRate: 0.003,
};

test("mensualité d'un prêt amortissable", () => {
  const p = monthlyPayment(200000, 0.03 / 12, 240);
  assert.ok(Math.abs(p - 1109.19) < 1, `mensualité inattendue : ${p}`);
});

test("sans montant ou durée, le tableau est vide", () => {
  assert.equal(buildAmortization({ amount: 0, years: 20 }).rows.length, 0);
  assert.equal(buildAmortization({ amount: 200000, years: 0 }).rows.length, 0);
});

test("le capital est intégralement remboursé en fin de tableau", () => {
  const { rows, totals } = buildAmortization(BASE);
  assert.equal(rows.length, 240);
  assert.equal(rows[rows.length - 1].balance, 0);
  assert.ok(Math.abs(totals.principal - BASE.amount) < 0.5);
});

test("différé partiel : X lignes sans capital, intérêts payés", () => {
  const deferred = 12;
  const { rows, summary } = buildAmortization({ ...BASE, deferredMonths: deferred });
  // Durée totale = différé + amortissement.
  assert.equal(rows.length, 240 + deferred);
  assert.equal(summary.deferredMonths, deferred);

  for (let i = 0; i < deferred; i += 1) {
    assert.equal(rows[i].deferred, true);
    assert.equal(rows[i].principal, 0, "aucun capital pendant le différé");
    assert.ok(rows[i].interest > 0, "les intérêts sont payés pendant le différé");
    // Le capital restant ne bouge pas pendant le différé.
    assert.equal(rows[i].balance, BASE.amount);
  }
  // Première échéance d'amortissement.
  assert.equal(rows[deferred].deferred, false);
  assert.ok(rows[deferred].principal > 0);
  // Le capital est soldé à la fin.
  assert.equal(rows[rows.length - 1].balance, 0);
});

test("le différé augmente le coût total du crédit (intérêts en plus)", () => {
  const base = buildAmortization(BASE);
  const withDeferral = buildAmortization({ ...BASE, deferredMonths: 12 });
  assert.ok(withDeferral.summary.totalInterest > base.summary.totalInterest);
});

test("sanitize borne les valeurs aberrantes", () => {
  const s = sanitizeAmortizationInput({
    amount: -5,
    years: 999,
    interestRate: 10,
    insuranceRate: 5,
    deferredMonths: -3,
    startDate: "pas une date",
  });
  assert.equal(s.amount, 0);
  assert.equal(s.years, 40);
  assert.equal(s.interestRate, 0.25);
  assert.equal(s.insuranceRate, 0.1);
  assert.equal(s.deferredMonths, 0);
  assert.equal(s.startDate, null);
});

test("dates d'échéance incrémentées mois par mois", () => {
  const { rows } = buildAmortization({ ...BASE, startDate: "2026-01-15" });
  assert.equal(rows[0].date, "2026-01-15");
  assert.equal(rows[1].date, "2026-02-15");
  assert.equal(rows[12].date, "2027-01-15");
});

test("fin de mois : le 31 janvier décale au dernier jour de février", () => {
  const { rows } = buildAmortization({ ...BASE, startDate: "2026-01-31" });
  assert.equal(rows[1].date, "2026-02-28");
  assert.equal(rows[2].date, "2026-03-31");
});

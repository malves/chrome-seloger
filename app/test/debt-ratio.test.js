/**
 * Taux d'endettement : calcul, valeurs manquantes ou estimées, page et
 * enregistrement automatique.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createTestApp, createUser, loginAgent, extractCsrf } from "./helpers.js";
import {
  annuity,
  borrowingCapacity,
  computeDebt,
  evaluateCharge,
  sanitizeDebtState,
} from "../src/lib/debt-ratio.js";

const NOW = "2026-10";

function state(overrides = {}) {
  return sanitizeDebtState({
    incomes: [{ id: "a", type: "salary", amount: 3000, frequency: "month" }],
    charges: [],
    ...overrides,
  });
}

/* ------------------------------ Calcul ------------------------------ */

test("le taux rapporte les charges aux revenus retenus", () => {
  const result = computeDebt(
    state({ charges: [{ id: "c", type: "consumer", monthly: 300 }] }),
    { now: NOW }
  );
  assert.equal(result.income, 3000);
  assert.equal(result.currentCharges, 300);
  assert.equal(result.ratioCurrent, 0.1);
  assert.equal(result.room, 750);
  assert.ok(Math.abs(result.restToLive - 2700) < 1e-9);
});

test("les loyers sont retenus à 70 % et les montants annuels ramenés au mois", () => {
  const result = computeDebt(
    state({
      incomes: [
        { id: "a", type: "salary", amount: 36000, frequency: "year" },
        { id: "b", type: "rental", amount: 1000 },
      ],
    })
  );
  assert.equal(result.income, 3000 + 700);
});

test("les allocations ne sont comptées que si l'utilisateur le demande", () => {
  const base = { id: "b", type: "benefits", amount: 400 };
  assert.equal(computeDebt(state({ incomes: [base] })).income, 0);
  assert.equal(
    computeDebt(state({ incomes: [{ ...base, counted: true }] })).income,
    400
  );
});

test("sans revenu, le taux reste inconnu au lieu de diviser par zéro", () => {
  const result = computeDebt(state({ incomes: [] }));
  assert.equal(result.ratioCurrent, null);
  assert.equal(result.capacity, 0);
});

test("une mensualité inconnue est estimée à partir du montant et de la durée", () => {
  const item = sanitizeDebtState({
    charges: [{ id: "c", type: "consumer", mode: "estimate", principal: 20000, years: 5 }],
  }).charges[0];
  const ev = evaluateCharge(item, { now: NOW });
  const expected = annuity(20000, 0.06, 5) + (20000 * 0.003) / 12;
  assert.ok(Math.abs(ev.monthly - expected) < 1e-9);
  assert.equal(ev.estimated, true);
  assert.equal(ev.rateUsed, 0.06);
});

test("une estimation incomplète n'est pas comptée mais signalée", () => {
  const item = sanitizeDebtState({
    charges: [{ id: "c", type: "mortgage", mode: "estimate", principal: 150000 }],
  }).charges[0];
  const ev = evaluateCharge(item, { now: NOW });
  assert.equal(ev.monthly, 0);
  assert.equal(ev.missing, true);
});

test("une date de fin inconnue n'empêche pas de compter le crédit", () => {
  const item = sanitizeDebtState({
    charges: [{ id: "c", type: "mortgage", monthly: 800 }],
  }).charges[0];
  const ev = evaluateCharge(item, { now: NOW });
  assert.equal(ev.monthly, 800);
  assert.equal(ev.endUnknown, true);
  assert.equal(ev.excluded, null);
});

test("la fin se déduit du début et de la durée", () => {
  const item = sanitizeDebtState({
    charges: [
      { id: "c", type: "consumer", mode: "estimate", principal: 10000, years: 4, start: "2023-01" },
    ],
  }).charges[0];
  const ev = evaluateCharge(item, { now: NOW });
  assert.equal(ev.end, "2026-12");
  assert.equal(ev.endEstimated, true);
  assert.equal(ev.monthsLeft, 3);
  assert.equal(ev.endingSoon, true);
});

test("un crédit terminé ou soldé à l'achat n'est plus compté", () => {
  const result = computeDebt(
    state({
      charges: [
        { id: "c", type: "consumer", monthly: 200, end: "2026-08" },
        { id: "d", type: "mortgage", monthly: 900, settled: true },
      ],
    }),
    { now: NOW }
  );
  assert.equal(result.currentCharges, 0);
  assert.equal(result.charges[0].excluded, "ended");
  assert.equal(result.charges[1].excluded, "settled");
});

test("le taux sans les crédits bientôt terminés est proposé", () => {
  const result = computeDebt(
    state({
      charges: [
        { id: "c", type: "consumer", monthly: 300, end: "2027-01" },
        { id: "d", type: "mortgage", monthly: 600 },
      ],
    }),
    { now: NOW }
  );
  assert.equal(result.ratioCurrent, 0.3);
  assert.equal(result.ratioWithoutEnding, 0.2);
});

test("l'assurance hors mensualité s'ajoute, et son absence est signalée", () => {
  const [withInsurance, without] = sanitizeDebtState({
    charges: [
      { id: "c", type: "mortgage", monthly: 800, insuranceIncluded: false, insurance: 40 },
      { id: "d", type: "mortgage", monthly: 800, insuranceIncluded: false },
    ],
  }).charges.map((item) => evaluateCharge(item, { now: NOW }));
  assert.equal(withInsurance.monthly, 840);
  assert.equal(without.monthly, 800);
  assert.equal(without.insuranceMissing, true);
});

test("la capacité d'emprunt correspond à la marge disponible", () => {
  const result = computeDebt(
    state({ project: { years: 20, rate: 0.035, insuranceRate: 0.003 } })
  );
  const capacity = borrowingCapacity(1050, 0.035, 20, 0.003);
  assert.ok(Math.abs(result.capacity - capacity) < 1e-6);
  const monthly = annuity(capacity, 0.035, 20) + (capacity * 0.003) / 12;
  assert.ok(Math.abs(monthly - 1050) < 1e-6);
});

test("la mensualité du projet s'ajoute au taux", () => {
  const result = computeDebt(
    state({
      charges: [{ id: "c", type: "consumer", monthly: 300 }],
      project: { monthly: 900 },
    })
  );
  assert.equal(result.ratioWithProject, 0.4);
  assert.equal(result.roomAfterProject, 1050 - 1200);
});

test("le nettoyage écarte les valeurs invalides", () => {
  const clean = sanitizeDebtState({
    incomes: [{ id: "<script>", type: "hack", amount: "-5", frequency: "week" }],
    charges: [{ type: "mortgage", monthly: "1 234,5", end: "2030-13", years: 99 }],
    project: { years: 3, rate: 2 },
  });
  assert.equal(clean.incomes[0].id, "item-1");
  assert.equal(clean.incomes[0].type, "other");
  assert.equal(clean.incomes[0].amount, null);
  assert.equal(clean.incomes[0].frequency, "month");
  assert.equal(clean.charges[0].monthly, 1234.5);
  assert.equal(clean.charges[0].end, "");
  assert.equal(clean.charges[0].years, 40);
  assert.equal(clean.project.years, 5);
  assert.equal(clean.project.rate, 0.2);
});

/* ------------------------------- Page ------------------------------- */

test("la page est réservée aux comptes connectés", async (t) => {
  const { app, close } = createTestApp();
  t.after(close);
  const { default: request } = await import("supertest");
  const res = await request(app).get("/endettement").expect(302);
  assert.match(res.headers.location, /^\/login\?next=%2Fendettement/);
});

test("la saisie est enregistrée et relue, sans fuiter vers un autre compte", async (t) => {
  const { app, repositories, close } = createTestApp();
  t.after(close);
  const alice = await createUser(repositories, "alice@example.com");
  await createUser(repositories, "bob@example.com");

  const agent = await loginAgent(app, "alice@example.com");
  const page = await agent.get("/endettement?mensualite=1250&source=Maison").expect(200);
  assert.match(page.text, /Mon taux d'endettement/);
  assert.match(page.text, /"prefill":\{"monthly":1250,"source":"Maison"\}/);

  await agent
    .post("/endettement")
    .set("X-CSRF-Token", extractCsrf(page.text))
    .send({
      state: {
        incomes: [{ id: "s1", type: "salary", amount: 2800 }],
        charges: [{ id: "c1", type: "consumer", monthly: 250 }],
      },
    })
    .expect(200, { ok: true });

  const saved = repositories.users.findById(alice.id).settings;
  assert.equal(saved.debt.incomes[0].amount, 2800);
  assert.equal(saved.debt.charges[0].monthly, 250);
  assert.ok(saved.financing, "les autres paramètres du compte sont conservés");

  const again = await agent.get("/endettement").expect(200);
  assert.match(again.text, /"amount":2800/);

  const bob = await loginAgent(app, "bob@example.com");
  const other = await bob.get("/endettement").expect(200);
  assert.doesNotMatch(other.text, /"amount":2800/);
});

test("l'enregistrement exige le jeton CSRF", async (t) => {
  const { app, repositories, close } = createTestApp();
  t.after(close);
  await createUser(repositories, "alice@example.com");
  const agent = await loginAgent(app, "alice@example.com");
  await agent.post("/endettement").send({ state: {} }).expect(403);
});

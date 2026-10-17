/**
 * Tableau d'amortissement d'un prêt amortissable à échéances constantes,
 * fonctions pures et testables (aucun accès base ni réseau).
 *
 * Nouveauté par rapport à `financing.service.js` : un **différé partiel** de
 * `deferredMonths` mois au début du crédit. Pendant ces mois, l'emprunteur
 * paie les intérêts (sur le capital emprunté, inchangé) et l'assurance, mais
 * aucun capital n'est remboursé. Le capital est ensuite amorti à échéances
 * constantes sur les `months` restants.
 *
 * Montants en euros, taux en décimal (0,035 = 3,5 %).
 */

/** Arrondi monétaire au centime. */
function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Mensualité amortissable (hors assurance) à échéances constantes.
 * Cas du taux nul traité à part (division par zéro).
 */
export function monthlyPayment(principal, monthlyRate, months) {
  if (!(principal > 0) || months <= 0) return 0;
  if (monthlyRate === 0) return principal / months;
  return (principal * monthlyRate) / (1 - (1 + monthlyRate) ** -months);
}

/**
 * Normalise les paramètres de saisie en valeurs sûres.
 *
 * @param {object} input
 * @param {number} input.amount          capital emprunté (€)
 * @param {number} input.years           durée totale d'amortissement (ans)
 * @param {number} input.interestRate    taux nominal annuel (décimal)
 * @param {number} input.insuranceRate   taux d'assurance annuel (décimal)
 * @param {number} [input.deferredMonths] mois de différé partiel (intérêts seuls)
 * @param {string} [input.startDate]     date de début (AAAA-MM-JJ)
 */
export function sanitizeAmortizationInput(input = {}) {
  const amount = Math.max(0, Number(input.amount) || 0);
  const years = Math.min(40, Math.max(0, Number(input.years) || 0));
  const interestRate = Math.min(0.25, Math.max(0, Number(input.interestRate) || 0));
  const insuranceRate = Math.min(0.1, Math.max(0, Number(input.insuranceRate) || 0));
  const deferredMonths = Math.min(
    120,
    Math.max(0, Math.trunc(Number(input.deferredMonths) || 0))
  );
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.startDate || ""))
    ? String(input.startDate)
    : null;
  return { amount, years, interestRate, insuranceRate, deferredMonths, startDate };
}

/**
 * Ajoute `n` mois à une date AAAA-MM-JJ, en gardant le jour (ou le dernier
 * jour du mois si celui-ci est plus court). Renvoie une chaîne AAAA-MM-JJ.
 */
function addMonths(startDate, n) {
  if (!startDate) return null;
  const [y, m, d] = startDate.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1 + n, 1));
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  const mm = String(month + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * Construit le tableau d'amortissement complet.
 *
 * Le tableau compte `deferredMonths + months` lignes : les premières ne
 * remboursent pas de capital (intérêts + assurance uniquement), les suivantes
 * amortissent le capital à échéances constantes. La dernière ligne est ajustée
 * pour solder exactement le capital.
 *
 * @returns {{
 *   rows: Array<object>,
 *   totals: { principal:number, interest:number, insurance:number, payment:number, total:number },
 *   summary: object
 * }}
 */
export function buildAmortization(rawInput) {
  const input = sanitizeAmortizationInput(rawInput);
  const { amount, years, interestRate, insuranceRate, deferredMonths, startDate } =
    input;

  const months = Math.round(years * 12);
  const empty = {
    rows: [],
    totals: { principal: 0, interest: 0, insurance: 0, payment: 0, total: 0 },
    summary: {
      amount,
      months: 0,
      deferredMonths: 0,
      interestRate,
      insuranceRate,
      startDate,
      endDate: startDate,
      monthlyInsurance: 0,
      amortizingPayment: 0,
      deferredMonthlyPayment: 0,
      firstMonthlyTotal: 0,
      amortizingMonthlyTotal: 0,
      totalInterest: 0,
      totalInsurance: 0,
      totalCreditCost: 0,
      totalRepaid: 0,
    },
  };
  if (!(amount > 0) || months <= 0) return empty;

  const monthlyRate = interestRate / 12;
  const monthlyInsurance = roundMoney((amount * insuranceRate) / 12);
  // Mensualité d'amortissement : le capital commence à être remboursé après le
  // différé, le capital emprunté restant inchangé pendant le différé.
  const amortizingPayment = monthlyPayment(amount, monthlyRate, months);

  const rows = [];
  const totals = { principal: 0, interest: 0, insurance: 0, payment: 0, total: 0 };
  let balance = amount;
  const totalRows = deferredMonths + months;

  for (let i = 1; i <= totalRows; i += 1) {
    const inDeferral = i <= deferredMonths;
    const interest = monthlyRate === 0 ? 0 : roundMoney(balance * monthlyRate);

    let principal;
    if (inDeferral) {
      principal = 0;
    } else {
      const amortIndex = i - deferredMonths; // 1..months
      principal =
        amortIndex === months
          ? roundMoney(balance)
          : roundMoney(amortizingPayment - interest);
      if (principal > balance) principal = roundMoney(balance);
      if (principal < 0) principal = 0;
    }

    const payment = roundMoney(principal + interest);
    const insurance = monthlyInsurance;
    const total = roundMoney(payment + insurance);
    balance = roundMoney(balance - principal);

    rows.push({
      index: i,
      date: addMonths(startDate, i - 1),
      deferred: inDeferral,
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
    totals.payment = roundMoney(totals.payment + payment);
    totals.total = roundMoney(totals.total + total);
  }

  const deferredMonthlyPayment = roundMoney(
    monthlyRate === 0 ? 0 : amount * monthlyRate
  );
  const amortizingMonthlyTotal = roundMoney(amortizingPayment + monthlyInsurance);
  const firstRow = rows[0];

  const summary = {
    amount,
    months,
    deferredMonths,
    interestRate,
    insuranceRate,
    startDate,
    endDate: addMonths(startDate, totalRows - 1),
    monthlyInsurance,
    amortizingPayment: roundMoney(amortizingPayment),
    deferredMonthlyPayment,
    firstMonthlyTotal: firstRow ? firstRow.total : 0,
    amortizingMonthlyTotal,
    totalInterest: totals.interest,
    totalInsurance: totals.insurance,
    totalCreditCost: roundMoney(totals.interest + totals.insurance),
    totalRepaid: totals.total,
  };

  return { rows, totals, summary };
}

export default { buildAmortization, sanitizeAmortizationInput, monthlyPayment };

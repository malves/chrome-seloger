/**
 * Taux d'endettement : fonctions pures, partagées entre le serveur et le
 * navigateur (`/public/js/debt-ratio.js`).
 *
 * Montants en euros par mois, taux en décimal (0,035 = 3,5 %), mois au
 * format « AAAA-MM ». Rien n'est obligatoire : une valeur absente est soit
 * ignorée, soit estimée, et le résultat le signale.
 */

/** Plafond du HCSF, assurance comprise. */
export const DEBT_LIMIT = 0.35;
/** Sous ce seuil, le dossier est jugé confortable. */
export const DEBT_COMFORT = 0.3;
/** Un crédit qui finit dans ce délai peut être ignoré par certaines banques. */
export const ENDING_SOON_MONTHS = 6;
/** Mensualité d'un crédit renouvelable estimée à partir du plafond autorisé. */
export const REVOLVING_MONTHLY_RATE = 0.03;
/** Assurance emprunteur annuelle retenue quand on estime une mensualité. */
export const ESTIMATE_INSURANCE_RATE = 0.003;

const MAX_ITEMS = 30;
const MAX_AMOUNT = 10_000_000;
/** Bornes de la part retenue réglable (loyers) : jamais moins de la moitié. */
const MIN_RETAINED = 0.5;
const MAX_RETAINED = 1;

export const INCOME_TYPES = {
  salary: {
    label: "Salaire",
    frequency: "month",
    retained: 1,
    hint: "Net avant impôt, tel qu'il figure sur votre fiche de paie. Vous empruntez à deux ? Ajoutez un salaire par personne.",
  },
  bonus: {
    label: "Primes, 13e mois",
    frequency: "year",
    retained: 1,
    hint: "Montant annuel. Les banques retiennent les primes régulières, souvent en moyenne sur 2 ou 3 ans.",
  },
  rental: {
    label: "Loyers perçus",
    frequency: "month",
    retained: 0.7,
    adjustable: true,
    hint: "Loyers hors charges, tels qu'ils figurent sur vos baux.",
  },
  pension: {
    label: "Retraite, pension",
    frequency: "month",
    retained: 1,
    hint: "Montant net avant impôt. Une pension alimentaire reçue compte aussi.",
  },
  freelance: {
    label: "Revenus d'indépendant",
    frequency: "year",
    retained: 1,
    hint: "Bénéfice annuel. Les banques font la moyenne des 2 ou 3 derniers bilans : une estimation suffit pour commencer.",
  },
  benefits: {
    label: "Allocations",
    frequency: "month",
    retained: 1,
    countedByDefault: false,
    hint: "La plupart des banques ne les retiennent pas. Cochez la case seulement si la vôtre les accepte.",
  },
  other: {
    label: "Autre revenu",
    frequency: "month",
    retained: 1,
    hint: "Tout revenu régulier et durable.",
  },
};

export const CHARGE_TYPES = {
  mortgage: {
    label: "Crédit immobilier",
    kind: "loan",
    rate: 0.035,
    hint: "Résidence actuelle, investissement locatif, prêt travaux…",
  },
  consumer: {
    label: "Crédit auto, conso",
    kind: "loan",
    rate: 0.06,
    hint: "Prêt personnel, prêt auto, prêt étudiant…",
  },
  revolving: {
    label: "Crédit renouvelable",
    kind: "revolving",
    hint: "Réserve d'argent liée à une carte : elle compte même si vous ne l'utilisez pas.",
  },
  lease: {
    label: "LOA, LLD",
    kind: "lease",
    hint: "Location avec option d'achat ou longue durée : le loyer mensuel est compté comme un crédit.",
  },
  alimony: {
    label: "Pension alimentaire versée",
    kind: "charge",
    hint: "Montant fixé par jugement ou convention.",
  },
  rent: {
    label: "Loyer conservé",
    kind: "charge",
    hint: "Seulement si vous restez locataire après l'achat (investissement locatif). Si vous achetez pour y habiter, votre loyer actuel disparaît : ne l'ajoutez pas.",
  },
  other: {
    label: "Autre charge",
    kind: "charge",
    hint: "Charge fixe et durable que la banque verra sur vos relevés.",
  },
};

export function defaultProject(defaults = {}) {
  return {
    monthly: null,
    source: "",
    years: Number(defaults.years) || 25,
    rate: Number.isFinite(Number(defaults.interestRate)) ? Number(defaults.interestRate) : 0.035,
    insuranceRate: Number.isFinite(Number(defaults.insuranceRate))
      ? Number(defaults.insuranceRate)
      : ESTIMATE_INSURANCE_RATE,
  };
}

export function emptyDebtState(defaults = {}) {
  return { version: 1, incomes: [], charges: [], project: defaultProject(defaults) };
}

/* ------------------------------ Lecture ------------------------------ */

function amount(value) {
  if (value === null || value === undefined || value === "") return null;
  const n =
    typeof value === "number"
      ? value
      : Number(String(value).replace(/[\s\u202f\u00a0€]/g, "").replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, MAX_AMOUNT);
}

function rate(value, max = 0.3) {
  const n = amount(value);
  return n === null ? null : Math.min(n, max);
}

function text(value, max = 60) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function month(value) {
  const s = String(value ?? "");
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? s : "";
}

function id(value, index) {
  const s = String(value ?? "");
  return /^[a-z0-9-]{1,24}$/i.test(s) ? s : `item-${index + 1}`;
}

function frequency(value, fallback) {
  return value === "year" || value === "month" ? value : fallback;
}

function retained(value, fallback) {
  const n = amount(value);
  if (n === null) return fallback;
  return Math.round(Math.min(Math.max(n, MIN_RETAINED), MAX_RETAINED) * 100) / 100;
}

/** Nettoie un état reçu du navigateur ou relu en base. */
export function sanitizeDebtState(input, defaults = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const incomes = (Array.isArray(raw.incomes) ? raw.incomes : [])
    .slice(0, MAX_ITEMS)
    .map((item, index) => {
      const type = Object.hasOwn(INCOME_TYPES, item?.type) ? item.type : "other";
      const meta = INCOME_TYPES[type];
      const income = {
        id: id(item?.id, index),
        type,
        label: text(item?.label),
        amount: amount(item?.amount),
        frequency: frequency(item?.frequency, meta.frequency),
        counted:
          typeof item?.counted === "boolean" ? item.counted : meta.countedByDefault !== false,
      };
      if (meta.adjustable) income.retained = retained(item?.retained, meta.retained);
      return income;
    });

  const charges = (Array.isArray(raw.charges) ? raw.charges : [])
    .slice(0, MAX_ITEMS)
    .map((item, index) => {
      const type = Object.hasOwn(CHARGE_TYPES, item?.type) ? item.type : "other";
      const years = amount(item?.years);
      return {
        id: id(item?.id, index),
        type,
        label: text(item?.label),
        mode: item?.mode === "estimate" ? "estimate" : "known",
        monthly: amount(item?.monthly),
        frequency: frequency(item?.frequency, "month"),
        insuranceIncluded: item?.insuranceIncluded !== false,
        insurance: amount(item?.insurance),
        principal: amount(item?.principal),
        years: years === null ? null : Math.min(years, 40),
        rate: rate(item?.rate),
        start: month(item?.start),
        end: month(item?.end),
        settled: item?.settled === true,
      };
    });

  const base = defaultProject(defaults);
  const p = raw.project && typeof raw.project === "object" ? raw.project : {};
  const projectYears = amount(p.years);
  const project = {
    monthly: amount(p.monthly),
    source: text(p.source, 120),
    years: projectYears ? Math.min(Math.max(Math.round(projectYears), 5), 30) : base.years,
    rate: rate(p.rate, 0.2) ?? base.rate,
    insuranceRate: rate(p.insuranceRate, 0.05) ?? base.insuranceRate,
  };

  return { version: 1, incomes, charges, project };
}

/* ------------------------------ Calcul ------------------------------- */

/** Mensualité d'un prêt amortissable à échéances constantes. */
export function annuity(principal, annualRate, years) {
  const months = Math.round(years * 12);
  if (!(principal > 0) || months <= 0) return 0;
  const r = annualRate / 12;
  if (r === 0) return principal / months;
  return (principal * r) / (1 - (1 + r) ** -months);
}

/** Capital empruntable pour une mensualité donnée, assurance comprise. */
export function borrowingCapacity(monthly, annualRate, years, insuranceRate = 0) {
  if (!(monthly > 0) || !(years > 0)) return 0;
  const perEuro = annuity(1, annualRate, years) + insuranceRate / 12;
  return perEuro > 0 ? monthly / perEuro : 0;
}

function monthIndex(value) {
  const [y, m] = value.split("-").map(Number);
  return y * 12 + (m - 1);
}

function monthFromIndex(index) {
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** Mois courant au format « AAAA-MM ». */
export function currentMonth(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function perMonth(value, freq) {
  if (value === null) return 0;
  return freq === "year" ? value / 12 : value;
}

export function evaluateIncome(item) {
  const meta = INCOME_TYPES[item.type] || INCOME_TYPES.other;
  const gross = perMonth(item.amount, item.frequency);
  const share = meta.adjustable ? retained(item.retained, meta.retained) : meta.retained;
  const retainedRate = item.counted ? share : 0;
  return {
    id: item.id,
    gross,
    retainedRate,
    monthly: gross * retainedRate,
    missing: item.amount === null,
  };
}

/**
 * Évalue une charge : mensualité retenue, origine (saisie ou estimée), date de
 * fin connue ou déduite, et raison pour laquelle elle n'est pas comptée.
 */
export function evaluateCharge(item, { now = currentMonth() } = {}) {
  const meta = CHARGE_TYPES[item.type] || CHARGE_TYPES.other;
  const isLoan = meta.kind === "loan";
  const canEstimate = isLoan || meta.kind === "revolving";
  const estimate = canEstimate && item.mode === "estimate";

  let monthly = 0;
  let missing = false;
  let insuranceMissing = false;
  let rateUsed = null;

  if (estimate && meta.kind === "revolving") {
    monthly = (item.principal ?? 0) * REVOLVING_MONTHLY_RATE;
    missing = item.principal === null;
  } else if (estimate) {
    rateUsed = item.rate ?? meta.rate;
    if (item.principal && item.years) {
      monthly =
        annuity(item.principal, rateUsed, item.years) +
        (item.principal * ESTIMATE_INSURANCE_RATE) / 12;
    } else {
      missing = true;
    }
  } else {
    monthly = perMonth(item.monthly, canEstimate || meta.kind === "lease" ? "month" : item.frequency);
    missing = item.monthly === null;
    if (isLoan && !item.insuranceIncluded) {
      if (item.insurance === null) insuranceMissing = !missing;
      else monthly += item.insurance;
    }
  }

  let end = item.end || "";
  let endEstimated = false;
  if (!end && isLoan && estimate && item.start && item.years) {
    end = monthFromIndex(monthIndex(item.start) + Math.round(item.years * 12) - 1);
    endEstimated = true;
  }
  const monthsLeft = end ? monthIndex(end) - monthIndex(now) + 1 : null;

  let excluded = null;
  if (item.settled) excluded = "settled";
  else if (monthsLeft !== null && monthsLeft <= 0) excluded = "ended";

  return {
    id: item.id,
    kind: meta.kind,
    monthly: excluded ? 0 : monthly,
    rawMonthly: monthly,
    estimated: estimate && !missing,
    missing,
    insuranceMissing,
    rateUsed,
    end,
    endEstimated,
    endUnknown: !end && (isLoan || meta.kind === "lease"),
    monthsLeft,
    endingSoon: !excluded && monthsLeft !== null && monthsLeft <= ENDING_SOON_MONTHS,
    excluded,
  };
}

function ratio(charges, income) {
  return income > 0 ? charges / income : null;
}

/** Calcule l'ensemble du tableau à partir d'un état nettoyé. */
export function computeDebt(state, { now = currentMonth(), limit = DEBT_LIMIT } = {}) {
  const incomes = state.incomes.map(evaluateIncome);
  const charges = state.charges.map((item) => evaluateCharge(item, { now }));
  const project = state.project;

  const income = incomes.reduce((sum, i) => sum + i.monthly, 0);
  const currentCharges = charges.reduce((sum, c) => sum + c.monthly, 0);
  const endingSoonCharges = charges
    .filter((c) => c.endingSoon)
    .reduce((sum, c) => sum + c.monthly, 0);
  const projectMonthly = project.monthly ?? 0;
  const totalCharges = currentCharges + projectMonthly;

  const maxCharges = income * limit;
  const room = Math.max(0, maxCharges - currentCharges);

  return {
    incomes,
    charges,
    income,
    currentCharges,
    projectMonthly,
    totalCharges,
    ratioCurrent: ratio(currentCharges, income),
    ratioWithProject: project.monthly ? ratio(totalCharges, income) : null,
    ratioWithoutEnding: endingSoonCharges
      ? ratio(totalCharges - endingSoonCharges, income)
      : null,
    limit,
    maxCharges,
    room,
    roomAfterProject: maxCharges - totalCharges,
    capacity: borrowingCapacity(room, project.rate, project.years, project.insuranceRate),
    restToLive: income - totalCharges,
  };
}

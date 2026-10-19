/**
 * Édition d'une question de visite (administration) : lecture du formulaire
 * à plat, brouillon affiché par la vue, normalisation et validation.
 *
 * Verrous (la logique du code en dépend) :
 *   - `field`, `photo` et `showWhen` ne sont jamais modifiés par le formulaire ;
 *   - le type de réponse est figé pour une question liée à un champ ou dont le
 *     type n'est pas éditable (confirm_*, count_pair…) ;
 *   - la `value` d'une option existante est conservée (les réponses déjà
 *     enregistrées y font référence) ; seules les nouvelles options en reçoivent une.
 */

import { VISIT_SECTION_BY_ID, VISIT_THEME_BY_ID } from "./visit-questions.js";
import { VISIT_LEVELS } from "./visit-question-levels.js";

/** Types proposés à la création et modifiables ensuite. */
export const EDITABLE_INPUT_TYPES = [
  { value: "yesno", label: "Oui / Non" },
  { value: "choice", label: "Choix dans une liste" },
  { value: "number", label: "Nombre" },
  { value: "yesno_number", label: "Oui / Non puis montant" },
  { value: "scale", label: "Échelle (étoiles)" },
  { value: "text", label: "Texte libre" },
];
const EDITABLE_TYPE_SET = new Set(EDITABLE_INPUT_TYPES.map((t) => t.value));

export const INPUT_TYPE_LABELS = {
  ...Object.fromEntries(EDITABLE_INPUT_TYPES.map((t) => [t.value, t.label])),
  confirm_number: "Nombre à confirmer (valeur de l'annonce)",
  confirm_yesno: "Oui / Non à confirmer (valeur de l'annonce)",
  confirm_letter: "Lettre à confirmer (DPE, GES)",
  count_pair: "Deux compteurs",
};

export const AUDIENCES = [
  { value: "", label: "Tous les biens" },
  { value: "house", label: "Maison" },
  { value: "apartment", label: "Appartement" },
  { value: "copro", label: "Copropriété (appartements, maisons en copro)" },
];
const AUDIENCE_SET = new Set(AUDIENCES.map((a) => a.value).filter(Boolean));

/** Conditions des notes au bilan : `kind` + argument éventuel. */
export const SIGNAL_KINDS = [
  { value: "yes", label: "Réponse « Oui »", arg: null },
  { value: "no", label: "Réponse « Non »", arg: null },
  { value: "unknown", label: "« Je ne sais pas » / « À confirmer »", arg: null },
  { value: "answered", label: "Toute réponse", arg: null },
  { value: "value", label: "Option(s) choisie(s)", arg: "values" },
  { value: "gte", label: "Nombre supérieur ou égal à", arg: "number" },
  { value: "lte", label: "Nombre inférieur ou égal à", arg: "number" },
  { value: "corrected", label: "Valeur de l'annonce corrigée", arg: null },
  { value: "below_pct", label: "Valeur corrigée inférieure de N % à l'annonce", arg: "number" },
  { value: "count_gte", label: "Compteur supérieur ou égal à (coût multiplié par le compteur)", arg: "count" },
];
const SIGNAL_KIND_BY_ID = Object.fromEntries(SIGNAL_KINDS.map((k) => [k.value, k]));

export const SIGNAL_TONES = [
  { value: "ok", label: "Favorable" },
  { value: "info", label: "Information" },
  { value: "warn", label: "Vigilance" },
  { value: "danger", label: "Alerte" },
];
const TONE_SET = new Set(SIGNAL_TONES.map((t) => t.value));

export const SIGNAL_WHEN_RE =
  /^(yes|no|unknown|answered|corrected|value:[^,]+(,[^,]+)*|gte:-?\d+(\.\d+)?|lte:-?\d+(\.\d+)?|below_pct:\d+|count_gte:[a-z_]+:\d+)$/;

export const MAX_OPTIONS = 20;
export const MAX_SIGNALS = 12;
const MAX_QUESTION = 300;
const MAX_TIP = 800;
const MAX_LABEL = 120;
const MAX_SIGNAL_TEXT = 400;
const MAX_COST = 10_000_000;

function str(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Nombre saisi à la française (« 1 500,5 ») ; null si vide, NaN si invalide. */
export function parseFrNumber(value) {
  const raw = String(value ?? "").replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/** Identifiant d'option à partir du libellé (minuscules, sans accents). */
export function slugify(text, max = 40) {
  return (
    String(text || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, max) || "option"
  );
}

function indexedRows(body, prefix, keys) {
  const indexes = new Set();
  for (const key of Object.keys(body)) {
    for (const k of keys) {
      const m = key.startsWith(`${prefix}${k}_`) ? key.slice(prefix.length + k.length + 1) : null;
      if (m !== null && /^\d{1,3}$/.test(m)) indexes.add(Number(m));
    }
  }
  return [...indexes]
    .sort((a, b) => a - b)
    .map((i) => Object.fromEntries(keys.map((k) => [k, body[`${prefix}${k}_${i}`]])));
}

/**
 * Corps urlencoded à plat → brouillon structuré (chaînes brutes).
 * Options : `opt_value_N`, `opt_label_N`, `opt_other_N` ; notes :
 * `sig_kind_N`, `sig_arg_N`, `sig_tone_N`, `sig_text_N`, `sig_cost_min_N`,
 * `sig_cost_max_N`, `sig_lever_N` (N = ordre d'affichage).
 */
export function readQuestionForm(body) {
  const src = body && typeof body === "object" ? body : {};
  const s = (k) => (typeof src[k] === "string" ? src[k] : "");
  return {
    question: s("question"),
    proTip: s("pro_tip"),
    section: s("section"),
    theme: s("theme"),
    audience: s("audience"),
    level: s("level"),
    inputType: s("input_type"),
    unit: s("unit"),
    min: s("min"),
    max: s("max"),
    decimals: s("decimals"),
    placeholder: s("placeholder"),
    unknownOption: s("unknown_option") === "1",
    unknownLabel: s("unknown_label"),
    options: indexedRows(src, "opt_", ["value", "label", "other"])
      .map((o) => ({
        value: typeof o.value === "string" ? o.value : "",
        label: typeof o.label === "string" ? o.label : "",
        other: o.other === "1",
      }))
      .filter((o) => o.value || o.label.trim()),
    signals: indexedRows(src, "sig_", ["kind", "arg", "tone", "text", "cost_min", "cost_max", "lever"])
      .map((g) => ({
        kind: typeof g.kind === "string" ? g.kind : "",
        arg: typeof g.arg === "string" ? g.arg : "",
        tone: typeof g.tone === "string" ? g.tone : "",
        text: typeof g.text === "string" ? g.text : "",
        costMin: typeof g.cost_min === "string" ? g.cost_min : "",
        costMax: typeof g.cost_max === "string" ? g.cost_max : "",
        lever: typeof g.lever === "string" ? g.lever : "",
      }))
      .filter((g) => g.text.trim() || g.arg.trim()),
  };
}

function numText(n) {
  return n === null || n === undefined || n === "" ? "" : String(n).replace(".", ",");
}

/** Question enregistrée → brouillon du formulaire. */
export function draftFromQuestion(q) {
  const input = (q && q.input) || { type: "yesno" };
  const options =
    input.type === "scale"
      ? (input.labels || []).map((label, i) => ({ value: String(i + 1), label, other: false }))
      : Array.isArray(input.options)
        ? input.options
            .filter((o) => o && typeof o === "object")
            .map((o) => ({ value: o.value, label: o.label, other: Boolean(o.other) }))
        : [];
  return {
    question: (q && q.question) || "",
    proTip: (q && q.proTip) || "",
    section: (q && q.section) || "avant",
    theme: (q && q.theme) || "negociation",
    audience: (q && q.audience) || "",
    level: q && q.essential ? "essential" : "expert",
    inputType: input.type,
    unit: input.unit || "",
    min: numText(input.min),
    max: numText(input.max),
    decimals: numText(input.decimals),
    placeholder: (input.type === "yesno_number" ? input.detailLabel : input.placeholder) || "",
    unknownOption: Boolean(input.unknownOption),
    unknownLabel: input.unknownLabel || "",
    options,
    signals: (Array.isArray(q && q.signals) ? q.signals : []).map((sig) => {
      const when = String(sig.when || "");
      const idx = when.indexOf(":");
      return {
        kind: idx === -1 ? when : when.slice(0, idx),
        arg: idx === -1 ? "" : when.slice(idx + 1),
        tone: sig.tone || "info",
        text: sig.text || "",
        costMin: Array.isArray(sig.cost) ? numText(sig.cost[0]) : "",
        costMax: Array.isArray(sig.cost) ? numText(sig.cost[1]) : "",
        lever: sig.lever ? String(sig.lever) : "",
      };
    }),
  };
}

/** Le type de réponse de cette question peut-il changer ? */
export function inputTypeLocked(existing) {
  if (!existing) return false;
  if (existing.field) return true;
  return !EDITABLE_TYPE_SET.has(existing.input && existing.input.type);
}

function readBound(draft, key, errors, label) {
  const n = parseFrNumber(draft[key]);
  if (Number.isNaN(n)) {
    errors[key] = `${label} : nombre invalide.`;
    return undefined;
  }
  return n === null ? undefined : n;
}

function buildNumberInput(base, draft, errors) {
  const input = { ...base };
  const unit = str(draft.unit, 20);
  if (unit) input.unit = unit;
  else delete input.unit;
  const min = readBound(draft, "min", errors, "Minimum");
  const max = readBound(draft, "max", errors, "Maximum");
  const decimals = readBound(draft, "decimals", errors, "Décimales");
  for (const [k, v] of [["min", min], ["max", max]]) {
    if (v === undefined) delete input[k];
    else input[k] = v;
  }
  if (decimals === undefined) delete input.decimals;
  else if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) {
    errors.decimals = "Décimales : entier entre 0 et 4.";
  } else input.decimals = decimals;
  if (input.min !== undefined && input.max !== undefined && input.min > input.max) {
    errors.max = "Le maximum doit être supérieur ou égal au minimum.";
  }
  return input;
}

function buildChoiceOptions(draft, existingOptions, errors) {
  const existingValues = new Set(
    (existingOptions || []).filter((o) => o && typeof o === "object").map((o) => o.value)
  );
  const rows = draft.options.slice(0, MAX_OPTIONS + 1);
  if (rows.length > MAX_OPTIONS) errors.options = `${MAX_OPTIONS} options au plus.`;
  const used = new Set();
  const options = [];
  rows.slice(0, MAX_OPTIONS).forEach((row) => {
    const label = str(row.label, MAX_LABEL);
    if (!label) {
      errors.options = "Chaque option doit avoir un libellé.";
      return;
    }
    let value = existingValues.has(row.value) && !used.has(row.value) ? row.value : null;
    if (!value) {
      const base = slugify(label);
      value = base;
      for (let i = 2; used.has(value) || existingValues.has(value); i += 1) value = `${base}_${i}`;
    }
    used.add(value);
    options.push(row.other ? { value, label, other: true } : { value, label });
  });
  if (options.length < 2 && !errors.options) errors.options = "Au moins deux options.";
  return options;
}

function buildInput(draft, existing, errors) {
  const locked = inputTypeLocked(existing);
  const type = locked ? existing.input.type : draft.inputType;
  if (!locked && !EDITABLE_TYPE_SET.has(type)) {
    errors.inputType = "Type de réponse inconnu.";
    return { type: "yesno" };
  }
  const prev = existing && existing.input && existing.input.type === type ? existing.input : null;
  const base = prev ? JSON.parse(JSON.stringify(prev)) : { type };

  switch (type) {
    case "yesno": {
      if (draft.unknownOption) {
        base.unknownOption = true;
        base.unknownLabel = str(draft.unknownLabel, 40) || "Je ne sais pas";
      } else {
        delete base.unknownOption;
        delete base.unknownLabel;
      }
      return base;
    }
    case "text": {
      const placeholder = str(draft.placeholder, 160);
      if (placeholder) base.placeholder = placeholder;
      else delete base.placeholder;
      return base;
    }
    case "number":
    case "confirm_number":
    case "confirm_yesno":
      return buildNumberInput(base, draft, errors);
    case "yesno_number": {
      const input = buildNumberInput(base, draft, errors);
      const detail = str(draft.placeholder, 80);
      if (detail) input.detailLabel = detail;
      else delete input.detailLabel;
      return input;
    }
    case "choice":
      base.options = buildChoiceOptions(draft, prev && prev.options, errors);
      return base;
    case "scale": {
      const labels = draft.options.map((o) => str(o.label, 40)).filter(Boolean);
      if (labels.length < 2 || labels.length > 10) {
        errors.options = "Une échelle compte de 2 à 10 crans, chacun avec un libellé.";
      }
      base.min = 1;
      base.max = Math.max(2, labels.length);
      base.labels = labels;
      return base;
    }
    default:
      return base;
  }
}

function buildSignals(draft, input, errors) {
  const out = [];
  const rows = draft.signals;
  if (rows.length > MAX_SIGNALS) errors.signals = `${MAX_SIGNALS} notes au plus.`;
  const optionValues = new Set(
    Array.isArray(input.options) ? input.options.map((o) => (typeof o === "object" ? o.value : o)) : []
  );
  rows.slice(0, MAX_SIGNALS).forEach((row, i) => {
    const n = i + 1;
    const kind = SIGNAL_KIND_BY_ID[row.kind];
    if (!kind) {
      errors.signals = `Note ${n} : condition inconnue.`;
      return;
    }
    let arg = str(row.arg, 200).replace(/\s*,\s*/g, ",");
    if (kind.arg === "number") arg = arg.replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
    const when = kind.arg ? `${kind.value}:${arg}` : kind.value;
    if (!SIGNAL_WHEN_RE.test(when)) {
      errors.signals = `Note ${n} : valeur de la condition invalide.`;
      return;
    }
    if (kind.value === "value" && optionValues.size) {
      const unknown = arg.split(",").filter((v) => !optionValues.has(v));
      if (unknown.length) {
        errors.signals = `Note ${n} : option inconnue (${unknown.join(", ")}).`;
        return;
      }
    }
    if (!TONE_SET.has(row.tone)) {
      errors.signals = `Note ${n} : tonalité inconnue.`;
      return;
    }
    const text = str(row.text, MAX_SIGNAL_TEXT);
    if (!text) {
      errors.signals = `Note ${n} : texte obligatoire.`;
      return;
    }
    const signal = { when, tone: row.tone, text };
    if (kind.value === "count_gte") signal.countFrom = arg.split(":")[0];
    const cMin = parseFrNumber(row.costMin);
    const cMax = parseFrNumber(row.costMax);
    if (cMin !== null || cMax !== null) {
      const lo = cMin === null ? cMax : cMin;
      const hi = cMax === null ? cMin : cMax;
      if (Number.isNaN(lo) || Number.isNaN(hi) || lo < 0 || hi > MAX_COST || lo > hi) {
        errors.signals = `Note ${n} : coût invalide (minimum ≤ maximum, en euros).`;
        return;
      }
      signal.cost = [Math.round(lo), Math.round(hi)];
    }
    const lever = parseFrNumber(row.lever);
    if (lever !== null) {
      if (!Number.isInteger(lever) || lever < 0 || lever > 3) {
        errors.signals = `Note ${n} : levier entre 0 et 3.`;
        return;
      }
      if (lever > 0) signal.lever = lever;
    }
    out.push(signal);
  });
  return out;
}

/**
 * Brouillon → question à enregistrer.
 * @param {object} draft sortie de readQuestionForm
 * @param {object|null} existing question en vigueur (null à la création)
 * @returns {{ ok: boolean, errors: Record<string,string>, section?: string, essential?: boolean, data?: object }}
 */
export function normalizeQuestion(draft, existing = null) {
  const errors = {};
  const question = str(draft.question, MAX_QUESTION + 1);
  if (!question) errors.question = "La question est obligatoire.";
  else if (question.length > MAX_QUESTION) errors.question = `${MAX_QUESTION} caractères au plus.`;
  const proTip = str(draft.proTip, MAX_TIP + 1);
  if (!proTip) errors.proTip = "Le conseil est obligatoire.";
  else if (proTip.length > MAX_TIP) errors.proTip = `${MAX_TIP} caractères au plus.`;
  if (!VISIT_SECTION_BY_ID[draft.section]) errors.section = "Étape inconnue.";
  if (!VISIT_THEME_BY_ID[draft.theme]) errors.theme = "Thème inconnu.";
  const audience = draft.audience || "";
  if (audience && !AUDIENCE_SET.has(audience)) errors.audience = "Public inconnu.";
  if (!VISIT_LEVELS.includes(draft.level)) errors.level = "Niveau inconnu.";

  const input = buildInput(draft, existing, errors);
  const signals = buildSignals(draft, input, errors);

  if (Object.keys(errors).length) return { ok: false, errors };

  const data = { question, proTip, theme: draft.theme, input };
  if (signals.length) data.signals = signals;
  if (audience) data.audience = audience;
  if (existing) {
    for (const key of ["field", "photo", "showWhen"]) {
      if (existing[key]) data[key] = JSON.parse(JSON.stringify(existing[key]));
    }
  }
  return { ok: true, errors, section: draft.section, essential: draft.level === "essential", data };
}

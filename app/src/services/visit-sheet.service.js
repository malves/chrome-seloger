/**
 * Fiche de preparation de visite : lecture/ecriture de la table
 * `listing_overrides` et derivation des corrections de champ (couche
 * utilisateur, provenance « visite »).
 *
 * Le client detient l'etat complet de la fiche et renvoie l'integralite des
 * reponses a chaque enregistrement (autosave), comme le plan de travaux.
 * On recalcule donc les corrections de champ a partir des reponses a chaque
 * sauvegarde (remplacement complet, jamais de fusion partielle fragile).
 */

import { nowIso } from "../lib/time.js";
import { FIELD_DEFS, resolveField } from "../lib/listing-field-provenance.js";
import { coerceFieldValue, parseListingFieldValue } from "../lib/listing-field-value.js";
import { QUESTION_BY_ID, fieldsFromAnswers } from "../lib/visit/visit-questions.js";
import { DEFAULT_VISIT_MODE, normalizeVisitMode } from "../lib/visit/visit-question-levels.js";

const MAX_ANSWERS = 300;
const MAX_TEXT = 2000;
const MAX_DATE = 40;

function defaultData() {
  return {
    fields: {},
    visit: {
      applyToSheet: null,
      mode: DEFAULT_VISIT_MODE,
      expertNudgeSeen: false,
      answers: {},
      startedAt: null,
      completedAt: null,
    },
  };
}

function cleanIsoString(value) {
  return typeof value === "string" && value ? value.slice(0, MAX_DATE) : null;
}

/** Nettoie et borne la map de reponses recue du client. */
function sanitizeAnswers(raw) {
  const answers = {};
  if (!raw || typeof raw !== "object") return answers;
  for (const [qid, ans] of Object.entries(raw).slice(0, MAX_ANSWERS)) {
    const q = QUESTION_BY_ID[qid];
    if (!q || !ans || typeof ans !== "object") continue;

    const response = typeof ans.response === "string" ? ans.response.slice(0, 24) : null;

    let value = ans.value;
    if (q.field) {
      value =
        value === null || value === undefined || value === ""
          ? null
          : coerceFieldValue(q.field, value);
    } else if (typeof value === "string") {
      value = value.trim().slice(0, MAX_TEXT) || null;
    } else if (typeof value === "number") {
      value = Number.isFinite(value) ? value : null;
    } else if (q.input && q.input.type === "count_pair" && value && typeof value === "object") {
      const cap = Number(q.input.max) > 0 ? Number(q.input.max) : 99;
      const rows = q.input.rows || [];
      const out = {};
      for (const row of rows) {
        const n = Number(value[row.key]);
        out[row.key] = Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), cap) : 0;
      }
      value = out;
    } else {
      value = null;
    }

    if (response == null && value == null) continue;
    answers[qid] = { response, value, answeredAt: cleanIsoString(ans.answeredAt) || nowIso() };
  }
  return answers;
}

/** Fusionne corrections « fiche » et champs dérivés de la visite (visite prioritaire). */
function mergeStoredFields(prevFields, visitFields) {
  const listingFields = {};
  for (const [key, entry] of Object.entries(prevFields || {})) {
    if (entry && entry.origin === "listing") listingFields[key] = entry;
  }
  return { ...listingFields, ...visitFields };
}

/** Retire les réponses de visite qui réinjecteraient ce champ à la prochaine sauvegarde. */
function clearVisitAnswersForField(answers, fieldKey) {
  const out = { ...(answers && typeof answers === "object" ? answers : {}) };
  for (const [qid] of Object.entries(out)) {
    const q = QUESTION_BY_ID[qid];
    if (q && q.field === fieldKey) delete out[qid];
  }
  return out;
}

export default function createVisitSheetService({ repositories }) {
  /** Etat normalise de la fiche (valeurs par defaut si rien n'est stocke). */
  function getSheet(listing) {
    const row = repositories.visitOverrides.find(listing.id);
    if (!row || !row.data) return { ...defaultData(), exists: false, updatedAt: null };
    const data = row.data;
    return {
      fields: data.fields && typeof data.fields === "object" ? data.fields : {},
      visit: {
        applyToSheet:
          data.visit && typeof data.visit.applyToSheet === "boolean"
            ? data.visit.applyToSheet
            : null,
        mode: normalizeVisitMode(data.visit && data.visit.mode),
        expertNudgeSeen: Boolean(data.visit && data.visit.expertNudgeSeen),
        answers:
          data.visit && data.visit.answers && typeof data.visit.answers === "object"
            ? data.visit.answers
            : {},
        startedAt: (data.visit && data.visit.startedAt) || null,
        completedAt: (data.visit && data.visit.completedAt) || null,
      },
      exists: true,
      updatedAt: row.updated_at,
    };
  }

  /** Valide, derive les corrections de champ et persiste. Renvoie l'etat sauvegarde. */
  function saveSheet(listing, payload) {
    const body = payload && typeof payload === "object" ? payload : {};
    const visitIn = body.visit && typeof body.visit === "object" ? body.visit : {};

    const answers = sanitizeAnswers(visitIn.answers);
    const applyToSheet =
      typeof visitIn.applyToSheet === "boolean" ? visitIn.applyToSheet : null;
    const visitFields = fieldsFromAnswers(answers, { origin: "visit" });

    const prev = getSheet(listing);
    const mode = visitIn.mode === undefined ? prev.visit.mode : normalizeVisitMode(visitIn.mode);
    const expertNudgeSeen =
      typeof visitIn.expertNudgeSeen === "boolean" ? visitIn.expertNudgeSeen : prev.visit.expertNudgeSeen;
    const fields = mergeStoredFields(prev.fields, visitFields);
    const data = {
      fields,
      visit: {
        applyToSheet,
        mode,
        expertNudgeSeen,
        answers,
        startedAt: prev.visit.startedAt || nowIso(),
        completedAt: cleanIsoString(visitIn.completedAt) || prev.visit.completedAt || null,
      },
    };
    repositories.visitOverrides.upsert(listing.id, data);
    return { ...data, exists: true };
  }

  /**
   * Corrections de champ a APPLIQUER a la fiche (resolveur, chiffrage).
   * Vide tant que l'utilisateur n'a pas accepte que ses reponses modifient la
   * fiche (`applyToSheet === true`).
   */
  function appliedOverrides(listing) {
    const sheet = getSheet(listing);
    if (!sheet.exists) return {};
    const fields = sheet.fields || {};
    const out = {};
    for (const [key, entry] of Object.entries(fields)) {
      if (entry && entry.origin === "listing") out[key] = entry;
    }
    if (sheet.visit.applyToSheet === true) {
      for (const [key, entry] of Object.entries(fields)) {
        if (entry && entry.origin === "visit") out[key] = entry;
      }
    }
    return out;
  }

  /**
   * Correction manuelle depuis la fiche annonce (effective immédiatement).
   * @param {object} ctx { listing, descriptionFacts }
   */
  function patchListingField(listing, fieldKey, rawValue, ctx = {}) {
    if (!FIELD_DEFS[fieldKey]) {
      return { ok: false, message: "Champ inconnu." };
    }
    const parsed = parseListingFieldValue(fieldKey, rawValue);
    if (!parsed.ok) return parsed;

    const prev = getSheet(listing);
    const fields = { ...(prev.fields || {}) };
    fields[fieldKey] = {
      value: parsed.value,
      source: "user",
      origin: "listing",
      confirmed: true,
      updatedAt: nowIso(),
    };

    const data = {
      fields,
      visit: prev.visit,
    };
    repositories.visitOverrides.upsert(listing.id, data);

    const overrides = appliedOverrides(listing);
    const resolved = resolveField(fieldKey, {
      listing,
      overrides,
      descriptionFacts: ctx.descriptionFacts ?? null,
    });

    return { ok: true, value: parsed.value, resolved, fields: data.fields };
  }

  /**
   * Rétablit la valeur d'origine d'un champ en supprimant la correction utilisateur.
   * @param {object} ctx { listing, descriptionFacts }
   */
  function restoreListingField(listing, fieldKey, ctx = {}) {
    if (!FIELD_DEFS[fieldKey]) {
      return { ok: false, message: "Champ inconnu." };
    }
    const prev = getSheet(listing);
    const fields = { ...(prev.fields || {}) };
    if (!(fieldKey in fields)) {
      return { ok: false, message: "Aucune correction à rétablir pour ce champ." };
    }
    delete fields[fieldKey];
    const data = {
      fields,
      visit: {
        ...prev.visit,
        answers: clearVisitAnswersForField(prev.visit.answers, fieldKey),
      },
    };
    repositories.visitOverrides.upsert(listing.id, data);

    const overrides = appliedOverrides(listing);
    const resolved = resolveField(fieldKey, {
      listing,
      overrides,
      descriptionFacts: ctx.descriptionFacts ?? null,
    });

    return { ok: true, resolved, fields: data.fields };
  }

  /**
   * Code postal corrigé (hors resolveur : il porte aussi la commune choisie).
   * `entry` à `null` rétablit la localisation de l'annonce.
   */
  function setPostalCodeOverride(listing, entry) {
    const prev = getSheet(listing);
    const fields = { ...(prev.fields || {}) };
    if (entry) fields.postal_code = entry;
    else delete fields.postal_code;
    repositories.visitOverrides.upsert(listing.id, { fields, visit: prev.visit });
  }

  return {
    getSheet,
    saveSheet,
    appliedOverrides,
    patchListingField,
    restoreListingField,
    setPostalCodeOverride,
  };
}

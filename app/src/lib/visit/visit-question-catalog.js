/**
 * Catalogue des questions de visite tel qu'enregistré en base
 * (`visit_questions`) : conversion lignes ↔ questions, import du catalogue
 * d'origine (visit-questions.js) et comparaison avec celui-ci.
 *
 * Une question du catalogue en vigueur a la même forme que celles de
 * visit-questions.js (id, section, essential, question, input, signals…),
 * plus `builtin` (issue du catalogue d'origine) et `position`.
 */

import {
  VISIT_QUESTIONS,
  VISIT_SECTIONS,
  VISIT_SECTION_BY_ID,
  VISIT_THEME_BY_ID,
  QUESTION_BY_ID,
} from "./visit-questions.js";
import { resolveQuestionLevels } from "./visit-question-levels.js";

export const AUDIENCE_LABELS = { copro: "Copropriété", house: "Maison", apartment: "Appartement" };

/** Clés stockées dans la colonne JSON `data`. */
export const CONTENT_KEYS = [
  "question",
  "proTip",
  "theme",
  "audience",
  "input",
  "signals",
  "showWhen",
  "photo",
  "field",
];

const SECTION_RANK = Object.fromEntries(VISIT_SECTIONS.map((s, i) => [s.id, i]));

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Contenu d'une question (sans organisation), copie profonde, clés vides omises. */
export function contentOf(q) {
  const out = {};
  for (const key of CONTENT_KEYS) {
    if (q && q[key] !== undefined && q[key] !== null) out[key] = clone(q[key]);
  }
  return out;
}

/** Question du catalogue d'origine portant cet id (ou null). */
export function builtinSeed(id) {
  return QUESTION_BY_ID[id] || null;
}

/**
 * Lignes à insérer quand la table est vide. Reprend le classement déjà
 * réglé dans `app_settings` (niveaux, ordre, étape).
 */
export function seedRows(storedLevels = null) {
  const resolved = resolveQuestionLevels(storedLevels);
  const rows = [];
  for (const sec of VISIT_SECTIONS) {
    (resolved.order[sec.id] || []).forEach((qid, position) => {
      const q = QUESTION_BY_ID[qid];
      rows.push({
        id: qid,
        section: sec.id,
        position,
        essential: resolved.levels[qid] === "essential",
        builtin: true,
        data: contentOf(q),
      });
    });
  }
  return rows;
}

/** Questions du catalogue d'origine absentes de la base (ajoutées au code depuis). */
export function missingBuiltinRows(existingIds) {
  const known = new Set(existingIds);
  return VISIT_QUESTIONS.filter((q) => !known.has(q.id)).map((q) => ({
    id: q.id,
    section: q.section,
    essential: Boolean(q.essential),
    builtin: true,
    data: contentOf(q),
  }));
}

function fromRow(row) {
  return {
    ...(row.data || {}),
    id: row.id,
    section: row.section,
    position: row.position,
    essential: Boolean(row.essential),
    builtin: Boolean(row.builtin),
    archivedAt: row.archivedAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function compareQuestions(a, b) {
  const sa = SECTION_RANK[a.section] ?? 99;
  const sb = SECTION_RANK[b.section] ?? 99;
  if (sa !== sb) return sa - sb;
  if (a.position !== b.position) return a.position - b.position;
  return a.id < b.id ? -1 : 1;
}

/** JSON à clés triées : l'ordre des clés ne compte pas dans la comparaison. */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Contenu modifié par rapport au catalogue d'origine ? */
export function isBuiltinModified(q) {
  const seed = q && q.builtin ? builtinSeed(q.id) : null;
  if (!seed) return false;
  return stableJson(contentOf(q)) !== stableJson(contentOf(seed));
}

/**
 * Catalogue en vigueur à partir des lignes du repository.
 * @returns {{ questions, byId, allById, archived, levels, order, sections, customized }}
 */
export function buildCatalog(activeRows = [], archivedRows = []) {
  const questions = activeRows
    .map(fromRow)
    .filter((q) => SECTION_RANK[q.section] !== undefined)
    .sort(compareQuestions);
  const archived = archivedRows.map(fromRow);
  const byId = Object.fromEntries(questions.map((q) => [q.id, q]));
  const allById = { ...Object.fromEntries(archived.map((q) => [q.id, q])), ...byId };

  const levels = {};
  const sections = {};
  const order = {};
  for (const sec of VISIT_SECTIONS) order[sec.id] = [];
  for (const q of questions) {
    levels[q.id] = q.essential ? "essential" : "expert";
    sections[q.id] = q.section;
    order[q.section].push(q.id);
  }

  return {
    questions,
    byId,
    allById,
    archived,
    levels,
    order,
    sections,
    customized: placementCustomized(questions),
  };
}

/** Niveau, étape ou ordre relatif des questions d'origine différents du catalogue ? */
function placementCustomized(questions) {
  const actual = {};
  for (const q of questions) {
    if (!q.builtin) continue;
    const seed = builtinSeed(q.id);
    if (!seed) continue;
    if (Boolean(seed.essential) !== q.essential || seed.section !== q.section) return true;
    (actual[q.section] = actual[q.section] || []).push(q.id);
  }
  for (const [secId, ids] of Object.entries(actual)) {
    const present = new Set(ids);
    const expected = VISIT_QUESTIONS.filter((s) => s.section === secId && present.has(s.id)).map((s) => s.id);
    if (expected.join(",") !== ids.join(",")) return true;
  }
  return false;
}

/**
 * Placements qui rétablissent l'étape, l'ordre et le niveau du catalogue
 * d'origine ; les questions créées restent dans leur étape, à la suite.
 */
export function resetPlacements(catalog) {
  const bySection = {};
  for (const sec of VISIT_SECTIONS) bySection[sec.id] = [];
  const active = new Set(catalog.questions.map((q) => q.id));
  for (const seed of VISIT_QUESTIONS) {
    if (active.has(seed.id) && catalog.byId[seed.id].builtin) {
      bySection[seed.section].push({ id: seed.id, section: seed.section, essential: Boolean(seed.essential) });
    }
  }
  for (const q of catalog.questions) {
    if (q.builtin && builtinSeed(q.id)) continue;
    bySection[q.section].push({ id: q.id, section: q.section, essential: q.essential });
  }
  return Object.values(bySection).flatMap((list) => list.map((p, position) => ({ ...p, position })));
}

function adminRow(q, catalog) {
  const seed = q.builtin ? builtinSeed(q.id) : null;
  const theme = VISIT_THEME_BY_ID[q.theme] || { label: q.theme, icon: "help" };
  const parent = q.showWhen ? catalog.allById[q.showWhen.questionId] : null;
  return {
    id: q.id,
    builtin: Boolean(seed),
    question: String(q.question || "").replace(/\{(rooms|claims)\}/g, "…"),
    theme,
    level: q.essential ? "essential" : "expert",
    audience: q.audience || null,
    audienceLabel: q.audience ? AUDIENCE_LABELS[q.audience] || q.audience : null,
    photo: q.photo ? (q.photo.required ? "required" : "hint") : null,
    parentQuestion: parent ? parent.question : null,
  };
}

/** View-model de la page admin : étapes, questions dans l'ordre, archives. */
export function buildQuestionsAdminView(catalog) {
  const sections = VISIT_SECTIONS.map((sec, index) => {
    const questions = (catalog.order[sec.id] || []).map((qid) => adminRow(catalog.byId[qid], catalog));
    return {
      id: sec.id,
      index: index + 1,
      label: sec.label,
      questions,
      essentials: questions.filter((q) => q.level === "essential").length,
    };
  });
  const all = sections.flatMap((s) => s.questions);
  const archived = catalog.archived.map((q) => ({
    ...adminRow(q, catalog),
    sectionLabel: (VISIT_SECTION_BY_ID[q.section] || {}).label || q.section,
    archivedAt: q.archivedAt,
  }));
  return {
    sections,
    archived,
    total: all.length,
    essentials: all.filter((q) => q.level === "essential").length,
    customized: catalog.customized,
  };
}

/**
 * Formulaire de classement (`readQuestionLevelsForm`) → placements à
 * enregistrer. Ids inconnus ou en double ignorés ; une question absente du
 * formulaire garde son étape, à la suite.
 */
export function placementsFromForm(catalog, form) {
  const levels = (form && form.level) || {};
  const rawOrder = (form && form.order) || {};
  const seen = new Set();
  const bySection = {};
  for (const sec of VISIT_SECTIONS) {
    const raw = rawOrder[sec.id];
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
    bySection[sec.id] = [];
    for (const id of list.map((s) => String(s).trim()).filter(Boolean)) {
      if (!catalog.byId[id] || seen.has(id)) continue;
      seen.add(id);
      bySection[sec.id].push(id);
    }
  }
  for (const q of catalog.questions) {
    if (!seen.has(q.id)) bySection[q.section].push(q.id);
  }
  return Object.entries(bySection).flatMap(([section, ids]) =>
    ids.map((id, position) => {
      const level = levels[id];
      const essential =
        level === "essential" ? true : level === "expert" ? false : catalog.byId[id].essential;
      return { id, section, position, essential };
    })
  );
}

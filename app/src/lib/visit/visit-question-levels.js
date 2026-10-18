/**
 * Niveau (Essentiel / Expert) et ordre des questions de la fiche de visite.
 *
 * Le catalogue (visit-questions.js) fournit les valeurs par défaut : drapeau
 * `essential` et ordre de déclaration dans chaque étape. L'administration peut
 * les surcharger (clé `visit_questions` de `app_settings`) ; on fusionne ici,
 * sans jamais faire confiance au stockage : id inconnus ignorés, questions
 * absentes de l'ordre stocké ajoutées en fin d'étape.
 */

import {
  VISIT_QUESTIONS,
  VISIT_SECTIONS,
  VISIT_THEME_BY_ID,
  QUESTION_BY_ID,
} from "./visit-questions.js";

export const VISIT_LEVELS = ["essential", "expert"];
export const VISIT_MODES = ["essential", "expert"];
export const DEFAULT_VISIT_MODE = "essential";

/** Niveau du catalogue (sans surcharge). */
export function catalogLevel(q) {
  return q && q.essential ? "essential" : "expert";
}

/** Ordre du catalogue : ids par étape. */
export function catalogOrder() {
  const order = {};
  for (const sec of VISIT_SECTIONS) order[sec.id] = [];
  for (const q of VISIT_QUESTIONS) {
    if (order[q.section]) order[q.section].push(q.id);
  }
  return order;
}

/**
 * @param {object|null} stored { levels?: { [qid]: level }, order?: { [sectionId]: qid[] } }
 * @returns {{ levels: Record<string,string>, order: Record<string,string[]>, customized: boolean }}
 */
export function resolveQuestionLevels(stored) {
  const src = stored && typeof stored === "object" ? stored : {};
  const storedLevels = src.levels && typeof src.levels === "object" ? src.levels : {};
  const storedOrder = src.order && typeof src.order === "object" ? src.order : {};

  const levels = {};
  let customized = false;
  for (const q of VISIT_QUESTIONS) {
    const override = storedLevels[q.id];
    const level = VISIT_LEVELS.includes(override) ? override : catalogLevel(q);
    if (level !== catalogLevel(q)) customized = true;
    levels[q.id] = level;
  }

  const defaults = catalogOrder();
  const order = {};
  for (const sec of VISIT_SECTIONS) {
    const fromStore = Array.isArray(storedOrder[sec.id]) ? storedOrder[sec.id] : [];
    const seen = new Set();
    const ids = [];
    for (const qid of fromStore) {
      const q = QUESTION_BY_ID[qid];
      if (!q || q.section !== sec.id || seen.has(qid)) continue;
      seen.add(qid);
      ids.push(qid);
    }
    for (const qid of defaults[sec.id]) {
      if (!seen.has(qid)) ids.push(qid);
    }
    if (ids.join(",") !== defaults[sec.id].join(",")) customized = true;
    order[sec.id] = ids;
  }

  return { levels, order, customized };
}

/**
 * Formulaire admin → valeur à stocker. `body.level[qid]` = niveau,
 * `body.order[sectionId]` = ids séparés par des virgules (ou tableau).
 * Ne garde que ce qui diffère du catalogue pour que les évolutions futures du
 * catalogue s'appliquent aux questions non retouchées.
 */
export function sanitizeQuestionLevelsForm(body) {
  const src = body && typeof body === "object" ? body : {};
  const rawLevels = src.level && typeof src.level === "object" ? src.level : {};
  const rawOrder = src.order && typeof src.order === "object" ? src.order : {};

  const levels = {};
  for (const [qid, level] of Object.entries(rawLevels)) {
    const q = QUESTION_BY_ID[qid];
    if (!q || !VISIT_LEVELS.includes(level)) continue;
    if (level !== catalogLevel(q)) levels[qid] = level;
  }

  const order = {};
  for (const sec of VISIT_SECTIONS) {
    const raw = rawOrder[sec.id];
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
    const ids = list.map((s) => String(s).trim()).filter(Boolean);
    if (ids.length) order[sec.id] = ids;
  }

  const resolved = resolveQuestionLevels({ levels, order });
  const defaults = catalogOrder();
  const keptOrder = {};
  for (const [secId, ids] of Object.entries(resolved.order)) {
    if (ids.join(",") !== defaults[secId].join(",")) keptOrder[secId] = ids;
  }
  return { levels, order: keptOrder };
}

/**
 * Corps urlencoded à plat (`level_<qid>`, `order_<sectionId>`) → forme
 * imbriquée attendue par `sanitizeQuestionLevelsForm`.
 */
export function readQuestionLevelsForm(body) {
  const level = {};
  const order = {};
  for (const [key, value] of Object.entries(body && typeof body === "object" ? body : {})) {
    if (typeof value !== "string") continue;
    if (key.startsWith("level_")) level[key.slice(6)] = value;
    else if (key.startsWith("order_")) order[key.slice(6)] = value;
  }
  return { level, order };
}

const AUDIENCE_LABELS = { copro: "Copropriété", house: "Maison", apartment: "Appartement" };

/** View-model de la page admin : étapes et questions dans l'ordre résolu. */
export function buildQuestionsAdminView(config) {
  const resolved = config || resolveQuestionLevels(null);
  const sections = VISIT_SECTIONS.map((sec, index) => {
    const questions = (resolved.order[sec.id] || []).map((qid) => {
      const q = QUESTION_BY_ID[qid];
      const theme = VISIT_THEME_BY_ID[q.theme] || { label: q.theme, icon: "help" };
      const parent = q.showWhen ? QUESTION_BY_ID[q.showWhen.questionId] : null;
      return {
        id: q.id,
        question: q.question.replace(/\{(rooms|claims)\}/g, "…"),
        theme,
        level: resolved.levels[q.id],
        catalogLevel: catalogLevel(q),
        audienceLabel: q.audience ? AUDIENCE_LABELS[q.audience] || q.audience : null,
        photo: q.photo ? (q.photo.required ? "required" : "hint") : null,
        parentQuestion: parent ? parent.question : null,
      };
    });
    return {
      id: sec.id,
      index: index + 1,
      label: sec.label,
      questions,
      essentials: questions.filter((q) => q.level === "essential").length,
    };
  });
  const all = sections.flatMap((s) => s.questions);
  return {
    sections,
    total: all.length,
    essentials: all.filter((q) => q.level === "essential").length,
    customized: resolved.customized,
  };
}

/** Mode d'affichage valide (repli sur le mode par défaut). */
export function normalizeVisitMode(value) {
  return VISIT_MODES.includes(value) ? value : DEFAULT_VISIT_MODE;
}

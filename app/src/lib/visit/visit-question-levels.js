/**
 * Niveau (Essentiel / Expert) et ordre des questions de la fiche de visite.
 *
 * Le catalogue (visit-questions.js) fournit les valeurs par défaut : drapeau
 * `essential` et ordre de déclaration dans chaque étape. Avant le passage en
 * base (`visit_questions`), l'administration les surchargeait dans la clé
 * `visit_questions` de `app_settings` : cette fusion ne sert plus qu'à
 * reprendre ce classement lors de l'import initial. On fusionne ici,
 * sans jamais faire confiance au stockage : id inconnus ignorés, questions
 * absentes de l'ordre stocké ajoutées en fin de leur étape du catalogue.
 * Une question peut être rangée dans une autre étape que celle du catalogue :
 * l'étape où elle figure dans l'ordre stocké l'emporte (première occurrence).
 */

import { VISIT_QUESTIONS, VISIT_SECTIONS, QUESTION_BY_ID } from "./visit-questions.js";

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
 * @returns {{ levels: Record<string,string>, order: Record<string,string[]>, sections: Record<string,string>, customized: boolean }}
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
  const sections = {};
  for (const sec of VISIT_SECTIONS) {
    const fromStore = Array.isArray(storedOrder[sec.id]) ? storedOrder[sec.id] : [];
    order[sec.id] = [];
    for (const qid of fromStore) {
      if (!QUESTION_BY_ID[qid] || sections[qid]) continue;
      sections[qid] = sec.id;
      order[sec.id].push(qid);
    }
  }
  for (const q of VISIT_QUESTIONS) {
    if (sections[q.id] || !order[q.section]) continue;
    sections[q.id] = q.section;
    order[q.section].push(q.id);
  }
  for (const sec of VISIT_SECTIONS) {
    if (order[sec.id].join(",") !== defaults[sec.id].join(",")) customized = true;
  }

  return { levels, order, sections, customized };
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

/** Mode d'affichage valide (repli sur le mode par défaut). */
export function normalizeVisitMode(value) {
  return VISIT_MODES.includes(value) ? value : DEFAULT_VISIT_MODE;
}

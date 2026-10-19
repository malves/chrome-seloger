/**
 * Catalogue des questions de visite, éditable depuis l'administration et
 * stocké dans `visit_questions`.
 *
 * Au premier accès, la table vide reçoit le catalogue d'origine
 * (lib/visit/visit-questions.js) avec le classement déjà réglé dans
 * `app_settings` (clé `visit_questions`, plus lue ensuite). Les questions
 * ajoutées plus tard au code sont insérées à la suite, sans toucher aux
 * lignes existantes, archivées comprises.
 *
 * Le catalogue résolu est mis en cache par connexion : plusieurs instances du
 * service (routeurs distincts) partagent le même cache, vidé à chaque écriture.
 */

import {
  buildCatalog,
  builtinSeed,
  contentOf,
  missingBuiltinRows,
  placementsFromForm,
  resetPlacements,
  seedRows,
} from "../lib/visit/visit-question-catalog.js";
import { normalizeQuestion, slugify } from "../lib/visit/visit-question-validate.js";

export const VISIT_QUESTIONS_SETTING_KEY = "visit_questions";

const caches = new WeakMap();

export default function createVisitQuestionsConfigService({ repositories }) {
  const repo = repositories.visitQuestions;
  if (!caches.has(repo)) caches.set(repo, { catalog: null, imported: false });
  const state = caches.get(repo);

  function ensureImported() {
    if (state.imported) return;
    repo.transaction(() => {
      if (repo.count() === 0) {
        const stored = repositories.appSettings.get(VISIT_QUESTIONS_SETTING_KEY);
        for (const row of seedRows(stored)) repo.insert(row);
      } else {
        for (const row of missingBuiltinRows(repo.allIds())) repo.insert(row);
      }
    });
    state.imported = true;
  }

  function invalidate() {
    state.catalog = null;
  }

  /** Catalogue en vigueur : { questions, byId, allById, archived, levels, order, sections, customized }. */
  function getCatalog() {
    if (state.catalog) return state.catalog;
    ensureImported();
    state.catalog = buildCatalog(repo.listActive(), repo.listArchived());
    return state.catalog;
  }

  function question(id) {
    return getCatalog().allById[id] || null;
  }

  function uniqueId(text) {
    const base = `custom_${slugify(text, 32)}`;
    let id = base;
    for (let i = 2; repo.byId(id); i += 1) id = `${base}_${i}`;
    return id;
  }

  /** @returns {{ ok: boolean, errors?: object, question?: object }} */
  function create(draft) {
    getCatalog();
    const result = normalizeQuestion(draft, null);
    if (!result.ok) return result;
    const id = uniqueId(result.data.question);
    repo.insert({
      id,
      section: result.section,
      essential: result.essential,
      builtin: false,
      data: result.data,
    });
    invalidate();
    return { ok: true, question: question(id) };
  }

  /** @returns {{ ok: boolean, errors?: object, question?: object } | null} null si inconnue */
  function update(id, draft) {
    const existing = question(id);
    if (!existing) return null;
    const result = normalizeQuestion(draft, existing);
    if (!result.ok) return result;
    const position =
      result.section === existing.section || existing.archivedAt
        ? existing.position
        : repo.nextPosition(result.section);
    repo.update(id, { section: result.section, position, essential: result.essential, data: result.data });
    invalidate();
    return { ok: true, question: question(id) };
  }

  function archive(id) {
    const done = repo.archive(id);
    invalidate();
    return done;
  }

  function restore(id) {
    const q = question(id);
    if (!q || !q.archivedAt) return false;
    const done = repo.restore(id, q.section);
    invalidate();
    return done;
  }

  /** Contenu d'origine (texte, réponses, notes) d'une question du catalogue. */
  function resetToBuiltin(id) {
    const q = question(id);
    const seed = q && q.builtin ? builtinSeed(id) : null;
    if (!seed) return false;
    repo.update(id, {
      section: q.section,
      position: q.position,
      essential: q.essential,
      data: contentOf(seed),
    });
    invalidate();
    return true;
  }

  /** Niveaux et ordre du formulaire de classement. */
  function saveLevelsAndOrder(form) {
    repo.reorder(placementsFromForm(getCatalog(), form));
    invalidate();
    return getCatalog();
  }

  /** Étape, ordre et niveau du catalogue d'origine (le contenu n'est pas touché). */
  function reset() {
    repo.reorder(resetPlacements(getCatalog()));
    invalidate();
    return getCatalog();
  }

  return {
    getCatalog,
    question,
    create,
    update,
    archive,
    restore,
    resetToBuiltin,
    saveLevelsAndOrder,
    reset,
  };
}

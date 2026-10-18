/**
 * Classement des questions de visite (Essentiel / Expert) et ordre dans chaque
 * étape, réglés depuis l'administration. Stocké dans `app_settings` (clé
 * `visit_questions`) ; seuls les écarts au catalogue sont conservés.
 */

import {
  resolveQuestionLevels,
  sanitizeQuestionLevelsForm,
} from "../lib/visit/visit-question-levels.js";

export const VISIT_QUESTIONS_SETTING_KEY = "visit_questions";

export default function createVisitQuestionsConfigService({ repositories }) {
  /** Configuration résolue : { levels, order, customized }. */
  function get() {
    return resolveQuestionLevels(repositories.appSettings.get(VISIT_QUESTIONS_SETTING_KEY));
  }

  function save(form) {
    repositories.appSettings.set(VISIT_QUESTIONS_SETTING_KEY, sanitizeQuestionLevelsForm(form));
    return get();
  }

  function reset() {
    repositories.appSettings.set(VISIT_QUESTIONS_SETTING_KEY, {});
    return get();
  }

  return { get, save, reset };
}

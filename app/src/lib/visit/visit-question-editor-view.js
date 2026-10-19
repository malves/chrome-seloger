/**
 * View-model du formulaire d'édition d'une question de visite (admin).
 * Le brouillon (`draft`, voir visit-question-validate.js) porte les valeurs
 * saisies : il est repris tel quel quand l'enregistrement échoue.
 */

import { VISIT_SECTIONS, VISIT_THEMES } from "./visit-questions.js";
import { builtinSeed, isBuiltinModified } from "./visit-question-catalog.js";
import {
  AUDIENCES,
  EDITABLE_INPUT_TYPES,
  INPUT_TYPE_LABELS,
  SIGNAL_KINDS,
  SIGNAL_TONES,
  inputTypeLocked,
} from "./visit-question-validate.js";
import { FIELD_DEFS } from "../listing-field-provenance.js";

/** Blocs du formulaire affichés selon le type de réponse. */
export const INPUT_TYPE_BLOCKS = {
  unknown: ["yesno"],
  number: ["number", "yesno_number", "confirm_number", "confirm_yesno"],
  placeholder: ["text", "yesno_number"],
  options: ["choice", "scale"],
};

export function emptyQuestionDraft() {
  return {
    question: "",
    proTip: "",
    section: VISIT_SECTIONS[0].id,
    theme: VISIT_THEMES[0].id,
    audience: "",
    level: "expert",
    inputType: "yesno",
    unit: "",
    min: "",
    max: "",
    decimals: "",
    placeholder: "",
    unknownOption: true,
    unknownLabel: "Je ne sais pas",
    options: [],
    signals: [],
  };
}

/**
 * @param {object} args
 * @param {object|null} args.question question en vigueur (null = création)
 * @param {object} args.draft valeurs du formulaire
 * @param {Record<string,string>} [args.errors]
 */
export function buildQuestionEditorView({ question = null, draft, errors = {} }) {
  const typeLocked = inputTypeLocked(question);
  const inputType = typeLocked ? question.input.type : draft.inputType;
  const field = question && question.field ? FIELD_DEFS[question.field] || { label: question.field } : null;
  const blocks = Object.fromEntries(
    Object.entries(INPUT_TYPE_BLOCKS).map(([key, types]) => [key, types.includes(inputType)])
  );
  return {
    isNew: !question,
    id: question ? question.id : null,
    action: question ? `/admin/visite/questions/${question.id}` : "/admin/visite/questions",
    builtin: Boolean(question && builtinSeed(question.id) && question.builtin),
    modified: Boolean(question && isBuiltinModified(question)),
    archived: Boolean(question && question.archivedAt),
    fieldLabel: field ? field.label : null,
    photoLinked: Boolean(question && question.photo),
    photoRequired: Boolean(question && question.photo && question.photo.required),
    conditional: Boolean(question && question.showWhen),
    typeLocked,
    inputType,
    inputTypeLabel: INPUT_TYPE_LABELS[inputType] || inputType,
    inputTypes: EDITABLE_INPUT_TYPES,
    blocks,
    blockTypes: Object.fromEntries(Object.entries(INPUT_TYPE_BLOCKS).map(([k, v]) => [k, v.join(" ")])),
    isScale: inputType === "scale",
    draft,
    errors,
    errorList: Object.values(errors),
    sections: VISIT_SECTIONS,
    themes: VISIT_THEMES,
    audiences: AUDIENCES,
    signalKinds: SIGNAL_KINDS,
    signalTones: SIGNAL_TONES,
  };
}

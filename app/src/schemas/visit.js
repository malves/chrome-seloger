import { z } from "zod";
import { VISIT_LEVELS, VISIT_MODES } from "../lib/visit/visit-question-levels.js";

/**
 * Enregistrement de la fiche de visite (PUT /listings/:id/visite). Les
 * réponses sont nettoyées question par question par le service ; on valide
 * ici la forme générale et les valeurs fermées.
 */
export const visitSheetBodySchema = z.object({
  visit: z
    .object({
      applyToSheet: z.boolean().nullable().optional(),
      mode: z.enum(VISIT_MODES).optional(),
      expertNudgeSeen: z.boolean().optional(),
      answers: z.record(z.string(), z.unknown()).optional(),
      completedAt: z.string().max(40).nullable().optional(),
    })
    .passthrough(),
});

/**
 * Formulaire admin d'une question (brouillon issu de readQuestionForm) : forme
 * et longueurs. Les règles métier (types, options, conditions, verrous) sont
 * appliquées par lib/visit/visit-question-validate.js.
 */
const draftText = (max) => z.string().max(max);
export const visitQuestionFormSchema = z.object({
  question: draftText(2000),
  proTip: draftText(4000),
  section: draftText(32),
  theme: draftText(32),
  audience: draftText(32),
  level: draftText(16),
  inputType: draftText(32),
  unit: draftText(100),
  min: draftText(40),
  max: draftText(40),
  decimals: draftText(10),
  placeholder: draftText(1000),
  unknownOption: z.boolean(),
  unknownLabel: draftText(200),
  options: z
    .array(z.object({ value: draftText(80), label: draftText(1000), other: z.boolean() }))
    .max(50),
  signals: z
    .array(
      z.object({
        kind: draftText(32),
        arg: draftText(400),
        tone: draftText(16),
        text: draftText(4000),
        costMin: draftText(40),
        costMax: draftText(40),
        lever: draftText(10),
      })
    )
    .max(50),
});

/** Identifiant de question dans l'URL. */
export const visitQuestionIdSchema = z.string().regex(/^[a-z0-9_]{1,80}$/);

/** Formulaire admin du classement des questions. */
export const visitQuestionsAdminSchema = z.object({
  level: z.record(z.string().max(64), z.enum(VISIT_LEVELS)).optional(),
  order: z.record(z.string().max(32), z.string().max(4000)).optional(),
});

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

/** Formulaire admin du classement des questions. */
export const visitQuestionsAdminSchema = z.object({
  level: z.record(z.string().max(64), z.enum(VISIT_LEVELS)).optional(),
  order: z.record(z.string().max(32), z.string().max(4000)).optional(),
});

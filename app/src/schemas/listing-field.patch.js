import { z } from "zod";
import { LISTING_INLINE_EDIT_FIELD_KEYS } from "../lib/listing-inline-edit-fields.js";

export const listingFieldKeyParamSchema = z
  .string()
  .refine((key) => LISTING_INLINE_EDIT_FIELD_KEYS.includes(key), {
    message: "Champ non modifiable depuis la fiche.",
  });

export const LISTING_SPEC_RESTORE_LOCATION_KEY = "location";

const restoreFlagSchema = z
  .union([z.literal(true), z.literal("true"), z.literal(1), z.literal("1")])
  .transform(() => true);

export const listingFieldPatchBodySchema = z.union([
  z.object({
    restore: restoreFlagSchema,
    primaryKey: z.string().optional(),
  }),
  z.object({ value: z.union([z.string(), z.number()]) }),
]);

/** Clés autorisées pour rétablir une valeur d'origine (champ ou localisation). */
export const listingFieldRestoreKeyParamSchema = z
  .string()
  .refine(
    (key) =>
      LISTING_INLINE_EDIT_FIELD_KEYS.includes(key) || key === LISTING_SPEC_RESTORE_LOCATION_KEY,
    { message: "Champ non modifiable depuis la fiche." }
  );

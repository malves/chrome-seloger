import { z } from "zod";
import { LISTING_INLINE_EDIT_FIELD_KEYS } from "../lib/listing-inline-edit-fields.js";

export const listingFieldKeyParamSchema = z
  .string()
  .refine((key) => LISTING_INLINE_EDIT_FIELD_KEYS.includes(key), {
    message: "Champ non modifiable depuis la fiche.",
  });

export const listingFieldPatchBodySchema = z.object({
  value: z.union([z.string(), z.number()]),
});

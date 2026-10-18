import { z } from "zod";

const postalCode = z.string().trim().regex(/^\d{5}$/, "Code postal à 5 chiffres.");

export const listingPostalCodeQuerySchema = z.object({
  postal_code: z.string().max(12).optional().default(""),
});

export const listingPostalCodeBodySchema = z.object({
  postal_code: postalCode,
  insee_code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^(\d{5}|2[AB]\d{3})$/, "Commune invalide."),
});

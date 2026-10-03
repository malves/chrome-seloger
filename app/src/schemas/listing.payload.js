/**
 * Schéma du JSON envoyé par l'extension (§7.1 de la spec).
 *
 * Principe : seuls `schema_version`, `source` et `url` sont obligatoires.
 * L'extension envoie ce qu'elle parvient à extraire ; un champ facultatif
 * invalide est ignoré plutôt que de faire échouer toute l'annonce. Les seules
 * erreurs bloquantes sont l'absence ou l'invalidité de ces trois champs.
 */

import { z } from "zod";

export const MAX_PHOTOS = 60;
export const MAX_DESCRIPTION = 20_000;

export function isHttpsUrl(value) {
  if (typeof value !== "string") return false;
  try {
    return new URL(value.trim()).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Rend un champ tolérant : `null`, chaîne vide et valeur invalide deviennent
 * `undefined`, donc simplement absents.
 */
function lenient(schema) {
  return z
    .preprocess(
      (value) =>
        value === null || value === undefined || value === "" ? undefined : value,
      schema.optional()
    )
    .catch(undefined);
}

const text = (max) =>
  lenient(
    z
      .string()
      .transform((s) => s.trim())
      .transform((s) => s.slice(0, max))
      .refine((s) => s.length > 0)
  );

const positiveNumber = (max) =>
  lenient(z.coerce.number().finite().positive().max(max));

const nonNegativeInt = (max) =>
  lenient(z.coerce.number().finite().int().min(0).max(max));

const energyGrade = lenient(
  z
    .string()
    .transform((s) => s.trim().toUpperCase())
    .pipe(z.enum(["A", "B", "C", "D", "E", "F", "G"]))
);

const flexibleBoolean = lenient(
  z.union([
    z.boolean(),
    z
      .string()
      .transform((s) => s.trim().toLowerCase())
      .pipe(z.enum(["true", "false", "1", "0", "oui", "non"]))
      .transform((s) => s === "true" || s === "1" || s === "oui"),
    z.number().transform((n) => n !== 0),
  ])
);

const plainObject = lenient(z.record(z.string(), z.unknown()));

const locationSchema = lenient(
  z.object({
    city: text(120),
    postal_code: lenient(
      z
        .string()
        .transform((s) => s.trim())
        .refine((s) => /^[0-9A-Za-z -]{2,10}$/.test(s))
    ),
    insee_code: lenient(
      z
        .string()
        .transform((s) => s.trim().toUpperCase())
        .refine((s) => /^(\d{5}|2[AB]\d{3})$/.test(s))
    ),
    lat: lenient(z.coerce.number().finite().min(-90).max(90)),
    lng: lenient(z.coerce.number().finite().min(-180).max(180)),
  })
);

const agencySchema = lenient(
  z.object({
    name: text(160),
    phone: text(40),
    fees_included: flexibleBoolean,
    fees_percent: lenient(z.coerce.number().finite().min(0).max(100)),
  })
);

/**
 * Les photos invalides sont écartées et la liste est tronquée : une URL
 * cassée ne doit pas empêcher d'enregistrer l'annonce.
 */
const photosSchema = z
  .preprocess(
    (value) => (Array.isArray(value) ? value : undefined),
    z.array(z.unknown()).optional()
  )
  .catch(undefined)
  .transform((list) =>
    (list || [])
      .filter(isHttpsUrl)
      .map((url) => String(url).trim())
      .filter((url, index, all) => all.indexOf(url) === index)
      .slice(0, MAX_PHOTOS)
  );

/**
 * Projets visés, par identifiant, slug ou nom. Les références inconnues sont
 * écartées plus tard, à la résolution : l'annonce est enregistrée quand même
 * et rejoint le projet par défaut.
 */
const projectRefsSchema = z
  .preprocess((value) => {
    if (value === null || value === undefined || value === "") return undefined;
    return Array.isArray(value) ? value : [value];
  }, z.array(z.unknown()).optional())
  .catch(undefined)
  .transform((list) =>
    (list || [])
      .filter((item) => typeof item === "string" || typeof item === "number")
      .map((item) => (typeof item === "number" ? item : item.trim()))
      .filter((item) => item !== "")
      .slice(0, 20)
  );

const featuresSchema = z
  .preprocess(
    (value) => (Array.isArray(value) ? value : undefined),
    z.array(z.unknown()).optional()
  )
  .catch(undefined)
  .transform((list) =>
    (list || [])
      .filter((item) => typeof item === "string" && item.trim())
      .map((item) => item.trim().slice(0, 60))
      .slice(0, 60)
  );

export const listingPayloadSchema = z.object({
  schema_version: z.coerce
    .number({ error: "schema_version est obligatoire." })
    .int()
    .min(1),

  source: z
    .string({ error: "source est obligatoire." })
    .transform((s) => s.trim().toLowerCase())
    .refine((s) => /^[a-z0-9][a-z0-9._-]{0,49}$/.test(s), {
      message: "source doit être un identifiant simple, ex. « seloger ».",
    }),

  url: z
    .string({ error: "url est obligatoire." })
    .transform((s) => s.trim())
    .refine(isHttpsUrl, { message: "url doit être une URL https valide." }),

  source_id: lenient(
    z
      .union([z.string(), z.number()])
      .transform((v) => String(v).trim())
      .refine((s) => s.length > 0 && s.length <= 100)
  ),

  captured_at: lenient(
    z
      .string()
      .transform((s) => s.trim())
      .refine((s) => !Number.isNaN(Date.parse(s)))
      .transform((s) => new Date(s).toISOString())
  ),

  transaction_type: z
    .preprocess(
      (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
      z.enum(["sale", "rent"]).optional()
    )
    .catch(undefined),

  property_type: z
    .preprocess(
      (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
      z.enum(["house", "apartment", "land", "other"]).optional()
    )
    .catch(undefined),

  title: text(300),
  description: text(MAX_DESCRIPTION),

  price: nonNegativeInt(1_000_000_000),
  surface: positiveNumber(100_000),
  land_surface: positiveNumber(10_000_000),
  rooms: nonNegativeInt(100),
  bedrooms: nonNegativeInt(100),
  floor: lenient(z.coerce.number().finite().int().min(-10).max(200)),
  year_built: lenient(
    z.coerce
      .number()
      .finite()
      .int()
      .min(800)
      .max(new Date().getFullYear() + 10)
  ),
  dpe: energyGrade,
  ges: energyGrade,
  // Valeurs chiffrées du DPE : consommation (kWhEP/m².an) et émissions
  // (kg CO₂/m².an). Facultatives, elles enrichissent l'affichage réglementaire.
  dpe_value: positiveNumber(100_000),
  ges_value: positiveNumber(100_000),
  is_new_build: flexibleBoolean,

  // Trois écritures acceptées pour le même besoin : l'extension envoie
  // indifféremment un identifiant, un nom ou une liste.
  projects: projectRefsSchema,
  project: projectRefsSchema,
  project_id: projectRefsSchema,

  location: locationSchema,
  photos: photosSchema,
  agency: agencySchema,
  features: featuresSchema,
  extension_data: plainObject,
  raw: plainObject,
});

/** Réunit `projects`, `project` et `project_id` en une seule liste. */
export function projectReferences(payload) {
  return [
    ...(payload.projects || []),
    ...(payload.project || []),
    ...(payload.project_id || []),
  ];
}

/** Transforme une `ZodError` en `details` exploitables côté extension. */
export function formatIssues(error) {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "(racine)",
    message: issue.message,
  }));
}

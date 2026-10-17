/**
 * Lignes « Caractéristiques » de la fiche annonce.
 *
 * Chaque ligne porte sa valeur affichée et sa provenance normalisée (`source`),
 * qu'elle vienne du resolveur (`resolveAll`), d'une colonne brute de l'annonce,
 * d'un calcul ou d'un référentiel public. L'édition inline est indépendante :
 * `fieldKey` n'est renseigné que pour les champs modifiables depuis la fiche.
 */

import { ORIGIN_LABELS, SOURCE_LABELS, SOURCE_SHORT } from "./listing-field-provenance.js";
import { fieldInputKind as resolveFieldInputKind } from "./listing-field-value.js";
import { listingSpecEditFieldKey } from "./listing-inline-edit-fields.js";

/** Champs pour lesquels 0 signifie « non renseigné » (l'étage 0 reste affiché). */
const ZERO_IS_EMPTY = new Set([
  "surface",
  "land_surface",
  "rooms",
  "bedrooms",
  "year_built",
  "charges_copro",
  "taxe_fonciere",
  "price",
]);

function isBlank(value) {
  return value === null || value === undefined || value === "";
}

export function formatListingFieldDisplay(fieldKey, val, fmt) {
  if (isBlank(val)) return null;
  if (val === 0 && ZERO_IS_EMPTY.has(fieldKey)) return null;
  if (fieldKey === "surface" || fieldKey === "land_surface") return fmt.surface(val);
  if (fieldKey === "price") return fmt.euro(val);
  if (fieldKey === "charges_copro" || fieldKey === "taxe_fonciere") {
    return `${fmt.euro(val)} / an`;
  }
  return String(val);
}

function effectiveValue(prov, key, fallback) {
  const p = prov[key];
  return p && !isBlank(p.value) ? p.value : fallback;
}

function agencyFees(agency) {
  if (!agency || !agency.fees_percent) return null;
  return `${agency.fees_percent} %${agency.fees_included ? " (inclus)" : ""}`;
}

/**
 * Définition déclarative des lignes, dans l'ordre d'affichage.
 * - `field` : champ résolu (valeur, source et ancienne valeur depuis `resolveAll`) ;
 * - `source` + `value(ctx)` : valeur hors resolveur, de provenance fixe ;
 * - `title` : info-bulle propre à la ligne (sinon libellé générique de la source) ;
 * - `key` + `dependsOn` : ligne calculée à rafraîchir quand un de ces champs change.
 */
const SPEC_ROWS = [
  { label: "Type de bien", source: "structured", value: ({ listing, fmt }) => fmt.propertyTypeLabel(listing.property_type) },
  { label: "Transaction", source: "structured", value: ({ listing, fmt }) => fmt.transactionLabel(listing.transaction_type) },
  { label: "Prix", field: "price" },
  {
    label: "Prix au m²",
    key: "price_per_m2",
    dependsOn: ["price", "surface"],
    source: "computed",
    title: "Calculé : prix ÷ surface habitable",
    value: ({ eff, fmt }) => {
      const price = Number(eff("price"));
      const surface = Number(eff("surface"));
      if (!price || !(surface > 0)) return null;
      return `${fmt.euro(Math.round(price / surface))} / m²`;
    },
  },
  { label: "Surface habitable", field: "surface" },
  { label: "Surface du terrain", field: "land_surface" },
  { label: "Pièces", field: "rooms" },
  { label: "Chambres", field: "bedrooms" },
  { label: "Étage", field: "floor" },
  { label: "Année de construction", field: "year_built" },
  { label: "Charges de copropriété", field: "charges_copro" },
  { label: "Taxe foncière", field: "taxe_fonciere" },
  { label: "État", field: "property_condition" },
  { label: "Chauffage", field: "heating_system" },
  { label: "Source d'énergie", field: "energy_source" },
  { label: "Construction", source: "structured", value: ({ listing }) => (listing.is_new_build ? "Neuf" : null) },
  { label: "Commune", source: "structured", value: ({ listing }) => listing.city },
  { label: "Code postal", source: "structured", value: ({ listing }) => listing.postal_code },
  {
    label: "Code INSEE",
    source: "reference",
    title: "Déduit du code postal et de la commune (base La Poste, geo.api.gouv.fr)",
    value: ({ postalInseeCode }) => postalInseeCode,
  },
  { label: "Agence", source: "structured", value: ({ listing }) => listing.agency?.name || null },
  { label: "Téléphone", source: "structured", value: ({ listing }) => listing.agency?.phone || null },
  { label: "Honoraires d'agence", source: "structured", value: ({ listing }) => agencyFees(listing.agency) },
  { label: "Identifiant source", source: "structured", value: ({ listing }) => listing.source_id },
];

function sourceInfo(kind, { origin = null, title = null, previous = null } = {}) {
  const defaultTitle =
    kind === "user" ? ORIGIN_LABELS[origin] || SOURCE_LABELS.user : SOURCE_LABELS[kind] || "";
  return {
    kind,
    short: SOURCE_SHORT[kind] || "",
    title: title || defaultTitle,
    previous,
  };
}

function resolvedRow(def, ctx) {
  const { listing, prov, fmt } = ctx;
  const p = prov[def.field] || null;
  const rawValue = effectiveValue(prov, def.field, listing[def.field] ?? null);
  const display = formatListingFieldDisplay(def.field, rawValue, fmt);
  if (display === null) return null;

  const previous =
    p && p.previous
      ? {
          display: formatListingFieldDisplay(def.field, p.previous.value, fmt) ?? String(p.previous.value),
          title: `Ancienne valeur (${SOURCE_LABELS[p.previous.source] || "annonce"})`,
        }
      : null;
  const fieldKey = listingSpecEditFieldKey(def.field);

  return {
    key: def.field,
    label: def.label,
    display,
    rawValue,
    fieldKey,
    dependsOn: [],
    fieldInputKind: fieldKey ? resolveFieldInputKind(fieldKey) : null,
    source: sourceInfo(p && p.source ? p.source : "structured", {
      origin: p ? p.origin : null,
      previous,
    }),
  };
}

function fixedRow(def, ctx) {
  const value = def.value(ctx);
  if (isBlank(value)) return null;
  return {
    key: def.key || null,
    label: def.label,
    display: String(value),
    rawValue: value,
    fieldKey: null,
    dependsOn: def.dependsOn || [],
    fieldInputKind: null,
    source: sourceInfo(def.source, { title: def.title }),
  };
}

/**
 * @returns {Array<{ key: string|null, label: string, display: string, rawValue: unknown,
 *   fieldKey: string|null, dependsOn: string[], fieldInputKind: object|null, source: { kind: string, short: string, title: string,
 *   previous: { display: string, title: string }|null } }>}
 */
export function buildListingSpecs(listing, provenance, fmt, { postalInseeCode = null } = {}) {
  const prov = provenance || {};
  const ctx = {
    listing,
    prov,
    fmt,
    postalInseeCode,
    eff: (key) => effectiveValue(prov, key, listing[key] ?? null),
  };
  return SPEC_ROWS.map((def) => (def.field ? resolvedRow(def, ctx) : fixedRow(def, ctx))).filter(Boolean);
}

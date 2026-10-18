/**
 * Vue « toutes les données structurées » d'une annonce (colonnes descriptives
 * + photos + clés extension / brut), y compris les champs vides.
 */

const ZERO_IS_EMPTY = new Set([
  "surface",
  "land_surface",
  "rooms",
  "bedrooms",
  "year_built",
  "price",
]);

function isEmptyScalar(value, fieldKey) {
  if (value === null || value === undefined || value === "") return true;
  if (typeof value === "number" && Number.isNaN(value)) return true;
  if (value === 0 && fieldKey && ZERO_IS_EMPTY.has(fieldKey)) return true;
  return false;
}

function row(label, display, { key = null, help = null, filled = null, kind = null } = {}) {
  const hasValue = display !== null && display !== undefined && display !== "";
  return {
    key,
    label,
    help,
    kind,
    display: hasValue ? String(display) : null,
    filled: filled !== null ? filled : hasValue,
  };
}

function summarizeJsonValue(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (!value.length) return null;
    return `Liste (${value.length} élément${value.length > 1 ? "s" : ""})`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (!keys.length) return null;
    return `Objet (${keys.length} clé${keys.length > 1 ? "s" : ""})`;
  }
  const text = String(value).trim();
  return text || null;
}

function agencyFeesDisplay(agency, fmt) {
  if (!agency || agency.fees_percent == null || agency.fees_percent === "") return null;
  const pct = Number(agency.fees_percent);
  if (!Number.isFinite(pct)) return null;
  const suffix = agency.fees_included ? " (inclus)" : "";
  return `${fmt.number(pct)} %${suffix}`;
}

function jsonKeyFields(prefix, data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return [row(`${prefix}`, summarizeJsonValue(data), { key: prefix })];
  }
  const keys = Object.keys(data).sort((a, b) => a.localeCompare(b, "fr"));
  if (!keys.length) {
    return [row("Contenu", null, { key: `${prefix}.__empty` })];
  }
  return keys.map((key) =>
    row(key, summarizeJsonValue(data[key]), { key: `${prefix}.${key}` })
  );
}

/**
 * @param {object} listing
 * @param {{ photoCount?: number, postalInseeCode?: string|null }} meta
 * @param {object} fmt helpers de `res.locals.fmt`
 */
export function buildListingStructuredDataView(listing, meta = {}, fmt) {
  const photoCount = meta.photoCount ?? 0;
  const postalInseeCode = meta.postalInseeCode ?? null;
  const agency = listing.agency || null;
  const inseeFromListing =
    listing.insee_code != null && listing.insee_code !== "" ? String(listing.insee_code) : null;
  const inseeDisplay = postalInseeCode || inseeFromListing;
  const inseeHelp =
    postalInseeCode && inseeFromListing && postalInseeCode !== inseeFromListing
      ? `Valeur brute de l'annonce : ${inseeFromListing}`
      : postalInseeCode
        ? "Déduit du code postal et de la commune (référentiel public)."
        : null;

  const sections = [
    {
      id: "identity",
      title: "Source et identité",
      fields: [
        row("Portail", listing.source ? fmt.sourceLabel(listing.source) : null, {
          key: "source",
        }),
        row("Identifiant source", listing.source_id, { key: "source_id" }),
        row("URL de l'annonce", listing.url, { key: "url", kind: "url", filled: Boolean(listing.url) }),
        row("Titre", listing.title, { key: "title" }),
        row(
          "Description",
          listing.description
            ? `${fmt.number(listing.description.length)} caractère${
                listing.description.length > 1 ? "s" : ""
              }`
            : null,
          {
            key: "description",
            help: "Longueur du texte extrait de l'annonce.",
          }
        ),
      ],
    },
    {
      id: "transaction",
      title: "Transaction et typologie",
      fields: [
        row(
          "Transaction",
          listing.transaction_type ? fmt.transactionLabel(listing.transaction_type) : null,
          { key: "transaction_type" }
        ),
        row(
          "Type de bien",
          listing.property_type ? fmt.propertyTypeLabel(listing.property_type) : null,
          { key: "property_type" }
        ),
        row(
          "Neuf",
          listing.is_new_build ? "Oui" : listing.is_new_build === 0 ? "Non" : null,
          { key: "is_new_build" }
        ),
      ],
    },
    {
      id: "price",
      title: "Prix et surfaces",
      fields: [
        row("Prix", isEmptyScalar(listing.price, "price") ? null : fmt.euro(listing.price), {
          key: "price",
        }),
        row(
          "Surface habitable",
          isEmptyScalar(listing.surface, "surface") ? null : fmt.surface(listing.surface),
          { key: "surface" }
        ),
        row(
          "Surface du terrain",
          isEmptyScalar(listing.land_surface, "land_surface")
            ? null
            : fmt.surface(listing.land_surface),
          { key: "land_surface" }
        ),
      ],
    },
    {
      id: "rooms",
      title: "Pièces et construction",
      fields: [
        row("Pièces", isEmptyScalar(listing.rooms, "rooms") ? null : fmt.number(listing.rooms), {
          key: "rooms",
        }),
        row(
          "Chambres",
          isEmptyScalar(listing.bedrooms, "bedrooms") ? null : fmt.number(listing.bedrooms),
          { key: "bedrooms" }
        ),
        row(
          "Étage",
          listing.floor === null || listing.floor === undefined ? null : fmt.number(listing.floor),
          { key: "floor" }
        ),
        row(
          "Année de construction",
          isEmptyScalar(listing.year_built, "year_built")
            ? null
            : fmt.number(listing.year_built),
          { key: "year_built" }
        ),
      ],
    },
    {
      id: "energy",
      title: "Performance énergétique",
      fields: [
        row("Étiquette DPE", listing.dpe, { key: "dpe" }),
        row("Étiquette GES", listing.ges, { key: "ges" }),
        row(
          "Consommation (kWhEP/m².an)",
          listing.dpe_value != null && listing.dpe_value !== ""
            ? `${fmt.number(listing.dpe_value)} kWhEP/m².an`
            : null,
          { key: "dpe_value" }
        ),
        row(
          "Émissions (kg CO₂/m².an)",
          listing.ges_value != null && listing.ges_value !== ""
            ? `${fmt.number(listing.ges_value)} kg CO₂/m².an`
            : null,
          { key: "ges_value" }
        ),
        row("Source d'énergie", listing.energy_source, { key: "energy_source" }),
        row("Chauffage", listing.heating_system, { key: "heating_system" }),
        row("État général", listing.property_condition, { key: "property_condition" }),
      ],
    },
    {
      id: "location",
      title: "Localisation",
      fields: [
        row("Commune", listing.city, { key: "city" }),
        row("Code postal", listing.postal_code, { key: "postal_code" }),
        row("Code INSEE", inseeDisplay, { key: "insee_code", help: inseeHelp }),
        row(
          "Latitude",
          listing.lat != null && listing.lat !== "" ? String(listing.lat) : null,
          { key: "lat" }
        ),
        row(
          "Longitude",
          listing.lng != null && listing.lng !== "" ? String(listing.lng) : null,
          { key: "lng" }
        ),
      ],
    },
    {
      id: "agency",
      title: "Agence",
      fields: [
        row("Nom", agency?.name || null, { key: "agency.name" }),
        row("Téléphone", agency?.phone || null, { key: "agency.phone" }),
        row("Honoraires", agencyFeesDisplay(agency, fmt), { key: "agency.fees" }),
      ],
    },
    {
      id: "media",
      title: "Médias",
      fields: [
        row(
          "Photos",
          photoCount > 0
            ? `${fmt.number(photoCount)} photo${photoCount > 1 ? "s" : ""}`
            : null,
          { key: "photos" }
        ),
      ],
    },
    {
      id: "extension",
      title: "Données extension",
      hint: "Calculs et métadonnées envoyés par l'extension Chrome.",
      fields: jsonKeyFields("extension_data", listing.extension_data),
    },
    {
      id: "raw",
      title: "Payload brut",
      hint: "Copie du JSON tel que reçu ou extrait lors de la dernière capture.",
      fields: jsonKeyFields("raw", listing.raw),
    },
  ];

  let filled = 0;
  let total = 0;
  for (const section of sections) {
    for (const field of section.fields) {
      total += 1;
      if (field.filled) filled += 1;
    }
  }

  return {
    summary: {
      filled,
      total,
      empty: total - filled,
    },
    sections,
  };
}

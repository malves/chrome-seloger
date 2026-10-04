/**
 * Formatage pour les vues. Exposé à EJS via `res.locals.fmt`.
 */

import { parseUserAddress } from "./user-address.js";
import { listingDpeSearchCriteria } from "./listing-dpe-criteria.js";

const STATUSES = {
  new: { label: "À étudier", tone: "neutral" },
  contacted: { label: "Contactée", tone: "info" },
  visit_planned: { label: "Visite prévue", tone: "accent" },
  visited: { label: "Visitée", tone: "accent" },
  offer: { label: "Offre faite", tone: "success" },
  rejected: { label: "Écartée", tone: "muted" },
};

const PROPERTY_TYPES = {
  house: "Maison",
  apartment: "Appartement",
  land: "Terrain",
  other: "Autre",
};

const TRANSACTION_TYPES = {
  sale: "Vente",
  rent: "Location",
};

export const STATUS_KEYS = Object.keys(STATUSES);
export const PROPERTY_TYPE_KEYS = Object.keys(PROPERTY_TYPES);

export function statusLabel(status) {
  return STATUSES[status]?.label || status || "—";
}

export function statusTone(status) {
  return STATUSES[status]?.tone || "neutral";
}

export function statusOptions() {
  return STATUS_KEYS.map((key) => ({ value: key, label: STATUSES[key].label }));
}

export function propertyTypeLabel(type) {
  return PROPERTY_TYPES[type] || null;
}

export function propertyTypeOptions() {
  return PROPERTY_TYPE_KEYS.map((key) => ({
    value: key,
    label: PROPERTY_TYPES[key],
  }));
}

export function transactionLabel(type) {
  return TRANSACTION_TYPES[type] || null;
}

const euroFormatter = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat("fr-FR", {
  maximumFractionDigits: 0,
});

export function euro(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "—";
  }
  return euroFormatter.format(Math.round(Number(value)));
}

export function number(value, suffix = "") {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "—";
  }
  return numberFormatter.format(Number(value)) + suffix;
}

export function surface(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "—";
  }
  const n = Number(value);
  const rounded = Number.isInteger(n) ? n : Math.round(n * 10) / 10;
  return `${rounded.toLocaleString("fr-FR")} m²`;
}

export function percent(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return "—";
  return `${(Number(value) * 100).toLocaleString("fr-FR", {
    maximumFractionDigits: digits,
  })} %`;
}

const dateFormatter = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export function date(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return dateFormatter.format(new Date(t));
}

const dateTimeFormatter = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Date + heure, ex. « 4 oct. 2026 à 18:21 » (détail d'un import, etc.). */
export function datetime(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return dateTimeFormatter.format(new Date(t));
}

/** « il y a 3 jours » : repère plus lisible qu'une date pour une liste. */
export function relative(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const minutes = Math.round((Date.now() - t) / 60000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 31) return `il y a ${days} j`;
  return date(iso);
}

/** Nom de domaine affichable pour la source d'une annonce. */
export function sourceLabel(source) {
  if (!source) return "—";
  return String(source)
    .replace(/[-_.]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Couleur de pastille d'un projet. La valeur est écrite dans un attribut
 * `style` : on n'accepte qu'un code hexadécimal, jamais une chaîne libre.
 */
export function projectColor(color) {
  return /^#[0-9a-f]{6}$/i.test(String(color || "")) ? color : "#0b3d2c";
}

/** Construit une URL de liste en modifiant seulement les clés fournies. */
export function listingsUrl(currentQuery, changes) {
  const params = new URLSearchParams(currentQuery || {});
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === undefined || value === "") {
      params.delete(key);
    } else {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `/listings?${qs}` : "/listings";
}

export default {
  euro,
  number,
  surface,
  percent,
  date,
  datetime,
  relative,
  statusLabel,
  statusTone,
  statusOptions,
  propertyTypeLabel,
  propertyTypeOptions,
  transactionLabel,
  sourceLabel,
  projectColor,
  listingsUrl,
  parseUserAddress,
  listingDpeSearchCriteria,
};

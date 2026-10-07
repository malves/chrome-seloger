/**
 * Formatage pour les vues. Exposé à EJS via `res.locals.fmt`.
 */

import { parseUserAddress } from "./user-address.js";
import { listingDpeSearchCriteria } from "./listing-dpe-criteria.js";
import { dvfPublicationNotice } from "./dvf-publication.js";

const STATUSES = {
  new: { label: "À étudier", shortLabel: "Étudier", tone: "neutral", pipeline: true },
  contacted: { label: "Contactée", shortLabel: "Contact", tone: "info", pipeline: true },
  visit_planned: { label: "Visite prévue", shortLabel: "Visite", tone: "accent", pipeline: true },
  visited: { label: "Visitée", shortLabel: "Visitée", tone: "accent", pipeline: true },
  offer: { label: "Offre faite", shortLabel: "Offre", tone: "success", pipeline: true },
  rejected: {
    label: "Écartée",
    shortLabel: "Écartée",
    badgeLabel: "Cette annonce est écartée",
    tone: "error",
    pipeline: false,
  },
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

/** Libellé du badge sur la fiche (plus explicite pour certains statuts). */
export function statusBadgeLabel(status) {
  const meta = STATUSES[status];
  return meta?.badgeLabel || meta?.label || status || "—";
}

export function statusTone(status) {
  return STATUSES[status]?.tone || "neutral";
}

export function statusOptions() {
  return STATUS_KEYS.map((key) => ({ value: key, label: STATUSES[key].label }));
}

export function statusShortLabel(status) {
  return STATUSES[status]?.shortLabel || statusLabel(status);
}

/** Étapes linéaires du suivi (hors « Écartée », qui est une sortie). */
export function statusPipeline() {
  return STATUS_KEYS.filter((key) => STATUSES[key].pipeline).map((key) => ({
    value: key,
    label: STATUSES[key].label,
    shortLabel: STATUSES[key].shortLabel,
    tone: STATUSES[key].tone,
  }));
}

export function isPipelineStatus(status) {
  return Boolean(STATUSES[status]?.pipeline);
}

/** Étape du parcours à afficher (y compris quand l'annonce est écartée). */
export function listingPipelineStatus(listing) {
  if (listing.status === "rejected") {
    if (isPipelineStatus(listing.status_progress)) return listing.status_progress;
    return "new";
  }
  if (isPipelineStatus(listing.status)) return listing.status;
  return "new";
}

/** Statut + progression à enregistrer lors d'un changement depuis l'interface. */
export function resolveListingStatusUpdate(listing, newStatus) {
  if (newStatus === "rejected") {
    if (listing.status === "rejected") {
      const restored = isPipelineStatus(listing.status_progress)
        ? listing.status_progress
        : "new";
      return { status: restored, status_progress: null };
    }
    const progress = isPipelineStatus(listing.status) ? listing.status : "new";
    return { status: "rejected", status_progress: progress };
  }
  return { status: newStatus, status_progress: null };
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
  statusBadgeLabel,
  statusShortLabel,
  statusTone,
  statusOptions,
  statusPipeline,
  isPipelineStatus,
  listingPipelineStatus,
  resolveListingStatusUpdate,
  propertyTypeLabel,
  propertyTypeOptions,
  transactionLabel,
  sourceLabel,
  projectColor,
  listingsUrl,
  parseUserAddress,
  listingDpeSearchCriteria,
  dvfPublicationNotice,
};

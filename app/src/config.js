/**
 * Lecture et validation des variables d'environnement.
 *
 * Les taux forfaitaires du financement ont leurs valeurs par défaut ici ;
 * l'administration peut les surcharger (table `app_settings`). Le service de
 * calcul ne contient aucun taux en dur.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

export const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function list(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `chrome-extension://abcdef…` → `abcdef…`, pour valider les redirections. */
function extensionId(origin) {
  const match = /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(origin);
  return match ? match[1] : null;
}

const env = process.env.NODE_ENV || "development";
const isProduction = env === "production";
const isTest = env === "test";

const config = {
  env,
  isProduction,
  isTest,
  port: num(process.env.PORT, 3000),
  baseUrl: (process.env.BASE_URL || "http://localhost:3000").replace(/\/+$/, ""),
  databasePath: process.env.DATABASE_PATH || "./data/app.db",
  sessionSecret: process.env.SESSION_SECRET || "change-me",
  extensionOrigins: list(process.env.EXTENSION_ORIGINS),

  /**
   * Identifiants d'extension autorisés à recevoir un code d'autorisation,
   * déduits de `EXTENSION_ORIGINS`. Liste vide = toute extension Chrome, ce
   * qui convient en développement mais doit être renseigné en production.
   */
  extensionIds: list(process.env.EXTENSION_ORIGINS)
    .map(extensionId)
    .filter(Boolean),

  /**
   * Version minimale de l'extension (`x.y.z`). Vide = pas de contrôle.
   * Les requêtes plus anciennes reçoivent HTTP 426 `extension_outdated`.
   */
  extensionMinVersion: String(process.env.EXTENSION_MIN_VERSION || "").trim(),

  logLevel: process.env.LOG_LEVEL || (isTest ? "silent" : "info"),

  /** Longueur minimale d'un mot de passe. */
  passwordMinLength: 10,

  /**
   * Compte autorisé à accéder à l'espace d'administration. Comparaison
   * insensible à la casse ; surchargeable via `ADMIN_EMAIL`.
   */
  adminEmail: (process.env.ADMIN_EMAIL || "contact@malves.fr").toLowerCase(),

  /** Limites de débit. */
  rateLimits: {
    login: { windowMs: 15 * 60 * 1000, max: 10 },
    api: { windowMs: 60 * 1000, max: 120 },
  },

  /** Appels externes des providers d'enrichissement. */
  enrichment: {
    timeoutMs: 8000,
    retries: 1,
  },

  /** Import SSMSI (délinquance enregistrée, data.gouv). */
  ssmsi: {
    communeUrl:
      process.env.SSMSI_COMMUNE_URL ||
      "https://static.data.gouv.fr/resources/bases-statistiques-communale-departementale-et-regionale-de-la-delinquance-enregistree-par-la-police-et-la-gendarmerie-nationales/20260709-115942/donnee-data.gouv-2025-geographie2026-produit-le2026-06-25.csv.gz",
    depUrl:
      process.env.SSMSI_DEP_URL ||
      "https://static.data.gouv.fr/resources/bases-statistiques-communale-departementale-et-regionale-de-la-delinquance-enregistree-par-la-police-et-la-gendarmerie-nationales/20260709-120038/donnee-dep-data.gouv-2025-geographie2026-produit-le2026-06-25.csv",
  },

  /**
   * Prix au m² issus des ventes réelles DVF (geo-dvf Etalab). Un fichier gzip
   * par année : `{baseUrl}/{année}/full.csv.gz`. L'import couvre la plage
   * `[yearFrom, yearTo]`. Les bornes de prix au m² écartent les aberrations.
   */
  dvf: {
    baseUrl: (
      process.env.DVF_BASE_URL ||
      "https://files.data.gouv.fr/geo-dvf/latest/csv"
    ).replace(/\/+$/, ""),
    yearFrom: num(process.env.DVF_YEAR_FROM, new Date().getFullYear() - 10),
    yearTo: num(process.env.DVF_YEAR_TO, new Date().getFullYear() - 1),
    minPricePerM2: num(process.env.DVF_MIN_PRICE_M2, 200),
    maxPricePerM2: num(process.env.DVF_MAX_PRICE_M2, 25000),
    radiusMeters: num(process.env.DVF_RADIUS_METERS, 250),
    radiusMinSample: num(process.env.DVF_RADIUS_MIN_SAMPLE, 5),
    radiusYears: num(process.env.DVF_RADIUS_YEARS, 5),
    /** Demi-vie (jours) des poids de récence pour la médiane pondérée du rayon. */
    radiusRecencyHalfLifeDays: num(process.env.DVF_RADIUS_RECENCY_HALF_LIFE_DAYS, 540),
    /** Ventes sous ce ratio × médiane locale ignorées pour la référence €/m². */
    radiusOutlierLowRatio: num(process.env.DVF_RADIUS_OUTLIER_LOW_RATIO, 0.5),
  },

  /**
   * Historique des prix au m² (Immo Data). Le jeton Bearer vit uniquement
   * ici : il n'est jamais exposé au navigateur.
   */
  immoData: {
    apiKey: String(process.env.IMMO_DATA_API_KEY || "").trim(),
    baseUrl: (
      process.env.IMMO_DATA_BASE_URL || "https://api.immo-data.fr"
    ).replace(/\/+$/, ""),
    timeoutMs: num(process.env.IMMO_DATA_TIMEOUT_MS, 12000),
    userAgent: "CarnetDeVisites/1.0",

    /**
     * Prix au m² du « grand quartier » Immo Data (codes type `7511453`,
     * `2A00401`), affiché à côté du rayon DVF quand une adresse est saisie.
     *
     * - `quartierGeoLevel` : valeur `geoLevel` de l'historique pour ce niveau.
     * - `quartierResolveUrl` : URL (gabarit `{lat}` `{lng}` `{insee}`) renvoyant
     *   `{ code }` du grand quartier pour un point. Vide = fonctionnalité
     *   désactivée (le provider se met en « ignoré » sans bloquer DVF), à
     *   renseigner selon l'endpoint de résolution de la doc Immo Data.
     */
    quartierGeoLevel: String(
      process.env.IMMO_DATA_QUARTIER_GEOLEVEL || "district"
    ).trim(),
    quartierResolveUrl: String(
      process.env.IMMO_DATA_QUARTIER_RESOLVE_URL || ""
    ).trim(),
  },

  /**
   * Calcul d'itinéraire voiture via OpenRouteService. La clé est partagée et
   * vit uniquement ici : l'extension n'a jamais à la connaître ni à la saisir.
   * Clé gratuite sur https://openrouteservice.org/dev/#/signup
   */
  openRouteService: {
    apiKey: process.env.ORS_API_KEY || "",
    baseUrl: (process.env.ORS_BASE_URL || "https://api.openrouteservice.org").replace(
      /\/+$/,
      ""
    ),
    timeoutMs: num(process.env.ORS_TIMEOUT_MS, 8000),
  },

  /**
   * Valeurs indicatives du tableau de financement. Les droits de mutation
   * varient selon le département : la V1 applique un taux forfaitaire,
   * présenté comme une estimation.
   */
  financing: {
    notaryRateOld: 0.08,
    notaryRateNew: 0.025,
    guaranteeRate: 0.015,
    interestRate: 0.035,
    insuranceRate: 0.003,
    years: 25,
    debtRatio: 0.35,
    downPayment: 0,
    works: 0,
  },

  /**
   * Fond de carte Leaflet (fiche annonce). Les tuiles tile.openstreetmap.org
   * ne doivent pas servir d'apps web : on utilise CARTO Voyager, qui
   * fonctionne sans clé pour un trafic modéré. `CARTO_BASEMAP_KEY` lève les
   * quotas en production.
   */
  basemap: {
    cartoKey: String(process.env.CARTO_BASEMAP_KEY || "").trim(),
  },
};

/**
 * Config sérialisable pour le client (URL tuiles + attribution).
 *
 * Avec `CARTO_BASEMAP_KEY` : tuiles CARTO Voyager (style OSM) adaptées aux
 * apps web, sans quota serré. Sans clé : repli Esri World Street Map, qui
 * sert de vraies tuiles sans clé (CARTO sans clé ne renvoie qu'un filigrane
 * « api key required »).
 */
export function basemapClientConfig({ cartoKey } = config.basemap) {
  if (cartoKey) {
    const key = encodeURIComponent(cartoKey);
    return {
      url: `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=${key}`,
      subdomains: "abcd",
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions/" target="_blank" rel="noopener noreferrer">CARTO</a>',
    };
  }
  return {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    subdomains: "",
    attribution:
      'Tiles &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener noreferrer">Esri</a> &mdash; sources: Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
  };
}

if (isProduction && config.sessionSecret === "change-me") {
  throw new Error(
    "SESSION_SECRET doit être défini en production (voir .env.example)."
  );
}

export default config;

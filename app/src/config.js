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
   * Comptes autorisés sur /admin (e-mails en base, comparaison insensible à la
   * casse). `ADMIN_EMAILS` (liste séparée par des virgules) ou `ADMIN_EMAIL`.
   */
  adminEmails: list(process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL).map(
    (email) => email.toLowerCase()
  ),

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
    /**
     * Bande de référence autour de la médiane brute du rayon : ventes hors
     * [ratio × M ; M / ratio] ignorées (défaut 0,5 → 50 % à 200 % de M).
     */
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
    /** Durée de validité du cache communal / départemental / quartier (jours). */
    cacheTtlDays: num(process.env.IMMO_DATA_CACHE_TTL_DAYS, 25),
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
   * Clé Google Maps (metadata Street View uniquement, sans quota). Permet d'ouvrir
   * Street View seulement quand une prise de vue existe ; sinon lien recherche Maps.
   */
  googleMaps: {
    apiKey: String(process.env.GOOGLE_MAPS_API_KEY || "").trim(),
    metadataTimeoutMs: num(process.env.GOOGLE_MAPS_METADATA_TIMEOUT_MS, 5000),
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
    /** Apport par défaut sur une fiche : part du prix affiché de l'annonce. */
    defaultDownPaymentRate: 0.1,
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

  /**
   * Modèle de langage (extraction de contraintes de localisation). Client
   * compatible OpenAI : `POST {baseUrl}/chat/completions`. Fonctionne tel quel
   * avec OpenAI, Mistral, Groq, OpenRouter, Ollama local, etc. La clé vit
   * uniquement ici : elle n'est jamais exposée au navigateur. Le LLM ne fait
   * QUE « texte libre → contraintes structurées » ; aucun calcul géographique.
   */
  llm: {
    apiKey: String(process.env.LLM_API_KEY || "").trim(),
    baseUrl: (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(
      /\/+$/,
      ""
    ),
    model: String(process.env.LLM_MODEL || "gpt-4o-mini").trim(),
    timeoutMs: num(process.env.LLM_TIMEOUT_MS, 20000),
  },

  /**
   * Analyse des photos d'annonce (vision). Client compatible OpenAI, mêmes
   * conventions que `llm` : la clé vit uniquement ici. Par défaut on réutilise
   * la clé et l'URL du LLM texte ; `VISION_MODEL` / `VISION_IMAGE_DETAIL`
   * pilotent le coût (gpt-4o-mini + détail « high » ≈ 0,05 € / 15 photos).
   * Les photos sont téléchargées côté serveur puis envoyées en base64.
   */
  /**
   * Estimation de la valeur locative (€/m²) à l'adresse. Client compatible
   * OpenAI : par défaut l'API Responses + recherche web (équivalent ChatGPT
   * avec sources). `RENT_WEB_SEARCH=false` bascule sur `/chat/completions`
   * (json_schema, sans web) pour un fournisseur non OpenAI. La clé vit
   * uniquement ici.
   */
  rent: {
    apiKey: String(process.env.RENT_API_KEY || process.env.LLM_API_KEY || "").trim(),
    baseUrl: (
      process.env.RENT_BASE_URL ||
      process.env.LLM_BASE_URL ||
      "https://api.openai.com/v1"
    ).replace(/\/+$/, ""),
    model: String(process.env.RENT_MODEL || "gpt-5-mini").trim(),
    webSearch: !["0", "false", "no", "off"].includes(
      String(process.env.RENT_WEB_SEARCH || "true").trim().toLowerCase()
    ),
    timeoutMs: num(process.env.RENT_TIMEOUT_MS, 120000),
  },

  vision: {
    apiKey: String(process.env.VISION_API_KEY || process.env.LLM_API_KEY || "").trim(),
    baseUrl: (
      process.env.VISION_BASE_URL ||
      process.env.LLM_BASE_URL ||
      "https://api.openai.com/v1"
    ).replace(/\/+$/, ""),
    model: String(process.env.VISION_MODEL || "gpt-4o-mini").trim(),
    /** `high` (défauts fins visibles) ou `low` (moins cher) pour la passe par image. */
    imageDetail: ["low", "high", "auto"].includes(process.env.VISION_IMAGE_DETAIL)
      ? process.env.VISION_IMAGE_DETAIL
      : "high",
    /** Détail des images de la passe de synthèse, qui attribue l'état des pièces. */
    synthesisImageDetail: ["low", "high", "auto"].includes(process.env.VISION_SYNTHESIS_DETAIL)
      ? process.env.VISION_SYNTHESIS_DETAIL
      : "high",
    timeoutMs: num(process.env.VISION_TIMEOUT_MS, 90000),
    /** Photos analysées au maximum par annonce (les suivantes sont ignorées). */
    maxPhotos: num(process.env.VISION_MAX_PHOTOS, 30),
    /** Images par appel de la passe « par image ». */
    batchSize: num(process.env.VISION_BATCH_SIZE, 8),
    /**
     * Seconde tentative sur les images restées non classées (unknown, fiche
     * absente, lot en échec) : taille des lots et plafond d'images relues.
     * `VISION_MAX_RETRY_IMAGES=0` désactive la seconde tentative.
     */
    retryBatchSize: num(process.env.VISION_RETRY_BATCH_SIZE, 2),
    maxRetryImages: num(process.env.VISION_MAX_RETRY_IMAGES, 12),
    maxImageBytes: num(process.env.VISION_MAX_IMAGE_BYTES, 8 * 1024 * 1024),
    downloadTimeoutMs: num(process.env.VISION_DOWNLOAD_TIMEOUT_MS, 10000),
  },

  /**
   * Géocodage des lieux (POI type « Monoprix », « gare du Val d'Or ») via
   * Nominatim OpenStreetMap. Nominatim exige un User-Agent/`email` identifiant
   * et limite à ~1 req/s : les résultats sont mis en cache (`geocode_cache`).
   */
  nominatim: {
    baseUrl: (
      process.env.NOMINATIM_BASE_URL || "https://nominatim.openstreetmap.org"
    ).replace(/\/+$/, ""),
    email: String(process.env.NOMINATIM_EMAIL || "").trim(),
    userAgent:
      String(process.env.NOMINATIM_USER_AGENT || "").trim() ||
      "CarnetDeVisites/1.0 (+https://github.com/)",
    timeoutMs: num(process.env.NOMINATIM_TIMEOUT_MS, 8000),
  },

  /**
   * Réglages du moteur de localisation probable. Tout est paramétrable : les
   * courbes de tolérance (les annonces arrondissent les temps/distances), les
   * distances conventionnelles des formules vagues, les poids par type de
   * contrainte, la finesse de la grille et le seuil d'incohérence.
   */
  probableLocation: {
    /** Grille de scoring : nombre de cellules par axe et marge autour des zones. */
    grid: {
      size: num(process.env.PLOC_GRID_SIZE, 60),
      paddingRatio: num(process.env.PLOC_GRID_PADDING_RATIO, 0.15),
      /** Cellules conservées dans la heatmap au-delà de ce score normalisé. */
      heatmapMinScore: num(process.env.PLOC_HEATMAP_MIN_SCORE, 0.15),
    },

    /**
     * Tolérance sur un temps annoncé `M` minutes. `grace` : minutes au-delà de
     * `M` encore notées 1. `span` : largeur de la décroissance linéaire vers 0
     * après la grâce. Calé sur l'exemple de la spec (M=5 → 0 au-delà de 10).
     */
    toleranceMinutes: {
      graceRatio: num(process.env.PLOC_TOL_MIN_GRACE_RATIO, 0),
      spanRatio: num(process.env.PLOC_TOL_MIN_SPAN_RATIO, 1),
      /** Exposant de la décroissance : 1 = linéaire, >1 = plus sévère. */
      curve: num(process.env.PLOC_TOL_MIN_CURVE, 1.5),
    },

    /** Même logique pour une distance annoncée en mètres. */
    toleranceMeters: {
      graceRatio: num(process.env.PLOC_TOL_M_GRACE_RATIO, 0),
      spanRatio: num(process.env.PLOC_TOL_M_SPAN_RATIO, 1),
      curve: num(process.env.PLOC_TOL_M_CURVE, 1.5),
    },

    /** Rayons conventionnels (mètres) des formules vagues, à pied. */
    vagueDistances: {
      "a deux pas": num(process.env.PLOC_VAGUE_DEUX_PAS_M, 200),
      proche: num(process.env.PLOC_VAGUE_PROCHE_M, 400),
      "a proximite": num(process.env.PLOC_VAGUE_PROXIMITE_M, 700),
      "face a": num(process.env.PLOC_VAGUE_FACE_M, 120),
      pres: num(process.env.PLOC_VAGUE_PRES_M, 500),
      /** Voie nommée sans numéro (plus serré qu'un POI « proche »). */
      street: num(process.env.PLOC_VAGUE_STREET_M, 200),
      default: num(process.env.PLOC_VAGUE_DEFAULT_M, 600),
    },

    /** Poids par nature de contrainte (les contraintes précises priment). */
    weights: {
      travelTimePrecise: num(process.env.PLOC_W_TIME, 1.0),
      distancePrecise: num(process.env.PLOC_W_DISTANCE, 1.0),
      /** Rue / voie explicitement citée dans l'annonce (sans numéro). */
      streetNear: num(process.env.PLOC_W_STREET, 1.15),
      /** Confiance géocodage minimale pour ancrer le centre sur la voie. */
      streetAnchorMinGeocoding: num(process.env.PLOC_STREET_MIN_GEO, 0.35),
      "a deux pas": num(process.env.PLOC_W_DEUX_PAS, 0.7),
      proche: num(process.env.PLOC_W_PROCHE, 0.5),
      "a proximite": num(process.env.PLOC_W_PROXIMITE, 0.4),
      "face a": num(process.env.PLOC_W_FACE, 0.7),
      pres: num(process.env.PLOC_W_PRES, 0.5),
      vagueDefault: num(process.env.PLOC_W_VAGUE_DEFAULT, 0.4),
    },

    /** Vitesses moyennes (m/min) pour le repli cercle quand ORS est absent. */
    speeds: {
      walking: num(process.env.PLOC_SPEED_WALK_M_MIN, 80),
      cycling: num(process.env.PLOC_SPEED_BIKE_M_MIN, 250),
      driving: num(process.env.PLOC_SPEED_CAR_M_MIN, 500),
    },

    /** Sous ce score global max (0..1), les contraintes sont jugées incompatibles. */
    consistencyThreshold: num(process.env.PLOC_CONSISTENCY_THRESHOLD, 0.35),

    /** Nombre de candidats renvoyés dans `top_candidates`. */
    topCandidates: num(process.env.PLOC_TOP_CANDIDATES, 5),
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

if (!isTest && config.adminEmails.length === 0) {
  throw new Error(
    "ADMIN_EMAILS (ou ADMIN_EMAIL) doit être défini dans .env (voir .env.example)."
  );
}

export default config;

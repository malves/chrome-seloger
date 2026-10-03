/**
 * Lecture et validation des variables d'environnement.
 *
 * Toutes les valeurs par défaut du financement vivent ici : le service de
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

  logLevel: process.env.LOG_LEVEL || (isTest ? "silent" : "info"),

  /** Longueur minimale d'un mot de passe. */
  passwordMinLength: 10,

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
    notaryRateOld: num(process.env.NOTARY_RATE_OLD, 0.08),
    notaryRateNew: num(process.env.NOTARY_RATE_NEW, 0.025),
    guaranteeRate: num(process.env.GUARANTEE_RATE, 0.015),
    interestRate: num(process.env.DEFAULT_INTEREST_RATE, 0.035),
    insuranceRate: num(process.env.DEFAULT_INSURANCE_RATE, 0.003),
    years: num(process.env.DEFAULT_YEARS, 25),
    debtRatio: num(process.env.DEBT_RATIO, 0.35),
    downPayment: 0,
    works: 0,
  },
};

if (isProduction && config.sessionSecret === "change-me") {
  throw new Error(
    "SESSION_SECRET doit être défini en production (voir .env.example)."
  );
}

export default config;

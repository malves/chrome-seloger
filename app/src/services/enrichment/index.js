/**
 * Registre et orchestration des providers d'enrichissement.
 *
 * Un provider est un fichier `*.provider.js` de ce dossier exportant par
 * défaut :
 *
 *   {
 *     key: 'commune',        // identifiant unique, sert aussi de nom de partial
 *     scope: 'commune',      // 'commune' (cache partagé par INSEE) | 'listing'
 *     ttlDays: 180,          // durée de validité du cache
 *     label: 'Commune',      // titre du bloc sur la fiche
 *     order: 0,              // ordre d'exécution (0 = en premier)
 *     resolvesInsee: true,   // facultatif : s'exécute même sans code INSEE
 *     async fetch(ctx) {}    // ctx = { listing, inseeCode, fetchJson, ... }
 *   }
 *
 * Ajouter une source de donnée = déposer un fichier provider et un partial
 * `views/partials/enrichment/<key>.ejs`. Aucune autre modification.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import config, { rootDir } from "../../config.js";
import { listingTerritory } from "../../lib/listing-territory.js";
import { daysSince } from "../../lib/time.js";
import ProviderSkipped from "./skipped.js";

const providersDir = path.dirname(fileURLToPath(import.meta.url));
const partialsDir = path.join(
  rootDir,
  "src",
  "views",
  "partials",
  "enrichment"
);

export { ProviderSkipped };

/**
 * Appel HTTP JSON avec délai maximum et un seul nouvel essai.
 */
export async function fetchJson(url, options = {}) {
  const {
    timeoutMs = config.enrichment.timeoutMs,
    retries = config.enrichment.retries,
    headers = {},
  } = options;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json", ...headers },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} sur ${url}`);
      }
      return await response.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function loadProviders() {
  const files = (await fs.readdir(providersDir))
    .filter((name) => name.endsWith(".provider.js"))
    .sort();

  const providers = [];
  for (const file of files) {
    const module = await import(path.join(providersDir, file));
    const provider = module.default;
    if (!provider?.key || typeof provider.fetch !== "function") continue;
    providers.push({ order: 100, scope: "listing", ttlDays: 30, ...provider });
  }

  return providers.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

async function loadPartials() {
  try {
    const files = await fs.readdir(partialsDir);
    return new Set(
      files
        .filter((name) => name.endsWith(".ejs"))
        .map((name) => name.replace(/\.ejs$/, ""))
    );
  } catch {
    return new Set();
  }
}

export default function createEnrichmentService({ repositories, logger }) {
  let registry = null;

  async function getRegistry() {
    if (!registry) {
      const [providers, partials] = await Promise.all([
        loadProviders(),
        loadPartials(),
      ]);
      registry = { providers, partials };
    }
    return registry;
  }

  /** Lit le cache communal, en tenant compte de la durée de validité. */
  function readCommuneCache(provider, inseeCode) {
    if (!inseeCode) return null;
    const row = repositories.enrichments.findCommune(inseeCode, provider.key);
    if (!row) return null;
    if (daysSince(row.fetched_at) > provider.ttlDays) return null;
    return row;
  }

  async function runProvider(provider, listing, { force = false } = {}) {
    const context = {
      listing,
      inseeCode: listing.insee_code || null,
      repositories,
      fetchJson,
      logger,
      config,
    };

    if (provider.scope === "commune") {
      const territory = listingTerritory(listing);
      const skipCache = territory.source === "user";
      const cached =
        !force && !skipCache
          ? readCommuneCache(provider, context.inseeCode)
          : null;
      if (cached) {
        repositories.enrichments.saveListingResult(listing.id, provider.key, {
          status: "ok",
          data: null,
        });
        return;
      }

      if (!context.inseeCode && !provider.resolvesInsee) {
        throw new ProviderSkipped(
          "Commune inconnue : le code INSEE n'a pas encore été résolu."
        );
      }

      const data = await provider.fetch(context);
      const inseeCode = data?.insee_code || context.inseeCode;
      if (!inseeCode) {
        throw new Error("Le provider n'a pas retourné de code INSEE.");
      }

      repositories.enrichments.saveCommune(inseeCode, provider.key, data);
      const forceInsee =
        territory.source === "user" || listing.insee_code !== inseeCode;
      if (!listing.insee_code || forceInsee) {
        repositories.listings.setInseeCode(listing.id, inseeCode, {
          force: forceInsee,
        });
        listing.insee_code = inseeCode;
      }
      repositories.enrichments.saveListingResult(listing.id, provider.key, {
        status: "ok",
        data: null,
      });
      return;
    }

    const data = await provider.fetch(context);
    repositories.enrichments.saveListingResult(listing.id, provider.key, {
      status: "ok",
      data,
    });
  }

  /**
   * Exécute les providers d'une annonce. Une erreur sur l'un n'empêche pas
   * les suivants : elle est enregistrée et affichée sur la fiche.
   */
  async function runForListing(userId, listingId, { only = null, force = false } = {}) {
    const { providers } = await getRegistry();
    const selected = only
      ? providers.filter((provider) => provider.key === only)
      : providers;

    for (const provider of selected) {
      // Relu à chaque tour : un provider peut avoir renseigné le code INSEE.
      const listing = repositories.listings.findById(userId, listingId);
      if (!listing) return;

      try {
        await runProvider(provider, listing, { force });
      } catch (err) {
        const skipped = err instanceof ProviderSkipped;
        repositories.enrichments.saveListingResult(listingId, provider.key, {
          status: "error",
          data: null,
          error: err.message,
        });
        logger[skipped ? "debug" : "warn"](
          { provider: provider.key, listingId, err: err.message },
          "enrichissement en échec"
        );
      }
    }
  }

  /**
   * Lance l'enrichissement sans bloquer la réponse HTTP : même process, pas de
   * file de messages en V1.
   */
  function schedule(userId, listingId, options) {
    setImmediate(() => {
      runForListing(userId, listingId, options).catch((err) => {
        logger.error({ err, listingId }, "orchestration d'enrichissement");
      });
    });
  }

  /**
   * Données d'affichage de la fiche : un bloc par provider, avec son partial,
   * son statut et sa date de mise à jour.
   */
  async function viewModel(listing) {
    const { providers, partials } = await getRegistry();
    const stored = repositories.enrichments.findByListing(listing.id);

    return providers.map((provider) => {
      const record = stored[provider.key] || null;
      let data = record?.data || null;
      let fetchedAt = record?.fetched_at || null;

      if (provider.scope === "commune" && listing.insee_code) {
        const cached = repositories.enrichments.findCommune(
          listing.insee_code,
          provider.key
        );
        if (cached) {
          data = cached.data;
          fetchedAt = cached.fetched_at;
        }
      }

      const status = record?.status || (data ? "ok" : "pending");

      return {
        key: provider.key,
        label: provider.label || provider.key,
        scope: provider.scope,
        source: provider.source || null,
        sourceUrl: provider.sourceUrl || null,
        // Chemin relatif à `views/partials/`, dossier du partial englobant.
        partial: partials.has(provider.key)
          ? `enrichment/${provider.key}`
          : "enrichment/_generic",
        status: data ? "ok" : status,
        error: record?.error || null,
        fetchedAt,
        data,
      };
    });
  }

  async function listProviders() {
    const { providers } = await getRegistry();
    return providers.map(({ key, label, scope }) => ({ key, label, scope }));
  }

  return { runForListing, schedule, viewModel, listProviders, fetchJson };
}

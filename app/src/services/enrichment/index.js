/**
 * Registre et orchestration des providers d'enrichissement.
 *
 * Un provider est un fichier `*.provider.js` de ce dossier exportant par
 * défaut :
 *
 *   {
 *     key: 'commune',        // identifiant unique, sert aussi de nom de partial
 *     scope: 'commune',      // 'commune' (INSEE) | 'department' (code dépt) | 'listing'
 *     ttlDays: 180,          // durée de validité du cache
 *     label: 'Commune',      // titre du bloc sur la fiche
 *     order: 0,              // ordre d'exécution (0 = en premier)
 *     group: 'territory',    // facultatif : regroupement d'affichage sur la fiche
 *     display: true,         // facultatif : false = provider cache-only (pas de bloc)
 *     resolvesInsee: true,   // facultatif : s'exécute même sans code INSEE
 *     async fetch(ctx) {}    // ctx = { listing, inseeCode, deptCode, fetchJson, ... }
 *   }
 *
 * Trois portées de cache :
 *  - `commune` → `commune_data`, partagé par code INSEE ;
 *  - `department` → `department_data`, partagé par code département ;
 *  - `listing` → `listing_enrichments`, propre à une annonce (ex. adresse saisie).
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
import {
  departmentCodeFromInsee,
  marketVerdict,
  needsImmoDataMarketRefresh,
  patchImmoDataMarketHorizons,
} from "../../lib/immo-data-market.js";
import ProviderSkipped from "./skipped.js";
import { needsDvfLocalRefresh } from "./dvf-local.provider.js";

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
    const merged = { order: 100, scope: "listing", ttlDays: 30, display: true, ...provider };
    merged.group =
      provider.group || (merged.scope === "commune" ? "territory" : "market");
    providers.push(merged);
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
  /** Évite de lancer plusieurs orchestrations identiques en parallèle. */
  const runsInFlight = new Set();

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

  /** Lit le cache départemental, en tenant compte de la durée de validité. */
  function readDepartmentCache(provider, deptCode) {
    if (!deptCode) return null;
    const row = repositories.enrichments.findDepartment(deptCode, provider.key);
    if (!row) return null;
    if (daysSince(row.fetched_at) > provider.ttlDays) return null;
    return row;
  }

  /** Code département de l'annonce (cache commune si dispo, sinon depuis l'INSEE). */
  function resolveDeptCode(inseeCode) {
    if (!inseeCode) return null;
    const commune = repositories.enrichments.findCommune(inseeCode, "commune");
    return commune?.data?.department?.code || departmentCodeFromInsee(inseeCode);
  }

  /**
   * Les providers communaux et départementaux ne stockent pas de ligne
   * `listing_enrichments` en cas de succès (leur donnée vit dans le cache
   * partagé). On efface simplement une éventuelle ligne d'erreur devenue
   * obsolète, pour que la fiche ne garde pas un ancien « Réessayer ».
   */
  function clearListingStatus(listingId, key) {
    repositories.enrichments.removeOne(listingId, key);
  }

  async function runProvider(provider, listing, { force = false } = {}) {
    const inseeCode = listing.insee_code || null;
    const context = {
      listing,
      inseeCode,
      deptCode: resolveDeptCode(inseeCode),
      repositories,
      fetchJson,
      logger,
      config,
    };

    if (provider.scope === "commune") {
      const territory = listingTerritory(listing);
      const cached = !force ? readCommuneCache(provider, inseeCode) : null;
      if (cached) {
        clearListingStatus(listing.id, provider.key);
        return;
      }

      if (!inseeCode && !provider.resolvesInsee) {
        throw new ProviderSkipped(
          "Commune inconnue : le code INSEE n'a pas encore été résolu."
        );
      }

      const data = await provider.fetch(context);
      const resolvedInsee = data?.insee_code || inseeCode;
      if (!resolvedInsee) {
        throw new Error("Le provider n'a pas retourné de code INSEE.");
      }

      repositories.enrichments.saveCommune(resolvedInsee, provider.key, data);
      const forceInsee =
        territory.source === "user" || listing.insee_code !== resolvedInsee;
      if (!listing.insee_code || forceInsee) {
        repositories.listings.setInseeCode(listing.id, resolvedInsee, {
          force: forceInsee,
        });
        listing.insee_code = resolvedInsee;
      }
      clearListingStatus(listing.id, provider.key);
      return;
    }

    if (provider.scope === "department") {
      if (!inseeCode) {
        throw new ProviderSkipped(
          "Commune inconnue : le code INSEE n'a pas encore été résolu."
        );
      }
      const deptCode = context.deptCode;
      if (!deptCode) {
        throw new ProviderSkipped("Département indéterminé pour cette annonce.");
      }

      const cached = !force ? readDepartmentCache(provider, deptCode) : null;
      if (cached) {
        clearListingStatus(listing.id, provider.key);
        return;
      }

      const data = await provider.fetch(context);
      repositories.enrichments.saveDepartment(deptCode, provider.key, data);
      clearListingStatus(listing.id, provider.key);
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
    const runKey = `${userId}:${listingId}:${only || "*"}`;
    if (runsInFlight.has(runKey)) return;
    runsInFlight.add(runKey);

    const { providers } = await getRegistry();
    const selected = only
      ? providers.filter((provider) => provider.key === only)
      : providers;

    try {
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
    } finally {
      runsInFlight.delete(runKey);
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
  /** Rapatrie les séries départementales Immo Data dans le payload d'affichage. */
  function mergeImmoDepartment(data, deptCode) {
    if (!data?.evolution?.by_type || !deptCode) return;
    const dept = repositories.enrichments.findDepartment(deptCode, "immo-data-dept");
    if (!dept?.data?.by_type) return;
    for (const type of ["apartment", "house"]) {
      if (data.evolution.by_type[type]) {
        data.evolution.by_type[type].department = dept.data.by_type[type] || null;
      }
    }
    if (dept.data.department) data.evolution.department = dept.data.department;
  }

  /** Verdict de prix propre à l'annonce (prix du bien vs référence communale). */
  function applyImmoVerdict(data, listing) {
    const type =
      listing.property_type === "house"
        ? "house"
        : listing.property_type === "apartment"
          ? "apartment"
          : null;
    const referencePrice =
      type && data.commune?.[type]?.median_price_m2
        ? data.commune[type].median_price_m2
        : null;
    data.verdict = referencePrice ? marketVerdict(listing, referencePrice) : null;
  }

  /** Comparatif « grand quartier » (Immo Data) + DVF local, si adresse saisie. */
  function attachAddressComparison(data, stored, listing) {
    const territory = listingTerritory(listing);
    if (territory.source !== "user") {
      data.address_comparison = null;
      return;
    }
    const quartier = stored["immo-data-quartier"]?.data || null;
    const dvf = stored["dvf-local"]?.data || null;
    data.address_comparison = quartier || dvf ? { quartier, dvf } : null;
  }

  /** Fusionne le volet départemental de la délinquance (cache département). */
  function mergeDelinquanceDepartment(data, deptCode) {
    if (!data || !deptCode) return;
    const dept = repositories.enrichments.findDepartment(deptCode, "delinquance-dept");
    if (!dept?.data) return;
    data.department_benchmark = dept.data.department_benchmark || [];
    data.score = data.score || {};
    data.score.department_index = dept.data.score?.department_index ?? null;
    data.score.department_persons_index =
      dept.data.score?.department_persons_index ?? null;
    data.score.department_property_index =
      dept.data.score?.department_property_index ?? null;
  }

  /** Recalcule et persiste le DVF local si absent ou au format obsolète. */
  async function ensureDvfLocalCache(listing, stored, providers) {
    if (listingTerritory(listing).source !== "user") return;
    const row = stored["dvf-local"];
    if (row?.status === "ok" && row?.data && !needsDvfLocalRefresh(row.data)) {
      return;
    }
    const provider = providers.find((p) => p.key === "dvf-local");
    if (!provider) return;
    try {
      await runProvider(provider, listing, { force: true });
    } catch (err) {
      const skipped = err instanceof ProviderSkipped;
      logger[skipped ? "debug" : "warn"](
        { listingId: listing.id, err: err.message },
        "DVF local indisponible pour la fiche"
      );
    }
  }

  async function viewModel(listing) {
    const { providers, partials } = await getRegistry();
    const inseeCode = listing.insee_code || null;
    const deptCode = resolveDeptCode(inseeCode);
    let stored = repositories.enrichments.findByListing(listing.id);

    // Migration one-shot : si le cache communal Immo Data date d'un ancien
    // format, on le recalcule (ainsi que le volet départemental).
    if (inseeCode) {
      const immoCommune = repositories.enrichments.findCommune(inseeCode, "immo-data");
      if (immoCommune?.data && needsImmoDataMarketRefresh(immoCommune.data)) {
        for (const key of ["immo-data", "immo-data-dept"]) {
          const prov = providers.find((p) => p.key === key);
          if (!prov) continue;
          try {
            await runProvider(prov, listing, { force: true });
          } catch (err) {
            logger.warn(
              { listingId: listing.id, provider: key, err: err.message },
              "migration cache analyse de marché Immo Data"
            );
          }
        }
      }
    }

    await ensureDvfLocalCache(listing, stored, providers);
    stored = repositories.enrichments.findByListing(listing.id);

    return providers
      .filter((provider) => provider.display !== false)
      .map((provider) => {
        let data = null;
        let fetchedAt = null;

        if (provider.scope === "commune") {
          const cached = inseeCode
            ? repositories.enrichments.findCommune(inseeCode, provider.key)
            : null;
          data = cached?.data || null;
          fetchedAt = cached?.fetched_at || null;
        } else if (provider.scope === "department") {
          const cached = repositories.enrichments.findDepartment(
            deptCode,
            provider.key
          );
          data = cached?.data || null;
          fetchedAt = cached?.fetched_at || null;
        } else {
          const record = stored[provider.key] || null;
          data = record?.data || null;
          fetchedAt = record?.fetched_at || null;
        }

        if (provider.key === "immo-data" && data) {
          mergeImmoDepartment(data, deptCode);
          applyImmoVerdict(data, listing);
          attachAddressComparison(data, stored, listing);
          patchImmoDataMarketHorizons(data);
        } else if (provider.key === "delinquance" && data) {
          mergeDelinquanceDepartment(data, deptCode);
        }

        // Le statut d'erreur (fiche « Réessayer ») reste porté par l'annonce,
        // quelle que soit la portée du cache.
        const record = stored[provider.key] || null;
        const status = data ? "ok" : record?.status || "pending";

        return {
          key: provider.key,
          label: provider.label || provider.key,
          scope: provider.scope,
          group: provider.group,
          source: provider.source || null,
          sourceUrl: provider.sourceUrl || null,
          // Chemin relatif à `views/partials/`, dossier du partial englobant.
          partial: partials.has(provider.key)
            ? `enrichment/${provider.key}`
            : "enrichment/_generic",
          status,
          error: record?.error || null,
          fetchedAt,
          data,
        };
      });
  }

  /**
   * Vrai tant qu'un bloc affiché sur la fiche attend encore un enrichissement
   * (cache vide ou calcul en cours).
   */
  function isEnrichmentPending(blocks) {
    return (blocks || []).some(
      (provider) => provider.key !== "financing" && provider.status === "pending"
    );
  }

  async function listProviders() {
    const { providers } = await getRegistry();
    return providers.map(({ key, label, scope, group, display }) => ({
      key,
      label,
      scope,
      group,
      display,
    }));
  }

  return {
    runForListing,
    schedule,
    viewModel,
    isEnrichmentPending,
    listProviders,
    fetchJson,
  };
}

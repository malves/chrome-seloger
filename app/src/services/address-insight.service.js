/**
 * Fiche d'une adresse saisie à la main (page admin « Infos adresse »).
 *
 * À partir d'une adresse texte, le service :
 *  1. géocode via la Base Adresse Nationale (BAN, data.gouv), avec cache ;
 *  2. estime le prix au m² local à partir des ventes réelles DVF, dans un
 *     rayon autour du point, pour l'appartement et la maison ;
 *  3. construit l'évolution du prix (commune puis repli département) ;
 *  4. renvoie les ventes récentes autour de l'adresse ;
 *  5. liste les DPE connus de la voie (base ADEME importée).
 *
 * Aucune écriture de schéma : lecture seule des tables existantes.
 */

import {
  boundingBox,
  buildDvfRadiusReference,
  salesWithinRadius,
  buildEvolution,
} from "../lib/dvf-stats.js";
import { departmentCodeFromInsee } from "../lib/immo-data-market.js";
import {
  parseStreetLine,
  compareStreetNames,
  normalizeStreetName,
} from "../lib/street-match.js";
import { stripLocalityFromBanAddress } from "../lib/dpe-address.js";

const BAN_SEARCH = "https://api-adresse.data.gouv.fr/search/";
const GEOCODE_PROVIDER = "ban-address-insight";

const PROPERTY_TYPES = [
  { key: "apartment", label: "Appartement" },
  { key: "house", label: "Maison" },
];

/** Nombre de ventes récentes détaillées renvoyées au client. */
const MAX_SALES = 24;
/** DPE de la voie renvoyés au client (les plus récents). */
const MAX_DPE = 20;
/** Score minimal pour qu'un DPE soit considéré sur la même voie. */
const MIN_DPE_STREET_SCORE = 0.78;

function dpeDate(record) {
  return (
    record.date_etablissement_dpe ||
    record.date_derniere_modification_dpe ||
    null
  );
}

export default function createAddressInsightService({
  repositories,
  config,
  logger,
  fetchImpl = fetch,
} = {}) {
  const dvf = repositories.dvf;
  const dpeRepo = repositories.dpe;
  const postalInsee = repositories.postalInsee;
  const geocodeCache = repositories.geocodeCache;

  /** Géocode une adresse via la BAN (cache positif et négatif). */
  async function geocode(text) {
    const query = String(text || "").trim();
    if (!query) return null;

    const cached = geocodeCache?.get(GEOCODE_PROVIDER, query);
    if (cached) return cached.found ? cached : null;

    const url = `${BAN_SEARCH}?q=${encodeURIComponent(query)}&limit=1`;
    let feature = null;
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(config?.enrichment?.timeoutMs ?? 8000),
      });
      if (response.ok) {
        const data = await response.json();
        feature = data?.features?.[0] ?? null;
      } else {
        logger?.warn?.({ status: response.status }, "address-insight/ban-error");
      }
    } catch (err) {
      logger?.warn?.({ err: err.message }, "address-insight/ban-unreachable");
      return null;
    }

    if (!feature?.geometry?.coordinates) {
      geocodeCache?.set(GEOCODE_PROVIDER, query, { found: false });
      return null;
    }

    const [lng, lat] = feature.geometry.coordinates;
    const props = feature.properties || {};
    const result = {
      found: true,
      place: props.label || query,
      lat,
      lng,
      confidence: props.score ?? null,
      raw: {
        label: props.label || null,
        postcode: props.postcode || null,
        citycode: props.citycode || null,
        city: props.city || null,
        type: props.type || null,
        street: props.street || props.name || null,
      },
    };
    geocodeCache?.set(GEOCODE_PROVIDER, query, result);
    return result;
  }

  /** Référence €/m² dans un rayon : médiane pondérée (ventes récentes). */
  function radiusReference(type, lat, lng, meters, yearFrom, opts) {
    const bbox = boundingBox(lat, lng, meters);
    const candidates = dvf.radiusCandidates(type, bbox, { yearFrom });
    const sales = salesWithinRadius(candidates, lat, lng, meters);
    return buildDvfRadiusReference(sales, opts);
  }

  /** Prix local DVF pour un type de bien, avec élargissement si l'échantillon est faible. */
  function priceForType(type, lat, lng) {
    const {
      radiusMeters,
      radiusMinSample,
      radiusYears,
      radiusRecencyHalfLifeDays: halfLifeDays,
      radiusOutlierLowRatio: outlierLowRatio,
    } = config.dvf;
    const yearFrom = new Date().getFullYear() - radiusYears;
    const now = new Date();
    const opts = { now, halfLifeDays, outlierLowRatio };

    let meters = radiusMeters;
    let ref = radiusReference(type, lat, lng, meters, yearFrom, opts);
    let widened = false;
    if (ref.count < radiusMinSample) {
      const wider = radiusReference(type, lat, lng, meters * 2, yearFrom, opts);
      if (wider.count > ref.count) {
        meters *= 2;
        ref = wider;
        widened = true;
      }
    }
    if (ref.median == null) return null;

    return {
      meters,
      median_price_m2: ref.median,
      count: ref.count,
      count_reference: ref.count_reference,
      outliers_excluded: ref.outliers_excluded,
      widened,
      enough: ref.count >= radiusMinSample,
      years: radiusYears,
      outlier_floor_m2: ref.outlier_floor_m2,
      outlier_ceiling_m2: ref.outlier_ceiling_m2,
      sales: ref.sales,
    };
  }

  /** Évolution du prix : commune (repli département) pour un type de bien. */
  function evolutionForType(type, insee, dept) {
    if (insee) {
      const commune = buildEvolution(dvf.communeSeries(insee, type));
      if (commune) return { scope: "commune", ...commune };
    }
    if (dept) {
      const department = buildEvolution(dvf.departmentSeries(dept, type));
      if (department) return { scope: "department", ...department };
    }
    return null;
  }

  /** DPE de la voie saisie (base ADEME importée, match sur le nom de rue). */
  function dpeForAddress(street, postalCode) {
    if (!dpeRepo?.addressLookupRows || !/^\d{5}$/.test(String(postalCode || ""))) {
      return [];
    }
    const typed = parseStreetLine(street);
    if (!typed?.name) return [];

    const rows = dpeRepo.addressLookupRows({ codePostal: postalCode });
    const seen = new Set();
    const matched = [];
    for (const row of rows) {
      const banLine = row.adresse_ban
        ? stripLocalityFromBanAddress(row.adresse_ban, row.code_postal_ban, null)
        : null;
      const brutLine = row.adresse_brut
        ? stripLocalityFromBanAddress(row.adresse_brut, row.code_postal_ban, null)
        : null;
      const banName = banLine ? parseStreetLine(banLine)?.name : null;
      const brutName = brutLine ? parseStreetLine(brutLine)?.name : null;
      const score = Math.max(
        banName ? compareStreetNames(typed.name, banName).score : 0,
        brutName ? compareStreetNames(typed.name, brutName).score : 0
      );
      if (score < MIN_DPE_STREET_SCORE) continue;
      if (seen.has(row.numero_dpe)) continue;
      seen.add(row.numero_dpe);
      matched.push({ row, score });
    }

    return matched
      .sort((a, b) => {
        const da = dpeDate(a.row) || "";
        const db = dpeDate(b.row) || "";
        return db.localeCompare(da) || b.score - a.score;
      })
      .slice(0, MAX_DPE)
      .map(({ row }) => ({
        numero_dpe: row.numero_dpe,
        adresse: row.adresse_ban || row.adresse_brut || null,
        etiquette_dpe: row.etiquette_dpe || null,
        etiquette_ges: row.etiquette_ges || null,
        type_batiment: row.type_batiment || null,
        surface: Number(row.surface_habitable_logement) || null,
        annee_construction: row.annee_construction || null,
        date: dpeDate(row),
      }));
  }

  /**
   * Analyse complète d'une adresse.
   * @param {string} address  adresse libre saisie par l'administrateur
   */
  async function analyze(address) {
    const point = await geocode(address);
    if (!point) {
      return { status: "not_found", query: String(address || "").trim() };
    }

    const postalCode = point.raw?.postcode || null;
    // La BAN renvoie directement le code INSEE (`citycode`) ; repli HexaSmal.
    const insee =
      point.raw?.citycode ||
      (postalCode
        ? (postalInsee?.findInseeByPostal?.(postalCode) || [])[0] ?? null
        : null);
    const dept = departmentCodeFromInsee(insee);
    const hasDvf = Boolean(dvf?.hasData?.());

    const prices = {};
    const evolution = {};
    const salesByType = {};
    for (const { key } of PROPERTY_TYPES) {
      prices[key] = hasDvf ? priceForType(key, point.lat, point.lng) : null;
      evolution[key] = hasDvf ? evolutionForType(key, insee, dept) : null;
      salesByType[key] = prices[key]?.sales
        ? prices[key].sales.slice(0, MAX_SALES)
        : [];
    }

    const streetLabel = point.raw?.street || point.raw?.label || address;
    const dpe = dpeForAddress(streetLabel, postalCode);

    return {
      status: "ok",
      query: String(address || "").trim(),
      place: {
        label: point.place,
        lat: point.lat,
        lng: point.lng,
        postal_code: postalCode,
        insee_code: insee,
        department: dept,
        city: point.raw?.city || null,
        street: point.raw?.street || null,
        type: point.raw?.type || null,
      },
      dvf_available: hasDvf,
      prices,
      evolution,
      sales: salesByType,
      dpe,
      types: PROPERTY_TYPES,
    };
  }

  /** Suggestions d'adresses (proxy BAN) pour l'autocomplétion. */
  async function suggest(query, { limit = 6 } = {}) {
    const q = String(query || "").trim();
    if (q.length < 3) return [];
    const url =
      `${BAN_SEARCH}?q=${encodeURIComponent(q)}` +
      `&limit=${Math.min(10, Math.max(1, limit))}&autocomplete=1`;
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(config?.enrichment?.timeoutMs ?? 8000),
      });
      if (!response.ok) return [];
      const data = await response.json();
      return (data?.features || [])
        .map((f) => ({
          label: f.properties?.label || "",
          context: f.properties?.context || "",
          postal_code: f.properties?.postcode || null,
          city: f.properties?.city || null,
        }))
        .filter((s) => s.label);
    } catch (err) {
      logger?.warn?.({ err: err.message }, "address-insight/suggest-unreachable");
      return [];
    }
  }

  return { analyze, suggest, geocode };
}

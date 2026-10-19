/**
 * Source de repli de l'import DVF : fichier brut DGFiP d'une année absente de
 * geo-dvf, géocodé par lot via la Base Adresse Nationale avant insertion.
 */

import readline from "node:readline";
import { buildMutation, DVF_TYPE_KEYS } from "../lib/dvf-csv.js";
import {
  parseDgfipLine,
  dgfipHeaderIndex,
  parseDgfipRow,
  pickDgfipResource,
  banGeocodeCsv,
  parseBanGeocodeCsv,
} from "../lib/dvf-dgfip.js";
import { readZipEntries, zipEntryStream } from "../lib/zip.js";

const DATASET_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 600_000;
/** Reste sous le délai de détection d'un job orphelin, nouvel essai compris. */
const BAN_TIMEOUT_MS = 60_000;
const BAN_RETRY_DELAY_MS = 3_000;
const INSERT_BATCH = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ressource DGFiP de l'année dans le jeu data.gouv, ou null. */
export async function findDgfipResource({ fetchImpl, datasetUrl, year }) {
  const response = await fetchImpl(datasetUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(DATASET_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} lors de la lecture du jeu DGFiP sur data.gouv.`);
  }
  const dataset = await response.json();
  return pickDgfipResource(dataset?.resources, year);
}

/** Télécharge l'archive DGFiP et renvoie le flux du fichier texte qu'elle contient. */
export async function openDgfipStream({ fetchImpl, url }) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} lors du téléchargement du fichier DGFiP.`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const entry = readZipEntries(buffer).find((e) => /\.txt$/i.test(e.name));
  if (!entry) throw new Error("Archive DGFiP sans fichier texte.");
  return zipEntryStream(buffer, entry);
}

/**
 * Géocodeur par lot (BAN, `POST /search/csv`), espacé d'au moins
 * `minIntervalMs` entre deux appels. Renvoie `Map<id, { lat, lng }>`.
 */
export function createBanBatchGeocoder({ fetchImpl, url, minScore, minIntervalMs }) {
  let lastCallAt = 0;

  async function call(items) {
    const wait = lastCallAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();

    const form = new FormData();
    form.append("data", new Blob([banGeocodeCsv(items)], { type: "text/csv" }), "adresses.csv");
    form.append("columns", "adresse");
    form.append("citycode", "citycode");
    const response = await fetchImpl(url, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(BAN_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} lors du géocodage BAN.`);
    }
    return parseBanGeocodeCsv(await response.text(), { minScore });
  }

  return async function geocode(items) {
    if (!items.length) return new Map();
    try {
      return await call(items);
    } catch {
      await sleep(BAN_RETRY_DELAY_MS);
      return call(items);
    }
  };
}

/**
 * Importe un flux DGFiP : regroupe les lignes contiguës d'une mutation,
 * nettoie, géocode par lot d'adresses distinctes puis insère.
 * Une adresse non reconnue garde des coordonnées vides : la vente compte
 * toujours dans les médianes communales, pas dans le rayon.
 */
export async function importDgfipStream(stream, repo, {
  geocode,
  batchSize,
  cleanOptions,
  onProgress,
  onGeocodeError,
} = {}) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let headerIndex = null;
  let currentKey = null;
  let currentRows = [];
  let pending = [];
  let imported = 0;
  let geocoded = 0;

  const flushMutation = () => {
    if (!currentRows.length) return;
    const rows = currentRows;
    currentRows = [];
    const mutation = buildMutation(rows, cleanOptions);
    if (!mutation) return;
    const dwelling = rows.find((r) => DVF_TYPE_KEYS[r.type_local]);
    pending.push({ mutation, address: dwelling?.address || null });
  };

  const flushPending = async () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];

    const ids = new Map();
    const items = [];
    for (const item of batch) {
      if (!item.address) continue;
      const key = `${item.mutation.insee_code}|${item.address}`;
      if (!ids.has(key)) {
        const id = String(items.length);
        ids.set(key, id);
        items.push({ id, address: item.address, citycode: item.mutation.insee_code });
      }
      item.id = ids.get(key);
    }

    let coords = new Map();
    try {
      coords = await geocode(items);
    } catch (err) {
      if (onGeocodeError) onGeocodeError(err);
    }

    const rows = batch.map(({ mutation, id }) => {
      const point = id != null ? coords.get(id) : null;
      if (point) geocoded += 1;
      return point ? { ...mutation, lat: point.lat, lng: point.lng } : mutation;
    });
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      imported += repo.insertMutationBatch(rows.slice(i, i + INSERT_BATCH));
    }
    if (onProgress) onProgress(imported);
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = parseDgfipLine(line);
    if (!headerIndex) {
      headerIndex = dgfipHeaderIndex(cols);
      continue;
    }
    const row = parseDgfipRow(cols, headerIndex);
    if (!row) continue;
    if (row.mutation_key !== currentKey) {
      flushMutation();
      currentKey = row.mutation_key;
    }
    currentRows.push(row);
    if (pending.length >= batchSize) await flushPending();
  }
  flushMutation();
  await flushPending();
  return { imported, geocoded };
}

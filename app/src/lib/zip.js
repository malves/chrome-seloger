/**
 * Lecture minimale d'une archive zip en mémoire (sans dépendance npm) :
 * répertoire central, puis flux décompressé d'une entrée. Couvre les archives
 * classiques « stockées » ou « deflate », hors zip64 (entrées < 4 Go).
 */

import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const EOCD_MAX_COMMENT = 0xffff;

function findEndOfCentralDirectory(buffer) {
  const stop = Math.max(0, buffer.length - EOCD_MIN_SIZE - EOCD_MAX_COMMENT);
  for (let i = buffer.length - EOCD_MIN_SIZE; i >= stop; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error("Archive zip invalide : fin du répertoire central introuvable.");
}

/**
 * Liste les entrées d'une archive zip.
 * @param {Buffer} buffer
 * @returns {{ name: string, method: number, compressedSize: number, size: number, dataOffset: number }[]}
 */
export function readZipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error("Archive zip invalide : entrée du répertoire central corrompue.");
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`Archive zip invalide : en-tête local absent pour « ${name} ».`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;

    entries.push({ name, method, compressedSize, size, dataOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Flux du contenu décompressé d'une entrée (méthodes 0 « stockée » et 8 « deflate »). */
export function zipEntryStream(buffer, entry) {
  const data = buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.method === 0) return Readable.from([data]);
  if (entry.method === 8) return Readable.from([data]).pipe(createInflateRaw());
  throw new Error(`Méthode de compression zip non prise en charge (${entry.method}).`);
}

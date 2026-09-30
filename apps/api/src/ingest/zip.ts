import { inflateRawSync } from 'node:zlib';

/**
 * Just enough of the ZIP format to read DOCX and EPUB, which are both zip
 * containers of XML. Only the two compression methods those formats actually
 * use are supported: stored (0) and deflate (8).
 *
 * Reading the central directory rather than scanning local headers matters:
 * the local header may carry zero-length fields with the real sizes deferred
 * to a data descriptor after the payload, which is common in streamed zips.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EOCD_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;

export interface ZipEntry {
  readonly name: string;
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

export class ZipError extends Error {}

/** Locate the end-of-central-directory record, which is at the tail of the file. */
function findEocd(buf: Buffer): number {
  // The comment field can be up to 64KiB, so scan backwards over that window.
  const start = Math.max(0, buf.length - 0x10000 - 22);
  for (let i = buf.length - 22; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new ZipError('not a zip archive: no end-of-central-directory record');
}

export function listEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  let entryCount = buf.readUInt16LE(eocd + 10);
  let directoryOffset = buf.readUInt32LE(eocd + 16);

  // Zip64: the 32-bit fields saturate and the real values live in a separate record.
  if (directoryOffset === 0xffffffff || entryCount === 0xffff) {
    const locator = eocd - 20;
    if (locator >= 0 && buf.readUInt32LE(locator) === ZIP64_EOCD_LOCATOR) {
      const zip64Offset = Number(buf.readBigUInt64LE(locator + 8));
      if (buf.readUInt32LE(zip64Offset) !== ZIP64_EOCD) throw new ZipError('malformed zip64 record');
      entryCount = Number(buf.readBigUInt64LE(zip64Offset + 32));
      directoryOffset = Number(buf.readBigUInt64LE(zip64Offset + 48));
    }
  }

  const entries: ZipEntry[] = [];
  let p = directoryOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (p + 46 > buf.length) throw new ZipError('central directory runs past the end of the file');
    if (buf.readUInt32LE(p) !== CENTRAL_SIGNATURE) throw new ZipError('malformed central directory entry');

    const compressionMethod = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);

    entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Decompress one entry. */
export function readEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const off = entry.localHeaderOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== LOCAL_SIGNATURE) {
    throw new ZipError(`malformed local header for ${entry.name}`);
  }
  const nameLength = buf.readUInt16LE(off + 26);
  const extraLength = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLength + extraLength;

  if (entry.compressionMethod === 0) {
    return buf.subarray(dataStart, dataStart + entry.uncompressedSize);
  }
  if (entry.compressionMethod === 8) {
    // The central directory's compressed size is authoritative; when it is
    // absent, inflate to the end and let zlib find the stream's own terminator.
    const end = entry.compressedSize > 0 ? dataStart + entry.compressedSize : buf.length;
    return inflateRawSync(buf.subarray(dataStart, end));
  }
  throw new ZipError(`unsupported compression method ${entry.compressionMethod} for ${entry.name}`);
}

/** Read a named entry as UTF-8 text, or null when it is not in the archive. */
export function readTextEntry(buf: Buffer, entries: readonly ZipEntry[], name: string): string | null {
  const entry = entries.find((e) => e.name === name);
  if (!entry) return null;
  return readEntry(buf, entry).toString('utf8');
}

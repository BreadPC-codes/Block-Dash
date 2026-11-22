// Random-access ZIP reader over a Blob / File (also used for .pkz packages, which are ZIP
// archives). Only the central directory and the entries that are asked for are read, so
// opening a 500 MB track pack does not load 500 MB: the File is sliced, never copied whole.
// Supports stored and deflated entries and ZIP64. Encrypted entries are reported, not read.
import { inflateSync } from 'three/addons/libs/fflate.module.js';

const SIG_EOCD = 0x06054b50, SIG_Z64_LOC = 0x07064b50, SIG_Z64_EOCD = 0x06064b50;
const SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;

export class ZipError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const u64 = (dv, o) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296;

async function bytesOf(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/** CP437 is close enough to Latin-1 for file names; UTF-8 when the archive says so. */
function decodeName(bytes, utf8) {
  if (utf8) return new TextDecoder('utf-8').decode(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * Open a ZIP archive. `source` is a Blob/File, an ArrayBuffer or a Uint8Array.
 * Resolves to { entries: [{ name, size, compressedSize, method, encrypted, offset }], read(entry) }.
 * Rejects with ZipError code 'not-zip' for anything that is not a plain ZIP container.
 */
export async function openZip(source) {
  const blob = source instanceof Blob ? source : new Blob([source]);
  const size = blob.size;
  if (size < 22) throw new ZipError('The file is too small to be a ZIP / PKZ archive.', 'not-zip');
  const head = await bytesOf(blob, 0, 4);
  const magic = head[0] | (head[1] << 8) | (head[2] << 16) | (head[3] << 24);
  if (magic !== SIG_LOC && magic !== SIG_EOCD) {
    throw new ZipError('This file is not a plain ZIP container (protected / encrypted packages cannot be opened).', 'not-zip');
  }
  // end of central directory: in the last 22 + 65535 bytes
  const tailLen = Math.min(size, 22 + 65535 + 20);
  const tail = await bytesOf(blob, size - tailLen, size);
  const tdv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tdv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('The archive has no central directory (damaged or not a ZIP).', 'not-zip');
  let count = tdv.getUint16(eocd + 10, true);
  let cdSize = tdv.getUint32(eocd + 12, true);
  let cdOffset = tdv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // ZIP64: the locator sits right before the classic record
    const loc = eocd - 20;
    if (loc >= 0 && tdv.getUint32(loc, true) === SIG_Z64_LOC) {
      const z64Off = u64(tdv, loc + 8);
      const z = await bytesOf(blob, z64Off, z64Off + 56);
      const zdv = new DataView(z.buffer);
      if (zdv.getUint32(0, true) !== SIG_Z64_EOCD) throw new ZipError('Damaged ZIP64 directory.', 'not-zip');
      count = u64(zdv, 32);
      cdSize = u64(zdv, 40);
      cdOffset = u64(zdv, 48);
    }
  }
  if (cdOffset + cdSize > size) throw new ZipError('The archive is truncated.', 'not-zip');
  const cd = await bytesOf(blob, cdOffset, cdOffset + cdSize);
  const dv = new DataView(cd.buffer);
  const entries = [];
  let p = 0;
  for (let k = 0; k < count && p + 46 <= cd.length; k++) {
    if (dv.getUint32(p, true) !== SIG_CEN) break;
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    let compressedSize = dv.getUint32(p + 20, true);
    let usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    let offset = dv.getUint32(p + 42, true);
    const name = decodeName(cd.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);
    // ZIP64 extended information
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = dv.getUint16(e, true), len = dv.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff) { usize = u64(dv, q); q += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = u64(dv, q); q += 8; }
        if (offset === 0xffffffff) { offset = u64(dv, q); q += 8; }
      }
      e += 4 + len;
    }
    p = eEnd + commentLen;
    if (name.endsWith('/')) continue; // folder
    entries.push({ name: name.replace(/\\/g, '/'), size: usize, compressedSize, method, encrypted: (flags & 1) !== 0, offset });
  }

  async function read(entry) {
    if (entry.encrypted) throw new ZipError(`"${entry.name}" is encrypted.`, 'encrypted');
    const lh = await bytesOf(blob, entry.offset, entry.offset + 30);
    const ldv = new DataView(lh.buffer);
    if (ldv.getUint32(0, true) !== SIG_LOC) throw new ZipError(`Damaged entry "${entry.name}".`, 'damaged');
    const start = entry.offset + 30 + ldv.getUint16(26, true) + ldv.getUint16(28, true);
    const raw = await bytesOf(blob, start, start + entry.compressedSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) {
      try {
        return inflateSync(raw, { out: new Uint8Array(entry.size) });
      } catch (err) {
        throw new ZipError(`Could not decompress "${entry.name}" (${err.message}).`, 'damaged');
      }
    }
    throw new ZipError(`"${entry.name}" uses compression method ${entry.method}, which is not supported (only stored and deflate).`, 'method');
  }

  return { entries, read };
}

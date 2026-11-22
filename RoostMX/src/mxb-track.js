// MX Bikes track packages (.pkz): reads the parts of a track that Roost MX can ride.
//
// An MX Bikes track is a folder (zipped and renamed .pkz) with, among others:
//   <track>.trh   collision terrain: "TRH\0", u32 width, u32 height, int16 samples
//                 (width x height, row by row), then size x (m), relief (m), size z (m),
//                 more metadata and the track's centre lines (straight / arc records)
//   <track>.rdf   race data (text): finish line, splits, starting grid - positions given
//                 as a distance along a centre line
//   <track>.ini   name, author, ...
//   <track>.map   terrain graphics, *.edf scenery models, textures - not used here
// Work-in-progress folders may instead carry the heightmap sources: a 16-bit little-endian
// .raw heightmap with its .hmf (samples, size_x, size_z, scale = total height in m).
// Distribution packages sometimes nest a "<track>_server.pkz" with the .trh / .rdf / .ini.
//
// The .trh layout follows the reverse-engineered description in the MIT-licensed mxb-app
// project (github.com/Frostn1/mxb-app, crates/content/src/trh.rs). Packages that are not
// plain ZIP archives (protected / encrypted mods) are refused, never decrypted.
import { openZip, ZipError } from './zip-reader.js';

export const STORE_DIM = 2049; // grids are kept at most this many samples per side
const MIN_DIM = 32, MAX_DIM = 8193;
const MAX_NESTED = 512 * 1024 * 1024;

export class TrackImportError extends Error {}

const extOf = (n) => (/\.([^./]+)$/.exec(n) || [null, ''])[1].toLowerCase();
const dirOf = (n) => (n.includes('/') ? n.slice(0, n.lastIndexOf('/') + 1) : '');
const baseOf = (n) => n.slice(n.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
const finite = (v) => Number.isFinite(v);

// ---------------------------------------------------------------------------------
// .trh
// ---------------------------------------------------------------------------------

/** Trailing "EX3\0" / "EXT\0" chunks (tag + u32 size at the very end): where the main body ends. */
function mainBodyEnd(u8, dv) {
  let end = u8.length;
  for (const tag of ['EXT\0', 'EX3\0']) {
    if (end < 8) break;
    const t = String.fromCharCode(u8[end - 8], u8[end - 7], u8[end - 6], u8[end - 5]);
    if (t !== tag) continue;
    const size = dv.getUint32(end - 4, true);
    if (size < 8 || size > end) break;
    end -= size;
  }
  return end;
}

/**
 * Parse an MX Bikes .trh. Returns
 * { w, h, sizeX, sizeZ, relief, samples: Uint16Array (sample + 32768, file order),
 *   profile: { header: [x, z, deg], records: [{ flag, length, radius, elevation, running, m }] } | null,
 *   box: { min, max } | null, notes: [] }
 */
export function parseTrh(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length < 12 || u8[0] !== 0x54 || u8[1] !== 0x52 || u8[2] !== 0x48 || u8[3] !== 0) throw new TrackImportError('The .trh terrain file has an unknown format (no TRH header).');
  const w = dv.getUint32(4, true), h = dv.getUint32(8, true);
  if (w < MIN_DIM || h < MIN_DIM || w > MAX_DIM || h > MAX_DIM) throw new TrackImportError(`The .trh terrain has an unsupported size (${w} x ${h} samples).`);
  const sampleEnd = 12 + w * h * 2;
  if (sampleEnd > u8.length) throw new TrackImportError('The .trh terrain file is truncated.');
  const samples = new Uint16Array(w * h);
  for (let i = 0, o = 12; i < samples.length; i++, o += 2) samples[i] = dv.getInt16(o, true) + 32768;
  const notes = [];
  let sizeX = NaN, relief = NaN, sizeZ = NaN;
  if (sampleEnd + 12 <= u8.length) {
    sizeX = dv.getFloat32(sampleEnd, true);
    relief = dv.getFloat32(sampleEnd + 4, true);
    sizeZ = dv.getFloat32(sampleEnd + 8, true);
  }
  const sane = (v, max) => finite(v) && v > 0 && v < max;
  if (!sane(sizeX, 1e5) || !sane(sizeZ, 1e5) || !sane(relief, 1e4)) {
    // the file does not say how big it is: assume a typical MX Bikes spacing / relief
    sizeX = (w - 1) * 0.3;
    sizeZ = (h - 1) * 0.3;
    relief = 25;
    notes.push('The terrain file does not state its size; assumed 0.3 m per sample and 25 m of relief - use Scale to adjust.');
  }
  // centre lines and the track box follow; anything unexpected only loses the line
  let profile = null, box = null;
  try {
    const end = mainBodyEnd(u8, dv);
    let p = sampleEnd + 24; // size x, relief, size z + 12 more bytes of metadata
    const need = (n) => {
      if (p + n > end) throw new Error('short');
    };
    const u32 = () => { need(4); const v = dv.getUint32(p, true); p += 4; return v; };
    const f32 = () => { need(4); const v = dv.getFloat32(p, true); p += 4; return v; };
    const skip = (n) => { need(n); p += n; };
    const aCount = u32();
    if (aCount > 4096) throw new Error('A');
    for (let i = 0; i < aCount; i++) { skip(8); const r = u32(), c = u32(); skip(r * c); }
    const bCount = u32();
    if (bCount > 4096) throw new Error('B');
    for (let i = 0; i < bCount; i++) { skip(4); const r = u32(), c = u32(); skip(r * c); }
    const header = [f32(), f32(), f32()];
    skip(4);
    const bx = [f32(), f32(), f32(), f32(), f32(), f32()];
    if (bx.every(finite) && bx[3] > bx[0] && bx[5] > bx[2]) box = { min: [bx[0], bx[1], bx[2]], max: [bx[3], bx[4], bx[5]] };
    const cCount = u32();
    if (cCount > 1e6) throw new Error('C');
    skip(cCount * 52);
    const dCount = u32();
    if (dCount > 1e6) throw new Error('D');
    const records = [];
    for (let i = 0; i < dCount; i++) {
      need(60);
      const flag = dv.getUint32(p, true);
      const rec = {
        flag,
        length: dv.getFloat32(p + 4, true),
        radius: dv.getFloat32(p + 8, true),
        elevation: dv.getFloat32(p + 16, true),
        running: dv.getFloat32(p + 20, true),
        m: new Array(9),
      };
      for (let k = 0; k < 9; k++) rec.m[k] = dv.getFloat32(p + 24 + k * 4, true);
      p += 60;
      if (flag > 1 || !(rec.length > 0) || !finite(rec.length) || !rec.m.every(finite) || (flag === 1 && (!finite(rec.radius) || rec.radius === 0))) throw new Error('bad record');
      records.push(rec);
    }
    if (records.length) profile = { header, records };
  } catch (e) {
    profile = null;
  }
  if (!profile) notes.push('No centre line was found in the terrain file: the track can be ridden in Free Ride, without lap timing.');
  return { w, h, sizeX, sizeZ, relief, samples, profile, box, notes };
}

/**
 * Walk a centre line profile (records in MX Bikes world metres) and sample it every `step`
 * metres. Returns { pts: Float32Array [x0, z0, x1, z1, ...], elev: Float32Array, length, closed }.
 * Straights run along the local +z axis, arcs bend toward local +x for a positive radius;
 * each record carries its start transform (x' = m0 x + m1 z + m2, z' = m3 x + m4 z + m5).
 */
export function sampleProfile(profile, step = 0.5) {
  const recs = profile.records;
  const xs = [], zs = [], es = [];
  let total = 0;
  for (let r = 0; r < recs.length; r++) {
    const R = recs[r];
    const m = R.m;
    const next = recs[r + 1] || recs[0];
    const n = Math.max(1, Math.ceil(R.length / step));
    for (let k = 0; k < n; k++) {
      const along = (k / n) * R.length;
      let lx = 0, lz = along;
      if (R.flag === 1) {
        const a = along / R.radius;
        lx = R.radius - Math.cos(a) * R.radius;
        lz = Math.sin(a) * R.radius;
      }
      xs.push(m[0] * lx + m[1] * lz + m[2]);
      zs.push(m[3] * lx + m[4] * lz + m[5]);
      const e0 = finite(R.elevation) ? R.elevation : 0, e1 = finite(next.elevation) ? next.elevation : e0;
      es.push(e0 + (e1 - e0) * (along / R.length));
    }
    total += R.length;
  }
  // end point of the last record
  const L = recs[recs.length - 1], m = L.m;
  let lx = 0, lz = L.length;
  if (L.flag === 1) {
    const a = L.length / L.radius;
    lx = L.radius - Math.cos(a) * L.radius;
    lz = Math.sin(a) * L.radius;
  }
  const ex = m[0] * lx + m[1] * lz + m[2], ez = m[3] * lx + m[4] * lz + m[5];
  const gap = Math.hypot(ex - xs[0], ez - zs[0]);
  const closed = gap < Math.max(6, total * 0.01);
  if (!closed) {
    xs.push(ex);
    zs.push(ez);
    es.push(es[es.length - 1]);
  }
  const pts = new Float32Array(xs.length * 2);
  for (let i = 0; i < xs.length; i++) {
    pts[i * 2] = xs[i];
    pts[i * 2 + 1] = zs[i];
  }
  return { pts, elev: Float32Array.from(es), length: total, closed };
}

// ---------------------------------------------------------------------------------
// text files: .rdf, .ini, .hmf
// ---------------------------------------------------------------------------------

/** PiBoSo block syntax: `key = value` lines and `name` + `{ ... }` blocks (// comments). */
export function parseBlocks(text) {
  const root = { values: {}, blocks: {} };
  const stack = [root];
  let pending = null;
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  for (let raw of lines) {
    const c = raw.indexOf('//');
    if (c >= 0) raw = raw.slice(0, c);
    let line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    while (line) {
      const top = stack[stack.length - 1];
      if (line.startsWith('{')) {
        const blk = { values: {}, blocks: {} };
        const name = pending || '_';
        (top.blocks[name.toLowerCase()] = top.blocks[name.toLowerCase()] || []).push(blk);
        stack.push(blk);
        pending = null;
        line = line.slice(1).trim();
        continue;
      }
      if (line.startsWith('}')) {
        if (stack.length > 1) stack.pop();
        line = line.slice(1).trim();
        continue;
      }
      const brace = line.search(/[{}]/);
      const part = brace >= 0 ? line.slice(0, brace).trim() : line;
      line = brace >= 0 ? line.slice(brace) : '';
      if (!part) continue;
      const eq = part.indexOf('=');
      if (eq >= 0) {
        top.values[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
        pending = null;
      } else if (/^\[.*\]$/.test(part)) {
        pending = null; // ini section header: values stay at the top level
      } else {
        pending = part;
      }
    }
  }
  return root;
}

const num = (v) => {
  const x = parseFloat(v);
  return finite(x) ? x : null;
};

/** Race data: finish line, splits, holeshot and starting grid, as centre-line distances. */
export function parseRdf(text) {
  const doc = parseBlocks(text);
  const line = (name) => {
    const b = (doc.blocks[name] || [])[0];
    if (!b) return null;
    const v = { line: num(b.values.line) ?? 0, long: num(b.values.long), left: num(b.values.left), right: num(b.values.right) };
    return v.long == null ? null : v;
  };
  const grid = [];
  const g = (doc.blocks.starting_grid || [])[0];
  if (g) {
    for (const k of Object.keys(g.blocks)) {
      const m = /^stall(\d+)$/.exec(k);
      if (!m) continue;
      const s = g.blocks[k][0].values;
      const long = num(s.long);
      if (long != null) grid[+m[1]] = { long, lat: num(s.lat) ?? 0, angle: num(s.angle) ?? 0 };
    }
  }
  return {
    finish: line('finish_line'),
    split1: line('split1'),
    split2: line('split2'),
    holeshot: line('holeshot'),
    grid: grid.filter(Boolean),
  };
}

/** Track info: name and author (keys vary a little between track tools). */
export function parseIni(text) {
  const doc = parseBlocks(text);
  const v = doc.values;
  const name = v.name || v.track_name || v.trackname || v.title || '';
  return { name: String(name).slice(0, 60), author: String(v.author || v.creator || '').slice(0, 60), type: v.type || '' };
}

/** Heightmap settings: samples, size in metres and total height (`scale`). */
export function parseHmf(text) {
  const doc = parseBlocks(text);
  const v = doc.values;
  let raw = '';
  for (const val of Object.values(v)) if (/\.raw$/i.test(val)) raw = val;
  return {
    samplesX: num(v.samples_x),
    samplesZ: num(v.samples_z) ?? num(v.samples_y),
    sizeX: num(v.size_x),
    sizeZ: num(v.size_z) ?? num(v.size_y),
    scale: num(v.scale),
    raw,
  };
}

/** A 16-bit little-endian .raw heightmap (Photoshop "IBM PC" order), sized by its .hmf. */
export function parseRaw(u8, hmf) {
  const count = Math.floor(u8.length / 2);
  let w = hmf && hmf.samplesX, h = hmf && hmf.samplesZ;
  if (!(w > 1 && h > 1 && w * h <= count)) {
    if (w > 1 && count % w === 0) h = count / w;
    else {
      const n = Math.round(Math.sqrt(count));
      if (n * n !== count) throw new TrackImportError('The .raw heightmap size does not match a square grid and no .hmf says its size.');
      w = h = n;
    }
  }
  if (w < MIN_DIM || h < MIN_DIM || w > MAX_DIM || h > MAX_DIM) throw new TrackImportError(`The .raw heightmap has an unsupported size (${w} x ${h}).`);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const samples = new Uint16Array(w * h);
  for (let i = 0; i < samples.length; i++) samples[i] = dv.getUint16(i * 2, true);
  const notes = [];
  let sizeX = hmf && hmf.sizeX, sizeZ = hmf && hmf.sizeZ, relief = hmf && hmf.scale;
  if (!(sizeX > 0)) { sizeX = (w - 1) * 0.3; notes.push('No size_x in the .hmf: assumed 0.3 m per sample.'); }
  if (!(sizeZ > 0)) sizeZ = sizeX * ((h - 1) / (w - 1));
  if (!(relief > 0)) { relief = 25; notes.push('No height scale in the .hmf: assumed 25 m.'); }
  notes.push('Heightmap source files have no centre line: the track can be ridden in Free Ride, without lap timing.');
  return { w, h, sizeX, sizeZ, relief, samples, profile: null, box: null, notes };
}

// ---------------------------------------------------------------------------------
// grid helpers
// ---------------------------------------------------------------------------------

/** Average a grid down so neither side exceeds maxDim samples (keeps the area covered). */
export function downsampleGrid(samples, w, h, maxDim = STORE_DIM) {
  const f = Math.max(1, Math.ceil(Math.max(w - 1, h - 1) / (maxDim - 1)));
  if (f === 1) return { samples, w, h };
  const ow = Math.floor((w - 1) / f) + 1, oh = Math.floor((h - 1) / f) + 1;
  const out = new Uint16Array(ow * oh);
  const r = f >> 1;
  for (let j = 0; j < oh; j++) {
    const cj = j * f, j0 = Math.max(0, cj - r), j1 = Math.min(h - 1, cj + r);
    for (let i = 0; i < ow; i++) {
      const ci = i * f, i0 = Math.max(0, ci - r), i1 = Math.min(w - 1, ci + r);
      let sum = 0, n = 0;
      for (let y = j0; y <= j1; y++) {
        const row = y * w;
        for (let x = i0; x <= i1; x++) { sum += samples[row + x]; n++; }
      }
      out[j * ow + i] = Math.round(sum / n);
    }
  }
  return { samples: out, w: ow, h: oh };
}

/** Bilinear height (m) of a stored grid at fractional sample coordinates (clamped). */
export function gridHeight(g, gi, gj) {
  const w = g.w, h = g.h;
  if (gi < 0) gi = 0; else if (gi > w - 1.0001) gi = w - 1.0001;
  if (gj < 0) gj = 0; else if (gj > h - 1.0001) gj = h - 1.0001;
  const i = gi | 0, j = gj | 0, fx = gi - i, fz = gj - j;
  const s = g.samples, o = j * w + i;
  const a = s[o] + (s[o + 1] - s[o]) * fx;
  const b = s[o + w] + (s[o + w + 1] - s[o + w]) * fx;
  return (a + (b - a) * fz) * (g.relief / 65535);
}

/**
 * Where the grid sits in the world the centre line is given in. The documented layout puts
 * sample (i, j) at (i, j) x spacing; the centre line's own ground heights decide between
 * that and the other possibilities (centred grid, mirrored axes), so a track whose terrain
 * would come out mirrored under its line is caught. Returns { ox, oz, flipX, flipZ, inside, rms }.
 */
export function alignGrid(g, line) {
  const sx = g.sizeX, sz = g.sizeZ;
  const mx = sx / (g.w - 1), mz = sz / (g.h - 1);
  const n = line.pts.length / 2;
  const stride = Math.max(1, Math.floor(n / 400));
  let eMin = Infinity, eMax = -Infinity;
  for (let k = 0; k < n; k += stride) { eMin = Math.min(eMin, line.elev[k]); eMax = Math.max(eMax, line.elev[k]); }
  const elevationsUseful = eMax - eMin > 0.3;
  let best = null;
  for (const origin of [[0, 0], [-sx / 2, -sz / 2]]) {
    for (const flipX of [false, true]) {
      for (const flipZ of [false, true]) {
        let inside = 0, cnt = 0, sum = 0, sum2 = 0;
        for (let k = 0; k < n; k += stride) {
          cnt++;
          let gi = (line.pts[k * 2] - origin[0]) / mx, gj = (line.pts[k * 2 + 1] - origin[1]) / mz;
          if (gi < 0 || gj < 0 || gi > g.w - 1 || gj > g.h - 1) continue;
          inside++;
          if (flipX) gi = g.w - 1 - gi;
          if (flipZ) gj = g.h - 1 - gj;
          const d = line.elev[k] - gridHeight(g, gi, gj);
          sum += d;
          sum2 += d * d;
        }
        const frac = inside / Math.max(1, cnt);
        const mean = sum / Math.max(1, inside);
        const rms = Math.sqrt(Math.max(0, sum2 / Math.max(1, inside) - mean * mean));
        // prefer: line inside the grid, then the best height match, then the documented layout
        const score = frac * 1000 - (elevationsUseful ? rms : 0) - (flipX ? 0.01 : 0) - (flipZ ? 0.01 : 0) - (origin[0] ? 0.02 : 0);
        if (!best || score > best.score) best = { score, ox: origin[0], oz: origin[1], flipX, flipZ, inside: frac, rms, elevationsUseful };
      }
    }
  }
  return best;
}

function flipGrid(g, flipX, flipZ) {
  if (!flipX && !flipZ) return;
  const { w, h } = g;
  const out = new Uint16Array(w * h);
  for (let j = 0; j < h; j++) {
    const sj = flipZ ? h - 1 - j : j;
    for (let i = 0; i < w; i++) out[j * w + i] = g.samples[sj * w + (flipX ? w - 1 - i : i)];
  }
  g.samples = out;
}

/** Stable id from the name and the terrain itself (re-importing replaces the old copy). */
function trackId(name, g) {
  let h = 0x811c9dc5;
  const mix = (v) => { h ^= v & 0xffff; h = Math.imul(h, 16777619) >>> 0; };
  for (let i = 0; i < name.length; i++) mix(name.charCodeAt(i));
  mix(g.w); mix(g.h);
  const step = Math.max(1, Math.floor(g.samples.length / 4096));
  for (let i = 0; i < g.samples.length; i += step) mix(g.samples[i]);
  return 'mxb-' + h.toString(36);
}

const prettyName = (s) => s.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase()) || 'Imported track';

// ---------------------------------------------------------------------------------
// package
// ---------------------------------------------------------------------------------

/** Find the tracks in a list of archive entries: one per .trh (or .hmf + .raw) folder. */
function findTracks(entries) {
  const out = [];
  const pick = (folder, ext, preferBase) => {
    const c = entries.filter((e) => dirOf(e.name).toLowerCase() === folder && extOf(e.name) === ext);
    return c.find((e) => baseOf(e.name).toLowerCase() === preferBase) || c[0] || null;
  };
  for (const e of entries) {
    if (extOf(e.name) !== 'trh') continue;
    const folder = dirOf(e.name).toLowerCase(), b = baseOf(e.name).toLowerCase();
    out.push({ kind: 'trh', folder: dirOf(e.name), terrain: e, rdf: pick(folder, 'rdf', b), ini: pick(folder, 'ini', b) });
  }
  if (!out.length) {
    for (const e of entries) {
      if (extOf(e.name) !== 'hmf') continue;
      const folder = dirOf(e.name).toLowerCase(), b = baseOf(e.name).toLowerCase();
      const raw = pick(folder, 'raw', b);
      if (raw) out.push({ kind: 'raw', folder: dirOf(e.name), terrain: raw, hmf: e, rdf: pick(folder, 'rdf', b), ini: pick(folder, 'ini', b) });
    }
  }
  return out;
}

function describeContents(entries) {
  const counts = {};
  for (const e of entries) {
    const x = extOf(e.name) || '(none)';
    counts[x] = (counts[x] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${v} .${k}`).join(', ');
}

/**
 * Read a .pkz / .zip and return every track in it, ready to store:
 * [{ id, name, author, folder, source, grid: { w, h, sizeX, sizeZ, relief, ox, oz, samples },
 *    line: { pts, elev, length, closed } | null, timing: { finish, gate, splits } | null,
 *    notes: [], info: { sourceW, sourceH, kind } }]
 */
export async function readTrackPackage(file, { onProgress = () => {}, fileName } = {}) {
  const name = fileName || file.name || 'track.pkz';
  let zip;
  try {
    zip = await openZip(file);
  } catch (e) {
    if (e instanceof ZipError) throw new TrackImportError(e.code === 'not-zip' ? `${name} is not a plain ZIP / PKZ archive. Protected (encrypted) MX Bikes packages cannot be imported.` : e.message);
    throw e;
  }
  let found = findTracks(zip.entries), read = zip.read;
  if (!found.length) {
    // distribution packs can nest a "<track>_server.pkz" holding the terrain and race data
    const nested = zip.entries.filter((e) => /\.(pkz|zip)$/i.test(e.name) && e.size < MAX_NESTED).sort((a, b) => (/server/i.test(b.name) ? 1 : 0) - (/server/i.test(a.name) ? 1 : 0));
    for (const n of nested) {
      onProgress(0.1, 'Opening ' + baseOf(n.name) + '…');
      try {
        const inner = await openZip(await zip.read(n));
        const f = findTracks(inner.entries);
        if (f.length) { found = f; read = inner.read; break; }
      } catch (e) {
        /* not a track package */
      }
    }
  }
  if (!found.length) {
    const exts = zip.entries.map((e) => extOf(e.name));
    const hint = exts.includes('edf') && !exts.includes('map') ? ' It looks like a bike, rider gear or scenery mod rather than a track.' : '';
    throw new TrackImportError(`No MX Bikes track terrain (.trh, or .hmf + .raw heightmap) was found in ${name}.${hint} Contents: ${describeContents(zip.entries) || 'empty'}.`);
  }
  const tracks = [];
  for (let k = 0; k < found.length; k++) {
    const c = found[k];
    const frac = (x) => (k + x) / found.length;
    onProgress(frac(0.1), 'Reading the terrain…');
    let ini = { name: '', author: '' };
    if (c.ini) {
      try { ini = parseIni(new TextDecoder('utf-8').decode(await read(c.ini))); } catch (e) { /* optional */ }
    }
    let parsed;
    if (c.kind === 'trh') parsed = parseTrh(await read(c.terrain));
    else parsed = parseRaw(await read(c.terrain), parseHmf(new TextDecoder('utf-8').decode(await read(c.hmf))));
    onProgress(frac(0.6), 'Reading the track line…');
    const notes = parsed.notes.slice();
    const sourceW = parsed.w, sourceH = parsed.h;
    const ds = downsampleGrid(parsed.samples, parsed.w, parsed.h);
    const grid = { w: ds.w, h: ds.h, sizeX: parsed.sizeX, sizeZ: parsed.sizeZ, relief: parsed.relief, ox: 0, oz: 0, samples: ds.samples };
    let line = null;
    if (parsed.profile) {
      line = sampleProfile(parsed.profile, 0.5);
      const al = alignGrid(grid, line);
      if (al.inside < 0.9) {
        notes.push('The track centre line does not lie on the terrain, so it was left out: Free Ride only.');
        line = null;
      } else {
        grid.ox = al.ox;
        grid.oz = al.oz;
        flipGrid(grid, al.flipX, al.flipZ);
        if (al.flipX || al.flipZ || al.ox) notes.push('Terrain orientation matched to the centre line' + (al.elevationsUseful ? ` (heights agree within ${al.rms.toFixed(2)} m).` : '.'));
      }
    }
    let timing = null;
    if (line && c.rdf) {
      try {
        const rdf = parseRdf(new TextDecoder('utf-8').decode(await read(c.rdf)));
        const onMain = (l) => l && (l.line ?? 0) === 0 && l.long >= 0 && l.long <= line.length + 1;
        timing = {
          finish: onMain(rdf.finish) ? rdf.finish.long : null,
          gate: rdf.grid.length && rdf.grid[0].long >= 0 && rdf.grid[0].long <= line.length ? rdf.grid[0].long : null,
          splits: [rdf.split1, rdf.split2].filter(onMain).map((l) => l.long),
        };
      } catch (e) {
        notes.push('The race data (.rdf) could not be read; default start and finish positions are used.');
      }
    }
    const folderName = c.folder.replace(/\/$/, '').split('/').pop();
    const title = ini.name || prettyName(folderName || baseOf(c.terrain.name) || baseOf(name));
    const rec = {
      name: title,
      author: ini.author,
      folder: c.folder,
      source: name,
      grid,
      line,
      timing,
      notes,
      info: { sourceW, sourceH, kind: c.kind },
    };
    rec.id = trackId(title, grid);
    tracks.push(rec);
  }
  onProgress(1, 'Done');
  return tracks;
}

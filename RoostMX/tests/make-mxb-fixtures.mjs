// Builds synthetic MX Bikes track packages for the track importer tests:
//   node tests/make-mxb-fixtures.mjs
// tests/fixtures/mxb-testtrack.pkz   a track folder (.trh terrain with centre line, .rdf,
//                                     .ini, plus stand-ins for .map / .edf files)
// tests/fixtures/mxb-dist.pkz        a distribution pack nesting "testtrack_server.pkz"
// tests/fixtures/mxb-heightmap.zip   heightmap sources only (.hmf + 16-bit .raw)
// All terrain is generated here; no MX Bikes content is included.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'three/addons/libs/fflate.module.js';
import { buildFeature } from '../src/track.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

// ---- the track: an oval in MX Bikes world metres (left-handed: X right, Z forward)
export const FIX = { w: 513, h: 513, size: 256, start: [128, 60], heading: 0 };
const RAD = 30, STRAIGHT = 100;
// records: flag, length, radius (+ = bends toward local +x, i.e. to the rider's right)
const RECS = [
  [0, STRAIGHT, 0],
  [1, Math.PI * RAD, RAD],
  [0, STRAIGHT, 0],
  [1, Math.PI * RAD, RAD],
];
const DOUBLE = { type: 'double', h1: 2.2, face: 24, gap: 9, h2: 2.0, land: 18 };

const rot = (deg) => {
  const a = (deg * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 1];
};
const mul = (L, R) => {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = L[r * 3] * R[c] + L[r * 3 + 1] * R[3 + c] + L[r * 3 + 2] * R[6 + c];
  return o;
};

/** Start matrices of the records, chained exactly like the game's loader expects. */
function chain() {
  let m = rot(FIX.heading);
  m[2] = FIX.start[0];
  m[5] = FIX.start[1];
  const out = [];
  let running = 0;
  for (const [flag, length, radius] of RECS) {
    out.push({ flag, length, radius, running, m: m.slice() });
    const pre = m.slice();
    let lx = 0, lz = length;
    if (flag === 1) {
      const sweep = (length / (2 * Math.PI * Math.abs(radius))) * 360;
      m = mul(m, rot(radius > 0 ? sweep : -sweep));
      const a = length / radius;
      lx = radius - Math.cos(a) * radius;
      lz = Math.sin(a) * radius;
    }
    m[2] = pre[0] * lx + pre[1] * lz + pre[2];
    m[5] = pre[3] * lx + pre[4] * lz + pre[5];
    running += length;
  }
  return out;
}

/** Point on the line at distance s (world metres) and its forward direction. */
function lineAt(recs, s) {
  for (const r of recs) {
    if (s > r.running + r.length && r !== recs[recs.length - 1]) continue;
    const along = Math.min(r.length, Math.max(0, s - r.running));
    let lx = 0, lz = along, tx = 0, tz = 1;
    if (r.flag === 1) {
      const a = along / r.radius;
      lx = r.radius - Math.cos(a) * r.radius;
      lz = Math.sin(a) * r.radius;
      tx = Math.sin(a);
      tz = Math.cos(a);
    }
    const m = r.m;
    return { x: m[0] * lx + m[1] * lz + m[2], z: m[3] * lx + m[4] * lz + m[5], fx: m[0] * tx + m[1] * tz, fz: m[3] * tx + m[4] * tz };
  }
  return null;
}

const base = (x, z) => 6 + 3 * Math.sin(x / 40) * Math.cos(z / 55) + 1.2 * Math.sin(z / 23 + 1);

/** Terrain (m) on the grid: rolling ground, the track bed eased onto it, a double jump. */
export function fixtureTerrain() {
  const recs = chain();
  const L = recs.reduce((a, r) => a + r.length, 0);
  const pts = [];
  for (let s = 0; s < L; s += 0.5) pts.push(lineAt(recs, s));
  // smoothed ground height along the line
  const raw = pts.map((p) => base(p.x, p.z));
  const elev = raw.map((_, i) => {
    let sum = 0, n = 0;
    for (let k = -40; k <= 40; k++) { sum += raw[(i + k + raw.length) % raw.length]; n++; }
    return sum / n;
  });
  const f = buildFeature(DOUBLE);
  const jumpAt = 25; // metres along the first straight
  const { w, h, size } = FIX;
  const mps = size / (w - 1);
  const H = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = i * mps, z = j * mps;
      let hgt = base(x, z);
      // nearest line point (coarse)
      let bi = 0, bd = Infinity;
      for (let k = 0; k < pts.length; k += 4) {
        const d = (pts[k].x - x) ** 2 + (pts[k].z - z) ** 2;
        if (d < bd) { bd = d; bi = k; }
      }
      for (let k = Math.max(0, bi - 4); k < Math.min(pts.length, bi + 5); k++) {
        const d = (pts[k].x - x) ** 2 + (pts[k].z - z) ** 2;
        if (d < bd) { bd = d; bi = k; }
      }
      const d = Math.sqrt(bd);
      const wgt = d < 7 ? 1 : d < 18 ? 1 - (d - 7) / 11 : 0;
      hgt = hgt + (elev[bi] - hgt) * wgt;
      const s = bi * 0.5;
      if (s >= jumpAt && s <= jumpAt + f.length && d < 9) hgt += f.height(s - jumpAt) * (d < 6 ? 1 : 1 - (d - 6) / 3);
      H[j * w + i] = hgt;
    }
  }
  return { H, recs, elev, L, pts };
}

function f32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return b; }
function u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; }
const cat = (parts) => {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** The .trh bytes for the fixture terrain. */
export function fixtureTrh() {
  const { H, recs, elev } = fixtureTerrain();
  const { w, h, size } = FIX;
  let lo = Infinity, hi = -Infinity;
  for (const v of H) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const relief = hi - lo;
  const grid = new Uint8Array(w * h * 2);
  const gdv = new DataView(grid.buffer);
  for (let k = 0; k < H.length; k++) gdv.setInt16(k * 2, Math.round(((H[k] - lo) / relief) * 65535) - 32768, true);
  const parts = [new Uint8Array([0x54, 0x52, 0x48, 0]), u32(w), u32(h), grid];
  // initial metadata: size x, relief, size z + 12 bytes
  parts.push(f32(size), f32(relief), f32(size), new Uint8Array(12));
  // A list (one 4 x 3 payload), B list (empty)
  parts.push(u32(1), u32(7), f32(0.5), u32(4), u32(3), new Uint8Array(12), u32(0));
  // root header 0: main profile x, z, rotation; root header 1: track box
  parts.push(f32(FIX.start[0]), f32(FIX.start[1]), f32(FIX.heading), u32(0xffffffff));
  parts.push(f32(90), f32(0), f32(20), f32(230), f32(relief), f32(200));
  // C records (none), D records (the centre line)
  parts.push(u32(0), u32(recs.length));
  for (const r of recs) {
    const sweep = r.flag === 1 ? (r.length / (2 * Math.PI * Math.abs(r.radius))) * 360 : 0;
    const e = elev[Math.min(elev.length - 1, Math.round(r.running / 0.5))] - lo;
    parts.push(u32(r.flag), f32(r.length), f32(r.radius), f32(sweep), f32(e), f32(r.running));
    for (const v of r.m) parts.push(f32(v));
  }
  // E, F, G, H, I lists (empty), main surface (no pairs)
  parts.push(u32(0), u32(0), u32(0), u32(0), u32(0), u32(1), u32(2), u32(0));
  // trailing EXT chunk: three absent profiles, three empty surfaces
  const ext = cat([u32(0), u32(0), u32(0), u32(0xffffffff), u32(0xffffffff), u32(0), u32(0xffffffff), u32(0xffffffff), u32(0), u32(0xffffffff), u32(0xffffffff), u32(0)]);
  parts.push(ext, strToU8('EXT\0'), u32(ext.length + 8));
  return { bytes: cat(parts), lo, relief };
}

export const RDF = `type = 3
finish_line
{
	line = 0
	long = 15
	left = -7
	right = 7
}
split1
{
	line = 0
	long = 120
	left = -6
	right = 6
}
split2
{
	line = 0
	long = 260
	left = -6
	right = 6
}
starting_grid
{
	numstalls = 2
	stall0
	{
		long = 5
		lat = -2
		angle = 0
	}
	stall1
	{
		long = 5
		lat = 2
		angle = 0
	}
}
`;

export const INI = `[info]
name = Roost Test MX
author = Roost MX tests
type = motocross
`;

export function buildFixtures() {
  const { bytes: trh } = fixtureTrh();
  const folder = {
    'testtrack/testtrack.trh': trh,
    'testtrack/testtrack.rdf': strToU8(RDF),
    'testtrack/testtrack.ini': strToU8(INI),
    'testtrack/testtrack.map': new Uint8Array(4096).fill(7),
    'testtrack/testtrack.amb': strToU8('ambient = 1\n'),
    'testtrack/clearsky.edf': new Uint8Array(512).fill(1),
    'testtrack/gate.edf': new Uint8Array(512).fill(2),
  };
  const pkz = zipSync(folder, { level: 6 });
  const server = zipSync({ 'testtrack/testtrack.trh': trh, 'testtrack/testtrack.rdf': strToU8(RDF), 'testtrack/testtrack.ini': strToU8(INI) }, { level: 6 });
  const dist = zipSync({ 'readme.txt': strToU8('Copy the pkz into mods/tracks\n'), 'testtrack_server.pkz': server, 'testtrack_full.edf': new Uint8Array(2048).fill(3) }, { level: 6 });
  // heightmap sources: 257 x 257 16-bit little-endian raw + .hmf
  const n = 257;
  const raw = new Uint8Array(n * n * 2);
  const rdv = new DataView(raw.buffer);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const v = 0.5 + 0.3 * Math.sin(i / 20) * Math.cos(j / 31) + (Math.abs(i - 128) < 6 ? 0.05 : 0);
    rdv.setUint16((j * n + i) * 2, Math.round(Math.min(1, Math.max(0, v)) * 65535), true);
  }
  const hmf = `samples_x = ${n}\nsamples_z = ${n}\nsize_x = 160\nsize_z = 160\nscale = 14\nheightmap = sandpit.raw\nnum_layers = 1\nlayer0\n{\n\tmap = maps/dirt.tga\n\trepetitions = 40\n}\n`;
  const wip = zipSync({ 'sandpit/sandpit.hmf': strToU8(hmf), 'sandpit/sandpit.raw': raw, 'sandpit/maps/dirt.tga': new Uint8Array(64) }, { level: 6 });
  const bike = zipSync({ 'mybike/mybike.edf': new Uint8Array(1024).fill(5), 'mybike/mybike.ini': strToU8('name = some bike\n'), 'mybike/paints/default.pnt': new Uint8Array(256) }, { level: 6 });
  return { pkz, dist, wip, bike };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const f = buildFixtures();
  fs.writeFileSync(path.join(dir, 'mxb-testtrack.pkz'), f.pkz);
  fs.writeFileSync(path.join(dir, 'mxb-dist.pkz'), f.dist);
  fs.writeFileSync(path.join(dir, 'mxb-heightmap.zip'), f.wip);
  fs.writeFileSync(path.join(dir, 'mxb-bike-mod.pkz'), f.bike);
  for (const k of ['mxb-testtrack.pkz', 'mxb-dist.pkz', 'mxb-heightmap.zip', 'mxb-bike-mod.pkz']) console.log(k, fs.statSync(path.join(dir, k)).size, 'bytes');
}

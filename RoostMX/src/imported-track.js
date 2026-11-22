// Imported MX Bikes tracks in the game: stored records (see mxb-track.js) become a
// Heightfield + Track at a chosen scale. Scaling is uniform - width, length and height
// together - so the track keeps its proportions; 100 % is the real size from the file,
// which matches the bike (MX Bikes and Roost MX both work in metres).
//
// MX Bikes uses a left-handed frame (X right, Y up, Z forward); Roost MX / three.js is
// right-handed, so X is mirrored on the way in (otherwise every left turn would become a
// right turn). The map is centred on the middle of the terrain.
import { Heightfield, SURF } from './heightfield.js';
import { Track, DS } from './track.js';
import { SimplexNoise, clamp, smoothstep } from './util.js';
import { gridHeight } from './mxb-track.js';

export const IMPORT_PREFIX = 'import:';
export const SCALE_MIN = 0.25, SCALE_MAX = 3;
const MAX_CELLS_SIDE = 2000;

export const isImportedId = (id) => typeof id === 'string' && id.startsWith(IMPORT_PREFIX);

/** Size of a record at a scale: { sizeX, sizeZ, relief, lap, cell } (metres). */
export function scaledStats(rec, scale) {
  const g = rec.grid;
  const sizeX = g.sizeX * scale, sizeZ = g.sizeZ * scale;
  let lo = 65535, hi = 0;
  const s = g.samples, step = Math.max(1, Math.floor(s.length / 65536));
  for (let i = 0; i < s.length; i += step) { if (s[i] < lo) lo = s[i]; if (s[i] > hi) hi = s[i]; }
  return {
    sizeX,
    sizeZ,
    relief: ((hi - lo) / 65535) * g.relief * scale,
    lap: rec.line ? rec.line.length * scale : 0,
    cell: cellFor(sizeX, sizeZ),
  };
}

function cellFor(sizeX, sizeZ) {
  return Math.max(0.5, Math.ceil((Math.max(sizeX, sizeZ) / MAX_CELLS_SIDE) * 20) / 20);
}

/** The game's track definition for an imported record (no terrain yet). */
export function importedDef(rec, scale) {
  const g = rec.grid;
  return {
    id: IMPORT_PREFIX + rec.id,
    name: rec.name,
    kind: 'MX Bikes import',
    description: (rec.author ? 'By ' + rec.author + ' · ' : '') + 'Imported from ' + rec.source,
    size: [g.sizeX * scale, g.sizeZ * scale],
    surface: rec.surface === 'sand' ? 'sand' : 'dirt',
    groundStyle: rec.surface === 'sand' ? 'dunes' : 'valley',
    vegetation: rec.surface === 'sand' ? 'coastal' : 'mixed',
    halfWidth: clamp(5.5 * scale, 3, 9),
    seed: parseInt(rec.id.replace(/\D/g, '').slice(0, 6) || '7', 10) || 7,
    checkpoints: 8,
    imported: true,
    scale,
    noTiming: !rec.line,
  };
}

/** Map a point of the MX Bikes world (metres) into the game's map at `scale`. */
function makeTransform(g, scale) {
  const cx = g.ox + g.sizeX / 2, cz = g.oz + g.sizeZ / 2;
  return {
    toGame: (wx, wz, out) => { out.x = -(wx - cx) * scale; out.z = (wz - cz) * scale; return out; },
    // game (x, z) -> fractional grid sample (gi, gj)
    gi: (x) => (cx - x / scale - g.ox) / (g.sizeX / (g.w - 1)),
    gj: (z) => (cz + z / scale - g.oz) / (g.sizeZ / (g.h - 1)),
  };
}

/** A short straight in the flattest spot near the middle (tracks without a centre line). */
function fallbackLine(hf) {
  let best = null;
  for (let r = 0; r <= 120; r += 15) {
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
      if (!hf.inBounds(x, z, 50)) continue;
      for (const dir of [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4]) {
        const dx = Math.cos(dir), dz = Math.sin(dir);
        let rough = 0, prev = hf.height(x - dx * 30, z - dz * 30);
        for (let t = -27; t <= 30; t += 3) {
          const hgt = hf.height(x + dx * t, z + dz * t);
          rough += Math.abs(hgt - prev);
          prev = hgt;
        }
        if (!best || rough < best.rough) best = { rough, x, z, dx, dz };
      }
    }
    if (best && best.rough < 1.5) break;
  }
  const b = best || { x: 0, z: 0, dx: 0, dz: 1 };
  const pts = [];
  for (let t = -30; t <= 30; t += 1) pts.push(b.x + b.dx * t, b.z + b.dz * t);
  return Float32Array.from(pts);
}

/**
 * Build the playable world pieces for an imported record at a scale:
 * { def, track, hf }. Heavy (a few hundred ms for a big track).
 */
export function buildImportedWorld(rec, scale = 1) {
  const g = rec.grid;
  const def = importedDef(rec, scale);
  const sizeX = g.sizeX * scale, sizeZ = g.sizeZ * scale;
  const cell = cellFor(sizeX, sizeZ);
  const hf = new Heightfield([sizeX, sizeZ], cell);
  const T = makeTransform(g, scale);
  // terrain heights: bilinear resample of the stored grid
  const H = hf.h, nx = hf.nx, nz = hf.nz;
  const giOf = new Float32Array(nx);
  for (let ix = 0; ix < nx; ix++) giOf[ix] = T.gi(-hf.halfX + ix * cell);
  for (let iz = 0; iz < nz; iz++) {
    const gj = T.gj(-hf.halfZ + iz * cell);
    const row = iz * nx;
    for (let ix = 0; ix < nx; ix++) H[row + ix] = gridHeight(g, giOf[ix], gj) * scale;
  }
  hf.computeRange();
  // centre line
  let pts;
  if (rec.line) {
    const src = rec.line.pts;
    pts = new Float32Array(src.length);
    const o = { x: 0, z: 0 };
    for (let i = 0; i < src.length; i += 2) {
      T.toGame(src[i], src[i + 1], o);
      pts[i] = o.x;
      pts[i + 1] = o.z;
    }
    def.open = !rec.line.closed;
  } else {
    pts = fallbackLine(hf);
    def.open = true;
  }
  def.points = pts;
  def.ground = (x, z) => hf.height(x, z);
  def.timing = timingFor(rec, scale, def.open);
  const track = new Track(def);
  paintSurfaces(hf, track, { sand: def.surface === 'sand' });
  return { def, track, hf };
}

function timingFor(rec, scale, open) {
  const L = rec.line ? rec.line.length : 60;
  const t = rec.timing || {};
  if (open) {
    return { gate: Math.min(20, L * 0.2) * scale, finish: Math.max(L * 0.5, L - 25) * scale };
  }
  const finish = t.finish != null ? t.finish : Math.min(70, L * 0.1);
  let gate = t.gate != null ? t.gate : finish - 30;
  if (gate < 0) gate += L;
  return { gate: gate * scale, finish: finish * scale };
}

/**
 * Dirt along the riding line, grass (or sand) elsewhere, dirt on steep faces; distance to
 * the line per cell (used to keep trees and props off the track).
 */
export function paintSurfaces(hf, track, { sand = false } = {}) {
  const nx = hf.nx, nz = hf.nz, cell = hf.cell, halfX = hf.halfX, halfZ = hf.halfZ;
  const count = nx * nz;
  const R = 30, R2 = R * R;
  const near = new Int32Array(count).fill(-1);
  const nd = new Float32Array(count).fill(1e9);
  const stride = Math.max(1, Math.round(1.5 / DS));
  for (let i = 0; i < track.n; i += stride) {
    const cx = track.x[i], cz = track.z[i];
    const ix0 = Math.max(0, Math.floor((cx - R + halfX) / cell)), ix1 = Math.min(nx - 1, Math.ceil((cx + R + halfX) / cell));
    const iz0 = Math.max(0, Math.floor((cz - R + halfZ) / cell)), iz1 = Math.min(nz - 1, Math.ceil((cz + R + halfZ) / cell));
    for (let iz = iz0; iz <= iz1; iz++) {
      const dz = iz * cell - halfZ - cz, dz2 = dz * dz;
      if (dz2 > R2) continue;
      let c = iz * nx + ix0;
      for (let ix = ix0; ix <= ix1; ix++, c++) {
        const dx = ix * cell - halfX - cx;
        const d2 = dx * dx + dz2;
        if (d2 < nd[c]) { nd[c] = d2; near[c] = i; }
      }
    }
  }
  const noise = new SimplexNoise((track.def.seed ?? 1) + 5);
  const splat = hf.splat, wear = hf.wear, surf = hf.surf, H = hf.h;
  const trackDist = new Float32Array(count);
  for (let iz = 0; iz < nz; iz++) {
    const wz = iz * cell - halfZ;
    for (let ix = 0; ix < nx; ix++) {
      const c = iz * nx + ix;
      const wx = ix * cell - halfX;
      let dirtW = 0, wearW = 0, d = 1e4;
      if (near[c] >= 0) {
        const i = near[c];
        // perpendicular distance to the line through the nearest sample
        const ddx = wx - track.x[i], ddz = wz - track.z[i];
        d = Math.abs(ddx * track.tz[i] - ddz * track.tx[i]);
        d = Math.min(Math.sqrt(nd[c]), Math.max(d, 0));
        const w = track.W[i];
        const en = noise.noise2(wx * 0.13, wz * 0.13) * 0.9 + noise.noise2(wx * 0.5, wz * 0.5) * 0.35;
        dirtW = 1 - smoothstep(w + 0.6 + en, w + 2.6 + en, d);
        wearW = (1 - smoothstep(0.15 * w, 0.95 * w, d)) * (0.6 + 0.4 * noise.noise2(wx * 0.08, wz * 0.35));
      }
      trackDist[c] = d;
      // steep ground (jump faces, berms built off the line) shows dirt
      const ixa = Math.max(0, ix - 1), ixb = Math.min(nx - 1, ix + 1), iza = Math.max(0, iz - 1), izb = Math.min(nz - 1, iz + 1);
      const sx = (H[iz * nx + ixb] - H[iz * nx + ixa]) / ((ixb - ixa) * cell || 1);
      const sz = (H[izb * nx + ix] - H[iza * nx + ix]) / ((izb - iza) * cell || 1);
      const slope = Math.sqrt(sx * sx + sz * sz);
      dirtW = Math.max(dirtW, smoothstep(0.42, 0.7, slope) * (1 - smoothstep(25, 60, d)));
      let wD, wG, wS;
      if (sand) {
        const grassPatch = smoothstep(0.35, 0.6, noise.fbm(wx / 30, wz / 30, 2)) * smoothstep(14, 30, d);
        wS = 1 - grassPatch;
        wG = grassPatch;
        wD = 0;
        wearW = Math.max(wearW, dirtW * 0.35);
      } else {
        const patch = smoothstep(0.55, 0.8, noise.fbm(wx / 9, wz / 9, 2)) * (1 - smoothstep(6, 18, d));
        wD = Math.max(dirtW, patch * 0.7);
        wG = 1 - wD;
        wS = 0;
      }
      const o = c * 4;
      const sum = wD + wG + wS || 1;
      splat[o] = Math.round((wD / sum) * 255);
      splat[o + 1] = Math.round((wG / sum) * 255);
      splat[o + 2] = Math.round((wS / sum) * 255);
      splat[o + 3] = 0;
      wear[c] = Math.round(clamp(wearW, 0, 1) * 255);
      let st = SURF.GRASS, bw = wG;
      if (wD > bw) { st = SURF.DIRT; bw = wD; }
      if (wS > bw) st = SURF.SAND;
      surf[c] = st;
    }
  }
  hf.trackDist = trackDist;
  hf.pits = [];
}

/**
 * Top-down preview of a record: shaded relief, the riding line and a 50 m scale bar
 * (at the given scale). Draws into a canvas.
 */
export function drawImportedPreview(cv, rec, scale = 1) {
  const ctx = cv.getContext('2d');
  const W = cv.width, Hh = cv.height;
  const g = rec.grid;
  const aspect = g.sizeX / g.sizeZ;
  let dw = W, dh = W / aspect;
  if (dh > Hh) { dh = Hh; dw = Hh * aspect; }
  const ox = (W - dw) / 2, oy = (Hh - dh) / 2;
  ctx.fillStyle = '#141416';
  ctx.fillRect(0, 0, W, Hh);
  const iw = Math.max(2, Math.round(dw)), ih = Math.max(2, Math.round(dh));
  const img = ctx.createImageData(iw, ih);
  let lo = 65535, hi = 0;
  const s = g.samples;
  for (let i = 0; i < s.length; i += 7) { if (s[i] < lo) lo = s[i]; if (s[i] > hi) hi = s[i]; }
  const range = Math.max(1, hi - lo);
  const mx = g.sizeX / (g.w - 1), mz = g.sizeZ / (g.h - 1);
  const hm = g.relief / 65535;
  for (let py = 0; py < ih; py++) {
    // drawn like the game's other track previews: game x to the right, game z down
    // (game x = mirrored MX Bikes X, game z = MX Bikes Z)
    const gj = (py / (ih - 1)) * (g.h - 1);
    for (let px = 0; px < iw; px++) {
      const gi = (1 - px / (iw - 1)) * (g.w - 1);
      const hgt = gridHeight(g, gi, gj);
      const e = gridHeight(g, Math.min(g.w - 1, gi + 2), gj) - gridHeight(g, Math.max(0, gi - 2), gj);
      const n = gridHeight(g, gi, Math.min(g.h - 1, gj + 2)) - gridHeight(g, gi, Math.max(0, gj - 2));
      // light from the upper left of the picture
      const shade = clamp(0.62 + (e / (4 * mx) - n / (4 * mz)) * 0.9, 0.15, 1.15);
      const t = ((hgt / hm) - lo) / range;
      const o = (py * iw + px) * 4;
      img.data[o] = clamp((70 + t * 70) * shade, 0, 255);
      img.data[o + 1] = clamp((92 + t * 60) * shade, 0, 255);
      img.data[o + 2] = clamp((58 + t * 40) * shade, 0, 255);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, Math.round(ox), Math.round(oy));
  const toPx = (wx, wz) => [ox + (1 - (wx - g.ox) / g.sizeX) * dw, oy + ((wz - g.oz) / g.sizeZ) * dh];
  if (rec.line) {
    const p = rec.line.pts;
    ctx.strokeStyle = '#c9925a';
    ctx.lineWidth = Math.max(2, Math.min(5, (11 * scale * dw) / (g.sizeX * scale)));
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < p.length; i += 2) {
      const [x, y] = toPx(p[i], p[i + 1]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    if (rec.line.closed) ctx.closePath();
    ctx.stroke();
  }
  // scale bar: 50 m in the game at this scale
  const metresPerPx = (g.sizeX * scale) / dw;
  const bar = 50 / metresPerPx;
  if (bar > 8 && bar < W * 0.6) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(W - bar - 22, Hh - 26, bar + 14, 18);
    ctx.fillStyle = '#fff';
    ctx.fillRect(W - bar - 15, Hh - 14, bar, 3);
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('50 m', W - bar / 2 - 15, Hh - 17);
  }
}

/** Light-weight listing entry (no grid data). */
export function summary(rec) {
  return {
    id: rec.id,
    name: rec.name,
    author: rec.author,
    source: rec.source,
    scale: rec.scale ?? 1,
    surface: rec.surface || 'dirt',
    created: rec.created,
    sizeX: rec.grid.sizeX,
    sizeZ: rec.grid.sizeZ,
    lap: rec.line ? rec.line.length : 0,
    closed: rec.line ? rec.line.closed : false,
    hasLine: !!rec.line,
  };
}

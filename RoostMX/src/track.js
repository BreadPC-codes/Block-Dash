// Track layout builder and terrain generator.
//
// A track is described with "turtle" commands (straights and constant-radius turns,
// like a real track designer would sketch it). The loop is closed automatically with a
// Dubins path. Jumps, rhythm sections, whoops and rollers sit on straights; berms are
// generated on the outside of corners. The result is stamped into a Heightfield together
// with surface types (dirt, grass, sand, gravel) used by both physics and rendering.

import { Heightfield, SURF } from './heightfield.js';
import { SimplexNoise, clamp, lerp, smoothstep, DEG } from './util.js';

export const DS = 0.25; // centerline sample spacing (m)

// ---------------------------------------------------------------------------
// Feature profiles. Every feature is a longitudinal height profile h(u), u = meters
// from the feature start. Jump faces use a curved transition into a straight lip.
// ---------------------------------------------------------------------------
// Face = curved transition (constant radius) blending into a straight lip section.
const FACE_F = 1.85; // length factor: 1 = all straight, 2 = all transition
const faceLength = (h, ang) => (FACE_F * h) / Math.tan(ang * DEG);
function faceHeight(u, h, ang) {
  const m = Math.tan(ang * DEG);
  const L = (FACE_F * h) / m;
  const Lt = (2 * (FACE_F - 1) * h) / m;
  if (u <= 0) return 0;
  if (u >= L) return h;
  if (u < Lt) return (m * u * u) / (2 * Lt);
  return (m * Lt) / 2 + m * (u - Lt);
}
const landLength = (h, ang) => (Math.PI * h) / (2 * Math.tan(ang * DEG));
const landHeight = (u, h, L) => (u <= 0 ? h : u >= L ? 0 : h * 0.5 * (1 + Math.cos((Math.PI * u) / L)));
const backLength = (h) => 1.35 * h;
const backHeight = (u, h, L) => (u <= 0 ? h : u >= L ? 0 : h * Math.pow(1 - u / L, 1.6));
const frontLength = (h) => 1.3 * h;
const frontHeight = (u, h, L) => (u <= 0 ? 0 : u >= L ? h : h * Math.pow(u / L, 1.6));
const bump = (u, h, L) => (u <= 0 || u >= L ? 0 : h * 0.5 * (1 - Math.cos((2 * Math.PI * u) / L)));

const FEATURE_BUILDERS = {
  // Tabletop: face up to a flat top, then a landing ramp.
  table(p) {
    const h = p.h ?? 2, face = p.face ?? 27, top = p.top ?? 10, land = p.land ?? 21;
    const Lf = faceLength(h, face), Ll = landLength(h, land);
    return {
      length: Lf + top + Ll,
      lips: [Lf],
      height(u) {
        if (u < Lf) return faceHeight(u, h, face);
        u -= Lf;
        if (u < top) return h;
        return landHeight(u - top, h, Ll);
      },
    };
  },
  // Double / triple: takeoff, open gap (optionally with a middle mound), landing.
  double(p) {
    const h1 = p.h1 ?? 1.9, face = p.face ?? 27, h2 = p.h2 ?? h1, land = p.land ?? 22;
    const knuckle = p.knuckle ?? 1.4;
    const Lf = faceLength(h1, face), Lb = backLength(h1), Lfr = frontLength(h2), Ll = landLength(h2, land);
    const g = Math.max(p.gap ?? 14, Lb + Lfr + 0.5);
    const mid = p.mid;
    return {
      length: Lf + g + knuckle + Ll,
      lips: [Lf],
      gap: g,
      height(u) {
        if (u < Lf) return faceHeight(u, h1, face);
        u -= Lf;
        if (u < g) {
          let v = Math.max(backHeight(u, h1, Lb), frontHeight(u - (g - Lfr), h2, Lfr));
          if (mid) v = Math.max(v, bump(u - (g * 0.5 - mid.w * 0.5), mid.h, mid.w));
          return v;
        }
        u -= g;
        if (u < knuckle) return h2;
        return landHeight(u - knuckle, h2, Ll);
      },
    };
  },
  // Step-up: takeoff onto a higher plateau that rolls down afterwards.
  stepup(p) {
    const h1 = p.h1 ?? 1.6, face = p.face ?? 28, h2 = p.h2 ?? 2.8, plateau = p.plateau ?? 8, down = p.down ?? 14;
    const Lf = faceLength(h1, face), Lb = backLength(h1), Lfr = frontLength(h2), Ld = landLength(h2, down);
    const g = Math.max(p.gap ?? 7, Lb + Lfr * 0.6);
    return {
      length: Lf + g + plateau + Ld,
      lips: [Lf],
      height(u) {
        if (u < Lf) return faceHeight(u, h1, face);
        u -= Lf;
        if (u < g) return Math.max(backHeight(u, h1, Lb), frontHeight(u - (g - Lfr), h2, Lfr));
        u -= g;
        if (u < plateau) return h2;
        return landHeight(u - plateau, h2, Ld);
      },
    };
  },
  // Step-down: long gentle ramp onto a plateau, kicker lip, drop to a landing.
  stepdown(p) {
    const h1 = p.h1 ?? 2.6, rise = p.rise ?? 22, plateau = p.plateau ?? 6, kick = p.kick ?? 0.5;
    const face = p.face ?? 18, land = p.land ?? 20, h2 = p.h2 ?? 1.0;
    const Lk = faceLength(kick, face);
    const Lb = backLength(h1 + kick);
    const Lfr = frontLength(h2);
    const Ll = landLength(h2, land);
    const g = Math.max(p.gap ?? 10, Lb + Lfr + 0.4);
    const top = h1 + kick;
    return {
      length: rise + plateau + Lk + g + 1 + Ll,
      lips: [rise + plateau + Lk],
      height(u) {
        if (u < rise) return h1 * 0.5 * (1 - Math.cos((Math.PI * u) / rise));
        u -= rise;
        if (u < plateau) return h1;
        u -= plateau;
        if (u < Lk) return h1 + faceHeight(u, kick, face);
        u -= Lk;
        if (u < g) return Math.max(backHeight(u, top, Lb), frontHeight(u - (g - Lfr), h2, Lfr));
        u -= g;
        if (u < 1) return h2;
        return landHeight(u - 1, h2, Ll);
      },
    };
  },
  rollers(p) {
    const n = p.n ?? 4, h = p.h ?? 0.8, len = p.len ?? 8;
    return {
      length: n * len,
      lips: [],
      height(u) {
        if (u <= 0 || u >= n * len) return 0;
        return bump(u % len, h, len);
      },
    };
  },
  whoops(p) {
    const n = p.n ?? 10, h = p.h ?? 0.6, sp = p.spacing ?? 3.6;
    return {
      length: n * sp,
      lips: [],
      height(u) {
        if (u <= 0 || u >= n * sp) return 0;
        const t = (u % sp) / sp;
        return h * Math.pow(Math.sin(Math.PI * t), 1.5);
      },
    };
  },
  // Rhythm: a row of small pyramids (face, short top, back) that can be rolled, doubled or tripled.
  rhythm(p) {
    const mounds = p.mounds ?? [1.3, 1.4, 1.4, 1.3, 1.5];
    const up = p.up ?? 27, down = p.down ?? 25, top = p.top ?? 0.9, spacing = p.spacing ?? 1.8;
    const parts = [];
    let u0 = 0;
    for (const h of mounds) {
      const Lf = faceLength(h, up), Ll = landLength(h, down);
      parts.push({ u0, h, Lf, Ll, len: Lf + top + Ll });
      u0 += Lf + top + Ll + spacing;
    }
    const length = u0 - spacing;
    return {
      length,
      lips: parts.map((q) => q.u0 + q.Lf),
      height(u) {
        for (const q of parts) {
          const v = u - q.u0;
          if (v < 0 || v > q.len) continue;
          if (v < q.Lf) return faceHeight(v, q.h, up);
          if (v < q.Lf + top) return q.h;
          return landHeight(v - q.Lf - top, q.h, q.Ll);
        }
        return 0;
      },
    };
  },
  // Wide smooth crest used for elevation changes on a straight.
  hill(p) {
    const h = p.h ?? 2.5, len = p.len ?? 40;
    return { length: len, lips: [], height: (u) => bump(u, h, len) };
  },
};

export function buildFeature(spec) {
  const b = FEATURE_BUILDERS[spec.type];
  if (!b) throw new Error('Unknown track feature: ' + spec.type);
  return b(spec);
}

// ---------------------------------------------------------------------------
// Dubins path (CSC families) used to close the loop smoothly.
// Paper frame: heading th, direction (cos th, sin th); +1 = counter-clockwise.
// ---------------------------------------------------------------------------
const mod2pi = (a) => {
  const t = a % (2 * Math.PI);
  return t < 0 ? t + 2 * Math.PI : t;
};

function dubinsCSC(x0, y0, th0, x1, y1, th1, r) {
  const dx = (x1 - x0) / r, dy = (y1 - y0) / r;
  const d = Math.hypot(dx, dy);
  const phi = Math.atan2(dy, dx);
  const a = mod2pi(th0 - phi), b = mod2pi(th1 - phi);
  const sa = Math.sin(a), sb = Math.sin(b), ca = Math.cos(a), cb = Math.cos(b);
  const cab = Math.cos(a - b);
  const out = [];
  // LSL
  {
    const p2 = 2 + d * d - 2 * cab + 2 * d * (sa - sb);
    if (p2 >= 0) {
      const tmp = Math.atan2(cb - ca, d + sa - sb);
      out.push({ type: [1, 0, 1], t: mod2pi(-a + tmp), p: Math.sqrt(p2), q: mod2pi(b - tmp) });
    }
  }
  // RSR
  {
    const p2 = 2 + d * d - 2 * cab + 2 * d * (sb - sa);
    if (p2 >= 0) {
      const tmp = Math.atan2(ca - cb, d - sa + sb);
      out.push({ type: [-1, 0, -1], t: mod2pi(a - tmp), p: Math.sqrt(p2), q: mod2pi(-b + tmp) });
    }
  }
  // LSR
  {
    const p2 = -2 + d * d + 2 * cab + 2 * d * (sa + sb);
    if (p2 >= 0) {
      const p = Math.sqrt(p2);
      const tmp = Math.atan2(-ca - cb, d + sa + sb) - Math.atan2(-2, p);
      out.push({ type: [1, 0, -1], t: mod2pi(-a + tmp), p, q: mod2pi(-b + tmp) });
    }
  }
  // RSL
  {
    const p2 = d * d - 2 + 2 * cab - 2 * d * (sa + sb);
    if (p2 >= 0) {
      const p = Math.sqrt(p2);
      const tmp = Math.atan2(ca + cb, d - sa - sb) - Math.atan2(2, p);
      out.push({ type: [-1, 0, 1], t: mod2pi(a - tmp), p, q: mod2pi(b - tmp) });
    }
  }
  let best = null;
  for (const c of out) {
    const len = c.t + c.p + c.q;
    if (!best || len < best.len) best = { ...c, len };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Layout -> primitives -> uniformly sampled centerline
// ---------------------------------------------------------------------------
function layoutToPrims(def) {
  let x = 0, z = 0, th = 0;
  const prims = [];
  def.layout.forEach((item, segIndex) => {
    const kind = item[0];
    if (kind === 'S') {
      const len = item[1];
      prims.push({ kind: 'line', x0: x, z0: z, th, len, seg: segIndex, opts: item[2] || {} });
      x += Math.cos(th) * len;
      z += Math.sin(th) * len;
    } else if (kind === 'L' || kind === 'R') {
      // Rider-left turns are clockwise on the (x,z) paper plane.
      const dir = kind === 'L' ? -1 : 1;
      const ang = item[1] * DEG, r = item[2];
      const prim = { kind: 'arc', x0: x, z0: z, th, r, dir, ang, len: ang * r, seg: segIndex, opts: item[3] || {} };
      prims.push(prim);
      const end = arcPoint(prim, ang);
      x = end.x; z = end.z; th = end.th;
    } else if (kind === 'CLOSE') {
      const r = item[1] ?? 14;
      const db = dubinsCSC(x, z, th, 0, 0, 0, r);
      if (!db) throw new Error('Cannot close track layout');
      const parts = [
        { d: db.type[0], v: db.t },
        { d: 0, v: db.p },
        { d: db.type[2], v: db.q },
      ];
      for (const part of parts) {
        if (part.v < 1e-4) continue;
        if (part.d === 0) {
          const len = part.v * r;
          prims.push({ kind: 'line', x0: x, z0: z, th, len, seg: segIndex, opts: item[2] || {} });
          x += Math.cos(th) * len;
          z += Math.sin(th) * len;
        } else {
          const prim = { kind: 'arc', x0: x, z0: z, th, r, dir: part.d, ang: part.v, len: part.v * r, seg: segIndex, opts: item[2] || {} };
          prims.push(prim);
          const end = arcPoint(prim, part.v);
          x = end.x; z = end.z; th = end.th;
        }
      }
    }
  });
  return { prims, end: { x, z, th } };
}

function arcPoint(prim, a) {
  const { x0, z0, th, r, dir } = prim;
  if (dir > 0) {
    const cx = x0 - r * Math.sin(th), cz = z0 + r * Math.cos(th);
    const t2 = th + a;
    return { x: cx + r * Math.sin(t2), z: cz - r * Math.cos(t2), th: t2 };
  }
  const cx = x0 + r * Math.sin(th), cz = z0 - r * Math.cos(th);
  const t2 = th - a;
  return { x: cx - r * Math.sin(t2), z: cz + r * Math.cos(t2), th: t2 };
}

function circularSmooth(arr, windowSamples) {
  const n = arr.length;
  const w = Math.max(1, Math.round(windowSamples));
  const half = Math.floor(w / 2);
  const prefix = new Float64Array(n * 3 + 1);
  for (let i = 0; i < n * 3; i++) prefix[i + 1] = prefix[i] + arr[i % n];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = i + n - half, b = i + n + half + 1;
    out[i] = (prefix[b] - prefix[a]) / (b - a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Track
// ---------------------------------------------------------------------------
export class Track {
  constructor(def) {
    this.def = def;
    this.noise = new SimplexNoise(def.seed ?? 1);
    this.noise2 = new SimplexNoise((def.seed ?? 1) + 77);
    const { prims, end } = layoutToPrims(def);
    this.prims = prims;
    this.closureError = Math.hypot(end.x, end.z);
    this._sample(prims);
    this._center();
    this._resolveHills();
    this.ground = makeGroundFunction(def, this.noise, this.hills);
    this._buildElevation();
    this._buildFeatures();
    this._buildBerms();
    this._buildWidth();
    this._buildIndex();
    this._buildTiming();
  }

  _sample(prims) {
    let total = 0;
    for (const p of prims) {
      p.s0 = total;
      total += p.len;
      p.s1 = total;
    }
    const n = Math.floor(total / DS);
    this.n = n;
    this.length = n * DS;
    this.x = new Float32Array(n);
    this.z = new Float32Array(n);
    this.tx = new Float32Array(n);
    this.tz = new Float32Array(n);
    this.kappa = new Float32Array(n);
    this.seg = new Int16Array(n);
    let pi = 0;
    for (let i = 0; i < n; i++) {
      const s = i * DS;
      while (pi < prims.length - 1 && s >= prims[pi].s1) pi++;
      const p = prims[pi];
      const u = s - p.s0;
      let x, z, th, k = 0;
      if (p.kind === 'line') {
        th = p.th;
        x = p.x0 + Math.cos(th) * u;
        z = p.z0 + Math.sin(th) * u;
      } else {
        const pt = arcPoint(p, u / p.r);
        x = pt.x; z = pt.z; th = pt.th;
        k = -p.dir / p.r; // rider-relative: + = left turn
      }
      this.x[i] = x;
      this.z[i] = z;
      this.tx[i] = Math.cos(th);
      this.tz[i] = Math.sin(th);
      this.kappa[i] = k;
      this.seg[i] = p.seg;
    }
  }

  _center() {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.n; i++) {
      minX = Math.min(minX, this.x[i]); maxX = Math.max(maxX, this.x[i]);
      minZ = Math.min(minZ, this.z[i]); maxZ = Math.max(maxZ, this.z[i]);
    }
    const off = this.def.offset || [0, 0];
    const cx = (minX + maxX) / 2 - off[0], cz = (minZ + maxZ) / 2 - off[1];
    for (let i = 0; i < this.n; i++) {
      this.x[i] -= cx;
      this.z[i] -= cz;
    }
    for (const p of this.prims) {
      p.x0 -= cx;
      p.z0 -= cz;
    }
    this.bounds = { minX: minX - cx, maxX: maxX - cx, minZ: minZ - cz, maxZ: maxZ - cz };
  }

  /** Index of sample nearest arc length s (wrapping). */
  idx(s) {
    let i = Math.round(s / DS) % this.n;
    if (i < 0) i += this.n;
    return i;
  }

  wrapS(s) {
    let v = s % this.length;
    if (v < 0) v += this.length;
    return v;
  }

  /** Linear interpolation of a per-sample array at arc length s. */
  interp(arr, s) {
    const f = this.wrapS(s) / DS;
    const i0 = Math.floor(f);
    const t = f - i0;
    const a = arr[i0 % this.n], b = arr[(i0 + 1) % this.n];
    return a + (b - a) * t;
  }

  segStart(segIndex) {
    for (const p of this.prims) if (p.seg === segIndex) return p.s0;
    return 0;
  }
  segEnd(segIndex) {
    let e = 0;
    for (const p of this.prims) if (p.seg === segIndex) e = p.s1;
    return e;
  }

  _resolveHills() {
    this.hills = (this.def.hills || []).map((hl) => {
      if (hl.x != null) return hl;
      const s0 = this.segStart(hl.seg), s1 = this.segEnd(hl.seg);
      const i = this.idx(lerp(s0, s1, hl.t ?? 0.5));
      const nx = this.tz[i], nz = -this.tx[i];
      const side = hl.side ?? 0;
      return { x: this.x[i] + nx * side, z: this.z[i] + nz * side, r: hl.r, h: hl.h };
    });
  }

  _buildElevation() {
    const n = this.n;
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) raw[i] = this.ground(this.x[i], this.z[i]);
    let E = circularSmooth(raw, 44 / DS);
    E = circularSmooth(E, 44 / DS);
    // Flatten segments flagged flat (start straight etc.)
    const flatSegs = new Set();
    this.def.layout.forEach((it, k) => {
      const opts = it[0] === 'S' ? it[2] : it[3];
      if (opts && opts.flat) flatSegs.add(k);
    });
    for (const k of flatSegs) {
      const s0 = this.segStart(k), s1 = this.segEnd(k);
      const i0 = this.idx(s0), cnt = Math.round((s1 - s0) / DS);
      let sum = 0;
      for (let j = 0; j < cnt; j++) sum += E[(i0 + j) % n];
      const mean = sum / Math.max(1, cnt);
      for (let j = 0; j < cnt; j++) E[(i0 + j) % n] = mean;
    }
    E = circularSmooth(E, 24 / DS);
    this.E = E;
  }

  _buildFeatures() {
    const n = this.n;
    this.F = new Float32Array(n);
    this.features = [];
    this.def.layout.forEach((it, k) => {
      if (it[0] !== 'S' || !it[2] || !it[2].features) return;
      const s0 = this.segStart(k), s1 = this.segEnd(k);
      for (const spec of it[2].features) {
        const f = buildFeature(spec);
        const fs0 = s0 + (spec.at ?? 0);
        const fs1 = fs0 + f.length;
        const info = { type: spec.type, spec, s0: fs0, s1: fs1, lips: f.lips.map((u) => fs0 + u), seg: k, fits: fs1 <= s1 - 2 };
        this.features.push(info);
        const i0 = Math.floor(fs0 / DS), i1 = Math.ceil(fs1 / DS);
        for (let i = i0; i <= i1; i++) {
          const ii = ((i % n) + n) % n;
          const v = f.height(i * DS - fs0);
          if (v > this.F[ii]) this.F[ii] = v;
        }
      }
    });
  }

  _buildBerms() {
    const n = this.n;
    const B = new Float32Array(n);
    for (const p of this.prims) {
      if (p.kind !== 'arc') continue;
      const angDeg = p.ang / DEG;
      let h = p.opts.berm;
      if (h == null) {
        if (p.r > 38 || angDeg < 25) h = 0;
        else h = clamp(1.05 + (22 - p.r) * 0.06, 0.45, 1.7) * smoothstep(20, 75, angDeg);
      }
      if (h <= 0) continue;
      const sgn = -p.dir; // + for rider-left turns
      const lead = 10, trail = 12;
      const i0 = Math.floor((p.s0 - lead) / DS), i1 = Math.ceil((p.s1 + trail) / DS);
      for (let i = i0; i <= i1; i++) {
        const s = i * DS;
        const w = smoothstep(p.s0 - lead, p.s0 + 3, s) * (1 - smoothstep(p.s1 - 3, p.s1 + trail, s));
        const ii = ((i % n) + n) % n;
        B[ii] += sgn * h * w;
      }
    }
    this.B = B;
  }

  _buildWidth() {
    const n = this.n;
    const W = new Float32Array(n);
    const base = this.def.halfWidth ?? 4.6;
    for (let i = 0; i < n; i++) {
      const it = this.def.layout[this.seg[i]];
      const opts = (it[0] === 'S' ? it[2] : it[3]) || {};
      W[i] = opts.w ?? base;
    }
    this.W = circularSmooth(W, 16 / DS);
  }

  _buildIndex() {
    const cell = 8;
    const b = this.bounds;
    this.gridCell = cell;
    this.gridX0 = b.minX - 40;
    this.gridZ0 = b.minZ - 40;
    this.gridW = Math.ceil((b.maxX - b.minX + 80) / cell);
    this.gridH = Math.ceil((b.maxZ - b.minZ + 80) / cell);
    const buckets = new Array(this.gridW * this.gridH);
    const step = Math.round(1 / DS);
    for (let i = 0; i < this.n; i += step) {
      const gx = Math.floor((this.x[i] - this.gridX0) / cell);
      const gz = Math.floor((this.z[i] - this.gridZ0) / cell);
      const k = gz * this.gridW + gx;
      (buckets[k] || (buckets[k] = [])).push(i);
    }
    this.buckets = buckets;
  }

  _buildTiming() {
    const first = this.def.layout[0];
    const opts = first[2] || {};
    this.gateS = opts.gate ?? 20;
    this.finishS = opts.finish ?? 70;
    const count = this.def.checkpoints ?? 8;
    this.checkpoints = [];
    for (let k = 0; k < count; k++) {
      const s = this.wrapS(this.finishS + (k * this.length) / count);
      const i = this.idx(s);
      this.checkpoints.push({ s, x: this.x[i], z: this.z[i], tx: this.tx[i], tz: this.tz[i] });
    }
  }

  /**
   * Nearest point on the centerline. If hint (sample index) is given, a local search is
   * performed first, which keeps progress tracking stable where sections run close.
   */
  project(x, z, hint = -1, out = {}) {
    let best = -1, bestD2 = Infinity;
    if (hint >= 0) {
      const range = Math.round(30 / DS);
      for (let k = -range; k <= range; k += 2) {
        const i = (((hint + k) % this.n) + this.n) % this.n;
        const dx = x - this.x[i], dz = z - this.z[i];
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = i; }
      }
      if (bestD2 > 22 * 22) best = -1;
    }
    if (best < 0) {
      const cell = this.gridCell;
      const gx = Math.floor((x - this.gridX0) / cell), gz = Math.floor((z - this.gridZ0) / cell);
      for (let rad = 1; rad <= 40 && best < 0; rad += 2) {
        for (let dz = -rad; dz <= rad; dz++) {
          for (let dx = -rad; dx <= rad; dx++) {
            const cx = gx + dx, cz = gz + dz;
            if (cx < 0 || cz < 0 || cx >= this.gridW || cz >= this.gridH) continue;
            const bk = this.buckets[cz * this.gridW + cx];
            if (!bk) continue;
            for (const i of bk) {
              const ddx = x - this.x[i], ddz = z - this.z[i];
              const d2 = ddx * ddx + ddz * ddz;
              if (d2 < bestD2) { bestD2 = d2; best = i; }
            }
          }
        }
      }
      if (best < 0) best = 0;
    }
    // refine around best
    for (let k = -4; k <= 4; k++) {
      const i = (((best + k) % this.n) + this.n) % this.n;
      const dx = x - this.x[i], dz = z - this.z[i];
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
    const i = best;
    const dx = x - this.x[i], dz = z - this.z[i];
    const along = dx * this.tx[i] + dz * this.tz[i];
    out.index = i;
    out.s = this.wrapS(i * DS + along);
    out.d = dx * this.tz[i] - dz * this.tx[i]; // + = left of travel direction
    out.dist = Math.sqrt(bestD2);
    return out;
  }

  /** Surface height of the track itself at arc length s and lateral offset d (no terrain). */
  pose(s, d = 0) {
    const i = this.idx(s);
    const nx = this.tz[i], nz = -this.tx[i];
    return { x: this.x[i] + nx * d, z: this.z[i] + nz * d, tx: this.tx[i], tz: this.tz[i], heading: Math.atan2(this.tx[i], this.tz[i]) };
  }

  /** Find a safe respawn arc length at or before s: no jump features nearby. */
  safeRespawnS(s) {
    for (let back = 4; back < 160; back += 2) {
      const t = s - back;
      let ok = true;
      for (let k = -7; k <= 7; k += 1) {
        const ss = t + k;
        if (this.interp(this.F, ss) > 0.05 || Math.abs(this.interp(this.B, ss)) > 0.35) { ok = false; break; }
      }
      if (ok) return this.wrapS(t);
    }
    return this.wrapS(s - 4);
  }

  featureAt(s) {
    const ws = this.wrapS(s);
    for (const f of this.features) if (ws >= f.s0 && ws <= f.s1) return f;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Natural ground shape (outside of the track influence)
// ---------------------------------------------------------------------------
export function makeGroundFunction(def, noise, hills) {
  const und = def.undulation ?? 3;
  const style = def.groundStyle ?? 'valley';
  const half = def.size / 2;
  const edgeStart = def.edgeStart ?? half * 0.8;
  const mountain = def.mountainHeight ?? 70;
  return (x, z) => {
    let h = noise.fbm(x / 230, z / 230, 3) * und + noise.fbm(x / 70 + 31.7, z / 70 - 12.1, 3) * und * 0.22;
    for (const hl of hills) {
      const dx = x - hl.x, dz = z - hl.z;
      const q = (dx * dx + dz * dz) / (hl.r * hl.r);
      if (q < 9) h += hl.h * Math.exp(-q);
    }
    const ax = Math.abs(x), az = Math.abs(z);
    const r = Math.sqrt(Math.sqrt(ax * ax * ax * ax + az * az * az * az));
    const e = smoothstep(edgeStart, edgeStart + 380, r);
    if (e > 0) {
      if (style === 'dunes') {
        const dune = noise.ridged(x / 160 + 3.1, z / 110 - 1.7, 3);
        h += e * (8 + 26 * dune) * e;
        if (def.seaSide) {
          const sideCoord = def.seaSide === 'south' ? z : -z;
          const sea = smoothstep(half * 0.95, half * 1.6, sideCoord);
          h = lerp(h, -10, sea);
        }
      } else {
        const rid = noise.ridged(x / 520 + 7, z / 520 - 3, 5);
        h += e * e * mountain * (0.35 + 1.1 * rid);
      }
    }
    return h;
  };
}

// ---------------------------------------------------------------------------
// Terrain generation: stamps the track into a heightfield.
// ---------------------------------------------------------------------------
export function generateTerrain(track, cell = 0.5) {
  const def = track.def;
  const hf = new Heightfield(def.size, cell);
  const n = hf.n, half = hf.half;
  const count = n * n;
  const G = track.ground;
  const noise = track.noise, noise2 = track.noise2;
  const isSand = def.surface === 'sand';

  // 1) Base ground on a coarse grid, bilinearly upsampled.
  const cc = 4; // coarse factor
  const cn = Math.ceil((n - 1) / cc) + 1;
  const coarse = new Float32Array(cn * cn);
  for (let j = 0; j < cn; j++) {
    for (let i = 0; i < cn; i++) {
      coarse[j * cn + i] = G(i * cc * cell - half, j * cc * cell - half);
    }
  }
  const H = hf.h;
  for (let iz = 0; iz < n; iz++) {
    const fz = iz / cc, jz = Math.min(cn - 2, Math.floor(fz)), tz = fz - jz;
    for (let ix = 0; ix < n; ix++) {
      const fx = ix / cc, jx = Math.min(cn - 2, Math.floor(fx)), tx = fx - jx;
      const a = coarse[jz * cn + jx], b = coarse[jz * cn + jx + 1];
      const c = coarse[(jz + 1) * cn + jx], d = coarse[(jz + 1) * cn + jx + 1];
      H[iz * n + ix] = (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
    }
  }

  // 2) Find the nearest centerline sample(s) for every cell, keeping the two closest
  //    distinct "parts" of the loop so close sections blend smoothly.
  const R = def.influence ?? 30;
  const R2 = R * R;
  const b1i = new Int32Array(count).fill(-1);
  const b2i = new Int32Array(count).fill(-1);
  const b1d = new Float32Array(count).fill(1e9);
  const b2d = new Float32Array(count).fill(1e9);
  const stride = 6; // 1.5 m coarse stride
  const N = track.n;
  const partSpan = Math.round(80 / DS);
  const circ = (a, b) => {
    const d = Math.abs(a - b);
    return d < N - d ? d : N - d;
  };
  for (let i = 0; i < N; i += stride) {
    const cx = track.x[i], cz = track.z[i];
    const ix0 = Math.max(0, Math.floor((cx - R + half) / cell));
    const ix1 = Math.min(n - 1, Math.ceil((cx + R + half) / cell));
    const iz0 = Math.max(0, Math.floor((cz - R + half) / cell));
    const iz1 = Math.min(n - 1, Math.ceil((cz + R + half) / cell));
    for (let iz = iz0; iz <= iz1; iz++) {
      const dz = iz * cell - half - cz;
      const dz2 = dz * dz;
      if (dz2 > R2) continue;
      let c = iz * n + ix0;
      for (let ix = ix0; ix <= ix1; ix++, c++) {
        const dx = ix * cell - half - cx;
        const d2 = dx * dx + dz2;
        if (d2 > R2) continue;
        const i1 = b1i[c];
        if (i1 < 0) { b1i[c] = i; b1d[c] = d2; continue; }
        if (circ(i, i1) < partSpan) {
          if (d2 < b1d[c]) { b1i[c] = i; b1d[c] = d2; }
          continue;
        }
        if (d2 < b1d[c]) {
          b2i[c] = i1; b2d[c] = b1d[c];
          b1i[c] = i; b1d[c] = d2;
          continue;
        }
        const i2 = b2i[c];
        if (i2 < 0 || circ(i, i2) < partSpan) {
          if (d2 < b2d[c]) { b2i[c] = i; b2d[c] = d2; }
        } else if (d2 < b2d[c]) {
          b2i[c] = i; b2d[c] = d2;
        }
      }
    }
  }

  // 3) Compose heights and surfaces.
  const splat = hf.splat, wear = hf.wear, surf = hf.surf;
  const trackDist = new Float32Array(count).fill(1e4);
  const part = { s: 0, d: 0, dist: 0 };
  const refine = (c, idx, wx, wz) => {
    let best = idx, bd = Infinity;
    for (let k = -stride; k <= stride; k++) {
      const j = (((idx + k) % N) + N) % N;
      const dx = wx - track.x[j], dz = wz - track.z[j];
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = j; }
    }
    const dx = wx - track.x[best], dz = wz - track.z[best];
    const along = dx * track.tx[best] + dz * track.tz[best];
    part.s = best * DS + along;
    part.d = dx * track.tz[best] - dz * track.tx[best];
    part.dist = Math.sqrt(bd);
  };
  const shoulder = def.shoulder ?? 7;
  const sideTan = Math.tan(40 * DEG);
  const evalPart = (wx, wz, out) => {
    const s = part.s, d = part.d;
    const w = track.interp(track.W, s);
    const E = track.interp(track.E, s);
    const F = track.interp(track.F, s);
    const B = track.interp(track.B, s);
    const ad = Math.abs(d);
    // feature side slopes
    let featH = 0;
    if (F > 0.001) {
      if (ad <= w) featH = F;
      else {
        const run = F / sideTan + 0.6;
        const t = (ad - w) / run;
        featH = t >= 1 ? 0 : F * 0.5 * (1 + Math.cos(Math.PI * t));
      }
    }
    // berm on the outside of the corner
    let bermH = 0;
    if (Math.abs(B) > 0.01) {
      const o = B > 0 ? -d : d; // + toward outside
      const Bh = Math.abs(B);
      if (o > -0.25 * w) {
        if (o <= w) {
          const t = (o + 0.25 * w) / (1.25 * w);
          bermH = Bh * t * t;
        } else {
          const back = 1.4 * Bh + 1.6;
          const t = (o - w) / back;
          bermH = t >= 1 ? 0 : Bh * 0.5 * (1 + Math.cos(Math.PI * t));
        }
      }
    }
    // surface micro bumps on the riding surface
    let micro = 0;
    if (ad < w + 1.5) {
      const on = 1 - smoothstep(w, w + 1.5, ad);
      micro = (noise2.noise2(wx * 0.45, wz * 0.45) * 0.035 + noise2.noise2(wx * 1.3 + 9, wz * 1.3) * 0.012) * on;
      // braking bumps before tight corners
      const kAhead = Math.abs(track.interp(track.kappa, s + 9));
      if (kAhead > 1 / 22 && F < 0.05) {
        const env = smoothstep(1 / 22, 1 / 12, kAhead) * on;
        micro += env * 0.055 * (0.5 - 0.5 * Math.cos((2 * Math.PI * s) / 2.1));
      }
    }
    const wb = ad <= w + 0.8 ? 1 : 1 - smoothstep(w + 0.8, w + shoulder, ad);
    out.E = E;
    out.M = featH + bermH + micro;
    out.wb = wb;
    out.w = w;
    out.ad = ad;
    out.F = F;
  };
  const p1 = {}, p2 = {};
  const pits = (def.pits || []).map((pt) => resolvePit(track, pt));

  for (let iz = 0; iz < n; iz++) {
    const wz = iz * cell - half;
    for (let ix = 0; ix < n; ix++) {
      const c = iz * n + ix;
      const wx = ix * cell - half;
      let h = H[c];
      let dirtW = 0, wearW = 0, nearTrack = 1e4;
      if (b1i[c] >= 0) {
        refine(c, b1i[c], wx, wz);
        nearTrack = part.dist;
        evalPart(wx, wz, p1);
        let E = p1.E, M = p1.M, W = p1.wb;
        if (b2i[c] >= 0) {
          refine(c, b2i[c], wx, wz);
          nearTrack = Math.min(nearTrack, part.dist);
          evalPart(wx, wz, p2);
          const wsum = p1.wb + p2.wb;
          if (wsum > 1e-4) E = (p1.wb * p1.E + p2.wb * p2.E) / wsum;
          W = 1 - (1 - p1.wb) * (1 - p2.wb);
          M = Math.max(p1.M, p2.M);
        }
        h = h + (E - h) * W + M;
        // surfaces
        const en = noise.noise2(wx * 0.13, wz * 0.13) * 0.9 + noise.noise2(wx * 0.5, wz * 0.5) * 0.35;
        const dw = 1 - smoothstep(p1.w + 0.5 + en, p1.w + 2.3 + en, p1.ad);
        dirtW = Math.max(dw, smoothstep(0.1, 0.45, M - (p1.ad < p1.w ? 0.2 : 0)));
        if (b2i[c] >= 0) {
          const dw2 = 1 - smoothstep(p2.w + 0.5 + en, p2.w + 2.3 + en, p2.ad);
          dirtW = Math.max(dirtW, dw2);
        }
        wearW = (1 - smoothstep(0.15 * p1.w, 0.95 * p1.w, p1.ad)) * (0.6 + 0.4 * noise2.noise2(wx * 0.08, wz * 0.35));
      }
      trackDist[c] = nearTrack;
      // pits / gravel areas
      let gravelW = 0;
      for (const pt of pits) {
        const lx = (wx - pt.x) * pt.ux + (wz - pt.z) * pt.uz;
        const lz = (wx - pt.x) * pt.vx + (wz - pt.z) * pt.vz;
        const ex = Math.abs(lx) - pt.hw, ez = Math.abs(lz) - pt.hd;
        const out = Math.max(ex, ez);
        if (out < 6) {
          const m = 1 - smoothstep(0, 6, out);
          h = h + (pt.h - h) * m;
          gravelW = Math.max(gravelW, 1 - smoothstep(-1.5, 0.8, out + noise.noise2(wx * 0.3, wz * 0.3) * 0.8));
        }
      }
      H[c] = h;

      // splat weights: dirt, grass, sand, gravel
      let wD, wG, wS, wV;
      if (isSand) {
        const grassPatch = smoothstep(0.35, 0.6, noise.fbm(wx / 30, wz / 30, 2)) * smoothstep(14, 30, nearTrack);
        wS = 1 - grassPatch;
        wG = grassPatch;
        wD = 0;
        wV = 0;
        wearW = Math.max(wearW, dirtW * 0.35);
      } else {
        wD = dirtW;
        wG = 1 - dirtW;
        // a few dusty patches in the grass near the track
        const patch = smoothstep(0.55, 0.8, noise.fbm(wx / 9, wz / 9, 2)) * (1 - smoothstep(6, 18, nearTrack));
        wD = Math.max(wD, patch * 0.7);
        wG = 1 - wD;
        wS = 0;
        wV = 0;
      }
      if (gravelW > 0) {
        wV = gravelW;
        const k = 1 - gravelW;
        wD *= k; wG *= k; wS *= k;
      }
      const sum = wD + wG + wS + wV || 1;
      const o = c * 4;
      splat[o] = Math.round((wD / sum) * 255);
      splat[o + 1] = Math.round((wG / sum) * 255);
      splat[o + 2] = Math.round((wS / sum) * 255);
      splat[o + 3] = Math.round((wV / sum) * 255);
      wear[c] = Math.round(clamp(wearW, 0, 1) * 255);
      // physics surface = dominant weight
      let st = SURF.GRASS, bw = wG;
      if (wD > bw) { st = SURF.DIRT; bw = wD; }
      if (wS > bw) { st = SURF.SAND; bw = wS; }
      if (wV > bw) { st = SURF.GRAVEL; bw = wV; }
      surf[c] = st;
    }
  }
  hf.trackDist = trackDist;
  hf.pits = pits;
  hf.computeRange();
  return hf;
}

function resolvePit(track, pt) {
  const s = track.segStart(pt.seg ?? 0) + (pt.at ?? 40);
  const i = track.idx(s);
  const tx = track.tx[i], tz = track.tz[i];
  const nx = tz, nz = -tx;
  const side = pt.side ?? -1; // -1 = right side
  const off = side * (pt.offset ?? 30);
  const x = track.x[i] + nx * off, z = track.z[i] + nz * off;
  const h = track.ground(x, z) * 0.3 + track.E[i] * 0.7;
  return { x, z, ux: tx, uz: tz, vx: nx, vz: nz, hw: (pt.length ?? 60) / 2, hd: (pt.depth ?? 26) / 2, h, side };
}

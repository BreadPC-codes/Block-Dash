/* =====================================================================
   ROOST MX - core: namespace, module loader and small math helpers.

   Every other file registers itself with MX.module(name, fn). The
   functions run in load order once Three.js is available (MX.boot),
   so files can use THREE at their top level while still being plain
   <script> tags (which also work when index.html is opened from disk).
   ===================================================================== */
(function (root) {
  'use strict';
  const MX = root.MX = root.MX || {};
  MX.VERSION = '1.0.0';
  MX.STORAGE_PREFIX = 'roostmx.';

  const modules = [];
  MX.module = function (name, fn) { modules.push({ name, fn }); };
  MX.boot = function (THREE) {
    MX.THREE = THREE;
    for (const m of modules) {
      try { m.fn(THREE, MX); }
      catch (err) { console.error('[ROOST MX] module "' + m.name + '" failed:', err); throw err; }
    }
  };

  // ---------------------------------------------------------------- math
  const clamp = MX.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  MX.lerp = (a, b, t) => a + (b - a) * t;
  MX.invLerp = (a, b, v) => (v - a) / (b - a);
  MX.smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  MX.smootherstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };
  MX.damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
  MX.approach = (v, target, rate) => (v < target ? Math.min(target, v + rate) : Math.max(target, v - rate));
  MX.wrapAngle = (a) => { a = (a + Math.PI) % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return a - Math.PI; };
  MX.sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
  MX.deg = (r) => r * 180 / Math.PI;
  MX.rad = (d) => d * Math.PI / 180;

  // Piecewise linear lookup in [[x, y], ...] sorted by x.
  MX.curve = function (points, x) {
    if (x <= points[0][0]) return points[0][1];
    const n = points.length;
    if (x >= points[n - 1][0]) return points[n - 1][1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (points[mid][0] <= x) lo = mid; else hi = mid; }
    const a = points[lo], b = points[hi];
    const t = (x - a[0]) / (b[0] - a[0]);
    return a[1] + (b[1] - a[1]) * t;
  };
  // Smooth (Catmull-Rom) lookup in the same format; used for torque curves.
  MX.curveSmooth = function (points, x) {
    const n = points.length;
    if (x <= points[0][0]) return points[0][1];
    if (x >= points[n - 1][0]) return points[n - 1][1];
    let i = 0;
    while (i < n - 2 && points[i + 1][0] < x) i++;
    const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(n - 1, i + 2)];
    const t = (x - p1[0]) / (p2[0] - p1[0]);
    const m1 = (p2[1] - p0[1]) / (p2[0] - p0[0]) * (p2[0] - p1[0]);
    const m2 = (p3[1] - p1[1]) / (p3[0] - p1[0]) * (p2[0] - p1[0]);
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p1[1] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[1] + (t3 - t2) * m2;
  };

  // Seeded random number generator (mulberry32).
  MX.rng = function (seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // "1:02.345"
  MX.fmtLap = function (sec) {
    if (sec == null || !isFinite(sec)) return '--:--.---';
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(3);
  };

  // ------------------------------------------------------------- storage
  MX.load = function (key, fallback) {
    try {
      const raw = root.localStorage && root.localStorage.getItem(MX.STORAGE_PREFIX + key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) { return fallback; }
  };
  MX.save = function (key, value) {
    try { root.localStorage && root.localStorage.setItem(MX.STORAGE_PREFIX + key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  };
  // Deep merge of saved data over defaults, keeping only known keys' types.
  MX.mergeDefaults = function mergeDefaults(def, saved) {
    if (saved == null || typeof saved !== typeof def || Array.isArray(def) !== Array.isArray(saved)) return structuredCloneSafe(def);
    if (typeof def !== 'object' || def === null || Array.isArray(def)) return saved;
    const out = {};
    for (const k of Object.keys(def)) out[k] = (k in saved) ? mergeDefaults(def[k], saved[k]) : structuredCloneSafe(def[k]);
    // keep extra keys of open maps (marked with __open)
    if (def.__open) for (const k of Object.keys(saved)) if (!(k in out)) out[k] = saved[k];
    return out;
  };
  function structuredCloneSafe(v) { return v == null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)); }
  MX.clone = structuredCloneSafe;

  // Tiny event bus.
  const listeners = {};
  MX.on = (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); };
  MX.off = (ev, fn) => { const l = listeners[ev]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } };
  MX.emit = (ev, data) => { const l = listeners[ev]; if (l) for (const fn of l.slice()) fn(data); };
})(typeof window !== 'undefined' ? window : globalThis);

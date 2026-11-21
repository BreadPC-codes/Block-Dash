/* =====================================================================
   ROOST MX - seeded 2D simplex noise and fractal sums (terrain, dirt
   detail, procedural textures). Pure JS, no Three.js needed.
   ===================================================================== */
(function (root) {
  'use strict';
  const MX = root.MX;
  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;
  // gradient table as two flat arrays (x, y components) for fast lookups
  const GX = new Float64Array([1, -1, 1, -1, 1, -1, 0, 0, 1, -1, 1, -1]);
  const GY = new Float64Array([1, 1, -1, -1, 0, 0, 1, -1, 1, 1, -1, -1]);

  function Simplex(seed) {
    const rnd = MX.rng(seed || 1);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) { this.perm[i] = p[i & 255]; this.permMod12[i] = this.perm[i] % 12; }
  }
  // Returns roughly -1..1
  Simplex.prototype.noise = function (xin, yin) {
    const perm = this.perm, pm = this.permMod12;
    let n0 = 0, n1 = 0, n2 = 0;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) { const g = pm[ii + perm[jj]]; t0 *= t0; n0 = t0 * t0 * (GX[g] * x0 + GY[g] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) { const g = pm[ii + i1 + perm[jj + j1]]; t1 *= t1; n1 = t1 * t1 * (GX[g] * x1 + GY[g] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) { const g = pm[ii + 1 + perm[jj + 1]]; t2 *= t2; n2 = t2 * t2 * (GX[g] * x2 + GY[g] * y2); }
    return 70 * (n0 + n1 + n2);
  };
  // Fractal Brownian motion: octaves of noise, -1..1-ish
  Simplex.prototype.fbm = function (x, y, octaves, lacunarity, gain) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    lacunarity = lacunarity || 2; gain = gain || 0.5;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * freq + o * 17.3, y * freq - o * 9.1);
      norm += amp; amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  };
  // Ridged variant (sharp crests) 0..1
  Simplex.prototype.ridged = function (x, y, octaves) {
    let amp = 0.5, freq = 1, sum = 0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.noise(x * freq, y * freq));
      sum += amp * n * n; amp *= 0.5; freq *= 2;
    }
    return sum;
  };
  MX.Simplex = Simplex;
})(typeof window !== 'undefined' ? window : globalThis);

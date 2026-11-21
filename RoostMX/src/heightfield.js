// Regular-grid heightfield used for both physics queries and terrain rendering.
// Height interpolation uses the same triangle split as the rendered mesh, so the
// wheels touch exactly the surface the player sees (at full mesh resolution).

export const SURF = { DIRT: 0, GRASS: 1, SAND: 2, GRAVEL: 3 };

export const SURFACES = [
  // mu: peak grip, rr: rolling resistance coefficient, dust: particle amount, loose: lateral looseness
  { id: SURF.DIRT, name: 'Dirt', mu: 1.05, rr: 0.032, dust: 1.0, loose: 0.0, color: [0.36, 0.25, 0.16] },
  { id: SURF.GRASS, name: 'Grass', mu: 0.78, rr: 0.05, dust: 0.12, loose: 0.1, color: [0.2, 0.3, 0.12] },
  { id: SURF.SAND, name: 'Sand', mu: 0.86, rr: 0.11, dust: 1.4, loose: 0.25, color: [0.76, 0.66, 0.47] },
  { id: SURF.GRAVEL, name: 'Gravel', mu: 0.8, rr: 0.03, dust: 0.7, loose: 0.15, color: [0.45, 0.43, 0.4] },
];

export class Heightfield {
  constructor(size, cell) {
    this.size = size;
    this.cell = cell;
    this.n = Math.round(size / cell) + 1;
    this.half = size / 2;
    this.inv = 1 / cell;
    const count = this.n * this.n;
    this.h = new Float32Array(count);
    // splat weights for rendering: dirt, grass, sand, gravel (0..255)
    this.splat = new Uint8Array(count * 4);
    // racing-line wear / darkening (0..255)
    this.wear = new Uint8Array(count);
    this.surf = new Uint8Array(count);
    this.minH = 0;
    this.maxH = 0;
  }

  /** Grid-space coordinate of a world position. */
  gx(x) {
    return (x + this.half) * this.inv;
  }

  inBounds(x, z, margin = 0) {
    const lim = this.half - margin;
    return x > -lim && x < lim && z > -lim && z < lim;
  }

  /** Interpolated height at world (x, z). Clamped to the grid edges. */
  height(x, z) {
    const n = this.n;
    const max = n - 1.0001;
    let gx = (x + this.half) * this.inv;
    let gz = (z + this.half) * this.inv;
    if (gx < 0) gx = 0; else if (gx > max) gx = max;
    if (gz < 0) gz = 0; else if (gz > max) gz = max;
    const ix = gx | 0;
    const iz = gz | 0;
    const fx = gx - ix;
    const fz = gz - iz;
    const i = iz * n + ix;
    const h = this.h;
    // Triangles: (00,10,01) and (10,11,01) - diagonal from (1,0) to (0,1)
    if (fx + fz <= 1) {
      const h00 = h[i];
      return h00 + (h[i + 1] - h00) * fx + (h[i + n] - h00) * fz;
    }
    const h11 = h[i + n + 1];
    return h11 + (h[i + n] - h11) * (1 - fx) + (h[i + 1] - h11) * (1 - fz);
  }

  /**
   * Smoothed surface normal using central differences over `e` meters.
   * Writes into out (any object with x,y,z) and returns it.
   */
  normal(x, z, out, e = 0.3) {
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    const inv2e = 1 / (2 * e);
    let nx = -hx * inv2e;
    let ny = 1;
    let nz = -hz * inv2e;
    const l = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
    out.x = nx * l;
    out.y = ny * l;
    out.z = nz * l;
    return out;
  }

  /** Surface type at a world position (nearest cell). */
  surface(x, z) {
    const n = this.n;
    let ix = Math.round((x + this.half) * this.inv);
    let iz = Math.round((z + this.half) * this.inv);
    if (ix < 0) ix = 0; else if (ix >= n) ix = n - 1;
    if (iz < 0) iz = 0; else if (iz >= n) iz = n - 1;
    return this.surf[iz * n + ix];
  }

  /** Cast a ray against the terrain by marching; returns distance or -1. */
  raycast(ox, oy, oz, dx, dy, dz, maxDist = 400, step = 1) {
    let prevT = 0;
    let prevDiff = oy - this.height(ox, oz);
    if (prevDiff < 0) return 0;
    for (let t = step; t <= maxDist; t += step) {
      const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
      const diff = y - this.height(x, z);
      if (diff < 0) {
        // refine by bisection
        let a = prevT, b = t;
        for (let k = 0; k < 8; k++) {
          const m = (a + b) * 0.5;
          const d = oy + dy * m - this.height(ox + dx * m, oz + dz * m);
          if (d < 0) b = m; else a = m;
        }
        return (a + b) * 0.5;
      }
      prevT = t;
      prevDiff = diff;
      if (t > 40) step = Math.min(step * 1.05, 4);
    }
    return -1;
  }

  computeRange() {
    let mn = Infinity, mx = -Infinity;
    const h = this.h;
    for (let i = 0; i < h.length; i++) {
      const v = h[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    this.minH = mn;
    this.maxH = mx;
  }
}

/** Simple function-backed terrain used by tests (same interface as Heightfield). */
export class FunctionTerrain {
  constructor(fn, surfaceFn = () => SURF.DIRT) {
    this.fn = fn;
    this.surfaceFn = surfaceFn;
    this.half = 1e6;
  }
  height(x, z) {
    return this.fn(x, z);
  }
  normal(x, z, out, e = 0.3) {
    const hx = this.fn(x + e, z) - this.fn(x - e, z);
    const hz = this.fn(x, z + e) - this.fn(x, z - e);
    const inv2e = 1 / (2 * e);
    let nx = -hx * inv2e, ny = 1, nz = -hz * inv2e;
    const l = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
    out.x = nx * l; out.y = ny * l; out.z = nz * l;
    return out;
  }
  surface(x, z) {
    return this.surfaceFn(x, z);
  }
  inBounds() {
    return true;
  }
}

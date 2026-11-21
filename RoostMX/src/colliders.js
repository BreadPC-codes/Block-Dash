// Static world colliders (trees, fences, barriers, buildings) in a spatial hash.
// Shapes are vertical prisms: circles (cylinders), oriented boxes and capsule walls.

export class ColliderSet {
  constructor(cell = 12) {
    this.cell = cell;
    this.map = new Map();
    this.items = [];
    this._stamp = 0;
  }

  clear() {
    this.map.clear();
    this.items.length = 0;
  }

  _key(ix, iz) {
    return ix * 73856093 ^ iz * 19349663;
  }

  _insert(item, minX, minZ, maxX, maxZ) {
    item.id = this.items.length;
    item.mark = 0;
    this.items.push(item);
    const c = this.cell;
    const x0 = Math.floor(minX / c), x1 = Math.floor(maxX / c);
    const z0 = Math.floor(minZ / c), z1 = Math.floor(maxZ / c);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = this._key(ix, iz);
        let b = this.map.get(k);
        if (!b) this.map.set(k, (b = []));
        b.push(item);
      }
    }
    return item;
  }

  addCircle(x, z, r, y0, y1, tag = 'obj', hard = true) {
    return this._insert({ type: 0, x, z, r, y0, y1, tag, hard }, x - r, z - r, x + r, z + r);
  }

  addBox(x, z, hw, hd, yaw, y0, y1, tag = 'obj', hard = true) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const ex = Math.abs(c * hw) + Math.abs(s * hd);
    const ez = Math.abs(s * hw) + Math.abs(c * hd);
    // local axes: u = (c, -s) along hw (x), v = (s, c) along hd (z)
    return this._insert({ type: 1, x, z, hw, hd, ux: c, uz: -s, vx: s, vz: c, y0, y1, tag, hard }, x - ex, z - ez, x + ex, z + ez);
  }

  addSegment(x0, z0, x1, z1, r, y0, y1, tag = 'wall', hard = true) {
    return this._insert(
      { type: 2, x0, z0, x1, z1, r, y0, y1, tag, hard },
      Math.min(x0, x1) - r, Math.min(z0, z1) - r, Math.max(x0, x1) + r, Math.max(z0, z1) + r
    );
  }

  /**
   * Find the deepest penetration of a vertical-axis sphere (x, y, z, radius).
   * Returns null or { nx, nz, depth, item } with the push-out normal in XZ.
   */
  sphereHit(x, y, z, radius, out = {}) {
    const c = this.cell;
    const x0 = Math.floor((x - radius) / c), x1 = Math.floor((x + radius) / c);
    const z0 = Math.floor((z - radius) / c), z1 = Math.floor((z + radius) / c);
    const stamp = ++this._stamp;
    let best = null;
    let bestDepth = 0;
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const b = this.map.get(this._key(ix, iz));
        if (!b) continue;
        for (const it of b) {
          if (it.mark === stamp) continue;
          it.mark = stamp;
          if (y + radius < it.y0 || y - radius > it.y1) continue;
          let nx = 0, nz = 0, depth = 0;
          if (it.type === 0) {
            const dx = x - it.x, dz = z - it.z;
            const d = Math.hypot(dx, dz);
            depth = it.r + radius - d;
            if (depth <= 0) continue;
            if (d > 1e-6) { nx = dx / d; nz = dz / d; } else { nx = 1; }
          } else if (it.type === 1) {
            const dx = x - it.x, dz = z - it.z;
            const lu = dx * it.ux + dz * it.uz;
            const lv = dx * it.vx + dz * it.vz;
            const cu = Math.max(-it.hw, Math.min(it.hw, lu));
            const cv = Math.max(-it.hd, Math.min(it.hd, lv));
            const ou = lu - cu, ov = lv - cv;
            const d = Math.hypot(ou, ov);
            if (d > 1e-6) {
              depth = radius - d;
              if (depth <= 0) continue;
              const pu = ou / d, pv = ov / d;
              nx = pu * it.ux + pv * it.vx;
              nz = pu * it.uz + pv * it.vz;
            } else {
              // center inside the box: push out along the smallest overlap axis
              const du = it.hw - Math.abs(lu), dv = it.hd - Math.abs(lv);
              if (du < dv) {
                depth = du + radius;
                const sgn = lu < 0 ? -1 : 1;
                nx = it.ux * sgn; nz = it.uz * sgn;
              } else {
                depth = dv + radius;
                const sgn = lv < 0 ? -1 : 1;
                nx = it.vx * sgn; nz = it.vz * sgn;
              }
            }
          } else {
            const ex = it.x1 - it.x0, ez = it.z1 - it.z0;
            const l2 = ex * ex + ez * ez || 1;
            let t = ((x - it.x0) * ex + (z - it.z0) * ez) / l2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const px = it.x0 + ex * t, pz = it.z0 + ez * t;
            const dx = x - px, dz = z - pz;
            const d = Math.hypot(dx, dz);
            depth = it.r + radius - d;
            if (depth <= 0) continue;
            if (d > 1e-6) { nx = dx / d; nz = dz / d; } else { nx = -ez; nz = ex; const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l; }
          }
          if (depth > bestDepth) {
            bestDepth = depth;
            best = it;
            out.nx = nx;
            out.nz = nz;
          }
        }
      }
    }
    if (!best) return null;
    out.depth = bestDepth;
    out.item = best;
    return out;
  }
}

/* =====================================================================
   ROOST MX - track & terrain.

   One analytic height function H(x, z) describes the whole map. Physics
   samples it directly (no meshes involved) and the renderer builds its
   meshes from the very same function, so what you see is what you ride.

   H = lerp(natural terrain, track base, corridor weight)
       + jumps / rollers / whoops (along the track, with shoulders)
       + berms (on the outside of turns) + ruts + braking bumps
       + small dirt roughness
   ===================================================================== */
(function (root) {
  'use strict';
  const MX = root.MX;
  const { clamp, smoothstep, lerp } = MX;
  const DS = 0.5;        // centerline sample spacing (m)
  const CELL = 8;        // spatial hash cell (m)

  // ------------------------------------------------------------ profiles
  // A profile is a list of pieces {u0, u1, h0, h1, shape, p}; u is the
  // distance along the track from the feature start.
  function evalPiece(pc, u) {
    const t = (u - pc.u0) / (pc.u1 - pc.u0);
    let f;
    switch (pc.shape) {
      case 'pow': f = Math.pow(t, pc.p); break;
      case 'cos': f = 0.5 - 0.5 * Math.cos(Math.PI * t); break;
      case 'in': f = 1 - Math.cos(Math.PI * 0.5 * t); break;       // flat start, steep end
      case 'out': f = Math.sin(Math.PI * 0.5 * t); break;          // steep start, flat end
      case 'lin': f = t; break;
      default: f = 0;
    }
    return pc.h0 + (pc.h1 - pc.h0) * f;
  }

  function lipFace(h, lipDeg, p) {
    p = p || 1.7;
    const len = p * h / Math.tan(lipDeg * Math.PI / 180);
    return { len, p };
  }

  // Build the piece list for a feature definition.
  function buildFeature(f, lipDeg) {
    const P = [];
    let u = 0;
    const add = (len, h0, h1, shape, p) => { P.push({ u0: u, u1: u + len, h0, h1, shape, p }); u += len; };
    const landing = (H, angle) => {
      // smooth knuckle then the landing slope (cosine, max slope = angle)
      const len = (Math.PI / 2) * H / Math.tan((angle || 25) * Math.PI / 180);
      add(len, H, 0, 'cos');
    };
    switch (f.type) {
      case 'table': {
        const face = lipFace(f.h, f.lip || lipDeg);
        add(face.len, 0, f.h, 'pow', face.p);
        add(f.top, f.h, f.h, 'lin');
        landing(f.h, f.landAngle);
        break;
      }
      case 'double': case 'kicker': {
        const h = f.h;
        const lip = f.type === 'kicker' ? (f.lip || lipDeg + 4) : (f.lip || lipDeg);
        const face = lipFace(h, lip);
        add(face.len, 0, h, 'pow', face.p);
        const lipU = u;
        const back = 1.0 * h + 0.4;
        add(back, h, 0, 'cos');
        if (f.type === 'double') {
          const landH = f.landH || h;
          const rise = 0.95 * landH + 0.4;
          const crest = lipU + f.gap;
          const flat = Math.max(0, crest - rise - u);
          if (flat > 0) add(flat, 0, 0, 'lin');
          add(rise, 0, landH, 'cos');
          landing(landH, f.landAngle);
        }
        break;
      }
      case 'stepup': {
        const face = lipFace(f.h, f.lip || lipDeg);
        add(face.len, 0, f.h, 'pow', face.p);
        const lipU = u;
        const back = 0.9 * f.h + 0.4;
        add(back, f.h, 0, 'cos');
        const wall = 0.75 * f.landH + 0.3;
        const crest = lipU + f.gap;
        const flat = Math.max(0, crest - wall - u);
        if (flat > 0) add(flat, 0, 0, 'lin');
        add(wall, 0, f.landH, 'out');
        add(f.plateau, f.landH, f.landH, 'lin');
        add(f.down, f.landH, 0, 'cos');
        break;
      }
      case 'stepdown': {
        add(f.rise, 0, f.h, 'cos');                 // gentle ramp up to a plateau
        add(4, f.h, f.h + 0.35, 'in');              // little kicker at the edge
        const lipU = u;
        const back = 1.0 * f.h;
        add(back, f.h + 0.35, 0, 'cos');
        const landH = f.landH;
        const rise = 0.9 * landH + 0.3;
        const crest = lipU + f.gap;
        const flat = Math.max(0, crest - rise - u);
        if (flat > 0) add(flat, 0, 0, 'lin');
        add(rise, 0, landH, 'cos');
        landing(landH, f.landAngle);
        break;
      }
      case 'rhythm': {
        for (let i = 0; i < f.n; i++) {
          const start = i * f.spacing;
          if (start > u) add(start - u, 0, 0, 'lin');
          add(f.up, 0, f.h, 'pow', 1.4);
          add(0.5, f.h, f.h, 'lin');
          add(f.down, f.h, 0, 'cos');
        }
        break;
      }
      case 'rollers': {
        for (let i = 0; i < f.n; i++) {
          add(f.spacing * 0.5, 0, f.h, 'cos');
          add(f.spacing * 0.5, f.h, 0, 'cos');
        }
        break;
      }
      case 'whoops': {
        for (let i = 0; i < f.n; i++) {
          add(f.spacing * 0.5, 0, f.h, 'cos');
          add(f.spacing * 0.5, f.h, 0, 'cos');
        }
        break;
      }
      default: break;
    }
    let maxH = 0;
    for (const pc of P) maxH = Math.max(maxH, pc.h0, pc.h1);
    return { pieces: P, len: u, maxH };
  }

  // ----------------------------------------------------------------- Track
  class Track {
    constructor(def) {
      this.def = def;
      this.id = def.id;
      this.name = def.name;
      this.w = def.halfWidth;
      this.blend = def.blend;
      this.margin = def.margin;
      this.rInf = def.halfWidth + def.blend + def.margin + 3.5; // influence radius (incl. berm backs)
      this.half = def.size / 2;
      this.noise = new MX.Simplex(def.seed);
      this.noise2 = new MX.Simplex(def.seed * 7 + 3);
      this.surf = def.surface;
      this._buildCenterline();
      this._buildHash();
      this._buildProfiles();
      this._buildFeatures();
      this._buildProps();
    }

    // ---------------------------------------------------- natural terrain
    terrain(x, z) {
      const t = this.def.terrain;
      let h = 0;
      if (t.kind === 'flat') return 0;
      const n = this.noise;
      h += t.amp * n.fbm(x / t.scale + 3.1, z / t.scale - 7.7, t.kind === 'hills' ? 4 : 3);
      if (t.detailAmp) h += t.detailAmp * n.fbm(x / t.detailScale + 11.3, z / t.detailScale + 2.9, 3);
      if (t.bumpAmp) h += t.bumpAmp * this.noise2.noise(x / 9.0, z / 9.0);
      if (t.rim) {
        const e = Math.max(Math.abs(x), Math.abs(z)) - (this.half - t.rim);
        if (e > 0) h += (e / t.rim) * (e / t.rim) * t.rim * 0.45;
      }
      return h;
    }

    // ------------------------------------------------------- centerline
    _buildCenterline() {
      const def = this.def;
      const segs = def.layout.map((s) => s.slice());
      // pass 1: walk to find closure error, then stretch the two closing straights
      const walk = (segments) => {
        let x = 0, z = 0, th = (def.start.heading || 0) * Math.PI / 180;
        const heads = [];
        for (const sg of segments) {
          heads.push(th);
          if (sg[0] === 'S') { x += Math.sin(th) * sg[1]; z += Math.cos(th) * sg[1]; }
          else {
            const R = sg[1], a = sg[2] * Math.PI / 180;
            const sgn = Math.sign(a);
            // center on the left (+) or right (-)
            const cx = x + sgn * R * Math.cos(th), cz = z - sgn * R * Math.sin(th);
            th += a;
            x = cx - sgn * R * Math.cos(th); z = cz + sgn * R * Math.sin(th);
          }
        }
        return { x, z, th, heads };
      };
      const r0 = walk(segs);
      const [ia, ib] = def.close;
      const ua = [Math.sin(r0.heads[ia]), Math.cos(r0.heads[ia])];
      const ub = [Math.sin(r0.heads[ib]), Math.cos(r0.heads[ib])];
      const ex = -r0.x, ez = -r0.z;
      const det = ua[0] * ub[1] - ua[1] * ub[0];
      if (Math.hypot(ex, ez) > 1e-6) {
        if (Math.abs(det) < 1e-6) throw new Error('closing segments are parallel');
        const a = (ex * ub[1] - ez * ub[0]) / det;
        const b = (ua[0] * ez - ua[1] * ex) / det;
        segs[ia][1] += a; segs[ib][1] += b;
      }
      if (segs[ia][1] < 5 || segs[ib][1] < 5) console.warn('[track] closure made a straight very short', def.id, segs[ia][1], segs[ib][1]);
      const turnSum = segs.reduce((acc, s) => acc + (s[0] === 'T' ? s[2] : 0), 0);
      if (Math.abs(Math.abs(turnSum) - 360) > 1e-6) console.warn('[track] turns do not add to 360', def.id, turnSum);
      this.segments = segs;

      // pass 2: sample every DS metres
      const px = [], pz = [], tx = [], tz = [], cv = [], sg = [];
      const segStart = [];
      let x = 0, z = 0, th = (def.start.heading || 0) * Math.PI / 180, s = 0;
      let carry = 0; // distance into the next segment where the next sample falls
      for (let k = 0; k < segs.length; k++) {
        const g = segs[k];
        segStart.push(s - carry);
        const len = g[0] === 'S' ? g[1] : Math.abs(g[2] * Math.PI / 180) * g[1];
        const R = g[0] === 'T' ? g[1] : Infinity;
        const ang = g[0] === 'T' ? g[2] * Math.PI / 180 : 0;
        const sgn = Math.sign(ang);
        const cx = g[0] === 'T' ? x + sgn * R * Math.cos(th) : 0;
        const cz = g[0] === 'T' ? z - sgn * R * Math.sin(th) : 0;
        let u = carry;
        while (u < len - 1e-9) {
          let sx, sz, sth;
          if (g[0] === 'S') { sx = x + Math.sin(th) * u; sz = z + Math.cos(th) * u; sth = th; }
          else {
            sth = th + sgn * u / R;
            sx = cx - sgn * R * Math.cos(sth); sz = cz + sgn * R * Math.sin(sth);
          }
          px.push(sx); pz.push(sz); tx.push(Math.sin(sth)); tz.push(Math.cos(sth));
          cv.push(g[0] === 'T' ? sgn / R : 0); sg.push(k);
          u += DS; s += DS;
        }
        carry = u - len;
        if (g[0] === 'S') { x += Math.sin(th) * len; z += Math.cos(th) * len; }
        else { th += ang; x = cx - sgn * R * Math.cos(th); z = cz + sgn * R * Math.sin(th); }
      }
      // recentre on the map
      let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
      for (let i = 0; i < px.length; i++) { minx = Math.min(minx, px[i]); maxx = Math.max(maxx, px[i]); minz = Math.min(minz, pz[i]); maxz = Math.max(maxz, pz[i]); }
      const ox = -(minx + maxx) / 2 + (def.offset ? def.offset[0] : 0);
      const oz = -(minz + maxz) / 2 + (def.offset ? def.offset[1] : 0);
      const n = px.length;
      this.n = n;
      this.length = n * DS;
      this.px = new Float64Array(n); this.pz = new Float64Array(n);
      this.tx = new Float64Array(tx); this.tz = new Float64Array(tz);
      this.curv = new Float64Array(cv);
      this.segOf = new Int32Array(sg);
      for (let i = 0; i < n; i++) { this.px[i] = px[i] + ox; this.pz[i] = pz[i] + oz; }
      this.segStart = segStart;
      this.bbox = { minx: minx + ox, maxx: maxx + ox, minz: minz + oz, maxz: maxz + oz };
      // smoothed curvature (for berms, chop and HUD map)
      const sc = new Float64Array(n);
      const K = 8;
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let j = -K; j <= K; j++) acc += this.curv[(i + j + n) % n];
        sc[i] = acc / (2 * K + 1);
      }
      this.curvS = sc;
    }

    // segment-relative position -> absolute s
    segS(seg, at) { return ((this.segStart[seg] + at) % this.length + this.length) % this.length; }

    // ------------------------------------------------------ spatial hash
    _buildHash() {
      const half = this.half + 20;
      this.hx0 = -half; this.hz0 = -half;
      this.hn = Math.ceil((2 * half) / CELL);
      const lists = new Array(this.hn * this.hn);
      const R = this.rInf + 1;
      for (let i = 0; i < this.n; i++) {
        const x = this.px[i], z = this.pz[i];
        const c0 = Math.max(0, Math.floor((x - R - this.hx0) / CELL)), c1 = Math.min(this.hn - 1, Math.floor((x + R - this.hx0) / CELL));
        const r0 = Math.max(0, Math.floor((z - R - this.hz0) / CELL)), r1 = Math.min(this.hn - 1, Math.floor((z + R - this.hz0) / CELL));
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          const k = r * this.hn + c;
          (lists[k] || (lists[k] = [])).push(i);
        }
      }
      this.hash = lists.map((l) => (l ? Int32Array.from(l) : null));
    }

    // Nearest point on the centerline; returns false if beyond rInf.
    // Fills q: { s, d, i, t (0..1 between i and i+1) }
    query(x, z, q) {
      const c = Math.floor((x - this.hx0) / CELL), r = Math.floor((z - this.hz0) / CELL);
      if (c < 0 || r < 0 || c >= this.hn || r >= this.hn) return false;
      const list = this.hash[r * this.hn + c];
      if (!list) return false;
      const px = this.px, pz = this.pz;
      let best = Infinity, bi = -1;
      for (let k = 0; k < list.length; k++) {
        const i = list[k];
        const dx = x - px[i], dz = z - pz[i];
        const d2 = dx * dx + dz * dz;
        if (d2 < best) { best = d2; bi = i; }
      }
      if (bi < 0 || best > this.rInf * this.rInf) return false;
      const n = this.n;
      // project on the two adjacent segments
      let bs = 0, bd2 = Infinity, bt = 0, bseg = bi;
      for (let side = 0; side < 2; side++) {
        const i0 = side === 0 ? (bi - 1 + n) % n : bi;
        const i1 = (i0 + 1) % n;
        const ax = px[i0], az = pz[i0];
        const ex = px[i1] - ax, ez = pz[i1] - az;
        const l2 = ex * ex + ez * ez;
        let t = ((x - ax) * ex + (z - az) * ez) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + ex * t, cz = az + ez * t;
        const dx = x - cx, dz = z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 < bd2) { bd2 = d2; bt = t; bseg = i0; }
      }
      const i0 = bseg, i1 = (i0 + 1) % n;
      const t = bt;
      const cx = px[i0] + (px[i1] - px[i0]) * t, cz = pz[i0] + (pz[i1] - pz[i0]) * t;
      let txx = this.tx[i0] + (this.tx[i1] - this.tx[i0]) * t;
      let tzz = this.tz[i0] + (this.tz[i1] - this.tz[i0]) * t;
      const tl = Math.hypot(txx, tzz) || 1; txx /= tl; tzz /= tl;
      // left normal = (tz, -tx)
      q.d = (x - cx) * tzz - (z - cz) * txx;
      q.s = (i0 + t) * DS;
      q.i = i0; q.t = t;
      q.tx = txx; q.tz = tzz;
      return true;
    }

    // per-sample value with linear interpolation
    _lerpArr(arr, q) { const i1 = (q.i + 1) % this.n; return arr[q.i] + (arr[i1] - arr[q.i]) * q.t; }

    // ------------------------------------------------------ profiles
    _buildProfiles() {
      const n = this.n, def = this.def;
      // natural terrain along the line, smoothed -> base elevation
      const raw = new Float64Array(n), crossRaw = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        raw[i] = this.terrain(this.px[i], this.pz[i]);
        const nx = this.tz[i], nz = -this.tx[i];
        crossRaw[i] = (this.terrain(this.px[i] + nx * 3, this.pz[i] + nz * 3) - this.terrain(this.px[i] - nx * 3, this.pz[i] - nz * 3)) / 6;
      }
      const smooth = (src, sigma) => {
        if (!sigma) return Float64Array.from(src);
        const out = new Float64Array(n);
        const K = Math.ceil(3 * sigma / DS);
        const wts = [];
        let wsum = 0;
        for (let j = -K; j <= K; j++) { const w = Math.exp(-0.5 * (j * DS / sigma) ** 2); wts.push(w); wsum += w; }
        for (let i = 0; i < n; i++) {
          let acc = 0;
          for (let j = -K; j <= K; j++) acc += src[(i + j + n * 4) % n] * wts[j + K];
          out[i] = acc / wsum;
        }
        return out;
      };
      this.base = smooth(raw, def.elevSmooth);
      const cs = smooth(crossRaw, def.elevSmooth * 0.6 || 0);
      this.cross = new Float64Array(n);
      for (let i = 0; i < n; i++) this.cross[i] = clamp(cs[i] * (def.crossSlope || 0), -0.14, 0.14);

      // berms, ruts and braking bumps from the turn options
      this.bermH = new Float64Array(n);
      this.bermSide = new Float64Array(n);
      this.rutD = new Float64Array(n);
      this.rutSide = new Float64Array(n);
      this.chop = new Float64Array(n);
      const L = this.length;
      const segs = this.segments;
      const chopAmp = this.surf.chop || 0;
      for (let k = 0; k < segs.length; k++) {
        const g = segs[k];
        if (g[0] !== 'T') continue;
        const o = g[3] || {};
        const s0 = this.segStart[k];
        const len = Math.abs(g[2] * Math.PI / 180) * g[1];
        const s1 = s0 + len;
        const side = Math.sign(g[2]);
        const stamp = (arr, sideArr, amp, pre, post, rampIn, rampOut, mode) => {
          const a = s0 - pre, b = s1 + post;
          for (let s = a; s <= b; s += DS) {
            let f;
            if (s < s0 - pre + rampIn) f = smoothstep(s0 - pre, s0 - pre + rampIn, s);
            else if (s > s1 + post - rampOut) f = 1 - smoothstep(s1 + post - rampOut, s1 + post, s);
            else f = 1;
            const i = Math.round((((s % L) + L) % L) / DS) % this.n;
            const v = amp * f;
            if (mode === 'max') { if (v > arr[i]) { arr[i] = v; if (sideArr) sideArr[i] = side; } }
            else arr[i] += v;
          }
        };
        if (o.berm) stamp(this.bermH, this.bermSide, o.berm, 5, 5, 8, 9, 'max');
        if (o.ruts) stamp(this.rutD, this.rutSide, o.ruts, 6, 7, 6, 8, 'max');
        if (chopAmp && (o.berm || 0) >= 0.6) {
          // braking bumps before the turn, accel chop after it
          const a = s0 - 30, b = s0 + 2;
          for (let s = a; s <= b; s += DS) {
            const f = smoothstep(a, s0 - 6, s) * (1 - smoothstep(s0 - 1, b, s));
            const i = Math.round((((s % L) + L) % L) / DS) % this.n;
            this.chop[i] = Math.max(this.chop[i], chopAmp * f);
          }
          const c = s1 + 2, d = s1 + 20;
          for (let s = c; s <= d; s += DS) {
            const f = smoothstep(c, c + 4, s) * (1 - smoothstep(d - 8, d, s));
            const i = Math.round((((s % L) + L) % L) / DS) % this.n;
            this.chop[i] = Math.max(this.chop[i], chopAmp * 0.55 * f);
          }
        }
      }
      // explicit inner-side extent (for meshes): never cross the centre of a turn
      this.extL = new Float64Array(n); this.extR = new Float64Array(n);
      const ext = this.rInf;
      for (let i = 0; i < n; i++) {
        const k = this.curv[i];
        let l = ext, r = ext;
        if (k > 1e-6) l = Math.min(ext, 0.92 / k);
        if (k < -1e-6) r = Math.min(ext, 0.92 / -k);
        this.extL[i] = l; this.extR[i] = r;
      }
      // smooth the extents a little so the ribbon edge doesn't kink
      for (let pass = 0; pass < 2; pass++) {
        for (const arr of [this.extL, this.extR]) {
          const c = Float64Array.from(arr);
          for (let i = 0; i < n; i++) arr[i] = Math.min(c[i], (c[(i - 3 + n) % n] + 2 * c[i] + c[(i + 3) % n]) / 4 + 0.5);
          // propagate tight values to neighbours (the clamp must hold before/after the turn)
          for (let i = 0; i < n; i++) {
            let m = arr[i];
            for (let j = -10; j <= 10; j++) m = Math.min(m, c[(i + j + n) % n] + Math.abs(j) * 0.35);
            arr[i] = m;
          }
        }
      }
    }

    // ------------------------------------------------------ features
    _buildFeatures() {
      const def = this.def;
      this.features = [];
      this.finishS = 20;
      this.gateS = null;
      for (const f of def.features) {
        const s0 = this.segS(f.seg, f.at);
        if (f.type === 'finish') { this.finishS = s0; continue; }
        if (f.type === 'gate') { this.gateS = s0; continue; }
        const prof = buildFeature(f, def.lip || 28);
        this.features.push({ type: f.type, s0, s1: s0 + prof.len, len: prof.len, pieces: prof.pieces, maxH: prof.maxH, def: f });
      }
      this.features.sort((a, b) => a.s0 - b.s0);
      // bucket by 10 m for quick lookup
      this.fBucket = [];
      const nb = Math.ceil(this.length / 10) + 1;
      for (let b = 0; b < nb; b++) this.fBucket.push([]);
      for (const f of this.features) {
        for (let s = Math.floor(f.s0 / 10); s <= Math.floor(f.s1 / 10); s++) this.fBucket[((s % nb) + nb) % nb].push(f);
      }
      this.spawnS = this.gateS != null ? this.gateS + 2 : (this.finishS - 14 + this.length) % this.length;
      // level the start area (riders line up on flat ground)
      if (this.def.elevSmooth) {
        const n = this.n, c = Math.round(this.spawnS / DS), ref = this.base[c];
        for (let k = -90; k <= 110; k++) {
          const i = ((c + k) % n + n) % n;
          const w = 1 - smoothstep(30, 55, Math.abs(k * DS - 5));
          this.base[i] = lerp(this.base[i], ref + (k * DS) * 0.02, w);
        }
      }
    }

    featureHeight(s) {
      const nb = this.fBucket.length;
      const list = this.fBucket[Math.floor(s / 10) % nb];
      if (!list || !list.length) return 0;
      let h = 0;
      for (let k = 0; k < list.length; k++) {
        const f = list[k];
        let u = s - f.s0;
        if (u < 0 && f.s1 > this.length) u += this.length;
        if (u < 0 || u >= f.len) continue;
        // binary search the piece
        const P = f.pieces;
        let lo = 0, hi = P.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (P[mid].u1 <= u) lo = mid + 1; else hi = mid; }
        h += evalPiece(P[lo], u);
      }
      return h;
    }

    // ------------------------------------------------------ height
    // Full surface height. If info is given, it gets track-relative data.
    height(x, z, info) {
      const q = this._q || (this._q = {});
      const T = this.terrain(x, z);
      const surf = this.surf;
      if (!this.query(x, z, q)) {
        if (info) { info.onTrack = false; info.dirt = surf.allDirt ? 1 : 0; info.rut = 0; info.d = 99; info.s = 0; }
        return T + this._grassRough(x, z);
      }
      const w = this.w, d = q.d, ad = Math.abs(d);
      const base = this._lerpArr(this.base, q) + this._lerpArr(this.cross, q) * d;
      const wBase = 1 - smoothstep(w + 0.3, w + this.blend, ad);
      let h = T + (base - T) * wBase;
      // jumps & co
      const fh = this.featureHeight(q.s);
      if (fh > 0) {
        const shoulder = Math.max(0.9, 1.15 * fh);
        h += fh * (1 - smoothstep(w - 0.35, w - 0.35 + shoulder, ad));
      }
      // berm
      const bh = this._lerpArr(this.bermH, q);
      let dOut = 0;
      if (bh > 0.001) {
        const side = this.bermSide[q.i] || this.bermSide[(q.i + 1) % this.n];
        dOut = -side * d;
        if (dOut > 0) {
          const back = 1.3 + 1.2 * bh;
          const u = (dOut - 0.15 * w) / (0.85 * w);
          if (dOut <= w) { if (u > 0) h += bh * Math.pow(u, 2.2); }
          else if (dOut < w + back) h += bh * 0.5 * (1 + Math.cos(Math.PI * (dOut - w) / back));
        }
      }
      // ruts
      let rutAmt = 0;
      const rd = this._lerpArr(this.rutD, q);
      if (rd > 0.002) {
        const side = this.rutSide[q.i] || this.rutSide[(q.i + 1) % this.n];
        const dd = -side * d;
        const s = q.s;
        const lines = [
          0.60 * w + 0.10 * w * Math.sin(s * 0.11), 1.0,
          -0.30 * w + 0.08 * w * Math.sin(s * 0.09 + 1.3), 0.85,
          0.16 * w + 0.06 * w * Math.sin(s * 0.13 + 2.1), 0.55,
        ];
        for (let k = 0; k < lines.length; k += 2) {
          const D = Math.abs(dd - lines[k]);
          if (D < 0.2) { const t = 1 - (D / 0.2) * (D / 0.2); const v = t * t; h -= rd * lines[k + 1] * v; rutAmt = Math.max(rutAmt, v * lines[k + 1]); }
          else if (D < 0.42) h += rd * lines[k + 1] * 0.22 * Math.sin(Math.PI * (D - 0.2) / 0.22);
        }
      }
      // braking bumps
      const ch = this._lerpArr(this.chop, q);
      if (ch > 0.001 && ad < w + 0.5) {
        const s = q.s;
        const lat = 1 - smoothstep(w - 1.2, w + 0.5, ad);
        h += ch * lat * (0.6 * Math.sin(6.2832 * s / 1.55 + 0.5 * Math.sin(0.9 * d)) +
                         0.4 * Math.sin(6.2832 * s / 1.18 + 1.7 + 0.7 * Math.sin(0.6 * d + 2)));
      }
      // dirt roughness on the track, grass bumps off it
      const onT = 1 - smoothstep(w - 0.2, w + 1.0, ad);
      const n2 = this.noise2;
      let r = surf.rough * (n2.noise(x / 2.3, z / 2.3) + 0.25 * n2.noise(x / 1.1 + 9, z / 1.1));
      if (surf.uneven) r += surf.uneven * (0.6 * n2.noise(x / 9.5 - 4, z / 9.5 + 1) + 0.4 * n2.noise(x / 4.1 + 7, z / 4.1 - 3));
      h += r * onT + this._grassRough(x, z) * (1 - onT);
      if (info) {
        info.onTrack = ad < w + 0.5;
        info.dirt = surf.allDirt ? 1 : Math.max(onT, bh > 0.05 && dOut > 0 ? 1 - smoothstep(w + 0.6 + bh, w + 1.8 + 1.2 * bh, dOut) : 0);
        info.rut = rutAmt;
        info.d = d; info.s = q.s;
      }
      return h;
    }

    _grassRough(x, z) {
      if (this.surf.allDirt) return 0.01 * this.noise2.noise(x / 2.5, z / 2.5);
      return 0.03 * this.noise2.noise(x / 4.6 + 5, z / 4.6 - 8);
    }

    // height + normal (central differences)
    heightNormal(x, z, out) {
      const e = 0.07;
      const h = this.height(x, z, out.info);
      const hx0 = this.height(x - e, z), hx1 = this.height(x + e, z);
      const hz0 = this.height(x, z - e), hz1 = this.height(x, z + e);
      let nx = -(hx1 - hx0) / (2 * e), ny = 1, nz = -(hz1 - hz0) / (2 * e);
      const l = Math.hypot(nx, ny, nz);
      out.h = h; out.nx = nx / l; out.ny = ny / l; out.nz = nz / l;
      return out;
    }

    // friction coefficient at a point (info from height())
    mu(info, x, z) {
      const s = this.surf;
      let m = lerp(s.offMu, s.trackMu, info.dirt);
      if (info.rut > 0.2) m *= 0.97;
      m *= 1 + 0.04 * this.noise.noise(x / 23, z / 23);
      return m;
    }

    // centerline position/heading at s
    pointAt(s) {
      const L = this.length;
      s = ((s % L) + L) % L;
      const f = s / DS;
      const i0 = Math.floor(f) % this.n, i1 = (i0 + 1) % this.n, t = f - Math.floor(f);
      const x = this.px[i0] + (this.px[i1] - this.px[i0]) * t;
      const z = this.pz[i0] + (this.pz[i1] - this.pz[i0]) * t;
      const tx = this.tx[i0] + (this.tx[i1] - this.tx[i0]) * t;
      const tz = this.tz[i0] + (this.tz[i1] - this.tz[i0]) * t;
      const l = Math.hypot(tx, tz);
      return { x, z, tx: tx / l, tz: tz / l, heading: Math.atan2(tx / l, tz / l) };
    }

    // a reset spot at or behind s: flat, off berms/ruts, with a run-up to the next jump
    safeResetS(s0) {
      const L = this.length, wrap = (v) => ((v % L) + L) % L;
      let s = s0;
      for (let k = 0; k < 120; k++) {
        const i = Math.floor(wrap(s) / DS) % this.n;
        let ok = this.isFlatAt(s) && this.bermH[i] < 0.15 && this.rutD[i] < 0.05;
        if (ok) for (let a = 0; a <= 26; a += 2) if (this.featureHeight(wrap(s + a)) > 0.05) { ok = false; break; }
        if (ok) return wrap(s);
        s -= 2;
      }
      // nothing ideal: settle for flat ground
      s = s0;
      for (let k = 0; k < 60 && !this.isFlatAt(s); k++) s -= 2;
      return wrap(s);
    }

    // Is there a jump/obstacle near s? (used to choose a safe reset spot)
    isFlatAt(s) {
      for (let k = -8; k <= 8; k += 2) if (this.featureHeight(((s + k) % this.length + this.length) % this.length) > 0.15) return false;
      return true;
    }

    // ------------------------------------------------------ props & colliders
    _buildProps() {
      const def = this.def, env = def.env;
      const rnd = MX.rng(def.seed * 13 + 7);
      const props = this.props = { trees: [], rocks: [], bushes: [], hay: [], tuff: [], stakes: [], banners: [] };
      const q = {};
      const half = this.half;
      const clearOf = (x, z, extra) => {
        if (!this.query(x, z, q)) return true;
        return Math.abs(q.d) > this.w + this.blend + (extra || 0) + (this._lerpArr(this.bermH, q) > 0.05 ? 3 : 0);
      };
      // trees: clustered with noise
      const treeN = env.trees || 0;
      let tries = 0;
      while (props.trees.length < treeN && tries < treeN * 30) {
        tries++;
        const x = (rnd() * 2 - 1) * (half - 8), z = (rnd() * 2 - 1) * (half - 8);
        const dens = this.noise.noise(x / 90 + 40, z / 90 - 13) * 0.5 + 0.5;
        if (rnd() > dens * dens * 1.6 + 0.04) continue;
        if (!clearOf(x, z, 4)) continue;
        if (def.id === 'practice' && Math.abs(x) < 60 && Math.abs(z) < 55 && rnd() < 0.85) continue; // keep the open area open
        const type = rnd() < (def.id === 'outdoor' ? 0.55 : 0.35) ? 1 : 0; // 1 = pine
        const h = type ? 9 + rnd() * 9 : 7 + rnd() * 6;
        props.trees.push({ x, z, y: this.height(x, z), h, r: type ? 0.28 + h * 0.015 : 0.3 + h * 0.02, type, rot: rnd() * Math.PI * 2, tint: rnd() });
      }
      const rockN = env.rocks || 0;
      tries = 0;
      while (props.rocks.length < rockN && tries < rockN * 30) {
        tries++;
        const x = (rnd() * 2 - 1) * (half - 6), z = (rnd() * 2 - 1) * (half - 6);
        if (!clearOf(x, z, 1.5)) continue;
        const s = 0.3 + Math.pow(rnd(), 3) * 1.6;
        props.rocks.push({ x, z, y: this.height(x, z), s, rot: rnd() * 6.28, tilt: rnd() * 0.5 });
      }
      const bushN = env.bushes || 0;
      tries = 0;
      while (props.bushes.length < bushN && tries < bushN * 30) {
        tries++;
        const x = (rnd() * 2 - 1) * (half - 6), z = (rnd() * 2 - 1) * (half - 6);
        if (!clearOf(x, z, 0.8)) continue;
        props.bushes.push({ x, z, y: this.height(x, z), s: 0.5 + rnd() * 0.9, rot: rnd() * 6.28, tint: rnd() });
      }
      // track-side stakes with tape, every ~7 m on both sides
      if (env.stakes) {
        for (let s = 0; s < this.length; s += 7) {
          const p = this.pointAt(s);
          const i = Math.floor(s / DS) % this.n;
          const bh = this.bermH[i];
          for (const side of [-1, 1]) {
            const outside = bh > 0.05 && side === -this.bermSide[i];
            const dd = side * (this.w + 1.2 + (outside ? 1.6 + 1.3 * bh : 0));
            if ((side > 0 && Math.abs(dd) > this.extL[i] - 0.5) || (side < 0 && Math.abs(dd) > this.extR[i] - 0.5)) continue;
            const x = p.x + p.tz * dd, z = p.z - p.tx * dd;
            if (this.query(x, z, q) && Math.abs(q.s - s) > 4 && Math.abs(q.s - s) < this.length - 4) continue;
            props.stakes.push({ x, z, y: this.height(x, z), s, side });
          }
        }
      }
      // hay bales on the outside of sharp turns (behind the berm)
      if (env.hay) {
        for (let k = 0; k < this.segments.length; k++) {
          const g = this.segments[k];
          if (g[0] !== 'T' || Math.abs(g[2]) < 80) continue;
          const o = g[3] || {};
          const len = Math.abs(g[2] * Math.PI / 180) * g[1];
          const side = -Math.sign(g[2]);
          for (let u = len * 0.15; u < len * 0.85; u += 1.6) {
            const s = this.segStart[k] + u;
            const p = this.pointAt(s);
            const dd = side * (this.w + 2.6 + 1.3 * (o.berm || 0) + 1.8);
            const x = p.x + p.tz * dd, z = p.z - p.tx * dd;
            props.hay.push({ x, z, y: this.height(x, z), rot: p.heading });
          }
        }
      }
      // supercross tuff blocks along both sides of the straights
      if (env.tuffBlocks) {
        for (let k = 0; k < this.segments.length; k++) {
          const g = this.segments[k];
          if (g[0] !== 'S' || g[1] < 20) continue;
          for (let u = 6; u < g[1] - 6; u += 1.25) {
            const s = this.segStart[k] + u;
            const p = this.pointAt(s);
            for (const side of [-1, 1]) {
              const dd = side * (this.w + 1.55);
              const x = p.x + p.tz * dd, z = p.z - p.tx * dd;
              let ok = true;
              if (this.query(x, z, q) && (Math.abs(q.d) < this.w + 0.9)) ok = false;
              if (ok) props.tuff.push({ x, z, y: 0, rot: p.heading, s });
            }
          }
        }
      }
      // banners near the finish line and on a few straights
      if (env.banners) {
        const fs = this.finishS;
        props.banners.push({ s: fs, finish: true });
      }
      // colliders
      const circles = [];
      for (const t of props.trees) circles.push({ x: t.x, z: t.z, y: t.y, r: t.r + 0.05, h: t.h, kind: 'tree' });
      for (const r of props.rocks) if (r.s > 0.6) circles.push({ x: r.x, z: r.z, y: r.y, r: r.s * 0.8, h: r.s * 0.7, kind: 'rock' });
      const boxes = [];
      for (const b of props.hay) boxes.push({ x: b.x, z: b.z, hx: 0.42, hz: 0.6, h: 0.5, rot: b.rot, kind: 'hay', y: b.y });
      for (const b of props.tuff) boxes.push({ x: b.x, z: b.z, hx: 0.3, hz: 0.6, h: 0.6, rot: b.rot, kind: 'tuff', y: 0 });
      this.colliders = { circles, boxes };
      // collider hash (cell 8 m)
      this.cHash = new Map();
      const addC = (o, rad) => {
        const c0 = Math.floor((o.x - rad) / 8), c1 = Math.floor((o.x + rad) / 8);
        const r0 = Math.floor((o.z - rad) / 8), r1 = Math.floor((o.z + rad) / 8);
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          const key = r * 4096 + c;
          let l = this.cHash.get(key); if (!l) { l = []; this.cHash.set(key, l); }
          l.push(o);
        }
      };
      for (const o of circles) addC(o, o.r + 1);
      for (const o of boxes) addC(o, 1.5);
      if (def.stadium) {
        const m = def.stadium.margin || 12, b = this.bbox;
        this.walls = { x0: b.minx - m, x1: b.maxx + m, z0: b.minz - m, z1: b.maxz + m, stadium: true };
      } else this.walls = { x0: -half + 2, x1: half - 2, z0: -half + 2, z1: half - 2, stadium: false };
    }

    collidersNear(x, z) {
      return this.cHash.get(Math.floor(z / 8) * 4096 + Math.floor(x / 8)) || null;
    }
  }

  MX.Track = Track;
  MX.safeResetS = (track, s) => track.safeResetS(s);
  MX.TRACK_DS = DS;
  MX.buildTrackFeature = buildFeature;
})(typeof window !== 'undefined' ? window : globalThis);

/* =====================================================================
   ROOST MX - world rendering: sky, light, terrain + track meshes, props.

   The terrain is a coarse grid; the track corridor is a fine "ribbon"
   mesh following the centerline. Both sample Track.height(), the same
   function the physics uses. Grid vertices hidden under the ribbon are
   pushed down so they never poke through it.
   ===================================================================== */
MX.module('world', function (THREE, MX) {
  'use strict';
  const { clamp, lerp, smoothstep } = MX;
  const V = THREE.Vector3;

  // --------------------------------------------------------- textures
  function noiseTexture(size, seed, painter) {
    const cv = document.createElement('canvas'); cv.width = cv.height = size;
    const g = cv.getContext('2d');
    const img = g.createImageData(size, size);
    const n = new MX.Simplex(seed);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // tileable: sample on a torus
      const a = u * Math.PI * 2, b = v * Math.PI * 2;
      const nx = Math.cos(a), ny = Math.sin(a), nz = Math.cos(b), nw = Math.sin(b);
      const f = (fr) => (n.noise(nx * fr + nz * fr * 0.7, ny * fr + nw * fr * 1.3) + n.noise(nz * fr + 3.1, nw * fr - nx * fr * 0.5)) * 0.5;
      const rgb = painter(f, u, v);
      const i = (y * size + x) * 4;
      img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2]; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    t.generateMipmaps = true;
    return t;
  }
  let _texCache = null;
  function groundTextures() {
    if (_texCache) return _texCache;
    const grass = noiseTexture(256, 11, (f) => {
      const a = f(3), b = f(13), c = f(40);
      const k = 0.78 + a * 0.12 + b * 0.1 + c * 0.12;
      return [200 * k * 0.92, 225 * k, 190 * k * 0.85].map((v) => clamp(v, 0, 255));
    });
    const dirt = noiseTexture(256, 23, (f) => {
      const a = f(2.5), b = f(9), c = f(34);
      let k = 0.8 + a * 0.1 + b * 0.12 + c * 0.16;
      if (c > 0.42) k += 0.14;   // pebbles / clods catching light
      if (b < -0.45) k -= 0.12;
      return [235 * k, 222 * k, 205 * k].map((v) => clamp(v, 0, 255));
    });
    _texCache = { grass, dirt };
    return _texCache;
  }

  // Standard material with world-space grass/dirt blending driven by the
  // 'aMix' vertex attribute (0 grass … 1 dirt), plus vertex colour tint.
  // The ground covers most of the screen, so its shader is the biggest GPU
  // cost: on LOW it is plain Lambert (same diffuse lighting, no specular).
  function groundMaterial(q) {
    const tex = groundTextures();
    const aniso = q.level >= 3 ? 16 : q.level >= 2 ? 8 : q.level >= 1 ? 4 : 2;
    for (const t of [tex.grass, tex.dirt]) if (t.anisotropy !== aniso) { t.anisotropy = aniso; t.needsUpdate = true; }
    const mat = q.level === 0
      ? new THREE.MeshLambertMaterial({ vertexColors: true })
      : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0.0 });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.tGrass = { value: tex.grass };
      sh.uniforms.tDirt = { value: tex.dirt };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aMix;\nvarying float vMix;\nvarying vec2 vWXZ;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMix = aMix;\nvec4 wpos_ = modelMatrix * vec4(position, 1.0);\nvWXZ = wpos_.xz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D tGrass;\nuniform sampler2D tDirt;\nvarying float vMix;\nvarying vec2 vWXZ;')
        .replace('#include <map_fragment>', `
          vec3 g1 = texture2D(tGrass, vWXZ * 0.21).rgb;
          vec3 g2 = texture2D(tGrass, vWXZ * 0.047 + 0.31).rgb;
          vec3 d1 = texture2D(tDirt, vWXZ * 0.29).rgb;
          vec3 d2 = texture2D(tDirt, vWXZ * 0.061 + 0.57).rgb;
          vec3 gt = g1 * (0.65 + 0.35 * g2);
          vec3 dt = d1 * (0.7 + 0.3 * d2);
          diffuseColor.rgb *= mix(gt, dt, clamp(vMix, 0.0, 1.0)) * 1.18;`);
    };
    mat.customProgramCacheKey = () => 'mxground' + (q.level === 0 ? 'L' : 'S');
    return mat;
  }

  // --------------------------------------------------------- sky
  function makeSky(env) {
    const night = env.sky === 'night';
    const evening = env.sky === 'evening';
    const top = new THREE.Color(night ? '#03050c' : evening ? '#3a6fae' : '#2f6fd1');
    const hor = new THREE.Color(night ? '#141a2e' : evening ? '#f2c08a' : '#bcd7ee');
    const bot = new THREE.Color(night ? '#06080d' : evening ? '#6b5a4a' : '#8aa3b5');
    const sunCol = new THREE.Color(night ? '#000000' : evening ? '#ffb070' : '#fff3d6');
    const el = MX.rad(env.sunElev), az = MX.rad(env.sunAzim);
    const sunDir = new V(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: top }, hor: { value: hor }, bot: { value: bot }, sunDir: { value: sunDir }, sunCol: { value: sunCol }, cloud: { value: night ? 0.0 : evening ? 0.55 : 0.45 }, time: { value: 0 } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
      fragmentShader: `
        uniform vec3 top, hor, bot, sunDir, sunCol; uniform float cloud; uniform float time;
        varying vec3 vDir;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
        float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
        void main(){
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = mix(hor, top, pow(clamp(h, 0.0, 1.0), 0.55));
          col = mix(col, bot, smoothstep(0.0, -0.25, h));
          float s = max(dot(d, sunDir), 0.0);
          col += sunCol * (pow(s, 900.0) * 6.0 + pow(s, 18.0) * 0.35 + pow(s, 3.0) * 0.08);
          if (cloud > 0.0 && h > 0.0) {
            vec2 uv = d.xz / (h + 0.12) * 1.6 + vec2(time * 0.004, 0.0);
            float c = smoothstep(0.48, 0.8, fbm(uv));
            vec3 cc = mix(vec3(1.0), hor * 1.05, 0.25) * (0.85 + 0.25 * s);
            col = mix(col, cc, c * cloud * smoothstep(0.0, 0.12, h));
          }
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
    sky.scale.setScalar(3000);
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    sky.userData.sunDir = sunDir;
    if (night) {
      const n = 900, pos = new Float32Array(n * 3), rnd = MX.rng(77);
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2, y = 0.08 + rnd() * 0.92, r = Math.sqrt(1 - y * y);
        pos[i * 3] = Math.cos(a) * r * 0.99; pos[i * 3 + 1] = y * 0.99; pos[i * 3 + 2] = Math.sin(a) * r * 0.99;
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const stars = new THREE.Points(g, new THREE.PointsMaterial({ color: '#cfd8ff', size: 1.6, sizeAttenuation: false, fog: false, depthWrite: false }));
      stars.frustumCulled = false;
      sky.add(stars);
    }
    return sky;
  }

  // --------------------------------------------------------- LOD patches
  // Draw order for opaque objects (front to back cuts overdraw): the bike
  // first, then the track ribbon, props, terrain, and the sky last so only
  // the sky pixels left uncovered get shaded.
  const RO = { ribbon: 1, props: 2, terrain: 3, sky: 50 };

  // a, a+s, a+2s, … always ending exactly at b
  function stepRange(a, b, s) { const out = []; for (let v = a; v < b; v += s) out.push(v); out.push(b); return out; }

  // Smooth vertex normals of a regular grid (same result as
  // BufferGeometry.computeVertexNormals on the full grid; rows can wrap).
  function gridNormals(P, R, C, wrapRows) {
    const N = new Float32Array(P.length);
    const face = (a, b, c) => {
      const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
      const bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
      const cbx = P[c * 3] - bx, cby = P[c * 3 + 1] - by, cbz = P[c * 3 + 2] - bz;
      const abx = ax - bx, aby = ay - by, abz = az - bz;
      const nx = cby * abz - cbz * aby, ny = cbz * abx - cbx * abz, nz = cbx * aby - cby * abx;
      N[a * 3] += nx; N[a * 3 + 1] += ny; N[a * 3 + 2] += nz;
      N[b * 3] += nx; N[b * 3 + 1] += ny; N[b * 3 + 2] += nz;
      N[c * 3] += nx; N[c * 3 + 1] += ny; N[c * 3 + 2] += nz;
    };
    const RR = wrapRows ? R : R - 1;
    for (let r = 0; r < RR; r++) {
      const r2 = (r + 1) % R;
      for (let c = 0; c < C - 1; c++) {
        const a = r * C + c, b = a + 1, cc = r2 * C + c, d = cc + 1;
        face(a, cc, b); face(b, cc, d);
      }
    }
    for (let k = 0; k < N.length; k += 3) {
      const l = Math.hypot(N[k], N[k + 1], N[k + 2]);
      if (l > 0) { N[k] /= l; N[k + 1] /= l; N[k + 2] /= l; }
    }
    return N;
  }

  // One patch of a source grid (rows × columns picked from it) as a mesh
  // geometry, relative to `center`. Skirts (a strip hanging under every
  // edge) hide the cracks between neighbouring patches of different detail.
  function buildPatch(src, rows, cols, yOf, skirt, flip, center) {
    const R = rows.length, C = cols.length, S = src.stride, NR = src.rows;
    const nGrid = R * C, nSk = skirt > 0 ? 2 * (R + C) : 0, nv = nGrid + nSk;
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3), mix = new Float32Array(nv);
    const SP = src.pos, SN = src.nor, SC = src.col, SM = src.mix;
    let v = 0;
    for (let r = 0; r < R; r++) {
      const row = rows[r] % NR;
      for (let c = 0; c < C; c++, v++) {
        const k = row * S + cols[c];
        pos[v * 3] = SP[k * 3] - center.x; pos[v * 3 + 1] = yOf(k) - center.y; pos[v * 3 + 2] = SP[k * 3 + 2] - center.z;
        nor[v * 3] = SN[k * 3]; nor[v * 3 + 1] = SN[k * 3 + 1]; nor[v * 3 + 2] = SN[k * 3 + 2];
        col[v * 3] = SC[k * 3]; col[v * 3 + 1] = SC[k * 3 + 1]; col[v * 3 + 2] = SC[k * 3 + 2];
        mix[v] = SM[k];
      }
    }
    const nIdx = (R - 1) * (C - 1) * 6 + (nSk ? (2 * (C - 1) + 2 * (R - 1)) * 12 : 0);
    const idx = nv < 65536 ? new Uint16Array(nIdx) : new Uint32Array(nIdx);
    let o = 0;
    for (let r = 0; r < R - 1; r++) for (let c = 0; c < C - 1; c++) {
      const a = r * C + c, b = a + 1, cc = a + C, d = cc + 1;
      if (!flip) { idx[o++] = a; idx[o++] = cc; idx[o++] = b; idx[o++] = b; idx[o++] = cc; idx[o++] = d; }
      else { idx[o++] = a; idx[o++] = b; idx[o++] = cc; idx[o++] = b; idx[o++] = d; idx[o++] = cc; }
    }
    if (nSk) {
      let sv = nGrid;
      const edge = (ids) => {
        const base = sv;
        for (const g of ids) {
          pos[sv * 3] = pos[g * 3]; pos[sv * 3 + 1] = pos[g * 3 + 1] - skirt; pos[sv * 3 + 2] = pos[g * 3 + 2];
          nor[sv * 3] = nor[g * 3]; nor[sv * 3 + 1] = nor[g * 3 + 1]; nor[sv * 3 + 2] = nor[g * 3 + 2];
          col[sv * 3] = col[g * 3]; col[sv * 3 + 1] = col[g * 3 + 1]; col[sv * 3 + 2] = col[g * 3 + 2];
          mix[sv] = mix[g]; sv++;
        }
        for (let i = 0; i < ids.length - 1; i++) {
          const a = ids[i], b = ids[i + 1], a2 = base + i, b2 = base + i + 1;
          // both windings, so the skirt shows from whichever side the crack is seen
          idx[o++] = a; idx[o++] = b; idx[o++] = a2; idx[o++] = b; idx[o++] = b2; idx[o++] = a2;
          idx[o++] = a; idx[o++] = a2; idx[o++] = b; idx[o++] = b; idx[o++] = a2; idx[o++] = b2;
        }
      };
      const top = [], bot = [], left = [], right = [];
      for (let c = 0; c < C; c++) { bot.push(c); top.push((R - 1) * C + c); }
      for (let r = 0; r < R; r++) { left.push(r * C); right.push(r * C + C - 1); }
      edge(bot); edge(top); edge(left); edge(right);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aMix', new THREE.BufferAttribute(mix, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }

  // bounding-box centre of a window of a source grid
  function patchCenter(src, rows, cols, yOf, out) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    const S = src.stride, NR = src.rows, P = src.pos;
    for (const rr of rows) {
      const row = rr % NR;
      for (const c of cols) {
        const k = row * S + c, x = P[k * 3], y = yOf(k), z = P[k * 3 + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
    }
    return out.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  }

  // place a geometry: rotate (Euler), then translate
  function place(geo, x, y, z, rx, ry, rz, order) {
    if (rx || ry || rz) geo.applyMatrix4(_pm4.makeRotationFromEuler(_pe.set(rx || 0, ry || 0, rz || 0, order || 'XYZ')));
    geo.translate(x, y, z);
    return geo;
  }
  function scaleUV(geo, su, sv) {
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    return geo;
  }
  const _pm4 = new THREE.Matrix4(), _pe = new THREE.Euler();

  // --------------------------------------------------------- World
  class World {
    constructor(track, quality) {
      this.track = track;
      this.def = track.def;
      this.env = track.def.env;
      this.q = Object.assign({ level: 2, shadows: true, shadowSize: 2048, trees: 1, ribbonStep: 0.22, terrainCell: 2 }, quality || {});
      this.scene = new THREE.Scene();
      this.disposables = [];
      this.animated = [];
      this.casters = [];
      this._envColors();
      this._lights();
      this._sky();
      this._terrain();
      this._ribbon();
      this._props();
      this._landmarks();
      if (track.walls && track.walls.stadium) this._stadium();
      this._finalize();
    }

    _track(o) { this.disposables.push(o); return o; }

    _lights() {
      const env = this.env, night = env.sky === 'night';
      const scene = this.scene;
      scene.fog = new THREE.Fog(new THREE.Color(env.fogColor), env.fog[0], env.fog[1]);
      scene.background = new THREE.Color(env.fogColor);
      const hemi = new THREE.HemisphereLight(night ? '#6c7aa8' : '#cfe3ff', night ? '#2c2014' : '#6b5a3d', night ? 0.75 : 1.05);
      scene.add(hemi);
      const sun = this.sun = new THREE.DirectionalLight(night ? '#f4f6ff' : env.sky === 'evening' ? '#ffd2a0' : '#fff4e2', night ? 2.6 : env.sky === 'evening' ? 2.4 : 2.9);
      const el = MX.rad(env.sunElev), az = MX.rad(env.sunAzim);
      this.sunDir = new V(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
      sun.position.copy(this.sunDir).multiplyScalar(120);
      sun.castShadow = !!this.q.shadows;
      if (sun.castShadow) {
        sun.shadow.mapSize.set(this.q.shadowSize, this.q.shadowSize);
        const s = 34;
        Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 400 });
        sun.shadow.bias = -0.0004;
        sun.shadow.normalBias = 0.04;
      }
      scene.add(sun);
      scene.add(sun.target);
      if (night) {
        // stadium lights wash
        const fill = new THREE.DirectionalLight('#9fb6ff', 0.9);
        fill.position.set(-80, 60, -50);
        scene.add(fill);
      }
    }

    _sky() {
      this.sky = makeSky(this.env);
      this.sky.renderOrder = RO.sky;
      for (const c of this.sky.children) c.renderOrder = RO.sky + 1;   // stars go on top of the sky
      this.scene.add(this.sky);
    }

    _envColors() {
      const env = this.env;
      this._gA = new THREE.Color(env.grass); this._gB = new THREE.Color(env.grass2);
      this._dA = new THREE.Color(env.dirt); this._dB = new THREE.Color(env.dirt2);
    }

    // colour of a point (shared by terrain & ribbon so they match): the
    // colour is left in _cG, the grass/dirt texture mix is returned
    _ground(x, z, info) {
      const t = this.track;
      const n = t.noise.noise(x / 37, z / 37) * 0.5 + 0.5;
      const n2 = t.noise2.noise(x / 9, z / 9) * 0.5 + 0.5;
      const g = _cG.copy(this._gA).lerp(this._gB, n * 0.8 + n2 * 0.2);
      const dirt = _cF.copy(this._dA).lerp(this._dB, n2 * 0.6 + n * 0.3);
      const mix = info.dirt;
      if (info.onTrack) {
        // packed racing line is darker, loose dirt near the edges is lighter
        const line = Math.exp(-Math.pow(info.d / (t.w * 0.45), 2));
        dirt.multiplyScalar(1 - 0.08 * line);
        if (info.rut > 0.05) dirt.multiplyScalar(1 - 0.22 * info.rut);
      }
      // a touch of brown in worn grass at track edges
      if (mix > 0.05 && mix < 0.95) g.lerp(this._dA, 0.25);
      g.lerp(dirt, mix);
      return mix;
    }

    // Natural terrain: a grid cut into tiles, each with three levels of
    // detail (every 1st, 2nd or 4th vertex). Grid vertices hidden under the
    // track ribbon are pushed down so they never poke through it.
    _terrain() {
      const t = this.track;
      const half = t.half;
      let x0 = -half, x1 = half, z0 = -half, z1 = half;
      const stadium = !!(t.walls && t.walls.stadium);
      if (stadium) { x0 = t.walls.x0 - 2; x1 = t.walls.x1 + 2; z0 = t.walls.z0 - 2; z1 = t.walls.z1 + 2; }
      const cell = stadium ? 1.5 : this.q.terrainCell;
      const nx = Math.ceil((x1 - x0) / cell) + 1, nz = Math.ceil((z1 - z0) / cell) + 1, N = nx * nz;
      const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), mix = new Float32Array(N), under = new Float32Array(N);
      const info = {};
      for (let j = 0, k = 0; j < nz; j++) for (let i = 0; i < nx; i++, k++) {
        const x = x0 + i * cell, z = z0 + j * cell;
        pos[k * 3] = x; pos[k * 3 + 1] = t.height(x, z, info); pos[k * 3 + 2] = z;
        // distance inside the ribbon's outer edge (negative = under the ribbon)
        under[k] = info.qi >= 0 ? Math.abs(info.d) - (info.d > 0 ? t.extL[info.qi] : t.extR[info.qi]) : 1e9;
        mix[k] = this._ground(x, z, info);
        col[k * 3] = _cG.r; col[k * 3 + 1] = _cG.g; col[k * 3 + 2] = _cG.b;
      }
      // normals of the true surface (central differences)
      const nor = new Float32Array(N * 3);
      for (let j = 0, k = 0; j < nz; j++) for (let i = 0; i < nx; i++, k++) {
        const il = i > 0 ? k - 1 : k, ir = i < nx - 1 ? k + 1 : k;
        const jd = j > 0 ? k - nx : k, ju = j < nz - 1 ? k + nx : k;
        const ax = -(pos[ir * 3 + 1] - pos[il * 3 + 1]) / ((ir - il) * cell);
        const az = -(pos[ju * 3 + 1] - pos[jd * 3 + 1]) / (((ju - jd) / nx) * cell);
        const l = Math.sqrt(ax * ax + 1 + az * az);
        nor[k * 3] = ax / l; nor[k * 3 + 1] = 1 / l; nor[k * 3 + 2] = az / l;
      }
      const mat = this.groundMat = this._track(groundMaterial(this.q));
      const src = { pos, nor, col, mix, stride: nx, rows: nz };
      const T = Math.max(8, Math.round(96 / cell / 4) * 4);        // cells per tile (~96 m)
      const tileM = T * cell;
      const switchAt = [tileM * 1.15, tileM * 2.6];
      const heightAt = (s) => {
        const lim = -cell * s * 1.5;
        return (k) => { const u = under[k]; let h = pos[k * 3 + 1]; if (u < lim) h -= 1.5; else if (u < 0.5) h -= 0.04; return h; };
      };
      const y0f = heightAt(1);
      this.terrainTiles = [];
      for (let tj = 0; tj < nz - 1; tj += T) for (let ti = 0; ti < nx - 1; ti += T) {
        const i1 = Math.min(ti + T, nx - 1), j1 = Math.min(tj + T, nz - 1);
        const center = patchCenter(src, stepRange(tj, j1, 4), stepRange(ti, i1, 4), y0f, new V());
        const lod = new THREE.LOD();
        lod.position.copy(center);
        [1, 2, 4].forEach((s, L) => {
          const g = this._track(buildPatch(src, stepRange(tj, j1, s), stepRange(ti, i1, s), heightAt(s), 2.5, false, center));
          const m = new THREE.Mesh(g, mat);
          m.receiveShadow = true; m.renderOrder = RO.terrain;
          lod.addLevel(m, L ? switchAt[L - 1] : 0, 0.08);
        });
        this.scene.add(lod);
        this.terrainTiles.push(lod);
      }
    }

    // The track corridor: a fine "ribbon" mesh following the centerline,
    // cut into ~40 m chunks with three levels of detail (every 1st, 2nd or
    // 4th row; the columns stay the same, so neighbouring chunks never crack).
    _ribbon() {
      const t = this.track;
      const n = t.n, w = t.w;
      // lateral sample offsets: fine on the track, coarse outside
      const fine = this.q.ribbonStep;
      const offs = [];
      const core = w + 1.0;
      for (let d = -core; d <= core + 1e-6; d += fine) offs.push(d);
      const outer = [];
      for (let d = core + 0.6; d < t.rInf + 0.01; d += 0.75) outer.push(d);
      outer.push(t.rInf);
      const cols = [...outer.map((d) => -d).reverse(), ...offs, ...outer];
      const nc = cols.length;
      // rows: every centerline sample (0.5 m), every other one at low quality
      const rowStep = this.q.level <= 1 ? 2 : 1;
      const rows = Math.ceil(n / rowStep);
      const N = rows * nc;
      const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), mix = new Float32Array(N);
      const info = {};
      for (let r = 0, k = 0; r < rows; r++) {
        const i = (r * rowStep) % n;
        const px = t.px[i], pz = t.pz[i];
        const nxv = t.tz[i], nzv = -t.tx[i];       // left normal
        const eL = t.extL[i], eR = t.extR[i];
        for (let c = 0; c < nc; c++, k++) {
          let d = cols[c];
          if (d > eL) d = eL; if (d < -eR) d = -eR;
          const x = px + nxv * d, z = pz + nzv * d;
          pos[k * 3] = x; pos[k * 3 + 1] = t.height(x, z, info); pos[k * 3 + 2] = z;
          mix[k] = this._ground(x, z, info);
          col[k * 3] = _cG.r; col[k * 3 + 1] = _cG.g; col[k * 3 + 2] = _cG.b;
        }
      }
      // smooth normals over the whole loop, so chunk seams light identically
      const nor = gridNormals(pos, rows, nc, true);
      let up = 0;
      for (let k = 0; k < Math.min(N, 2000); k++) up += nor[k * 3 + 1];
      const flip = up < 0;                        // keep the faces pointing up
      if (flip) for (let k = 0; k < nor.length; k++) nor[k] = -nor[k];
      const mat = this._track(groundMaterial(this.q));
      mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -2;
      const src = { pos, nor, col, mix, stride: nc, rows };
      const yOf = (k) => pos[k * 3 + 1];
      const CH = Math.max(8, Math.round(40 / (MX.TRACK_DS * rowStep) / 4) * 4);
      const allCols = stepRange(0, nc - 1, 1);
      this.ribbonChunks = [];
      for (let r0 = 0; r0 < rows; r0 += CH) {
        const r1 = Math.min(r0 + CH, rows);      // row `rows` is row 0 again (closed loop)
        const center = patchCenter(src, stepRange(r0, r1, 2), allCols, yOf, new V());
        const lod = new THREE.LOD();
        lod.position.copy(center);
        [1, 2, 4].forEach((s, L) => {
          const g = this._track(buildPatch(src, stepRange(r0, r1, s), allCols, yOf, 0, flip, center));
          const m = new THREE.Mesh(g, mat);
          m.receiveShadow = true; m.renderOrder = RO.ribbon;
          lod.addLevel(m, L ? [65, 150][L - 1] : 0, 0.08);
        });
        this.scene.add(lod);
        this.ribbonChunks.push(lod);
      }
    }

    // --------------------------------------------------------- props
    _props() {
      const t = this.track, P = t.props, scene = this.scene, q = this.q;
      const shadows = !!q.shadows;
      const dummy = new THREE.Object3D();
      const treeFrac = clamp(q.trees, 0, 1);
      // ---- trees
      const pines = P.trees.filter((tr, i) => tr.type === 1 && (i % 10) < treeFrac * 10);
      const leafy = P.trees.filter((tr, i) => tr.type === 0 && (i % 10) < treeFrac * 10);
      const trunkMat = this._track(new THREE.MeshStandardMaterial({ color: '#5a4030', roughness: 0.95 }));
      const pineMat = this._track(new THREE.MeshStandardMaterial({ color: '#2f5a2e', roughness: 0.9, flatShading: true }));
      const leafMat = this._track(new THREE.MeshStandardMaterial({ color: '#4f7a33', roughness: 0.9, flatShading: true }));
      const mkInst = (geo, mat, list, placeIt, cast) => {
        if (!list.length) return null;
        const im = new THREE.InstancedMesh(geo, mat, list.length);
        const color = new THREE.Color();
        list.forEach((it, i) => { placeIt(dummy, it); dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix);
          if (it.tint !== undefined) { color.setHSL(0, 0, 0.82 + it.tint * 0.3); im.setColorAt(i, color); } });
        // shadows come from a proxy holding only the instances near the bike
        im.castShadow = false; im.receiveShadow = false;
        im.renderOrder = RO.props;
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.computeBoundingSphere();
        scene.add(im); this._track(geo);
        if (shadows && cast) this._addCaster(im);
        return im;
      };
      // trunk tops sit inside the foliage and bottoms in the ground: no caps
      const trunkG = new THREE.CylinderGeometry(0.12, 0.2, 1, 6, 1, true); trunkG.translate(0, 0.5, 0);
      const pineG = mergeCones();
      const leafG = new THREE.IcosahedronGeometry(1, 1);
      mkInst(trunkG, trunkMat, [...pines, ...leafy], (d, it) => { d.position.set(it.x, it.y - 0.2, it.z); d.rotation.set(0, it.rot, 0); d.scale.set(it.r * 4, it.h * (it.type ? 0.35 : 0.45), it.r * 4); }, true);
      mkInst(pineG, pineMat, pines, (d, it) => { d.position.set(it.x, it.y + it.h * 0.18, it.z); d.rotation.set(0, it.rot, 0); d.scale.set(it.h * 0.24, it.h * 0.85, it.h * 0.24); }, true);
      mkInst(leafG, leafMat, leafy, (d, it) => { d.position.set(it.x, it.y + it.h * 0.62, it.z); d.rotation.set(it.rot, it.rot * 0.7, 0); d.scale.set(it.h * 0.36, it.h * 0.32, it.h * 0.36); }, true);
      // ---- rocks & bushes
      const rockG = new THREE.DodecahedronGeometry(1, 0);
      const rockMat = this._track(new THREE.MeshStandardMaterial({ color: '#8b857c', roughness: 0.92, flatShading: true }));
      mkInst(rockG, rockMat, P.rocks, (d, it) => { d.position.set(it.x, it.y + it.s * 0.15, it.z); d.rotation.set(it.tilt, it.rot, it.tilt * 0.5); d.scale.set(it.s, it.s * 0.6, it.s * 0.85); }, true);
      const bushG = new THREE.IcosahedronGeometry(1, 0);
      const bushMat = this._track(new THREE.MeshStandardMaterial({ color: '#5b7a32', roughness: 0.95, flatShading: true }));
      mkInst(bushG, bushMat, P.bushes.filter((b, i) => (i % 10) < treeFrac * 10 + 2), (d, it) => { d.position.set(it.x, it.y + it.s * 0.3, it.z); d.rotation.set(0, it.rot, 0); d.scale.set(it.s, it.s * 0.65, it.s); }, false);
      // ---- hay bales
      const hayG = new THREE.BoxGeometry(0.84, 0.5, 1.2); hayG.translate(0, 0.25, 0);
      const hayMat = this._track(new THREE.MeshStandardMaterial({ color: '#d8bb6a', roughness: 1 }));
      mkInst(hayG, hayMat, P.hay, (d, it) => { d.position.set(it.x, it.y - 0.03, it.z); d.rotation.set(0, it.rot, 0); d.scale.set(1, 1, 1); }, true);
      // ---- tuff blocks (alternating colours)
      if (P.tuff.length) {
        const tg = new THREE.BoxGeometry(0.6, 0.6, 1.2); tg.translate(0, 0.3, 0);
        const tm = this._track(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.55 }));
        const im = new THREE.InstancedMesh(tg, tm, P.tuff.length);
        const ca = new THREE.Color('#e9edf2'), cb = new THREE.Color('#1f6bff');
        P.tuff.forEach((b, i) => {
          dummy.position.set(b.x, t.height(b.x, b.z) - 0.02, b.z); dummy.rotation.set(0, b.rot, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
          im.setMatrixAt(i, dummy.matrix); im.setColorAt(i, Math.floor(b.s / 1.25) % 2 ? ca : cb);
        });
        im.castShadow = false; im.receiveShadow = true; im.renderOrder = RO.props;
        im.computeBoundingSphere();
        scene.add(im); this._track(tg);
        if (shadows) this._addCaster(im);
      }
      // ---- stakes + tape
      if (P.stakes.length) {
        const sg = new THREE.CylinderGeometry(0.025, 0.025, 1.0, 5); sg.translate(0, 0.5, 0);
        const sm = this._track(new THREE.MeshStandardMaterial({ color: '#f2f2f2', roughness: 0.6 }));
        mkInst(sg, sm, P.stakes, (d, it) => { d.position.set(it.x, it.y, it.z); d.rotation.set(0, 0, 0); d.scale.set(1, 1, 1); }, false);
        // tape between consecutive stakes on the same side
        const tapes = [];
        for (const side of [-1, 1]) {
          const list = P.stakes.filter((s) => s.side === side).sort((a, b) => a.s - b.s);
          for (let i = 0; i < list.length; i++) {
            const a = list[i], b = list[(i + 1) % list.length];
            const dist = Math.hypot(b.x - a.x, b.z - a.z);
            if (dist > 12 || dist < 0.5) continue;
            tapes.push({ a, b, dist });
          }
        }
        const tg = new THREE.BoxGeometry(0.02, 0.05, 1);
        const tmat = this._track(new THREE.MeshStandardMaterial({ color: this.env.sky === 'evening' ? '#ff3b3b' : '#ffe14a', roughness: 0.6, emissive: '#221100' }));
        mkInst(tg, tmat, tapes, (d, it) => {
          d.position.set((it.a.x + it.b.x) / 2, (it.a.y + it.b.y) / 2 + 0.88, (it.a.z + it.b.z) / 2);
          d.rotation.set(0, Math.atan2(it.b.x - it.a.x, it.b.z - it.a.z), 0);
          d.rotateX(-Math.atan2(it.b.y - it.a.y, it.dist));
          d.scale.set(1, 1, it.dist);
        }, false);
      }
    }

    // A shadow-only copy of an instanced prop set. Every few metres it is
    // refilled with just the instances whose shadow can reach the shadow
    // map around the bike, instead of drawing thousands into it every frame.
    _addCaster(im) {
      const n = im.count, xs = new Float32Array(n), zs = new Float32Array(n), ls = new Float32Array(n);
      const geo = im.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const top = geo.boundingBox.max.y;
      const tanEl = Math.max(0.2, Math.tan(MX.rad(this.env.sunElev)));
      const e = _pm4.elements;
      for (let i = 0; i < n; i++) {
        im.getMatrixAt(i, _pm4);
        xs[i] = e[12]; zs[i] = e[14];
        const sy = Math.hypot(e[4], e[5], e[6]);
        const h = Math.max(0.5, e[13] + sy * top - this.track.height(e[12], e[14]));
        ls[i] = h / tanEl + 1;                     // shadow length on flat ground
      }
      if (!this._proxyMat) this._proxyMat = this._track(new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
      const proxy = new THREE.InstancedMesh(geo, this._proxyMat, n);
      proxy.count = 0;
      proxy.castShadow = true; proxy.receiveShadow = false;
      proxy.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(proxy);
      this.casters.push({ im, proxy, xs, zs, ls });
    }

    _updateCasters(focus) {
      if (!this.casters.length) return;
      const at = this._casterAt || (this._casterAt = { x: Infinity, z: Infinity });
      if (Math.hypot(focus.x - at.x, focus.z - at.z) < 6) return;
      at.x = focus.x; at.z = focus.z;
      const sl = Math.hypot(this.sunDir.x, this.sunDir.z) || 1;
      const dx = -this.sunDir.x / sl, dz = -this.sunDir.z / sl;   // shadows fall this way
      const R = 34 * Math.SQRT2 + 8, R2 = R * R;                   // shadow box half-diagonal + slack
      for (const c of this.casters) {
        const { im, proxy, xs, zs, ls } = c;
        const src = im.instanceMatrix.array, dst = proxy.instanceMatrix.array;
        let k = 0;
        for (let i = 0; i < xs.length; i++) {
          // distance from the focus to this instance's shadow (a segment on the ground)
          const px = focus.x - xs[i], pz = focus.z - zs[i];
          let s = px * dx + pz * dz;
          s = s < 0 ? 0 : s > ls[i] ? ls[i] : s;
          const ex = px - dx * s, ez = pz - dz * s;
          if (ex * ex + ez * ez > R2) continue;
          const a = i * 16, b = k * 16;
          for (let j = 0; j < 16; j++) dst[b + j] = src[a + j];
          k++;
        }
        proxy.count = k;
        proxy.instanceMatrix.clearUpdateRanges();
        proxy.instanceMatrix.addUpdateRange(0, Math.max(16, k * 16));
        proxy.instanceMatrix.needsUpdate = true;
        proxy.computeBoundingSphere();
      }
    }

    _landmarks() {
      const t = this.track, scene = this.scene;
      // finish line gantry + checkered strip
      const fp = t.pointAt(t.finishS);
      const span = t.w + 1.6;
      const postMat = this._track(new THREE.MeshStandardMaterial({ color: '#d9dde3', metalness: 0.6, roughness: 0.35 }));
      const check = MX.canvasTex(256, 64, (g, w, h) => { for (let y = 0; y < 2; y++) for (let x = 0; x < 16; x++) { g.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4'; g.fillRect(x * 16, y * 32, 16, 32); } });
      check.wrapS = THREE.RepeatWrapping;
      const bannerTex = MX.canvasTex(1024, 128, (g, w, h) => {
        g.fillStyle = '#111317'; g.fillRect(0, 0, w, h);
        for (let x = 0; x < w; x += 32) { g.fillStyle = (x / 32) % 2 ? '#f4f4f4' : '#111'; g.fillRect(x, 0, 32, 16); g.fillStyle = (x / 32) % 2 ? '#111' : '#f4f4f4'; g.fillRect(x, h - 16, 32, 16); }
        g.fillStyle = '#ff7a00'; g.font = 'italic 900 70px "Arial Black", Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('ROOST MX  ·  FINISH', w / 2, h / 2 + 2);
      });
      this._track(check); this._track(bannerTex);
      // gantry: posts + beam in one mesh, the two banner faces in another
      const hL = t.height(fp.x + fp.tz * span, fp.z - fp.tx * span), hR = t.height(fp.x - fp.tz * span, fp.z + fp.tx * span);
      const hTop = Math.max(hL, hR) + 4.6;
      const metal = [];
      for (const side of [1, -1]) {
        const px = fp.x + fp.tz * span * side, pz = fp.z - fp.tx * span * side;
        const hb = side > 0 ? hL : hR;
        metal.push(place(new THREE.CylinderGeometry(0.12, 0.14, hTop - hb, 10), px, (hTop + hb) / 2, pz));
      }
      const bw = span * 2 + 0.6;
      metal.push(place(new THREE.BoxGeometry(bw, 1.0, 0.12), fp.x, hTop - 0.3, fp.z, 0, fp.heading, 0));
      const gantry = new THREE.Mesh(this._track(MX.mergeGeometries(metal)), postMat);
      gantry.castShadow = true; gantry.renderOrder = RO.props;
      scene.add(gantry);
      const faceF = new THREE.PlaneGeometry(bw, 1.0); faceF.translate(0, 0, 0.061);
      const faceB = new THREE.PlaneGeometry(bw, 1.0); faceB.rotateY(Math.PI); faceB.translate(0, 0, -0.061);
      const faces = MX.mergeGeometries([faceF, faceB]);
      place(faces, fp.x, hTop - 0.3, fp.z, 0, fp.heading, 0);
      const banner = new THREE.Mesh(this._track(faces), this._track(new THREE.MeshStandardMaterial({ map: bannerTex, roughness: 0.6 })));
      banner.renderOrder = RO.props;
      scene.add(banner);
      // checkered strip on the ground (follows terrain)
      const segs = 24, wS = span * 2, depth = 1.2;
      const g = new THREE.PlaneGeometry(wS, depth, segs, 1);
      g.rotateX(-Math.PI / 2);
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const lx = pos.getX(i), lz = pos.getZ(i);
        // local x across the track (left normal), local z along
        const wx = fp.x + fp.tz * lx + fp.tx * lz, wz = fp.z - fp.tx * lx + fp.tz * lz;
        pos.setXYZ(i, wx, t.height(wx, wz) + 0.025, wz);
      }
      g.computeVertexNormals();
      const stripMat = this._track(new THREE.MeshStandardMaterial({ map: check, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
      check.repeat.set(1, 1);
      const strip = new THREE.Mesh(g, stripMat); strip.receiveShadow = true; strip.renderOrder = RO.ribbon;
      scene.add(strip);
      this._track(g);
      // start gate (SX) / start line
      if (t.gateS != null) {
        const gp = t.pointAt(t.gateS + 1.2);
        const gateMat = this._track(new THREE.MeshStandardMaterial({ color: '#c8ccd2', metalness: 0.7, roughness: 0.35 }));
        const n = 9;
        const ig = new THREE.BoxGeometry(0.75, 0.55, 0.06);
        const im = new THREE.InstancedMesh(ig, gateMat, n);
        const dmy = new THREE.Object3D();
        for (let i = 0; i < n; i++) {
          const lat = (i - (n - 1) / 2) * 0.85;
          const x = gp.x + gp.tz * lat, z = gp.z - gp.tx * lat;
          dmy.position.set(x, t.height(x, z) + 0.12, z); dmy.rotation.order = 'YXZ'; dmy.rotation.set(-1.25, gp.heading, 0); dmy.updateMatrix();
          im.setMatrixAt(i, dmy.matrix);
        }
        im.castShadow = true; im.renderOrder = RO.props; im.computeBoundingSphere();
        scene.add(im); this._track(ig);
        const beam = new THREE.Mesh(this._track(place(new THREE.BoxGeometry(n * 0.85 + 0.4, 0.12, 0.25), gp.x, t.height(gp.x, gp.z) + 0.06, gp.z, 0, gp.heading, 0)), gateMat);
        beam.renderOrder = RO.props;
        scene.add(beam);
      }
      // banners on poles along the straights (all banners one mesh, all poles another)
      const bTex = MX.canvasTex(512, 128, (g, w, h) => {
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#ff7a00'; g.fillRect(0, 0, w, 18); g.fillRect(0, h - 18, w, 18);
        g.fillStyle = '#121418'; g.font = 'italic 900 64px "Arial Black", Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('ROOST MX', w / 2, h / 2 + 2);
      });
      this._track(bTex);
      const bMat = this._track(new THREE.MeshStandardMaterial({ map: bTex, roughness: 0.7, side: THREE.DoubleSide }));
      const rnd = MX.rng(this.def.seed + 5);
      if (!t.walls.stadium) {
        const boards = [], poles = [];
        for (let s = 30; s < t.length; s += 70 + rnd() * 50) {
          const p = t.pointAt(s);
          const i = Math.floor(s / MX.TRACK_DS) % t.n;
          if (t.bermH[i] > 0.1 || t.featureHeight(s) > 0.05) continue;
          const side = rnd() < 0.5 ? 1 : -1;
          const dd = side * (t.w + 4.2);
          const x = p.x + p.tz * dd, z = p.z - p.tx * dd;
          const y = t.height(x, z);
          boards.push(place(new THREE.PlaneGeometry(4, 1), x, y + 1.3, z, 0, p.heading - side * Math.PI / 2, 0));   // face the track
          for (const e of [-1.9, 1.9]) poles.push(place(new THREE.CylinderGeometry(0.04, 0.04, 1.9, 6), x + p.tx * e, y + 0.95, z + p.tz * e));
        }
        if (boards.length) {
          const bm = new THREE.Mesh(this._track(MX.mergeGeometries(boards)), bMat); bm.renderOrder = RO.props; scene.add(bm);
          const pm = new THREE.Mesh(this._track(MX.mergeGeometries(poles)), postMat); pm.renderOrder = RO.props; scene.add(pm);
        }
      }
    }

    _stadium() {
      const W = this.track.walls, scene = this.scene;
      const wallMat = this._track(new THREE.MeshStandardMaterial({ color: '#1a1d24', roughness: 0.8 }));
      const adTex = MX.canvasTex(1024, 64, (g, w, h) => {
        const words = ['ROOST MX', 'DIRT SERIES', 'HOLESHOT', 'RACE FUEL', 'KNOBBY TIRE CO', 'MX OIL'];
        const cols = ['#ff7a00', '#1f6bff', '#e5262b', '#22b14c', '#ffd23f', '#ffffff'];
        for (let i = 0; i < 6; i++) {
          g.fillStyle = i % 2 ? '#111418' : '#f2f2f2'; g.fillRect(i * w / 6, 0, w / 6, h);
          g.fillStyle = cols[i]; g.font = 'italic 900 30px "Arial Black", Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(words[i], i * w / 6 + w / 12, h / 2);
        }
      });
      adTex.wrapS = THREE.RepeatWrapping;
      this._track(adTex);
      const adMat = this._track(new THREE.MeshStandardMaterial({ map: adTex, roughness: 0.6, emissive: '#ffffff', emissiveMap: adTex, emissiveIntensity: 0.25 }));
      const crowdTex = MX.canvasTex(512, 512, (g, w, h) => {
        g.fillStyle = '#20232b'; g.fillRect(0, 0, w, h);
        const rnd = MX.rng(9);
        for (let y = 0; y < h; y += 8) for (let x = 0; x < w; x += 7) {
          if (rnd() < 0.82) { g.fillStyle = `hsl(${Math.floor(rnd() * 360)},${30 + rnd() * 40}%,${25 + rnd() * 45}%)`; g.fillRect(x + rnd() * 2, y + rnd() * 2, 5, 6); }
        }
        g.fillStyle = 'rgba(0,0,0,0.35)'; for (let y = 0; y < h; y += 32) g.fillRect(0, y, w, 4);
      });
      crowdTex.wrapS = crowdTex.wrapT = THREE.RepeatWrapping;
      this._track(crowdTex);
      const crowdMat = this._track(new THREE.MeshStandardMaterial({ map: crowdTex, roughness: 0.9, emissive: '#ffffff', emissiveMap: crowdTex, emissiveIntensity: 0.12 }));
      const panelMat = this._track(new THREE.MeshBasicMaterial({ color: '#fffbe8' }));
      const sides = [
        { a: [W.x0, W.z0], b: [W.x1, W.z0] }, { a: [W.x1, W.z0], b: [W.x1, W.z1] },
        { a: [W.x1, W.z1], b: [W.x0, W.z1] }, { a: [W.x0, W.z1], b: [W.x0, W.z0] },
      ];
      // everything static and same-material is merged: one draw call per material
      const walls = [], ads = [], stands = [], panels = [];
      for (const sd of sides) {
        const dx = sd.b[0] - sd.a[0], dz = sd.b[1] - sd.a[1], len = Math.hypot(dx, dz);
        const ang = Math.atan2(dx, dz);
        const cx = (sd.a[0] + sd.b[0]) / 2, cz = (sd.a[1] + sd.b[1]) / 2;
        // outward normal
        const ox = dz / len, oz = -dx / len;
        walls.push(place(new THREE.BoxGeometry(0.4, 1.4, len + 0.4), cx + ox * 0.2, 0.7, cz + oz * 0.2, 0, ang, 0));
        ads.push(place(scaleUV(new THREE.PlaneGeometry(len, 0.9), Math.round(len / 18), 1), cx - ox * 0.01, 0.75, cz - oz * 0.01, 0, ang - Math.PI / 2, 0));
        // grandstand: tilted crowd slab rising away from the floor
        const depth = 34, rise = 22;
        stands.push(place(scaleUV(new THREE.PlaneGeometry(len + 40, Math.hypot(depth, rise)), Math.round((len + 40) / 12), 6),
          cx + ox * (6 + depth / 2), 2.5 + rise / 2, cz + oz * (6 + depth / 2), -Math.atan2(rise, depth), ang - Math.PI / 2, 0, 'YXZ'));
        // light towers
        for (const f of [0.2, 0.8]) {
          const lx = sd.a[0] + dx * f + ox * 4, lz = sd.a[1] + dz * f + oz * 4;
          walls.push(place(new THREE.CylinderGeometry(0.25, 0.35, 32, 8), lx, 16, lz));
          panels.push(place(new THREE.BoxGeometry(5, 2.2, 0.4), lx - ox * 0.4, 32.5, lz - oz * 0.4, 0.4, ang - Math.PI / 2, 0));
        }
      }
      // roof ring (dark) to close the stadium silhouette
      const ring = new THREE.TorusGeometry(Math.max(W.x1 - W.x0, W.z1 - W.z0) * 0.75, 3, 6, 48);
      ring.applyMatrix4(new THREE.Matrix4().compose(new V((W.x0 + W.x1) / 2, 34, (W.z0 + W.z1) / 2), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)), new V(1, 0.62, 1)));
      walls.push(ring);
      for (const [list, mat] of [[walls, wallMat], [ads, adMat], [stands, crowdMat], [panels, panelMat]]) {
        const m = new THREE.Mesh(this._track(MX.mergeGeometries(list)), mat);
        m.renderOrder = RO.props;
        scene.add(m);
      }
      // floor outside the walls (concrete)
      const fl = new THREE.Mesh(this._track(new THREE.PlaneGeometry(600, 600)), this._track(new THREE.MeshStandardMaterial({ color: '#2a2c31', roughness: 1 })));
      fl.rotation.x = -Math.PI / 2; fl.position.y = -0.3; fl.renderOrder = RO.terrain;
      this.scene.add(fl);
    }

    // Nothing in the world moves except the sun (it follows the bike) and
    // the sky (it follows the camera): freeze every other matrix.
    _finalize() {
      this.scene.traverse((o) => {
        if (o === this.scene || o === this.sky || o.isLight || o === this.sun.target) return;
        o.updateMatrix();
        o.matrixAutoUpdate = false;
      });
      this.scene.updateMatrixWorld(true);
    }

    // follow the focus point with the shadow camera (snapped to texels)
    update(dt, focus, camera) {
      if (this.sky) {
        this.sky.position.copy(camera.position);
        this.sky.material.uniforms.time.value += dt;
      }
      if (this.sun && focus) {
        const s = this.sun;
        const snap = (68 / (this.q.shadowSize || 2048));
        const fx = Math.round(focus.x / snap) * snap, fz = Math.round(focus.z / snap) * snap;
        s.target.position.set(fx, focus.y, fz);
        s.position.set(fx, focus.y, fz).addScaledVector(this.sunDir, 150);
        s.target.updateMatrixWorld();
        if (s.castShadow) this._updateCasters(focus);
      }
    }

    dispose() {
      for (const d of this.disposables) if (d && d.dispose) d.dispose();
      this.scene.traverse((o) => {
        if (o.isMesh || o.isPoints || o.isInstancedMesh) {
          if (o.geometry) o.geometry.dispose();
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) if (m && m.dispose) m.dispose();
        }
      });
    }
  }

  function mergeCones() {
    const parts = [];
    for (let i = 0; i < 3; i++) {
      const g = new THREE.ConeGeometry(1 - i * 0.22, 0.5, 7);
      g.translate(0, 0.25 + i * 0.25, 0);
      parts.push(g);
    }
    return MX.mergeGeometries(parts);
  }

  const _cF = new THREE.Color(), _cG = new THREE.Color();

  // --------------------------------------------------------- Showroom
  class Showroom {
    constructor() {
      const scene = this.scene = new THREE.Scene();
      scene.background = new THREE.Color('#0c0e13');
      scene.fog = new THREE.Fog('#0c0e13', 12, 34);
      const hemi = new THREE.HemisphereLight('#9fb4d8', '#1a140e', 0.7);
      scene.add(hemi);
      const key = this.key = new THREE.SpotLight('#fff1dc', 60, 30, 0.5, 0.65, 1.2);
      key.position.set(3, 7.5, 3.5);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.bias = -0.0005;
      scene.add(key); scene.add(key.target);
      const rim = new THREE.DirectionalLight('#ff8a3c', 1.1);
      rim.position.set(-5, 3, -6);
      scene.add(rim);
      const rim2 = new THREE.DirectionalLight('#5aa0ff', 1.2);
      rim2.position.set(6, 2, -4);
      scene.add(rim2);
      // floor & turntable
      const floorTex = MX.canvasTex(512, 512, (g, w, h) => {
        const grd = g.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w / 2);
        grd.addColorStop(0, '#2a2d34'); grd.addColorStop(1, '#0c0e13');
        g.fillStyle = grd; g.fillRect(0, 0, w, h);
        g.strokeStyle = 'rgba(255,255,255,0.04)';
        for (let i = 0; i < w; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, h); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(w, i); g.stroke(); }
      });
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.6, metalness: 0.2 }));
      floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
      scene.add(floor);
      const table = this.table = new THREE.Group();
      scene.add(table);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.2, 0.12, 64), new THREE.MeshStandardMaterial({ color: '#16181e', roughness: 0.7, metalness: 0.2 }));
      disc.position.y = 0.06; disc.receiveShadow = true;
      table.add(disc);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(2.15, 0.025, 8, 96), new THREE.MeshBasicMaterial({ color: '#ff7a00' }));
      ring.rotation.x = Math.PI / 2; ring.position.y = 0.125;
      table.add(ring);
      this.ring = ring;
      this.holder = new THREE.Group();
      this.holder.position.y = 0.12;
      table.add(this.holder);
      // backdrop: a curved wall with a soft vertical gradient and light strips
      const wallTex = MX.canvasTex(32, 256, (g, w, h) => {
        const grd = g.createLinearGradient(0, 0, 0, h);
        grd.addColorStop(0, '#07080b'); grd.addColorStop(0.55, '#141821'); grd.addColorStop(1, '#0b0d12');
        g.fillStyle = grd; g.fillRect(0, 0, w, h);
      });
      const wall = new THREE.Mesh(new THREE.CylinderGeometry(16, 16, 12, 64, 1, true, Math.PI * 0.55, Math.PI * 0.9), new THREE.MeshBasicMaterial({ map: wallTex, side: THREE.BackSide, fog: false }));
      wall.position.y = 5.5;
      scene.add(wall);
      for (let i = 0; i < 7; i++) {
        const a = Math.PI * (0.62 + i * 0.12);
        const strip = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 7), new THREE.MeshBasicMaterial({ color: i % 3 === 1 ? '#ff7a00' : '#2a3040', transparent: true, opacity: 0.8, fog: false }));
        strip.position.set(Math.sin(a) * 15.8, 4.5, Math.cos(a) * 15.8);
        strip.lookAt(0, 4.5, 0);
        scene.add(strip);
      }
      this.bike = null;
      this.spin = 0; this.spinVel = 0.25; this.dragging = false;
      this.camAngle = 0.6; this.camT = 0;
      this.mode = 'menu';
    }

    setBike(model) {
      if (this.bike) this.holder.remove(this.bike.root);
      this.bike = model;
      if (model) {
        // stand the bike on the turntable (wheels on the disc)
        model.root.position.set(0, 0.395, 0);
        this.holder.add(model.root);
      }
    }

    setAccent(color) { this.ring.material.color.set(color); }

    update(dt, camera) {
      this.camT += dt;
      if (!this.dragging) { this.spin += this.spinVel * dt; this.spinVel = lerp(this.spinVel, 0.22, 1 - Math.exp(-dt * 1.5)); }
      this.table.rotation.y = this.spin;
      const mode = this.mode;
      if (this.debugCam) { camera.position.copy(this.debugCam.pos); camera.lookAt(this.debugCam.look); return; }
      // animated background camera: slow orbit + bob; the bike sits right of the menus
      let dist = 4.7, height = 1.35, shift = 0.75;
      if (mode === 'garage') { dist = 4.0; height = 1.3; shift = 1.15; }
      if (mode === 'bikes') { dist = 4.6; height = 1.4; shift = 1.35; }
      const a = 0.62 + Math.sin(this.camT * 0.11) * 0.3;
      const pos = _sv1.set(Math.sin(a) * dist, height + Math.sin(this.camT * 0.23) * 0.12, Math.cos(a) * dist);
      // offset the look point to the camera's left so the bike appears on the right of the screen
      const right = _sv2.set(Math.cos(a), 0, -Math.sin(a));
      const look = _sv3.set(0, mode === 'menu' ? 0.5 : 0.72, 0).addScaledVector(right, -shift);
      pos.addScaledVector(right, -shift);
      camera.position.lerp(pos, 1 - Math.exp(-dt * 2.5));
      if (!this._look) this._look = look.clone();
      this._look.lerp(look, 1 - Math.exp(-dt * 3));
      camera.lookAt(this._look);
    }
  }

  const _sv1 = new V(), _sv2 = new V(), _sv3 = new V();
  MX.World = World;
  MX.Showroom = Showroom;
});

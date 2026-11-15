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
  function groundMaterial(q) {
    const tex = groundTextures();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0.0 });
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
    mat.customProgramCacheKey = () => 'mxground';
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
      this._lights();
      this._sky();
      this._terrain();
      this._ribbon();
      this._props();
      this._landmarks();
      if (track.walls && track.walls.stadium) this._stadium();
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
      this.scene.add(this.sky);
    }

    // colours for a point (shared by terrain & ribbon so they match)
    _ground(x, z, info, h) {
      const env = this.env, t = this.track;
      const n = t.noise.noise(x / 37, z / 37) * 0.5 + 0.5;
      const n2 = t.noise2.noise(x / 9, z / 9) * 0.5 + 0.5;
      const grassA = _cA.set(env.grass), grassB = _cB.set(env.grass2);
      const g = _cG.copy(grassA).lerp(grassB, n * 0.8 + n2 * 0.2);
      const dirtA = _cD.set(env.dirt), dirtB = _cE.set(env.dirt2);
      const dirt = _cF.copy(dirtA).lerp(dirtB, n2 * 0.6 + n * 0.3);
      let mix = info.dirt;
      if (info.onTrack && info.d !== undefined) {
        // packed racing line is darker, loose dirt near the edges is lighter
        const line = Math.exp(-Math.pow(info.d / (t.w * 0.45), 2));
        dirt.multiplyScalar(1 - 0.08 * line);
        if (info.rut > 0.05) dirt.multiplyScalar(1 - 0.22 * info.rut);
      }
      // a touch of brown in worn grass at track edges
      if (mix > 0.05 && mix < 0.95) g.lerp(dirtA, 0.25);
      return { color: g.lerp(dirt, mix), mix };
    }

    _terrain() {
      const t = this.track, def = this.def;
      const half = t.half;
      let x0 = -half, x1 = half, z0 = -half, z1 = half;
      if (t.walls && t.walls.stadium) { x0 = t.walls.x0 - 2; x1 = t.walls.x1 + 2; z0 = t.walls.z0 - 2; z1 = t.walls.z1 + 2; }
      const cell = t.walls && t.walls.stadium ? 1.5 : this.q.terrainCell;
      const nx = Math.ceil((x1 - x0) / cell) + 1, nz = Math.ceil((z1 - z0) / cell) + 1;
      const pos = new Float32Array(nx * nz * 3), col = new Float32Array(nx * nz * 3), mix = new Float32Array(nx * nz);
      const info = {}, q = {};
      const DS = MX.TRACK_DS;
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        const x = x0 + i * cell, z = z0 + j * cell;
        let h = t.height(x, z, info);
        // under the ribbon? push down (it's hidden there)
        if (t.query(x, z, q)) {
          const ext = q.d > 0 ? t.extL[q.i] : t.extR[q.i];
          if (Math.abs(q.d) < ext - cell * 1.5) h -= 1.5;
          else if (Math.abs(q.d) < ext + 0.5) h -= 0.04;
        }
        const k = j * nx + i;
        pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
        const gc = this._ground(x, z, info, h);
        col[k * 3] = gc.color.r; col[k * 3 + 1] = gc.color.g; col[k * 3 + 2] = gc.color.b;
        mix[k] = gc.mix;
      }
      const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
      let o = 0;
      for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        idx[o++] = a; idx[o++] = c; idx[o++] = b; idx[o++] = b; idx[o++] = c; idx[o++] = d;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aMix', new THREE.BufferAttribute(mix, 1));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeVertexNormals();
      const mat = this.groundMat = groundMaterial(this.q);
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      this.scene.add(m);
      this._track(g); this._track(mat);
      this.terrainMesh = m;
    }

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
      // rows: every centerline sample (0.5 m) — but keep it lighter on big tracks at low quality
      const rowStep = this.q.level <= 1 ? 2 : 1;
      const rows = Math.ceil(n / rowStep);
      const pos = new Float32Array(rows * nc * 3), col = new Float32Array(rows * nc * 3), mix = new Float32Array(rows * nc);
      const info = {};
      for (let r = 0; r < rows; r++) {
        const i = (r * rowStep) % n;
        const px = t.px[i], pz = t.pz[i];
        const nxv = t.tz[i], nzv = -t.tx[i];       // left normal
        const eL = t.extL[i], eR = t.extR[i];
        for (let c = 0; c < nc; c++) {
          let d = cols[c];
          if (d > eL) d = eL; if (d < -eR) d = -eR;
          const x = px + nxv * d, z = pz + nzv * d;
          const h = t.height(x, z, info);
          const k = r * nc + c;
          pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
          const gc = this._ground(x, z, info, h);
          // fade the outer edge colour into the terrain exactly
          col[k * 3] = gc.color.r; col[k * 3 + 1] = gc.color.g; col[k * 3 + 2] = gc.color.b;
          mix[k] = gc.mix;
        }
      }
      const idx = new Uint32Array(rows * (nc - 1) * 6);
      let o = 0;
      for (let r = 0; r < rows; r++) {
        const r2 = (r + 1) % rows;
        for (let c = 0; c < nc - 1; c++) {
          const a = r * nc + c, b = a + 1, cc = r2 * nc + c, d = cc + 1;
          // winding: rows advance along the track, columns go from right (-d) to left (+d)
          idx[o++] = a; idx[o++] = cc; idx[o++] = b; idx[o++] = b; idx[o++] = cc; idx[o++] = d;
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aMix', new THREE.BufferAttribute(mix, 1));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeVertexNormals();
      // make sure normals face up
      const nor = g.attributes.normal;
      let flip = 0;
      for (let k = 0; k < Math.min(nor.count, 2000); k++) flip += nor.getY(k);
      if (flip < 0) {
        for (let k = 0; k < idx.length; k += 3) { const tmp = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = tmp; }
        g.index.needsUpdate = true; g.computeVertexNormals();
      }
      const mat = groundMaterial(this.q);
      mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -2;
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      this.scene.add(m);
      this._track(g); this._track(mat);
      this.ribbonMesh = m;
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
      const mkInst = (geo, mat, list, place, cast) => {
        if (!list.length) return null;
        const im = new THREE.InstancedMesh(geo, mat, list.length);
        const color = new THREE.Color();
        list.forEach((it, i) => { place(dummy, it); dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix);
          if (it.tint !== undefined) { color.setHSL(0, 0, 0.82 + it.tint * 0.3); im.setColorAt(i, color); } });
        im.castShadow = shadows && cast; im.receiveShadow = false;
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        scene.add(im); this._track(geo);
        return im;
      };
      const trunkG = new THREE.CylinderGeometry(0.12, 0.2, 1, 6); trunkG.translate(0, 0.5, 0);
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
        im.castShadow = shadows; im.receiveShadow = true;
        scene.add(im); this._track(tg);
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
      const gantry = new THREE.Group();
      const hL = t.height(fp.x + fp.tz * span, fp.z - fp.tx * span), hR = t.height(fp.x - fp.tz * span, fp.z + fp.tx * span);
      const hTop = Math.max(hL, hR) + 4.6;
      for (const side of [1, -1]) {
        const px = fp.x + fp.tz * span * side, pz = fp.z - fp.tx * span * side;
        const hb = side > 0 ? hL : hR;
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, hTop - hb, 10), postMat);
        post.position.set(px, (hTop + hb) / 2, pz); post.castShadow = true;
        gantry.add(post);
      }
      const banner = new THREE.Mesh(new THREE.BoxGeometry(span * 2 + 0.6, 1.0, 0.12), [postMat, postMat, postMat, postMat, new THREE.MeshStandardMaterial({ map: bannerTex, roughness: 0.6 }), new THREE.MeshStandardMaterial({ map: bannerTex, roughness: 0.6 })]);
      banner.position.set(fp.x, hTop - 0.3, fp.z);
      banner.rotation.y = fp.heading;
      banner.castShadow = true;
      gantry.add(banner);
      scene.add(gantry);
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
      const strip = new THREE.Mesh(g, stripMat); strip.receiveShadow = true;
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
        im.castShadow = true; scene.add(im); this._track(ig);
        const beam = new THREE.Mesh(new THREE.BoxGeometry(n * 0.85 + 0.4, 0.12, 0.25), gateMat);
        beam.position.set(gp.x, t.height(gp.x, gp.z) + 0.06, gp.z); beam.rotation.y = gp.heading;
        scene.add(beam);
      }
      // banners on poles along the straights
      const bTex = MX.canvasTex(512, 128, (g, w, h) => {
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#ff7a00'; g.fillRect(0, 0, w, 18); g.fillRect(0, h - 18, w, 18);
        g.fillStyle = '#121418'; g.font = 'italic 900 64px "Arial Black", Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('ROOST MX', w / 2, h / 2 + 2);
      });
      this._track(bTex);
      const bMat = this._track(new THREE.MeshStandardMaterial({ map: bTex, roughness: 0.7, side: THREE.DoubleSide }));
      const bG = new THREE.PlaneGeometry(4, 1);
      this._track(bG);
      const rnd = MX.rng(this.def.seed + 5);
      if (!t.walls.stadium) {
        for (let s = 30; s < t.length; s += 70 + rnd() * 50) {
          const p = t.pointAt(s);
          const i = Math.floor(s / MX.TRACK_DS) % t.n;
          if (t.bermH[i] > 0.1 || t.featureHeight(s) > 0.05) continue;
          const side = rnd() < 0.5 ? 1 : -1;
          const dd = side * (t.w + 4.2);
          const x = p.x + p.tz * dd, z = p.z - p.tx * dd;
          const y = t.height(x, z);
          const b = new THREE.Mesh(bG, bMat);
          b.position.set(x, y + 1.3, z); b.rotation.y = p.heading - side * Math.PI / 2;   // face the track
          scene.add(b);
          for (const e of [-1.9, 1.9]) {
            const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.9, 6), postMat);
            pole.position.set(x + p.tx * e, y + 0.95, z + p.tz * e);
            scene.add(pole);
          }
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
      const sides = [
        { a: [W.x0, W.z0], b: [W.x1, W.z0] }, { a: [W.x1, W.z0], b: [W.x1, W.z1] },
        { a: [W.x1, W.z1], b: [W.x0, W.z1] }, { a: [W.x0, W.z1], b: [W.x0, W.z0] },
      ];
      for (const sd of sides) {
        const dx = sd.b[0] - sd.a[0], dz = sd.b[1] - sd.a[1], len = Math.hypot(dx, dz);
        const ang = Math.atan2(dx, dz);
        const cx = (sd.a[0] + sd.b[0]) / 2, cz = (sd.a[1] + sd.b[1]) / 2;
        // outward normal
        const ox = dz / len, oz = -dx / len;
        const wall = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.4, len + 0.4), wallMat);
        wall.position.set(cx + ox * 0.2, 0.7, cz + oz * 0.2); wall.rotation.y = ang;
        scene.add(wall);
        const ad = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.9), adMat);
        adTex.repeat.set(Math.round(len / 18), 1);
        ad.position.set(cx - ox * 0.01, 0.75, cz - oz * 0.01); ad.rotation.y = ang - Math.PI / 2;
        scene.add(ad);
        // grandstand: tilted crowd slab rising away from the floor
        const depth = 34, rise = 22;
        const stand = new THREE.Mesh(new THREE.PlaneGeometry(len + 40, Math.hypot(depth, rise)), crowdMat);
        crowdTex.repeat.set(Math.round((len + 40) / 12), 6);
        stand.position.set(cx + ox * (6 + depth / 2), 2.5 + rise / 2, cz + oz * (6 + depth / 2));
        stand.rotation.order = 'YXZ';
        stand.rotation.y = ang - Math.PI / 2;
        stand.rotation.x = -Math.atan2(rise, depth);
        scene.add(stand);
        // light towers
        for (const f of [0.2, 0.8]) {
          const lx = sd.a[0] + dx * f + ox * 4, lz = sd.a[1] + dz * f + oz * 4;
          const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, 32, 8), wallMat);
          pole.position.set(lx, 16, lz); scene.add(pole);
          const panel = new THREE.Mesh(new THREE.BoxGeometry(5, 2.2, 0.4), new THREE.MeshBasicMaterial({ color: '#fffbe8' }));
          panel.position.set(lx - ox * 0.4, 32.5, lz - oz * 0.4); panel.rotation.y = ang - Math.PI / 2; panel.rotation.x = 0.4;
          scene.add(panel);
        }
      }
      // floor outside the walls (concrete)
      const fl = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), this._track(new THREE.MeshStandardMaterial({ color: '#2a2c31', roughness: 1 })));
      fl.rotation.x = -Math.PI / 2; fl.position.y = -0.3;
      this.scene.add(fl);
      // roof ring (dark) to close the stadium silhouette
      const ring = new THREE.Mesh(new THREE.TorusGeometry(Math.max(W.x1 - W.x0, W.z1 - W.z0) * 0.75, 3, 6, 48), wallMat);
      ring.rotation.x = Math.PI / 2; ring.position.set((W.x0 + W.x1) / 2, 34, (W.z0 + W.z1) / 2); ring.scale.set(1, 0.62, 1);
      scene.add(ring);
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

  const _cA = new THREE.Color(), _cB = new THREE.Color(), _cD = new THREE.Color(), _cE = new THREE.Color(), _cF = new THREE.Color(), _cG = new THREE.Color();

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

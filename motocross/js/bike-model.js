/* =====================================================================
   ROOST MX - 3D motocross bike + rider built from Three.js geometry.

   Hierarchy (bike frame: +Z forward, +Y up, +X left, origin between
   the footpegs):
     root
      ├ chassis (frame, engine, exhaust, tank, shrouds, seat, fenders…)
      ├ steerPivot (on the raked steering axis) → steer (bars turn)
      │    └ forkSlider (fork lowers slide with compression) → front wheel
      ├ swingarm (rotates about its pivot) → rear wheel, chain
      ├ shock (stretched between frame and swingarm)
      └ rider (IK arms to the grips, legs to the pegs)
   ===================================================================== */
MX.module('bike-model', function (THREE, MX) {
  'use strict';
  const { clamp, lerp } = MX;
  const C = MX.CHASSIS;
  const V = THREE.Vector3;

  // --------------------------------------------------------------- helpers
  function mergeGeometries(list) {
    let nPos = 0, nIdx = 0;
    const prepared = list.map((g) => {
      if (!g.index) {
        const cnt = g.attributes.position.count;
        const idx = new Uint32Array(cnt);
        for (let i = 0; i < cnt; i++) idx[i] = i;
        g.setIndex(new THREE.BufferAttribute(idx, 1));
      }
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      if (!g.attributes.normal) g.computeVertexNormals();
      nPos += g.attributes.position.count; nIdx += g.index.count;
      return g;
    });
    const pos = new Float32Array(nPos * 3), nor = new Float32Array(nPos * 3), uv = new Float32Array(nPos * 2);
    const idx = new Uint32Array(nIdx);
    let po = 0, io = 0;
    for (const g of prepared) {
      pos.set(g.attributes.position.array, po * 3);
      nor.set(g.attributes.normal.array, po * 3);
      uv.set(g.attributes.uv.array, po * 2);
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + po;
      po += g.attributes.position.count; io += gi.length;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    out.computeBoundingSphere();
    return out;
  }
  MX.mergeGeometries = mergeGeometries;

  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new V(1, 1, 1);
  const UP = new V(0, 1, 0);
  function xf(geo, pos, rot, scl) {
    _q.setFromEuler(rot ? new THREE.Euler(rot[0], rot[1], rot[2]) : new THREE.Euler());
    _m4.compose(new V(pos[0], pos[1], pos[2]), _q, scl ? new V(scl[0], scl[1], scl[2]) : _s);
    return geo.applyMatrix4(_m4);
  }
  // cylinder between two points
  function rod(a, b, r, seg, rEnd) {
    const A = new V(...a), B = new V(...b);
    const d = new V().subVectors(B, A), len = d.length();
    const g = new THREE.CylinderGeometry(rEnd != null ? rEnd : r, r, len, seg || 8, 1);
    _q.setFromUnitVectors(UP, d.clone().normalize());
    _m4.compose(A.clone().add(B).multiplyScalar(0.5), _q, _s);
    return g.applyMatrix4(_m4);
  }
  // tube along points with radius function r(t)
  function tube(points, r, seg, radial, closed) {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new V(...p)), !!closed, 'centripetal');
    const g = new THREE.TubeGeometry(curve, seg || 32, typeof r === 'number' ? r : 0.03, radial || 8, !!closed);
    if (typeof r === 'function') {
      // scale every ring around its curve point
      const pos = g.attributes.position, rs = (radial || 8) + 1;
      const base = 0.03;
      for (let i = 0; i <= (seg || 32); i++) {
        const t = i / (seg || 32);
        const c = curve.getPointAt(t);
        const k = r(t) / base;
        for (let j = 0; j < rs; j++) {
          const vi = i * rs + j;
          pos.setXYZ(vi, c.x + (pos.getX(vi) - c.x) * k, c.y + (pos.getY(vi) - c.y) * k, c.z + (pos.getZ(vi) - c.z) * k);
        }
      }
      g.computeVertexNormals();
    }
    return g;
  }
  // extrude a side profile [z,y] along X (thickness), centred on x0
  function sideShape(pts, depth, x0, bevel) {
    const sh = new THREE.Shape();
    pts.forEach((p, i) => (i ? sh.lineTo(p[0], p[1]) : sh.moveTo(p[0], p[1])));
    sh.closePath();
    const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: !!bevel, bevelThickness: bevel || 0, bevelSize: bevel || 0, bevelSegments: 2, curveSegments: 6 });
    // shape coords: x->z, y->y ; extrusion along +z -> map to x
    const pos = g.attributes.position;
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (let i = 0; i < pos.count; i++) { minA = Math.min(minA, pos.getX(i)); maxA = Math.max(maxA, pos.getX(i)); minB = Math.min(minB, pos.getY(i)); maxB = Math.max(maxB, pos.getY(i)); }
    const uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const zz = pos.getX(i), yy = pos.getY(i), xx = pos.getZ(i);
      pos.setXYZ(i, x0 + xx - depth / 2, yy, zz);
      const u = (zz - minA) / (maxA - minA);
      uv.setXY(i, x0 > 0 ? 1 - u : u, (yy - minB) / (maxB - minB));
    }
    g.computeVertexNormals();
    return g;
  }

  // ------------------------------------------------------------ textures
  function canvasTex(w, h, draw) {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    draw(cv.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }
  function shade(hex, k) {
    const c = new THREE.Color(hex);
    c.offsetHSL(0, 0, k);
    return '#' + c.getHexString();
  }
  function graphicsTexture(look) {
    return canvasTex(512, 256, (g, w, h) => {
      const base = look.plastics, acc = look.graphicsColor || '#ffffff';
      g.fillStyle = base; g.fillRect(0, 0, w, h);
      const style = look.graphics || 'race';
      g.save();
      if (style === 'stripes') {
        g.fillStyle = acc;
        for (let i = -2; i < 6; i++) { g.beginPath(); g.moveTo(i * 120, h); g.lineTo(i * 120 + 50, h); g.lineTo(i * 120 + 190, 0); g.lineTo(i * 120 + 140, 0); g.fill(); }
      } else if (style === 'blocks') {
        g.fillStyle = acc; g.fillRect(0, h * 0.62, w, h * 0.38);
        g.fillStyle = shade(base, -0.18); g.fillRect(0, h * 0.55, w, h * 0.07);
      } else if (style === 'flames') {
        g.fillStyle = acc;
        for (let i = 0; i < 7; i++) {
          g.beginPath(); const y = h * (0.25 + i * 0.1);
          g.moveTo(0, y); g.bezierCurveTo(w * 0.3, y - 40, w * 0.45, y + 30, w * (0.65 + 0.05 * Math.sin(i)), y - 20 - i * 3);
          g.lineTo(w * 0.5, y + 12); g.bezierCurveTo(w * 0.3, y + 30, w * 0.2, y + 10, 0, y + 22); g.fill();
        }
      } else if (style === 'race') {
        g.fillStyle = acc;
        g.beginPath(); g.moveTo(0, h * 0.55); g.lineTo(w, h * 0.25); g.lineTo(w, h * 0.42); g.lineTo(0, h * 0.75); g.fill();
        g.fillStyle = shade(base, -0.22);
        g.beginPath(); g.moveTo(0, h * 0.8); g.lineTo(w, h * 0.5); g.lineTo(w, h); g.lineTo(0, h); g.fill();
      }
      if (style !== 'none') {
        g.fillStyle = 'rgba(255,255,255,0.92)';
        g.font = 'italic 900 64px "Arial Black", Impact, sans-serif';
        g.fillText('ROOST', w * 0.12, h * 0.42);
        g.font = 'bold 26px Arial, sans-serif';
        g.fillStyle = 'rgba(0,0,0,0.65)';
        g.fillText('RACING DEPT', w * 0.14, h * 0.55);
      }
      g.restore();
    });
  }
  function plateTexture(look) {
    return canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = look.plateBg || '#ffffff'; g.fillRect(0, 0, w, h);
      g.fillStyle = look.plateNum || '#111111';
      g.font = 'italic 900 150px "Arial Black", Impact, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(look.number || '27').slice(0, 3), w / 2, h * 0.56);
    });
  }
  function tireTexture() {
    return canvasTex(64, 256, (g, w, h) => {
      g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#2a2a2a';
      for (let y = 0; y < h; y += 16) { g.fillRect(4, y, 22, 9); g.fillRect(38, y + 8, 22, 9); }
    });
  }
  function jerseyTexture(look) {
    return canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = look.jersey; g.fillRect(0, 0, w, h);
      g.fillStyle = look.jersey2 || shade(look.jersey, -0.25);
      g.fillRect(0, h * 0.62, w, h * 0.1);
      g.beginPath(); g.moveTo(0, h * 0.2); g.lineTo(w, h * 0.45); g.lineTo(w, h * 0.55); g.lineTo(0, h * 0.3); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.font = 'italic 900 70px "Arial Black", Impact, sans-serif'; g.textAlign = 'center';
      g.fillText(String(look.number || '27').slice(0, 3), w / 2, h * 0.92);
    });
  }

  // ------------------------------------------------------------- default look
  MX.defaultLook = function () {
    return {
      plastics: '#ff7a00', graphicsColor: '#1a1a1a', graphics: 'race', frame: '#9aa0a8', seat: '#1b1d22',
      rims: '#202226', plateBg: '#ffffff', plateNum: '#111111', number: '27',
      jersey: '#ff7a00', jersey2: '#1a1a1a', pants: '#1b1d22', gloves: '#ff7a00', boots: '#e8e8e8',
      helmet: '#f2f2f2', helmetAccent: '#ff7a00', goggle: '#2b6cff',
    };
  };

  // ---------------------------------------------------------------- build
  class BikeModel {
    constructor(spec, look, opts) {
      this.spec = spec;
      this.look = Object.assign(MX.defaultLook(), look || {});
      this.opts = Object.assign({ rider: true, shadows: true, detail: 1 }, opts || {});
      this.root = new THREE.Group();
      this.root.name = 'bike';
      this.mats = {};
      this.textures = [];
      this._build();
      this.setRiderVisible(this.opts.rider);
    }

    _mat(key, params) {
      if (!this.mats[key]) this.mats[key] = new THREE.MeshStandardMaterial(params);
      return this.mats[key];
    }

    _materials() {
      const L = this.look;
      this.disposeTextures();
      const gtex = graphicsTexture(L), ptex = plateTexture(L), ttex = tireTexture(), jtex = jerseyTexture(L);
      this.textures.push(gtex, ptex, ttex, jtex);
      const M = {
        plastic: new THREE.MeshStandardMaterial({ color: L.plastics, roughness: 0.42, metalness: 0.0 }),
        graphics: new THREE.MeshStandardMaterial({ map: gtex, roughness: 0.38, metalness: 0.0 }),
        plate: new THREE.MeshStandardMaterial({ map: ptex, roughness: 0.45 }),
        frame: new THREE.MeshStandardMaterial({ color: L.frame, roughness: 0.35, metalness: 0.75 }),
        metal: new THREE.MeshStandardMaterial({ color: '#c7cbd1', roughness: 0.25, metalness: 0.9 }),
        dark: new THREE.MeshStandardMaterial({ color: '#23252a', roughness: 0.55, metalness: 0.45 }),
        black: new THREE.MeshStandardMaterial({ color: '#111214', roughness: 0.75, metalness: 0.1 }),
        engine: new THREE.MeshStandardMaterial({ color: '#8d939c', roughness: 0.38, metalness: 0.7 }),
        cylinder: new THREE.MeshStandardMaterial({ color: '#2a2c31', roughness: 0.5, metalness: 0.5 }),
        sprocket: new THREE.MeshStandardMaterial({ color: '#3d4047', roughness: 0.35, metalness: 0.8 }),
        gold: new THREE.MeshStandardMaterial({ color: '#c9a03a', roughness: 0.3, metalness: 0.85 }),
        seat: new THREE.MeshStandardMaterial({ color: L.seat, roughness: 0.8 }),
        rim: new THREE.MeshStandardMaterial({ color: L.rims, roughness: 0.3, metalness: 0.8 }),
        tire: new THREE.MeshStandardMaterial({ color: '#1c1c1c', roughness: 0.95, map: ttex }),
        knob: new THREE.MeshStandardMaterial({ color: '#202020', roughness: 0.9 }),
        exhaust: new THREE.MeshStandardMaterial({ color: this.spec.stroke === 2 ? '#3b3e44' : '#b9bcc2', roughness: 0.3, metalness: 0.85 }),
        silencer: new THREE.MeshStandardMaterial({ color: '#d4d6da', roughness: 0.35, metalness: 0.7 }),
        spring: new THREE.MeshStandardMaterial({ color: L.helmetAccent === '#ffd23f' ? '#ffd23f' : '#ffcf2a', roughness: 0.4, metalness: 0.5 }),
        chain: new THREE.MeshStandardMaterial({ color: '#4a4c50', roughness: 0.5, metalness: 0.8 }),
        radiator: new THREE.MeshStandardMaterial({ color: '#2d3036', roughness: 0.6, metalness: 0.5 }),
        jersey: new THREE.MeshStandardMaterial({ map: jtex, roughness: 0.85 }),
        jerseyArm: new THREE.MeshStandardMaterial({ color: L.jersey, roughness: 0.85 }),
        pants: new THREE.MeshStandardMaterial({ color: L.pants, roughness: 0.85 }),
        gloves: new THREE.MeshStandardMaterial({ color: L.gloves, roughness: 0.8 }),
        boots: new THREE.MeshStandardMaterial({ color: L.boots, roughness: 0.55, metalness: 0.05 }),
        helmet: new THREE.MeshStandardMaterial({ color: L.helmet, roughness: 0.25, metalness: 0.1 }),
        helmetAcc: new THREE.MeshStandardMaterial({ color: L.helmetAccent, roughness: 0.3, metalness: 0.1 }),
        goggle: new THREE.MeshStandardMaterial({ color: L.goggle, roughness: 0.1, metalness: 0.6 }),
        skinDark: new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.6 }),
      };
      return M;
    }

    disposeTextures() { for (const t of this.textures) t.dispose(); this.textures.length = 0; }

    _mesh(geo, mat, parent, cast) {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = this.opts.shadows && cast !== false;
      m.receiveShadow = false;
      (parent || this.chassis).add(m);
      return m;
    }

    _build() {
      const M = this.M = this._materials();
      const two = this.spec.stroke === 2;
      const root = this.root;
      const chassis = this.chassis = new THREE.Group();
      root.add(chassis);

      // ---------------- frame (perimeter, twin spars)
      const fr = [];
      for (const sx of [1, -1]) {
        fr.push(tube([[0, 0.66, 0.46], [sx * 0.09, 0.62, 0.36], [sx * 0.125, 0.52, 0.17], [sx * 0.125, 0.38, 0.02], [sx * 0.115, 0.22, -0.08], [sx * 0.105, 0.06, -0.09]], 0.026, 24, 8));
        fr.push(tube([[sx * 0.12, 0.47, 0.0], [sx * 0.115, 0.50, -0.25], [sx * 0.10, 0.50, -0.58]], 0.016, 12, 6));
        fr.push(tube([[sx * 0.11, 0.18, -0.10], [sx * 0.11, 0.33, -0.33], [sx * 0.10, 0.48, -0.55]], 0.014, 12, 6));
        fr.push(tube([[0, 0.42, 0.50], [sx * 0.03, 0.18, 0.43], [sx * 0.065, -0.06, 0.33], [sx * 0.07, -0.11, 0.12], [sx * 0.07, -0.08, -0.06], [sx * 0.10, 0.04, -0.10]], 0.019, 24, 6));
      }
      // head tube along the steering axis
      const ax = new V(0, Math.cos(C.rake), -Math.sin(C.rake));
      const H = new V(C.steerHead[0], C.steerHead[1], C.steerHead[2]);
      const ht0 = H.clone().addScaledVector(ax, -0.11), ht1 = H.clone().addScaledVector(ax, 0.08);
      fr.push(rod(ht0.toArray(), ht1.toArray(), 0.034, 14));
      // pivot plates
      for (const sx of [1, -1]) fr.push(xf(new THREE.BoxGeometry(0.03, 0.22, 0.12), [sx * 0.11, 0.12, -0.09]));
      this._mesh(mergeGeometries(fr), M.frame);

      // ---------------- engine
      const eng = [], cyl = [];
      eng.push(xf(new THREE.BoxGeometry(0.17, 0.22, 0.34), [0, 0.02, 0.08]));
      eng.push(xf(new THREE.CylinderGeometry(0.12, 0.12, 0.16, 20), [0, 0.02, 0.03], [0, 0, Math.PI / 2]));
      const cylTilt = -0.25;
      if (two) {
        cyl.push(xf(new THREE.CylinderGeometry(0.065, 0.075, 0.2, 16), [0, 0.24, 0.17], [cylTilt, 0, 0]));
        for (let i = 0; i < 6; i++) cyl.push(xf(new THREE.CylinderGeometry(0.095, 0.095, 0.008, 16), [0, 0.19 + i * 0.03, 0.155 + i * 0.008], [cylTilt, 0, 0]));
        eng.push(xf(new THREE.CylinderGeometry(0.045, 0.06, 0.06, 12), [0, 0.36, 0.20], [cylTilt, 0, 0]));
      } else {
        cyl.push(xf(new THREE.BoxGeometry(0.15, 0.18, 0.17), [0, 0.22, 0.16], [cylTilt, 0, 0]));
        eng.push(xf(new THREE.BoxGeometry(0.17, 0.09, 0.2), [0, 0.35, 0.19], [cylTilt, 0, 0]));
        for (let i = 0; i < 4; i++) cyl.push(xf(new THREE.BoxGeometry(0.18, 0.008, 0.19), [0, 0.15 + i * 0.035, 0.155], [cylTilt, 0, 0]));
      }
      this._mesh(mergeGeometries(eng), M.engine);
      this._mesh(mergeGeometries(cyl), M.cylinder);
      const covers = [];
      covers.push(xf(new THREE.CylinderGeometry(0.105, 0.11, 0.035, 24), [-0.1, 0.03, 0.06], [0, 0, Math.PI / 2]));
      covers.push(xf(new THREE.CylinderGeometry(0.085, 0.09, 0.03, 24), [0.1, 0.04, -0.01], [0, 0, Math.PI / 2]));
      this._mesh(mergeGeometries(covers), two ? M.dark : M.gold);
      // skid plate
      this._mesh(xf(new THREE.BoxGeometry(0.16, 0.012, 0.42), [0, -0.12, 0.13]), M.black);

      // ---------------- exhaust
      if (two) {
        // expansion chamber: fat, then thin, along the right side
        const pts = [[0, 0.30, 0.27], [-0.015, 0.20, 0.40], [-0.05, 0.02, 0.43], [-0.10, -0.08, 0.30], [-0.14, -0.04, 0.10], [-0.155, 0.10, -0.08], [-0.15, 0.27, -0.22]];
        this._mesh(tube(pts, (t) => 0.024 + 0.036 * Math.sin(Math.PI * Math.min(1, t * 1.25)) * (t < 0.85 ? 1 : 0.35) + 0.002, 48, 12), M.exhaust);
        this._mesh(rod([-0.15, 0.30, -0.25], [-0.15, 0.46, -0.66], 0.042, 14), M.silencer);
        this._mesh(rod([-0.15, 0.46, -0.66], [-0.15, 0.475, -0.70], 0.02, 10, 0.03), M.dark);
      } else {
        const pts = [[0, 0.31, 0.28], [-0.05, 0.27, 0.36], [-0.12, 0.18, 0.30], [-0.15, 0.18, 0.12], [-0.16, 0.26, -0.08], [-0.16, 0.35, -0.24]];
        this._mesh(tube(pts, 0.022, 40, 10), M.exhaust);
        this._mesh(rod([-0.165, 0.36, -0.26], [-0.16, 0.48, -0.70], 0.055, 16, 0.05), M.silencer);
        this._mesh(rod([-0.16, 0.48, -0.70], [-0.16, 0.49, -0.74], 0.028, 12), M.dark);
      }

      // ---------------- radiators, tank, airbox
      for (const sx of [1, -1]) this._mesh(xf(new THREE.BoxGeometry(0.045, 0.26, 0.19), [sx * 0.135, 0.36, 0.33], [0.2, 0, 0]), M.radiator);
      this._mesh(xf(new THREE.BoxGeometry(0.22, 0.13, 0.32), [0, 0.53, 0.2]), M.black);
      this._mesh(xf(new THREE.BoxGeometry(0.2, 0.18, 0.3), [0, 0.35, -0.3]), M.black);

      // ---------------- shrouds with graphics
      const shroud = [[0.47, 0.67], [0.30, 0.60], [0.06, 0.56], [0.10, 0.44], [0.24, 0.28], [0.40, 0.22], [0.46, 0.40]];
      for (const sx of [1, -1]) {
        const g = sideShape(shroud, 0.012, sx * 0.17, 0.006);
        this._mesh(g, M.graphics);
      }
      // tank cover / scoop between shrouds
      this._mesh(xf(new THREE.BoxGeometry(0.30, 0.03, 0.3), [0, 0.6, 0.27], [-0.14, 0, 0]), M.plastic);

      // ---------------- seat
      const seatP = [[0.24, 0.58], [0.10, 0.575], [-0.30, 0.545], [-0.62, 0.55], [-0.64, 0.50], [-0.30, 0.49], [0.05, 0.52], [0.22, 0.54]];
      this._mesh(sideShape(seatP, 0.21, 0, 0.025), M.seat);

      // ---------------- side panels (number plates) & rear fender
      const side = [[-0.05, 0.45], [-0.55, 0.52], [-0.58, 0.40], [-0.20, 0.20], [-0.04, 0.26]];
      for (const sx of [1, -1]) this._mesh(sideShape(side, 0.012, sx * 0.135, 0.006), M.plate);
      const fender = [[-0.40, 0.52], [-0.70, 0.555], [-0.98, 0.60], [-1.0, 0.585], [-0.72, 0.525], [-0.42, 0.49]];
      this._mesh(sideShape(fender, 0.24, 0, 0.01), M.plastic);
      // taillight-less MX fender has a small mud flap
      this._mesh(xf(new THREE.BoxGeometry(0.16, 0.10, 0.006), [0, 0.52, -0.62], [0.4, 0, 0]), M.black);

      // ---------------- footpegs, pedals
      for (const sx of [1, -1]) {
        this._mesh(xf(new THREE.BoxGeometry(0.09, 0.022, 0.055), [sx * 0.20, -0.005, 0.0]), M.metal);
        for (let i = 0; i < 3; i++) this._mesh(xf(new THREE.BoxGeometry(0.09, 0.008, 0.004), [sx * 0.20, 0.008, -0.02 + i * 0.02]), M.dark);
      }
      this._mesh(rod([-0.16, 0.0, 0.03], [-0.18, 0.02, 0.21], 0.008, 6), M.metal); // brake pedal
      this._mesh(rod([0.16, 0.06, 0.02], [0.18, 0.06, 0.18], 0.008, 6), M.metal);  // shifter

      // ---------------- steering assembly
      const steerPivot = this.steerPivot = new THREE.Group();
      steerPivot.position.copy(H);
      steerPivot.rotation.x = -C.rake;
      root.add(steerPivot);
      const steer = this.steer = new THREE.Group();
      steerPivot.add(steer);
      const off = C.forkOffset;
      // clamps
      this._mesh(xf(new THREE.BoxGeometry(0.25, 0.035, 0.085), [0, 0.07, off * 0.6]), M.metal, steer);
      this._mesh(xf(new THREE.BoxGeometry(0.25, 0.04, 0.09), [0, -0.13, off * 0.6]), M.metal, steer);
      // fork tubes (outer, upper)
      for (const sx of [1, -1]) this._mesh(rod([sx * 0.085, 0.10, off], [sx * 0.085, -0.46, off], 0.027, 14), M.dark, steer);
      // bars (tapered aluminium bar with bend)
      const barPts = [[0.40, 0.205, -0.085], [0.30, 0.19, -0.065], [0.17, 0.155, -0.025], [0.07, 0.14, -0.012], [-0.07, 0.14, -0.012], [-0.17, 0.155, -0.025], [-0.30, 0.19, -0.065], [-0.40, 0.205, -0.085]];
      this._mesh(tube(barPts, 0.0115, 32, 8), M.metal, steer);
      this._mesh(xf(new THREE.BoxGeometry(0.17, 0.04, 0.05), [0, 0.15, -0.012]), this._mat('pad', { color: this.look.helmetAccent, roughness: 0.7 }), steer);
      for (const sx of [1, -1]) {
        this._mesh(rod([sx * 0.31, 0.19, -0.067], [sx * 0.43, 0.208, -0.09], 0.017, 10), M.black, steer); // grips
        this._mesh(xf(new THREE.BoxGeometry(0.15, 0.012, 0.02), [sx * 0.30, 0.205, -0.03], [0, sx * 0.25, 0]), M.dark, steer); // levers
        this._mesh(rod([sx * 0.06, 0.07, 0.0], [sx * 0.06, 0.14, -0.012], 0.012, 8), M.metal, steer); // risers
      }
      // front number plate
      this._mesh(xf(new THREE.BoxGeometry(0.26, 0.24, 0.008), [0, 0.03, off + 0.075], [-0.25, 0, 0]), M.plate, steer);
      // front fender (mounted on the lower clamp)
      const ff = [[0.42, -0.21], [0.22, -0.16], [0.02, -0.15], [-0.18, -0.19], [-0.20, -0.215], [0.0, -0.18], [0.22, -0.19], [0.43, -0.235]];
      const ffg = sideShape(ff, 0.12, 0, 0.008);
      this._mesh(ffg, M.plastic, steer);
      // fork slider (moves with compression) + front wheel
      const slider = this.forkSlider = new THREE.Group();
      slider.position.set(0, -C.forkLenExt, off);
      steer.add(slider);
      for (const sx of [1, -1]) {
        this._mesh(rod([sx * 0.085, 0.0, 0], [sx * 0.085, 0.48, 0], 0.03, 14), M.gold, slider); // lowers (coated)
        this._mesh(rod([sx * 0.085, 0.05, 0.02], [sx * 0.085, 0.36, 0.02], 0.038, 10, 0.033), M.plastic, slider); // guards
        this._mesh(xf(new THREE.BoxGeometry(0.03, 0.06, 0.06), [sx * 0.085, 0.0, 0]), M.dark, slider);
      }
      this._mesh(rod([0.09, 0, 0], [-0.09, 0, 0], 0.012, 8), M.metal, slider); // axle
      this.frontWheel = this._wheel(C.wheelRadiusF, 0.04, 0.135, true);
      slider.add(this.frontWheel);

      // ---------------- swingarm + rear wheel
      const sw = this.swingarm = new THREE.Group();
      sw.position.set(C.swingPivot[0], C.swingPivot[1], C.swingPivot[2]);
      root.add(sw);
      const swg = [];
      for (const sx of [1, -1]) {
        swg.push(xf(new THREE.BoxGeometry(0.03, 0.065, 0.46), [sx * 0.105, 0.0, -0.27]));
        swg.push(xf(new THREE.BoxGeometry(0.03, 0.04, 0.12), [sx * 0.10, 0.0, -0.55]));
      }
      swg.push(xf(new THREE.BoxGeometry(0.21, 0.05, 0.06), [0, 0.0, -0.08]));
      swg.push(xf(new THREE.CylinderGeometry(0.03, 0.03, 0.26, 12), [0, 0, 0], [0, 0, Math.PI / 2]));
      this._mesh(mergeGeometries(swg), M.frame, sw);
      // chain & sprockets (left side)
      const sl = C.swingLen;
      const ch = [];
      ch.push(rod([0.112, 0.045, 0.07], [0.112, 0.105, -sl], 0.006, 4));
      ch.push(rod([0.112, -0.045, 0.07], [0.112, -0.105, -sl], 0.006, 4));
      this._mesh(mergeGeometries(ch), M.chain, sw);
      this._mesh(xf(new THREE.CylinderGeometry(0.1, 0.1, 0.006, 28), [0.112, 0, -sl], [0, 0, Math.PI / 2]), M.sprocket, sw);
      this._mesh(xf(new THREE.BoxGeometry(0.012, 0.025, 0.18), [0.115, -0.07, -0.17]), M.black, sw); // chain guide
      this.rearWheel = this._wheel(C.wheelRadiusR, 0.055, 0.12, false);
      this.rearWheel.position.set(0, 0, -sl);
      sw.add(this.rearWheel);

      // ---------------- shock
      const shock = this.shock = new THREE.Group();
      root.add(shock);
      this.shockTop = new V(0, 0.43, -0.07);
      this.shockLen0 = 0.42;
      const body = this._mesh(rod([0, 0.42, 0], [0, 0.22, 0], 0.028, 12), M.dark, shock);
      const res = this._mesh(rod([0.05, 0.40, 0.02], [0.05, 0.26, 0.02], 0.018, 10), M.dark, shock);
      const coil = [];
      const turns = 9;
      const helix = [];
      for (let i = 0; i <= turns * 12; i++) { const a = i / 12 * Math.PI * 2; helix.push([Math.cos(a) * 0.038, 0.04 + i / (turns * 12) * 0.30, Math.sin(a) * 0.038]); }
      const springMesh = this._mesh(tube(helix, 0.0065, turns * 16, 6), M.spring, shock);
      this.shockSpring = springMesh;
      this._mesh(rod([0, 0.0, 0], [0, 0.24, 0], 0.011, 8), M.metal, shock);

      // ---------------- rider
      this.rider = new THREE.Group();
      root.add(this.rider);
      this._buildRider();

      root.traverse((o) => { if (o.isMesh) { o.frustumCulled = true; } });
      this.update({ sF: 0.07, sR: 0.1, steer: 0, wheelF: 0, wheelR: 0, rider: { x: 0, y: 0.78, z: 0, seated: 0, legOut: 0 }, lean: 0 });
    }

    _wheel(R, tireW, discR, front) {
      const M = this.M;
      const g = new THREE.Group();
      const spin = new THREE.Group();
      g.add(spin);
      const tr = front ? 0.052 : 0.058;
      // tyre (torus) with knobs
      const tire = new THREE.TorusGeometry(R - tr, tr, 12, 48);
      tire.rotateY(Math.PI / 2);
      const tm = this._mesh(tire, M.tire, spin);
      const knobs = [];
      const nK = 44;
      for (let i = 0; i < nK; i++) {
        const a = (i / nK) * Math.PI * 2;
        for (const side of [-1, 1]) {
          const ang = a + (side > 0 ? Math.PI / nK : 0);
          const kb = new THREE.BoxGeometry(0.022, 0.016, 0.026);
          const rr = R - 0.004;
          const lat = side * tireW * 0.38;
          const tilt = side * 0.45;
          _q.setFromEuler(new THREE.Euler(ang, 0, tilt));
          _m4.compose(new V(lat, Math.cos(ang) * rr - Math.abs(lat) * 0.25, Math.sin(ang) * rr), _q, _s);
          knobs.push(kb.applyMatrix4(_m4));
        }
      }
      this._mesh(mergeGeometries(knobs), M.knob, spin);
      // rim
      const rim = new THREE.TorusGeometry(R - tr * 1.75, 0.012, 6, 48);
      rim.rotateY(Math.PI / 2);
      this._mesh(rim, M.rim, spin);
      this._mesh(xf(new THREE.CylinderGeometry(R - tr * 1.75, R - tr * 1.75, 0.03, 48, 1, true), [0, 0, 0], [0, 0, Math.PI / 2]), M.rim, spin);
      // hub
      this._mesh(xf(new THREE.CylinderGeometry(0.045, 0.05, 0.12, 16), [0, 0, 0], [0, 0, Math.PI / 2]), M.metal, spin);
      // spokes
      const sp = [];
      const nS = 32, rimR = R - tr * 1.75 - 0.005;
      for (let i = 0; i < nS; i++) {
        const a = (i / nS) * Math.PI * 2;
        const side = i % 2 ? 1 : -1;
        const a2 = a + side * 0.18;
        sp.push(rod([side * 0.05, Math.cos(a) * 0.045, Math.sin(a) * 0.045], [side * 0.008, Math.cos(a2) * rimR, Math.sin(a2) * rimR], 0.0022, 3));
      }
      this._mesh(mergeGeometries(sp), M.metal, spin, false);
      // brake disc (right side)
      this._mesh(xf(new THREE.CylinderGeometry(discR, discR, 0.004, 32, 1), [-0.055, 0, 0], [0, 0, Math.PI / 2]), M.metal, spin);
      // caliper (doesn't spin)
      this._mesh(xf(new THREE.BoxGeometry(0.03, 0.06, 0.08), [-0.06, front ? 0.09 : -0.06, front ? -0.07 : -0.09]), M.dark, g);
      g.userData.spin = spin;
      return g;
    }

    // ------------------------------------------------------------ rider
    _buildRider() {
      const M = this.M, R = this.rider;
      const mk = (geo, mat) => { const m = new THREE.Mesh(geo, mat); m.castShadow = this.opts.shadows; R.add(m); return m; };
      // unit-length capsules along Y, scaled per frame
      const cap = (r, mat, L0) => { const m = mk(new THREE.CapsuleGeometry(r, L0, 4, 10), mat); m.userData.L0 = L0; return m; };
      this.rp = {
        torso: mk(new THREE.CapsuleGeometry(0.15, 0.32, 6, 14), M.jersey),
        hips: mk(new THREE.SphereGeometry(0.15, 14, 10), M.pants),
        neck: mk(new THREE.TorusGeometry(0.09, 0.035, 8, 16), M.dark),
        head: new THREE.Group(),
        uArmL: cap(0.05, M.jerseyArm, 0.28), uArmR: cap(0.05, M.jerseyArm, 0.28),
        fArmL: cap(0.045, M.jerseyArm, 0.26), fArmR: cap(0.045, M.jerseyArm, 0.26),
        handL: mk(new THREE.SphereGeometry(0.045, 10, 8), M.gloves), handR: mk(new THREE.SphereGeometry(0.045, 10, 8), M.gloves),
        thighL: cap(0.075, M.pants, 0.4), thighR: cap(0.075, M.pants, 0.4),
        shinL: cap(0.065, M.pants, 0.4), shinR: cap(0.065, M.pants, 0.4),
        bootL: mk(bootGeo(), M.boots), bootR: mk(bootGeo(), M.boots),
      };
      // knee pads/boot tops look
      // helmet: shell + chin bar + peak + goggles
      const head = this.rp.head;
      R.add(head);
      const shell = new THREE.Mesh(new THREE.SphereGeometry(0.135, 20, 16), M.helmet);
      shell.scale.set(1, 1.04, 1.12);
      shell.castShadow = this.opts.shadows;
      head.add(shell);
      const stripe = new THREE.Mesh(new THREE.SphereGeometry(0.137, 20, 16, 0, Math.PI * 2, 0, 0.5), M.helmetAcc);
      stripe.scale.set(0.35, 1.04, 1.12);
      head.add(stripe);
      const chin = new THREE.Mesh(xf(new THREE.CylinderGeometry(0.07, 0.05, 0.16, 12), [0, -0.07, 0.11], [Math.PI / 2 + 0.45, 0, 0]), M.helmetAcc);
      chin.castShadow = this.opts.shadows;
      head.add(chin);
      const peak = new THREE.Mesh(xf(new THREE.BoxGeometry(0.22, 0.012, 0.16), [0, 0.085, 0.15], [-0.25, 0, 0]), M.helmetAcc);
      head.add(peak);
      const gog = new THREE.Mesh(xf(new THREE.BoxGeometry(0.2, 0.06, 0.06), [0, 0.01, 0.13]), M.goggle);
      head.add(gog);
      const strap = new THREE.Mesh(new THREE.TorusGeometry(0.135, 0.012, 6, 24), M.black);
      strap.rotation.x = Math.PI / 2 + 0.15; strap.position.y = 0.01;
      head.add(strap);
      this.headLocal = new V();
    }

    setRiderVisible(v) { this.rider.visible = v; }

    // place a unit capsule (length 1 + 2r) between a and b
    _limb(m, a, b) {
      const d = _tmpD.subVectors(b, a);
      const len = d.length();
      m.position.addVectors(a, b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(UP, d.multiplyScalar(1 / Math.max(len, 1e-6)));
      m.scale.set(1, Math.max(0.05, len / (m.userData.L0 || 1)), 1);
    }

    // two-bone IK: returns the joint position in out
    static ik(root, target, l1, l2, pole, out) {
      const d = _ikD.subVectors(target, root);
      let L = d.length();
      const maxL = l1 + l2 - 1e-3;
      if (L > maxL) { d.multiplyScalar(maxL / L); L = maxL; target = _ikT.copy(root).add(d); }
      L = Math.max(L, Math.abs(l1 - l2) + 1e-3);
      const dir = d.normalize();
      const ca = clamp((l1 * l1 + L * L - l2 * l2) / (2 * l1 * L), -1, 1);
      const sa = Math.sqrt(1 - ca * ca);
      const bend = _ikB.copy(pole).addScaledVector(dir, -pole.dot(dir));
      if (bend.lengthSq() < 1e-8) bend.set(0, 0, 1);
      bend.normalize();
      out.copy(root).addScaledVector(dir, l1 * ca).addScaledVector(bend, l1 * sa);
      return target;
    }

    // ------------------------------------------------------------ pose
    update(st) {
      // front suspension: slider along steering axis
      this.forkSlider.position.y = -C.forkLenExt + (st.sF || 0);
      this.steer.rotation.y = st.steer || 0;
      this.frontWheel.userData.spin.rotation.x = st.wheelF || 0;
      // swingarm angle
      const b = C.rearExtAngle - (st.sR || 0) / C.swingLen;
      this.swingarm.rotation.x = -b;
      this.rearWheel.userData.spin.rotation.x = st.wheelR || 0;
      // shock between frame mount and swingarm linkage point
      const lowLocal = _tmpA.set(0, -0.05, -0.17);
      lowLocal.applyEuler(this.swingarm.rotation).add(this.swingarm.position);
      const top = this.shockTop;
      const d = _tmpB.subVectors(top, lowLocal);
      const len = d.length();
      this.shock.position.copy(lowLocal);
      this.shock.quaternion.setFromUnitVectors(UP, d.normalize());
      this.shock.scale.set(1, len / this.shockLen0, 1);
      if (st.rider && this.rider.visible && !st.detachedRider) this._poseRider(st);
    }

    gripLocal(side, out) {
      // grip in bike frame through steering transforms
      out.set(side * 0.37, 0.198, -0.078);
      out.applyEuler(this.steer.rotation);
      out.applyEuler(this.steerPivot.rotation).add(this.steerPivot.position);
      return out;
    }

    _poseRider(st) {
      const r = st.rider, p = this.rp;
      const seated = r.seated || 0;
      // pelvis
      const pel = _r1.set(r.x, r.y - 0.03, r.z - 0.07);
      pel.y = lerp(pel.y, 0.62, seated);
      pel.z = lerp(pel.z, -0.17 + (r.z + 0.14) * 0.5, seated);
      // torso lean forward: more when forward, upright when back / seated
      const fwd = clamp((r.z + 0.05) / 0.25, -1, 1);
      const lean = lerp(0.62 + 0.25 * fwd, 0.35 + 0.15 * fwd, seated);
      // body stays more upright than the bike in corners
      const roll = -(st.lean || 0) * 0.4 + (st.whip || 0) * 0.2;
      const spine = _r2.set(Math.sin(roll) * 0.3, Math.cos(lean), Math.sin(lean)).normalize();
      const shoulders = _r3.copy(pel).addScaledVector(spine, 0.46);
      p.hips.position.copy(pel);
      p.hips.scale.set(1.15, 0.85, 1.0);
      p.torso.position.copy(pel).addScaledVector(spine, 0.25);
      p.torso.quaternion.setFromUnitVectors(UP, spine);
      p.torso.scale.set(1.12, 1, 0.85);
      // head
      const headPos = _r4.copy(shoulders).addScaledVector(spine, 0.12);
      headPos.y += 0.13; headPos.z += 0.06;
      p.head.position.copy(headPos);
      p.head.rotation.set(0.35 - lean * 0.5, 0, -roll * 0.6);
      p.neck.position.copy(shoulders).addScaledVector(spine, 0.06);
      p.neck.quaternion.setFromUnitVectors(UP, spine);
      p.neck.rotateX(Math.PI / 2);
      this.headLocal.copy(headPos);
      // arms
      const side = _r5.set(1, 0, 0);
      for (const s of [1, -1]) {
        const sh = _r6.copy(shoulders).addScaledVector(side, s * 0.19);
        sh.y -= 0.02;
        const grip = this.gripLocal(s, _r7);
        const elbow = _r8;
        const pole = _r9.set(s * 0.8, -0.2, -0.4);
        const tgt = BikeModel.ik(sh, grip, 0.30, 0.30, pole, elbow);
        const L = s > 0 ? 'L' : 'R';
        this._limb(p['uArm' + L], sh, elbow);
        this._limb(p['fArm' + L], elbow, tgt);
        p['hand' + L].position.copy(tgt);
      }
      // legs
      for (const s of [1, -1]) {
        const hip = _r6.copy(pel).addScaledVector(side, s * 0.1);
        let foot = _r7.set(s * 0.19, 0.075, -0.03);
        const out = (r.legOut || 0) * s;
        if (out > 0) {
          // inside leg out forward in a corner
          foot.lerp(_r10.set(s * 0.42, 0.18, 0.58), clamp(out, 0, 1));
        }
        const knee = _r8;
        const pole = _r9.set(s * 0.25, 0.1, 1);
        const tgt = BikeModel.ik(hip, foot, 0.45, 0.45, pole, knee);
        const L = s > 0 ? 'L' : 'R';
        this._limb(p['thigh' + L], hip, knee);
        this._limb(p['shin' + L], knee, tgt);
        const boot = p['boot' + L];
        // boot shaft follows the shin, the sole stays on the peg
        boot.position.copy(tgt);
        boot.quaternion.setFromUnitVectors(UP, _r10.subVectors(knee, tgt).normalize());
        boot.rotateY(0); 
      }
    }

    // flail pose for the detached (crashed) rider; called with the rider group in world space
    poseCrashed(t) {
      const p = this.rp;
      const pel = _r1.set(0, 0, 0);
      const spine = _r2.set(0, 1, 0.2).normalize();
      p.hips.position.copy(pel);
      p.torso.position.copy(pel).addScaledVector(spine, 0.25);
      p.torso.quaternion.setFromUnitVectors(UP, spine);
      const shoulders = _r3.copy(pel).addScaledVector(spine, 0.46);
      p.head.position.copy(shoulders).addScaledVector(spine, 0.2);
      p.head.rotation.set(0.2, 0, 0);
      p.neck.position.copy(shoulders).addScaledVector(spine, 0.06);
      const w = Math.min(1, t * 1.2);
      for (const s of [1, -1]) {
        const L = s > 0 ? 'L' : 'R';
        const sh = _r6.copy(shoulders); sh.x += s * 0.19;
        const ph = t * 9 + (s > 0 ? 0 : 1.7);
        const el = _r8.set(sh.x + s * 0.22, sh.y + 0.08 * Math.sin(ph) * (1 - w * 0.7), sh.z + 0.12 * Math.cos(ph));
        const hd = _r7.set(el.x + s * 0.18, el.y - 0.15 + 0.1 * Math.sin(ph + 1), el.z + 0.1);
        this._limb(p['uArm' + L], sh, el); this._limb(p['fArm' + L], el, hd); p['hand' + L].position.copy(hd);
        const hip = _r6.set(s * 0.1, 0, 0);
        const kn = _r8.set(s * 0.18, -0.38 + 0.08 * Math.sin(ph * 0.8), 0.15 + 0.1 * Math.cos(ph * 0.8));
        const ft = _r7.set(s * 0.2, -0.8, 0.05 + 0.15 * Math.sin(ph * 0.8 + 1));
        this._limb(p['thigh' + L], hip, kn); this._limb(p['shin' + L], kn, ft);
        p['boot' + L].position.copy(ft); p['boot' + L].quaternion.setFromUnitVectors(UP, _r10.subVectors(kn, ft).normalize());
      }
    }

    setLook(look) {
      this.look = Object.assign(MX.defaultLook(), look || {});
      const old = this.M;
      const M = this._materials();
      // swap materials on meshes by identity
      const map = new Map();
      for (const k of Object.keys(old)) map.set(old[k], M[k]);
      this.root.traverse((o) => { if (o.isMesh && map.has(o.material)) o.material = map.get(o.material); });
      if (this.mats.pad) this.mats.pad.color.set(this.look.helmetAccent);
      for (const k of Object.keys(old)) old[k].dispose();
      this.M = M;
    }

    dispose() {
      this.disposeTextures();
      this.root.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); } });
      for (const k of Object.keys(this.M)) this.M[k].dispose();
      for (const k of Object.keys(this.mats)) this.mats[k].dispose();
    }
  }

  // boot: shaft along +Y from the ankle, foot pointing forward
  function bootGeo() {
    const shaft = new THREE.CylinderGeometry(0.068, 0.058, 0.3, 10); shaft.translate(0, 0.15, -0.01);
    const foot = new THREE.BoxGeometry(0.1, 0.075, 0.25); foot.translate(0, 0.0, 0.055);
    const sole = new THREE.BoxGeometry(0.104, 0.02, 0.27); sole.translate(0, -0.045, 0.055);
    const buckle = new THREE.BoxGeometry(0.14, 0.03, 0.12); buckle.translate(0, 0.2, -0.01);
    return mergeGeometries([shaft, foot, sole, buckle]);
  }
  const _tmpA = new V(), _tmpB = new V(), _tmpD = new V();
  const _ikD = new V(), _ikT = new V(), _ikB = new V();
  const _r1 = new V(), _r2 = new V(), _r3 = new V(), _r4 = new V(), _r5 = new V(), _r6 = new V(), _r7 = new V(), _r8 = new V(), _r9 = new V(), _r10 = new V();

  MX.BikeModel = BikeModel;
  MX.canvasTex = canvasTex;
});

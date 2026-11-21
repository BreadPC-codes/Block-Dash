/* =====================================================================
   ROOST MX - effects: dust & roost particles, tyre marks.
   ===================================================================== */
MX.module('fx', function (THREE, MX) {
  'use strict';
  const { clamp, lerp } = MX;
  const V = THREE.Vector3;

  // ------------------------------------------------------------ particles
  class Particles {
    constructor(scene, max, opts) {
      this.max = max;
      this.opts = Object.assign({ color: '#b48a62' }, opts || {});
      this.pos = new Float32Array(max * 3);
      this.vel = new Float32Array(max * 3);
      this.life = new Float32Array(max);
      this.maxLife = new Float32Array(max);
      this.size0 = new Float32Array(max);
      this.size1 = new Float32Array(max);
      this.grav = new Float32Array(max);
      this.drag = new Float32Array(max);
      this.alpha0 = new Float32Array(max);
      this.cursor = 0;
      const g = this.geo = new THREE.BufferGeometry();
      this.aPos = new THREE.BufferAttribute(new Float32Array(max * 3), 3);
      this.aSize = new THREE.BufferAttribute(new Float32Array(max), 1);
      this.aAlpha = new THREE.BufferAttribute(new Float32Array(max), 1);
      this.aCol = new THREE.BufferAttribute(new Float32Array(max * 3), 3);
      [this.aPos, this.aSize, this.aAlpha, this.aCol].forEach((a) => a.setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('position', this.aPos);
      g.setAttribute('aSize', this.aSize);
      g.setAttribute('aAlpha', this.aAlpha);
      g.setAttribute('aCol', this.aCol);
      g.setDrawRange(0, max);
      const mat = this.mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, fog: true,
        uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { scale: { value: 600 }, maxSize: { value: 300 } }]),
        vertexShader: `
          attribute float aSize; attribute float aAlpha; attribute vec3 aCol;
          varying float vAlpha; varying vec3 vCol;
          uniform float scale, maxSize;
          #include <fog_pars_vertex>
          void main(){
            vAlpha = aAlpha; vCol = aCol;
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            // capped so a puff right in front of the camera can't cover the screen (fill rate)
            gl_PointSize = min(aSize * scale / max(0.1, -mvPosition.z), maxSize);
            gl_Position = projectionMatrix * mvPosition;
            #include <fog_vertex>
          }`,
        fragmentShader: `
          varying float vAlpha; varying vec3 vCol;
          #include <fog_pars_fragment>
          void main(){
            vec2 c = gl_PointCoord - 0.5;
            float d = dot(c, c);
            if (d > 0.25) discard;
            float a = vAlpha * smoothstep(0.25, 0.02, d);
            gl_FragColor = vec4(vCol, a);
            #include <fog_fragment>
            #include <colorspace_fragment>
          }`,
      });
      this.points = new THREE.Points(g, mat);
      this.points.frustumCulled = false;
      scene.add(this.points);
      this.live = 0;          // particles alive
      this.clean = true;      // GPU buffers hold nothing visible
    }

    // (plain arguments rather than an options object: no allocation per particle)
    emit(p, v, life, size0, size1, grav, drag, alpha, color) {
      const i = this.cursor; this.cursor = (this.cursor + 1) % this.max;
      if (this.life[i] <= 0) this.live++;
      this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
      this.vel[i * 3] = v.x; this.vel[i * 3 + 1] = v.y; this.vel[i * 3 + 2] = v.z;
      this.life[i] = this.maxLife[i] = life;
      this.size0[i] = size0; this.size1[i] = size1;
      this.grav[i] = grav; this.drag[i] = drag; this.alpha0[i] = alpha;
      // colour only changes here: write it straight into the GPU-side copy
      const c = color || this._c || (this._c = new THREE.Color(this.opts.color));
      const Cc = this.aCol.array;
      Cc[i * 3] = c.r; Cc[i * 3 + 1] = c.g; Cc[i * 3 + 2] = c.b;
      this.aCol.needsUpdate = true;
    }

    setScale(h) { this.mat.uniforms.scale.value = h * 0.9; this.mat.uniforms.maxSize.value = Math.max(32, h * 0.4); }

    // Moves the live particles. Dead ones get size 0 (nothing to rasterise)
    // and nothing is uploaded while there is nothing to show.
    update(dt) {
      if (this.live === 0) {
        if (this.clean) return;
        this.clean = true;
      } else this.clean = false;
      const P = this.aPos.array, S = this.aSize.array, A = this.aAlpha.array;
      for (let i = 0; i < this.max; i++) {
        let l = this.life[i];
        if (l <= 0) { A[i] = 0; S[i] = 0; continue; }
        l -= dt; this.life[i] = l;
        if (l <= 0) { A[i] = 0; S[i] = 0; this.live--; continue; }
        const k = Math.exp(-this.drag[i] * dt);
        const j = i * 3;
        this.vel[j] *= k; this.vel[j + 2] *= k;
        this.vel[j + 1] = this.vel[j + 1] * k + this.grav[i] * dt;
        this.pos[j] += this.vel[j] * dt; this.pos[j + 1] += this.vel[j + 1] * dt; this.pos[j + 2] += this.vel[j + 2] * dt;
        P[j] = this.pos[j]; P[j + 1] = this.pos[j + 1]; P[j + 2] = this.pos[j + 2];
        const t = 1 - l / this.maxLife[i];
        S[i] = lerp(this.size0[i], this.size1[i], Math.sqrt(t));
        A[i] = this.alpha0[i] * (t < 0.1 ? t / 0.1 : 1) * (1 - t) * (1 - t);
      }
      this.aPos.needsUpdate = true; this.aSize.needsUpdate = true; this.aAlpha.needsUpdate = true;
    }

    clear() {
      this.life.fill(0); this.live = 0; this.clean = true;
      this.aAlpha.array.fill(0); this.aSize.array.fill(0);
      this.aAlpha.needsUpdate = true; this.aSize.needsUpdate = true;
    }
    dispose() { this.geo.dispose(); this.mat.dispose(); this.points.parent && this.points.parent.remove(this.points); }
  }

  // ------------------------------------------------------------ tyre marks
  class TireMarks {
    constructor(scene, max) {
      this.max = max;
      const g = this.geo = new THREE.BufferGeometry();
      this.p = new Float32Array(max * 4 * 3);
      this.c = new Float32Array(max * 4 * 4);
      const idx = new Uint32Array(max * 6);
      for (let i = 0; i < max; i++) { const v = i * 4; idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], i * 6); }
      this.aP = new THREE.BufferAttribute(this.p, 3); this.aP.setUsage(THREE.DynamicDrawUsage);
      this.aC = new THREE.BufferAttribute(this.c, 4); this.aC.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('position', this.aP); g.setAttribute('color', this.aC);
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      this.mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
      this.mesh = new THREE.Mesh(g, this.mat);
      this.mesh.frustumCulled = false;
      this.mesh.renderOrder = 2;
      scene.add(this.mesh);
      this.cursor = 0;
      this.last = [null, null];
      this.lastSide = [new V(), new V()];
      this.color = new THREE.Color('#3b2a1c');
    }

    // add a mark point for wheel k at contact point p with normal n, heading dir
    add(k, p, n, dir, width, strength) {
      const last = this.last[k];
      const side = _s.crossVectors(n, dir).normalize().multiplyScalar(width / 2);
      const lift = 0.02;
      if (last && last.distanceTo(p) < 0.25) return;
      if (last && last.distanceTo(p) < 2.5 && strength > 0.02) {
        const i = this.cursor; this.cursor = (this.cursor + 1) % this.max;
        const ls = this.lastSide[k];
        const v = i * 12;
        const set = (o, x, y, z) => { this.p[v + o] = x; this.p[v + o + 1] = y; this.p[v + o + 2] = z; };
        set(0, last.x - ls.x + n.x * lift, last.y - ls.y + n.y * lift, last.z - ls.z + n.z * lift);
        set(3, last.x + ls.x + n.x * lift, last.y + ls.y + n.y * lift, last.z + ls.z + n.z * lift);
        set(6, p.x - side.x + n.x * lift, p.y - side.y + n.y * lift, p.z - side.z + n.z * lift);
        set(9, p.x + side.x + n.x * lift, p.y + side.y + n.y * lift, p.z + side.z + n.z * lift);
        const a = clamp(strength, 0, 1) * 0.55;
        const cv = i * 16;
        for (let q = 0; q < 4; q++) { this.c[cv + q * 4] = this.color.r; this.c[cv + q * 4 + 1] = this.color.g; this.c[cv + q * 4 + 2] = this.color.b; this.c[cv + q * 4 + 3] = a; }
        // upload just this quad, not the whole ring buffer
        this.aP.addUpdateRange(v, 12); this.aC.addUpdateRange(cv, 16);
        this.aP.needsUpdate = true; this.aC.needsUpdate = true;
      }
      if (!this.last[k]) this.last[k] = new V();
      this.last[k].copy(p);
      this.lastSide[k].copy(side);
    }

    lift(k) { this.last[k] = null; }

    clear() {
      this.p.fill(0); this.c.fill(0);
      this.aP.clearUpdateRanges(); this.aC.clearUpdateRanges();
      this.aP.needsUpdate = true; this.aC.needsUpdate = true; this.last = [null, null];
    }
    dispose() { this.geo.dispose(); this.mat.dispose(); this.mesh.parent && this.mesh.parent.remove(this.mesh); }
  }
  const _s = new V();

  // ------------------------------------------------------------ manager
  class Effects {
    constructor(scene, track, quality) {
      const q = quality || {};
      this.track = track;
      const night = track.def.env.sky === 'night';
      this.dust = new Particles(scene, q.particles || 900, { color: night ? '#8a6c52' : '#b9946c' });
      this.clods = new Particles(scene, 260, { color: '#4a3424' });
      this.marks = new TireMarks(scene, q.marks || 2400);
      this.dustColor = new THREE.Color(track.def.env.dirt2).lerp(new THREE.Color('#d8c4a8'), 0.45);
      this.grassColor = new THREE.Color(track.def.env.grass).lerp(new THREE.Color('#8b7a55'), 0.5);
      this.clodColor = new THREE.Color(track.def.env.dirt).multiplyScalar(0.7);
      this.acc = [0, 0];
    }

    setViewport(h) { this.dust.setScale(h); this.clods.setScale(h); }

    // per frame: emit from the bike state
    update(dt, phys) {
      if (phys && !phys.crashed) {
        const speed = phys.speed;
        for (let k = 0; k < 2; k++) {
          const w = phys.wheels[k];
          if (!w.contact) { this.marks.lift(k); continue; }
          const dir = _d.copy(phys.vel); dir.y = 0;
          if (dir.lengthSq() < 0.01) dir.copy(phys.f);
          dir.normalize();
          const slide = clamp(w.slideAmt || 0, 0, 2);
          const dirtK = w.dirt > 0.3 ? 1 : 0.35;
          // tyre marks: knobbies leave a trail on dirt, darker when sliding
          if (speed > 1.2) this.marks.add(k, w.cp, w.cn, dir, k ? 0.17 : 0.12, (0.18 + slide * 0.5) * (w.dirt > 0.3 ? 1 : 0.4));
          // dust & roost from the rear when driving / sliding
          let rate = 0;
          if (k === 1) {
            const drive = clamp((Math.abs(w.slip || 0) - 0.08) * 3, 0, 2) * clamp(speed / 8, 0.2, 1.2);
            rate = (drive * 14 + slide * 26 + speed * 0.35) * dirtK;
          } else rate = (slide * 18 + speed * 0.08) * dirtK;
          this.acc[k] += rate * dt;
          while (this.acc[k] >= 1) {
            this.acc[k] -= 1;
            const back = _b.copy(dir).multiplyScalar(-1);
            const sp = 1 + Math.random() * 2;
            _v.copy(back).multiplyScalar(sp + (k === 1 ? Math.abs(w.slip || 0) * 4 : 0)).add(_r.set((Math.random() - 0.5) * 1.6, 0.5 + Math.random() * 1.4, (Math.random() - 0.5) * 1.6));
            _v.addScaledVector(phys.vel, 0.25);
            _p.copy(w.cp).addScaledVector(w.cn, 0.08);
            this.dust.emit(_p, _v, 1.2 + Math.random() * 1.4, 0.3, 1.5 + Math.random() * 1.3, 0.12, 1.5, 0.14 + 0.1 * Math.min(1, slide), w.dirt > 0.3 ? this.dustColor : this.grassColor);
            if (k === 1 && Math.abs(w.slip || 0) > 0.25 && Math.random() < 0.6) {
              _v.copy(back).multiplyScalar(4 + Math.random() * 5).add(_r.set((Math.random() - 0.5) * 2, 1.5 + Math.random() * 2.5, (Math.random() - 0.5) * 2));
              _v.addScaledVector(phys.vel, 0.5);
              this.clods.emit(_p, _v, 0.9, 0.07, 0.06, -9.8, 0.4, 0.95, this.clodColor);
            }
          }
        }
      }
      this.dust.update(dt);
      this.clods.update(dt);
    }

    burst(p, strength, color) {
      const n = Math.floor(clamp(strength, 0, 14) * 4);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, s = 1 + Math.random() * strength * 0.4;
        _v.set(Math.cos(a) * s, 0.4 + Math.random() * 1.5, Math.sin(a) * s);
        this.dust.emit(p, _v, 1.6 + Math.random(), 0.5, 3 + Math.random() * 2, 0.1, 1.6, 0.35, color || this.dustColor);
      }
    }

    clear() { this.dust.clear(); this.clods.clear(); this.marks.clear(); }
    dispose() { this.dust.dispose(); this.clods.dispose(); this.marks.dispose(); }
  }
  const _d = new V(), _b = new V(), _v = new V(), _r = new V(), _p = new V();

  MX.Effects = Effects;
});

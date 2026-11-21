// Pooled GPU point particles (roost, dust, landing bursts) and tire marks.
import * as THREE from 'three';
import { makeParticleTexture } from './textures.js';

const VERT = /* glsl */ `
attribute vec4 aColor;
attribute float aSize;
varying vec4 vColor;
uniform float uScale;
#include <fog_pars_vertex>
void main() {
  vColor = aColor;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(0.1, -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uLight;
varying vec4 vColor;
#include <fog_pars_fragment>
void main() {
  float a = texture2D(uMap, gl_PointCoord).a * vColor.a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor.rgb * uLight, a);
  #include <fog_fragment>
}`;

export class Particles {
  constructor(scene, max = 1200) {
    this.max = max;
    this.count = 0;
    const F = (n) => new Float32Array(n);
    this.px = F(max); this.py = F(max); this.pz = F(max);
    this.vx = F(max); this.vy = F(max); this.vz = F(max);
    this.life = F(max); this.maxLife = F(max);
    this.s0 = F(max); this.s1 = F(max);
    this.r = F(max); this.g = F(max); this.b = F(max); this.a0 = F(max);
    this.grav = F(max); this.drag = F(max);
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.tex = makeParticleTexture();
    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMap: { value: null }, uScale: { value: 500 }, uLight: { value: new THREE.Vector3(1, 1, 1) } }]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.mat.uniforms.uMap.value = this.tex;
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
  }

  setViewport(heightPx, fovDeg) {
    this.mat.uniforms.uScale.value = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  setLight(r, g, b) {
    this.mat.uniforms.uLight.value.set(r, g, b);
  }

  emit(x, y, z, vx, vy, vz, life, size0, size1, r, g, b, alpha, grav = 9.8, drag = 0.5) {
    if (this.count >= this.max) return;
    const i = this.count++;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = life; this.maxLife[i] = life;
    this.s0[i] = size0; this.s1[i] = size1;
    this.r[i] = r; this.g[i] = g; this.b[i] = b; this.a0[i] = alpha;
    this.grav[i] = grav; this.drag[i] = drag;
  }

  clear() {
    this.count = 0;
    this.geo.setDrawRange(0, 0);
  }

  update(dt, terrain) {
    let n = this.count;
    for (let i = 0; i < n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // swap-remove
        n--;
        this._copy(n, i);
        i--;
        continue;
      }
      const dr = Math.max(0, 1 - this.drag[i] * dt);
      this.vx[i] *= dr; this.vz[i] *= dr;
      this.vy[i] = this.vy[i] * dr - this.grav[i] * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      if (this.grav[i] > 1 && terrain) {
        const gh = terrain.height(this.px[i], this.pz[i]);
        if (this.py[i] < gh + 0.02) {
          this.py[i] = gh + 0.02;
          this.vy[i] *= -0.2;
          this.vx[i] *= 0.4;
          this.vz[i] *= 0.4;
          this.life[i] = Math.min(this.life[i], 0.35);
        }
      }
    }
    this.count = n;
    const pos = this.pos, col = this.col, size = this.size;
    for (let i = 0; i < n; i++) {
      const t = 1 - this.life[i] / this.maxLife[i];
      pos[i * 3] = this.px[i];
      pos[i * 3 + 1] = this.py[i];
      pos[i * 3 + 2] = this.pz[i];
      col[i * 4] = this.r[i];
      col[i * 4 + 1] = this.g[i];
      col[i * 4 + 2] = this.b[i];
      const fade = t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9;
      col[i * 4 + 3] = this.a0[i] * fade;
      size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
    }
    this.geo.setDrawRange(0, n);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
  }

  _copy(from, to) {
    const arrs = [this.px, this.py, this.pz, this.vx, this.vy, this.vz, this.life, this.maxLife, this.s0, this.s1, this.r, this.g, this.b, this.a0, this.grav, this.drag];
    for (const a of arrs) a[to] = a[from];
  }

  dispose() {
    this.points.parent && this.points.parent.remove(this.points);
    this.geo.dispose();
    this.mat.dispose();
    this.tex.dispose();
  }
}

/** Ring buffer of quads drawn on the ground behind sliding tires. */
export class TireMarks {
  constructor(scene, max = 700) {
    this.max = max;
    this.next = 0;
    this.pos = new Float32Array(max * 4 * 3);
    this.col = new Float32Array(max * 4 * 4);
    const idx = new Uint32Array(max * 6);
    for (let i = 0; i < max; i++) {
      const v = i * 4;
      idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], i * 6);
    }
    this.age = new Float32Array(max).fill(1e9);
    this.alpha = new Float32Array(max);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this.last = [null, null];
    this.dirty = false;
    this.timer = 0;
  }

  /** Add a mark segment for track `k` (0 = front, 1 = rear) ending at p with normal n. */
  add(k, p, n, width, color, alpha) {
    const last = this.last[k];
    if (!last) {
      this.last[k] = p.clone();
      return;
    }
    const dx = p.x - last.x, dz = p.z - last.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.25) return;
    if (d > 2.5) {
      last.copy(p);
      return;
    }
    // side vector
    const sx = (-dz / d) * width * 0.5, sz = (dx / d) * width * 0.5;
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    const o = i * 12;
    const lift = 0.025;
    const P = this.pos;
    P[o] = last.x + sx; P[o + 1] = last.y + lift; P[o + 2] = last.z + sz;
    P[o + 3] = last.x - sx; P[o + 4] = last.y + lift; P[o + 5] = last.z - sz;
    P[o + 6] = p.x + sx; P[o + 7] = p.y + lift; P[o + 8] = p.z + sz;
    P[o + 9] = p.x - sx; P[o + 10] = p.y + lift; P[o + 11] = p.z - sz;
    const c = i * 16;
    for (let v = 0; v < 4; v++) {
      this.col[c + v * 4] = color[0];
      this.col[c + v * 4 + 1] = color[1];
      this.col[c + v * 4 + 2] = color[2];
      this.col[c + v * 4 + 3] = alpha;
    }
    this.age[i] = 0;
    this.alpha[i] = alpha;
    last.copy(p);
    this.dirty = true;
    void n;
  }

  break(k) {
    this.last[k] = null;
  }

  update(dt) {
    this.timer += dt;
    if (this.timer > 0.25) {
      // fade old marks slowly
      const t = this.timer;
      this.timer = 0;
      for (let i = 0; i < this.max; i++) {
        if (this.age[i] > 1e8) continue;
        this.age[i] += t;
        if (this.age[i] > 25) {
          const a = Math.max(0, this.alpha[i] * (1 - (this.age[i] - 25) / 15));
          for (let v = 0; v < 4; v++) this.col[i * 16 + v * 4 + 3] = a;
          if (a <= 0) this.age[i] = 1e9;
          this.dirty = true;
        }
      }
    }
    if (this.dirty) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.color.needsUpdate = true;
      this.dirty = false;
    }
  }

  clear() {
    this.col.fill(0);
    this.age.fill(1e9);
    this.last = [null, null];
    this.dirty = true;
  }

  dispose() {
    this.mesh.parent && this.mesh.parent.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}

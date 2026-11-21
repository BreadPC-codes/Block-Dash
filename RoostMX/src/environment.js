// Outdoor environment: sky, sun & shadows, fog, vegetation and trackside props.
// Everything is instanced or merged to keep draw calls low; solid props register
// colliders that the bike physics uses.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ColliderSet } from './colliders.js';
import { makeRng, clamp, lerp, smoothstep } from './util.js';
import { DS } from './track.js';
import {
  makeGrassTexture, makeBannerTexture, makeCheckerTexture, makeTapeTexture, makeWindowTexture, makeBarkTexture,
} from './textures.js';

export const QUALITY_PRESETS = {
  low: { shadows: false, shadowMap: 1024, pixelRatio: 0.75, grass: 0, trees: 0.4, bushes: 0.35, props: 0.6, antialias: false, particles: 300, terrain: 'low', fogFar: 950, crowd: 0.4 },
  medium: { shadows: true, shadowMap: 1024, pixelRatio: 1.0, grass: 15000, trees: 0.7, bushes: 0.65, props: 1, antialias: true, particles: 700, terrain: 'medium', fogFar: 1500, crowd: 0.7 },
  high: { shadows: true, shadowMap: 2048, pixelRatio: 1.5, grass: 38000, trees: 1, bushes: 1, props: 1, antialias: true, particles: 1300, terrain: 'high', fogFar: 2200, crowd: 1 },
};

const ENV_PRESETS = {
  valley: { elevation: 38, azimuth: 205, turbidity: 3.2, rayleigh: 1.6, fog: 0xc4d3df, exposure: 0.62, clouds: 0.45, hemiSky: 0xcfe2ff, hemiGround: 0x5b4b3a },
  pine: { elevation: 30, azimuth: 140, turbidity: 4.5, rayleigh: 1.9, fog: 0xb9c8d2, exposure: 0.6, clouds: 0.55, hemiSky: 0xc9dbf2, hemiGround: 0x4d4536 },
  dunes: { elevation: 46, azimuth: 250, turbidity: 6, rayleigh: 1.1, fog: 0xe2dccd, exposure: 0.56, clouds: 0.25, hemiSky: 0xe6eefc, hemiGround: 0x8d7a5b },
};

const SPONSORS = [
  ['DIRTLINE', '#111111', '#f26a10', '#f26a10'],
  ['TORQUE OIL', '#f4f4f4', '#111111', '#d4241c'],
  ['RIDGE GOGGLES', '#1f5fd6', '#ffffff', '#f2c418'],
  ['HOLESHOT', '#f2c418', '#111111', '#111111'],
  ['KNOBBY TYRES', '#1b1b1d', '#ffffff', '#2fae3c'],
  ['BRAAP ENERGY', '#2fae3c', '#111111', '#f4f4f4'],
  ['GRIT GEAR', '#d4241c', '#ffffff', '#111111'],
  ['ROOST MX', '#f26a10', '#111111', '#ffffff'],
  ['FULL SEND', '#ffffff', '#1f5fd6', '#1f5fd6'],
  ['PIT BOSS', '#111111', '#f2c418', '#f2c418'],
];

/** Instances split into spatial cells so frustum culling (and shadow culling) works. */
class ChunkedInstances {
  constructor(geometry, material, cell = 96) {
    this.geometry = geometry;
    this.material = material;
    this.cell = cell;
    this.cells = new Map();
  }
  add(matrix, color) {
    const x = matrix.elements[12], z = matrix.elements[14];
    const key = Math.floor(x / this.cell) + ':' + Math.floor(z / this.cell);
    let c = this.cells.get(key);
    if (!c) this.cells.set(key, (c = { m: [], c: [] }));
    c.m.push(matrix.clone());
    if (color) c.c.push(color.clone());
  }
  build(group, { cast = true, receive = true } = {}) {
    const meshes = [];
    for (const c of this.cells.values()) {
      const im = new THREE.InstancedMesh(this.geometry, this.material, c.m.length);
      c.m.forEach((m, i) => im.setMatrixAt(i, m));
      if (c.c.length) c.c.forEach((col, i) => im.setColorAt(i, col));
      im.castShadow = cast;
      im.receiveShadow = receive;
      im.computeBoundingSphere();
      im.matrixAutoUpdate = false;
      group.add(im);
      meshes.push(im);
    }
    return meshes;
  }
}

function colorize(geo, color, jitter = 0.08, rng = Math.random) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  const c = new THREE.Color(color);
  for (let i = 0; i < n; i += 3) {
    const j = 1 + (rng() - 0.5) * jitter * 2;
    for (let k = 0; k < 3 && i + k < n; k++) {
      col[(i + k) * 3] = c.r * j;
      col[(i + k) * 3 + 1] = c.g * j;
      col[(i + k) * 3 + 2] = c.b * j;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}

function merge(list) {
  const clean = list.map((g) => {
    const x = g.index ? g.toNonIndexed() : g;
    const y = new THREE.BufferGeometry();
    y.setAttribute('position', x.getAttribute('position'));
    if (!x.getAttribute('normal')) x.computeVertexNormals();
    y.setAttribute('normal', x.getAttribute('normal'));
    y.setAttribute('uv', x.getAttribute('uv') || new THREE.BufferAttribute(new Float32Array(x.getAttribute('position').count * 2), 2));
    if (x.getAttribute('color')) y.setAttribute('color', x.getAttribute('color'));
    return y;
  });
  const hasColor = clean.every((g) => g.getAttribute('color'));
  if (!hasColor) clean.forEach((g) => g.deleteAttribute('color'));
  return mergeGeometries(clean, false);
}

// --- tree / plant geometries ------------------------------------------------------------
function pineGeometry(rng) {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.13, 0.22, 2.4, 7);
  trunk.translate(0, 1.2, 0);
  parts.push(colorize(trunk, 0x5a3d26, 0.1, rng));
  const tiers = [[1.9, 2.4, 1.7], [1.55, 2.2, 2.75], [1.2, 2.0, 3.7], [0.85, 1.8, 4.55], [0.5, 1.4, 5.3]];
  for (const [r, h, y] of tiers) {
    const c = new THREE.ConeGeometry(r, h, 9, 1);
    c.translate(0, y + h / 2 - 0.4, 0);
    parts.push(colorize(c, 0x2b4a26, 0.14, rng));
  }
  return merge(parts);
}
function leafyGeometry(rng) {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.16, 0.26, 3.2, 7);
  trunk.translate(0, 1.6, 0);
  parts.push(colorize(trunk, 0x5e4630, 0.1, rng));
  const blobs = [[0, 4.2, 0, 1.9], [1.0, 3.7, 0.5, 1.35], [-0.9, 3.8, -0.4, 1.4], [0.2, 3.6, -1.0, 1.3], [-0.3, 5.0, 0.3, 1.25]];
  for (const [x, y, z, r] of blobs) {
    const b = new THREE.IcosahedronGeometry(r, 1);
    b.translate(x, y, z);
    parts.push(colorize(b, 0x4a6e2c, 0.16, rng));
  }
  return merge(parts);
}
function palmGeometry(rng) {
  const parts = [];
  const pts = [];
  for (let i = 0; i <= 6; i++) pts.push(new THREE.Vector3(Math.sin(i * 0.25) * 0.5, i * 0.95, 0));
  const trunk = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, 0.17, 7);
  parts.push(colorize(trunk, 0x8a6f4e, 0.12, rng));
  const top = pts[pts.length - 1];
  for (let i = 0; i < 8; i++) {
    const leaf = new THREE.BoxGeometry(0.5, 0.04, 2.6);
    leaf.translate(0, 0, 1.3);
    leaf.rotateX(0.45);
    leaf.rotateY((i / 8) * Math.PI * 2);
    leaf.translate(top.x, top.y, top.z);
    parts.push(colorize(leaf, 0x4f7a2e, 0.15, rng));
  }
  return merge(parts);
}
function bushGeometry(rng, color = 0x45662a) {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const b = new THREE.IcosahedronGeometry(0.55 + rng() * 0.35, 1);
    b.scale(1, 0.7, 1);
    b.translate((rng() - 0.5) * 0.8, 0.35, (rng() - 0.5) * 0.8);
    parts.push(colorize(b, color, 0.18, rng));
  }
  return merge(parts);
}
function rockGeometry(rng) {
  const g = new THREE.DodecahedronGeometry(0.7, 1);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const s = 0.75 + rng() * 0.5;
    p.setXYZ(i, p.getX(i) * s, p.getY(i) * s * 0.65, p.getZ(i) * s);
  }
  g.computeVertexNormals();
  return colorize(g, 0x7e7a72, 0.12, rng);
}

export class Environment {
  constructor({ renderer, scene, track, hf, quality, terrainStyle }) {
    this.renderer = renderer;
    this.scene = scene;
    this.track = track;
    this.hf = hf;
    this.q = QUALITY_PRESETS[quality] || QUALITY_PRESETS.medium;
    this.qualityName = quality;
    this.group = new THREE.Group();
    this.group.name = 'environment';
    this.colliders = new ColliderSet(12);
    this.disposables = [];
    this.time = 0;
    this.style = terrainStyle;
    this.gate = null;
    const def = track.def;
    const presetKey = def.vegetation === 'pine' ? 'pine' : def.groundStyle === 'dunes' ? 'dunes' : 'valley';
    this.env = { ...ENV_PRESETS[presetKey], ...(def.env || {}) };
  }

  track_(m) {
    this.disposables.push(m);
    return m;
  }

  build() {
    this.scene.add(this.group);
    this._sky();
    this._lights();
    if (this.track.def.seaSide) this._sea();
    this._vegetation();
    this._trackProps();
    this._venue();
    return this;
  }

  // ---------------------------------------------------------------------------------
  _sky() {
    const env = this.env;
    const sky = new Sky();
    sky.scale.setScalar(4500);
    const u = sky.material.uniforms;
    u.turbidity.value = env.turbidity;
    u.rayleigh.value = env.rayleigh;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.82;
    if (u.cloudCoverage) {
      u.cloudCoverage.value = env.clouds;
      u.cloudDensity.value = 0.45;
      u.cloudScale.value = 0.00025;
      u.cloudElevation.value = 0.5;
    }
    const phi = THREE.MathUtils.degToRad(90 - env.elevation);
    const theta = THREE.MathUtils.degToRad(env.azimuth);
    this.sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunDir);
    this.sky = sky;
    this.group.add(sky);
    // environment map from the sky (for metal/paint reflections)
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const sky2 = new Sky();
    sky2.scale.setScalar(4500);
    sky2.material.uniforms = THREE.UniformsUtils.clone(sky.material.uniforms);
    if (sky2.material.uniforms.showSunDisc) sky2.material.uniforms.showSunDisc.value = 0;
    envScene.add(sky2);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(4000, 16), new THREE.MeshBasicMaterial({ color: this.style === 'dunes' ? 0x9c8664 : 0x3e4a2c }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -30;
    envScene.add(ground);
    const rt = pmrem.fromScene(envScene, 0.02, 1, 6000);
    this.envMap = rt;
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.55;
    sky2.geometry.dispose();
    sky2.material.dispose();
    ground.geometry.dispose();
    ground.material.dispose();
    pmrem.dispose();
    this.scene.fog = new THREE.Fog(env.fog, 140, this.q.fogFar);
    this.scene.background = new THREE.Color(env.fog);
    this.renderer.toneMappingExposure = env.exposure;
  }

  _lights() {
    const env = this.env;
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.7);
    sun.position.copy(this.sunDir).multiplyScalar(150);
    sun.castShadow = this.q.shadows;
    const s = sun.shadow;
    s.mapSize.set(this.q.shadowMap, this.q.shadowMap);
    const ext = 42;
    s.camera.left = -ext; s.camera.right = ext; s.camera.top = ext; s.camera.bottom = -ext;
    s.camera.near = 10; s.camera.far = 340;
    s.bias = -0.0004;
    s.normalBias = 0.04;
    s.radius = 2.2;
    this.sun = sun;
    this.group.add(sun);
    this.group.add(sun.target);
    const hemi = new THREE.HemisphereLight(env.hemiSky, env.hemiGround, 0.62);
    this.group.add(hemi);
    this.hemi = hemi;
  }

  _sea() {
    const geo = new THREE.PlaneGeometry(9000, 9000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2b6f86, roughness: 0.06, metalness: 0.1, transparent: true, opacity: 0.93 });
    const sea = new THREE.Mesh(geo, mat);
    sea.position.y = -2.2;
    this.group.add(sea);
    this.track_(geo);
    this.track_(mat);
  }

  // ---------------------------------------------------------------------------------
  _trackDistAt(x, z) {
    const hf = this.hf;
    const ix = Math.round((x + hf.half) / hf.cell), iz = Math.round((z + hf.half) / hf.cell);
    if (ix < 0 || iz < 0 || ix >= hf.n || iz >= hf.n) return 1e4;
    return hf.trackDist[iz * hf.n + ix];
  }

  _inPits(x, z, margin = 4) {
    for (const p of this.hf.pits || []) {
      const lx = (x - p.x) * p.ux + (z - p.z) * p.uz;
      const lz = (x - p.x) * p.vx + (z - p.z) * p.vz;
      if (Math.abs(lx) < p.hw + margin && Math.abs(lz) < p.hd + margin) return true;
    }
    return false;
  }

  _slope(x, z) {
    const n = this.hf.normal(x, z, { x: 0, y: 1, z: 0 }, 1.5);
    return n.y;
  }

  _vegetation() {
    const hf = this.hf, track = this.track, def = track.def;
    const rng = makeRng((def.seed || 1) * 7 + 3);
    const half = hf.half;
    const q = this.q;
    const noise = track.noise;
    const vegType = def.vegetation;
    // --- trees
    const types = [];
    const bark = makeBarkTexture();
    this.track_(bark);
    const treeMat = this.track_(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, flatShading: true }));
    if (vegType === 'coastal') {
      types.push({ geo: palmGeometry(rng), weight: 0.6, r: 0.25 });
      types.push({ geo: bushGeometry(rng, 0x6b7a3a), weight: 0.4, r: 0, small: true });
    } else if (vegType === 'pine') {
      types.push({ geo: pineGeometry(rng), weight: 0.85, r: 0.3 });
      types.push({ geo: leafyGeometry(rng), weight: 0.15, r: 0.3 });
    } else {
      types.push({ geo: pineGeometry(rng), weight: 0.45, r: 0.3 });
      types.push({ geo: leafyGeometry(rng), weight: 0.55, r: 0.3 });
    }
    const chunks = types.map((t) => {
      this.track_(t.geo);
      return new ChunkedInstances(t.geo, treeMat, 110);
    });
    const baseCount = vegType === 'coastal' ? 520 : vegType === 'pine' ? 1900 : 1500;
    const count = Math.round(baseCount * q.trees * (def.size / 640) ** 2);
    const m = new THREE.Matrix4(), qt = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
    let placed = 0, tries = 0;
    while (placed < count && tries < count * 25) {
      tries++;
      const x = (rng() * 2 - 1) * (half - 3), z = (rng() * 2 - 1) * (half - 3);
      const td = this._trackDistAt(x, z);
      if (td < 24) continue;
      if (this._inPits(x, z, 10)) continue;
      // clusters: denser where noise is high, plus a tree line near the boundary
      const edge = Math.max(Math.abs(x), Math.abs(z)) > half - 45;
      const dens = noise.fbm(x / 85 + 9, z / 85 - 4, 3);
      const p = edge ? 0.9 : vegType === 'pine' ? 0.35 + dens : 0.12 + dens * 1.2;
      if (rng() > p) continue;
      if (this._slope(x, z) < 0.8) continue;
      let ti = 0;
      const r0 = rng();
      let acc = 0;
      for (let i = 0; i < types.length; i++) { acc += types[i].weight; if (r0 <= acc) { ti = i; break; } }
      const t = types[ti];
      const s = t.small ? 0.8 + rng() * 0.8 : 0.75 + rng() * 0.75;
      const h = hf.height(x, z);
      pos.set(x, h - 0.1, z);
      qt.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI * 2);
      sc.set(s, s * (0.85 + rng() * 0.35), s);
      m.compose(pos, qt, sc);
      chunks[ti].add(m);
      if (t.r > 0 && Math.abs(x) < half - 2 && Math.abs(z) < half - 2) this.colliders.addCircle(x, z, t.r * s + 0.1, h - 1, h + 8 * s, 'a tree');
      placed++;
    }
    for (const c of chunks) c.build(this.group, { cast: q.shadows && this.qualityName === 'high', receive: true });

    // --- bushes
    const bushGeo = this.track_(bushGeometry(rng, vegType === 'coastal' ? 0x7d8442 : 0x42652a));
    const bushes = new ChunkedInstances(bushGeo, treeMat, 110);
    const bushCount = Math.round(900 * q.bushes * (def.size / 640) ** 2);
    placed = 0; tries = 0;
    while (placed < bushCount && tries < bushCount * 20) {
      tries++;
      const x = (rng() * 2 - 1) * (half - 3), z = (rng() * 2 - 1) * (half - 3);
      const td = this._trackDistAt(x, z);
      if (td < 14 || this._inPits(x, z, 3)) continue;
      const dens = noise.fbm(x / 60 - 3, z / 60 + 8, 2);
      if (rng() > 0.25 + dens) continue;
      const s = 0.6 + rng() * 0.9;
      pos.set(x, hf.height(x, z) - 0.15, z);
      qt.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * 6.28);
      sc.set(s, s, s);
      m.compose(pos, qt, sc);
      bushes.add(m);
      placed++;
    }
    bushes.build(this.group, { cast: false, receive: true });

    // --- rocks
    const rockGeo = this.track_(rockGeometry(rng));
    const rocks = new ChunkedInstances(rockGeo, treeMat, 160);
    const rockCount = Math.round((vegType === 'coastal' ? 60 : 160) * q.props);
    placed = 0; tries = 0;
    while (placed < rockCount && tries < rockCount * 20) {
      tries++;
      const x = (rng() * 2 - 1) * (half - 4), z = (rng() * 2 - 1) * (half - 4);
      if (this._trackDistAt(x, z) < 20 || this._inPits(x, z, 6)) continue;
      const s = 0.4 + rng() * rng() * 2.2;
      const h = hf.height(x, z);
      pos.set(x, h - 0.1 * s, z);
      qt.setFromEuler(new THREE.Euler(rng() * 0.4, rng() * 6.28, rng() * 0.4));
      sc.set(s, s, s);
      m.compose(pos, qt, sc);
      rocks.add(m);
      if (s > 0.9) this.colliders.addCircle(x, z, 0.62 * s, h - 1, h + 0.7 * s, 'a rock');
      placed++;
    }
    rocks.build(this.group, { cast: q.shadows, receive: true });

    // --- grass tufts near the track
    if (q.grass > 0 && def.surface !== 'sand') {
      const gtex = this.track_(makeGrassTexture());
      const quad = [];
      for (let i = 0; i < 3; i++) {
        const p = new THREE.PlaneGeometry(0.95, 0.6, 1, 1);
        p.translate(0, 0.3, 0);
        p.rotateY((i / 3) * Math.PI);
        quad.push(p);
      }
      const gg = merge(quad);
      // normals straight up so tufts are lit like the ground
      const nn = gg.getAttribute('normal');
      for (let i = 0; i < nn.count; i++) nn.setXYZ(i, 0, 1, 0);
      this.track_(gg);
      const gmat = this.track_(new THREE.MeshStandardMaterial({ map: gtex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 1, color: 0xc8d8a8 }));
      const timeU = { value: 0 };
      this.grassTime = timeU;
      gmat.onBeforeCompile = (sh) => {
        sh.uniforms.uTime = timeU;
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;')
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            #ifdef USE_INSTANCING
              vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
            #else
              vec3 ip = vec3(0.0);
            #endif
            float sway = sin(uTime * 1.7 + ip.x * 0.35 + ip.z * 0.21) * 0.08 + sin(uTime * 3.1 + ip.z * 0.5) * 0.03;
            transformed.x += sway * position.y;
            transformed.z += sway * 0.6 * position.y;`
          );
      };
      gmat.customProgramCacheKey = () => 'grass-sway';
      const grass = new ChunkedInstances(gg, gmat, 48);
      const gCount = Math.round(q.grass * (def.size / 640) ** 2);
      placed = 0; tries = 0;
      const n = hf.n;
      while (placed < gCount && tries < gCount * 12) {
        tries++;
        const x = (rng() * 2 - 1) * (half - 2), z = (rng() * 2 - 1) * (half - 2);
        const td = this._trackDistAt(x, z);
        if (td < 7.5 || td > 70) continue;
        const ix = Math.round((x + half) / hf.cell), iz = Math.round((z + half) / hf.cell);
        if (hf.splat[(iz * n + ix) * 4 + 1] < 200) continue;
        const s = 0.6 + rng() * 0.8;
        pos.set(x, hf.height(x, z) - 0.03, z);
        qt.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * 6.28);
        sc.set(s, s * (0.7 + rng() * 0.6), s);
        m.compose(pos, qt, sc);
        grass.add(m);
        placed++;
      }
      grass.build(this.group, { cast: false, receive: true });
    }
  }

  // ---------------------------------------------------------------------------------
  /** Is a point free of the track surface (any part) and inside the map? */
  _free(x, z, clear = 3) {
    const hf = this.hf;
    if (Math.abs(x) > hf.half - 3 || Math.abs(z) > hf.half - 3) return false;
    const pr = this.track.project(x, z);
    const w = this.track.interp(this.track.W, pr.s);
    return this._trackDistAt(x, z) > w + clear && pr.dist > w + clear;
  }

  _trackProps() {
    const track = this.track, hf = this.hf, q = this.q;
    const rng = makeRng((track.def.seed || 1) * 13 + 5);
    // ---- stakes and tape along both edges
    const stakeGeo = this.track_(new THREE.BoxGeometry(0.05, 1.0, 0.05));
    stakeGeo.translate(0, 0.5, 0);
    const stakeMat = this.track_(new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 }));
    const stakes = [];
    const tapePos = [], tapeUv = [], tapeIdx = [];
    const tapeTex = this.track_(makeTapeTexture());
    const step = 6;
    const gateS = track.gateS;
    for (const side of [1, -1]) {
      let prev = null;
      for (let s = 0; s < track.length; s += step) {
        const w = track.interp(track.W, s);
        const B = track.interp(track.B, s);
        const outer = (B > 0 && side < 0) || (B < 0 && side > 0);
        const d = side * (w + 1.4 + (outer ? Math.abs(B) * 1.6 + 1.2 : 0));
        const p = track.pose(s, d);
        const nearGate = Math.abs(track.wrapS(s - gateS + 12)) < 18;
        // do not place on top of another section of track
        const pr = track.project(p.x, p.z);
        const otherW = track.interp(track.W, pr.s);
        const onOther = Math.abs(track.wrapS(pr.s - s + track.length / 2) - track.length / 2) > 25 && pr.dist < otherW + 1.2;
        if (nearGate || onOther) { prev = null; continue; }
        const h = hf.height(p.x, p.z);
        const pt = new THREE.Vector3(p.x, h, p.z);
        stakes.push(pt);
        if (prev && prev.distanceTo(pt) < step * 1.6) {
          const base = tapePos.length / 3;
          const y0 = 0.82, y1 = 0.9;
          tapePos.push(prev.x, prev.y + y0, prev.z, prev.x, prev.y + y1, prev.z, pt.x, pt.y + y0, pt.z, pt.x, pt.y + y1, pt.z);
          const L = prev.distanceTo(pt) / 0.8;
          tapeUv.push(0, 0, 0, 1, L, 0, L, 1);
          tapeIdx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
        }
        prev = pt;
      }
    }
    const stakeIM = new THREE.InstancedMesh(stakeGeo, stakeMat, stakes.length);
    const m = new THREE.Matrix4();
    stakes.forEach((p, i) => {
      m.makeTranslation(p.x, p.y - 0.1, p.z);
      stakeIM.setMatrixAt(i, m);
    });
    stakeIM.castShadow = q.shadows;
    stakeIM.computeBoundingSphere();
    this.group.add(stakeIM);
    const tgeo = this.track_(new THREE.BufferGeometry());
    tgeo.setAttribute('position', new THREE.Float32BufferAttribute(tapePos, 3));
    tgeo.setAttribute('uv', new THREE.Float32BufferAttribute(tapeUv, 2));
    tgeo.setIndex(tapeIdx);
    tgeo.computeVertexNormals();
    const tmat = this.track_(new THREE.MeshStandardMaterial({ map: tapeTex, side: THREE.DoubleSide, roughness: 0.7 }));
    const tape = new THREE.Mesh(tgeo, tmat);
    tape.castShadow = false;
    this.group.add(tape);

    // ---- start gate
    this._startGate();
    // ---- finish line + gantry
    this._finishLine();
    // ---- banners near lips and corners
    this._banners(rng);
    // ---- tire barriers / hay bales on the outside of tight corners
    this._barriers(rng);
  }

  _startGate() {
    const track = this.track, hf = this.hf;
    const s = track.gateS;
    const w = track.interp(track.W, s);
    const p0 = track.pose(s, 0);
    const slot = 1.05;
    const count = Math.max(4, Math.floor((w * 2 - 1.2) / slot));
    const width = count * slot;
    const heading = Math.atan2(p0.tx, p0.tz);
    const group = new THREE.Group();
    const h0 = hf.height(p0.x, p0.z);
    group.position.set(p0.x, h0, p0.z);
    group.rotation.y = heading;
    this.group.add(group);
    const metal = this.track_(new THREE.MeshStandardMaterial({ color: 0x9aa2ab, metalness: 0.8, roughness: 0.4 }));
    const dark = this.track_(new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 0.5, roughness: 0.6 }));
    const pad = this.track_(new THREE.MeshStandardMaterial({ color: 0x8b8378, roughness: 0.95 }));
    // concrete pad behind the gate (thin decal, no collision)
    const padGeo = this.track_(new THREE.BoxGeometry(width + 0.6, 0.04, 3.2));
    const padMesh = new THREE.Mesh(padGeo, pad);
    padMesh.position.set(0, 0.0, -1.7);
    padMesh.receiveShadow = true;
    group.add(padMesh);
    // base bar and side posts
    const bar = new THREE.Mesh(this.track_(new THREE.BoxGeometry(width + 0.4, 0.12, 0.18)), dark);
    bar.position.set(0, 0.06, 0);
    bar.castShadow = true;
    group.add(bar);
    for (const sx of [-1, 1]) {
      const post = new THREE.Mesh(this.track_(new THREE.BoxGeometry(0.25, 1.1, 0.4)), dark);
      post.position.set(sx * (width / 2 + 0.35), 0.55, 0);
      post.castShadow = true;
      group.add(post);
    }
    // gates (hinged at the bottom front edge)
    const gGeo = this.track_(new THREE.BoxGeometry(slot - 0.08, 0.52, 0.035));
    gGeo.translate(0, 0.26, 0);
    const gates = new THREE.InstancedMesh(gGeo, metal, count);
    gates.castShadow = true;
    group.add(gates);
    this.gate = { group, gates, count, slot, width, angle: Math.PI / 2, target: Math.PI / 2, heading, pos: new THREE.Vector3(p0.x, h0, p0.z), collider: null };
    this._updateGateMatrices();
    // numbers on the pad (paint) skipped; colliders for the posts
    for (const sx of [-1, 1]) {
      const px = p0.x + Math.cos(heading) * sx * (width / 2 + 0.35) * -1;
      const pz = p0.z + Math.sin(heading) * sx * (width / 2 + 0.35);
      void px; void pz;
    }
    const lx = Math.cos(heading), lz = -Math.sin(heading); // local +X in world
    for (const sx of [-1, 1]) {
      const off = sx * (width / 2 + 0.35);
      this.colliders.addCircle(p0.x + lx * off, p0.z + lz * off, 0.3, h0 - 1, h0 + 1.2, 'the start gate');
    }
  }

  _updateGateMatrices() {
    const g = this.gate;
    const m = new THREE.Matrix4(), r = new THREE.Matrix4();
    for (let i = 0; i < g.count; i++) {
      const x = -g.width / 2 + g.slot * (i + 0.5);
      m.makeTranslation(x, 0.12, 0.09);
      r.makeRotationX(g.angle);
      m.multiply(r);
      g.gates.setMatrixAt(i, m);
    }
    g.gates.instanceMatrix.needsUpdate = true;
    g.gates.computeBoundingSphere();
  }

  /** Raise (false) or drop (true) the starting gate. */
  setGateDown(down, instant = false) {
    const g = this.gate;
    if (!g) return;
    g.target = down ? Math.PI / 2 : 0;
    if (instant) {
      g.angle = g.target;
      this._updateGateMatrices();
    }
    // collider while the gate is up
    if (!down && !g.collider) {
      const lx = Math.cos(g.heading), lz = -Math.sin(g.heading);
      g.collider = this.colliders.addSegment(g.pos.x - lx * g.width / 2, g.pos.z - lz * g.width / 2, g.pos.x + lx * g.width / 2, g.pos.z + lz * g.width / 2, 0.15, g.pos.y - 1, g.pos.y + 0.7, 'the start gate');
    } else if (down && g.collider) {
      g.collider.y1 = -1e9; // disable
      g.collider.y0 = -1e9;
      g.collider = null;
    }
  }

  _finishLine() {
    const track = this.track, hf = this.hf;
    const s = track.finishS;
    const w = track.interp(track.W, s);
    const p = track.pose(s, 0);
    const heading = Math.atan2(p.tx, p.tz);
    const h = hf.height(p.x, p.z);
    const group = new THREE.Group();
    group.position.set(p.x, h, p.z);
    group.rotation.y = heading;
    this.group.add(group);
    const checker = this.track_(makeCheckerTexture());
    checker.repeat.set(Math.round(w * 2 / 1.2), 1);
    const lineMat = this.track_(new THREE.MeshStandardMaterial({ map: checker, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 }));
    // ground strip: a few segments following the terrain across the track
    const segs = 12;
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= segs; i++) {
      const d = -w + (2 * w * i) / segs;
      const a = track.pose(s, d);
      for (const dz of [-0.6, 0.6]) {
        const x = a.x + p.tx * dz, z = a.z + p.tz * dz;
        const y = hf.height(x, z) + 0.03;
        // into group-local coordinates
        const lx = (x - p.x) * Math.cos(heading) - (z - p.z) * Math.sin(heading);
        const lz = (x - p.x) * Math.sin(heading) + (z - p.z) * Math.cos(heading);
        pos.push(lx, y - h, lz);
        uv.push(i / segs, dz < 0 ? 0 : 1);
      }
      if (i < segs) {
        const b = i * 2;
        idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
    }
    const lg = this.track_(new THREE.BufferGeometry());
    lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    lg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    lg.setIndex(idx);
    lg.computeVertexNormals();
    const line = new THREE.Mesh(lg, lineMat);
    line.receiveShadow = true;
    group.add(line);
    // gantry
    const pillarMat = this.track_(new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.5, metalness: 0.3 }));
    const span = w + 2.2;
    for (const sx of [-1, 1]) {
      const pil = new THREE.Mesh(this.track_(new THREE.BoxGeometry(0.45, 5.6, 0.45)), pillarMat);
      pil.position.set(sx * span, 2.8, 0);
      pil.castShadow = true;
      group.add(pil);
      const lxw = Math.cos(heading), lzw = -Math.sin(heading);
      this.colliders.addCircle(p.x + lxw * sx * span, p.z + lzw * sx * span, 0.35, h - 1, h + 6, 'the finish gantry');
    }
    const beam = new THREE.Mesh(this.track_(new THREE.BoxGeometry(span * 2 + 0.45, 1.2, 0.3)), pillarMat);
    beam.position.set(0, 5.4, 0);
    beam.castShadow = true;
    group.add(beam);
    const ftex = this.track_(makeBannerTexture('FINISH', '#111111', '#ffffff', '#f26a10'));
    const fmat = this.track_(new THREE.MeshStandardMaterial({ map: ftex, roughness: 0.6 }));
    for (const sz of [-1, 1]) {
      const pl = new THREE.Mesh(this.track_(new THREE.PlaneGeometry(span * 2, 1.05)), fmat);
      pl.position.set(0, 5.4, sz * 0.16);
      if (sz < 0) pl.rotation.y = Math.PI;
      group.add(pl);
    }
  }

  _banners(rng) {
    const track = this.track, hf = this.hf;
    const spots = [];
    for (const f of track.features) {
      if (f.lips.length && f.type !== 'rhythm') spots.push(f.lips[0] + 2);
      else spots.push((f.s0 + f.s1) / 2);
    }
    // a few extra spots along straights
    for (let k = 0; k < 4; k++) spots.push(track.length * (0.12 + k * 0.22));
    const poleMat = this.track_(new THREE.MeshStandardMaterial({ color: 0x222226, metalness: 0.6, roughness: 0.5 }));
    const backMat = this.track_(new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.8 }));
    let k = 0;
    const max = Math.round(16 * this.q.props);
    for (const s0 of spots) {
      if (k >= max) break;
      const sp = SPONSORS[k % SPONSORS.length];
      let placed = false;
      for (const side of rng() < 0.5 ? [1, -1] : [-1, 1]) {
        const w = track.interp(track.W, s0);
        const d = side * (w + 5.5);
        const p = track.pose(s0, d);
        if (!this._free(p.x, p.z, 3.5)) continue;
        const h = hf.height(p.x, p.z);
        const g = new THREE.Group();
        g.position.set(p.x, h, p.z);
        // face the track: banner normal points toward centerline
        const heading = Math.atan2(p.tx, p.tz);
        g.rotation.y = heading + (side > 0 ? -Math.PI / 2 : Math.PI / 2);
        const tex = this.track_(makeBannerTexture(sp[0], sp[1], sp[2], sp[3]));
        const mat = this.track_(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.65 }));
        const front = new THREE.Mesh(this.track_(new THREE.PlaneGeometry(4.2, 1.05)), mat);
        front.position.set(0, 1.0, 0.02);
        front.castShadow = true;
        g.add(front);
        const back = new THREE.Mesh(this.track_(new THREE.PlaneGeometry(4.2, 1.05)), backMat);
        back.position.set(0, 1.0, -0.02);
        back.rotation.y = Math.PI;
        g.add(back);
        for (const sx of [-1, 1]) {
          const pole = new THREE.Mesh(this.track_(new THREE.CylinderGeometry(0.04, 0.04, 1.6, 6)), poleMat);
          pole.position.set(sx * 2.15, 0.8, 0);
          g.add(pole);
        }
        this.group.add(g);
        const ux = Math.cos(g.rotation.y), uz = -Math.sin(g.rotation.y);
        this.colliders.addSegment(p.x - ux * 2.1, p.z - uz * 2.1, p.x + ux * 2.1, p.z + uz * 2.1, 0.12, h - 1, h + 1.6, 'a banner');
        placed = true;
        break;
      }
      if (placed) k++;
    }
  }

  _barriers(rng) {
    const track = this.track, hf = this.hf;
    // tire stack geometry
    const tires = [];
    for (let i = 0; i < 3; i++) {
      const t = new THREE.TorusGeometry(0.3, 0.12, 8, 16);
      t.rotateX(Math.PI / 2);
      t.translate(0, 0.12 + i * 0.24, 0);
      tires.push(t);
    }
    const stackGeo = this.track_(merge(tires));
    const tireMat = this.track_(new THREE.MeshStandardMaterial({ color: 0x1a1a1b, roughness: 0.9 }));
    const hay = this.track_(new THREE.CylinderGeometry(0.55, 0.55, 1.2, 12));
    hay.rotateZ(Math.PI / 2);
    hay.translate(0, 0.5, 0);
    const hayMat = this.track_(new THREE.MeshStandardMaterial({ color: 0xc8a75a, roughness: 1 }));
    const stackM = [], hayM = [];
    const m = new THREE.Matrix4(), qq = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1), pos = new THREE.Vector3();
    let corner = 0;
    for (const p of track.prims) {
      if (p.kind !== 'arc' || p.r > 20 || p.ang < 1.2) continue;
      corner++;
      const useTires = corner % 2 === 1;
      for (let s = p.s0 - 4; s < p.s1 + 4; s += useTires ? 0.72 : 1.3) {
        const w = track.interp(track.W, s);
        const B = track.interp(track.B, s);
        const side = B > 0 ? -1 : 1;
        const d = side * (w + Math.abs(B) * 1.6 + 4.6);
        const q = track.pose(s, d);
        if (!this._free(q.x, q.z, 2.8)) continue;
        const h = hf.height(q.x, q.z);
        pos.set(q.x, h - 0.05, q.z);
        qq.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(q.tx, q.tz) + (useTires ? rng() : Math.PI / 2));
        m.compose(pos, qq, sc);
        if (useTires) {
          stackM.push(m.clone());
          this.colliders.addCircle(q.x, q.z, 0.4, h - 1, h + 0.75, 'the tire wall');
        } else {
          hayM.push(m.clone());
          this.colliders.addCircle(q.x, q.z, 0.55, h - 1, h + 1.05, 'a hay bale');
        }
      }
    }
    if (stackM.length) {
      const im = new THREE.InstancedMesh(stackGeo, tireMat, stackM.length);
      stackM.forEach((mm, i) => im.setMatrixAt(i, mm));
      im.castShadow = this.q.shadows;
      im.computeBoundingSphere();
      this.group.add(im);
    }
    if (hayM.length) {
      const im = new THREE.InstancedMesh(hay, hayMat, hayM.length);
      hayM.forEach((mm, i) => im.setMatrixAt(i, mm));
      im.castShadow = this.q.shadows;
      im.computeBoundingSphere();
      this.group.add(im);
    }
  }

  // ---------------------------------------------------------------------------------
  _venue() {
    const track = this.track, hf = this.hf, q = this.q;
    const rng = makeRng((track.def.seed || 1) * 31 + 7);
    // ---- perimeter fence (posts and rails) around the venue
    const half = hf.half;
    const b = track.bounds;
    const margin = 42;
    const x0 = Math.max(-half + 6, b.minX - margin), x1 = Math.min(half - 6, b.maxX + margin);
    const z0 = Math.max(-half + 6, b.minZ - margin), z1 = Math.min(half - 6, b.maxZ + margin);
    const postGeo = this.track_(new THREE.CylinderGeometry(0.07, 0.08, 1.3, 6));
    postGeo.translate(0, 0.55, 0);
    const woodMat = this.track_(new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.9 }));
    const posts = [];
    const rails = [];
    const edges = [[x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0]];
    for (const [ax, az, bx, bz] of edges) {
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.round(len / 3));
      let prev = null;
      for (let i = 0; i <= n; i++) {
        const x = ax + ((bx - ax) * i) / n, z = az + ((bz - az) * i) / n;
        if (this._trackDistAt(x, z) < 12 || this._inPits(x, z, 2)) { prev = null; continue; }
        const h = hf.height(x, z);
        const p = new THREE.Vector3(x, h, z);
        posts.push(p);
        if (prev) {
          rails.push([prev, p]);
          this.colliders.addSegment(prev.x, prev.z, p.x, p.z, 0.12, Math.min(prev.y, p.y) - 1, Math.max(prev.y, p.y) + 1.2, 'the fence');
        }
        prev = p;
      }
    }
    if (posts.length) {
      const im = new THREE.InstancedMesh(postGeo, woodMat, posts.length);
      const m = new THREE.Matrix4();
      posts.forEach((p, i) => { m.makeTranslation(p.x, p.y, p.z); im.setMatrixAt(i, m); });
      im.castShadow = q.shadows;
      im.computeBoundingSphere();
      this.group.add(im);
    }
    if (rails.length) {
      const railGeo = this.track_(new THREE.BoxGeometry(0.06, 0.1, 1));
      const im = new THREE.InstancedMesh(railGeo, woodMat, rails.length * 2);
      const m = new THREE.Matrix4(), qq = new THREE.Quaternion(), sc = new THREE.Vector3(), mid = new THREE.Vector3(), dir = new THREE.Vector3();
      let k = 0;
      for (const [a, c] of rails) {
        dir.subVectors(c, a);
        const len = dir.length();
        qq.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize());
        for (const y of [0.55, 1.0]) {
          mid.addVectors(a, c).multiplyScalar(0.5);
          mid.y += y;
          sc.set(1, 1, len);
          m.compose(mid, qq, sc);
          im.setMatrixAt(k++, m);
        }
      }
      im.castShadow = q.shadows;
      im.computeBoundingSphere();
      this.group.add(im);
    }

    // ---- pits: garages, vans, tents, porta-johns on the gravel area
    for (const pit of hf.pits || []) this._pits(pit, rng);

    // ---- spectators: bleachers near the start and the biggest jump
    this._spectators(rng);
  }

  _pits(pit, rng) {
    const q = this.q;
    const heading = Math.atan2(pit.ux, pit.uz);
    const at = (lx, lz) => ({ x: pit.x + pit.ux * lx + pit.vx * lz, z: pit.z + pit.uz * lx + pit.vz * lz });
    const wallMat = this.track_(new THREE.MeshStandardMaterial({ color: 0xd9d6cf, roughness: 0.85 }));
    const roofMat = this.track_(new THREE.MeshStandardMaterial({ color: 0x5b6670, roughness: 0.6, metalness: 0.4 }));
    const doorMat = this.track_(new THREE.MeshStandardMaterial({ color: 0x33383d, roughness: 0.7, metalness: 0.3 }));
    const winTex = this.track_(makeWindowTexture());
    winTex.repeat.set(2, 1);
    const winMat = this.track_(new THREE.MeshStandardMaterial({ map: winTex, roughness: 0.6 }));
    // pit-local frame: lx along the track, lz along the side normal; far side is away from the track
    const side = pit.side || 1;
    const farZ = side * (pit.hd - 5);
    // timing tower near the start of the pit area
    {
      const c = at(-pit.hw + 6, -farZ * 0.2);
      const h = this.hf.height(c.x, c.z);
      const g = new THREE.Group();
      g.position.set(c.x, h, c.z);
      g.rotation.y = heading;
      const body = new THREE.Mesh(this.track_(new THREE.BoxGeometry(4, 6.5, 4)), winMat);
      body.position.y = 3.25;
      body.castShadow = q.shadows;
      g.add(body);
      const roof = new THREE.Mesh(this.track_(new THREE.BoxGeometry(5, 0.3, 5)), roofMat);
      roof.position.y = 6.65;
      g.add(roof);
      this.group.add(g);
      this.colliders.addBox(c.x, c.z, 2.1, 2.1, heading, h - 1, h + 7, 'the timing tower');
    }
    // garages along the far side
    const nG = 3;
    for (let i = 0; i < nG; i++) {
      const c = at(-pit.hw * 0.45 + i * 9.5, farZ - side * 1.5);
      const h = this.hf.height(c.x, c.z);
      const g = new THREE.Group();
      g.position.set(c.x, h, c.z);
      g.rotation.y = heading;
      const body = new THREE.Mesh(this.track_(new THREE.BoxGeometry(6, 3.4, 8)), wallMat);
      body.position.y = 1.7;
      body.castShadow = q.shadows;
      body.receiveShadow = true;
      g.add(body);
      const roof = new THREE.Mesh(this.track_(new THREE.BoxGeometry(6.8, 0.25, 8.6)), roofMat);
      roof.position.y = 3.5;
      roof.rotation.z = 0.08 * side;
      g.add(roof);
      const door = new THREE.Mesh(this.track_(new THREE.PlaneGeometry(6, 2.8)), doorMat);
      door.position.set(-side * 3.01, 1.4, 0);
      door.rotation.y = -side * Math.PI / 2;
      g.add(door);
      this.group.add(g);
      this.colliders.addBox(c.x, c.z, 3.1, 4.1, heading, h - 1, h + 3.6, 'a garage');
    }
    // team vans
    const vanColors = [0xf26a10, 0x1f5fd6, 0xd4241c, 0x2fae3c, 0xeeeeee, 0x1b1b1d];
    const vanBodyGeo = this.track_(new THREE.BoxGeometry(2.1, 2.3, 5.2));
    const cabGeo = this.track_(new THREE.BoxGeometry(2.0, 1.5, 1.4));
    const wheelGeo = this.track_(new THREE.CylinderGeometry(0.38, 0.38, 0.25, 12));
    wheelGeo.rotateZ(Math.PI / 2);
    const tireMat = this.track_(new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 }));
    const glassMat = this.track_(new THREE.MeshStandardMaterial({ color: 0x1d2a33, roughness: 0.1, metalness: 0.6 }));
    for (let i = 0; i < 4; i++) {
      const c = at(-pit.hw * 0.6 + i * 12 + rng() * 3, farZ * 0.15 + (rng() - 0.5) * 4);
      const h = this.hf.height(c.x, c.z);
      const g = new THREE.Group();
      g.position.set(c.x, h, c.z);
      g.rotation.y = heading + Math.PI / 2 + (rng() - 0.5) * 0.3;
      const mat = this.track_(new THREE.MeshStandardMaterial({ color: vanColors[i % vanColors.length], roughness: 0.4, metalness: 0.2 }));
      const body = new THREE.Mesh(vanBodyGeo, mat);
      body.position.set(0, 1.55, -0.4);
      body.castShadow = q.shadows;
      g.add(body);
      const cab = new THREE.Mesh(cabGeo, mat);
      cab.position.set(0, 1.15, 2.85);
      g.add(cab);
      const ws = new THREE.Mesh(this.track_(new THREE.PlaneGeometry(1.8, 0.8)), glassMat);
      ws.position.set(0, 1.45, 3.56);
      ws.rotation.x = -0.35;
      g.add(ws);
      for (const [wx, wz] of [[1, 2.4], [-1, 2.4], [1, -1.9], [-1, -1.9]]) {
        const wh = new THREE.Mesh(wheelGeo, tireMat);
        wh.position.set(wx * 1.0, 0.38, wz);
        g.add(wh);
      }
      this.group.add(g);
      this.colliders.addBox(c.x, c.z, 1.15, 3.4, g.rotation.y, h - 1, h + 2.8, 'a team van');
    }
    // pop-up tents
    const canopyColors = [0xf26a10, 0x1f5fd6, 0xffffff, 0xd4241c, 0xf2c418];
    for (let i = 0; i < 5; i++) {
      const c = at(-pit.hw * 0.7 + i * 10 + rng() * 2, farZ * 0.55);
      const h = this.hf.height(c.x, c.z);
      const g = new THREE.Group();
      g.position.set(c.x, h, c.z);
      g.rotation.y = heading;
      const cm = this.track_(new THREE.MeshStandardMaterial({ color: canopyColors[i % canopyColors.length], roughness: 0.7, side: THREE.DoubleSide }));
      const canopy = new THREE.Mesh(this.track_(new THREE.ConeGeometry(2.3, 0.8, 4, 1, true)), cm);
      canopy.position.y = 2.75;
      canopy.rotation.y = Math.PI / 4;
      canopy.castShadow = q.shadows;
      g.add(canopy);
      for (const [px, pz] of [[1.5, 1.5], [-1.5, 1.5], [1.5, -1.5], [-1.5, -1.5]]) {
        const pole = new THREE.Mesh(this.track_(new THREE.CylinderGeometry(0.03, 0.03, 2.4, 5)), roofMat);
        pole.position.set(px, 1.2, pz);
        g.add(pole);
        const w = { x: c.x + pit.ux * px + pit.vx * pz, z: c.z + pit.uz * px + pit.vz * pz };
        this.colliders.addCircle(w.x, w.z, 0.1, h - 1, h + 2.5, 'a tent');
      }
      this.group.add(g);
    }
    // porta-johns
    const pjMat = this.track_(new THREE.MeshStandardMaterial({ color: 0x2a5fb8, roughness: 0.6 }));
    for (let i = 0; i < 3; i++) {
      const c = at(pit.hw - 4 - i * 1.6, farZ);
      const h = this.hf.height(c.x, c.z);
      const box = new THREE.Mesh(this.track_(new THREE.BoxGeometry(1.2, 2.3, 1.2)), pjMat);
      box.position.set(c.x, h + 1.15, c.z);
      box.rotation.y = heading;
      box.castShadow = q.shadows;
      this.group.add(box);
      this.colliders.addBox(c.x, c.z, 0.65, 0.65, heading, h - 1, h + 2.3, 'a porta-john');
    }
  }

  _spectators(rng) {
    const track = this.track, hf = this.hf, q = this.q;
    // candidate spots: biggest jump + start straight
    let best = null;
    for (const f of track.features) {
      const hgt = f.spec.h || f.spec.h1 || 0;
      if (!best || hgt > (best.spec.h || best.spec.h1 || 0)) best = f;
    }
    const spots = [];
    if (best) spots.push(best.lips[0] || best.s0);
    spots.push(track.finishS + 25);
    const rhythm = track.features.find((f) => f.type === 'rhythm' || f.type === 'whoops');
    if (rhythm) spots.push((rhythm.s0 + rhythm.s1) / 2);
    const benchMat = this.track_(new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.6, metalness: 0.5 }));
    const bodyGeo = this.track_(new THREE.CapsuleGeometry(0.2, 0.45, 3, 8));
    bodyGeo.translate(0, 0.45, 0);
    const headGeo = this.track_(new THREE.SphereGeometry(0.12, 10, 8));
    headGeo.translate(0, 0.98, 0);
    const bodyMat = this.track_(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }));
    const headMat = this.track_(new THREE.MeshStandardMaterial({ color: 0xd9a886, roughness: 0.7 }));
    const people = [];
    for (const s0 of spots) {
      for (const side of [1, -1]) {
        const w = track.interp(track.W, s0);
        const d = side * (w + 11);
        const p = track.pose(s0, d);
        let ok = true;
        for (const [ox, oz] of [[0, 0], [5, 0], [-5, 0], [0, 3], [0, -3]]) {
          if (!this._free(p.x + p.tx * ox + p.tz * oz, p.z + p.tz * ox - p.tx * oz, 4.5)) ok = false;
        }
        if (!ok) continue;
        const h = hf.height(p.x, p.z);
        const g = new THREE.Group();
        g.position.set(p.x, h, p.z);
        const heading = Math.atan2(p.tx, p.tz);
        g.rotation.y = heading + (side > 0 ? -Math.PI / 2 : Math.PI / 2);
        // bleacher: 4 steps
        for (let k = 0; k < 4; k++) {
          const step = new THREE.Mesh(this.track_(new THREE.BoxGeometry(12, 0.45 * (k + 1), 0.9)), benchMat);
          step.position.set(0, 0.225 * (k + 1), -k * 0.9);
          step.castShadow = q.shadows;
          step.receiveShadow = true;
          g.add(step);
          for (let i = 0; i < 18; i++) {
            if (rng() > 0.8 * q.crowd) continue;
            const pm = new THREE.Matrix4().makeTranslation(-5.6 + i * 0.65 + (rng() - 0.5) * 0.15, 0.45 * (k + 1), -k * 0.9);
            pm.multiply(new THREE.Matrix4().makeRotationY((rng() - 0.5) * 0.6));
            people.push({ local: pm, group: g });
          }
        }
        this.group.add(g);
        g.updateMatrixWorld(true);
        const ux = Math.cos(g.rotation.y), uz = -Math.sin(g.rotation.y);
        const vx = Math.sin(g.rotation.y), vz = Math.cos(g.rotation.y);
        this.colliders.addBox(p.x - vx * 1.35, p.z - vz * 1.35, 6.1, 1.9, g.rotation.y, h - 1, h + 2, 'the bleachers');
        void ux; void uz;
        break;
      }
    }
    if (people.length) {
      const bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, people.length);
      const heads = new THREE.InstancedMesh(headGeo, headMat, people.length);
      const col = new THREE.Color();
      const shirt = [0xd4241c, 0x1f5fd6, 0xf2c418, 0x2fae3c, 0xf26a10, 0xeeeeee, 0x222222, 0x8e44ad, 0x16a085];
      people.forEach((pp, i) => {
        const wm = new THREE.Matrix4().multiplyMatrices(pp.group.matrixWorld, pp.local);
        bodies.setMatrixAt(i, wm);
        heads.setMatrixAt(i, wm);
        col.setHex(shirt[Math.floor(rng() * shirt.length)]);
        bodies.setColorAt(i, col);
      });
      bodies.castShadow = q.shadows;
      bodies.computeBoundingSphere();
      heads.computeBoundingSphere();
      this.group.add(bodies);
      this.group.add(heads);
      this.crowd = bodies;
    }
  }

  // ---------------------------------------------------------------------------------
  update(dt, focus) {
    this.time += dt;
    if (this.grassTime) this.grassTime.value = this.time;
    if (this.sky && this.sky.material.uniforms.time) this.sky.material.uniforms.time.value = this.time;
    // shadow camera follows the focus point, snapped to texels to avoid shimmering
    const sun = this.sun;
    if (sun) {
      const texel = (42 * 2) / this.q.shadowMap;
      const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
      sun.target.position.set(fx, focus.y, fz);
      sun.position.set(fx, focus.y, fz).addScaledVector(this.sunDir, 160);
      sun.target.updateMatrixWorld();
    }
    // gate animation
    const g = this.gate;
    if (g && Math.abs(g.angle - g.target) > 1e-3) {
      const sp = g.target > g.angle ? 5.5 : 3;
      g.angle += clamp(g.target - g.angle, -sp * dt, sp * dt);
      this._updateGateMatrices();
    }
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isInstancedMesh) o.dispose();
    });
    if (this.sky) {
      this.sky.geometry.dispose();
      this.sky.material.dispose();
    }
    for (const d of this.disposables) if (d && d.dispose) d.dispose();
    if (this.envMap) this.envMap.dispose();
    this.scene.environment = null;
    this.scene.fog = null;
    this.scene.remove(this.group);
    this.colliders.clear();
  }
}
void lerp; void smoothstep; void DS;

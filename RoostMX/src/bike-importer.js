// Custom bike import: GLB/GLTF (preferred), OBJ(+MTL), FBX, and PKZ/ZIP archives.
//
// PKZ files (packages used by PiBoSo games such as MX Bikes) are inspected as ZIP
// archives. If they contain a model in a supported interchange format it is loaded; the
// native PiBoSo formats (.edf meshes, .pnt paints, ...) are proprietary and undocumented,
// so they are reported as unsupported instead of pretending they loaded.
//
// After loading, wheels / steering / swingarm are detected by name (or geometry), the
// model is oriented and scaled to the physics wheelbase, and assigned parts are
// re-parented under pivots so the physics can drive steering, suspension and wheel spin.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { unzipSync } from 'three/addons/libs/fflate.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { GEO, AXIS_FRONT, SWINGARM_LENGTH } from './bike-geometry.js';

export const MODEL_EXT = ['glb', 'gltf', 'fbx', 'obj'];
const TEX_EXT = ['png', 'jpg', 'jpeg', 'webp', 'tga', 'dds', 'bmp', 'ktx2', 'gif'];
const PIBOSO_EXT = {
  edf: 'PiBoSo 3D mesh (proprietary, undocumented)',
  edfbin: 'PiBoSo 3D mesh data (proprietary)',
  pnt: 'PiBoSo paint / livery file (proprietary)',
  hlm: 'PiBoSo helmet definition (proprietary)',
  bin: 'Binary data (may belong to a glTF model)',
  scl: 'Engine configuration (not a model)',
  ini: 'Configuration file (not a model)',
  cfg: 'Configuration file (not a model)',
  hrc: 'Configuration / hierarchy file (not a model)',
  jm: 'Configuration file (not a model)',
  gfx: 'Graphics configuration (not a model)',
  tyre: 'Tyre physics data (not a model)',
  trk: 'Track data (not a bike model)',
  lua: 'Script (not a model)',
  txt: 'Text file',
};

export const COMPONENT_SLOTS = [
  { key: 'root', label: 'Bike root (hide everything else)', multi: false },
  { key: 'frontWheel', label: 'Front wheel', multi: true },
  { key: 'rearWheel', label: 'Rear wheel', multi: true },
  { key: 'steering', label: 'Steering assembly', multi: true },
  { key: 'handlebar', label: 'Handlebar', multi: true },
  { key: 'fork', label: 'Front fork (sliding part)', multi: true },
  { key: 'swingarm', label: 'Rear suspension / swingarm', multi: true },
  { key: 'riderPoint', label: 'Rider attachment point', multi: false },
];

export function defaultConfig() {
  return {
    scale: 1,
    pos: [0, 0, 0],
    rot: [0, 0, 0],
    comps: { root: [], frontWheel: [], rearWheel: [], steering: [], handlebar: [], fork: [], swingarm: [], riderPoint: [] },
    rider: { show: true, offset: [0, 0, 0] },
    paint: [],
    animation: '',
    autoFitDone: false,
  };
}

const ext = (name) => {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
};
const base = (name) => (name || '').split(/[\\/]/).pop();

// ---------------------------------------------------------------------------------
// File inspection (PKZ / ZIP / loose files)
// ---------------------------------------------------------------------------------
export async function readFileList(fileList) {
  const out = [];
  for (const f of fileList) out.push({ name: f.name, data: await f.arrayBuffer() });
  return out;
}

function isZip(u8) {
  return u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 3 || u8[2] === 5) && (u8[3] === 4 || u8[3] === 6);
}

function classify(path) {
  const e = ext(path);
  if (MODEL_EXT.includes(e)) return 'model';
  if (e === 'mtl') return 'material';
  if (TEX_EXT.includes(e)) return 'texture';
  if (PIBOSO_EXT[e]) return e === 'bin' ? 'data' : e === 'edf' || e === 'edfbin' || e === 'pnt' || e === 'hlm' ? 'proprietary' : 'config';
  return 'other';
}

/**
 * Expands archives and reports what was found.
 * Returns { files: [{name, data}], report: { archives: [...], model, models, warnings, ok } }
 */
export function inspectFiles(files) {
  const report = { archives: [], warnings: [], models: [], model: null, ok: false };
  const outFiles = [];
  for (const f of files) {
    const e = ext(f.name);
    if (e === 'pkz' || e === 'zip') {
      const u8 = new Uint8Array(f.data);
      const arc = { name: f.name, kind: e.toUpperCase(), isZip: isZip(u8), entries: [], error: '', size: u8.length };
      report.archives.push(arc);
      if (!arc.isZip) {
        arc.error = `${f.name} is not a standard ZIP archive (signature ${Array.from(u8.slice(0, 4)).map((b) => b.toString(16).padStart(2, '0')).join(' ')}). It may be encrypted or use a proprietary container, so it cannot be opened.`;
        continue;
      }
      let entries;
      try {
        entries = unzipSync(u8);
      } catch (err) {
        arc.error = `Could not unpack ${f.name}: ${err.message || err}. The archive may be encrypted or use unsupported compression.`;
        continue;
      }
      for (const path of Object.keys(entries)) {
        const data = entries[path];
        if (path.endsWith('/')) continue;
        const kind = classify(path);
        arc.entries.push({ path, size: data.length, kind, note: PIBOSO_EXT[ext(path)] || '' });
        outFiles.push({ name: path, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), fromArchive: f.name });
      }
      arc.entries.sort((a, b) => a.path.localeCompare(b.path));
    } else {
      outFiles.push(f);
    }
  }
  const models = outFiles.filter((f) => MODEL_EXT.includes(ext(f.name)));
  // preference: glb > gltf > fbx > obj, larger files first within a type
  models.sort((a, b) => MODEL_EXT.indexOf(ext(a.name)) - MODEL_EXT.indexOf(ext(b.name)) || b.data.byteLength - a.data.byteLength);
  report.models = models.map((m) => m.name);
  report.model = models.length ? models[0].name : null;
  const proprietary = [];
  for (const a of report.archives) for (const en of a.entries) if (en.kind === 'proprietary') proprietary.push(en.path);
  for (const f of outFiles) if (!f.fromArchive && classify(f.name) === 'proprietary') proprietary.push(f.name);
  report.proprietary = proprietary;
  if (!report.model) {
    if (proprietary.length) {
      report.warnings.push(
        `No supported 3D model was found. The package contains PiBoSo engine files (${[...new Set(proprietary.map((p) => '.' + ext(p)))].join(', ')}) which use an undocumented proprietary format that this game cannot read.`
      );
    } else if (report.archives.some((a) => a.error)) {
      report.warnings.push('The archive could not be opened.');
    } else {
      report.warnings.push('No .glb, .gltf, .fbx or .obj model was found in the selected files.');
    }
  } else if (proprietary.length) {
    report.warnings.push(`Proprietary files were skipped (${proprietary.length}). The ${ext(report.model).toUpperCase()} model "${base(report.model)}" will be used instead.`);
  }
  if (report.model && ext(report.model) === 'gltf') {
    // check external buffers exist
    report.warnings.push('Loading a .gltf file: select its .bin and texture files together with it (or zip them) so they can be found.');
  }
  report.ok = !!report.model;
  return { files: outFiles, report };
}

export const CONVERSION_GUIDE = [
  'This game reads standard interchange formats: GLB (recommended), GLTF, FBX and OBJ.',
  'MX Bikes style .pkz packages are ZIP archives; their bike meshes are stored as PiBoSo .edf files, which are proprietary and cannot be loaded here.',
  'To ride such a bike, you need the model in an open format: ask the mod author for the source model (most bikes are built in Blender or 3ds Max) or use your own model.',
  'Export from Blender with File > Export > glTF 2.0, Format: glTF Binary (.glb), +Y Up, Apply Modifiers, and Materials/Images included.',
  'Name objects like "wheel_front", "wheel_rear", "fork", "handlebar" and "swingarm" (or assign them in the Components tab) so they animate.',
  'Respect the author\'s licence: many mods do not allow their models to be extracted, converted or redistributed.',
];

// ---------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------
let _draco = null, _ktx2 = null;
function sharedDecoders(renderer) {
  if (!_draco) {
    _draco = new DRACOLoader();
    _draco.setDecoderPath(new URL('dist/draco/', document.baseURI).href);
  }
  if (!_ktx2) {
    _ktx2 = new KTX2Loader();
    _ktx2.setTranscoderPath(new URL('dist/basis/', document.baseURI).href);
    if (renderer) {
      try { _ktx2.detectSupport(renderer); } catch (e) { /* ignore */ }
    }
  }
  return { draco: _draco, ktx2: _ktx2 };
}

/**
 * Load the main model from a set of files. Returns { root, animations, warnings }.
 */
export async function loadModel(files, mainName, renderer) {
  const warnings = [];
  const urls = new Map();
  const created = [];
  for (const f of files) {
    const u = URL.createObjectURL(new Blob([f.data]));
    created.push(u);
    urls.set(base(f.name).toLowerCase(), u);
    urls.set(f.name.toLowerCase().replace(/\\/g, '/'), u);
  }
  const missing = new Set();
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (/^(blob:|data:)/.test(url)) return url;
    let clean = url.split('?')[0].split('#')[0];
    try { clean = decodeURIComponent(clean); } catch (e) { /* keep */ }
    const b = base(clean).toLowerCase();
    if (urls.has(b)) return urls.get(b);
    const rel = clean.replace(/^\.\//, '').toLowerCase();
    if (urls.has(rel)) return urls.get(rel);
    missing.add(base(clean));
    return url;
  });
  manager.addHandler(/\.tga$/i, new TGALoader(manager));
  manager.addHandler(/\.dds$/i, new DDSLoader(manager));
  const main = files.find((f) => f.name === mainName);
  if (!main) throw new Error('Model file not found: ' + mainName);
  const e = ext(main.name);
  let root, animations = [];
  try {
    if (e === 'glb' || e === 'gltf') {
      const { draco, ktx2 } = sharedDecoders(renderer);
      const loader = new GLTFLoader(manager).setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
      const gltf = await new Promise((res, rej) => loader.parse(main.data, '', res, rej));
      root = gltf.scene || gltf.scenes[0];
      animations = gltf.animations || [];
    } else if (e === 'fbx') {
      const loader = new FBXLoader(manager);
      root = loader.parse(main.data, '');
      animations = root.animations || [];
    } else if (e === 'obj') {
      const text = new TextDecoder().decode(main.data);
      const loader = new OBJLoader(manager);
      const mtlFile = files.find((f) => ext(f.name) === 'mtl');
      if (mtlFile) {
        const mtl = new MTLLoader(manager).parse(new TextDecoder().decode(mtlFile.data), '');
        mtl.preload();
        loader.setMaterials(mtl);
      }
      root = loader.parse(text);
    } else {
      throw new Error('Unsupported model format: .' + e);
    }
  } catch (err) {
    created.forEach((u) => URL.revokeObjectURL(u));
    throw new Error(`Failed to load ${base(main.name)}: ${err && err.message ? err.message : err}`);
  }
  // let textures finish loading
  await new Promise((res) => {
    let done = false;
    const finish = () => { if (!done) { done = true; res(); } };
    manager.onLoad = finish;
    setTimeout(finish, 2500);
  });
  if (missing.size) warnings.push('Missing texture/resource files: ' + [...missing].slice(0, 8).join(', ') + (missing.size > 8 ? '…' : ''));
  let meshCount = 0, triCount = 0;
  root.traverse((o) => {
    if (o.isMesh) {
      meshCount++;
      o.castShadow = true;
      o.receiveShadow = true;
      const g = o.geometry;
      triCount += g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m && m.map) m.map.anisotropy = 8;
    }
  });
  if (!meshCount) throw new Error('The model contains no meshes.');
  root.userData.objectUrls = created;
  return { root, animations, warnings, stats: { meshes: meshCount, triangles: Math.round(triCount) } };
}

export function releaseModel(root) {
  if (!root) return;
  (root.userData.objectUrls || []).forEach((u) => URL.revokeObjectURL(u));
  root.traverse((o) => {
    if (o.isMesh) {
      o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) if (m[k]) m[k].dispose();
        m.dispose();
      }
    }
  });
}

// ---------------------------------------------------------------------------------
// Node listing / paths
// ---------------------------------------------------------------------------------
export function nodePath(root, node) {
  const idx = [];
  let n = node;
  while (n && n !== root) {
    const p = n.parent;
    if (!p) break;
    idx.push(p.children.indexOf(n));
    n = p;
  }
  return idx.reverse().join('.');
}

export function nodeByPath(root, path) {
  if (path === '' || path == null) return root;
  let n = root;
  for (const s of String(path).split('.')) {
    n = n.children[+s];
    if (!n) return null;
  }
  return n;
}

export function listNodes(root) {
  const out = [];
  const walk = (n, depth) => {
    if (n !== root) {
      let tris = 0;
      n.traverse((o) => {
        if (o.isMesh) tris += o.geometry.index ? o.geometry.index.count / 3 : o.geometry.getAttribute('position').count / 3;
      });
      out.push({ path: nodePath(root, n), name: n.name || (n.isMesh ? 'mesh' : 'group'), depth, isMesh: !!n.isMesh, tris: Math.round(tris), children: n.children.length });
    }
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(root, -1);
  return out;
}

export function listMaterials(root) {
  const set = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m) set.set(m.name || m.uuid.slice(0, 8), m);
  });
  return [...set.keys()];
}

// ---------------------------------------------------------------------------------
// Auto detection
// ---------------------------------------------------------------------------------
const RX = {
  wheel: /(wheel|tyre|tire|rim|felge|rad\b|roue|rueda|ruota|hub|spoke|disc|disk)/i,
  front: /(front|frnt|^f[_\-. ]|[_\-. ]f$|[_\-. ]f[_\-. ]|fwd|forward|vorder|vorne|avant|ant\b|delant)/i,
  rear: /(rear|back|^r[_\-. ]|[_\-. ]r$|[_\-. ]r[_\-. ]|hinter|hinten|arri|trase|post)/i,
  steering: /(steer|triple|clamp|yoke|front[_ ]?end|frontend|lenk|direction|headset)/i,
  handlebar: /(handle|handlebar|bar\b|bars\b|lenker|guidon|manubrio|grip|lever)/i,
  fork: /(fork|gabel|fourche|forcella|horquilla|stanchion|slider|lower[_ ]?leg)/i,
  swingarm: /(swing|schwinge|bras|basculante|forcellone|shock|linkage|rear[_ ]?susp|chain)/i,
  seat: /(seat|saddle|sitz|selle|sella|rider|driver)/i,
};

function bboxOf(obj, space) {
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  const inv = space ? new THREE.Matrix4().copy(space.matrixWorld).invert() : null;
  obj.updateWorldMatrix(true, true);
  obj.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    tmp.copy(g.boundingBox);
    const m = new THREE.Matrix4().copy(o.matrixWorld);
    if (inv) m.premultiply(inv);
    tmp.applyMatrix4(m);
    box.union(tmp);
  });
  return box;
}

/**
 * Guess component assignments from node names, falling back to geometry (two disk-shaped
 * clusters at the ends of the model are taken as wheels).
 */
export function autoDetect(root) {
  const comps = defaultConfig().comps;
  root.updateWorldMatrix(true, true);
  const nodes = [];
  root.traverse((o) => {
    if (o !== root) nodes.push(o);
  });
  const taken = new Set();
  const isDescOfTaken = (n) => {
    let p = n.parent;
    while (p) {
      if (taken.has(p)) return true;
      p = p.parent;
    }
    return false;
  };
  const pick = (key, test) => {
    for (const n of nodes) {
      const nm = n.name || '';
      if (!nm || taken.has(n) || isDescOfTaken(n)) continue;
      if (test(nm)) {
        comps[key].push(nodePath(root, n));
        taken.add(n);
      }
    }
  };
  pick('frontWheel', (nm) => RX.wheel.test(nm) && RX.front.test(nm) && !RX.rear.test(nm) && !/fender|mudguard|guard/i.test(nm));
  pick('rearWheel', (nm) => RX.wheel.test(nm) && RX.rear.test(nm) && !RX.front.test(nm) && !/fender|mudguard|guard/i.test(nm));
  pick('fork', (nm) => RX.fork.test(nm) && !/guard|protect/i.test(nm));
  pick('handlebar', (nm) => RX.handlebar.test(nm));
  pick('steering', (nm) => RX.steering.test(nm));
  pick('swingarm', (nm) => RX.swingarm.test(nm));
  for (const n of nodes) {
    if (n.name && RX.seat.test(n.name)) {
      comps.riderPoint = [nodePath(root, n)];
      break;
    }
  }
  let method = 'names';
  if (!comps.frontWheel.length || !comps.rearWheel.length) {
    const g = geometricWheels(root, nodes);
    if (g) {
      if (!comps.frontWheel.length) comps.frontWheel = g.a.map((n) => nodePath(root, n));
      if (!comps.rearWheel.length) comps.rearWheel = g.b.map((n) => nodePath(root, n));
      method = 'geometry';
    }
  }
  return { comps, method };
}

function geometricWheels(root, nodes) {
  const meshes = nodes.filter((n) => n.isMesh);
  const whole = bboxOf(root, root);
  const size = whole.getSize(new THREE.Vector3());
  const longAxis = size.x >= size.z ? 'x' : 'z';
  const len = Math.max(size.x, size.z);
  const cands = [];
  for (const m of meshes) {
    const b = bboxOf(m, root);
    const s = b.getSize(new THREE.Vector3());
    const dims = [s.x, s.y, s.z].sort((a, c) => a - c);
    // disk: two similar large dims, one small; diameter ~ 0.25..0.5 of bike length
    if (dims[2] < len * 0.22 || dims[2] > len * 0.55) continue;
    if (dims[1] < dims[2] * 0.75) continue;
    if (dims[0] > dims[2] * 0.5) continue;
    cands.push({ m, b, c: b.getCenter(new THREE.Vector3()), d: dims[2] });
  }
  if (cands.length < 2) return null;
  cands.sort((p, q) => q.d - p.d);
  let A = cands[0], B = null;
  for (const c of cands.slice(1)) {
    if (Math.abs(c.c[longAxis] - A.c[longAxis]) > len * 0.4) { B = c; break; }
  }
  if (!B) return null;
  const collect = (W) => {
    const out = [W.m];
    const grow = W.b.clone().expandByScalar(W.d * 0.03);
    for (const m of meshes) {
      if (m === W.m) continue;
      const b = bboxOf(m, root);
      if (grow.containsBox(b)) out.push(m);
    }
    return out;
  };
  // front = the one nearer the handlebar-ish (higher stuff above); cannot know yet:
  // return as a/b, autoFit decides orientation; caller treats a as front.
  return { a: collect(A), b: collect(B) };
}

/** Compute model adjustments that map detected wheels onto the physics wheel positions. */
export function autoFit(root, comps) {
  root.updateWorldMatrix(true, true);
  const nodesOf = (key) => (comps[key] || []).map((p) => nodeByPath(root, p)).filter(Boolean);
  const fw = nodesOf('frontWheel'), rw = nodesOf('rearWheel');
  const bikeRoot = nodesOf('root')[0] || root;
  const whole = bboxOf(bikeRoot, root);
  if (!fw.length || !rw.length) {
    // fallback: longest horizontal axis as forward, Y up, overall length scaled to 2.15 m
    const s = whole.getSize(new THREE.Vector3());
    const alongX = s.x > s.z;
    const length = Math.max(s.x, s.z);
    const scale = 2.15 / Math.max(length, 1e-6);
    const rotY = alongX ? -90 : 0;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, THREE.MathUtils.degToRad(rotY), 0, 'XYZ'));
    const tb = new THREE.Box3();
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? whole.max.x : whole.min.x, i & 2 ? whole.max.y : whole.min.y, i & 4 ? whole.max.z : whole.min.z);
      tb.expandByPoint(p.applyQuaternion(q).multiplyScalar(scale));
    }
    const c = tb.getCenter(new THREE.Vector3());
    return {
      scale,
      rot: [0, rotY, 0],
      pos: [-c.x, -tb.min.y, -c.z],
      ok: false,
      message: 'Wheels not assigned: fitted by bounding box. Assign the wheels for an exact fit (and use Y rotation 180 if it faces backwards).',
    };
  }
  const box = (list) => {
    const b = new THREE.Box3();
    for (const n of list) b.union(bboxOf(n, root));
    return b;
  };
  const bf = box(fw), br = box(rw);
  const cf = bf.getCenter(new THREE.Vector3()), cr = br.getCenter(new THREE.Vector3());
  const sf = bf.getSize(new THREE.Vector3());
  // wheel axle = thinnest axis of the front wheel box
  const dims = [['x', sf.x], ['y', sf.y], ['z', sf.z]].sort((a, b) => a[1] - b[1]);
  const lat = new THREE.Vector3(dims[0][0] === 'x' ? 1 : 0, dims[0][0] === 'y' ? 1 : 0, dims[0][0] === 'z' ? 1 : 0);
  const fwd = new THREE.Vector3().subVectors(cf, cr);
  fwd.addScaledVector(lat, -fwd.dot(lat));
  const wb = fwd.length();
  fwd.normalize();
  let up = new THREE.Vector3().crossVectors(lat, fwd).normalize();
  const mid = new THREE.Vector3().addVectors(cf, cr).multiplyScalar(0.5);
  const bodyC = whole.getCenter(new THREE.Vector3());
  if (up.dot(new THREE.Vector3().subVectors(bodyC, mid)) < 0) up.negate();
  const left = new THREE.Vector3().crossVectors(up, fwd).normalize();
  // model -> bike rotation: rows are the bike axes expressed in model space
  const m = new THREE.Matrix4().makeBasis(left, up, fwd).invert();
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  const scale = GEO.wheelbase / Math.max(wb, 1e-6);
  // position: map the wheel midpoint onto the physics axle midpoint
  const target = new THREE.Vector3((GEO.frontAxle[0] + GEO.rearAxle[0]) / 2, (GEO.frontAxle[1] + GEO.rearAxle[1]) / 2, (GEO.frontAxle[2] + GEO.rearAxle[2]) / 2);
  const midB = mid.clone().applyQuaternion(q).multiplyScalar(scale);
  const pos = target.sub(midB);
  const radiusF = (Math.max(sf.x, sf.y, sf.z) / 2) * scale;
  return {
    scale,
    rot: [THREE.MathUtils.radToDeg(e.x), THREE.MathUtils.radToDeg(e.y), THREE.MathUtils.radToDeg(e.z)],
    pos: [pos.x, pos.y, pos.z],
    ok: true,
    message: `Fitted to the physics wheelbase (scale ${scale.toFixed(3)}, front wheel radius ${radiusF.toFixed(2)} m).`,
  };
}

// ---------------------------------------------------------------------------------
// Imported visual bound to physics
// ---------------------------------------------------------------------------------
const AXIS = new THREE.Vector3(...AXIS_FRONT);
const _q = new THREE.Quaternion();

export class ImportedBikeVisual {
  /** source: loaded root (kept pristine); a clone is bound with the given config. */
  constructor(source, config, animations = []) {
    this.kind = 'imported';
    this.config = config;
    if (!config.comps.root) config.comps.root = [];
    this.root = new THREE.Group();
    this.root.name = 'importedBike';
    this.model = SkeletonUtils.clone(source);
    // remember each node's path in the source so picks/highlights map back to config paths
    this.model.traverse((o) => {
      o.userData.srcPath = nodePath(this.model, o);
    });
    this.adjust = new THREE.Group();
    this.adjust.name = 'adjust';
    this.adjust.add(this.model);
    this.root.add(this.adjust);
    this.applyAdjust();
    this.mixer = null;
    this.paintMats = [];
    this.warnings = [];
    this._bind(animations);
  }

  applyAdjust() {
    const c = this.config;
    this.adjust.scale.setScalar(c.scale || 1);
    this.adjust.rotation.set(
      THREE.MathUtils.degToRad(c.rot[0] || 0),
      THREE.MathUtils.degToRad(c.rot[1] || 0),
      THREE.MathUtils.degToRad(c.rot[2] || 0),
      'XYZ'
    );
    this.adjust.position.set(c.pos[0] || 0, c.pos[1] || 0, c.pos[2] || 0);
    this.root.updateMatrixWorld(true);
  }

  _bind(animations) {
    const root = this.root;
    root.updateMatrixWorld(true);
    const get = (key) => (this.config.comps[key] || []).map((p) => nodeByPath(this.model, p)).filter(Boolean);
    const fa = new THREE.Vector3(...GEO.frontAxle);
    const pv = new THREE.Vector3(...GEO.swingPivot);
    // pivots in bike space
    this.steerPivot = new THREE.Group();
    this.steerPivot.position.copy(fa);
    root.add(this.steerPivot);
    this.forkSlide = new THREE.Group();
    this.steerPivot.add(this.forkSlide);
    this.swingPivot = new THREE.Group();
    this.swingPivot.position.copy(pv);
    root.add(this.swingPivot);
    root.updateMatrixWorld(true);
    const used = new Set();
    const safeAttach = (parent, node, label) => {
      if (!node || used.has(node)) return false;
      // refuse if an ancestor was already moved (it carries the node along already)
      let p = node.parent;
      while (p) {
        if (used.has(p)) return false;
        p = p.parent;
      }
      parent.attach(node);
      used.add(node);
      void label;
      return true;
    };
    const centerOf = (nodes) => {
      const b = new THREE.Box3();
      for (const n of nodes) b.union(bboxOf(n, root));
      return b.isEmpty() ? null : b.getCenter(new THREE.Vector3());
    };
    const fwNodes = get('frontWheel'), rwNodes = get('rearWheel');
    const fwC = centerOf(fwNodes), rwC = centerOf(rwNodes);
    // steering + handlebar rotate with the steer pivot
    for (const n of [...get('steering'), ...get('handlebar')]) safeAttach(this.steerPivot, n, 'steering');
    // fork lowers slide
    for (const n of get('fork')) safeAttach(this.forkSlide, n, 'fork');
    // front wheel spins around its own center
    this.frontWheelPivot = new THREE.Group();
    this.forkSlide.add(this.frontWheelPivot);
    root.updateMatrixWorld(true);
    if (fwC) {
      const local = this.forkSlide.worldToLocal(root.localToWorld(fwC.clone()));
      this.frontWheelPivot.position.copy(local);
      root.updateMatrixWorld(true);
      for (const n of fwNodes) safeAttach(this.frontWheelPivot, n, 'front wheel');
    } else this.warnings.push('Front wheel not assigned: it will not spin or steer.');
    // swingarm & rear wheel
    for (const n of get('swingarm')) safeAttach(this.swingPivot, n, 'swingarm');
    this.rearWheelPivot = new THREE.Group();
    this.swingPivot.add(this.rearWheelPivot);
    root.updateMatrixWorld(true);
    if (rwC) {
      const local = this.swingPivot.worldToLocal(root.localToWorld(rwC.clone()));
      this.rearWheelPivot.position.copy(local);
      root.updateMatrixWorld(true);
      for (const n of rwNodes) safeAttach(this.rearWheelPivot, n, 'rear wheel');
    } else this.warnings.push('Rear wheel not assigned: it will not spin or follow the suspension.');
    // rider attachment
    const rp = get('riderPoint')[0];
    this.riderAnchor = null;
    if (rp) {
      const b = bboxOf(rp, root);
      const c = b.isEmpty() ? rp.getWorldPosition(new THREE.Vector3()) : b.getCenter(new THREE.Vector3());
      this.riderAnchor = root.worldToLocal(c);
    }
    // optional bike root: hide anything outside it (stands, ground planes, extra props)
    const rootPath = (this.config.comps.root || [])[0];
    if (rootPath != null && rootPath !== '') {
      const inside = (p) => p === rootPath || (typeof p === 'string' && p.startsWith(rootPath + '.'));
      this.model.traverse((o) => {
        if (o.isMesh && !inside(o.userData.srcPath)) o.visible = false;
      });
    }
    // paintable materials
    const paint = new Set(this.config.paint || []);
    if (paint.size) {
      this.model.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m, i) => {
          if (m && paint.has(m.name || m.uuid.slice(0, 8))) {
            const c = m.clone();
            this.paintMats.push(c);
            if (Array.isArray(o.material)) o.material[i] = c;
            else o.material = c;
          }
        });
      });
    }
    // animations
    if (animations && animations.length && this.config.animation) {
      const clip = animations.find((a) => a.name === this.config.animation);
      if (clip) {
        this.mixer = new THREE.AnimationMixer(this.model);
        this.mixer.clipAction(clip).play();
      }
    }
    this.model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }

  /** Rider offset relative to the default seat position (bike space). */
  riderOffset(out) {
    const o = this.config.rider.offset;
    out.set(o[0] || 0, o[1] || 0, o[2] || 0);
    if (this.riderAnchor) {
      out.x += this.riderAnchor.x - GEO.seat[0];
      out.y += this.riderAnchor.y - GEO.seat[1];
      out.z += this.riderAnchor.z - GEO.seat[2];
    }
    return out;
  }

  setColor(hex) {
    for (const m of this.paintMats) if (m.color) m.color.set(hex);
  }

  update(st, dt = 0) {
    _q.setFromAxisAngle(AXIS, -st.steer);
    this.steerPivot.quaternion.copy(_q);
    this.forkSlide.position.copy(AXIS).multiplyScalar(st.compF - GEO.sagF);
    this.frontWheelPivot.rotation.x = st.spinF;
    this.swingPivot.rotation.x = (st.compR - GEO.sagR) / SWINGARM_LENGTH;
    this.rearWheelPivot.rotation.x = st.spinR;
    if (this.mixer && dt) this.mixer.update(dt);
  }

  grips(outL, outR, steer) {
    const fa = new THREE.Vector3(...GEO.frontAxle);
    _q.setFromAxisAngle(AXIS, -steer);
    outL.set(GEO.grips[0], GEO.grips[1], GEO.grips[2]).sub(fa).applyQuaternion(_q).add(fa);
    outR.set(-GEO.grips[0], GEO.grips[1], GEO.grips[2]).sub(fa).applyQuaternion(_q).add(fa);
  }

  dispose() {
    // geometry/materials are shared with the source model (released separately)
    for (const m of this.paintMats) m.dispose();
    if (this.mixer) this.mixer.stopAllAction();
  }
}

/** Highlight helper for the garage: returns a box helper around nodes. */
export function boundsOf(root, paths, space) {
  const b = new THREE.Box3();
  for (const p of paths) {
    const n = nodeByPath(root, p);
    if (n) b.union(bboxOf(n, space));
  }
  return b;
}

export { bboxOf, ext as fileExt };

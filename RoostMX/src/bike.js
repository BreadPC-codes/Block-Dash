// Procedural motocross bike model, built in "bike space" (see bike-geometry.js) with
// a hierarchy that lets the physics drive steering, fork travel, swingarm travel, the
// rear shock and wheel spin.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GEO, AXIS_FRONT, SWINGARM_LENGTH } from './bike-geometry.js';
import { makeBikeAtlas } from './textures.js';
import { makePartMaterial, setPaint, bakePart, mergeBaked } from './part-material.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

export const BIKE_COLORS = {
  red: '#d4241c',
  blue: '#1f5fd6',
  green: '#2fae3c',
  black: '#1b1b1d',
  white: '#ececec',
  orange: '#f26a10',
  yellow: '#f2c418',
};

// Material looks, baked per vertex into one shared "part" material (see part-material.js).
const LOOKS = {
  paint: { color: 0xffffff, roughness: 0.38, metalness: 0.02, paint: 1 },
  white: { color: 0xf1f1ef, roughness: 0.45 },
  black: { color: 0x141416, roughness: 0.62 },
  alu: { color: 0xb9bec5, roughness: 0.32, metalness: 0.85 },
  darkAlu: { color: 0x3a3d42, roughness: 0.42, metalness: 0.8 },
  chrome: { color: 0xe8e8ea, roughness: 0.1, metalness: 1 },
  gold: { color: 0xd1a12a, roughness: 0.28, metalness: 0.9 },
  rubber: { color: 0x18181a, roughness: 0.93 },
  engine: { color: 0x2b2c2f, roughness: 0.5, metalness: 0.55 },
  pipe: { color: 0x9c8c7c, roughness: 0.3, metalness: 0.9 },
  muffler: { color: 0xc7c9cc, roughness: 0.25, metalness: 0.9 },
  seat: { color: 0x161617, roughness: 0.82 },
  spring: { color: 0xe3b41a, roughness: 0.35, metalness: 0.4 },
  disc: { color: 0x8b8e93, roughness: 0.25, metalness: 1 },
  plate: { color: 0xffffff, roughness: 0.45 },
};
// number plate occupies the top 3/4 of the atlas, everything else samples the white strip
const PLATE_UV = (u, v, o) => { o[0] = 0.02 + u * 0.96; o[1] = 0.255 + v * 0.74; };
const WHITE_UV = [0.5, 0.1];

/** Collects pieces of every rigid part; baked into a single skinned mesh (1 draw call). */
class SkinBuilder {
  constructor() {
    this.items = [];
    this.skinBones = [];
  }
  /** A bone that carries geometry. */
  part(name, parent) {
    const b = new THREE.Bone();
    b.name = name;
    if (parent) parent.add(b);
    this.skinBones.push(b);
    return new Parts(this, this.skinBones.length - 1, b);
  }
  add(key, geo, bone) {
    this.items.push({ key, geo, bone });
  }
  build(material) {
    const baked = this.items.map(({ key, geo, bone }) => {
      const look = LOOKS[key];
      const g = bakePart(geo, { ...look, bone, uv: key === 'plate' ? undefined : WHITE_UV, uvMap: key === 'plate' ? PLATE_UV : undefined });
      geo.dispose();
      return g;
    });
    const geo = mergeBaked(baked);
    geo.computeBoundingSphere();
    const mesh = new THREE.SkinnedMesh(geo, material);
    mesh.name = 'bikeMesh';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    const skeleton = new THREE.Skeleton(this.skinBones, this.skinBones.map(() => new THREE.Matrix4()));
    mesh.bind(skeleton, new THREE.Matrix4());
    return mesh;
  }
}

class Parts {
  constructor(builder, index, bone) {
    this.builder = builder;
    this.index = index;
    this.bone = bone;
  }
  add(key, geo) {
    this.builder.add(key, geo, this.index);
    return geo;
  }
}

// --- geometry helpers -------------------------------------------------------------
function tube(points, r, segs = 24, radial = 8, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points, closed, 'centripetal');
  return new THREE.TubeGeometry(curve, segs, r, radial, closed);
}
function cylBetween(a, b, r1, r2 = r1, radial = 12) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r2, r1, len, radial, 1);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), dir.normalize());
  g.applyQuaternion(q);
  g.translate(a.x, a.y, a.z);
  return g;
}
function rbox(w, h, d, r, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2) * 0.99);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}
/** Extrude a side-profile shape (shape x -> bike Z, shape y -> bike Y) across bike X. */
function sideExtrude(pts, width, bevel = 0.01, xCenter = 0, steps = 1) {
  const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p[0], p[1])));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, width - bevel * 2),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    steps,
    curveSegments: 16,
  });
  g.translate(0, 0, -(width - bevel * 2) / 2);
  g.rotateY(-Math.PI / 2);
  g.translate(xCenter, 0, 0);
  return g;
}
/** Thin plate (shape in a plane) extruded by thickness, for shrouds/panels. */
function plate(pts, thick, bevel = 0.006) {
  const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p[0], p[1])));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 12 });
  g.translate(0, 0, -thick / 2);
  return g;
}
/** Curved arc band (fender) around a center in the YZ plane, extruded across X. */
function arcBand(cy, cz, r1, r2, a0, a1, width, bevel = 0.008) {
  const pts = [];
  const n = 18;
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cz + Math.cos(a) * r2, cy + Math.sin(a) * r2]);
  }
  for (let i = n; i >= 0; i--) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cz + Math.cos(a) * r1, cy + Math.sin(a) * r1]);
  }
  return sideExtrude(pts, width, bevel);
}

// --- wheel ---------------------------------------------------------------------------
function buildWheel(isFront, P) {
  const R = isFront ? GEO.rFront : GEO.rRear;
  const tubeR = isFront ? 0.046 : 0.058;
  const rimR = isFront ? GEO.rimFront : GEO.rimRear;
  const width = isFront ? 0.085 : 0.11;
  // tire carcass (torus around X axis)
  const tire = new THREE.TorusGeometry(R - tubeR, tubeR, 14, 64);
  tire.scale(1, 1, width / (tubeR * 2));
  tire.rotateY(Math.PI / 2);
  P.add('rubber', tire);
  // sidewall filling between rim and tread
  const side = new THREE.CylinderGeometry(R - tubeR * 1.6, R - tubeR * 1.6, width * 0.82, 48, 1, true);
  side.rotateZ(Math.PI / 2);
  P.add('rubber', side);
  // knobs
  const knob = new THREE.BoxGeometry(0.022, 0.022, 0.026);
  const kn = isFront ? 40 : 44;
  const knobs = [];
  for (let i = 0; i < kn; i++) {
    const a = (i / kn) * Math.PI * 2;
    for (const row of [-1, 0, 1]) {
      if (row === 0 && i % 2) continue;
      const lat = row * width * 0.36 + (row === 0 ? 0 : (i % 2 ? 0.006 : -0.006));
      const rr = R - 0.002 - Math.abs(row) * 0.012;
      const k = knob.clone();
      k.rotateX(-a);
      k.translate(lat, Math.cos(a) * rr, Math.sin(a) * rr);
      knobs.push(k);
    }
  }
  P.add('rubber', mergeGeometries(knobs.map((k) => k.toNonIndexed())));
  // rim
  const rim = new THREE.TorusGeometry(rimR, 0.013, 8, 64);
  rim.rotateY(Math.PI / 2);
  P.add('black', rim);
  const rimBand = new THREE.CylinderGeometry(rimR + 0.006, rimR + 0.006, width * 0.7, 48, 1, true);
  rimBand.rotateZ(Math.PI / 2);
  P.add('black', rimBand);
  // hub
  const hub = new THREE.CylinderGeometry(0.045, 0.045, isFront ? 0.13 : 0.15, 20);
  hub.rotateZ(Math.PI / 2);
  P.add('alu', hub);
  const axle = new THREE.CylinderGeometry(0.012, 0.012, 0.24, 10);
  axle.rotateZ(Math.PI / 2);
  P.add('chrome', axle);
  // spokes
  const spokes = [];
  const ns = 32;
  for (let i = 0; i < ns; i++) {
    const a = (i / ns) * Math.PI * 2;
    const side = i % 2 ? 1 : -1;
    const ha = a + side * 0.35;
    const h = V(side * 0.045, Math.cos(ha) * 0.04, Math.sin(ha) * 0.04);
    const r = V(side * 0.012, Math.cos(a) * (rimR - 0.008), Math.sin(a) * (rimR - 0.008));
    spokes.push(cylBetween(h, r, 0.0022, 0.0022, 4).toNonIndexed());
  }
  P.add('chrome', mergeGeometries(spokes));
  // brake disc
  const discR = isFront ? 0.135 : 0.12;
  const disc = new THREE.CylinderGeometry(discR, discR, 0.004, 40);
  disc.rotateZ(Math.PI / 2);
  disc.translate(isFront ? 0.062 : -0.07, 0, 0);
  P.add('disc', disc);
  const carrier = new THREE.CylinderGeometry(0.07, 0.07, 0.008, 20);
  carrier.rotateZ(Math.PI / 2);
  carrier.translate(isFront ? 0.058 : -0.066, 0, 0);
  P.add('darkAlu', carrier);
  if (!isFront) {
    // rear sprocket on the left
    const spr = new THREE.CylinderGeometry(0.115, 0.115, 0.006, 48);
    spr.rotateZ(Math.PI / 2);
    spr.translate(0.075, 0, 0);
    P.add('darkAlu', spr);
  }
}

// --- full bike -----------------------------------------------------------------------
export function buildProceduralBike(color = BIKE_COLORS.orange, number = '27') {
  const atlas = makeBikeAtlas(number, '#f4f4f2', '#111');
  const material = makePartMaterial({ map: atlas, paint: color, name: 'bike' });

  const root = new THREE.Group();
  root.name = 'proceduralBike';
  const SB = new SkinBuilder();

  const fa = V(...GEO.frontAxle), ra = V(...GEO.rearAxle);
  const axis = V(...AXIS_FRONT); // up along the fork
  const headTop = fa.clone().addScaledVector(axis, 0.7); // ~ (0, 0.98, 0.42)
  const headBot = fa.clone().addScaledVector(axis, 0.54);
  const pivot = V(...GEO.swingPivot);

  // ---------------- chassis
  const C = SB.part('chassis', root);
  // frame: twin spars from head tube to pivot, cradle under the engine
  for (const s of [1, -1]) {
    C.add('alu', tube([
      headTop.clone().add(V(0, -0.02, -0.02)),
      V(s * 0.1, 0.92, 0.25),
      V(s * 0.13, 0.82, 0.02),
      V(s * 0.12, 0.66, -0.12),
      V(s * 0.11, pivot.y + 0.03, pivot.z + 0.02),
      V(s * 0.1, 0.36, -0.12),
    ], 0.022, 40, 8));
    // down tube / cradle
    C.add('alu', tube([
      headBot.clone().add(V(0, 0, 0.0)),
      V(s * 0.05, 0.62, 0.42),
      V(s * 0.07, 0.36, 0.3),
      V(s * 0.08, 0.24, 0.12),
      V(s * 0.09, 0.27, -0.08),
      V(s * 0.1, 0.36, -0.12),
    ], 0.016, 40, 8));
    // subframe
    C.add('darkAlu', tube([V(s * 0.12, 0.8, -0.08), V(s * 0.1, 0.86, -0.4), V(s * 0.08, 0.88, -0.62)], 0.012, 16, 6));
    C.add('darkAlu', tube([V(s * 0.11, 0.6, -0.18), V(s * 0.1, 0.74, -0.42), V(s * 0.08, 0.86, -0.6)], 0.011, 16, 6));
  }
  // head tube
  C.add('alu', cylBetween(headBot.clone().addScaledVector(axis, -0.03), headTop.clone().addScaledVector(axis, 0.02), 0.032, 0.032, 16));
  // engine
  C.add('engine', rbox(0.25, 0.27, 0.36, 0.05, 0, 0.42, 0.04));
  C.add('engine', rbox(0.13, 0.23, 0.15, 0.03, 0, 0.62, 0.14, -0.35));
  C.add('darkAlu', rbox(0.15, 0.08, 0.17, 0.03, 0, 0.75, 0.19, -0.35));
  // cylinder fins
  for (let i = 0; i < 5; i++) C.add('engine', rbox(0.16, 0.012, 0.17, 0.004, 0, 0.56 + i * 0.03, 0.12 + i * 0.012, -0.35));
  // clutch cover (right side) and ignition cover (left)
  const cc = new THREE.CylinderGeometry(0.1, 0.1, 0.04, 28);
  cc.rotateZ(Math.PI / 2);
  cc.translate(-0.135, 0.42, 0.08);
  C.add('darkAlu', cc);
  const ic = new THREE.CylinderGeometry(0.08, 0.085, 0.04, 28);
  ic.rotateZ(Math.PI / 2);
  ic.translate(0.135, 0.42, -0.02);
  C.add('darkAlu', ic);
  // countershaft sprocket
  const cs = new THREE.CylinderGeometry(0.04, 0.04, 0.01, 16);
  cs.rotateZ(Math.PI / 2);
  cs.translate(0.1, 0.42, -0.08);
  C.add('darkAlu', cs);
  // radiators (behind shrouds)
  for (const s of [1, -1]) {
    C.add('darkAlu', rbox(0.04, 0.26, 0.17, 0.01, s * 0.11, 0.68, 0.36, 0, s * 0.18, 0));
  }
  // tank (mostly hidden by shrouds)
  C.add('paint', sideExtrude([[0.42, 0.88], [0.26, 1.0], [0.0, 1.02], [-0.1, 0.93], [0.05, 0.84], [0.32, 0.8]], 0.2, 0.04));
  // seat: long rounded profile
  C.add('seat', sideExtrude([[0.18, 0.95], [0.1, 0.985], [-0.2, 0.985], [-0.55, 0.975], [-0.68, 0.955], [-0.7, 0.925], [-0.4, 0.915], [-0.05, 0.9], [0.14, 0.9]], 0.24, 0.035));
  // radiator shrouds (paint), angled outward
  for (const s of [1, -1]) {
    const g = plate([[0.5, 0.78], [0.42, 1.02], [0.18, 1.04], [-0.04, 0.95], [0.06, 0.74], [0.3, 0.58], [0.46, 0.6]], 0.008);
    g.rotateY(s > 0 ? -Math.PI / 2 : -Math.PI / 2);
    // plate lies in XY after rotate: map shape x->Z, y->Y
    const m = new THREE.Matrix4().makeRotationY(s * 0.12);
    g.applyMatrix4(m);
    g.translate(s * 0.15, 0, 0);
    C.add('paint', g);
    // shroud graphic stripe (white)
    const st = plate([[0.44, 0.84], [0.38, 0.95], [0.1, 0.92], [0.16, 0.82]], 0.004, 0.002);
    st.rotateY(-Math.PI / 2);
    st.applyMatrix4(m);
    st.translate(s * 0.158, 0, 0);
    C.add('white', st);
  }
  // side panels with number plates
  for (const s of [1, -1]) {
    const g = plate([[-0.18, 0.88], [-0.62, 0.92], [-0.66, 0.74], [-0.42, 0.6], [-0.2, 0.62]], 0.008);
    g.rotateY(-Math.PI / 2);
    g.translate(s * 0.13, 0, 0);
    C.add('paint', g);
    const pl = new THREE.PlaneGeometry(0.2, 0.15);
    pl.rotateY(s > 0 ? Math.PI / 2 : -Math.PI / 2);
    pl.translate(s * 0.139, 0.78, -0.42);
    C.add('plate', pl);
  }
  // airbox
  C.add('black', rbox(0.2, 0.2, 0.26, 0.04, 0, 0.74, -0.32));
  // rear fender: rises from under the seat to the tail
  C.add('paint', sideExtrude([[-0.45, 0.88], [-0.7, 0.93], [-1.0, 1.0], [-1.1, 1.02], [-1.1, 0.995], [-0.98, 0.965], [-0.7, 0.895], [-0.48, 0.85]], 0.2, 0.012));
  // rear fender underside / mud flap
  C.add('black', sideExtrude([[-0.55, 0.85], [-0.75, 0.86], [-0.74, 0.83], [-0.56, 0.82]], 0.17, 0.005));
  // footpegs
  for (const s of [1, -1]) {
    C.add('darkAlu', rbox(0.11, 0.022, 0.05, 0.006, s * 0.2, GEO.pegs[1], GEO.pegs[2]));
    C.add('darkAlu', rbox(0.04, 0.05, 0.04, 0.008, s * 0.135, GEO.pegs[1] + 0.02, GEO.pegs[2]));
  }
  // brake pedal (right), shift lever (left)
  C.add('darkAlu', tube([V(-0.17, 0.36, -0.06), V(-0.18, 0.34, 0.06), V(-0.19, 0.33, 0.16)], 0.009, 8, 6));
  C.add('darkAlu', tube([V(0.17, 0.44, -0.02), V(0.18, 0.4, 0.1), V(0.19, 0.38, 0.14)], 0.008, 8, 6));
  // exhaust: header from cylinder head front, around the right side, into the muffler
  const pipePts = [V(-0.02, 0.72, 0.3), V(-0.06, 0.6, 0.38), V(-0.12, 0.46, 0.34), V(-0.16, 0.5, 0.12), V(-0.16, 0.62, -0.08), V(-0.16, 0.74, -0.3)];
  C.add('pipe', tube(pipePts, 0.024, 48, 10));
  const muff = cylBetween(V(-0.165, 0.74, -0.28), V(-0.17, 0.9, -0.78), 0.055, 0.05, 20);
  C.add('muffler', muff);
  const endcap = cylBetween(V(-0.17, 0.9, -0.78), V(-0.17, 0.915, -0.83), 0.05, 0.03, 16);
  C.add('darkAlu', endcap);
  // chain run (top and bottom) on the left side
  C.add('black', rbox(0.012, 0.01, 0.01, 0.002, 0.1, 0.46, -0.08));
  // rear shock top mount
  C.add('darkAlu', rbox(0.06, 0.05, 0.05, 0.01, 0, 0.8, -0.1));
  const chassis = C.bone;

  // ---------------- steering assembly (rotates about steering axis through the front axle)
  const steerPivot = new THREE.Bone();
  steerPivot.name = 'steerPivot';
  steerPivot.position.copy(fa);
  root.add(steerPivot);
  const S = SB.part('steer', steerPivot);
  S.bone.position.copy(fa).negate();
  const fkx = 0.085;
  const topClampY = headTop.clone().addScaledVector(axis, 0.03);
  const botClamp = headBot.clone().addScaledVector(axis, -0.04);
  // triple clamps
  S.add('alu', rbox(0.25, 0.035, 0.1, 0.012, topClampY.x, topClampY.y, topClampY.z, -0.47));
  S.add('alu', rbox(0.26, 0.045, 0.11, 0.012, botClamp.x, botClamp.y, botClamp.z, -0.47));
  // fork outer tubes (upper, USD): from above top clamp down ~0.42
  for (const s of [1, -1]) {
    const top = topClampY.clone().add(V(s * fkx, 0, 0)).addScaledVector(axis, 0.03);
    const bot = top.clone().addScaledVector(axis, -0.47);
    S.add('gold', cylBetween(bot, top, 0.03, 0.028, 18));
  }
  // handlebar
  const barC = topClampY.clone().addScaledVector(axis, 0.06).add(V(0, 0, -0.03));
  const gL = V(GEO.grips[0], GEO.grips[1], GEO.grips[2]);
  const gR = V(-GEO.grips[0], GEO.grips[1], GEO.grips[2]);
  S.add('alu', tube([gR.clone().add(V(0.06, 0, 0)), V(-0.24, gL.y - 0.02, barC.z + 0.0), V(-0.1, barC.y + 0.01, barC.z + 0.01), V(0.1, barC.y + 0.01, barC.z + 0.01), V(0.24, gL.y - 0.02, barC.z), gL.clone().add(V(-0.06, 0, 0))], 0.012, 40, 8));
  // risers
  S.add('darkAlu', cylBetween(topClampY.clone().add(V(0.04, 0, 0)), barC.clone().add(V(0.04, 0, 0)), 0.014));
  S.add('darkAlu', cylBetween(topClampY.clone().add(V(-0.04, 0, 0)), barC.clone().add(V(-0.04, 0, 0)), 0.014));
  // bar pad
  S.add('paint', rbox(0.2, 0.045, 0.05, 0.018, barC.x, barC.y + 0.03, barC.z + 0.01));
  // grips & levers
  for (const s of [1, -1]) {
    const g = s > 0 ? gL : gR;
    S.add('rubber', cylBetween(g.clone().add(V(-s * 0.07, 0, 0)), g.clone().add(V(s * 0.065, 0, 0)), 0.017, 0.017, 12));
    S.add('darkAlu', tube([g.clone().add(V(-s * 0.08, 0.02, 0.03)), g.clone().add(V(-s * 0.0, 0.025, 0.07)), g.clone().add(V(s * 0.06, 0.015, 0.08))], 0.006, 8, 5));
    S.add('black', rbox(0.05, 0.05, 0.05, 0.012, g.x - s * 0.09, g.y, g.z + 0.01));
  }
  // front number plate
  const npC = topClampY.clone().addScaledVector(axis, -0.06).add(V(0, 0, 0.08));
  const np = plate([[-0.13, -0.11], [0.13, -0.11], [0.15, 0.08], [0.06, 0.14], [-0.06, 0.14], [-0.15, 0.08]], 0.008);
  np.rotateX(-0.36);
  np.translate(npC.x, npC.y, npC.z);
  S.add('paint', np);
  const npl = new THREE.PlaneGeometry(0.17, 0.13);
  npl.rotateX(-0.36);
  npl.translate(npC.x, npC.y - 0.01, npC.z + 0.008);
  S.add('plate', npl);
  // front fender (mounted on lower clamp, above the tire at full extension)
  const faExt = fa.clone().addScaledVector(axis, -GEO.sagF);
  S.add('paint', arcBand(faExt.y, faExt.z + 0.03, GEO.rFront + 0.085, GEO.rFront + 0.1, 0.12 * Math.PI, 0.62 * Math.PI, 0.145, 0.01));
  const steer = S.bone;

  // ---------------- fork lowers (slide along the fork axis)
  const forkSlide = new THREE.Bone();
  forkSlide.name = 'forkSlide';
  steerPivot.add(forkSlide);
  const L = SB.part('forkLower', forkSlide);
  L.bone.position.copy(fa).negate();
  for (const s of [1, -1]) {
    const bot = fa.clone().add(V(s * fkx, 0, 0)).addScaledVector(axis, -0.02);
    const top = bot.clone().addScaledVector(axis, 0.5);
    L.add('chrome', cylBetween(bot, top, 0.024, 0.024, 16));
    L.add('darkAlu', rbox(0.06, 0.09, 0.07, 0.015, bot.x, bot.y + 0.015, bot.z));
    // fork guard
    const gb = bot.clone().addScaledVector(axis, 0.08).add(V(s * 0.012, 0, 0.022));
    const gt = gb.clone().addScaledVector(axis, 0.24);
    L.add('white', cylBetween(gb, gt, 0.03, 0.028, 10));
  }
  // caliper (left)
  L.add('darkAlu', rbox(0.04, 0.09, 0.06, 0.012, 0.07, fa.y + 0.06, fa.z - 0.1, 0.4));
  const forkLower = L.bone;

  // ---------------- swingarm
  const swingPivot = new THREE.Bone();
  swingPivot.name = 'swingPivot';
  swingPivot.position.copy(pivot);
  root.add(swingPivot);
  const A = SB.part('swingarm', swingPivot);
  A.bone.position.copy(pivot).negate();
  for (const s of [1, -1]) {
    A.add('alu', tube([V(s * 0.115, pivot.y, pivot.z), V(s * 0.12, (pivot.y + ra.y) / 2 + 0.02, (pivot.z + ra.z) / 2), V(s * 0.105, ra.y + 0.01, ra.z + 0.04)], 0.026, 16, 8));
    A.add('alu', rbox(0.03, 0.06, 0.09, 0.01, s * 0.105, ra.y, ra.z));
  }
  A.add('alu', rbox(0.22, 0.05, 0.05, 0.015, 0, pivot.y - 0.05, pivot.z - 0.13));
  A.add('darkAlu', cylBetween(V(0.13, pivot.y, pivot.z), V(-0.13, pivot.y, pivot.z), 0.022));
  // chain guide & chain
  A.add('black', rbox(0.02, 0.07, 0.18, 0.01, 0.11, ra.y - 0.08, ra.z + 0.2));
  A.add('black', cylBetween(V(0.1, pivot.y - 0.08, pivot.z + 0.02), V(0.1, ra.y - 0.11, ra.z), 0.006, 0.006, 6));
  A.add('black', cylBetween(V(0.1, pivot.y + 0.0, pivot.z + 0.02), V(0.1, ra.y + 0.11, ra.z), 0.006, 0.006, 6));
  // rear caliper (right side)
  A.add('darkAlu', rbox(0.035, 0.08, 0.06, 0.012, -0.08, ra.y + 0.1, ra.z + 0.05, 0.5));
  // linkage point for the shock
  A.add('darkAlu', rbox(0.06, 0.06, 0.08, 0.012, 0, pivot.y - 0.1, pivot.z - 0.08));
  const swingarm = A.bone;

  // ---------------- shock (stretched between mounts every frame)
  const shock = new THREE.Bone();
  shock.name = 'shock';
  root.add(shock);
  const K = SB.part('shockBody', shock);
  K.add('darkAlu', cylBetween(V(0, 0, 0), V(0, 0.16, 0), 0.026, 0.026, 14));
  K.add('chrome', cylBetween(V(0, 0.16, 0), V(0, 0.3, 0), 0.011, 0.011, 10));
  K.add('darkAlu', cylBetween(V(0, -0.03, 0), V(0, 0.0, 0), 0.02, 0.02, 10));
  // reservoir
  K.add('darkAlu', cylBetween(V(0.045, 0.02, 0), V(0.045, 0.14, 0), 0.02, 0.02, 10));
  // spring as a helix (scaled with travel)
  const helixPts = [];
  const turns = 9;
  for (let i = 0; i <= turns * 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    helixPts.push(V(Math.cos(a) * 0.036, (i / (turns * 16)), Math.sin(a) * 0.036));
  }
  const springGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(helixPts), turns * 16, 0.0065, 6, false);
  const SP = SB.part('spring', shock);
  SP.add('spring', springGeo);
  const springMesh = SP.bone;

  // ---------------- wheels
  const FW = SB.part('frontWheel', forkSlide);
  buildWheel(true, FW);
  const frontWheel = FW.bone;
  const RW = SB.part('rearWheel', swingPivot);
  buildWheel(false, RW);
  const rearWheel = RW.bone;
  rearWheel.position.subVectors(ra, pivot);

  const mesh = SB.build(material);
  root.add(mesh);

  return {
    root,
    mesh,
    material,
    atlas,
    parts: { chassis, steer, steerPivot, forkSlide, forkLower, frontWheel, rearWheel, swingPivot, swingarm, shock, springMesh },
  };
}
// ---------------------------------------------------------------------------------
// Visual binding: drives a bike model from the physics state.
// ---------------------------------------------------------------------------------
const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3(...AXIS_FRONT);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

export class ProceduralBikeVisual {
  constructor(color, number) {
    const b = buildProceduralBike(color, number);
    this.root = b.root;
    this.mesh = b.mesh;
    this.material = b.material;
    this.atlas = b.atlas;
    this.p = b.parts;
    this.kind = 'procedural';
    this.shockTop = V(0, 0.79, -0.1);
    this.linkLocal = V(0, GEO.swingPivot[1] - 0.1, GEO.swingPivot[2] - 0.08); // in bike space at rest
    this.update({ steer: 0, compF: GEO.sagF, compR: GEO.sagR, spinF: 0, spinR: 0 });
  }

  setColor(hex) {
    setPaint(this.material, hex);
  }

  /** state: steer (rad), compF/compR (m from full extension), spinF/spinR (rad) */
  update(st) {
    const p = this.p;
    _q.setFromAxisAngle(_axis, -st.steer);
    p.steerPivot.quaternion.copy(_q);
    // fork compression relative to static sag
    p.forkSlide.position.copy(_axis).multiplyScalar(st.compF - GEO.sagF);
    p.frontWheel.rotation.x = st.spinF;
    // swingarm rotation from rear travel
    const a = (st.compR - GEO.sagR) / SWINGARM_LENGTH;
    p.swingPivot.rotation.x = a;
    p.rearWheel.rotation.x = st.spinR;
    // shock between top mount and linkage on the swingarm
    const pv = p.swingPivot.position;
    _v.copy(this.linkLocal).sub(pv).applyAxisAngle(V1X, a).add(pv);
    const dir = _v2.copy(this.shockTop).sub(_v);
    const len = dir.length();
    p.shock.position.copy(_v);
    p.shock.quaternion.setFromUnitVectors(V1Y, dir.divideScalar(Math.max(1e-6, len)));
    p.springMesh.scale.set(1, Math.max(0.1, len - 0.07), 1);
    p.springMesh.position.y = 0.04;
  }

  /** Grip positions in bike space (follow steering). */
  grips(outL, outR, steer) {
    const fa = FA;
    _q.setFromAxisAngle(_axis, -steer);
    outL.set(GEO.grips[0], GEO.grips[1], GEO.grips[2]).sub(fa).applyQuaternion(_q).add(fa);
    outR.set(-GEO.grips[0], GEO.grips[1], GEO.grips[2]).sub(fa).applyQuaternion(_q).add(fa);
  }

  dispose() {
    this.mesh.geometry.dispose();
    if (this.mesh.skeleton) this.mesh.skeleton.dispose();
    this.material.dispose();
    this.atlas.dispose();
  }
}
const V1X = V(1, 0, 0);
const V1Y = V(0, 1, 0);
const FA = V(...GEO.frontAxle);

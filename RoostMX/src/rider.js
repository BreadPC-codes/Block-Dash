// Motocross rider built from primitives and posed procedurally every frame:
// hands stay on the (steering) grips and feet on the pegs via two-bone IK, while the
// pelvis/torso move with stance (sit/stand), weight shift, suspension and landings.
// After a crash the rider detaches and follows the physics ragdoll with a flailing pose.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GEO } from './bike-geometry.js';
import { makeRiderAtlas, drawRiderAtlas } from './textures.js';
import { makePartMaterial, setPaint, bakePart, mergeBaked } from './part-material.js';
import { clamp, damp, lerp } from './util.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);

const LEN = { thigh: 0.43, shin: 0.43, upper: 0.29, fore: 0.27, spine: 0.44 };

function capsuleGeo(r, len, radial = 10) {
  const g = new THREE.CapsuleGeometry(r, len, 4, radial);
  g.translate(0, len / 2, 0);
  return g;
}

// looks baked per vertex (part material); 'paint' parts follow the rider's primary colour
const LOOKS = {
  jersey: { color: 0xffffff, roughness: 0.75, atlas: 'jersey' },
  sleeve: { color: 0xffffff, roughness: 0.75, paint: 1 },
  pants: { color: 0x2a2b2e, roughness: 0.8 },
  pantsAccent: { color: 0xffffff, roughness: 0.7, paint: 1 },
  boots: { color: 0xeeeeec, roughness: 0.55 },
  bootSole: { color: 0x151515, roughness: 0.9 },
  gloves: { color: 0x1a1a1c, roughness: 0.8 },
  helmet: { color: 0xffffff, roughness: 0.25, metalness: 0.05, atlas: 'helmet' },
  visor: { color: 0xffffff, roughness: 0.4, paint: 1 },
  goggleStrap: { color: 0x111111, roughness: 0.7 },
  lens: { color: 0x6a3fd0, roughness: 0.05, metalness: 0.9 },
  brace: { color: 0x202022, roughness: 0.6 },
};
// atlas layout (512 x 576): jersey rows 0-255, helmet rows 256-511, white rows 512-575
const ATLAS_UV = {
  jersey: (u, v, o) => { o[0] = u; o[1] = 0.5556 + v * 0.4444; },
  helmet: (u, v, o) => { o[0] = u; o[1] = 0.1111 + v * 0.4444; },
};
const WHITE_UV = [0.5, 0.05];

/** Two-bone IK: returns joint position. pole = preferred bend direction. */
function solveIK(a, t, l1, l2, pole, outJoint, outEnd) {
  const dir = _ikD.subVectors(t, a);
  let d = dir.length();
  if (d < 1e-5) { dir.set(0, -1, 0); d = 1e-5; } else dir.divideScalar(d);
  const dc = clamp(d, Math.abs(l1 - l2) + 0.01, l1 + l2 - 0.002);
  const x = (l1 * l1 - l2 * l2 + dc * dc) / (2 * dc);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const perp = _ikP.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (perp.lengthSq() < 1e-8) perp.set(0, 0, 1);
  perp.normalize();
  outJoint.copy(a).addScaledVector(dir, x).addScaledVector(perp, h);
  outEnd.copy(a).addScaledVector(dir, dc);
  return outJoint;
}
const _ikD = V(0, 0, 0), _ikP = V(0, 0, 0), _spine = V(0, 1, 0), _pole = V(0, 0, 1);
const _q = new THREE.Quaternion();
const _d = V(0, 0, 0);

function place(mesh, a, b) {
  _d.subVectors(b, a);
  const len = _d.length();
  mesh.position.copy(a);
  if (len > 1e-6) mesh.quaternion.setFromUnitVectors(UP, _d.divideScalar(len));
}

export class Rider {
  constructor(primary = '#f26a10', secondary = '#111111', number = '27') {
    this.group = new THREE.Group();
    this.group.name = 'rider';
    this.primary = primary;
    this.atlas = makeRiderAtlas(primary);
    this.material = makePartMaterial({ map: this.atlas, paint: primary, name: 'rider' });
    const G = this.group;
    const bones = [];
    const pieces = [];
    const bone = (name) => {
      const b = new THREE.Bone();
      b.name = name;
      G.add(b);
      bones.push(b);
      return b;
    };
    const add = (b, geo, look) => pieces.push({ geo, look, bone: bones.indexOf(b) });
    // torso (jersey with chest protector bulk)
    this.torso = bone('torso');
    const torsoGeo = new THREE.CapsuleGeometry(0.15, 0.3, 6, 14);
    torsoGeo.scale(1.22, 1, 0.82);
    torsoGeo.translate(0, 0.15 + 0.02, 0);
    add(this.torso, torsoGeo, 'jersey');
    this.hips = bone('hips');
    const hips = new THREE.CapsuleGeometry(0.12, 0.14, 4, 10);
    hips.rotateZ(Math.PI / 2);
    add(this.hips, hips, 'pants');
    // neck brace
    this.brace = bone('brace');
    const brace = new THREE.TorusGeometry(0.1, 0.035, 8, 18);
    brace.rotateX(Math.PI / 2);
    add(this.brace, brace, 'brace');
    // helmet
    this.head = bone('head');
    const shell = new THREE.SphereGeometry(0.155, 24, 18);
    shell.scale(1, 1.03, 1.16);
    add(this.head, shell, 'helmet');
    const chin = new RoundedBoxGeometry(0.17, 0.09, 0.12, 2, 0.04);
    chin.translate(0, -0.09, 0.13);
    chin.rotateX(0.25);
    add(this.head, chin, 'helmet');
    const peak = new RoundedBoxGeometry(0.2, 0.018, 0.15, 2, 0.008);
    peak.rotateX(-0.28);
    peak.translate(0, 0.085, 0.17);
    add(this.head, peak, 'visor');
    const strap = new THREE.TorusGeometry(0.158, 0.016, 6, 28);
    strap.scale(1, 1, 1.15);
    strap.rotateX(Math.PI / 2 - 0.12);
    add(this.head, strap, 'goggleStrap');
    const lens = new RoundedBoxGeometry(0.16, 0.055, 0.03, 2, 0.012);
    lens.translate(0, 0.012, 0.172);
    add(this.head, lens, 'lens');
    // limbs
    this.limbs = {};
    for (const s of ['L', 'R']) {
      const limb = (name, r, len, look) => {
        const b = bone(name + s);
        add(b, capsuleGeo(r, len), look);
        this.limbs[name + s] = b;
      };
      limb('thigh', 0.072, LEN.thigh, 'pants');
      limb('shin', 0.056, LEN.shin, 'pants');
      limb('upper', 0.054, LEN.upper, 'sleeve');
      limb('fore', 0.047, LEN.fore, 'sleeve');
      // boot: tall shaft + foot
      limb('bootShaft', 0.064, 0.22, 'boots');
      const foot = bone('foot' + s);
      const footGeo = new RoundedBoxGeometry(0.1, 0.085, 0.27, 2, 0.03);
      footGeo.translate(0, 0, 0.06);
      add(foot, footGeo, 'boots');
      const sole = new RoundedBoxGeometry(0.105, 0.025, 0.28, 1, 0.01);
      sole.translate(0, -0.05, 0.06);
      add(foot, sole, 'bootSole');
      this.limbs['foot' + s] = foot;
      const glove = bone('glove' + s);
      add(glove, new RoundedBoxGeometry(0.075, 0.07, 0.11, 2, 0.025), 'gloves');
      this.limbs['glove' + s] = glove;
      // knee guard
      const knee = bone('knee' + s);
      add(knee, new RoundedBoxGeometry(0.09, 0.14, 0.05, 2, 0.02), 'pantsAccent');
      this.limbs['knee' + s] = knee;
    }
    // one skinned mesh, one bone per rigid body part -> a single draw call
    const baked = pieces.map(({ geo, look, bone: bi }) => {
      const L = LOOKS[look];
      const g = bakePart(geo, { ...L, bone: bi, uvMap: L.atlas ? ATLAS_UV[L.atlas] : undefined, uv: L.atlas ? undefined : WHITE_UV });
      geo.dispose();
      return g;
    });
    const mesh = new THREE.SkinnedMesh(mergeBaked(baked), this.material);
    mesh.name = 'riderMesh';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.bind(new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4())), new THREE.Matrix4());
    G.add(mesh);
    this.mesh = mesh;
    // joints state (bike space while riding)
    this.j = {};
    for (const k of ['pelvis', 'chest', 'neck', 'headC', 'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR', 'shL', 'shR', 'elL', 'elR', 'handL', 'handR', 'footL', 'footR']) this.j[k] = V(0, 0, 0);
    // smoothed pose parameters
    this.pose = { stand: 1, fore: 0, side: 0, crouch: 0, dabL: 0, dabR: 0, twist: 0, look: 0 };
    this.flail = 0;
    this.firstPerson = false;
    void secondary; void number;
  }

  setColor(primary) {
    this.primary = primary;
    setPaint(this.material, primary);
    drawRiderAtlas(this.atlas.image, primary);
    this.atlas.needsUpdate = true;
  }

  setFirstPerson(fp) {
    this.firstPerson = fp;
    // hide the helmet and brace from the eye camera by collapsing their bones
    const s = fp ? 1e-4 : 1;
    this.head.scale.setScalar(s);
    this.brace.scale.setScalar(s);
  }

  /**
   * Pose the rider on the bike. s = {
   *  stance, riderLean (-1..1 fore/aft), side (-1..1 body left/right, + = right),
   *  legE (m), lean (bike roll rad), steer, speed, airborne, whip, brake }
   */
  updateRiding(dt, s, gripL, gripR) {
    const P = this.pose;
    const t = Math.min(1, dt);
    P.stand = damp(P.stand, s.stance, 8, t);
    P.fore = damp(P.fore, s.riderLean, 9, t);
    // bike space +X is the bike's left, so a body lean to the right moves toward -X
    const sideGoal = s.side !== undefined ? -s.side * 0.62 + s.whip * 0.2 : -s.lean * 0.55 + s.whip * 0.25;
    P.side = damp(P.side, clamp(sideGoal, -0.62, 0.62), 11, t);
    P.crouch = damp(P.crouch, clamp(-s.legE / 0.3, -0.4, 1), 18, t);
    const cornering = !s.airborne && P.stand < 0.6 && Math.abs(s.lean) > 0.22 && s.speed < 16 && s.speed > 1;
    P.dabL = damp(P.dabL, cornering && s.lean < 0 ? 1 : 0, 5, t);
    P.dabR = damp(P.dabR, cornering && s.lean > 0 ? 1 : 0, 5, t);
    P.twist = damp(P.twist, s.whip * 0.3, 6, t);
    P.look = damp(P.look, clamp(-s.steer * 1.2, -0.5, 0.5), 5, t);
    const st = P.stand, fore = P.fore;
    const j = this.j;
    // pelvis (slides across the seat / between the pegs with the side lean)
    const seatY = GEO.seat[1] + 0.07;
    const pz = lerp(-0.16, -0.1, st) + fore * lerp(0.1, 0.17, st) + (1 - st) * 0.06;
    const py = lerp(seatY, 1.2, st) - P.crouch * lerp(0.03, 0.2, st) - Math.abs(fore) * 0.04 * st - Math.abs(P.side) * 0.05;
    j.pelvis.set(P.side * lerp(0.1, 0.16, st), py, pz);
    // spine leaning forward (attack position) and sideways with the body lean
    const spineAng = lerp(0.42, 0.62, st) + fore * 0.32 + P.crouch * 0.18 - (s.brake || 0) * 0.08;
    const sideAng = P.side * 0.75;
    const spineDir = _spine.set(Math.sin(sideAng) * 0.6, Math.cos(spineAng), Math.sin(spineAng)).normalize();
    j.chest.copy(j.pelvis).addScaledVector(spineDir, LEN.spine);
    j.neck.copy(j.chest).addScaledVector(spineDir, 0.08);
    // head looks forward (counter-rotate spine pitch), stays a little more upright than the spine
    j.headC.copy(j.neck);
    j.headC.x += P.look * 0.05 - P.side * 0.02;
    j.headC.y += 0.13;
    j.headC.z += 0.05;
    // shoulders
    const shW = 0.19;
    j.shL.copy(j.chest);
    j.shL.x += shW; j.shL.y -= 0.03; j.shL.z += P.twist * 0.08;
    j.shR.copy(j.chest);
    j.shR.x -= shW; j.shR.y -= 0.03; j.shR.z -= P.twist * 0.08;
    // hips
    j.hipL.copy(j.pelvis);
    j.hipL.x += 0.1; j.hipL.y -= 0.03;
    j.hipR.copy(j.pelvis);
    j.hipR.x -= 0.1; j.hipR.y -= 0.03;
    // hands on grips
    j.handL.copy(gripL);
    j.handR.copy(gripR);
    // feet on pegs (or dabbing forward in corners)
    const peg = GEO.pegs;
    j.ankleL.set(peg[0] + 0.03 + P.dabL * 0.08, peg[1] + 0.06 + P.dabL * 0.06, peg[2] - 0.02 + P.dabL * 0.5);
    j.ankleR.set(-(peg[0] + 0.03 + P.dabR * 0.08), peg[1] + 0.06 + P.dabR * 0.06, peg[2] - 0.02 + P.dabR * 0.5);
    // IK legs (knees forward and slightly out; the outside knee grips the bike in a side lean)
    solveIK(j.hipL, j.ankleL, LEN.thigh, LEN.shin, _pole.set(0.25 + Math.max(0, P.side) * 0.3, 0.15, 1), j.kneeL, j.ankleL);
    solveIK(j.hipR, j.ankleR, LEN.thigh, LEN.shin, _pole.set(-0.25 + Math.min(0, P.side) * 0.3, 0.15, 1), j.kneeR, j.ankleR);
    // IK arms (elbows out and up)
    solveIK(j.shL, j.handL, LEN.upper, LEN.fore, _pole.set(1, 0.35, -0.6), j.elL, j.handL);
    solveIK(j.shR, j.handR, LEN.upper, LEN.fore, _pole.set(-1, 0.35, -0.6), j.elR, j.handR);
    this._applyMeshes(spineDir, 0);
  }

  /** Flailing pose used while the rider tumbles after a crash (rider-local space). */
  updateRagdoll(dt, grounded) {
    this.flail += dt * (grounded ? 2 : 9);
    const f = this.flail;
    const j = this.j;
    const amp = grounded ? 0.15 : 0.5;
    j.pelvis.set(0, 0, 0);
    const spineDir = _spine.set(Math.sin(f * 0.7) * 0.2 * amp, 1, Math.cos(f * 0.9) * 0.3 * amp).normalize();
    j.chest.copy(j.pelvis).addScaledVector(spineDir, LEN.spine);
    j.neck.copy(j.chest).addScaledVector(spineDir, 0.08);
    j.headC.copy(j.neck);
    j.headC.y += 0.13; j.headC.z += 0.03;
    j.shL.copy(j.chest);
    j.shL.x += 0.19; j.shL.y -= 0.03;
    j.shR.copy(j.chest);
    j.shR.x -= 0.19; j.shR.y -= 0.03;
    j.hipL.set(0.1, -0.03, 0);
    j.hipR.set(-0.1, -0.03, 0);
    j.handL.set(j.shL.x + 0.35 + Math.sin(f) * amp * 0.3, j.shL.y + 0.2 + Math.cos(f * 1.3) * amp * 0.4, j.shL.z + Math.sin(f * 0.8) * amp * 0.3);
    j.handR.set(j.shR.x - 0.35 - Math.sin(f * 1.1) * amp * 0.3, j.shR.y + 0.15 + Math.sin(f * 1.4) * amp * 0.4, j.shR.z + Math.cos(f) * amp * 0.3);
    j.ankleL.set(j.hipL.x + 0.2 + Math.sin(f * 0.9) * amp * 0.2, j.hipL.y - 0.78, j.hipL.z + Math.cos(f * 1.2) * amp * 0.4);
    j.ankleR.set(j.hipR.x - 0.2 - Math.cos(f) * amp * 0.2, j.hipR.y - 0.78, j.hipR.z + Math.sin(f * 1.1) * amp * 0.4);
    solveIK(j.hipL, j.ankleL, LEN.thigh, LEN.shin, _pole.set(0.2, 0, 1), j.kneeL, j.ankleL);
    solveIK(j.hipR, j.ankleR, LEN.thigh, LEN.shin, _pole.set(-0.2, 0, 1), j.kneeR, j.ankleR);
    solveIK(j.shL, j.handL, LEN.upper, LEN.fore, _pole.set(0.5, -0.5, -0.5), j.elL, j.handL);
    solveIK(j.shR, j.handR, LEN.upper, LEN.fore, _pole.set(-0.5, -0.5, -0.5), j.elR, j.handR);
    this._applyMeshes(spineDir, 1);
  }

  _applyMeshes(spineDir, ragdoll) {
    const j = this.j, L = this.limbs;
    // torso oriented along spine with forward = +Z
    this.torso.position.copy(j.pelvis);
    _q.setFromUnitVectors(UP, spineDir);
    this.torso.quaternion.copy(_q);
    this.hips.position.copy(j.pelvis);
    this.hips.quaternion.identity();
    this.brace.position.copy(j.neck).addScaledVector(spineDir, -0.01);
    this.brace.quaternion.copy(_q);
    this.head.position.copy(j.headC);
    // head pitch: keep the eyes roughly forward/level
    this.head.rotation.set(ragdoll ? 0.3 : -0.12 + this.pose.fore * 0.05, this.pose.look, ragdoll ? 0 : this.pose.side * 0.35);
    place(L.thighL, j.hipL, j.kneeL);
    place(L.thighR, j.hipR, j.kneeR);
    place(L.shinL, j.kneeL, j.ankleL);
    place(L.shinR, j.kneeR, j.ankleR);
    place(L.upperL, j.shL, j.elL);
    place(L.upperR, j.shR, j.elR);
    place(L.foreL, j.elL, j.handL);
    place(L.foreR, j.elR, j.handR);
    // boots: shaft from ankle up the shin
    for (let k = 0; k < 2; k++) {
      const left = k === 0;
      const knee = left ? j.kneeL : j.kneeR, ankle = left ? j.ankleL : j.ankleR;
      const shaft = left ? L.bootShaftL : L.bootShaftR;
      shaft.position.copy(ankle);
      _d.subVectors(knee, ankle).normalize();
      shaft.quaternion.setFromUnitVectors(UP, _d);
      const foot = left ? L.footL : L.footR;
      foot.position.copy(ankle);
      foot.position.y -= 0.04;
      foot.position.z += 0.02;
      foot.rotation.set(ragdoll ? 0.6 : 0, 0, 0);
      const kg = left ? L.kneeL : L.kneeR;
      kg.position.copy(knee);
      kg.position.z += 0.05;
      kg.quaternion.copy(shaft.quaternion);
      const glove = left ? L.gloveL : L.gloveR;
      glove.position.copy(left ? j.handL : j.handR);
      glove.quaternion.identity();
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.skeleton.dispose();
    this.material.dispose();
    this.atlas.dispose();
  }
}

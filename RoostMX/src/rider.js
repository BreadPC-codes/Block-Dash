// Motocross rider built from primitives and posed procedurally every frame:
// hands stay on the (steering) grips and feet on the pegs via two-bone IK, while the
// pelvis/torso move with stance (sit/stand), weight shift, suspension and landings.
// After a crash the rider detaches and follows the physics ragdoll with a flailing pose.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GEO } from './bike-geometry.js';
import { makeGraphicTexture } from './textures.js';
import { clamp, damp, lerp } from './util.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);

const LEN = { thigh: 0.43, shin: 0.43, upper: 0.29, fore: 0.27, spine: 0.44 };

function capsule(r, len, mat, radial = 10) {
  const g = new THREE.CapsuleGeometry(r, len, 4, radial);
  g.translate(0, len / 2, 0);
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

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
const _ikD = V(0, 0, 0), _ikP = V(0, 0, 0);
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
    this.mats = {
      jersey: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75 }),
      sleeve: new THREE.MeshStandardMaterial({ color: primary, roughness: 0.75 }),
      pants: new THREE.MeshStandardMaterial({ color: 0x2a2b2e, roughness: 0.8 }),
      pantsAccent: new THREE.MeshStandardMaterial({ color: primary, roughness: 0.7 }),
      boots: new THREE.MeshStandardMaterial({ color: 0xeeeeec, roughness: 0.55 }),
      bootSole: new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 }),
      gloves: new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.8 }),
      helmet: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25, metalness: 0.05 }),
      visor: new THREE.MeshStandardMaterial({ color: primary, roughness: 0.4 }),
      goggleStrap: new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.7 }),
      lens: new THREE.MeshStandardMaterial({ color: 0x5b2fbf, roughness: 0.05, metalness: 0.9, emissive: 0x150a30 }),
      brace: new THREE.MeshStandardMaterial({ color: 0x202022, roughness: 0.6 }),
    };
    this._applyGraphics(primary);
    const m = this.mats;
    const G = this.group;
    // torso (jersey with chest protector bulk)
    const torsoGeo = new THREE.CapsuleGeometry(0.15, 0.3, 6, 14);
    torsoGeo.scale(1.22, 1, 0.82);
    torsoGeo.translate(0, 0.15 + 0.02, 0);
    this.torso = new THREE.Mesh(torsoGeo, m.jersey);
    this.torso.castShadow = true;
    G.add(this.torso);
    const hips = new THREE.CapsuleGeometry(0.12, 0.14, 4, 10);
    hips.rotateZ(Math.PI / 2);
    this.hips = new THREE.Mesh(hips, m.pants);
    this.hips.castShadow = true;
    G.add(this.hips);
    // neck brace
    const brace = new THREE.TorusGeometry(0.1, 0.035, 8, 18);
    brace.rotateX(Math.PI / 2);
    this.brace = new THREE.Mesh(brace, m.brace);
    G.add(this.brace);
    // helmet
    this.head = new THREE.Group();
    const shell = new THREE.SphereGeometry(0.155, 24, 18);
    shell.scale(1, 1.03, 1.16);
    const shellMesh = new THREE.Mesh(shell, m.helmet);
    shellMesh.castShadow = true;
    this.head.add(shellMesh);
    const chin = new RoundedBoxGeometry(0.17, 0.09, 0.12, 2, 0.04);
    chin.translate(0, -0.09, 0.13);
    chin.rotateX(0.25);
    this.head.add(new THREE.Mesh(chin, m.helmet));
    const peak = new RoundedBoxGeometry(0.2, 0.018, 0.15, 2, 0.008);
    peak.rotateX(-0.28);
    peak.translate(0, 0.085, 0.17);
    this.head.add(new THREE.Mesh(peak, m.visor));
    const strap = new THREE.TorusGeometry(0.158, 0.016, 6, 28);
    strap.scale(1, 1, 1.15);
    strap.rotateX(Math.PI / 2 - 0.12);
    strap.translate(0, 0.0, 0.0);
    this.head.add(new THREE.Mesh(strap, m.goggleStrap));
    const lens = new RoundedBoxGeometry(0.16, 0.055, 0.03, 2, 0.012);
    lens.translate(0, 0.012, 0.172);
    this.head.add(new THREE.Mesh(lens, m.lens));
    G.add(this.head);
    // limbs
    const mk = (r, len, mat) => {
      const c = capsule(r, len, mat);
      G.add(c);
      return c;
    };
    this.limbs = {};
    for (const s of ['L', 'R']) {
      this.limbs['thigh' + s] = mk(0.072, LEN.thigh, m.pants);
      this.limbs['shin' + s] = mk(0.056, LEN.shin, m.pants);
      this.limbs['upper' + s] = mk(0.054, LEN.upper, m.sleeve);
      this.limbs['fore' + s] = mk(0.047, LEN.fore, m.sleeve);
      // boot: tall shaft + foot
      const shaft = capsule(0.064, 0.22, m.boots);
      G.add(shaft);
      this.limbs['bootShaft' + s] = shaft;
      const foot = new THREE.Group();
      const footGeo = new RoundedBoxGeometry(0.1, 0.085, 0.27, 2, 0.03);
      footGeo.translate(0, 0, 0.06);
      const fm = new THREE.Mesh(footGeo, m.boots);
      fm.castShadow = true;
      foot.add(fm);
      const sole = new RoundedBoxGeometry(0.105, 0.025, 0.28, 1, 0.01);
      sole.translate(0, -0.05, 0.06);
      foot.add(new THREE.Mesh(sole, m.bootSole));
      G.add(foot);
      this.limbs['foot' + s] = foot;
      const glove = new RoundedBoxGeometry(0.075, 0.07, 0.11, 2, 0.025);
      const gm = new THREE.Mesh(glove, m.gloves);
      gm.castShadow = true;
      G.add(gm);
      this.limbs['glove' + s] = gm;
      // knee guard
      const kg = new RoundedBoxGeometry(0.09, 0.14, 0.05, 2, 0.02);
      const km = new THREE.Mesh(kg, m.pantsAccent);
      G.add(km);
      this.limbs['knee' + s] = km;
    }
    // joints state (bike space while riding)
    this.j = {};
    for (const k of ['pelvis', 'chest', 'neck', 'headC', 'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR', 'shL', 'shR', 'elL', 'elR', 'handL', 'handR', 'footL', 'footR']) this.j[k] = V(0, 0, 0);
    // smoothed pose parameters
    this.pose = { stand: 1, fore: 0, side: 0, crouch: 0, dabL: 0, dabR: 0, twist: 0, look: 0 };
    this.flail = 0;
    this.firstPerson = false;
  }

  _applyGraphics(primary) {
    const tex = makeGraphicTexture(primary, '#ffffff', '#111111', 7);
    if (this.mats.jersey.map) this.mats.jersey.map.dispose();
    this.mats.jersey.map = tex;
    this.mats.jersey.needsUpdate = true;
    const htex = makeGraphicTexture('#f4f4f4', primary, '#111111', 11);
    if (this.mats.helmet.map) this.mats.helmet.map.dispose();
    this.mats.helmet.map = htex;
    this.mats.helmet.needsUpdate = true;
  }

  setColor(primary) {
    this.primary = primary;
    this.mats.sleeve.color.set(primary);
    this.mats.pantsAccent.color.set(primary);
    this.mats.visor.color.set(primary);
    this._applyGraphics(primary);
  }

  setFirstPerson(fp) {
    this.firstPerson = fp;
    this.head.visible = !fp;
    this.brace.visible = !fp;
  }

  /**
   * Pose the rider on the bike. s = {
   *  stance, riderLean (-1..1), legE (m), lean (bike roll rad), steer, speed, airborne,
   *  throttle, brake, whip, compF, compR, landing (0..1), offset (Vector3), scale }
   */
  updateRiding(dt, s, gripL, gripR) {
    const P = this.pose;
    const t = Math.min(1, dt);
    P.stand = damp(P.stand, s.stance, 8, t);
    P.fore = damp(P.fore, s.riderLean, 9, t);
    P.side = damp(P.side, clamp(-s.lean * 0.55 + s.whip * 0.25, -0.5, 0.5), 7, t);
    P.crouch = damp(P.crouch, clamp(-s.legE / 0.3, -0.4, 1), 18, t);
    const cornering = !s.airborne && P.stand < 0.6 && Math.abs(s.lean) > 0.22 && s.speed < 16 && s.speed > 1;
    P.dabL = damp(P.dabL, cornering && s.lean < 0 ? 1 : 0, 5, t);
    P.dabR = damp(P.dabR, cornering && s.lean > 0 ? 1 : 0, 5, t);
    P.twist = damp(P.twist, s.whip * 0.3, 6, t);
    P.look = damp(P.look, clamp(-s.steer * 1.2, -0.5, 0.5), 5, t);
    const st = P.stand, fore = P.fore;
    const j = this.j;
    // pelvis
    const seatY = GEO.seat[1] + 0.07;
    const pz = lerp(-0.16, -0.1, st) + fore * lerp(0.1, 0.17, st) + (1 - st) * 0.06;
    const py = lerp(seatY, 1.2, st) - P.crouch * lerp(0.03, 0.2, st) - Math.abs(fore) * 0.04 * st;
    j.pelvis.set(P.side * 0.12 * st, py, pz);
    // spine leaning forward (attack position)
    const spineAng = lerp(0.42, 0.62, st) + fore * 0.32 + P.crouch * 0.18 - (s.brake || 0) * 0.08;
    const sideAng = P.side * 0.6;
    const spineDir = V(Math.sin(sideAng) * 0.5, Math.cos(spineAng), Math.sin(spineAng)).normalize();
    j.chest.copy(j.pelvis).addScaledVector(spineDir, LEN.spine);
    j.neck.copy(j.chest).addScaledVector(spineDir, 0.08);
    // head looks forward (counter-rotate spine pitch)
    j.headC.copy(j.neck).add(V(P.look * 0.05, 0.13, 0.05));
    // shoulders
    const shW = 0.19;
    const lat = V(1, 0, 0);
    j.shL.copy(j.chest).addScaledVector(lat, shW).add(V(0, -0.03, P.twist * 0.08));
    j.shR.copy(j.chest).addScaledVector(lat, -shW).add(V(0, -0.03, -P.twist * 0.08));
    // hips
    j.hipL.copy(j.pelvis).add(V(0.1, -0.03, 0));
    j.hipR.copy(j.pelvis).add(V(-0.1, -0.03, 0));
    // hands on grips
    j.handL.copy(gripL);
    j.handR.copy(gripR);
    // feet on pegs (or dabbing forward in corners)
    const peg = GEO.pegs;
    const footBase = (sx, dab) => V(sx * (peg[0] + 0.03 + dab * 0.08), peg[1] + 0.06 + dab * 0.06, peg[2] - 0.02 + dab * 0.5);
    j.ankleL.copy(footBase(1, P.dabL));
    j.ankleR.copy(footBase(-1, P.dabR));
    // IK legs (knees forward and slightly out)
    const kneePole = V(0, 0.15, 1);
    solveIK(j.hipL, j.ankleL, LEN.thigh, LEN.shin, kneePole.clone().add(V(0.25, 0, 0)), j.kneeL, j.ankleL);
    solveIK(j.hipR, j.ankleR, LEN.thigh, LEN.shin, kneePole.clone().add(V(-0.25, 0, 0)), j.kneeR, j.ankleR);
    // IK arms (elbows out and up)
    solveIK(j.shL, j.handL, LEN.upper, LEN.fore, V(1, 0.35, -0.6), j.elL, j.handL);
    solveIK(j.shR, j.handR, LEN.upper, LEN.fore, V(-1, 0.35, -0.6), j.elR, j.handR);
    this._applyMeshes(spineDir, 0);
  }

  /** Flailing pose used while the rider tumbles after a crash (rider-local space). */
  updateRagdoll(dt, grounded) {
    this.flail += dt * (grounded ? 2 : 9);
    const f = this.flail;
    const j = this.j;
    const amp = grounded ? 0.15 : 0.5;
    j.pelvis.set(0, 0, 0);
    const spineDir = V(Math.sin(f * 0.7) * 0.2 * amp, 1, Math.cos(f * 0.9) * 0.3 * amp).normalize();
    j.chest.copy(j.pelvis).addScaledVector(spineDir, LEN.spine);
    j.neck.copy(j.chest).addScaledVector(spineDir, 0.08);
    j.headC.copy(j.neck).add(V(0, 0.13, 0.03));
    j.shL.copy(j.chest).add(V(0.19, -0.03, 0));
    j.shR.copy(j.chest).add(V(-0.19, -0.03, 0));
    j.hipL.set(0.1, -0.03, 0);
    j.hipR.set(-0.1, -0.03, 0);
    j.handL.copy(j.shL).add(V(0.35 + Math.sin(f) * amp * 0.3, 0.2 + Math.cos(f * 1.3) * amp * 0.4, Math.sin(f * 0.8) * amp * 0.3));
    j.handR.copy(j.shR).add(V(-0.35 - Math.sin(f * 1.1) * amp * 0.3, 0.15 + Math.sin(f * 1.4) * amp * 0.4, Math.cos(f) * amp * 0.3));
    j.ankleL.copy(j.hipL).add(V(0.2 + Math.sin(f * 0.9) * amp * 0.2, -0.78, Math.cos(f * 1.2) * amp * 0.4));
    j.ankleR.copy(j.hipR).add(V(-0.2 - Math.cos(f) * amp * 0.2, -0.78, Math.sin(f * 1.1) * amp * 0.4));
    solveIK(j.hipL, j.ankleL, LEN.thigh, LEN.shin, V(0.2, 0, 1), j.kneeL, j.ankleL);
    solveIK(j.hipR, j.ankleR, LEN.thigh, LEN.shin, V(-0.2, 0, 1), j.kneeR, j.ankleR);
    solveIK(j.shL, j.handL, LEN.upper, LEN.fore, V(0.5, -0.5, -0.5), j.elL, j.handL);
    solveIK(j.shR, j.handR, LEN.upper, LEN.fore, V(-0.5, -0.5, -0.5), j.elR, j.handR);
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
    this.head.rotation.set(ragdoll ? 0.3 : -0.12 + this.pose.fore * 0.05, this.pose.look, 0);
    place(L.thighL, j.hipL, j.kneeL);
    place(L.thighR, j.hipR, j.kneeR);
    place(L.shinL, j.kneeL, j.ankleL);
    place(L.shinR, j.kneeR, j.ankleR);
    place(L.upperL, j.shL, j.elL);
    place(L.upperR, j.shR, j.elR);
    place(L.foreL, j.elL, j.handL);
    place(L.foreR, j.elR, j.handR);
    // boots: shaft from ankle up the shin
    for (const s of ['L', 'R']) {
      const knee = j['knee' + s], ankle = j['ankle' + s];
      const shaft = L['bootShaft' + s];
      shaft.position.copy(ankle);
      _d.subVectors(knee, ankle).normalize();
      shaft.quaternion.setFromUnitVectors(UP, _d);
      const foot = L['foot' + s];
      foot.position.copy(ankle).add(V(0, -0.04, 0.02));
      foot.rotation.set(ragdoll ? 0.6 : 0, 0, 0);
      const kg = L['knee' + s];
      kg.position.copy(knee).add(V(0, 0, 0.05));
      kg.quaternion.copy(shaft.quaternion);
      const glove = L['glove' + s];
      glove.position.copy(j['hand' + s]);
      glove.quaternion.identity();
    }
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh) o.geometry.dispose();
    });
    for (const k in this.mats) {
      const m = this.mats[k];
      if (m.map) m.map.dispose();
      m.dispose();
    }
  }
}

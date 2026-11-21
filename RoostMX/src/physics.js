// Custom motocross physics.
//
// The bike + rider is one 6-DOF rigid body integrated at a fixed timestep (240 Hz).
// Each wheel finds its contact with the heightfield (tangent-plane + edge sampling for
// lips and steps), a progressive spring/damper suspension produces the normal load, and a
// combined-slip tire model (longitudinal slip ratio + slip angle sharing one friction
// circle) produces drive, braking and cornering forces. The rear wheel is driven through
// an auto clutch and 5-speed gearbox by an engine with a torque curve and rev limiter.
//
// Riding a two-wheeler needs balance, so a rider model leans the bike toward a target
// lean angle (from steering input, speed and available grip) and the front wheel steers
// to the angle that keeps that lean in balance. If the tires lose grip the balance breaks
// and the bike falls - crashes come from the physics, never from random rolls.

import { Vector3, Quaternion } from 'three';
import { SURFACES, SURF } from './heightfield.js';
import { clamp, lerp, smoothstep } from './util.js';
import { GEO, AXIS_FRONT, AXIS_REAR } from './bike-geometry.js';

export const PHYSICS_DT = 1 / 240;
const G = 9.81;
const RPM_PER_RADS = 60 / (2 * Math.PI);

// Tire curve: sin(C * atan(B * s)), peak at s = 1
const SHAPE_C = 1.65;
const SHAPE_B = Math.tan(Math.PI / (2 * SHAPE_C));
const SHAPE_SLOPE0 = SHAPE_C * SHAPE_B;
const tireShape = (s) => Math.sin(SHAPE_C * Math.atan(SHAPE_B * s));
const KAPPA_PEAK = 0.17;
const TAN_ALPHA_PEAK = Math.tan(11 * Math.PI / 180);
const V_SLIP_MIN = 3.0;

export const DEFAULT_TUNE = {
  steerSens: 1.0,
  enginePower: 1.0,
  suspStiffness: 1.0,
  suspDamping: 1.0,
  brakeFront: 1.0,
  brakeRear: 1.0,
  assist: 2, // 0 = off, 1 = low, 2 = full
  autoGearbox: true,
};

// ---------------------------------------------------------------------------
// Engine and gearbox
// ---------------------------------------------------------------------------
const TORQUE_TABLE = [
  [800, 14], [1500, 24], [2500, 31], [3500, 37], [4500, 41.5], [5500, 45], [6500, 47.2],
  [7500, 48.2], [8500, 47.6], [9500, 45.8], [10500, 42.6], [11500, 37.8], [12200, 32], [12600, 18],
];

export class Engine {
  constructor() {
    this.ratios = [22.0, 17.8, 14.8, 12.6, 11.0];
    this.idle = 1750;
    this.limiter = 12150;
    this.maxRpm = 12600;
    this.inertia = 0.012;
    this.efficiency = 0.92;
    this.reset();
  }

  reset() {
    this.rpm = this.idle;
    this.gear = 1;
    this.shiftTimer = 0;
    this.pendingGear = 1;
    this.locked = false;
    this.cutoff = false;
    this.load = 0;
    this.autoCooldown = 0;
    this.stalled = false;
    this.lastShift = 0;
  }

  torque(rpm) {
    const t = TORQUE_TABLE;
    if (rpm <= t[0][0]) return t[0][1];
    for (let i = 1; i < t.length; i++) {
      if (rpm <= t[i][0]) {
        const a = t[i - 1], b = t[i];
        return a[1] + ((b[1] - a[1]) * (rpm - a[0])) / (b[0] - a[0]);
      }
    }
    return t[t.length - 1][1];
  }

  get ratio() {
    return this.ratios[this.gear - 1];
  }

  shift(dir) {
    if (this.shiftTimer > 0) return false;
    const g = this.gear + dir;
    if (g < 1 || g > this.ratios.length) return false;
    this.pendingGear = g;
    this.shiftTimer = 0.1;
    this.locked = false;
    this.lastShift = dir;
    return true;
  }

  /**
   * Advance the engine and return the torque at the rear wheel and the inertia
   * reflected to the wheel (when the clutch is locked).
   */
  update(dt, throttle, omegaRear, power, clutchIn, out) {
    const ratio = this.ratio;
    const wheelRpm = omegaRear * ratio * RPM_PER_RADS;
    if (this.autoCooldown > 0) this.autoCooldown -= dt;
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
      const target = omegaRear * this.ratios[this.pendingGear - 1] * RPM_PER_RADS;
      this.rpm += (Math.max(target, this.idle) - this.rpm) * Math.min(1, dt * 22);
      if (this.shiftTimer <= 0) {
        this.gear = this.pendingGear;
        if (target > 2200) {
          this.locked = true;
          this.rpm = target;
        }
      }
      this.load = 0;
      out.torque = 0;
      out.inertia = 0;
      return out;
    }
    if (this.rpm > this.limiter) this.cutoff = true;
    else if (this.rpm < this.limiter - 350) this.cutoff = false;
    const thr = this.cutoff ? 0 : throttle;
    this.load = thr;
    const drag = 1.1 + this.rpm * 0.00052;
    const tEng = thr * this.torque(this.rpm) * power - (1 - thr) * drag;
    if (clutchIn) this.locked = false;
    if (this.locked) {
      if (wheelRpm < 1350 || (wheelRpm < 1900 && thr < 0.15)) {
        this.locked = false;
      } else {
        this.rpm = wheelRpm;
        out.torque = tEng * ratio * this.efficiency;
        out.inertia = this.inertia * ratio * ratio;
        if (this.rpm > this.maxRpm) this.rpm = this.maxRpm;
        return out;
      }
    }
    // Slipping auto-clutch (centrifugal style): engagement rises with engine rpm.
    let engage = clutchIn ? 0 : smoothstep(2000, 4300, this.rpm);
    if (!clutchIn && wheelRpm > 2400) engage = 1;
    const cap = 90 * engage;
    const slip = this.rpm - wheelRpm;
    let tc = clamp(slip * 0.22, -cap, cap);
    const idleT = this.rpm < this.idle ? (this.idle - this.rpm) * 0.05 : 0;
    this.rpm += ((tEng + idleT - tc) / this.inertia) * dt * RPM_PER_RADS;
    if (this.rpm < 800) this.rpm = 800;
    if (this.rpm > this.maxRpm) this.rpm = this.maxRpm;
    if (!clutchIn && wheelRpm > 2400 && Math.abs(this.rpm - wheelRpm) < 400) {
      this.locked = true;
      this.rpm = wheelRpm;
    }
    out.torque = tc * ratio * this.efficiency;
    out.inertia = 0;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Wheel
// ---------------------------------------------------------------------------
class Wheel {
  constructor(isFront) {
    this.isFront = isFront;
    const axle = isFront ? GEO.frontAxle : GEO.rearAxle;
    const axis = isFront ? AXIS_FRONT : AXIS_REAR;
    this.radius = isFront ? GEO.rFront : GEO.rRear;
    this.tube = isFront ? GEO.tubeFront : GEO.tubeRear;
    this.travel = isFront ? GEO.travelF : GEO.travelR;
    this.sag = isFront ? GEO.sagF : GEO.sagR;
    this.inertia = isFront ? 0.42 : 0.62;
    this.axis = new Vector3(axis[0], axis[1], axis[2]);
    this.axleStatic = new Vector3(axle[0], axle[1], axle[2]);
    // hub at full extension, bike space
    this.hubExt = this.axleStatic.clone().addScaledVector(this.axis, -this.sag);
    this.baseK = 0;
    this.k = 0;
    this.cComp = 0;
    this.cReb = 0;
    this.prog = 1.25;
    // contact info
    this.normal = new Vector3(0, 1, 0);
    this.point = new Vector3();
    this.hub = new Vector3();
    this.reset();
  }

  reset() {
    this.omega = 0;
    this.angle = 0;
    this.compression = this.sag;
    this.visComp = this.sag;
    this.contact = false;
    this.load = 0;
    this.slip = 0;
    this.slipRatio = 0;
    this.slipAngle = 0;
    this.slideSpeed = 0;
    this.surface = SURF.DIRT;
    this.fx = 0;
    this.fy = 0;
    this.bottomed = false;
    this.airTime = 0;
    this.xdF = 0;
    this.loadF = 0;
  }
}

// ---------------------------------------------------------------------------
// Rider ragdoll (after a crash the rider separates and tumbles)
// ---------------------------------------------------------------------------
export class RiderRagdoll {
  constructor() {
    this.pos = new Vector3();
    this.vel = new Vector3();
    this.quat = new Quaternion();
    this.angVel = new Vector3();
    this.active = false;
    this.grounded = false;
    this.settle = 0;
    this._n = new Vector3();
    this._dq = new Quaternion();
  }

  start(pos, vel, quat, angVel) {
    this.pos.copy(pos);
    this.vel.copy(vel);
    this.quat.copy(quat);
    this.angVel.copy(angVel);
    this.active = true;
    this.grounded = false;
    this.settle = 0;
  }

  step(dt, terrain, colliders) {
    if (!this.active) return;
    const r = 0.3;
    this.vel.y -= G * dt;
    const h = terrain.height(this.pos.x, this.pos.z);
    const pen = h + r - this.pos.y;
    this.grounded = pen > 0;
    if (pen > 0) {
      const n = terrain.normal(this.pos.x, this.pos.z, this._n);
      const vn = this.vel.dot(n);
      // push out and bounce a little
      this.pos.addScaledVector(n, pen * n.y);
      if (vn < 0) this.vel.addScaledVector(n, -vn * 1.25);
      // friction
      const vt = this.vel.clone().addScaledVector(n, -this.vel.dot(n));
      const speed = vt.length();
      if (speed > 1e-4) {
        const dec = Math.min(speed, 6.5 * dt + speed * 2.2 * dt);
        this.vel.addScaledVector(vt, -dec / speed);
      }
      // tumbling: roll along the ground
      const roll = new Vector3().crossVectors(n, vt).multiplyScalar(1 / r);
      this.angVel.lerp(roll, Math.min(1, dt * 6));
      this.angVel.multiplyScalar(Math.max(0, 1 - dt * 1.5));
    } else {
      this.angVel.multiplyScalar(Math.max(0, 1 - dt * 0.2));
    }
    if (colliders) {
      const hit = colliders.sphereHit(this.pos.x, this.pos.y, this.pos.z, 0.35, {});
      if (hit && hit.item.hard) {
        this.pos.x += hit.nx * hit.depth;
        this.pos.z += hit.nz * hit.depth;
        const vn = this.vel.x * hit.nx + this.vel.z * hit.nz;
        if (vn < 0) {
          this.vel.x -= 1.3 * vn * hit.nx;
          this.vel.z -= 1.3 * vn * hit.nz;
        }
      }
    }
    this.pos.addScaledVector(this.vel, dt);
    const w = this.angVel;
    const a = w.length() * dt;
    if (a > 1e-7) {
      this._dq.setFromAxisAngle(w.clone().normalize(), a);
      this.quat.premultiply(this._dq).normalize();
    }
    if (this.grounded && this.vel.lengthSq() < 0.5) this.settle += dt;
    else this.settle = 0;
  }
}

// ---------------------------------------------------------------------------
// Bike body
// ---------------------------------------------------------------------------
const HARD_POINTS = [
  { name: 'bash', p: [0, 0.27, 0.06], crash: false, mu: 0.35 },
  { name: 'pegL', p: [0.2, 0.37, -0.1], crash: false, mu: 0.5 },
  { name: 'pegR', p: [-0.2, 0.37, -0.1], crash: false, mu: 0.5 },
  { name: 'barL', p: [0.41, 1.07, 0.32], crash: true, mu: 0.6 },
  { name: 'barR', p: [-0.41, 1.07, 0.32], crash: true, mu: 0.6 },
  { name: 'fenderF', p: [0, 0.8, 1.08], crash: true, mu: 0.5 },
  { name: 'fenderR', p: [0, 0.98, -1.07], crash: true, mu: 0.5 },
  { name: 'seat', p: [0, 0.97, -0.5], crash: true, mu: 0.6 },
  { name: 'shroudL', p: [0.25, 0.86, 0.3], crash: true, mu: 0.6 },
  { name: 'shroudR', p: [-0.25, 0.86, 0.3], crash: true, mu: 0.6 },
  { name: 'pipe', p: [-0.19, 0.78, -0.66], crash: true, mu: 0.5 },
  { name: 'head', p: null, crash: true, mu: 0.6 },
].map((h) => ({ ...h, v: h.p ? new Vector3(h.p[0], h.p[1], h.p[2]) : new Vector3() }));

// temporaries
const _v1 = new Vector3(), _v2 = new Vector3(), _v3 = new Vector3(), _v4 = new Vector3();
const _n = new Vector3(), _nTmp = new Vector3();
const _r = new Vector3();
const _hub = new Vector3();
const _tl = new Vector3(), _tt = new Vector3();
const _vc = new Vector3();
const _wEff = new Vector3();
const _force = new Vector3(), _torque = new Vector3();
const _dq = new Quaternion();

export class BikePhysics {
  constructor(terrain, colliders = null) {
    this.terrain = terrain;
    this.colliders = colliders;
    this.pos = new Vector3();
    this.vel = new Vector3();
    this.quat = new Quaternion();
    this.angVel = new Vector3();
    this.prevPos = new Vector3();
    this.prevQuat = new Quaternion();
    // basis (world)
    this.right = new Vector3(-1, 0, 0);
    this.up = new Vector3(0, 1, 0);
    this.fwd = new Vector3(0, 0, 1);
    this.left = new Vector3(1, 0, 0);
    this.m = new Float32Array(9);
    this.com = new Vector3(); // current CoM in bike space
    this.front = new Wheel(true);
    this.rear = new Wheel(false);
    this.wheels = [this.front, this.rear];
    this.engine = new Engine();
    this.ragdoll = new RiderRagdoll();
    this.tune = { ...DEFAULT_TUNE };
    this.events = [];
    this.drive = { torque: 0, inertia: 0 };
    this.applyTune();
    this.reset(new Vector3(0, 1, 0), 0);
  }

  applyTune(t) {
    if (t) Object.assign(this.tune, t);
    const mTot = GEO.massBike + GEO.massRider;
    // static load split from the rider-seated CoM
    const zc = (GEO.massBike * GEO.comBike[2] + GEO.massRider * GEO.riderStanding[2]) / mTot;
    const fracF = (zc - GEO.rearAxle[2]) / GEO.wheelbase;
    const loadF = mTot * G * fracF, loadR = mTot * G * (1 - fracF);
    const ks = this.tune.suspStiffness, kd = this.tune.suspDamping;
    for (const w of this.wheels) {
      const load = w.isFront ? loadF : loadR;
      w.baseK = load / (w.sag * (1 + w.prog * (w.sag / w.travel) ** 2));
      w.k = w.baseK * ks;
      const mEff = load / G;
      const crit = 2 * Math.sqrt(w.k * mEff);
      w.cComp = crit * 0.32 * kd;
      w.cReb = crit * 0.58 * kd;
    }
  }

  /** Place the bike upright on the terrain at (x,z) facing heading (radians, 0 = +Z). */
  reset(pos, heading) {
    this.crashed = false;
    this.crashTimer = 0;
    this.crashReason = '';
    this.ragdoll.active = false;
    this.mass = GEO.massBike + GEO.massRider;
    this.inertia = new Vector3(52, 46, 26); // pitch (X), yaw (Y), roll (Z)
    this.stance = 1;
    this.riderLean = 0;
    // rider legs: offset of the rider along the bike's up axis (m) and its rate
    this.riderE = 0;
    this.riderEv = 0;
    this.chassisShift = 0; // chassis offset along up relative to the rigid CoM frame
    this.chassisShiftVel = 0;
    this.leanTarget = 0;
    this.leanAngle = 0;
    this.pitchAngle = 0;
    this.steerAngle = 0;
    this.airTime = 0;
    this.lastAirTime = 0;
    this.groundTime = 0;
    this.airborne = false;
    this.wasAirborne = false;
    this.maxAirHeight = 0;
    this.impactTimer = 0;
    this.frontTuck = 0;
    this.muLat = 1;
    this.speed = 0;
    this.forwardSpeed = 0;
    this.throttle = 0;
    this.brakeF = 0;
    this.brakeR = 0;
    this.steerIn = 0;
    this.leanIn = 0;
    this.wheelieAngle = 0;
    this.events.length = 0;
    this.engine.reset();
    for (const w of this.wheels) w.reset();
    this._updateCom(true);
    this.quat.setFromAxisAngle(_v1.set(0, 1, 0), heading);
    this._basis();
    // place so that the wheels sit at static sag on the ground below
    const h = this.terrain.height(pos.x, pos.z);
    // bike-space origin is on the ground at static sag; CoM is above it
    this.pos.set(pos.x, h, pos.z).add(this.toWorldDir(this.com, _v1));
    this.pos.y += 0.02;
    this.vel.set(0, 0, 0);
    this.angVel.set(0, 0, 0);
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
  }

  // --- basis helpers ----------------------------------------------------------
  _basis() {
    const q = this.quat;
    const x = q.x, y = q.y, z = q.z, w = q.w;
    const m = this.m;
    m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y - z * w); m[2] = 2 * (x * z + y * w);
    m[3] = 2 * (x * y + z * w); m[4] = 1 - 2 * (x * x + z * z); m[5] = 2 * (y * z - x * w);
    m[6] = 2 * (x * z - y * w); m[7] = 2 * (y * z + x * w); m[8] = 1 - 2 * (x * x + y * y);
    this.left.set(m[0], m[3], m[6]);
    this.right.set(-m[0], -m[3], -m[6]);
    this.up.set(m[1], m[4], m[7]);
    this.fwd.set(m[2], m[5], m[8]);
  }

  toWorldDir(v, out) {
    const m = this.m;
    return out.set(m[0] * v.x + m[1] * v.y + m[2] * v.z, m[3] * v.x + m[4] * v.y + m[5] * v.z, m[6] * v.x + m[7] * v.y + m[8] * v.z);
  }

  /** World position of a bike-space point. */
  bikeToWorld(p, out) {
    _v4.set(p.x - this.com.x, p.y - this.com.y, p.z - this.com.z);
    this.toWorldDir(_v4, out);
    return out.add(this.pos);
  }

  /** World position of the bike-space origin (used by the visual model). */
  originWorld(out) {
    _v4.set(-this.com.x, -this.com.y, -this.com.z);
    this.toWorldDir(_v4, out);
    return out.add(this.pos);
  }

  riderBikeSpace(out) {
    const a = GEO.riderSeated, b = GEO.riderStanding;
    const t = this.stance;
    return out.set(
      lerp(a[0], b[0], t),
      lerp(a[1], b[1], t) - Math.abs(this.riderLean) * 0.05,
      lerp(a[2], b[2], t) + this.riderLean * 0.16
    );
  }

  _updateCom(force) {
    const prev = _v3.copy(this.com);
    if (this.crashed) {
      this.com.set(GEO.comBike[0], GEO.comBike[1], GEO.comBike[2]);
    } else {
      const r = this.riderBikeSpace(_v2);
      const mb = GEO.massBike, mr = GEO.massRider;
      const inv = 1 / (mb + mr);
      this.com.set((mb * GEO.comBike[0] + mr * r.x) * inv, (mb * GEO.comBike[1] + mr * r.y) * inv, (mb * GEO.comBike[2] + mr * r.z) * inv);
    }
    if (!force) {
      // keep the chassis in place: shift the body position by the CoM change
      _v1.subVectors(this.com, prev);
      this.toWorldDir(_v1, _v2);
      this.pos.add(_v2);
    }
  }

  headBikeSpace(out) {
    const a = GEO.headSeated, b = GEO.headStanding;
    const t = this.stance;
    return out.set(0, lerp(a[1], b[1], t), lerp(a[2], b[2], t) + this.riderLean * 0.22);
  }

  // --- main step --------------------------------------------------------------
  step(dt, input) {
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    this._basis();
    const crashed = this.crashed;
    const tune = this.tune;

    // ---- inputs
    const throttleIn = crashed ? 0 : input.throttle;
    this.brakeF = crashed ? 0 : input.brakeF;
    this.brakeR = crashed ? 0 : input.brakeR;
    this.steerIn = crashed ? 0 : clamp(input.steer * tune.steerSens, -1, 1);
    this.leanIn = crashed ? 0 : input.lean;

    const vel = this.vel;
    this.forwardSpeed = vel.dot(this.fwd);
    this.speed = vel.length();
    const speed = Math.abs(this.forwardSpeed);

    // ---- rider stance / weight shift (moves the CoM)
    if (!crashed) {
      const leanNow = Math.asin(clamp(-this.right.y, -1, 1));
      const wantStand = this.airborne || (speed > 6.5 && Math.abs(leanNow) < 0.38) || Math.abs(this.leanIn) > 0.5;
      this.stance += clamp((wantStand ? 1 : 0) - this.stance, -dt * 2.2, dt * 2.2);
      // riders lean forward to accelerate and back when braking
      const auto = tune.assist > 0 && !this.airborne ? 1 : 0.5;
      const autoLean = auto * (0.7 * input.throttle * (this.engine.gear <= 3 ? 1 : 0.6) - 0.5 * input.brakeF - 0.2 * input.brakeR);
      const leanGoal = clamp(this.leanIn + (this.airborne ? 0 : autoLean), -1, 1);
      this.riderLean += clamp(leanGoal - this.riderLean, -dt * 4, dt * 4);
      this._updateCom(false);
    }

    // ---- lean / steering targets
    const right = this.right, up = this.up, fwd = this.fwd;
    const phi = Math.asin(clamp(-right.y, -1, 1));
    this.leanAngle = phi;
    this.pitchAngle = Math.asin(clamp(fwd.y, -1, 1));
    const phiDot = this.angVel.dot(fwd);

    // average ground normal & surface for grip estimates
    let nAvgX = 0, nAvgY = 0, nAvgZ = 0, muAvg = 0, cnt = 0;
    for (const w of this.wheels) {
      if (w.contact) {
        nAvgX += w.normal.x; nAvgY += w.normal.y; nAvgZ += w.normal.z;
        muAvg += SURFACES[w.surface].mu;
        cnt++;
      }
    }
    if (cnt === 0) { nAvgY = 1; muAvg = 1; cnt = 1; }
    nAvgX /= cnt; nAvgY /= cnt; nAvgZ /= cnt; muAvg /= cnt;

    const assist = tune.assist;
    if (!crashed) {
      // horizontal right vector
      let rhx = right.x, rhz = right.z;
      const rhl = Math.hypot(rhx, rhz) || 1;
      rhx /= rhl; rhz /= rhl;
      const nb = nAvgX * rhx + nAvgZ * rhz; // ground tilt toward the bike's right
      const dirSign = this.steerIn >= 0 ? 1 : -1;
      const beta = Math.asin(clamp(nb, -0.85, 0.85)) * dirSign;
      // lateral grip actually left in each tire's friction circle (drive/brake use some of it)
      // each axle must carry its share of the cornering force (yaw-moment balance), so the
      // weaker axle (e.g. a front unloaded by throttle) limits how far the bike can lean
      let muNow = 1.4;
      let anyContact = false;
      for (const w of this.wheels) {
        if (!w.contact) continue;
        anyContact = true;
        const Fm = SURFACES[w.surface].mu * w.loadF;
        const lat = Math.sqrt(Math.max(0, Fm * Fm - w.fx * w.fx));
        const share = w.isFront ? 0.49 : 0.51;
        muNow = Math.min(muNow, lat / (this.mass * G * share));
      }
      muNow = anyContact && !this.airborne ? clamp(muNow, 0.12, 1.4) : muAvg;
      this.muLat += (muNow - this.muLat) * (1 - Math.exp(-dt / 0.15));
      const muBase = assist === 0 ? muAvg : Math.min(muAvg, this.muLat);
      const muEst = muBase * (assist === 2 ? 0.82 : assist === 1 ? 0.87 : 1.15);
      const tb = Math.tan(beta);
      const tanMax = clamp((muEst + tb) / Math.max(0.2, 1 - muEst * tb), 0.15, 2.0);
      const leanSpeed = lerp(0.12, 0.98, smoothstep(0.6, 11.5, speed));
      const leanLimit = Math.min(leanSpeed, Math.atan(tanMax));
      this.leanTarget = this.steerIn * leanLimit;

      // steering angle derived from the lean that has to be balanced
      const tanPhi = Math.tan(clamp(phi, -1.25, 1.25));
      const v2 = Math.max(speed * speed, 1);
      const deltaLean = Math.atan((GEO.wheelbase * G * tanPhi) / v2);
      const deltaDirect = this.steerIn * 0.6;
      const wl = smoothstep(1.0, 4.5, speed);
      let delta = lerp(deltaDirect, deltaLean, wl);
      const dmax = lerp(0.62, 0.17, smoothstep(3, 24, speed));
      delta = clamp(delta, -dmax, dmax);
      if (this.front.contact && this.rear.contact && speed > 3 && this.forwardSpeed > 0) {
        // instinctive counter-steer when the rear steps out beyond a normal slip angle
        const ra = this.rear.slipAngle;
        const excess = Math.sign(ra) * Math.max(0, Math.abs(ra) - 0.1);
        delta += 0.9 * excess * smoothstep(3, 8, speed);
      }
      if (this.forwardSpeed < -0.5) delta = deltaDirect; // rolling backwards
      delta = clamp(delta, -0.66, 0.66);
      this.steerAngle += (delta - this.steerAngle) * (1 - Math.exp(-dt / 0.035));
    } else {
      this.steerAngle *= 1 - dt * 2;
    }

    // ---- engine
    let throttle = throttleIn;
    const pitchRate = this.angVel.dot(right);
    if (!crashed && assist > 0 && this.rear.contact && !this.front.contact) {
      // wheelie control (rider modulating throttle), anticipating the pitch rate
      // with full assists the front is kept just skimming the ground, and lower still when turning
      const turning = Math.min(1, Math.abs(this.steerIn) * 2);
      const lim = (assist === 2 ? 0.07 : 0.2) * (1 - 0.6 * turning);
      const predicted = this.wheelieAngle + 0.25 * pitchRate;
      throttle *= 1 - smoothstep(lim, lim + 0.12, predicted);
    }
    if (!crashed && assist === 2 && Math.abs(phi) > 0.3) {
      // the rider modulates brakes when a tire starts sliding while leaned over
      if (this.rear.slip > 1.3) this.brakeR *= 0.45;
      if (this.front.slip > 1.6) this.brakeF *= 0.6;
    }
    if (!crashed && assist > 0 && this.front.contact && !this.rear.contact && !this.airborne) {
      // stoppie control: ease off the front brake when the rear lifts
      const stoppie = -Math.asin(clamp(fwd.dot(this.front.normal), -1, 1)) - 0.2 * pitchRate;
      const lim = assist === 2 ? 0.12 : 0.3;
      this.brakeF *= 1 - smoothstep(lim, lim + 0.18, stoppie);
    }
    this.throttle = throttle;
    const clutchIn = crashed || (this.airborne && this.brakeR > 0.15);
    const eng = this.engine;
    if (crashed) {
      eng.update(dt, 0, this.rear.omega, 0, true, this.drive);
    } else {
      eng.update(dt, throttle, this.rear.omega, tune.enginePower, clutchIn, this.drive);
      if (tune.autoGearbox && !this.airborne && eng.shiftTimer <= 0 && eng.autoCooldown <= 0) {
        if (eng.rpm > 11300 && eng.gear < 5 && throttle > 0.25 && eng.locked) {
          if (eng.shift(1)) { eng.autoCooldown = 0.5; this.events.push({ type: 'shift', dir: 1 }); }
        } else if (eng.gear > 1 && eng.rpm < 5600) {
          const nr = this.rear.omega * eng.ratios[eng.gear - 2] * RPM_PER_RADS;
          if (nr < 10400) {
            if (eng.shift(-1)) { eng.autoCooldown = 0.45; this.events.push({ type: 'shift', dir: -1 }); }
          }
        }
      }
    }
    let driveTorque = this.drive.torque;
    if (!crashed && assist > 0 && this.rear.contact && driveTorque > 0) {
      // traction control: the rider feathers the throttle when the rear spins up
      const sLim = assist === 2 ? 1.05 : 1.6;
      const sl = this.rear.slip;
      if (sl > sLim && this.rear.slipRatio > 0.05) driveTorque *= clamp(1 - (sl - sLim) / 0.8, 0.15, 1);
    }

    // ---- forces (contacts first, gravity added after so the legs see contact loads only)
    const F = _force.set(0, 0, 0);
    const T = _torque.set(0, 0, 0);
    let groundedCount = 0;
    let bottomHit = 0;
    for (const w of this.wheels) {
      const hit = this._wheel(w, dt, F, T, w.isFront ? 0 : driveTorque, w.isFront ? 0 : this.drive.inertia);
      if (hit) groundedCount++;
      if (w.bottomed) bottomHit++;
    }

    // body hard points
    this._hardPoints(dt, F, T, crashed);

    // ---- rider legs (sprung rider mass absorbs bumps and landings)
    if (!crashed) {
      const mr = GEO.massRider, mb = GEO.massBike;
      const mu = (mr * mb) / (mr + mb);
      const standing = this.stance;
      const k = lerp(26000, 16000, standing);
      const c = lerp(1700, 1250, standing);
      const fcUp = F.dot(up);
      let fLeg = k * this.riderE + c * this.riderEv - mr * G * up.y;
      const e = this.riderE;
      if (e < -0.3) fLeg += (e + 0.3) * 120000;
      if (e > 0.12) fLeg += (e - 0.12) * 120000;
      const acc = -fLeg / mu - fcUp / mb + (this.airborne ? 0 : 0);
      // in the air the contact load is zero; gravity acts on both equally
      this.riderEv += (acc - (this.airborne ? -0 : 0)) * dt;
      this.riderE += this.riderEv * dt;
      if (this.airborne) {
        // legs relax back to neutral in the air
        this.riderEv += (-this.riderE * 30 - this.riderEv * 8) * dt;
      }
      this.riderE = clamp(this.riderE, -0.38, 0.16);
    } else {
      this.riderE *= 1 - dt * 5;
      this.riderEv = 0;
    }
    const shiftPrev = this.chassisShift;
    this.chassisShift = -(GEO.massRider / (GEO.massBike + GEO.massRider)) * this.riderE;
    this.chassisShiftVel = (this.chassisShift - shiftPrev) / dt;
    F.y -= this.mass * G;

    // aero drag
    const sp = vel.length();
    if (sp > 0.1) F.addScaledVector(vel, -0.5 * 1.2 * (crashed ? 0.45 : 0.55) * sp);

    const wasAir = this.airborne;
    this.airborne = groundedCount === 0;
    if (this.airborne && !wasAir && !crashed && this.speed > 7 && this.vel.y > 1.5) this.events.push({ type: 'takeoff', speed: this.speed });

    // ---- rider control torques
    if (!crashed) {
      if (!this.airborne) {
        // balance: lean toward target
        const hEff = 0.8;
        const Iroll = this.inertia.z + this.mass * hEff * hEff;
        const frontGrip = this.front.contact ? 1 - smoothstep(1.4, 3.0, this.front.slip) : 0.7;
        // at low speed MX riders dab a foot, which can save a lot of lean
        const dab = (assist > 0 ? 1700 : 900) * (1 - smoothstep(5, 13, speed));
        const cap = 1500 * (0.15 + 0.85 * frontGrip) + dab;
        let tau = Iroll * (26 * (this.leanTarget - phi) - 8 * phiDot);
        tau = clamp(tau, -cap, cap);
        this.dbgTau = tau;
        this.dbgCap = cap;
        T.addScaledVector(fwd, tau);
        // rider pushes the chassis fore/aft with arms and legs
        T.addScaledVector(right, -this.leanIn * 150);
        // wheelie assist: rider leans forward automatically when looping
        if (assist > 0 && !this.front.contact && this.rear.contact) {
          const lim = assist === 2 ? 0.1 : 0.4;
          if (this.wheelieAngle > lim) T.addScaledVector(right, -(this.wheelieAngle - lim) * (assist === 2 ? 1400 : 600));
        }
        // rider keeps the yaw rate consistent with the lean (throttle/brake/body control)
        const yawRate = this.angVel.dot(up);
        if (speed > 2.5 && assist > 0) {
          const target = -(G * Math.tan(clamp(phi, -1.1, 1.1))) / speed;
          const k = this.inertia.y * (assist === 2 ? 7 : 5);
          const capY = assist === 2 ? 520 : 400;
          T.addScaledVector(up, clamp(k * (target - yawRate), -capY, capY));
        } else {
          T.addScaledVector(up, -yawRate * 4);
        }
      } else {
        // air control: pitch by body English, whip by steering input
        T.addScaledVector(right, -this.leanIn * 230);
        const whip = this.steerIn;
        const Yx = 0, Yy = 1, Yz = 0;
        T.y += -whip * 170;
        T.addScaledVector(fwd, whip * 85);
        const stab = (1 - Math.abs(whip)) * (assist === 2 ? 1.25 : assist === 1 ? 0.85 : 0.5);
        if (stab > 0.01) {
          // straighten the bike with the direction of travel and level it
          let fx = fwd.x, fz = fwd.z;
          const fl = Math.hypot(fx, fz) || 1;
          fx /= fl; fz /= fl;
          let vx = vel.x, vz = vel.z;
          const vl = Math.hypot(vx, vz);
          let yawErr = 0;
          if (vl > 2) {
            vx /= vl; vz /= vl;
            // rotation about +Y takes +Z toward +X: sin = (f x v).y
            yawErr = Math.asin(clamp(fz * vx - fx * vz, -1, 1));
          }
          T.y += stab * (110 * yawErr - 28 * this.angVel.y);
          T.addScaledVector(fwd, stab * (-95 * phi - 22 * phiDot));
          void Yx; void Yy; void Yz;
        }
        // pitch assist: the rider keeps the bike roughly parallel to its flight path
        if (assist > 0 && Math.abs(this.leanIn) < 0.15) {
          const hv = Math.hypot(vel.x, vel.z);
          const pathAngle = Math.atan2(vel.y, Math.max(hv, 1));
          const pTarget = pathAngle * 0.85;
          const pitchNow = this.pitchAngle;
          const kp = assist === 2 ? 260 : 110;
          const kdp = assist === 2 ? 70 : 35;
          T.addScaledVector(right, clamp(kp * (pTarget - pitchNow) - kdp * this.angVel.dot(right), -240, 240));
        }
        T.addScaledVector(this.angVel, -2.5);
      }
    } else {
      // crashed: lots of angular damping when touching the ground
      const damp = groundedCount > 0 ? 18 : 1.5;
      T.addScaledVector(this.angVel, -damp);
    }

    // ---- integrate
    const invM = 1 / this.mass;
    const ax = F.x * invM, ay = F.y * invM, az = F.z * invM;
    vel.x += ax * dt; vel.y += ay * dt; vel.z += az * dt;
    // impact detection (non-gravity acceleration)
    const aNonGrav = Math.hypot(ax, ay + G, az);
    this.pos.addScaledVector(vel, dt);

    // angular: alpha = R * I^-1 * R^T * T
    const m = this.m;
    const tbx = m[0] * T.x + m[3] * T.y + m[6] * T.z;
    const tby = m[1] * T.x + m[4] * T.y + m[7] * T.z;
    const tbz = m[2] * T.x + m[5] * T.y + m[8] * T.z;
    const abx = tbx / this.inertia.x, aby = tby / this.inertia.y, abz = tbz / this.inertia.z;
    const w = this.angVel;
    w.x += (m[0] * abx + m[1] * aby + m[2] * abz) * dt;
    w.y += (m[3] * abx + m[4] * aby + m[5] * abz) * dt;
    w.z += (m[6] * abx + m[7] * aby + m[8] * abz) * dt;
    const wl2 = w.lengthSq();
    if (wl2 > 900) w.multiplyScalar(30 / Math.sqrt(wl2));
    const q = this.quat;
    const ox = w.x * dt * 0.5, oy = w.y * dt * 0.5, oz = w.z * dt * 0.5;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    q.x = qx + (ox * qw + oy * qz - oz * qy);
    q.y = qy + (oy * qw + oz * qx - ox * qz);
    q.z = qz + (oz * qw + ox * qy - oy * qx);
    q.w = qw + (-ox * qx - oy * qy - oz * qz);
    q.normalize();

    // ---- world collisions
    if (this.colliders) this._collide(dt);

    // ---- bounds
    const T0 = this.terrain;
    if (T0.half && T0.half < 1e5) {
      const lim = T0.half - 6;
      if (Math.abs(this.pos.x) > lim) { this.pos.x = Math.sign(this.pos.x) * lim; vel.x *= -0.2; }
      if (Math.abs(this.pos.z) > lim) { this.pos.z = Math.sign(this.pos.z) * lim; vel.z *= -0.2; }
    }

    // ---- state bookkeeping
    this._basis();
    if (this.rear.contact) {
      this.wheelieAngle = Math.asin(clamp(this.fwd.dot(this.rear.normal), -1, 1));
    } else {
      this.wheelieAngle = 0;
    }
    if (this.airborne) {
      this.airTime += dt;
      this.groundTime = 0;
      const gh = this.terrain.height(this.pos.x, this.pos.z);
      this.maxAirHeight = Math.max(this.maxAirHeight, this.pos.y - gh - 0.8);
    } else {
      if (wasAir) {
        this._onLanding(aNonGrav);
      }
      this.groundTime += dt;
      if (this.groundTime > 0.12) {
        this.airTime = 0;
        this.maxAirHeight = 0;
      }
    }
    this.wasAirborne = wasAir;

    if (!crashed) this._crashChecks(dt, aNonGrav, bottomHit);
    else {
      this.crashTimer += dt;
      this.ragdoll.step(dt, this.terrain, this.colliders);
    }
  }

  // --- wheel contact and forces -------------------------------------------------
  _wheel(w, dt, F, T, driveTorque, driveInertia) {
    const terrain = this.terrain;
    const right = this.right, up = this.up, fwd = this.fwd;
    // hub at full extension (world)
    _v1.set(w.hubExt.x - this.com.x, w.hubExt.y - this.com.y + this.chassisShift, w.hubExt.z - this.com.z);
    this.toWorldDir(_v1, _hub).add(this.pos);
    const axis = this.toWorldDir(w.axis, _v2);
    const R = w.radius, rt = w.tube, Rc = R - rt;
    const hx = _hub.x, hy = _hub.y, hz = _hub.z;

    // quick reject when far above the ground
    const gh = terrain.height(hx, hz);
    if (hy - gh > R + 0.6) {
      this._noContact(w, dt, driveTorque, driveInertia);
      return false;
    }

    // tangent plane method (2 refinements)
    const n = terrain.normal(hx, hz, _n);
    let cx = hx, cy = hy, cz = hz, gy = gh;
    for (let it = 0; it < 2; it++) {
      const nr = n.x * right.x + n.y * right.y + n.z * right.z;
      let dx = -(n.x - nr * right.x), dy = -(n.y - nr * right.y), dz = -(n.z - nr * right.z);
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl; dy /= dl; dz /= dl;
      cx = hx + dx * Rc - n.x * rt;
      cy = hy + dy * Rc - n.y * rt;
      cz = hz + dz * Rc - n.z * rt;
      gy = terrain.height(cx, cz);
      terrain.normal(cx, cz, n);
    }
    let pen = (gy - cy) * n.y;
    let px = cx + n.x * pen, py = cy + n.y * pen, pz = cz + n.z * pen;
    let nx = n.x, ny = n.y, nz = n.z;

    // edge sampling along the wheel for lips, steps and sharp crests
    let ffx = fwd.x, ffz = fwd.z;
    const ffl = Math.hypot(ffx, ffz);
    if (ffl > 0.2) {
      ffx /= ffl; ffz /= ffl;
      for (let k = -2; k <= 2; k++) {
        if (k === 0) continue;
        const off = k * 0.44 * R;
        // sample along the ground trace of the wheel's lowest point
        const sx = cx + ffx * off, sz = cz + ffz * off;
        const sy = terrain.height(sx, sz);
        let vx = sx - hx, vy = sy - hy, vz = sz - hz;
        const vr = vx * right.x + vy * right.y + vz * right.z;
        if (vr > rt * 1.6 || vr < -rt * 1.6) continue; // not under the tire
        vx -= vr * right.x; vy -= vr * right.y; vz -= vr * right.z;
        if (vx * up.x + vy * up.y + vz * up.z > -0.05) continue;
        const dist = Math.hypot(vx, vy, vz);
        const p = R - dist;
        if (p > pen + 0.004) {
          pen = p;
          nx = -vx / dist; ny = -vy / dist; nz = -vz / dist;
          px = sx; py = sy; pz = sz;
        }
      }
    }

    if (pen <= 0) {
      this._noContact(w, dt, driveTorque, driveInertia);
      return false;
    }

    // ---- suspension
    const wasContact = w.contact;
    w.contact = true;
    w.airTime = 0;
    w.normal.set(nx, ny, nz);
    w.point.set(px, py, pz);
    w.surface = terrain.surface(px, pz);
    const an = axis.x * nx + axis.y * ny + axis.z * nz;
    const anc = Math.max(an, 0.3);
    const x = pen / anc;
    _r.subVectors(_hub, this.pos);
    // chassis velocity at hub
    const av = this.angVel;
    const sv = this.chassisShiftVel;
    const vhx = this.vel.x + av.y * _r.z - av.z * _r.y + up.x * sv;
    const vhy = this.vel.y + av.z * _r.x - av.x * _r.z + up.y * sv;
    const vhz = this.vel.z + av.x * _r.y - av.y * _r.x + up.z * sv;
    const vn = vhx * nx + vhy * ny + vhz * nz;
    // tire compliance: the carcass soaks up the sharpest velocity spikes
    const xdRaw = -vn / anc;
    if (!wasContact) w.xdF = xdRaw;
    w.xdF += (xdRaw - w.xdF) * (1 - Math.exp(-dt / 0.012));
    const xd = w.xdF;
    const travel = w.travel;
    const xr = Math.min(x, travel) / travel;
    let Fs = w.k * Math.min(x, travel) * (1 + w.prog * xr * xr);
    const ramp = Math.min(1, x / 0.025);
    // digressive high-speed damping (valve blow-off); rebound blows off earlier so the
    // wheel can drop into holes and braking bumps instead of skipping over them
    const axd = Math.abs(xd);
    let xdEff;
    if (xd >= 0) xdEff = axd < 0.8 ? xd : 0.8 + (axd - 0.8) * 0.35;
    else xdEff = -(axd < 0.35 ? axd : 0.35 + (axd - 0.35) * 0.25);
    Fs += (xd > 0 ? w.cComp : w.cReb) * xdEff * ramp;
    w.bottomed = false;
    if (x > travel) {
      // hydraulic bottoming cone: stiff, and damped in both directions so it doesn't kick back
      const e = x - travel;
      Fs += 1.8e5 * e + 4500 * xd;
      w.bottomed = true;
    }
    const N = Math.max(0, Fs);
    w.load = N;
    w.compression = Math.min(x, travel);
    w.visComp = w.compression;
    w.hub.copy(_hub).addScaledVector(axis, w.compression);

    // ---- tire frame
    let fwx = fwd.x, fwy = fwd.y, fwz = fwd.z;
    if (w.isFront) {
      const c = Math.cos(this.steerAngle), s = Math.sin(this.steerAngle);
      fwx = fwd.x * c + right.x * s;
      fwy = fwd.y * c + right.y * s;
      fwz = fwd.z * c + right.z * s;
    }
    const fn = fwx * nx + fwy * ny + fwz * nz;
    _tl.set(fwx - fn * nx, fwy - fn * ny, fwz - fn * nz);
    let tll = _tl.length();
    if (tll < 1e-4) {
      _tl.copy(fwd);
      tll = 1;
    }
    _tl.multiplyScalar(1 / tll);
    // lateral = tl x n  (points to the right)
    _tt.set(_tl.y * nz - _tl.z * ny, _tl.z * nx - _tl.x * nz, _tl.x * ny - _tl.y * nx);

    // contact point velocity without the roll-rate component
    _r.set(px - this.pos.x, py - this.pos.y, pz - this.pos.z);
    const wr = av.dot(fwd);
    _wEff.copy(av).addScaledVector(fwd, -wr);
    _vc.set(
      this.vel.x + _wEff.y * _r.z - _wEff.z * _r.y,
      this.vel.y + _wEff.z * _r.x - _wEff.x * _r.z,
      this.vel.z + _wEff.x * _r.y - _wEff.y * _r.x
    );
    const vLong = _vc.dot(_tl);
    const vLat = _vc.dot(_tt);

    const surf = SURFACES[w.surface];
    // tire relaxation: grip follows the load over ~0.35 m of rolling, not instantly
    const tau = 0.35 / Math.max(Math.abs(vLong), 3);
    w.loadF += (N - w.loadF) * (1 - Math.exp(-dt / tau));
    const Ng = Math.min(w.loadF, N * 2.5 + 200);
    const loadFactor = 1 - 0.07 * (Ng / 1000 - 1);
    const mu = surf.mu * clamp(loadFactor, 0.75, 1.1);
    const Fmax = mu * Ng;
    const denom = Math.max(Math.abs(vLong), V_SLIP_MIN);
    const aN = vLat / denom / (TAN_ALPHA_PEAK * (1 + surf.loose));

    // ---- wheel spin (implicit)
    const Reff = R;
    const brakeMax = w.isFront ? 540 * this.tune.brakeFront : 330 * this.tune.brakeRear;
    const brake = (w.isFront ? this.brakeF : this.brakeR) * brakeMax;
    const Ieff = w.inertia + driveInertia;
    const slipFx = (om) => {
      const kN = (om * Reff - vLong) / denom / KAPPA_PEAK;
      const s = Math.hypot(kN, aN);
      if (s < 1e-6) return 0;
      return ((Fmax * tireShape(s)) / s) * kN;
    };
    const kw = (Fmax * SHAPE_SLOPE0 * Reff) / (KAPPA_PEAK * denom);
    const fx0 = slipFx(w.omega);
    const denomI = Ieff + dt * Reff * kw;
    const omPrev = w.omega;
    let wFree = w.omega + (dt * (driveTorque - fx0 * Reff)) / denomI;
    const dwB = (dt * brake) / denomI;
    if (Math.abs(wFree) <= dwB) wFree = 0;
    else wFree -= Math.sign(wFree) * dwB;
    w.omega = wFree;
    if (!w.isFront && this.airborne === false) {
      // nothing extra: gyroscopic reaction only matters in the air
    }
    void omPrev;

    // ---- final tire forces with new wheel speed
    const kN = (w.omega * Reff - vLong) / denom / KAPPA_PEAK;
    const s = Math.hypot(kN, aN);
    let fx = 0, fy = 0;
    if (s > 1e-6) {
      const f = (Fmax * tireShape(s)) / s;
      fx = f * kN;
      fy = -f * aN;
    }
    w.slip = s;
    w.slipRatio = (w.omega * Reff - vLong) / denom;
    w.slipAngle = Math.atan2(vLat, Math.max(Math.abs(vLong), 0.5));
    w.slideSpeed = Math.hypot(w.omega * Reff - vLong, vLat);
    // rolling resistance
    const rr = -surf.rr * N * clamp(vLong / 0.6, -1, 1);
    fx += rr;
    w.fx = fx;
    w.fy = fy;
    w.angle += w.omega * dt;

    const Fx = nx * N + _tl.x * fx + _tt.x * fy;
    const Fy = ny * N + _tl.y * fx + _tt.y * fy;
    const Fz = nz * N + _tl.z * fx + _tt.z * fy;
    F.x += Fx; F.y += Fy; F.z += Fz;
    T.x += _r.y * Fz - _r.z * Fy;
    T.y += _r.z * Fx - _r.x * Fz;
    T.z += _r.x * Fy - _r.y * Fx;
    return true;
  }

  _noContact(w, dt, driveTorque, driveInertia) {
    w.contact = false;
    w.load = 0;
    w.loadF *= Math.exp(-dt / 0.03);
    w.slip = 0;
    w.slideSpeed = 0;
    w.slipRatio = 0;
    w.airTime += dt;
    w.bottomed = false;
    // suspension extends (rebound limited)
    w.compression = Math.max(0, w.compression - dt * 2.2);
    w.visComp = w.compression;
    // free wheel spin: rear driven by engine, both braked
    const Ieff = w.inertia + driveInertia;
    const prev = w.omega;
    let om = w.omega + (dt * (driveTorque - Math.sign(w.omega) * 0.8)) / Ieff;
    const brakeMax = w.isFront ? 540 * this.tune.brakeFront : 330 * this.tune.brakeRear;
    const brake = (w.isFront ? this.brakeF : this.brakeR) * brakeMax;
    const dwB = (dt * brake) / Ieff;
    if (Math.abs(om) <= dwB) om = 0;
    else om -= Math.sign(om) * dwB;
    w.omega = om;
    w.angle += om * dt;
    // gyroscopic reaction on the chassis (throttle = nose up, brake = nose down)
    if (!this.crashed) {
      const gyroI = w.isFront ? w.inertia : w.inertia + (driveInertia > 0 ? this.engine.inertia * this.engine.ratio : 0);
      const tq = (gyroI * (om - prev)) / dt;
      _torque.addScaledVector(this.right, tq * 1.6);
    }
    w.hub.set(w.hubExt.x - this.com.x, w.hubExt.y - this.com.y + this.chassisShift, w.hubExt.z - this.com.z);
    this.toWorldDir(w.hub, _v3);
    w.hub.copy(_v3).add(this.pos);
    this.toWorldDir(w.axis, _v3);
    w.hub.addScaledVector(_v3, w.compression);
  }

  // --- body contacts ------------------------------------------------------------
  _hardPoints(dt, F, T, crashed) {
    const terrain = this.terrain;
    for (const hp of HARD_POINTS) {
      if (!crashed && hp.crash) continue;
      let p = hp.v;
      if (hp.name === 'head') {
        if (crashed) continue;
        p = this.headBikeSpace(_v3);
      }
      const wp = this.bikeToWorld(p, _v1);
      const gh = terrain.height(wp.x, wp.z);
      const pen = gh - wp.y;
      if (pen <= 0) continue;
      const n = terrain.normal(wp.x, wp.z, _nTmp);
      const penN = pen * n.y;
      _r.subVectors(wp, this.pos);
      const av = this.angVel;
      const vx = this.vel.x + av.y * _r.z - av.z * _r.y;
      const vy = this.vel.y + av.z * _r.x - av.x * _r.z;
      const vz = this.vel.z + av.x * _r.y - av.y * _r.x;
      const vn = vx * n.x + vy * n.y + vz * n.z;
      const Fn = Math.max(0, 9e4 * penN - 5000 * vn);
      let tx = vx - vn * n.x, ty = vy - vn * n.y, tz = vz - vn * n.z;
      const ts = Math.hypot(tx, ty, tz);
      const mu = crashed ? hp.mu * 1.3 : hp.mu;
      let Ft = mu * Fn;
      if (ts < 0.3) Ft *= ts / 0.3;
      if (ts > 1e-5) { tx /= ts; ty /= ts; tz /= ts; } else { tx = ty = tz = 0; }
      const fx = n.x * Fn - tx * Ft, fy = n.y * Fn - ty * Ft, fz = n.z * Fn - tz * Ft;
      F.x += fx; F.y += fy; F.z += fz;
      T.x += _r.y * fz - _r.z * fy;
      T.y += _r.z * fx - _r.x * fz;
      T.z += _r.x * fy - _r.y * fx;
      if (!crashed && hp.name === 'bash' && Fn > 2500) this.events.push({ type: 'scrape', amount: Fn });
    }
  }

  // --- static object collisions ---------------------------------------------------
  _collide(dt) {
    const probes = [
      [0, 0.62, 0.75, 0.42],
      [0, 0.62, -0.7, 0.42],
      [0, 1.15, -0.05, 0.38],
    ];
    const hit = {};
    for (const pr of probes) {
      if (this.crashed && pr[1] > 1) continue;
      const wp = this.bikeToWorld(_v3.set(pr[0], pr[1], pr[2]), _v1);
      const h = this.colliders.sphereHit(wp.x, wp.y, wp.z, pr[3], hit);
      if (!h) continue;
      if (!h.item.hard) continue;
      const vn = this.vel.x * h.nx + this.vel.z * h.nz;
      this.pos.x += h.nx * h.depth;
      this.pos.z += h.nz * h.depth;
      if (vn < 0) {
        const impact = -vn;
        this.vel.x -= 1.25 * vn * h.nx;
        this.vel.z -= 1.25 * vn * h.nz;
        // yaw kick away from the obstacle
        this.angVel.y += (h.nx * this.fwd.z - h.nz * this.fwd.x) * impact * 0.25;
        if (!this.crashed && impact > 5.5) {
          this.crash(`Hit ${h.item.tag}`);
        } else if (impact > 1.5) {
          this.events.push({ type: 'bump', amount: impact });
        }
      }
    }
  }

  // --- landing / crash logic --------------------------------------------------------
  _onLanding(aNonGrav) {
    const air = this.airTime;
    this.lastAirTime = air;
    if (air < 0.25) return;
    const w = this.front.contact && !this.rear.contact ? this.front : this.rear.contact ? this.rear : this.front;
    const n = w.normal;
    const vn = this.vel.dot(n);
    const impact = Math.max(0, -vn);
    this.events.push({ type: 'land', impact, air, frontFirst: w.isFront && !this.rear.contact });
    if (this.crashed) return;
    const rollRel = Math.asin(clamp(this.right.dot(n), -1, 1));
    const pitchRel = Math.asin(clamp(this.fwd.dot(n), -1, 1));
    // heading vs direction of travel along the ground
    _v1.copy(this.vel).addScaledVector(n, -vn);
    const vt = _v1.length();
    let yawSlip = 0;
    if (vt > 1) {
      _v2.copy(this.fwd).addScaledVector(n, -this.fwd.dot(n)).normalize();
      yawSlip = Math.acos(clamp(_v2.dot(_v1) / vt, -1, 1));
    }
    const tol = this.tune.assist === 2 ? 1.15 : this.tune.assist === 1 ? 1.0 : 0.85;
    if (Math.abs(rollRel) > 0.62 * tol) return this.crash('Landed leaned over');
    if (yawSlip > 0.75 * tol && vt > 6) return this.crash('Landed sideways');
    // landing on a face that points back against the direction of travel = casing
    const hvl = Math.hypot(this.vel.x, this.vel.z) || 1;
    const facing = (n.x * this.vel.x + n.z * this.vel.z) / hvl;
    if (facing < -0.3 && impact > 9 * tol) return this.crash('Cased the landing');
    if (pitchRel < -0.6 * tol && w.isFront && impact > 3.5) return this.crash('Nose-dived the landing');
    if (impact > 13.5 * tol) return this.crash('Landed too hard');
    void aNonGrav;
  }

  _crashChecks(dt, aNonGrav, bottomHit) {
    // body parts touching the ground
    for (const hp of HARD_POINTS) {
      if (!hp.crash) continue;
      const p = hp.name === 'head' ? this.headBikeSpace(_v3) : hp.v;
      const wp = this.bikeToWorld(p, _v1);
      const gh = this.terrain.height(wp.x, wp.z);
      if (gh - wp.y > 0.015) {
        const reasons = {
          head: 'Went over the bars', barL: 'Lowsided', barR: 'Lowsided', fenderF: 'Endo',
          fenderR: 'Looped out', seat: 'Looped out', shroudL: 'Lowsided', shroudR: 'Lowsided', pipe: 'Lowsided',
        };
        return this.crash(reasons[hp.name] || 'Crashed');
      }
    }
    const grounded = !this.airborne;
    if (grounded && Math.abs(this.leanAngle) > 1.3) return this.crash('Fell over');
    if (grounded && this.pitchAngle > 1.2) return this.crash('Looped out');
    if (grounded && this.pitchAngle < -1.2) return this.crash('Endo');
    // front tuck: front tire washing out while leaned
    if (this.front.contact && this.front.slip > 2.4 && Math.abs(this.leanAngle) > 0.38 && this.speed > 4) {
      this.frontTuck += dt;
      if (this.frontTuck > 0.3) return this.crash('Front end tucked');
    } else {
      this.frontTuck = Math.max(0, this.frontTuck - dt);
    }
    // violent impacts (casing a jump face, flat landings)
    if (aNonGrav > 150 && bottomHit > 0) {
      this.impactTimer += dt;
      if (this.impactTimer > 0.03) return this.crash('Cased it');
    } else {
      this.impactTimer = 0;
    }
  }

  crash(reason) {
    if (this.crashed) return;
    this.crashed = true;
    this.crashReason = reason;
    this.crashTimer = 0;
    // detach rider
    const riderPos = this.bikeToWorld(this.riderBikeSpace(_v3), _v1).clone();
    const rv = this.vel.clone();
    // rider keeps momentum and gets a small pop upward/forward
    rv.addScaledVector(this.up, 1.2).addScaledVector(this.fwd, 0.5);
    const spin = this.angVel.clone().multiplyScalar(0.8);
    spin.addScaledVector(this.right, Math.min(6, this.speed * 0.25));
    this.ragdoll.start(riderPos, rv, this.quat, spin);
    // bike alone: lighter, smaller inertia
    this.mass = GEO.massBike;
    this.inertia.set(24, 22, 9);
    const before = this.com.clone();
    this.com.set(GEO.comBike[0], GEO.comBike[1], GEO.comBike[2]);
    _v1.subVectors(this.com, before);
    this.toWorldDir(_v1, _v2);
    this.pos.add(_v2);
    this.events.push({ type: 'crash', reason, speed: this.speed });
  }

  /** Visual helpers ------------------------------------------------------------- */
  interpolated(alpha, outPos, outQuat) {
    outPos.lerpVectors(this.prevPos, this.pos, alpha);
    outQuat.slerpQuaternions(this.prevQuat, this.quat, alpha);
  }

  get rpm() {
    return this.engine.rpm;
  }
}

// Whip / air-control physics.
//
// Nothing here is an animation: the rider's input becomes *effort* that builds up over a
// fraction of a second, effort becomes torque on the bike's rigid body, and the body's
// angular momentum does the rest. On top of the rider's torques the system models
//  - gyroscopic coupling of the spinning wheels (yawing the bike rolls it and vice versa:
//    the faster the wheels spin, the stronger and the more "weighty" this feels),
//  - aerodynamics: a weathervane torque that turns a sideways bike back into the wind,
//    extra drag and a little side force while the bike is sideways,
//  - air + body damping per axis and soft limits the rider can't hold the bike beyond,
//  - the rider straightening the bike when the input is released, with a capped torque so
//    a fast whip takes time to stop (momentum), working harder just before touchdown,
//  - a whip set up on the jump face (the tyres still push), so it can leave the lip already
//    rotating,
//  - the bars turned back toward the direction of travel (the front wheel stays pointed
//    where the bike is going while the rear swings out),
//  - the rider's upper body as a separate spring-damper that counterbalances the bike.
// Every tuning value lives in WHIP.
import { Vector3 } from 'three';
import { clamp, smoothstep } from './util.js';

const DEG = Math.PI / 180;

export const WHIP = {
  // --- rider effort: inputs create effort that builds up / relaxes (no instant response)
  effortRise: 7, // 1/s  getting into a move
  effortFall: 8, // 1/s  relaxing (input released) or switching direction
  inputDeadzone: 0.06, // on top of the controller deadzone, against stick noise
  airControl: 0.85, // overall authority in the air (scaled by the Air control setting)
  // --- torques at full effort (N·m); the chassis inertia is pitch 52, yaw 46, roll 26 kg·m²
  whipYawTorque: 215, // hips and legs throw the rear out
  whipRollTorque: 205, // laying the bike over into the whip (works against the wheels' gyro)
  bodyRollTorque: 110, // rider lean left / right (right stick, arrow keys) rolls the bike
  pitchTorque: 270, // body English forward / back (left stick up / down, arrow keys)
  flipRateFade: 7, // rad/s: around this flip rotation speed the rider can't push it any faster
  throttlePitch: 0.45, // W / S in the air: throttle lifts the nose, rear brake drops it
  pedalThreshold: 0.35, // only a deliberate throttle / brake press counts (holding a little is normal)
  faceWhip: 0.4, // share of the whip effort that already acts on the jump face
  faceSteer: 0.3, // on a jump face steering turns the bike this much (the rest sets up the whip)
  // --- natural behaviour
  gyroScale: 1.0, // wheel gyroscopic coupling, 1 = physical
  weathervane: 0.1, // aerodynamic yaw torque: N·m per (m/s)² at 90° sideways
  sideDrag: 0.9, // extra drag when fully sideways (fraction of the normal drag)
  sideLift: 0.35, // side force of a sideways bike: N per (m/s)² at 45°
  damping: { pitch: 2.2, yaw: 3.0, roll: 2.4 }, // N·m per rad/s (air + rider's body)
  // --- soft limits the rider can't hold the bike beyond
  maxWhipAngle: 75, // deg, whip (heading vs direction of travel)
  maxLayAngle: 72, // deg, roll
  limitStart: 0.85, // limits start pushing back at this fraction
  limitStiffness: 700, // N·m per rad past the start
  limitDamping: 90, // N·m per rad/s while still rotating outward past the start
  limitMaxTorque: 380, // N·m: the push-back never becomes a kick
  reachStart: 0.55, // the rider's push fades from this fraction of a limit to the limit
  // --- recovery when the rider lets go (assists off / low / full)
  recoveryStrength: [0.4, 1.0, 1.6], // straightening the bike back up (the assist level)
  recoveryDamping: [1.3, 1.45, 1.6], // the rider's body resisting the rotation after letting go
  recoveryYaw: { k: 150, d: 70 },
  recoveryRoll: { k: 190, d: 60 },
  recoveryMaxTorque: 230, // N·m (x strength): big rotations take time to stop
  landingBoost: 1.9, // the rider straightens harder in the last moments before touchdown
  landingWindow: 0.7, // s
  // --- rider counterbalance: the rider's upper body vs the bike
  riderCounterbalance: 0.65,
  riderTwistMax: 38, // deg
  riderLeanMax: 28, // deg
  riderSpring: 70, // 1/s²
  riderDamping: 13, // 1/s
  riderInertia: 2.5, // kg·m²: reaction on the bike when the rider's body swings
  // --- front wheel: bars turned back toward the direction of travel during a whip
  frontStability: 0.55,
  maxAirSteer: 0.5, // rad
  steerResponse: 0.08, // s
  barsLandingTime: 0.35, // s before touchdown when the rider lines the bars up to land
  // --- landing: a bike still rotating keeps rotating after touchdown
  landingLookahead: 0.15, // s of whip / roll momentum counted at touchdown
};

const _L = new Vector3(), _g = new Vector3(), _h = new Vector3();
const approach = (v, target, rate, dt) => v + clamp(target - v, -rate * dt, rate * dt);
/** Input with a small extra deadzone, rescaled to the full range. */
const deadzone = (v, dz) => (Math.abs(v) < dz ? 0 : (v - Math.sign(v) * dz) / (1 - dz));
/** 0..1 how much of a pedal press counts as deliberate. */
const deliberate = (v, threshold) => clamp((v - threshold) / (1 - threshold), 0, 1);
/** Effort follows its target: builds up at `rise`, relaxes / reverses at `fall`. */
const effortStep = (e, target, c, dt) => {
  const building = Math.abs(target) > Math.abs(e) && (e === 0 || target * e > 0);
  return approach(e, target, building ? c.effortRise : c.effortFall, dt);
};

export class WhipController {
  constructor(cfg = WHIP) {
    this.cfg = cfg;
    this.reset();
  }

  reset() {
    this.whipEffort = 0;
    this.pitchEffort = 0;
    this.sideEffort = 0;
    this.whipAngle = 0; // rad, heading vs horizontal direction of travel (+ = nose right)
    this.whipRate = 0; // rad/s
    this.rollRate = 0;
    this.riderTwist = 0; // rad, rider's upper body yaw relative to the bike
    this.riderTwistV = 0;
    this.riderLean = 0; // rad, rider's upper body roll relative to the bike
    this.riderLeanV = 0;
    this.torque = { yaw: 0, roll: 0, pitch: 0, gyro: 0, aero: 0, recYaw: 0, recRoll: 0 }; // last step, N·m (debug)
    this.recovery = 0;
    this.landIn = -1; // s until the predicted touchdown (-1 = none / on the ground)
    if (!this.landPoint) this.landPoint = new Vector3();
    this.gyroL = 0;
    this.airSteer = 0;
    this.onFace = false;
  }

  /**
   * The bike's heading on the level, taken from its sideways (axle) axis: the horizontal
   * direction square to it. Pitching the bike - a jump face, a nose-dive, a whole front or
   * back flip - turns the bike about that axis and leaves this heading alone, where the
   * nose's own direction would swing through 180 degrees once the bike passes vertical.
   * Writes into out (unit, y = 0); falls back to the nose when the bike lies on its side.
   */
  static heading(ph, out) {
    const r = ph.right, f = ph.fwd;
    let hx = r.z, hz = -r.x; // world up x right
    const l = Math.hypot(hx, hz);
    // laid far over (a big whip) but not pitched: the nose itself is the better reference
    // (the right way round when upside down)
    const lf = Math.hypot(f.x, f.z);
    const w = l < 0.15 ? 1 : smoothstep(0.35, 0.7, Math.abs(r.y)) * (1 - smoothstep(0.5, 0.8, Math.abs(f.y)));
    if (l > 1e-6) { hx /= l; hz /= l; }
    if (w > 0 && lf > 1e-6) {
      const sgn = ph.up.y < 0 ? -1 : 1;
      hx += ((sgn * f.x) / lf - hx) * w;
      hz += ((sgn * f.z) / lf - hz) * w;
    }
    const n = Math.hypot(hx, hz) || 1;
    return out.set(hx / n, 0, hz / n);
  }

  /**
   * Whip angle: the bike's level heading vs its horizontal direction of travel
   * (rad, + = nose right). Not affected by pitch, so flips do not read as whips.
   */
  static angle(ph, h = WhipController.heading(ph, _h)) {
    const vel = ph.vel;
    const hv = Math.hypot(vel.x, vel.z);
    if (hv < 1) return 0;
    const vx = vel.x / hv, vz = vel.z / hv;
    // rotating the bike about +Y by this angle lines it up with the velocity
    return Math.atan2(h.z * vx - h.x * vz, h.x * vx + h.z * vz);
  }

  /**
   * Riding up the last part of a jump face: steep, fast, and the ground ahead falls away
   * from the face's slope (a lip) within a few metres. Long climbs don't count.
   */
  static onTakeoff(ph) {
    if (!(ph.pitchAngle > 0.17 && ph.speed > 7 && ph.front.contact)) return false;
    const hv = Math.hypot(ph.vel.x, ph.vel.z);
    if (hv < 1) return false;
    const dx = ph.vel.x / hv, dz = ph.vel.z / hv;
    const T = ph.terrain, p = ph.front.point;
    const h0 = T.height(p.x, p.z), slope = Math.tan(ph.pitchAngle);
    for (let d = 3; d <= 12; d += 3) {
      if (T.height(p.x + dx * d, p.z + dz * d) < h0 + slope * d - 0.6) return true;
    }
    return false;
  }

  /**
   * Rider effort from the inputs (called every step, ground or air).
   * input: { steer, lean, side, throttle, brakeR } after assists / tuning.
   */
  updateEffort(dt, input, airborne) {
    const c = this.cfg, dz = c.inputDeadzone;
    // W / S (throttle / rear brake) add to the body-English pitch input in the air
    const pedals = airborne ? c.throttlePitch * (deliberate(input.throttle, c.pedalThreshold) - deliberate(input.brakeR, c.pedalThreshold)) : 0;
    const pitch = clamp(deadzone(input.lean, dz) - pedals, -1, 1);
    this.whipEffort = effortStep(this.whipEffort, deadzone(input.steer, dz), c, dt);
    this.pitchEffort = effortStep(this.pitchEffort, pitch, c, dt);
    this.sideEffort = effortStep(this.sideEffort, deadzone(input.side, dz), c, dt);
  }

  /**
   * Air control torques. ph = BikePhysics (basis, angVel, wheels, vel); T = world torque
   * accumulator; F = world force accumulator. assist 0/1/2, authority = Air control setting.
   */
  air(ph, dt, T, F, assist, authority) {
    const c = this.cfg;
    const fwd = ph.fwd, up = ph.up, right = ph.right, w = ph.angVel, vel = ph.vel;
    const A = c.airControl * authority;
    // roll is measured and applied about the level heading: the same as about the nose for
    // a bike flying straight, and still the right way round upside down in a flip
    const h = WhipController.heading(ph, _h);
    const psi = WhipController.angle(ph, h);
    const phi = ph.leanAngle;
    this.whipAngle = psi;
    this.whipRate = -w.y;
    this.rollRate = w.dot(h);
    let tYaw = 0, tRoll = 0, tPitch = 0; // about world Y, the level heading, bike right

    // 1) rider effort -> torque. Near the limits the rider's body runs out of reach, so
    //    pushing further gets weaker (pulling back stays at full strength)
    const maxW = c.maxWhipAngle * DEG, maxL = c.maxLayAngle * DEG;
    const reachW = this.whipEffort * psi > 0 ? 1 - smoothstep(c.reachStart * maxW, maxW * 1.05, Math.abs(psi)) : 1;
    const rollE = this.whipEffort * c.whipRollTorque + this.sideEffort * c.bodyRollTorque;
    const reachL = rollE * phi > 0 ? 1 - smoothstep(c.reachStart * maxL, maxL * 1.05, Math.abs(phi)) : 1;
    tYaw += -this.whipEffort * c.whipYawTorque * A * reachW;
    // the rider lays the bike over about its own nose (on a nose-up bike this also turns it
    // a little); everything that rights the bike acts about the level heading (below)
    const tLay = rollE * A * reachL;
    // body English: full strength until the bike already flips fast the same way
    const push = -this.pitchEffort * c.pitchTorque * A;
    const wp = w.dot(right);
    tPitch += push * (push * wp > 0 ? 1 - smoothstep(c.flipRateFade * 0.75, c.flipRateFade * 1.25, Math.abs(wp)) : 1);

    // 2) soft limits: the rider can't hold the bike past them (spring + damper, capped, so
    //    a fast whip is caught over a few degrees instead of bouncing off a wall)
    const wl = maxW * c.limitStart, ll = maxL * c.limitStart;
    if (Math.abs(psi) > wl) {
      const out = Math.max(0, Math.sign(psi) * -w.y);
      tYaw += Math.sign(psi) * Math.min(c.limitMaxTorque, c.limitStiffness * (Math.abs(psi) - wl) + c.limitDamping * out);
    }
    if (Math.abs(phi) > ll) {
      const out = Math.max(0, Math.sign(phi) * this.rollRate);
      tRoll += -Math.sign(phi) * Math.min(c.limitMaxTorque, c.limitStiffness * (Math.abs(phi) - ll) + c.limitDamping * out);
    }

    // 3) recovery: the rider straightens the bike after the whip input ends; capped torque, so
    //    a fast rotation takes time to stop, and harder just before the landing
    const land = ph._predictLanding(this.landPoint);
    this.landIn = land;
    const boost = land > 0 ? 1 + (c.landingBoost - 1) * smoothstep(c.landingWindow, 0.15, land) : 1;
    const s = c.recoveryStrength[assist] * boost, sd = c.recoveryDamping[assist] * boost;
    const yawFree = 1 - Math.min(1, Math.abs(this.whipEffort) * 1.4);
    const rollFree = yawFree * (1 - 0.85 * Math.min(1, Math.abs(this.sideEffort)));
    const cap = c.recoveryMaxTorque * Math.max(s, sd);
    const recYaw = clamp(s * c.recoveryYaw.k * psi - sd * c.recoveryYaw.d * w.y, -cap, cap) * yawFree;
    const recRoll = clamp(-s * c.recoveryRoll.k * phi - sd * c.recoveryRoll.d * this.rollRate, -cap, cap) * rollFree;
    tYaw += recYaw;
    tRoll += recRoll;
    this.recovery = s * yawFree;
    this.torque.recYaw = recYaw;
    this.torque.recRoll = recRoll;

    // 4) aerodynamics: weathervane yaw torque, extra drag and side force when sideways
    const v2 = vel.x * vel.x + vel.z * vel.z;
    const sinPsi = Math.sin(psi);
    const aero = c.weathervane * v2 * sinPsi;
    tYaw += aero;
    const hv = Math.sqrt(v2);
    if (hv > 1) {
      const sp = vel.length();
      const sideways = Math.abs(sinPsi);
      F.addScaledVector(vel, -0.5 * 1.2 * 0.55 * sp * c.sideDrag * sideways);
      // a sideways bike acts like a plate: pushed toward the side its nose points
      const lift = c.sideLift * v2 * Math.sin(2 * psi);
      F.x += (-vel.z / hv) * lift;
      F.z += (vel.x / hv) * lift;
    }
    this.torque.aero = aero;

    // 5) gyroscopic coupling of the spinning wheels: tau = -omega x L, L along the axles
    const front = ph.front, rear = ph.rear;
    const crank = ph.drive.inertia > 0 ? ph.engine.inertia * ph.engine.ratio : 0; // clutch engaged
    const Lmag = front.inertia * front.omega + (rear.inertia + crank) * rear.omega;
    this.gyroL = Lmag;
    _L.copy(ph.left).multiplyScalar(Lmag);
    _g.crossVectors(w, _L).multiplyScalar(-c.gyroScale);
    T.add(_g);
    this.torque.gyro = _g.dot(fwd);

    // 6) air + body damping per axis
    T.addScaledVector(right, -c.damping.pitch * w.dot(right));
    T.addScaledVector(up, -c.damping.yaw * w.dot(up));
    T.addScaledVector(fwd, -c.damping.roll * w.dot(fwd));

    // 7) rider counterbalance: the upper body lags and counter-rotates; its reaction acts
    //    back on the bike (internal torque)
    const cb = c.riderCounterbalance;
    const twistT = clamp(-psi * cb, -c.riderTwistMax * DEG, c.riderTwistMax * DEG);
    const leanT = clamp(-phi * cb * 0.7 + this.sideEffort * 0.25, -c.riderLeanMax * DEG, c.riderLeanMax * DEG);
    const aT = c.riderSpring * (twistT - this.riderTwist) - c.riderDamping * this.riderTwistV;
    const aL = c.riderSpring * (leanT - this.riderLean) - c.riderDamping * this.riderLeanV;
    this.riderTwistV += aT * dt;
    this.riderTwist += this.riderTwistV * dt;
    this.riderLeanV += aL * dt;
    this.riderLean += this.riderLeanV * dt;
    tYaw += c.riderInertia * aT;
    tRoll += -c.riderInertia * aL;

    T.y += tYaw;
    T.addScaledVector(fwd, tLay);
    T.addScaledVector(h, tRoll);
    T.addScaledVector(right, tPitch);
    this.torque.yaw = tYaw;
    this.torque.roll = tRoll + tLay;
    this.torque.pitch = tPitch;

    // 8) bars turned back toward the direction of travel (front wheel directional stability);
    //    just before touchdown the rider lines them up for the landing again
    const toBars = land > 0 ? smoothstep(c.barsLandingTime, c.barsLandingTime * 0.35, land) : 0;
    const travelSteer = clamp(-psi * c.frontStability + this.whipEffort * 0.12, -c.maxAirSteer, c.maxAirSteer);
    this.airSteer = travelSteer + (ph.steerGround - travelSteer) * toBars;
    ph.steerAngle += (this.airSteer - ph.steerAngle) * (1 - Math.exp(-dt / c.steerResponse));
    this.onFace = false;
  }

  /**
   * On the ground: the whip can be set up on a jump face (the tyres still push), and the
   * rider's body settles back.
   */
  ground(ph, dt, T, authority) {
    const c = this.cfg;
    const h = WhipController.heading(ph, _h);
    this.whipAngle = WhipController.angle(ph, h);
    this.whipRate = -ph.angVel.y;
    this.rollRate = ph.angVel.dot(h);
    this.landIn = -1;
    this.recovery = 0;
    this.torque.gyro = 0;
    this.torque.aero = 0;
    this.torque.recYaw = 0;
    this.torque.recRoll = 0;
    // on a takeoff face at speed: part of the whip effort already turns the bike
    this.onFace = WhipController.onTakeoff(ph);
    const face = this.onFace ? c.faceWhip * c.airControl * authority * smoothstep(0.17, 0.35, ph.pitchAngle) : 0;
    const tYaw = -this.whipEffort * c.whipYawTorque * face;
    const tRoll = this.whipEffort * c.whipRollTorque * face;
    if (face > 0) {
      T.y += tYaw;
      T.addScaledVector(ph.fwd, tRoll);
    }
    this.torque.yaw = tYaw;
    this.torque.roll = tRoll;
    this.torque.pitch = 0;
    // rider's body back to neutral
    const k = c.riderSpring, d = c.riderDamping;
    this.riderTwistV += (-k * this.riderTwist - d * this.riderTwistV) * dt;
    this.riderTwist += this.riderTwistV * dt;
    this.riderLeanV += (-k * this.riderLean - d * this.riderLeanV) * dt;
    this.riderLean += this.riderLeanV * dt;
  }
}

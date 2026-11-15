/* =====================================================================
   ROOST MX - motorcycle physics.

   Model (integrated at 500 Hz):
   - One rigid body for bike + rider (6 DOF). The rider's centre of mass
     moves inside it (fore/aft, height, sideways), shifting weight.
   - The total angular momentum (chassis + spinning wheels + crank) is
     integrated, so wheel/crank spin-up and braking pitch the bike in the
     air (throttle = nose up, rear brake = nose down) and spinning wheels
     give real gyroscopic coupling (yaw <-> roll) during whips.
   - Fork (raked telescopic) and swingarm (arc) suspension, each a
     massless-wheel spring/damper solved implicitly against a radial tire
     spring: progressive springs, digressive damping, top-out, bottoming.
   - Wheel-vs-heightfield contact with the wheel as a disk.
   - Combined-slip tire model (friction ellipse, peak/slide) on surfaces
     with different grip, rolling resistance, brake locking.
   - Engine torque curve, rev limiter, engine braking, flywheel inertia,
     friction clutch (manual lever + optional auto/anti-stall clutch),
     sequential gearbox with neutral, shift time, stalling.
   - The rider balances the bike by counter-steering toward the lean the
     player asks for (like a real rider does); grip limits, bumps, ruts
     and landings can still knock it down. Below walking pace the rider
     dabs a foot.
   - Air control: body pitch, whip (roll/yaw), throttle and brakes.
   - Crash detection and a simple tumble/ragdoll after a crash.
   ===================================================================== */
MX.module('physics', function (THREE, MX) {
  'use strict';
  const { clamp, lerp, smoothstep } = MX;
  const V = THREE.Vector3;
  const G = 9.81;
  const RHO = 1.2;
  const DT = 1 / 500;
  const C = MX.CHASSIS;

  // magic-formula-like normalized tire curve: peak 1 at rho=1, slides at ~0.89
  const TB = 2.6, TC = 1.3;
  function tireCurve(rho) { return Math.sin(TC * Math.atan(TB * rho)); }

  // temporaries
  const _v1 = new V(), _v2 = new V(), _v3 = new V(), _v4 = new V(), _v5 = new V(), _v6 = new V();
  const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
  const _hn = { h: 0, nx: 0, ny: 1, nz: 0, info: {} };

  class Wheel {
    constructor(front) {
      this.front = front;
      this.s = 0; this.sv = 0;           // suspension compression & speed
      this.spin = 0; this.angle = 0;      // rad/s, rad
      this.contact = false; this.N = 0;
      this.Fx = 0; this.Fy = 0;
      this.slip = 0; this.slipAngle = 0; this.slideAmt = 0;
      this.mu = 1; this.dirt = 1; this.rut = 0; this.onTrack = false;
      this.cp = new V(); this.cn = new V(0, 1, 0); this.axle = new V();
      this.fPrev = new V();
      this.bottomed = false; this.toppedOut = true;
      this.pen = 0;
      this.braking = 0;
      this.locked = false;
    }
  }

  class BikePhysics {
    constructor(track, spec, setup, options) {
      this.track = track;
      this.opts = Object.assign({ autoClutch: true, autoShift: false, steerAssist: 1.0, riderAssist: 1, tractionControl: true }, options || {});
      this.pos = new V(); this.vel = new V();
      this.q = new THREE.Quaternion();
      this.L = new V(); this.omega = new V();
      this.origin = new V();
      this.f = new V(0, 0, 1); this.u = new V(0, 1, 0); this.l = new V(1, 0, 0);
      this.wheels = [new Wheel(true), new Wheel(false)];
      this.input = { throttle: 0, front: 0, rear: 0, clutch: 0, lean: 0, rider: 0 };
      this.rider = { x: 0, y: 0.78, z: 0, vx: 0, vy: 0, vz: 0, seated: 0, legOut: 0 };
      this.com = new V();
      this.inertia = new V(1, 1, 1);
      this.events = [];
      this.steer = 0;
      this.engine = { rpm: 0, w: 0, gear: 1, thrEff: 0, cut: false, stalled: false, load: 0, limiter: false, shiftT: 0, pendingGear: null, clutchEng: 1, locked: false, autoShiftCd: 0, torque: 0 };
      this.air = { airborne: false, time: 0, maxH: 0, lastContactT: 0 };
      this.crashed = false; this.crash = null;
      this.time = 0;
      this.setSpec(spec, setup);
    }

    // ------------------------------------------------------------ setup
    setSpec(spec, setup) {
      this.spec = spec;
      this.setup = Object.assign(MX.defaultSetup(), setup || {});
      const su = spec.susp, st = this.setup;
      this.mBike = spec.mass; this.mRider = C.riderMass; this.m = this.mBike + this.mRider;
      const mk = (front) => ({
        R: front ? C.wheelRadiusF : C.wheelRadiusR,
        travel: front ? su.travelF : su.travelR,
        k: (front ? su.kF : su.kR) * (front ? st.forkSpring : st.shockSpring),
        prog: (front ? su.progF : su.progR) * (front ? st.forkSpring : st.shockSpring),
        preload: front ? su.preloadF : su.preloadR,
        comp: (front ? su.compF : su.compR) * st.compression,
        reb: (front ? su.rebF : su.rebR) * st.rebound,
        knee: su.hsKnee, hsc: su.hsCompFactor, hsr: su.hsRebFactor,
        I: front ? spec.wheelInertiaF : spec.wheelInertiaR,
        brake: front ? spec.brakes.front : spec.brakes.rear,
        kt: front ? 105000 : 115000, ct: 260,
      });
      this.wp = [mk(true), mk(false)];
      this.ratios = MX.gearRatios(spec, this.setup);
      const e = spec.engine;
      this.eng = e;
      this.wIdle = e.idle * Math.PI / 30;
      this.wLimit = e.limit * Math.PI / 30;
      // steering geometry (local)
      const rk = C.rake;
      this.axisUp = new V(0, Math.cos(rk), -Math.sin(rk));
      this.perpF = new V(0, Math.sin(rk), Math.cos(rk));
      this.head = new V(C.steerHead[0], C.steerHead[1], C.steerHead[2]);
      this.pivot = new V(C.swingPivot[0], C.swingPivot[1], C.swingPivot[2]);
      this.wheelbase = 1.5;
      this.handling = spec.handling * (this.setup.steering || 1);
    }

    setOptions(o) { Object.assign(this.opts, o); }

    // local axle position for compression s; dir gets the compression direction
    axleLocal(front, s, out, dir) {
      if (front) {
        // A = head - (L - s) * axisUp + offset * perpF
        out.copy(this.head).addScaledVector(this.axisUp, -(C.forkLenExt - s)).addScaledVector(this.perpF, C.forkOffset);
        if (dir) dir.copy(this.axisUp);
      } else {
        const b = C.rearExtAngle - s / C.swingLen;
        out.set(0, this.pivot.y - C.swingLen * Math.sin(b), this.pivot.z - C.swingLen * Math.cos(b));
        if (dir) dir.set(0, Math.cos(b), -Math.sin(b));
      }
      return out;
    }

    // ------------------------------------------------------------ helpers
    localToWorld(p, out) { return out.copy(p).sub(this.com).applyQuaternion(this.q).add(this.pos); }

    _updateBasis() {
      this.f.set(0, 0, 1).applyQuaternion(this.q);
      this.u.set(0, 1, 0).applyQuaternion(this.q);
      this.l.set(1, 0, 0).applyQuaternion(this.q);
    }

    _updateMass() {
      const r = this.rider, sp = this.spec;
      const mb = this.mBike, mr = this.mRider, m = this.m;
      const bx = 0, by = sp.cogY, bz = sp.cogZ;
      const cx = (mb * bx + mr * r.x) / m, cy = (mb * by + mr * r.y) / m, cz = (mb * bz + mr * r.z) / m;
      this.com.set(cx, cy, cz);
      const dbx = bx - cx, dby = by - cy, dbz = bz - cz;
      const drx = r.x - cx, dry = r.y - cy, drz = r.z - cz;
      const I = sp.inertia;
      const riderPitch = 7.5, riderYaw = 3.2, riderRoll = 8.5;
      const ix = I.pitch + riderPitch + mb * (dby * dby + dbz * dbz) + mr * (dry * dry + drz * drz);
      const iy = I.yaw + riderYaw + mb * (dbx * dbx + dbz * dbz) + mr * (drx * drx + drz * drz);
      const iz = I.roll + riderRoll + mb * (dbx * dbx + dby * dby) + mr * (drx * drx + dry * dry);
      this.inertia.set(ix, iy, iz);
    }

    spinMomentum(out) {
      const w = this.wheels, e = this.engine;
      const s = this.wp[0].I * w[0].spin + this.wp[1].I * w[1].spin + this.eng.inertia * e.w;
      return out.copy(this.l).multiplyScalar(s);
    }

    _updateOmega() {
      // omega = I_world^-1 (L - L_spin)
      const b = this.spinMomentum(_v1).negate().add(this.L);
      _q1.copy(this.q).invert();
      b.applyQuaternion(_q1);
      b.set(b.x / this.inertia.x, b.y / this.inertia.y, b.z / this.inertia.z);
      this.omega.copy(b.applyQuaternion(this.q));
    }

    // world angular momentum for a given chassis angular velocity
    _setOmega(w) {
      const wx = w.x, wy = w.y, wz = w.z;
      _q1.copy(this.q).invert();
      const b = _v1.set(wx, wy, wz).applyQuaternion(_q1);
      b.set(b.x * this.inertia.x, b.y * this.inertia.y, b.z * this.inertia.z).applyQuaternion(this.q);
      this.L.copy(b).add(this.spinMomentum(_v2));
      this.omega.set(wx, wy, wz);
    }

    get speed() { return this.vel.length(); }
    get forwardSpeed() { return this.vel.dot(this.f); }
    get lean() { return Math.asin(clamp(this.l.y, -1, 1)); }
    get pitch() { return Math.asin(clamp(-this.f.y, -1, 1)); } // + = nose down
    get rpm() { return this.engine.w * 30 / Math.PI; }
    get gear() { return this.engine.gear; }
    get airborne() { return this.air.airborne; }

    // ------------------------------------------------------------ reset
    reset(s, offset) {
      const tr = this.track;
      s = s == null ? tr.spawnS : s;
      const p = tr.pointAt(s);
      const heading = p.heading;
      const d = offset || 0;
      const x = p.x + p.tz * d, z = p.z - p.tx * d;
      this.rider.x = 0; this.rider.y = 0.70; this.rider.z = 0; this.rider.vx = this.rider.vy = this.rider.vz = 0;
      this.loadInst = G; this.loadFilt = G;
      this.rider.seated = 0; this.rider.legOut = 0;
      this._updateMass();
      // estimate sag and the pitch from the ground under the wheels
      const wb = 1.5;
      const hr = tr.height(x - Math.sin(heading) * wb * 0.45, z - Math.cos(heading) * wb * 0.45);
      const hf = tr.height(x + Math.sin(heading) * wb * 0.55, z + Math.cos(heading) * wb * 0.55);
      const pitch = Math.atan2(hf - hr, wb);
      this.q.setFromEuler(new THREE.Euler(-pitch, heading, 0, 'YXZ'));
      this._updateBasis();
      const sagF = this.wp[0].travel * 0.24, sagR = this.wp[1].travel * 0.32;
      this.wheels[0].s = sagF; this.wheels[1].s = sagR;
      for (const w of this.wheels) { w.sv = 0; w.spin = 0; w.contact = false; w.N = 0; w.fPrev.set(0, 0, 0); w.locked = false; }
      // place so the rear tyre just touches
      const ar = this.axleLocal(false, sagR, _v3);
      const arW = _v4.copy(ar).sub(this.com).applyQuaternion(this.q);
      const groundR = Math.min(hr, tr.height(x - Math.sin(heading) * 0.66, z - Math.cos(heading) * 0.66));
      this.pos.set(x - Math.sin(heading) * 0.04, 0, z - Math.cos(heading) * 0.04);
      this.pos.y = groundR + this.wp[1].R - arW.y + 0.012;
      this.vel.set(0, 0, 0); this.L.set(0, 0, 0); this.omega.set(0, 0, 0);
      const e = this.engine;
      e.w = this.wIdle; e.gear = 1; e.shiftT = 0; e.pendingGear = null; e.stalled = false; e.cut = false; e.locked = false; e.thrEff = 0; e.autoShiftCd = 0;
      this.steer = 0;
      this.crashed = false; this.crash = null;
      this.air.airborne = false; this.air.time = 0; this.air.lastContactT = this.time;
      this.events.length = 0;
      this.origin.copy(this.com).negate().applyQuaternion(this.q).add(this.pos);
      // let it settle for a moment (no horizontal motion)
      const saveIn = Object.assign({}, this.input);
      Object.assign(this.input, { throttle: 0, front: 0.5, rear: 0.5, clutch: 1, lean: 0, rider: 0 });
      for (let i = 0; i < 300; i++) {
        this.step(DT, true);
        this.vel.x *= 0.5; this.vel.z *= 0.5;
        const wv = _v5.copy(this.omega); wv.y *= 0.5; this._setOmega(wv);
      }
      this.vel.set(0, Math.min(0, this.vel.y), 0);
      this._setOmega(_v5.set(0, 0, 0));
      for (const w of this.wheels) w.spin = 0;
      this._setOmega(_v5.set(0, 0, 0));
      Object.assign(this.input, saveIn);
      this.events.length = 0;
      this.crashed = false; this.crash = null;
      this.air.airborne = false; this.air.time = 0;
      e.w = this.wIdle;
    }

    // ------------------------------------------------------------ gears
    shift(dir) {
      const e = this.engine;
      if (this.crashed || e.shiftT > 0) return false;
      const n = this.ratios.length;
      let g = e.gear + dir;
      if (g < 0 || g > n) return false;
      // over-rev protection on downshifts
      if (dir < 0 && g >= 1 && e.gear >= 1) {
        const wheelW = this.wheels[1].spin;
        const newW = wheelW * this.ratios[g - 1];
        if (newW > this.wLimit * 1.04) { this.events.push({ type: 'shiftDenied' }); return false; }
      }
      e.pendingGear = g;
      e.shiftT = dir > 0 ? 0.075 : 0.095;
      e.shiftDir = dir;
      this.events.push({ type: 'shift', gear: g, dir });
      return true;
    }

    // ------------------------------------------------------------ main step
    step(dt, settling) {
      dt = dt || DT;
      this.time += dt;
      if (this.crashed) { this._crashStep(dt); return; }
      const inp = this.input;
      const tr = this.track;

      this._updateBasis();
      const speed = this.vel.length();
      const vF = this.vel.dot(this.f);
      const grounded = this.wheels[0].contact || this.wheels[1].contact;

      // ---------------- rider body (moves the centre of mass)
      this._riderStep(dt, grounded, speed);
      this._updateMass();
      this.origin.copy(this.com).negate().applyQuaternion(this.q).add(this.pos);
      this._updateOmega();

      const F = _v5.set(0, -G * this.m, 0);   // total force
      const T = _v6.set(0, 0, 0);              // total torque about CoM

      // ---------------- steering
      this._steerStep(dt, speed, vF);

      // ---------------- wheels: contact, suspension, tyres
      for (let k = 0; k < 2; k++) this._wheelStep(k, dt, F, T);

      // ---------------- drivetrain (engine, clutch, gearbox, wheel spin)
      this._drivetrainStep(dt, settling);

      // ---------------- aero drag
      if (speed > 0.1) {
        const dragK = 0.5 * RHO * this.spec.aero * speed;
        F.addScaledVector(this.vel, -dragK);
      }

      // ---------------- rider control torques (air control, foot dab, scrub)
      this._riderTorques(dt, T, speed);

      // ---------------- chassis probes (skid plate, pegs, fenders) & colliders
      this._probeStep(dt, F, T, settling);

      // specific force felt by the bike (all but gravity), along its up axis
      this.loadInst = (F.dot(this.u) + G * this.m * this.u.y) / this.m;
      // ---------------- integrate
      const aL = F.dot(this.f) / this.m;
      this.accLong = (this.accLong || 0) + (aL - (this.accLong || 0)) * (1 - Math.exp(-12 * dt));
      this.vel.addScaledVector(F, dt / this.m);
      this.pos.addScaledVector(this.vel, dt);
      this.L.addScaledVector(T, dt);
      // keep the chassis spin sane (numerical safety)
      this._updateOmega();
      const wl = this.omega.length();
      if (wl > 40) this._setOmega(_v1.copy(this.omega).multiplyScalar(40 / wl));
      if (wl > 1e-9) {
        _q1.setFromAxisAngle(_v1.copy(this.omega).multiplyScalar(1 / wl), wl * dt);
        this.q.premultiply(_q1).normalize();
      }
      // wheel angles
      this.wheels[0].angle = (this.wheels[0].angle + this.wheels[0].spin * dt) % (Math.PI * 200);
      this.wheels[1].angle = (this.wheels[1].angle + this.wheels[1].spin * dt) % (Math.PI * 200);
      this.origin.copy(this.com).negate().applyQuaternion(this.q).add(this.pos);

      // ---------------- air state & landings
      this._airStep(dt);
      if (!settling) this._crashChecks(dt);
    }

    // ------------------------------------------------------------ rider
    _riderStep(dt, grounded, speed) {
      const r = this.rider, inp = this.input;
      const assist = this.opts.riderAssist == null ? 1 : this.opts.riderAssist;
      const P = clamp(inp.rider, -1, 1), Ln = clamp(inp.lean, -1, 1);
      // sit down in slow corners (rider plants the inside foot), stand otherwise
      const wantSit = grounded && speed > 1.5 && speed < 13 && Math.abs(Ln) > 0.35 && P > -0.5 && inp.front < 0.5;
      r.seated = MX.approach(r.seated, wantSit ? 1 : 0, dt * (wantSit ? 2.2 : 3.0));
      r.legOut = MX.approach(r.legOut, wantSit ? Math.sign(Ln) : 0, dt * 3);
      let tz = P >= 0 ? P * 0.20 : P * 0.28;
      let ty = 0.78 - 0.07 * Math.abs(P);
      tz = lerp(tz, -0.14 + P * 0.10, r.seated);
      ty = lerp(ty, 0.70, r.seated);
      // braking hard: get back; accelerating hard: get forward (attack position)
      if (grounded && assist > 0) {
        const ax = this.accLong || 0;          // + = accelerating
        tz += clamp(ax / G, -1.2, 1.2) * 0.09 * assist * (Math.abs(P) < 0.5 ? 1 : 0.4);
      }
      // the body stays roughly upright while the bike pitches under it
      if (grounded) {
        const pu = Math.asin(clamp(this.f.y, -1, 1));   // + = nose up (world)
        const comp = clamp(pu, -0.6, 0.6);
        tz += 0.62 * ty * Math.sin(comp);
        ty -= 0.10 * Math.abs(Math.sin(comp));
      }
      let tx = grounded ? Ln * 0.06 : -Ln * 0.05;
      // corner exit on the gas: weight over the front so it steers
      if (grounded) tz += 0.10 * clamp(Math.abs(Ln) * 1.6, 0, 1) * clamp(inp.throttle * 1.5, 0, 1) * (P > -0.3 ? 1 : 0);
      // instinct: a rider leans into a wheelie and back on a stoppie
      if (assist > 0 && grounded) {
        const wf = this.wheels[0], wr = this.wheels[1];
        if (wr.contact && !wf.contact) {
          const up = this.f.dot(wr.cn);   // sin(nose-up angle vs ground)
          tz += assist * 0.2 * smoothstep(0.06, 0.45, up) * (P > -0.3 ? 1 : 0.25);
        } else if (wf.contact && !wr.contact) {
          const dn = -this.f.dot(wf.cn);
          tz -= assist * 0.24 * smoothstep(0.05, 0.35, dn);
        }
      }
      const wn = 9;
      const k = wn * wn, c = 2 * wn;
      r.vx += (k * (tx - r.x) - c * r.vx) * dt; r.x += r.vx * dt;
      r.vz += (k * (tz - r.z) - c * r.vz) * dt; r.z += r.vz * dt;
      // legs: two-body relative motion. Load transients push the rider down (landings) or
      // let him float up (take-offs); muscles follow the load with a lag; legs spring & damp.
      const mr = this.mRider, mb = this.mBike, m = this.m, mu = mr * mb / m;
      const fInst = this.loadInst || 0;
      this.loadFilt = (this.loadFilt == null ? fInst : this.loadFilt) + (fInst - (this.loadFilt == null ? fInst : this.loadFilt)) * (1 - Math.exp(-dt / 0.12));
      const kLeg = mu * 75, cLeg = 2 * 0.8 * Math.sqrt(kLeg * mu);
      const ay = (m / mb) * (this.loadFilt - fInst) + (kLeg * (ty - r.y) - cLeg * r.vy) / mu;
      r.vy += clamp(ay, -150, 150) * dt; r.y += r.vy * dt;
      if (r.y < 0.42) { r.y = 0.42; if (r.vy < 0) r.vy = 0; }
      if (r.y > 0.98) { r.y = 0.98; if (r.vy > 0) r.vy = 0; }
      // the bike moves opposite to the rider (momentum is shared)
      const kk = -mr / m;
      this.bikeVelOff = this.bikeVelOff || new V();
      this.bikeVelOff.set(r.vx * kk, r.vy * kk, r.vz * kk).applyQuaternion(this.q);
    }

    // ------------------------------------------------------------ steering
    _steerStep(dt, speed, vF) {
      const inp = this.input;
      const Ln = clamp(inp.lean, -1, 1);
      const fw = this.wheels[0];
      const v = Math.max(Math.abs(vF), 0.01);
      const phi = this.lean;                      // + = leaning right
      const phiRate = this.omega.dot(this.f);     // + = rolling right
      let target;
      const hand = this.handling * (this.opts.steerAssist || 1);
      if (!fw.contact && this.wheels[1].contact) {
        // front in the air (wheelie / skipping): the bars can't do anything, hold them
        target = this.steer * 0.98;
        this.leanTarget = MX.approach(this.leanTarget == null ? phi : this.leanTarget, phi, 2 * dt);
      } else if (fw.contact) {
        let phiMax = lerp(0.30, 0.98, smoothstep(1.5, 11, v));
        // the rider knows roughly how much the dirt will hold (plus the berm's banking)
        const assist = this.opts.riderAssist == null ? 1 : this.opts.riderAssist;
        if (assist > 0) {
          const cw = fw.contact ? fw : this.wheels[1];
          const bank = Math.asin(clamp(cw.cn.dot(this.l) * -Math.sign(Ln || 1), -0.9, 0.9)); // ground tilt toward the turn
          const muE = cw.mu * 0.94;
          const grip = Math.atan(muE * (assist >= 2 ? 0.74 : 0.82)) + Math.max(0, bank) * 0.9;
          phiMax = Math.min(phiMax, grip);
        }
        // the rider can only throw the bike over so fast
        const phiGoal = Ln * phiMax;
        this.leanTarget = MX.approach(this.leanTarget == null ? phi : this.leanTarget, phiGoal, 4.0 * Math.sqrt(hand) * dt);
        const phiT = this.leanTarget;
        // lateral acceleration the "rider" asks the tyres for (counter-steering)
        const k1 = 50 * hand, k2 = 13 * Math.sqrt(hand);
        const aCmd = G * Math.tan(clamp(phi, -1.2, 1.2)) + k1 * (phi - phiT) + k2 * phiRate;
        const vv = Math.max(v, 2.2);
        let dCtl = -Math.atan(this.wheelbase * aCmd / (vv * vv)) / Math.cos(C.rake);
        // inner loop: track the yaw rate that gives that acceleration (cancels tyre understeer)
        if (v > 3) {
          const rDes = -aCmd / v;                  // world yaw rate, + = turning left
          const rAct = this.omega.y;
          dCtl += clamp((rDes - rAct) * 0.32 * clamp(9 / v, 0.25, 1.5), -0.25, 0.25) * smoothstep(3, 6, v);
        }
        // steer into a rear-wheel slide (opposite lock)
        if (speed > 3) {
          const vh = _v1.set(this.vel.x, 0, this.vel.z).normalize();
          const fh = _v2.set(this.f.x, 0, this.f.z).normalize();
          const beta = Math.atan2(vh.z * fh.x - vh.x * fh.z, vh.dot(fh)); // + = nose left of travel
          dCtl += clamp(-0.55 * beta * hand, -0.4, 0.4) * smoothstep(3, 6, speed);
        }
        // walking pace: steer directly
        const direct = -Ln * 0.62;
        const blend = smoothstep(1.2, 3.2, v);
        target = lerp(direct, dCtl, blend);
        if (vF < -0.3) target = direct;           // rolling backwards
        // bars can't usefully turn further than ~1.8 g of kinematic lateral acceleration
        const dMax = clamp(Math.atan(this.wheelbase * 1.8 * G / Math.max(v * v, 1)), 0.07, 0.66);
        target = clamp(target, -dMax, dMax);
      } else {
        target = -Ln * 0.28;                       // in the air: bars follow the input
        this.leanTarget = phi;
      }
      const rate = 7;
      this.steer = MX.approach(this.steer, target, rate * dt);
    }

    // ------------------------------------------------------------ wheel
    _wheelStep(k, dt, F, T) {
      const front = k === 0;
      const w = this.wheels[k], wp = this.wp[k];
      const tr = this.track;
      const R = wp.R;

      // world axle position & compression direction
      const aL = this.axleLocal(front, w.s, _v1, _v2);
      const C0 = w.axle.copy(aL).sub(this.com).applyQuaternion(this.q).add(this.pos);
      const D = _v2.applyQuaternion(this.q);
      // wheel plane: forward fw, axle aw (left)
      const fw = _v3.copy(this.f), aw = _v4.copy(this.l);
      if (front && Math.abs(this.steer) > 1e-5) {
        const sa = _v1.copy(this.axisUp).applyQuaternion(this.q);
        _q2.setFromAxisAngle(sa, this.steer);
        fw.applyQuaternion(_q2); aw.applyQuaternion(_q2);
      }
      // down in the wheel plane = aw x fw
      const dw = _v1.crossVectors(aw, fw).normalize();

      // ---- find the deepest rim sample
      let best = -1e9, bx = 0, bz = 0, bh = 0, by = 0;
      for (let i = -3; i <= 3; i++) {
        const th = i * 0.36;
        const cth = Math.cos(th), sth = Math.sin(th);
        const px = C0.x + R * (cth * dw.x + sth * fw.x);
        const py = C0.y + R * (cth * dw.y + sth * fw.y);
        const pz = C0.z + R * (cth * dw.z + sth * fw.z);
        const h = tr.height(px, pz);
        const pv = h - py;
        if (pv > best) { best = pv; bx = px; bz = pz; bh = h; by = py; }
      }
      let pen = -1, nd = 0;
      const n = w.cn;
      if (best > -0.03) {
        tr.heightNormal(bx, bz, _hn);
        n.set(_hn.nx, _hn.ny, _hn.nz);
        // disk vs plane
        const ndA = n.dot(aw);
        const nip = Math.sqrt(Math.max(1e-6, 1 - ndA * ndA));
        const dCenter = (C0.x - bx) * n.x + (C0.y - _hn.h) * n.y + (C0.z - bz) * n.z;
        pen = R * nip - dCenter;
        // contact point on the rim
        w.cp.copy(n).addScaledVector(aw, -ndA).multiplyScalar(-R / nip).add(C0);
        w.dirt = _hn.info.dirt; w.rut = _hn.info.rut; w.onTrack = _hn.info.onTrack;
        w.mu = tr.mu(_hn.info, bx, bz);
        nd = n.dot(D);
      }

      // ---- suspension (implicit, massless wheel)
      const s0 = w.s;
      const prog = wp.prog * s0 * s0;
      let Fs = wp.preload + wp.k * s0 + prog * s0;
      let ks = wp.k + 3 * prog;
      const bumpStart = wp.travel - 0.035;
      if (s0 > bumpStart) { const e = s0 - bumpStart; Fs += 1.6e6 * e * e; ks += 3.2e6 * e; }
      const contact = pen > 0;
      let rhs = -Fs, K = ks;
      if (contact) {
        rhs += wp.kt * pen * nd + w.fPrev.dot(D);
        K += wp.kt * nd * nd;
      }
      let cLow = rhs > 0 ? wp.comp : wp.reb;
      let sv = rhs / (cLow + K * dt);
      if (Math.abs(sv) > wp.knee) {
        const cHigh = cLow * (rhs > 0 ? wp.hsc : wp.hsr);
        sv = Math.sign(rhs) * (Math.abs(rhs) - (cLow - cHigh) * wp.knee) / (cHigh + K * dt);
      }
      let s1 = s0 + sv * dt;
      w.bottomed = false; w.toppedOut = false;
      if (s1 < 0) { s1 = 0; sv = 0; w.toppedOut = true; }
      if (s1 > wp.travel) { s1 = wp.travel; sv = 0; w.bottomed = true; }
      w.s = s1; w.sv = sv;

      if (!contact) {
        w.contact = false; w.N = 0; w.Fx = 0; w.Fy = 0; w.slideAmt = 0; w.pen = 0;
        w.fPrev.set(0, 0, 0);
        return;
      }
      // ---- tyre normal force
      let p = pen - nd * (s1 - s0);
      if (p <= 0) { w.contact = false; w.N = 0; w.Fx = w.Fy = 0; w.fPrev.set(0, 0, 0); w.pen = 0; return; }
      w.pen = p;
      // contact point velocity
      const r = _v1.copy(w.cp).sub(this.pos);
      const vc = _v2.crossVectors(this.omega, r).add(this.vel);
      if (this.bikeVelOff) vc.add(this.bikeVelOff);
      const vn = vc.dot(n) + sv * nd;   // wheel centre approach speed (+ = leaving)
      let N = wp.kt * p - wp.ct * vn;
      if (p > 0.055) N += wp.kt * 6 * (p - 0.055);   // rim hits
      // first touch after a gap: how hard did the tyre hit the ground?
      if (!w.contact) { w.impact = Math.max(0, -vn); w.impactT = this.time; }
      if (N < 0) N = 0;
      w.contact = true; w.N = N;

      // ---- tyre frame
      const tl = _v3.copy(fw).addScaledVector(n, -fw.dot(n));
      const tll = tl.length();
      if (tll < 1e-4) { w.Fx = w.Fy = 0; return; }
      tl.multiplyScalar(1 / tll);
      const tlat = _v4.crossVectors(n, tl);   // left
      const vLong = vc.dot(tl), vLat = vc.dot(tlat);
      const surf = w.spin * R;
      const slipV = surf - vLong;
      const vRef = Math.max(Math.abs(vLong), 1.0);
      const kappa = slipV / vRef;
      const alpha = Math.atan2(vLat, vRef);
      const kp = 0.17 + 0.05 * (1 - w.dirt), ap = 0.19;
      const sx = kappa / kp, sy = alpha / ap;
      const rho = Math.sqrt(sx * sx + sy * sy);
      // load sensitivity: knobbies (and the dirt under them) give less grip per newton under big loads
      const mu = w.mu * clamp(1.07 - 0.07 * N / 1000, 0.72, 1.05);
      let fOverRho = rho < 1e-4 ? TB * TC : tireCurve(rho) / rho;
      let Fx = mu * N * fOverRho * sx;
      let Fy = -mu * N * fOverRho * sy;
      // stability limits (don't let the tyre force overshoot the slip in one step)
      const e = this.engine;
      const Ieff = (!front && e.locked && e.gear > 0) ? wp.I + this.ratios[e.gear - 1] ** 2 * this.eng.inertia : wp.I;
      const capX = 0.8 * Math.abs(slipV) / (dt * (R * R / Ieff + 1 / this.m));
      if (Math.abs(Fx) > capX) Fx = Math.sign(Fx) * capX;
      const capY = 0.5 * 70 * Math.abs(vLat) / dt;
      if (Math.abs(Fy) > capY) Fy = Math.sign(Fy) * capY;
      w.Fx = Fx; w.Fy = Fy;
      w.slip = kappa; w.slipAngle = alpha;
      w.slideAmt = clamp(Math.max(Math.abs(sx), Math.abs(sy)) - 0.8, 0, 3) * (Math.abs(vLong) + Math.abs(vLat) > 1 ? 1 : 0)
                 + (Math.abs(slipV) > 3 ? 0.5 : 0);
      w.vLong = vLong;
      // ---- apply to chassis at the contact point
      const Fw = _v1.copy(n).multiplyScalar(N).addScaledVector(tl, Fx).addScaledVector(tlat, Fy);
      w.fPrev.copy(tl).multiplyScalar(Fx).addScaledVector(tlat, Fy);
      F.add(Fw);
      const rr = _v2.copy(w.cp).sub(this.pos);
      T.add(rr.cross(Fw));
    }

    // ------------------------------------------------------------ drivetrain
    _engineTorque(w, thr) {
      const e = this.eng;
      const rpm = w * 30 / Math.PI;
      const fric = e.friction[0] + e.friction[1] * rpm;
      if (this.engine.stalled) return w > 0 ? -fric - 2 : 0;
      let full = MX.curveSmooth(e.torque, rpm);
      let tq = thr * full - (1 - thr) * fric;
      // rev limiter (cut with hysteresis)
      const en = this.engine;
      if (rpm > e.limit) en.cut = true;
      else if (rpm < e.limit - 220) en.cut = false;
      if (en.cut) tq = -fric;
      // idle control
      if (rpm < e.idle * 1.05) tq += clamp((e.idle * 1.05 - rpm) * 0.06, 0, 14) * (1 - thr);
      return tq;
    }

    _drivetrainStep(dt, settling) {
      const inp = this.input, en = this.engine, e = this.eng;
      const wf = this.wheels[0], wr = this.wheels[1];
      const pf = this.wp[0], pr = this.wp[1];

      // throttle response (carb/body lag) and shift cut
      let thrIn = clamp(inp.throttle, 0, 1);
      en.thrEff += (thrIn - en.thrEff) * (1 - Math.exp(-e.response * dt));
      if (en.shiftT > 0) {
        en.shiftT -= dt;
        if (en.pendingGear != null && en.shiftT < 0.04) { en.gear = en.pendingGear; en.pendingGear = null; en.locked = false; }
        if (en.shiftT <= 0) en.shiftT = 0;
      }
      const shifting = en.shiftT > 0;
      let thr = shifting && en.shiftDir > 0 ? 0 : en.thrEff;
      // rider instinct: ease the throttle (and cover the rear brake) before looping out
      this.assistBrake = 0;
      const assist = this.opts.riderAssist == null ? 1 : this.opts.riderAssist;
      if (assist > 0 && wr.contact && !wf.contact) {
        const up = Math.asin(clamp(this.f.dot(wr.cn), -1, 1));
        const rate = -this.omega.dot(this.l);   // + = pitching up
        const wantWheelie = clamp(-inp.rider, 0, 1) * 0.14;   // rider back: allow a taller wheelie
        const turning = clamp(Math.abs(inp.lean) * 1.5, 0, 1) * 0.1; // turning: keep the front down
        const a0 = (assist >= 2 ? 0.06 : 0.13) + wantWheelie - turning, a1 = (assist >= 2 ? 0.30 : 0.44) + wantWheelie - turning;
        const pred = up + 0.22 * Math.max(0, rate);
        thr *= 1 - smoothstep(a0, a1, pred);
        if (pred > a1 && rate > 0.3) this.assistBrake = clamp((pred - a1) * 3 + rate * 0.25, 0, 1);
      }
      // rider instinct: the front goes light while turning -> roll off so it can steer
      if (assist > 0 && wr.contact) {
        const nf = wf.contact ? wf.N : 0;
        this.frontLoadF = (this.frontLoadF == null ? nf : this.frontLoadF) + (nf - (this.frontLoadF || 0)) * (1 - Math.exp(-25 * dt));
        const turnNeed = clamp(Math.max(Math.abs(inp.lean) - 0.15, Math.abs(this.lean) * 1.5 - 0.15), 0, 1);
        if (turnNeed > 0) {
          const frac = this.frontLoadF / (this.m * G * 0.47);
          thr *= 1 - turnNeed * (1 - smoothstep(0.12, 0.45, frac)) * 0.9;
        }
      }
      // traction control (like the factory TC on modern MX bikes): trims ignition when the rear spins up
      this.tcCut = 0;
      if (this.opts.tractionControl && wr.contact && en.gear > 0) {
        const k = wr.slip;
        const cut = smoothstep(0.2, 0.55, k);
        this.tcCut = cut;
        thr *= 1 - 0.95 * cut;
      }

      // stall / restart
      if (en.stalled) {
        if (inp.clutch > 0.85 || en.gear === 0) { en.stalled = false; en.w = Math.max(en.w, this.wIdle * 0.9); this.events.push({ type: 'restart' }); }
      }

      // clutch engagement
      let eng = 1 - clamp(inp.clutch, 0, 1);
      if (this.opts.autoClutch) eng *= smoothstep(this.wIdle * 1.1, this.wIdle * 1.95, en.w);
      if (shifting) eng *= 0.0;
      en.clutchEng = eng;
      const cap = eng * e.clutchMax;

      // external torques on the wheels (tyre force + rolling resistance)
      const rrF = 0.032 + 0.03 * (1 - wf.dirt), rrR = 0.032 + 0.03 * (1 - wr.dirt);
      const Text_f = -wf.Fx * pf.R - rrF * wf.N * pf.R * Math.tanh(wf.spin * 2);
      const Text_r = -wr.Fx * pr.R - rrR * wr.N * pr.R * Math.tanh(wr.spin * 2);

      // brakes
      let bfIn = clamp(inp.front, 0, 1);
      // rider instinct: ease the front brake when the rear lifts (no endo)
      if (assist > 0 && wf.contact && bfIn > 0) {
        const down = Math.asin(clamp(-this.f.dot(wf.cn), -1, 1));
        const rateDn = this.omega.dot(this.l);   // + = pitching nose down
        const rearLight = 1 - smoothstep(0.08, 0.3, wr.N / (this.m * G * 0.5));
        const pred = down + 0.25 * Math.max(0, rateDn);
        const a0 = assist >= 2 ? 0.03 : 0.07, a1 = assist >= 2 ? 0.16 : 0.24;
        bfIn *= 1 - rearLight * smoothstep(a0, a1, pred) * 0.85;
      }
      this.frontBrakeEff = bfIn;
      const bf = bfIn * pf.brake;
      const br = Math.max(clamp(inp.rear, 0, 1), this.assistBrake || 0) * pr.brake;
      const brakeApply = (w0, Tb, I) => { const d = Tb * dt / I; return Math.abs(w0) <= d ? 0 : w0 - Math.sign(w0) * d; };

      // front wheel
      let wfNew = wf.spin + Text_f / pf.I * dt;
      wfNew = brakeApply(wfNew, bf, pf.I);
      wf.locked = bf > 0 && wfNew === 0 && Math.abs(wf.vLong || 0) > 0.5;
      wf.spin = wfNew;
      wf.braking = bf;

      // engine torque
      const Teng = this._engineTorque(en.w, thr);
      en.torque = Teng;
      const Ie = e.inertia;
      const gearR = en.gear > 0 ? this.ratios[en.gear - 1] : 0;

      if (gearR === 0 || cap <= 1e-3) {
        en.locked = false;
        en.w = Math.max(0, en.w + Teng / Ie * dt);
        let w = wr.spin + Text_r / pr.I * dt;
        wr.spin = brakeApply(w, br, pr.I);
      } else {
        const g = gearR;
        let done = false;
        if (en.locked) {
          const Ic = pr.I + g * g * Ie;
          const ar = (g * Teng + Text_r) / Ic;
          const Tc = Teng - Ie * g * ar;
          if (Math.abs(Tc) <= cap) {
            let w = wr.spin + ar * dt;
            w = brakeApply(w, br, Ic);
            wr.spin = w; en.w = g * w;
            done = true;
          } else en.locked = false;
        }
        if (!done) {
          const slip = en.w - g * wr.spin;
          const Tc = cap * clamp(slip / 2.0, -1, 1);
          let we = en.w + (Teng - Tc) / Ie * dt;
          let w = wr.spin + (g * Tc + Text_r) / pr.I * dt;
          w = brakeApply(w, br, pr.I);
          const slip2 = we - g * w;
          if ((Math.sign(slip2) !== Math.sign(slip) && slip !== 0) || Math.abs(slip2) < 0.6) {
            // synchronise conserving angular momentum
            const wr2 = (pr.I * w + g * Ie * we) / (pr.I + g * g * Ie);
            wr.spin = wr2; en.w = g * wr2; en.locked = cap > Math.abs(Teng) * 0.5 || cap > 5;
          } else { en.w = Math.max(0, we); wr.spin = w; }
        }
      }
      wr.locked = br > 0 && wr.spin === 0 && Math.abs(wr.vLong || 0) > 0.5;
      wr.braking = br;

      // stall (manual clutch only)
      if (!this.opts.autoClutch && !en.stalled && en.gear > 0 && en.w < this.wIdle * 0.42 && eng > 0.5) {
        en.stalled = true; en.locked = false; this.events.push({ type: 'stall' });
      }
      if (en.stalled) en.w = Math.max(0, en.w - 60 * dt);
      en.rpmSmooth = en.w * 30 / Math.PI;
      en.limiter = en.cut;
      // audio "load": torque demand relative to max
      en.load = clamp(thr * (en.locked || eng > 0.3 ? 1 : 0.55), 0, 1);

      // auto shift
      if (this.opts.autoShift && !settling && !en.stalled && en.shiftT <= 0) {
        en.autoShiftCd -= dt;
        if (en.autoShiftCd <= 0 && en.gear > 0) {
          const rpm = en.w * 30 / Math.PI;
          if (rpm > e.limit * 0.95 && en.gear < this.ratios.length && this.wheels[1].contact) { this.shift(1); en.autoShiftCd = 0.45; }
          else if (en.gear > 1 && rpm < e.limit * 0.42) {
            const after = wr.spin * this.ratios[en.gear - 2] * 30 / Math.PI;
            if (after < e.limit * 0.86) { this.shift(-1); en.autoShiftCd = 0.45; }
          }
        }
        if (en.gear === 0) this.shift(1);
      }
    }

    // ------------------------------------------------------------ rider torques
    _riderTorques(dt, T, speed) {
      const inp = this.input;
      const Ln = clamp(inp.lean, -1, 1), P = clamp(inp.rider, -1, 1);
      const wf = this.wheels[0], wr = this.wheels[1];
      const grounded = wf.contact || wr.contact;
      const f = this.f, u = this.u, l = this.l, om = this.omega;
      if (!grounded) {
        const airT = this.air.time;
        const auth = smoothstep(0.0, 0.12, airT);
        // body pitch: rider forward = nose down
        T.addScaledVector(l, 160 * P * auth);
        // whip: lay the bike over and kick the rear out
        T.addScaledVector(f, 120 * Ln * auth);
        T.addScaledVector(u, 70 * Ln * auth);
        // rider steadies the bike when not whipping
        const calm = (1 - Math.min(1, Math.abs(Ln) * 1.5)) * auth;
        if (calm > 0) {
          const phi = this.lean;
          let yawErr = 0;
          const vh = _v1.set(this.vel.x, 0, this.vel.z);
          const fh = _v2.set(f.x, 0, f.z);
          if (vh.lengthSq() > 4 && fh.lengthSq() > 0.01) {
            vh.normalize(); fh.normalize();
            yawErr = Math.atan2(vh.z * fh.x - vh.x * fh.z, vh.dot(fh)); // + = nose left of travel
          }
          T.addScaledVector(f, (-70 * phi - 28 * om.dot(f)) * calm);
          T.addScaledVector(u, (-45 * yawErr - 20 * om.dot(u)) * calm);
        }
        // rider keeps the bike's pitch matched to the trajectory unless he's asked to move
        const assist = this.opts.riderAssist == null ? 1 : this.opts.riderAssist;
        if (assist > 0) {
          const vh = Math.hypot(this.vel.x, this.vel.z);
          if (vh > 2) {
            const trajPitch = Math.atan2(this.vel.y, vh);              // + = climbing
            const bikePitch = Math.asin(clamp(f.y, -1, 1));           // + = nose up
            const pRate = -om.dot(l);                                 // + = nose up
            const trajRate = -G * Math.cos(trajPitch) / Math.max(4, this.vel.length());
            const ctl = 1 - Math.min(1, Math.abs(P) * 1.4);
            const kp = (assist >= 2 ? 150 : 100) * ctl;
            const kd = (assist >= 2 ? 150 : 110) * ctl;
            const tq = clamp(-kp * (bikePitch - trajPitch + 0.03) - kd * (pRate - 0.5 * trajRate), -320, 320) * auth;
            T.addScaledVector(l, -tq);   // torque about +l is nose down
          }
        }
        // a little general body damping
        T.addScaledVector(om, -3.0);
        return;
      }
      // ---- on the ground
      // foot dab at walking pace keeps the bike up
      const dab = 1 - smoothstep(1.4, 4.2, speed);
      if (dab > 0) {
        const phi = this.lean;
        const phiT = Ln * 0.22;
        T.addScaledVector(f, (-1100 * (phi - phiT) - 260 * om.dot(f)) * dab);
        // and helps turn the bike around on the spot
        T.addScaledVector(u, (-Ln * 160 - 40 * om.dot(u)) * dab * (this.input.throttle > 0.05 ? 0.4 : 1));
      }
      // scrub: throw the bike sideways on a jump face
      const slopeAhead = -(wr.cn.x * f.x + wr.cn.z * f.z); // + = going uphill
      if (Math.abs(Ln) > 0.3 && speed > 8 && slopeAhead > 0.2 && wr.contact) {
        const s = smoothstep(0.2, 0.45, slopeAhead) * (Math.abs(Ln) - 0.3) / 0.7 * Math.sign(Ln);
        T.addScaledVector(f, 380 * s);
        T.addScaledVector(u, -180 * s);
      }
    }

    // ------------------------------------------------------------ chassis probes
    _probeStep(dt, F, T, settling) {
      const tr = this.track;
      const r = this.rider;
      const probes = this._probes || (this._probes = [
        { p: new V(0, -0.11, 0.22), r: 0.03, mu: 0.45, name: 'skid' },
        { p: new V(0, -0.09, -0.10), r: 0.03, mu: 0.45, name: 'skid' },
        { p: new V(0.25, -0.01, 0.0), r: 0.02, mu: 0.6, name: 'peg' },
        { p: new V(-0.25, -0.01, 0.0), r: 0.02, mu: 0.6, name: 'peg' },
        { p: new V(0, 0.40, -0.95), r: 0.04, mu: 0.6, name: 'fender' },
        { p: new V(0.40, 0.72, 0.36), r: 0.03, mu: 0.7, name: 'bar' },
        { p: new V(-0.40, 0.72, 0.36), r: 0.03, mu: 0.7, name: 'bar' },
      ]);
      this.probeHits = this.probeHits || {};
      const hits = this.probeHits;
      hits.bar = 0; hits.peg = 0; hits.skid = 0; hits.fender = 0; hits.nose = 0;
      for (const pr of probes) {
        const P = this.localToWorld(pr.p, _v1);
        const h = tr.height(P.x, P.z);
        const pen = h + pr.r - P.y;
        if (pen <= 0) continue;
        hits[pr.name] = Math.max(hits[pr.name], pen);
        tr.heightNormal(P.x, P.z, _hn);
        const n = _v2.set(_hn.nx, _hn.ny, _hn.nz);
        const rr = _v3.copy(P).sub(this.pos);
        const vp = _v4.crossVectors(this.omega, rr).add(this.vel);
        if (this.bikeVelOff) vp.add(this.bikeVelOff);
        const vn = vp.dot(n);
        let N = 70000 * pen * n.y - 2600 * vn;
        if (N < 0) N = 0;
        const vt = vp.addScaledVector(n, -vn);
        const vtl = vt.length();
        const Ff = _v4.copy(vt).multiplyScalar(vtl > 0.05 ? -pr.mu * N / vtl : -pr.mu * N / 0.05);
        const Fp = Ff.addScaledVector(n, N);
        F.add(Fp);
        T.add(rr.cross(Fp));
      }
      // colliders (trees, rocks, hay bales, tuff blocks) and walls
      this._colliders(dt, F, T, settling);
    }

    _colliders(dt, F, T, settling) {
      const tr = this.track;
      const pts = this._colPts || (this._colPts = [
        { p: new V(0, 0.0, 0.85), r: 0.36 }, { p: new V(0, 0.0, -0.66), r: 0.36 },
        { p: new V(0.38, 0.68, 0.43), r: 0.06 }, { p: new V(-0.38, 0.68, 0.43), r: 0.06 },
        { p: new V(0, 1.15, 0.0), r: 0.25 },
      ]);
      let maxImpact = 0;
      for (const cp of pts) {
        const P = this.localToWorld(cp.p, _v1);
        const list = tr.collidersNear(P.x, P.z);
        if (list) {
          for (const o of list) {
            let nx = 0, nz = 0, pen = 0;
            if (o.r !== undefined) {
              if (P.y > (o.y !== undefined ? o.y : -1e9) + o.h + 0.5 && o.kind !== 'tree') continue;
              const dx = P.x - o.x, dz = P.z - o.z;
              const d = Math.hypot(dx, dz);
              const rr = o.r + cp.r;
              if (d >= rr || d < 1e-6) continue;
              nx = dx / d; nz = dz / d; pen = rr - d;
            } else {
              // oriented box
              const groundY = o.y !== undefined ? o.y : tr.height(o.x, o.z);
              if (P.y - cp.r > groundY + o.h) continue;
              const c = Math.cos(o.rot), s = Math.sin(o.rot);
              const dx = P.x - o.x, dz = P.z - o.z;
              // local: box axes = (tz,-tx) side, (tx,tz) along -> we stored rot = heading
              const lx = dx * c - dz * s, lz = dx * s + dz * c;
              const ex = o.hx + cp.r, ez = o.hz + cp.r;
              if (Math.abs(lx) >= ex || Math.abs(lz) >= ez) continue;
              const px = ex - Math.abs(lx), pz = ez - Math.abs(lz);
              if (px < pz) { const sx = Math.sign(lx) || 1; nx = sx * c; nz = -sx * s; pen = px; }
              else { const sz = Math.sign(lz) || 1; nx = sz * s; nz = sz * c; pen = pz; }
            }
            const rr = _v2.copy(P).sub(this.pos);
            const vp = _v3.crossVectors(this.omega, rr).add(this.vel);
            const vn = vp.x * nx + vp.z * nz;
            if (vn < 0) maxImpact = Math.max(maxImpact, -vn);
            let Nf = 90000 * pen - 3000 * vn;
            if (Nf < 0) Nf = 0;
            const Fp = _v4.set(nx * Nf, 0, nz * Nf);
            // friction along the obstacle
            const vtx = vp.x - vn * nx, vtz = vp.z - vn * nz, vtl = Math.hypot(vtx, vtz);
            if (vtl > 0.01) { Fp.x -= 0.5 * Nf * vtx / vtl; Fp.z -= 0.5 * Nf * vtz / vtl; }
            F.add(Fp); T.add(rr.cross(Fp));
          }
        }
        // stadium / map walls
        const W = tr.walls;
        const wallPen = (v, lim, dir) => (dir > 0 ? v + cp.r - lim : lim - (v - cp.r));
        const walls = [[P.x, W.x1, 1, 1, 0], [P.x, W.x0, -1, -1, 0], [P.z, W.z1, 1, 0, 1], [P.z, W.z0, -1, 0, -1]];
        for (const [val, lim, dir, ax, az] of walls) {
          const pen = dir > 0 ? val + cp.r - lim : lim - val + cp.r;
          if (pen <= 0) continue;
          const nx = -ax, nz = -az;
          const rr = _v2.copy(P).sub(this.pos);
          const vp = _v3.crossVectors(this.omega, rr).add(this.vel);
          const vn = vp.x * nx + vp.z * nz;
          if (vn < 0) maxImpact = Math.max(maxImpact, -vn);
          let Nf = 90000 * pen - 3000 * vn;
          if (Nf < 0) Nf = 0;
          const Fp = _v4.set(nx * Nf, 0, nz * Nf);
          F.add(Fp); T.add(rr.cross(Fp));
        }
      }
      if (!settling && maxImpact > 5.5) this._triggerCrash('Hit an obstacle', maxImpact);
      else if (maxImpact > 1.5) this.events.push({ type: 'bump', strength: maxImpact });
    }

    // ------------------------------------------------------------ air
    _airStep(dt) {
      const a = this.air;
      const contact = this.wheels[0].contact || this.wheels[1].contact;
      if (contact) {
        if (a.airborne && a.time > 0.25) {
          // landing
          const n = this.wheels[1].contact ? this.wheels[1].cn : this.wheels[0].cn;
          const vn = -this.vel.dot(n);
          this.events.push({ type: 'land', strength: vn, air: a.time, height: a.maxH });
          a.lastLanding = { vn, air: a.time, t: this.time };
          this._landingCheck(vn);
        }
        a.airborne = false; a.time = 0; a.lastContactT = this.time; a.maxH = 0;
        a.groundY = this.pos.y;
      } else {
        if (this.time - a.lastContactT > 0.04) {
          if (!a.airborne) { a.airborne = true; a.takeoffY = this.pos.y; a.maxH = 0; a.time = 0; }
          a.time += dt;
          const h = this.pos.y - this.track.height(this.pos.x, this.pos.z);
          a.maxH = Math.max(a.maxH, h);
        }
      }
    }

    _landingCheck(vn) {
      if (vn > 11.5) { this._triggerCrash('Landed too hard', vn); return; }
      const speed = this.vel.length();
      if (speed > 5) {
        const vh = _v1.set(this.vel.x, 0, this.vel.z).normalize();
        const fh = _v2.set(this.f.x, 0, this.f.z).normalize();
        const ang = Math.acos(clamp(vh.dot(fh), -1, 1));
        if (ang > 0.95) this._triggerCrash('Landed sideways', speed);
      }
      if (Math.abs(this.lean) > 0.95) this._triggerCrash('Landed leaned over', speed);
    }

    _crashChecks(dt) {
      const h = this.probeHits;
      const speed = this.vel.length();
      const phi = this.lean;
      const pitchUp = Math.asin(clamp(this.f.y, -1, 1));
      // rider's head
      const r = this.rider;
      const head = this.localToWorld(_v3.set(r.x * 1.2, r.y + 0.72, r.z + 0.05), _v1);
      const hh = this.track.height(head.x, head.z);
      if (head.y - 0.13 < hh) { this._triggerCrash('Head first', speed); return; }
      if (h.bar > 0.025 && speed > 2.5) { this._triggerCrash('Dug the bars in', speed); return; }
      if (Math.abs(phi) > 1.30) { this._triggerCrash('Lowsided', speed); return; }
      if (pitchUp > 1.22) { this._triggerCrash('Looped out', speed); return; }
      if (pitchUp < -1.15) { this._triggerCrash('Went over the bars', speed); return; }
      // slammed a wheel into the ground / a face
      for (let k = 0; k < 2; k++) {
        const w = this.wheels[k];
        if (w.impact && this.time - w.impactT < 0.02) {
          const lim = k === 0 ? 9.5 : 12.5;
          if (w.impact > lim) { w.impact = 0; this._triggerCrash(k === 0 ? 'Nosed in' : 'Cased it', w.impact); return; }
          if (w.impact > lim * 0.6) this.events.push({ type: 'impact', wheel: k, strength: w.impact });
          w.impact = 0;
        }
      }
      // tip over at a standstill
      if (speed < 1.5 && Math.abs(phi) > 0.95) { this._triggerCrash('Tipped over', speed); return; }
      // violent instability (tank slapper / spin)
      const om = this.omega;
      const rollRate = Math.abs(om.dot(this.f));
      if (rollRate > 7.5 && (this.wheels[0].contact || this.wheels[1].contact)) { this._triggerCrash('Highsided', speed); return; }
      // out of the map (fell off the world)
      if (this.pos.y < -200) this._triggerCrash('Out of bounds', 0);
    }

    _triggerCrash(reason, strength) {
      if (this.crashed) return;
      this.crashed = true;
      const rider = this.rider;
      const headLocal = new V(rider.x, rider.y, rider.z + 0.05);
      const rpos = this.localToWorld(headLocal, new V());
      // rider body leaves with the bike's velocity, thrown forward a little
      const rvel = this.vel.clone().addScaledVector(this.f, Math.min(4, this.vel.length() * 0.25)).add(new V(0, 2.2 + Math.random() * 1.5, 0));
      const spin = new V((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 6).addScaledVector(this.l, -this.vel.length() * 0.6);
      this.crash = {
        reason, strength, t: 0,
        rider: { pos: rpos, vel: rvel, q: this.q.clone(), w: spin, rest: 0 },
      };
      this.engine.stalled = true; this.engine.thrEff = 0;
      this.events.push({ type: 'crash', reason, strength });
    }

    // simple tumble for bike and rider after a crash
    _crashStep(dt) {
      const tr = this.track, c = this.crash;
      c.t += dt;
      this._updateBasis();
      this._updateOmega();
      // bike: probes incl. wheels as spheres
      const F = _v5.set(0, -G * this.m * 0.6, 0);
      const T = _v6.set(0, 0, 0);
      const pts = this._crashPts || (this._crashPts = [
        new V(0, -0.02, 0.84), new V(0, -0.02, -0.66), new V(0, 0.36, 0.84), new V(0, 0.36, -0.66),
        new V(0.38, 0.68, 0.43), new V(-0.38, 0.68, 0.43), new V(0, 0.42, -0.95), new V(0, 0.5, 0),
        new V(0.22, 0.25, 0.3), new V(-0.22, 0.25, 0.3), new V(0, -0.1, 0.1),
      ]);
      const m = this.m * 0.6;
      for (const p of pts) {
        const P = this.localToWorld(p, _v1);
        const h = tr.height(P.x, P.z);
        const pen = h + 0.06 - P.y;
        if (pen <= 0) continue;
        const n = _v2.set(0, 1, 0);
        const rr = _v3.copy(P).sub(this.pos);
        const vp = _v4.crossVectors(this.omega, rr).add(this.vel);
        const vn = vp.y;
        let N = 40000 * pen - 1500 * vn;
        if (N < 0) N = 0;
        const vt = vp.setY(0);
        const vtl = vt.length();
        const Ff = vt.multiplyScalar(-0.75 * N / Math.max(vtl, 0.3));
        Ff.y += N;
        F.add(Ff); T.add(rr.cross(Ff));
      }
      F.addScaledVector(this.vel, -0.6);
      T.addScaledVector(this.omega, -6);
      this.vel.addScaledVector(F, dt / m);
      this.pos.addScaledVector(this.vel, dt);
      this.L.addScaledVector(T, dt);
      for (const w of this.wheels) { w.spin *= Math.exp(-0.8 * dt); w.contact = false; w.N = 0; w.s = Math.max(0, w.s - dt * 0.5); }
      this.engine.w = Math.max(0, this.engine.w - 200 * dt);
      this._updateOmega();
      const wl = this.omega.length();
      if (wl > 25) this._setOmega(_v1.copy(this.omega).multiplyScalar(25 / wl));
      if (wl > 1e-9) { _q1.setFromAxisAngle(_v1.copy(this.omega).normalize(), wl * dt); this.q.premultiply(_q1).normalize(); }
      this.origin.copy(this.com).negate().applyQuaternion(this.q).add(this.pos);
      // walls
      const W = tr.walls;
      this.pos.x = clamp(this.pos.x, W.x0 + 1, W.x1 - 1); this.pos.z = clamp(this.pos.z, W.z0 + 1, W.z1 - 1);
      // rider ragdoll-lite: a tumbling body that slides to a stop
      const rd = c.rider;
      rd.vel.y -= G * dt;
      rd.pos.addScaledVector(rd.vel, dt);
      const gh = tr.height(rd.pos.x, rd.pos.z) + 0.22;
      if (rd.pos.y < gh) {
        rd.pos.y = gh;
        if (rd.vel.y < 0) rd.vel.y = -rd.vel.y * 0.25;
        const k = Math.exp(-2.6 * dt);
        rd.vel.x *= k; rd.vel.z *= k;
        rd.w.multiplyScalar(Math.exp(-3.5 * dt));
        // roll along the ground in the direction of travel
        const hv = Math.hypot(rd.vel.x, rd.vel.z);
        if (hv > 0.5) rd.w.lerp(_v1.set(rd.vel.z, 0, -rd.vel.x).multiplyScalar(1 / 0.35), 0.06);
      }
      const rwl = rd.w.length();
      if (rwl > 1e-6) { _q1.setFromAxisAngle(_v1.copy(rd.w).normalize(), rwl * dt); rd.q.premultiply(_q1).normalize(); }
      rd.pos.x = clamp(rd.pos.x, W.x0 + 1, W.x1 - 1); rd.pos.z = clamp(rd.pos.z, W.z0 + 1, W.z1 - 1);
      rd.rest = rd.vel.length() < 0.6 && this.vel.length() < 0.8 ? rd.rest + dt : 0;
    }

    // ------------------------------------------------------------ outputs
    // compression travel in 0..1
    suspFraction(k) { return this.wheels[k].s / this.wp[k].travel; }
    consumeEvents() { const e = this.events.slice(); this.events.length = 0; return e; }
  }

  BikePhysics.DT = DT;
  MX.BikePhysics = BikePhysics;
});

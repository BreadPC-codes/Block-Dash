// Headless autopilot: rides each track with a simple line-following controller and
// reports crashes, lap times and where trouble happens. node tests/autopilot.mjs [trackId] [laps]
import { Vector3 } from 'three';
import { Track, generateTerrain } from '../src/track.js';
import { TRACKS } from '../src/tracks.js';
import { BikePhysics, PHYSICS_DT } from '../src/physics.js';
import { WHIP } from '../src/whip.js';

// WHIP='{"gyroScale":0}' overrides whip / air-control tuning values for an experiment
if (process.env.WHIP) Object.assign(WHIP, JSON.parse(process.env.WHIP));

const only = process.argv[2] && process.argv[2] !== 'all' ? process.argv[2] : null;
const lapsWanted = +(process.argv[3] || 2);
const assist = +(process.argv[4] ?? 2);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

for (const def of TRACKS) {
  if (only && def.id !== only) continue;
  const tr = new Track(def);
  const hf = generateTerrain(tr);
  const b = new BikePhysics(hf, null);
  b.tune.assist = assist;
  const spawn = (s) => { const p = tr.pose(s, 0); b.reset(new Vector3(p.x, 0, p.z), p.heading); };
  // START_S=<m> starts somewhere along the track (debugging one section)
  // (START_OFF=<m> shifts the usual start a little: a cheap way to see how much the
  // results depend on chance)
  spawn(process.env.START_S ? +process.env.START_S : tr.gateS - 2 + +(process.env.START_OFF || 0));
  const crashes = [];
  let hint = -1, prevS = null, dist = 0, t = 0, lapStart = null, laps = [], maxAir = 0, maxSpeed = 0, sinceAir = 9;
  const dt = PHYSICS_DT;
  const maxT = 400;
  // precompute speed limit from curvature ahead
  const vLimitAt = (s) => {
    let v = 22;
    for (let k = 0; k <= 45; k += 3) {
      const kap = Math.abs(tr.interp(tr.kappa, s + k));
      if (kap > 1e-4) {
        const B = Math.abs(tr.interp(tr.B, s + k));
        const surfMu = def.surface === 'sand' ? 0.86 : 1.05;
        const mu = surfMu * 0.72 + B * 0.12;
        const vc = Math.sqrt((mu * 9.81) / kap);
        v = Math.min(v, vc + k * 0.35);
      }
    }
    // approach speed for jumps: the track's recommended takeoff speed, or a sensible default
    const f = tr.featureAt(s + 12) || tr.featureAt(s + 4);
    if (f) {
      const target = f.spec.speed ?? ({ double: 15, table: 14.5, stepup: 14, rhythm: 11, whoops: 13, rollers: 11, stepdown: 12, hill: 18 }[f.type] || 14);
      v = f.spec.speed != null ? target : Math.min(v, target);
    }
    if (tr.open && !f) {
      // straight line: build speed for the next jump
      for (let k = 12; k <= 70; k += 4) {
        const g = tr.featureAt(s + k);
        if (g && g.spec.speed != null) { v = g.spec.speed; break; }
      }
    }
    return v;
  };
  while (t < maxT && laps.length < lapsWanted) {
    const pr = tr.project(b.pos.x, b.pos.z, hint);
    hint = pr.index;
    if (prevS != null) {
      let d = pr.s - prevS;
      if (d < -tr.length / 2) {
        // crossed s=0 forwards
        d += tr.length;
      }
      if (d > tr.length / 2) d -= tr.length;
      dist += d;
      const relPrev = (prevS - tr.finishS + tr.length) % tr.length, rel = (pr.s - tr.finishS + tr.length) % tr.length;
      if (!tr.open && rel < relPrev - tr.length / 2 && dist > tr.length * 0.9) {
        if (lapStart != null) laps.push(t - lapStart);
        lapStart = t;
        dist = 0;
      }
    }
    if (tr.open) {
      // point to point: a run from the gate to the finish line, then back to the start
      if (lapStart == null && pr.s >= tr.startS) lapStart = t;
      if (pr.s >= tr.finishS) {
        if (lapStart != null) laps.push(t - lapStart);
        lapStart = null;
        spawn(tr.gateS - 2);
        hint = -1;
        prevS = null;
        continue;
      }
    }
    prevS = pr.s;
    const speed = b.forwardSpeed;
    maxSpeed = Math.max(maxSpeed, speed);
    if (b.airborne) maxAir = Math.max(maxAir, b.airTime);
    // steering: pure pursuit on centerline
    const look = 4 + Math.abs(speed) * 0.45;
    const tp = tr.pose(pr.s + look, 0);
    const desired = Math.atan2(tp.x - b.pos.x, tp.z - b.pos.z);
    const heading = Math.atan2(b.fwd.x, b.fwd.z);
    let err = desired - heading;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    // positive steer = right turn = heading decreasing (rotation about -Y)
    // hold the line: aim back toward the centerline when drifting wide
    let steer = clamp(-err * 1.8 + b.angVel.y * 0.25 + clamp(pr.d, -3, 3) * -0.08 * Math.sign(1), -1, 1);
    if (b.airborne) steer = 0;
    // keep the bars straight on a jump face (steering there sends the bike off the lip rolling)
    const onFace = tr.interp(tr.F, pr.s) > 0.25 && tr.interp(tr.F, pr.s + 1) > tr.interp(tr.F, pr.s);
    if (onFace && Math.abs(pr.d) < 3) steer = 0;
    const vt = vLimitAt(pr.s);
    let throttle = 0, brakeF = 0, brakeR = 0;
    const ev = vt - speed;
    if (ev > 0) throttle = clamp(0.3 + ev * (tr.open ? 0.9 : 0.5), 0, 1);
    else { brakeF = clamp(-ev * (tr.open ? 0.45 : 0.25), 0, 0.8); brakeR = clamp(-ev * (tr.open ? 0.35 : 0.2), 0, 0.6); throttle = 0.05; }
    // a jump with a speed hint: that is a takeoff speed checked by tests/jump-tuner.mjs, which
    // holds it all the way to the lip - so hold it up the face the same way, never brake there
    // (the defaults above for jumps without one already allow for the speed lost on the face)
    const fNow = tr.featureAt(pr.s);
    if (fNow && fNow.spec.speed != null && fNow.lips.length && pr.s < fNow.lips[0] && !b.airborne) {
      throttle = clamp(0.65 + ev * 0.9, 0, 1);
      brakeF = 0;
      brakeR = 0;
    }
    if (b.airborne) { throttle = 0.3; brakeF = 0; brakeR = 0; sinceAir = 0; } else sinceAir += dt;
    if (!b.front.contact) brakeF = 0;
    // like a rider: no braking on a landing ramp or right after touching down
    const descending = tr.interp(tr.F, pr.s) > 0.2 && tr.interp(tr.F, pr.s + 1) < tr.interp(tr.F, pr.s);
    if (tr.open && (descending || sinceAir < 0.6)) { brakeF = 0; brakeR = Math.min(brakeR, 0.15); }
    if (tr.open && (!b.front.contact || !b.rear.contact) && !b.airborne && Math.abs(pr.d) < 3) steer = 0;
    b.step(dt, { throttle, brakeF, brakeR, steer, lean: 0 });
    t += dt;
    if (process.env.LOG_FROM && t >= +process.env.LOG_FROM && t <= +process.env.LOG_TO && Math.round(t / dt) % 6 === 0) {
      const D = (r) => (r * 57.3).toFixed(0);
      console.log(`t=${t.toFixed(2)} s=${pr.s.toFixed(1)} d=${pr.d.toFixed(2)} v=${b.forwardSpeed.toFixed(1)} vt=${vt.toFixed(1)} thr=${throttle.toFixed(2)} bF=${brakeF.toFixed(2)} bR=${brakeR.toFixed(2)} st=${steer.toFixed(2)} lean=${D(b.leanAngle)} tgt=${D(b.leanTarget)} delta=${D(b.steerAngle)} yaw=${b.angVel.y.toFixed(2)} fS=${b.front.slip.toFixed(2)} rS=${b.rear.slip.toFixed(2)} fN=${b.front.load.toFixed(0)}/${b.front.loadF.toFixed(0)} rN=${b.rear.load.toFixed(0)}/${b.rear.loadF.toFixed(0)} rA=${D(b.rear.slipAngle)} fA=${D(b.front.slipAngle)} tau=${(b.dbgTau||0).toFixed(0)}/${(b.dbgCap||0).toFixed(0)} fy=${b.front.fy.toFixed(0)}/${b.rear.fy.toFixed(0)} pitch=${D(b.pitchAngle)} ${b.crashed ? 'CRASH ' + b.crashReason : ''}`);
    }
    if (b.crashed) {
      const f = tr.featureAt(pr.s);
      crashes.push({ t: t.toFixed(1), s: pr.s.toFixed(0), reason: b.crashReason, speed: (b.speed * 3.6).toFixed(0), feature: f ? f.type : (Math.abs(tr.interp(tr.kappa, pr.s)) > 0.01 ? 'corner' : 'straight'), d: pr.d.toFixed(1) });
      spawn(tr.safeRespawnS(pr.s));
      hint = -1;
      prevS = null;
      dist -= 30;
      if (crashes.length > 25) break;
    }
  }
  console.log(`\n== ${def.name} (assist ${assist}): sim ${t.toFixed(0)} s, laps ${laps.map((l) => l.toFixed(1)).join(', ') || '-'}, crashes ${crashes.length}, max speed ${(maxSpeed * 3.6).toFixed(0)} km/h, max air ${maxAir.toFixed(2)} s`);
  for (const c of crashes) console.log(`   crash t=${c.t} s=${c.s} (${c.feature}, d=${c.d}) at ${c.speed} km/h: ${c.reason}`);
}

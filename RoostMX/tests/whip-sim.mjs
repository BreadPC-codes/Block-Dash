// Whip / air-control physics on a big double with the real bike physics.
//   node tests/whip-sim.mjs [--trace]
// Prints each case and checks the behaviour: no input = no whip, small inputs subtle and
// big ones dramatic, symmetric, momentum after the input is released, bounded angular
// acceleration (no snapping), recovery before touchdown, a whip held into the landing
// crashes, W / S and the left stick pitch the bike.
import { Vector3 } from 'three';
import { BikePhysics, PHYSICS_DT } from '../src/physics.js';
import { FunctionTerrain } from '../src/heightfield.js';
import { buildFeature } from '../src/track.js';

const dt = PHYSICS_DT;
const deg = (r) => (r * 180) / Math.PI;
const SPEC = { type: 'double', h1: 3.0, face: 28, gap: 24, h2: 2.8, land: 18 };

/**
 * Ride the double at v m/s. Inputs are functions of the time since takeoff (tAir, -1 on
 * the jump face): steer(tAir, onFace), and optionally lean, side, throttle, brake.
 */
export function whipRun(steerFn, { assist = 2, v = 18, trace = false, side = null, lean = null, throttle = null, brake = null, airControl = 1 } = {}) {
  const f = buildFeature(SPEC);
  const lip = f.lips[0];
  const terr = new FunctionTerrain((x, z) => (z > 0 && z < f.length ? f.height(z) : 0));
  const b = new BikePhysics(terr);
  b.tune.assist = assist;
  b.tune.airControl = airControl;
  b.reset(new Vector3(0, 0, -160), 0);
  let t = 0, tAir = -1, landed = false, peak = 0, peakT = 0, landWhip = null, landRoll = null;
  let maxAcc = 0, prevRate = null, maxRoll = 0, maxPitch = -9, minPitch = 9, pitchAt = null, whipAt = null;
  const rows = [];
  while (t < 30 && !b.crashed && b.pos.z < f.length + 40) {
    const z = b.pos.z;
    const air = b.airborne && z > lip - 1;
    if (air && tAir < 0) tAir = 0;
    const onFace = !b.airborne && z > 0 && z < lip;
    const inAir = tAir >= 0 && !landed;
    const steer = inAir ? steerFn(tAir, false) : onFace ? steerFn(-1, true) : 0;
    let thr = tAir < 0 ? Math.min(1, Math.max(0, (v - b.forwardSpeed) * 0.9 + (z > 0 ? 0.65 : 0.3))) : 0.3;
    if (inAir && throttle) thr = throttle(tAir);
    const brk = inAir && brake ? brake(tAir) : 0;
    b.step(dt, { throttle: thr, brakeF: 0, brakeR: brk, steer: tAir < 0 && !onFace ? 0 : steer, lean: inAir && lean ? lean(tAir) : 0, side: inAir && side ? side(tAir) : 0 });
    t += dt;
    if (inAir) {
      tAir += dt;
      const wa = b.whip.whipAngle;
      if (Math.abs(wa) > Math.abs(peak)) { peak = wa; peakT = tAir; }
      maxRoll = Math.max(maxRoll, Math.abs(b.leanAngle));
      if (b.airborne) { maxPitch = Math.max(maxPitch, b.pitchAngle); minPitch = Math.min(minPitch, b.pitchAngle); }
      if (pitchAt == null && tAir >= 0.7) pitchAt = b.pitchAngle;
      if (whipAt == null && tAir >= 1.3) whipAt = b.whip.whipAngle;
      const rate = b.whip.whipRate;
      // angular acceleration in the air (from the second airborne step on)
      if (prevRate != null && b.airborne) maxAcc = Math.max(maxAcc, Math.abs(rate - prevRate) / dt);
      prevRate = rate;
      if (trace && Math.round(tAir / dt) % 24 === 0) rows.push(`t=${tAir.toFixed(2)} in=${steer.toFixed(2)} eff=${b.whip.whipEffort.toFixed(2)} whip=${deg(wa).toFixed(1)} rate=${deg(rate).toFixed(0)}/s roll=${deg(b.leanAngle).toFixed(1)} pitch=${deg(b.pitchAngle).toFixed(1)} Tyaw=${b.whip.torque.yaw.toFixed(0)} Troll=${b.whip.torque.roll.toFixed(0)} gyro=${b.whip.torque.gyro.toFixed(0)} rec=${b.whip.recovery.toFixed(2)} land=${b.whip.landIn.toFixed(2)} twist=${deg(b.whip.riderTwist).toFixed(0)} bars=${deg(b.steerAngle).toFixed(0)}`);
      if (tAir > 0.3 && !b.airborne) { landed = true; landWhip = b.whip.whipAngle; landRoll = b.leanAngle; }
    }
  }
  return {
    crashed: b.crashed ? b.crashReason : '', peak: deg(peak), peakT, air: tAir, maxAcc: deg(maxAcc), maxRoll: deg(maxRoll),
    landWhip: landWhip == null ? null : deg(landWhip), landRoll: landRoll == null ? null : deg(landRoll),
    maxPitch: deg(maxPitch), minPitch: deg(minPitch), pitchAt: deg(pitchAt ?? 0), whipAt: deg(whipAt ?? 0), rows,
  };
}

/**
 * Front / back flip on the double: hold rider lean (dir -1 = back, +1 = forward) until the
 * bike has turned `releaseAt` degrees, then let go. Returns the total rotation, the largest
 * whip reading and yaw rate while flipping, and the outcome.
 */
export function flipRun(dir, releaseAt, { assist = 2, v = 18, spec = SPEC } = {}) {
  const f = buildFeature(spec);
  const lip = f.lips[0];
  const terr = new FunctionTerrain((x, z) => (z > 0 && z < f.length ? f.height(z) : 0));
  const b = new BikePhysics(terr);
  b.tune.assist = assist;
  b.reset(new Vector3(0, 0, -160), 0);
  let t = 0, tAir = -1, rot = 0, landed = false, released = false, maxWhip = 0, maxYaw = 0;
  while (t < 30 && !b.crashed && b.pos.z < f.length + 40) {
    const z = b.pos.z;
    if (b.airborne && z > lip - 1 && tAir < 0) tAir = 0;
    const inAir = tAir >= 0 && !landed;
    const thr = tAir < 0 ? Math.min(1, Math.max(0, (v - b.forwardSpeed) * 0.9 + (z > 0 ? 0.65 : 0.3))) : 0.3;
    if (inAir && !released && deg(Math.abs(rot)) > releaseAt) released = true;
    b.step(dt, { throttle: thr, brakeF: 0, brakeR: 0, steer: 0, lean: inAir && !released ? dir : 0, side: 0 });
    t += dt;
    if (inAir) {
      tAir += dt;
      rot += b.angVel.dot(b.right) * dt;
      if (b.airborne) {
        maxWhip = Math.max(maxWhip, Math.abs(b.whip.whipAngle));
        maxYaw = Math.max(maxYaw, Math.abs(b.angVel.y));
      }
      if (tAir > 0.3 && !b.airborne) landed = true;
    }
  }
  return { rot: deg(rot), crashed: b.crashed ? b.crashReason : '', maxWhip: deg(maxWhip), maxYaw: deg(maxYaw), air: tAir };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  let fails = 0;
  const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
  const hold = (amount, until, dir = 1) => (t) => (t >= 0 && t < until ? amount * dir : 0);
  const line = (name, r) => console.log(`${name.padEnd(46)} peak ${r.peak.toFixed(1).padStart(6)} deg at ${r.peakT.toFixed(2)} s | max roll ${r.maxRoll.toFixed(0)} deg | at touchdown whip ${r.landWhip == null ? '-' : r.landWhip.toFixed(1)} roll ${r.landRoll == null ? '-' : r.landRoll.toFixed(1)} | air ${r.air.toFixed(2)} s | max yaw accel ${r.maxAcc.toFixed(0)} deg/s2 | ${r.crashed || 'rode away'}`);
  const trace = process.argv.includes('--trace');
  const R = {};
  for (const [key, name, fn] of [
    ['none', 'no input', () => 0],
    ['small', 'small right 0.25 for 0.6 s', hold(0.25, 0.6)],
    ['half', 'half right 0.5 for 0.6 s', hold(0.5, 0.6)],
    ['full', 'full right for 0.45 s', hold(1, 0.45)],
    ['left', 'full left for 0.45 s', hold(1, 0.45, -1)],
    ['long', 'full right for 0.8 s', hold(1, 0.8)],
    ['face', 'full right from the face, release at 0.35 s', (t, face) => (face ? 1 : t < 0.35 ? 1 : 0)],
    ['held', 'full right held to landing', () => 1],
  ]) {
    R[key] = whipRun(fn, { trace: trace && key === 'full' });
    line(name, R[key]);
    if (R[key].rows.length) console.log(R[key].rows.join('\n'));
  }
  // assists: low still straightens the bike; off leaves it to the rider (counter-whip)
  const a1 = whipRun(hold(1, 0.45), { assist: 1 });
  // (without the pitch assist the rider also has to keep the nose down)
  const noseDown = (t) => (t > 0.05 && t < 0.8 ? 0.6 : 0);
  const a0 = whipRun(hold(1, 0.45), { assist: 0, lean: noseDown });
  const a0c = whipRun((t) => (t < 0 ? 0 : t < 0.45 ? 1 : t > 0.6 && t < 1.0 ? -1 : 0), { assist: 0, lean: noseDown });
  line('assist low', a1);
  line('assist off', a0);
  line('assist off, counter-whip at 0.6-1.0 s', a0c);
  const lowAir = whipRun(hold(1, 0.45), { airControl: 0.6 });
  line('Air control 60 %', lowAir);
  // pitch: W (throttle) lifts the nose, S (rear brake) drops it, left stick fore / aft
  const base = R.none;
  const gas = whipRun(() => 0, { throttle: (t) => (t < 0.5 ? 1 : 0.3) });
  const brk = whipRun(() => 0, { brake: (t) => (t < 0.5 ? 1 : 0) });
  const back = whipRun(() => 0, { lean: (t) => (t < 0.5 ? -1 : 0) });
  const fwd = whipRun(() => 0, { lean: (t) => (t < 0.5 ? 1 : 0) });
  console.log(`pitch 0.7 s after takeoff (deg): none ${base.pitchAt.toFixed(1)}, W ${gas.pitchAt.toFixed(1)}, S ${brk.pitchAt.toFixed(1)}, stick back ${back.pitchAt.toFixed(1)}, stick forward ${fwd.pitchAt.toFixed(1)}`);

  console.log('checks');
  ok(Math.abs(R.none.peak) < 1 && !R.none.crashed, 'no input: no whip, clean landing');
  ok(R.small.peak > 3 && R.small.peak < 14, `small input = subtle whip (${R.small.peak.toFixed(1)} deg)`);
  ok(R.small.peak < R.half.peak && R.half.peak < R.full.peak && R.full.peak < R.long.peak, 'bigger / longer input = bigger whip');
  ok(R.full.peak > 30, `full input = dramatic whip (${R.full.peak.toFixed(1)} deg; 0.8 s: ${R.long.peak.toFixed(1)} deg)`);
  ok(Math.abs(R.full.peak + R.left.peak) < 1, 'left and right are symmetric');
  ok(R.full.peakT > 0.45 + 0.2, `momentum: the bike keeps rotating after the input is released (peak ${(R.full.peakT - 0.45).toFixed(2)} s after release)`);
  ok(R.full.maxAcc < 1200 && R.long.maxAcc < 1500, `no snapping: angular acceleration in the air stays bounded (${R.full.maxAcc.toFixed(0)} / ${R.long.maxAcc.toFixed(0)} deg/s2)`);
  ok(Math.abs(R.long.peak) < 95 && Math.abs(R.held.peak) < 100, `soft limits: no spinning round (held: ${R.held.peak.toFixed(1)} deg)`);
  for (const k of ['small', 'half', 'full', 'left', 'long', 'face']) {
    ok(!R[k].crashed && Math.abs(R[k].landWhip) < 12, `${k}: straightened before touchdown (${R[k].landWhip == null ? '-' : R[k].landWhip.toFixed(1)} deg) and rode away`);
  }
  ok(!!R.held.crashed, `a whip held into the landing crashes (${R.held.crashed})`);
  ok(!a1.crashed && Math.abs(a1.landWhip) < 12, `assist low: still straightened before touchdown (${a1.landWhip == null ? '-' : a1.landWhip.toFixed(1)} deg)`);
  ok(Math.abs(a0.landWhip) > Math.abs(a1.landWhip) && Math.abs(a1.landWhip) > Math.abs(R.full.landWhip), `less assist = less automatic straightening (touchdown ${a0.landWhip.toFixed(1)} / ${a1.landWhip.toFixed(1)} / ${R.full.landWhip.toFixed(1)} deg with assists off / low / full)`);
  ok(Math.abs(a0.peak) < Math.abs(R.full.peak) * 1.4, `the same input gives a similar whip on every assist level (${a0.peak.toFixed(1)} / ${a1.peak.toFixed(1)} / ${R.full.peak.toFixed(1)} deg)`);
  ok(a0c.whipAt < a0.whipAt - 15 && Math.abs(a0c.landWhip) < Math.abs(a0.landWhip) - 10, `assist off: a counter-whip brings the bike back (1.3 s after takeoff ${a0c.whipAt.toFixed(1)} vs ${a0.whipAt.toFixed(1)} deg, touchdown ${a0c.landWhip.toFixed(1)} vs ${a0.landWhip.toFixed(1)} deg)`);
  ok(Math.abs(lowAir.peak) < Math.abs(R.full.peak) * 0.8, `Air control setting scales the whip (${lowAir.peak.toFixed(1)} deg at 60 %)`);
  ok(gas.pitchAt > base.pitchAt + 4 && brk.pitchAt < base.pitchAt - 4, 'W lifts the nose, S drops it');
  ok(back.pitchAt > base.pitchAt + 4 && fwd.pitchAt < base.pitchAt - 4, 'left stick back lifts the nose, forward drops it');
  console.log('flips');
  const BIG = { type: 'double', h1: 4.2, face: 30, gap: 38, h2: 4, land: 18 };
  const fl = [];
  for (const [name, dir, spec, v] of [['back flip, 1.9 s jump', -1, SPEC, 18], ['front flip, 1.9 s jump', 1, SPEC, 18], ['back flip, 2.5 s jump', -1, BIG, 23], ['front flip, 2.5 s jump', 1, BIG, 23]]) {
    for (const rel of [200, 240, 280]) {
      const r = flipRun(dir, rel, { spec, v });
      fl.push(r);
      console.log(`  ${name}, let go after ${rel} deg: turned ${r.rot.toFixed(0)} deg, whip reading <= ${r.maxWhip.toFixed(1)} deg, yaw rate <= ${r.maxYaw.toFixed(0)} deg/s, ${r.crashed || 'landed'}`);
    }
  }
  // (one full turn, give or take the takeoff and landing angles: it leaves the lip nose-up and
  // lands on the down-ramp)
  ok(fl.every((r) => !r.crashed && Math.abs(r.rot) > 280 && Math.abs(r.rot) < 470), 'front and back flips: hold rider lean back / forward, let go once it is round - one flip, lands (the rider brings it round)');
  ok(fl.every((r) => r.maxWhip < 10 && r.maxYaw < 60), 'a flip is not mistaken for a whip (no yaw spin, no sideways twist)');
  const held = flipRun(-1, 9999);
  ok(Math.abs(held.rot) > 365, `holding lean back for the whole jump keeps it turning past a full flip (${held.rot.toFixed(0)} deg)`);
  console.log(fails ? `${fails} FAILURES` : 'WHIP PHYSICS OK');
  process.exitCode = fails ? 1 : 0;
}

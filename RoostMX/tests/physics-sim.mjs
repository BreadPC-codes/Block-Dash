// Headless physics checks: node tests/physics-sim.mjs
import { Vector3 } from 'three';
import { BikePhysics, PHYSICS_DT } from '../src/physics.js';
import { FunctionTerrain } from '../src/heightfield.js';

const flat = new FunctionTerrain(() => 0);
const dt = PHYSICS_DT;
const deg = (r) => (r * 180 / Math.PI).toFixed(1);
let failures = 0;
const check = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failures++; };

function run(bike, seconds, inputFn, log) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    bike.step(dt, inputFn(t, bike));
    if (log && i % Math.round(log / dt) === 0) {
      const b = bike;
      console.log(`   t=${t.toFixed(2)} v=${(b.forwardSpeed * 3.6).toFixed(1)}km/h g${b.engine.gear} rpm=${b.engine.rpm.toFixed(0)} lean=${deg(b.leanAngle)} pitch=${deg(b.pitchAngle)} cF=${b.front.compression.toFixed(3)} cR=${b.rear.compression.toFixed(3)} slipR=${b.rear.slipRatio.toFixed(2)} air=${b.airborne ? 'Y' : 'n'} y=${b.pos.y.toFixed(2)}${b.crashed ? ' CRASH:' + b.crashReason : ''}`);
    }
  }
}
const I = (o = {}) => ({ throttle: 0, brakeF: 0, brakeR: 0, steer: 0, lean: 0, side: 0, ...o });

console.log('1) settle on flat ground');
{
  const b = new BikePhysics(flat);
  b.reset(new Vector3(0, 0, 0), 0);
  run(b, 3, () => I(), 1);
  check(!b.crashed, 'no crash at rest');
  check(Math.abs(b.front.compression - 0.075) < 0.03 && Math.abs(b.rear.compression - 0.1) < 0.03, `sag front ${b.front.compression.toFixed(3)} rear ${b.rear.compression.toFixed(3)}`);
  check(b.speed < 0.05, `at rest speed ${b.speed.toFixed(3)}`);
  check(Math.abs(b.leanAngle) < 0.02, `upright lean ${deg(b.leanAngle)}`);
}

console.log('2) full throttle on flat (assist full)');
{
  const b = new BikePhysics(flat);
  b.reset(new Vector3(0, 0, 0), 0);
  let maxWheelie = 0, t100 = null;
  run(b, 12, (t, bk) => { maxWheelie = Math.max(maxWheelie, bk.wheelieAngle); if (t100 == null && bk.forwardSpeed * 3.6 >= 100) t100 = t; return I({ throttle: 1 }); }, 1);
  check(!b.crashed, 'no crash');
  check(b.forwardSpeed * 3.6 > 105, `top speed ${(b.forwardSpeed * 3.6).toFixed(1)} km/h`);
  check(t100 != null && t100 < 7, `0-100 km/h in ${t100 && t100.toFixed(2)} s`);
  check(maxWheelie < 0.7, `max wheelie ${deg(maxWheelie)} deg`);
  check(Math.abs(b.pos.x) < 3, `went straight (x drift ${b.pos.x.toFixed(2)})`);
}

console.log('3) braking from ~70 km/h');
{
  const b = new BikePhysics(flat);
  b.reset(new Vector3(0, 0, 0), 0);
  run(b, 5, () => I({ throttle: 1 }));
  const v0 = b.forwardSpeed, z0 = b.pos.z;
  let tStop = 0;
  run(b, 6, (t, bk) => { if (bk.forwardSpeed > 0.3) tStop = t; return I({ brakeF: 1, brakeR: 0.6 }); }, 0.5);
  const dist = b.pos.z - z0;
  check(!b.crashed, 'no crash under hard braking straight');
  console.log(`   from ${(v0 * 3.6).toFixed(1)} km/h: stopped in ${dist.toFixed(1)} m, ${tStop.toFixed(2)} s, decel ${(v0 / tStop / 9.81).toFixed(2)} g`);
  check(v0 / tStop > 5.5, 'decel > 0.55 g');
}

console.log('4) cornering at ~45 km/h, full right steer');
{
  const b = new BikePhysics(flat);
  b.reset(new Vector3(0, 0, 0), 0);
  run(b, 3.5, (t, bk) => I({ throttle: bk.forwardSpeed < 12.5 ? 1 : 0.35 }));
  const v = b.forwardSpeed;
  let minR = 1e9, maxLean = 0;
  run(b, 4, (t, bk) => {
    const yawRate = Math.abs(bk.angVel.y);
    if (t > 1.5 && yawRate > 0.05) minR = Math.min(minR, bk.speed / yawRate);
    maxLean = Math.max(maxLean, Math.abs(bk.leanAngle));
    return I({ steer: 1, throttle: 0.45 });
  }, 0.5);
  check(!b.crashed, 'no crash in steady turn' + (b.crashed ? ' (' + b.crashReason + ')' : ''));
  console.log(`   entry ${(v * 3.6).toFixed(1)} km/h radius ${minR.toFixed(1)} m, max lean ${deg(maxLean)}`);
  check(minR < 65 && minR > 4, "turn radius plausible");
}

console.log('5) slow speed tight turn');
{
  const b = new BikePhysics(flat);
  b.reset(new Vector3(0, 0, 0), 0);
  run(b, 1.2, () => I({ throttle: 0.5 }));
  run(b, 4, () => I({ steer: -1, throttle: 0.15 }), 1);
  check(!b.crashed, 'no crash in slow tight turn' + (b.crashed ? ' (' + b.crashReason + ')' : ''));
}

console.log('6) tabletop jump');
{
  // takeoff face 2 m high at z=40..45.6, flat top 10m, landing ramp
  const prof = (z) => {
    const h = 2, m = Math.tan(27 * Math.PI / 180), L = 1.5 * h / m, Lt = h / m;
    const z0 = 40;
    let u = z - z0;
    if (u <= 0) return 0;
    if (u < L) return u < Lt ? m * u * u / (2 * Lt) : m * Lt / 2 + m * (u - Lt);
    u -= L;
    if (u < 10) return h;
    u -= 10;
    const Ll = Math.PI * h / (2 * Math.tan(21 * Math.PI / 180));
    if (u < Ll) return h * 0.5 * (1 + Math.cos(Math.PI * u / Ll));
    return 0;
  };
  const ramp = new FunctionTerrain((x, z) => prof(z));
  for (const target of [11, 14, 16]) {
    const b = new BikePhysics(ramp);
    b.reset(new Vector3(0, 0, -30), 0);
    let maxAir = 0, landed = false;
    run(b, 9, (t, bk) => {
      if (bk.airborne) maxAir = Math.max(maxAir, bk.airTime);
      const thr = bk.pos.z < 39 ? Math.min(1, Math.max(0, (target - bk.forwardSpeed) * 0.8 + 0.25)) : 0.35;
      return I({ throttle: thr });
    });
    check(!b.crashed, `speed ${target} m/s: air ${maxAir.toFixed(2)} s, end z=${b.pos.z.toFixed(1)}` + (b.crashed ? ' CRASH ' + b.crashReason : ''));
  }
}

console.log('7) whip held through landing should crash');
{
  const prof = (z) => { const u = z - 40; if (u <= 0) return 0; if (u < 6) return u * 0.5; if (u < 7) return 3 - (u - 6) * 3; return 0; };
  const ramp = new FunctionTerrain((x, z) => Math.max(0, prof(z)));
  const b = new BikePhysics(ramp);
  b.reset(new Vector3(0, 0, -30), 0);
  run(b, 8, (t, bk) => I({ throttle: bk.pos.z < 40 ? (bk.forwardSpeed < 16 ? 1 : 0.4) : 0.3, steer: bk.pos.z > 46 ? 1 : 0 }));
  check(b.crashed, 'crashed: ' + b.crashReason);
}

console.log('8) lowside from over-leaning on grass at speed (assist off)');
{
  const grass = new FunctionTerrain(() => 0, () => 1);
  const b = new BikePhysics(grass);
  b.tune.assist = 0;
  b.reset(new Vector3(0, 0, 0), 0);
  run(b, 4, (t, bk) => I({ throttle: bk.forwardSpeed < 17 ? 1 : 0.4 }));
  run(b, 3, () => I({ steer: 1, throttle: 1 }));
  console.log('   crashed:', b.crashed, b.crashReason);
}

console.log('9) rider lean right while riding straight (no steering)');
{
  const b = new BikePhysics(flat);
  b.reset(new Vector3(0, 0, 0), 0);
  run(b, 3, (t, bk) => I({ throttle: bk.forwardSpeed < 11 ? 1 : 0.4 }));
  const x0 = b.pos.x;
  run(b, 3, (t, bk) => I({ throttle: bk.forwardSpeed < 11 ? 0.8 : 0.4, side: 1 }), 0.5);
  check(!b.crashed, 'no crash' + (b.crashed ? ' (' + b.crashReason + ')' : ''));
  check(b.riderSide > 0.9, `rider body moved right (riderSide ${b.riderSide.toFixed(2)})`);
  check(b.comLean > 0.1, `combined CoM shifted right of the bike (${deg(b.comLean)} deg)`);
  check(b.leanAngle < -0.08 && Math.abs(b.leanAngle + b.comLean) < 0.05, `bike leans the other way so the CoM stays over the wheels (bike ${deg(b.leanAngle)}, CoM ${deg(b.leanAngle + b.comLean)})`);
  check(Math.abs(b.pos.x - x0) < 2.5, `body lean alone does not steer (x ${x0.toFixed(1)} -> ${b.pos.x.toFixed(1)})`);
}

console.log('10) counter-leaning vs neutral vs hanging off in the same turn');
{
  const turn = (side, steer, vT) => {
    const b = new BikePhysics(flat);
    b.reset(new Vector3(0, 0, 0), 0);
    const ctl = (bk) => Math.min(1, Math.max(0, (vT - bk.forwardSpeed) * 0.9 + 0.3));
    run(b, 4, (t, bk) => I({ throttle: ctl(bk) }));
    let lean = 0, yr = 0, v = 0, n = 0;
    run(b, 5, (t, bk) => {
      if (t > 2.5) { lean += bk.leanAngle; yr += Math.abs(bk.angVel.y); v += bk.speed; n++; }
      return I({ steer, side, throttle: ctl(bk) });
    });
    return { b, lean: lean / n, R: v / n / Math.max(1e-3, yr / n) };
  };
  for (const [steer, vT] of [[1, 6], [1, 12], [0.6, 12]]) {
    const c = turn(-1, steer, vT), n0 = turn(0, steer, vT), h = turn(1, steer, vT);
    console.log(`   steer ${steer} @ ${vT} m/s: radius counter ${c.R.toFixed(1)} m / neutral ${n0.R.toFixed(1)} m / hang-off ${h.R.toFixed(1)} m; bike lean ${deg(c.lean)} / ${deg(n0.lean)} / ${deg(h.lean)} deg`);
    check(!c.b.crashed && !n0.b.crashed && !h.b.crashed, '  no crash in any of them');
    check(c.R < n0.R * 0.88, `  counter-leaning turns tighter (${((1 - c.R / n0.R) * 100).toFixed(0)} % smaller radius)`);
    check(c.lean > n0.lean + 0.05 && n0.lean > h.lean + 0.05, '  the bike leans furthest under a counter-leaning rider, least when hanging off');
    check(h.R > n0.R * 0.97, '  leaning into the turn is no shortcut');
  }
}

console.log('11) rider lean in the air rolls the bike');
{
  const prof = (z) => { const u = z - 40; if (u <= 0) return 0; if (u < 6) return u * 0.5; if (u < 7) return 3 - (u - 6) * 3; return 0; };
  const ramp = new FunctionTerrain((x, z) => Math.max(0, prof(z)));
  const fly = (side) => {
    const b = new BikePhysics(ramp);
    b.reset(new Vector3(0, 0, -30), 0);
    let maxRoll = 0, airT = 0;
    run(b, 6, (t, bk) => {
      if (bk.airborne) { airT += dt; maxRoll = Math.max(maxRoll, bk.leanAngle * Math.sign(side || 1)); }
      const s = bk.airborne && airT < 0.35 ? side : 0;
      return I({ throttle: bk.pos.z < 40 ? (bk.forwardSpeed < 16 ? 1 : 0.4) : 0.3, side: s });
    });
    return maxRoll;
  };
  const r0 = fly(0), rR = fly(1), rL = fly(-1);
  console.log(`   max roll in the air: none ${deg(r0)}, right ${deg(rR)}, left ${deg(rL)} deg`);
  check(rR > 0.12 && rL > 0.12 && r0 < 0.06, 'leaning the rider tilts the bike that way in the air');
}

console.log('12) grip: hard cornering and acceleration without sliding');
{
  const b = new BikePhysics(flat);
  b.reset(new Vector3(0, 0, 0), 0);
  const ctl = (bk) => Math.min(1, Math.max(0, (12 - bk.forwardSpeed) * 0.9 + 0.3));
  run(b, 4, (t, bk) => I({ throttle: ctl(bk) }));
  let ay = 0, n = 0, maxSlipF = 0, maxSlipR = 0;
  run(b, 5, (t, bk) => {
    if (t > 2.5) { ay += bk.speed * Math.abs(bk.angVel.y); n++; maxSlipF = Math.max(maxSlipF, bk.front.slip); maxSlipR = Math.max(maxSlipR, bk.rear.slip); }
    return I({ steer: 1, throttle: ctl(bk) });
  });
  ay /= n * 9.81;
  check(!b.crashed && ay > 1.1, `steady full-lean turn at 43 km/h pulls ${ay.toFixed(2)} g on dirt`);
  check(maxSlipF < 0.8 && maxSlipR < 0.8, `tyres stay below their grip peak (slip front ${maxSlipF.toFixed(2)}, rear ${maxSlipR.toFixed(2)})`);
  // full throttle out of the turn: traction, not wheelspin
  let maxSpin = 0;
  run(b, 2, (t, bk) => { maxSpin = Math.max(maxSpin, bk.rear.slipRatio); return I({ steer: t < 0.6 ? 0.5 : 0, throttle: 1 }); });
  check(!b.crashed && maxSpin < 0.35, `full throttle on exit: rear slip ratio peaks at ${maxSpin.toFixed(2)}`);
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL OK');

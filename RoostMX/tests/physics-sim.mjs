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
  let comLeanMax = 0;
  run(b, 3, (t, bk) => { comLeanMax = Math.max(comLeanMax, bk.leanAngle + bk.comLean); return I({ throttle: bk.forwardSpeed < 11 ? 0.8 : 0.4, side: 1 }); }, 0.5);
  check(!b.crashed, 'no crash' + (b.crashed ? ' (' + b.crashReason + ')' : ''));
  check(b.riderSide > 0.9, `rider body moved right (riderSide ${b.riderSide.toFixed(2)})`);
  check(b.comLean > 0.1, `combined CoM shifted right of the bike (${deg(b.comLean)} deg)`);
  check(b.leanAngle < b.leanAngle + b.comLean - 0.1, `bike leans less than the rider+bike CoM (bike ${deg(b.leanAngle)}, CoM ${deg(b.leanAngle + b.comLean)})`);
  check(b.pos.x < x0 - 1.5, `body lean alone turns the bike gently right (x ${x0.toFixed(1)} -> ${b.pos.x.toFixed(1)})`);
}

console.log('10) hanging off vs counter-leaning in the same turn');
{
  const turn = (side) => {
    const b = new BikePhysics(flat);
    b.reset(new Vector3(0, 0, 0), 0);
    run(b, 3, (t, bk) => I({ throttle: bk.forwardSpeed < 11 ? 1 : 0.4 }));
    let lean = 0, n = 0, minR = 1e9;
    run(b, 4, (t, bk) => {
      if (t > 2) {
        lean += bk.leanAngle; n++;
        const yr = Math.abs(bk.angVel.y);
        if (yr > 0.05) minR = Math.min(minR, bk.speed / yr);
      }
      return I({ steer: 1, side, throttle: bk.forwardSpeed < 11 ? 0.7 : 0.4 });
    });
    return { b, lean: lean / n, minR };
  };
  const inside = turn(1), outside = turn(-1);
  check(!inside.b.crashed && !outside.b.crashed, 'no crash either way');
  console.log(`   bike lean: hanging off ${deg(inside.lean)} deg, counter-leaning ${deg(outside.lean)} deg; radius ${inside.minR.toFixed(1)} m vs ${outside.minR.toFixed(1)} m`);
  check(outside.lean - inside.lean > 0.06, 'counter-leaning leans the bike further under the rider');
  check(inside.minR < outside.minR, 'leaning into the turn turns tighter');
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

console.log(failures ? `\n${failures} FAILURES` : '\nALL OK');

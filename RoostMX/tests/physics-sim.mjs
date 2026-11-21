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
const I = (o = {}) => ({ throttle: 0, brakeF: 0, brakeR: 0, steer: 0, lean: 0, ...o });

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
  check(minR < 30 && minR > 4, 'turn radius plausible');
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

console.log(failures ? `\n${failures} FAILURES` : '\nALL OK');

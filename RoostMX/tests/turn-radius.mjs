// Turn radius vs speed for neutral / counter-lean / hang-off: node tests/turn-radius.mjs
import { Vector3 } from 'three';
import { BikePhysics, PHYSICS_DT } from '../src/physics.js';
import { FunctionTerrain } from '../src/heightfield.js';
const flat = new FunctionTerrain(() => 0);
const dt = PHYSICS_DT;
const deg = (r) => (r * 180 / Math.PI).toFixed(0);
function turn(vTarget, side, steer = 1, assist = 2) {
  const b = new BikePhysics(flat);
  b.tune.assist = assist;
  b.reset(new Vector3(0, 0, 0), 0);
  const ctl = (bk) => Math.min(1, Math.max(0, (vTarget - bk.forwardSpeed) * 0.9 + 0.3));
  for (let i = 0; i < 4 / dt; i++) b.step(dt, { throttle: ctl(b), brakeF: b.forwardSpeed > vTarget + 1 ? 0.4 : 0, brakeR: 0, steer: 0, lean: 0, side: 0 });
  let yr = 0, v = 0, lean = 0, n = 0;
  for (let i = 0; i < 5 / dt; i++) {
    b.step(dt, { throttle: ctl(b), brakeF: 0, brakeR: 0, steer, lean: 0, side });
    if (i * dt > 2.5) { yr += Math.abs(b.angVel.y); v += b.speed; lean += b.leanAngle; n++; }
  }
  yr /= n; v /= n; lean /= n;
  return { R: v / Math.max(yr, 1e-3), v, lean, crashed: b.crashed ? b.crashReason : '' };
}
for (const steer of [1, 0.6]) {
  console.log(`steer ${steer}`);
  for (const vt of [6, 9, 12, 15]) {
    const c = turn(vt, -1, steer), n0 = turn(vt, 0, steer), h = turn(vt, 1, steer);
    const f = (r) => `R ${r.R.toFixed(1).padStart(5)} m lean ${deg(r.lean).padStart(3)}${r.crashed ? ' CRASH ' + r.crashed : ''}`;
    console.log(`  v ${vt.toString().padStart(2)} m/s | counter ${f(c)} | neutral ${f(n0)} | hang-off ${f(h)} | counter tighter by ${((1 - c.R / n0.R) * 100).toFixed(0)}%`);
  }
}

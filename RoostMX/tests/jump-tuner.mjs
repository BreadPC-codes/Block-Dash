// Jump check with the real physics: for every jump on a track (or the specs passed in),
// ride it at a range of takeoff speeds and report the speeds that land cleanly.
//   node tests/jump-tuner.mjs [trackId]        (default: jumpline)
import { Vector3 } from 'three';
import { BikePhysics, PHYSICS_DT } from '../src/physics.js';
import { FunctionTerrain } from '../src/heightfield.js';
import { buildFeature } from '../src/track.js';
import { getTrackDef } from '../src/tracks.js';

const dt = PHYSICS_DT;
const JUMPS = new Set(['table', 'double', 'stepup', 'stepdown']);

/** Ride one feature at takeoff speed v (held up to the lip), assists full. */
export function rideJump(spec, v, assist = 2) {
  const f = buildFeature(spec);
  const lip = f.lips[0] ?? 0;
  const terr = new FunctionTerrain((x, z) => (z > 0 && z < f.length ? f.height(z) : 0));
  const b = new BikePhysics(terr);
  b.tune.assist = assist;
  b.reset(new Vector3(0, 0, -160), 0);
  let air = 0, maxAir = 0, landZ = null, leftLip = false, t = 0, vLip = 0;
  while (t < 30 && !b.crashed && b.pos.z < f.length + 45) {
    const z = b.pos.z;
    let thr;
    if (!leftLip && z < lip) thr = Math.min(1, Math.max(0, (v - b.forwardSpeed) * 0.9 + (z > 0 ? 0.65 : 0.3)));
    else thr = b.airborne ? 0.3 : Math.min(1, Math.max(0, (v - b.forwardSpeed) * 0.5 + 0.3));
    const brake = !leftLip && z < -10 && b.forwardSpeed > v + 0.6 ? 0.5 : 0;
    b.step(dt, { throttle: thr, brakeF: brake, brakeR: brake * 0.6, steer: 0, lean: 0, side: 0 });
    t += dt;
    if (!leftLip && b.pos.z >= lip - 0.5) vLip = b.forwardSpeed;
    if (b.airborne) {
      if (b.pos.z > lip - 1) leftLip = true;
      air += dt;
      maxAir = Math.max(maxAir, air);
    } else {
      if (air > 0.25 && landZ == null) landZ = b.pos.z;
      air = 0;
    }
  }
  return { crashed: b.crashed ? b.crashReason : '', maxAir, landZ, vLip, length: f.length, lip };
}

/**
 * Where a clean landing should touch down: the middle of the landing ramp (the last
 * descending part of the profile), or the plateau of a step-up.
 */
export function landingZone(spec) {
  const f = buildFeature(spec);
  const L = f.length, dz = 0.05;
  if (spec.type === 'stepup') {
    const lip = f.lips[0];
    let a = null, b = null;
    for (let u = lip + 1; u < L; u += dz) {
      const top = f.height(u) > spec.h2 - 0.05;
      if (top && a == null) a = u;
      if (!top && a != null) { b = u; break; }
    }
    return { a: a + 1, b: (b ?? L) - 1 };
  }
  // start of the final descent
  let start = L;
  for (let u = L - dz; u > 0; u -= dz) {
    if (f.height(u - dz) <= f.height(u) + 1e-4) { start = u; break; }
  }
  const len = L - start;
  return { a: start + 0.12 * len, b: start + 0.7 * len };
}

/** Speeds (step 0.5 m/s) that land without crashing: [{v, air, landZ}] */
export function safeSpeeds(spec, vMin = 10, vMax = 28) {
  const ok = [];
  for (let v = vMin; v <= vMax + 1e-6; v += 0.5) {
    const r = rideJump(spec, v);
    if (!r.crashed && r.maxAir > 0.3) ok.push({ v, air: r.maxAir, landZ: r.landZ });
  }
  return ok;
}

/** Longest run of consecutive safe speeds. */
export function bestWindow(ok) {
  let best = null, cur = null;
  for (const o of ok) {
    if (cur && Math.abs(o.v - cur.hi - 0.5) < 1e-6) cur.hi = o.v;
    else cur = { lo: o.v, hi: o.v };
    cur.air = Math.max(cur.air || 0, o.air);
    if (!best || cur.hi - cur.lo > best.hi - best.lo) best = { ...cur };
  }
  return best;
}

/** Speeds that touch down inside the landing zone without crashing. */
export function sweetSpeeds(spec, vMin = 9, vMax = 26) {
  const z = landingZone(spec);
  const ok = [];
  for (let v = vMin; v <= vMax + 1e-6; v += 0.5) {
    const r = rideJump(spec, v);
    if (!r.crashed && r.landZ != null && r.landZ >= z.a && r.landZ <= z.b) ok.push({ v, air: r.maxAir, landZ: r.landZ });
  }
  return ok;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const def = getTrackDef(process.argv[2] || 'jumpline');
  let total = 0, good = 0;
  for (const it of def.layout) {
    if (it[0] !== 'S' || !it[2] || !it[2].features) continue;
    for (const spec of it[2].features) {
      if (!JUMPS.has(spec.type)) continue;
      total++;
      const w = bestWindow(safeSpeeds(spec));
      const sw = bestWindow(sweetSpeeds(spec));
      const desc = `${spec.type} @${spec.at.toFixed(0)} m ${JSON.stringify(Object.fromEntries(Object.entries(spec).filter(([k]) => !['type', 'at'].includes(k))))}`;
      const hintOk = sw && spec.speed != null && spec.speed >= sw.lo && spec.speed <= sw.hi;
      if (w && w.hi - w.lo >= 1.5 && sw && (spec.speed == null || hintOk)) good++;
      console.log(`${w && w.hi - w.lo >= 1.5 && sw && (spec.speed == null || hintOk) ? 'ok  ' : 'BAD '} ${desc}\n      safe takeoff ${w ? `${w.lo.toFixed(1)}-${w.hi.toFixed(1)} m/s (${(w.lo * 3.6).toFixed(0)}-${(w.hi * 3.6).toFixed(0)} km/h), air up to ${w.air.toFixed(2)} s` : 'NONE'}; sweet spot ${sw ? `${sw.lo.toFixed(1)}-${sw.hi.toFixed(1)} m/s (suggest ${((sw.lo + sw.hi) / 2).toFixed(1)})` : 'NONE'}`);
    }
  }
  console.log(`\n${good}/${total} jumps have a safe window of at least 1.5 m/s and a sweet spot that contains their speed hint`);
  if (good < total) process.exitCode = 1;
}

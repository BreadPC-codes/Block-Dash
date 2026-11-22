// MX Bikes track import: node tests/track-import.mjs
// Uses the synthetic packages from tests/make-mxb-fixtures.mjs (built in memory here).
import { Vector3 } from 'three';
import { readTrackPackage, parseTrh, alignGrid, sampleProfile, parseRdf, parseBlocks, downsampleGrid, gridHeight, TrackImportError } from '../src/mxb-track.js';
import { buildImportedWorld, scaledStats, importedDef } from '../src/imported-track.js';
import { BikePhysics, PHYSICS_DT } from '../src/physics.js';
import { SURF } from '../src/heightfield.js';
import { LapTimer } from '../src/timing.js';
import { buildFixtures, fixtureTrh, fixtureTerrain, FIX } from './make-mxb-fixtures.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const fx = buildFixtures();
const blob = (u8) => new Blob([u8]);

console.log('1) parsing a track package');
const tracks = await readTrackPackage(blob(fx.pkz), { fileName: 'mxb-testtrack.pkz' });
ok(tracks.length === 1, `one track found (${tracks.length})`);
const rec = tracks[0];
ok(rec.name === 'Roost Test MX' && rec.author === 'Roost MX tests', `name / author from the .ini: "${rec.name}" by "${rec.author}"`);
ok(rec.grid.w === FIX.w && rec.grid.h === FIX.h && near(rec.grid.sizeX, FIX.size, 1e-3), `terrain ${rec.grid.w} x ${rec.grid.h} samples, ${rec.grid.sizeX} m`);
const { H } = fixtureTerrain();
let maxErr = 0;
const { lo } = fixtureTrh();
for (let k = 0; k < H.length; k += 997) {
  const i = k % FIX.w, j = Math.floor(k / FIX.w);
  maxErr = Math.max(maxErr, Math.abs(gridHeight(rec.grid, i, j) - (H[k] - lo)));
}
ok(maxErr < 0.01, `heights decode to metres (max error ${(maxErr * 1000).toFixed(1)} mm)`);
ok(rec.line && rec.line.closed && near(rec.line.length, 200 + 60 * Math.PI, 0.05), `centre line: closed loop, ${rec.line && rec.line.length.toFixed(1)} m`);
ok(rec.grid.ox === 0 && rec.grid.oz === 0, 'grid placed as documented (sample i, j at i, j x spacing; no flip needed)');
ok(rec.timing && rec.timing.finish === 15 && rec.timing.gate === 5 && rec.timing.splits.length === 2, `race data: finish ${rec.timing && rec.timing.finish} m, gate ${rec.timing && rec.timing.gate} m, ${rec.timing && rec.timing.splits.length} splits`);

console.log('2) orientation check against the centre line heights');
const trh = parseTrh(fixtureTrh().bytes);
const line = sampleProfile(trh.profile, 0.5);
const g0 = { w: trh.w, h: trh.h, sizeX: trh.sizeX, sizeZ: trh.sizeZ, relief: trh.relief, samples: trh.samples };
const flipped = { ...g0, samples: new Uint16Array(trh.samples.length) };
for (let j = 0; j < trh.h; j++) for (let i = 0; i < trh.w; i++) flipped.samples[j * trh.w + i] = trh.samples[j * trh.w + (trh.w - 1 - i)];
const a0 = alignGrid(g0, line), a1 = alignGrid(flipped, line);
ok(!a0.flipX && !a0.flipZ && a0.inside > 0.99 && a0.rms < 1, `documented layout matches (centre line heights within ${a0.rms.toFixed(2)} m)`);
ok(a1.flipX && !a1.flipZ, 'a mirrored grid is detected and turned back');
const ds = downsampleGrid(new Uint16Array(4097 * 4097).fill(1000), 4097, 4097);
ok(ds.w === 2049 && ds.h === 2049 && ds.samples[5] === 1000, `4097 x 4097 terrain stored at ${ds.w} x ${ds.h}`);
const rdf = parseRdf('finish_line\n{\n line = 0\n long = 99.5 // comment\n left = -5\n right = 5\n}\nstarting_grid { numstalls = 1\n stall0 { long = 3\n lat = 1\n angle = 0 } }');
ok(rdf.finish.long === 99.5 && rdf.grid.length === 1 && rdf.grid[0].long === 3, 'race data parser handles comments and inline braces');
ok(parseBlocks('[info]\nname = "Quoted"\n').values.name === 'Quoted', 'ini values, sections and quotes');

console.log('3) building the world at 100 %');
const w1 = buildImportedWorld({ ...rec, surface: 'dirt' }, 1);
ok(near(w1.hf.sizeX, 256, 1e-6) && w1.hf.cell === 0.5, `heightfield ${w1.hf.sizeX} m, cell ${w1.hf.cell} m`);
ok(!w1.track.open && near(w1.track.length, rec.line.length, 0.6), `track loop ${w1.track.length.toFixed(1)} m`);
// rider-relative direction survives the X mirror: the fixture loop turns right (radius > 0)
let ksum = 0;
for (let i = 0; i < w1.track.n; i++) ksum += w1.track.kappa[i];
ok(ksum < 0, 'right-hand corners stay right-hand corners (X mirrored from the left-handed MX Bikes frame)');
// the line sits on the dirt and on the terrain the file describes
let onDirt = 0, hErr = 0;
for (let i = 0; i < w1.track.n; i += 8) {
  if (w1.hf.surface(w1.track.x[i], w1.track.z[i]) === SURF.DIRT) onDirt++;
}
for (let k = 0; k < line.pts.length / 2; k += 25) {
  const wx = line.pts[k * 2], wz = line.pts[k * 2 + 1];
  const gx = -(wx - 128), gz = wz - 128;
  hErr = Math.max(hErr, Math.abs(w1.hf.height(gx, gz) - gridHeight(rec.grid, wx / 0.5, wz / 0.5)));
}
ok(onDirt / Math.ceil(w1.track.n / 8) > 0.95, `the riding line is painted dirt (${((onDirt / Math.ceil(w1.track.n / 8)) * 100).toFixed(0)} %)`);
ok(hErr < 0.05, `game terrain matches the file under the line (max ${(hErr * 100).toFixed(1)} cm)`);
ok(near(w1.track.finishS, 15, 0.01) && near(w1.track.gateS, 5, 0.01) && w1.track.checkpoints.length === 8, `timing: finish ${w1.track.finishS} m, gate ${w1.track.gateS} m, 8 checkpoints`);
ok(w1.hf.trackDist && w1.hf.pits && w1.hf.trackDist.length === w1.hf.nx * w1.hf.nz, 'distance-to-track map for the scenery');

console.log('4) scaling keeps proportions');
const w2 = buildImportedWorld(rec, 2), wh = buildImportedWorld(rec, 0.5);
const r1 = w1.hf.maxH - w1.hf.minH, r2 = w2.hf.maxH - w2.hf.minH, rh = wh.hf.maxH - wh.hf.minH;
ok(near(w2.hf.sizeX, 512, 1e-6) && near(w2.track.length, 2 * w1.track.length, 1.5) && near(r2 / r1, 2, 0.02), `200 %: ${w2.hf.sizeX} m map, lap ${w2.track.length.toFixed(0)} m, relief x${(r2 / r1).toFixed(2)}`);
ok(near(wh.hf.sizeX, 128, 1e-6) && near(wh.track.length, 0.5 * w1.track.length, 1) && near(rh / r1, 0.5, 0.02), `50 %: ${wh.hf.sizeX} m map, lap ${wh.track.length.toFixed(0)} m, relief x${(rh / r1).toFixed(2)}`);
const st = scaledStats(rec, 1.5);
ok(near(st.sizeX, 384, 1e-6) && near(st.lap, rec.line.length * 1.5, 0.01), `stats at 150 %: ${st.sizeX} m, lap ${st.lap.toFixed(0)} m, relief ${st.relief.toFixed(1)} m`);
ok(importedDef(rec, 1).id === 'import:' + rec.id, 'track id');

console.log('5) riding it with the real physics');
function ride(world, seconds, vmax = 15) {
  const { track, hf } = world;
  const b = new BikePhysics(hf, null);
  b.tune.assist = 2;
  const p = track.pose(track.gateS - 2.2, 0);
  b.reset(new Vector3(p.x, 0, p.z), p.heading);
  const timer = new LapTimer(track);
  let t = 0, crashes = 0, maxAir = 0, laps = 0, hint = -1, dist = 0, prev = null;
  while (t < seconds) {
    const pr = track.project(b.pos.x, b.pos.z, hint);
    hint = pr.index;
    if (prev != null) { let d = pr.s - prev; if (d < -track.length / 2) d += track.length; if (d > track.length / 2) d -= track.length; dist += d; }
    prev = pr.s;
    const tp = track.pose(pr.s + 4 + Math.abs(b.forwardSpeed) * 0.45, 0);
    let err = Math.atan2(tp.x - b.pos.x, tp.z - b.pos.z) - Math.atan2(b.fwd.x, b.fwd.z);
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    const k = Math.abs(track.interp(track.kappa, pr.s + 10));
    const vt = Math.min(vmax, Math.sqrt(9.81 * 0.9 / Math.max(k, 1e-3)));
    const ev = vt - b.forwardSpeed;
    const steer = b.airborne ? 0 : Math.max(-1, Math.min(1, -err * 1.8 + b.angVel.y * 0.25 - pr.d * 0.08));
    b.step(PHYSICS_DT, { throttle: b.airborne ? 0.3 : ev > 0 ? Math.min(1, 0.3 + ev * 0.5) : 0.05, brakeF: ev < -1 ? 0.3 : 0, brakeR: ev < -1 ? 0.2 : 0, steer, lean: 0 });
    t += PHYSICS_DT;
    if (b.airborne) maxAir = Math.max(maxAir, b.airTime);
    for (const e of timer.update(b.pos.x, b.pos.z, t, null)) if (e.type === 'lap') laps++;
    if (b.crashed) {
      crashes++;
      const s = track.safeRespawnS(pr.s);
      const q = track.pose(s, 0);
      b.reset(new Vector3(q.x, 0, q.z), q.heading);
      timer.teleported(s);
    }
  }
  return { crashes, maxAir, laps, dist };
}
const r = ride(w1, 70);
console.log(`    100 %: ${r.dist.toFixed(0)} m ridden, ${r.laps} timed laps, max air ${r.maxAir.toFixed(2)} s, ${r.crashes} crashes`);
ok(r.dist > 600 && r.laps >= 1, 'the bike rides laps around the imported track and the timer counts them');
ok(r.maxAir > 0.4, 'the double jump from the terrain file launches the bike');
ok(r.crashes <= 1, 'no repeated crashes');
// jump speeds grow with the square root of the size
const r2r = ride(w2, 70, 15 * Math.SQRT2);
console.log(`    200 %: ${r2r.dist.toFixed(0)} m ridden, max air ${r2r.maxAir.toFixed(2)} s, ${r2r.crashes} crashes`);
ok(r2r.dist > 700 && r2r.crashes <= 1, 'the scaled-up track is rideable (with proportionally more speed)');
// respawning after a crash puts the bike on calm ground before a jump, never in its gap
const jump = w1.track.F.findIndex((v) => v > 0.5);
const sJump = jump * 0.25;
const back = w1.track.safeRespawnS(sJump + 6);
ok(jump > 0 && back < sJump - 1 && w1.track.interp(w1.track.F, back) <= 0.05, `jumps found in the terrain (at ${sJump.toFixed(0)} m); a crash there respawns at ${back.toFixed(0)} m`);

console.log('6) other packages');
const dist = await readTrackPackage(blob(fx.dist), { fileName: 'mxb-dist.pkz' });
ok(dist.length === 1 && dist[0].name === 'Roost Test MX' && dist[0].line, 'a distribution pack with a nested server .pkz');
const wip = await readTrackPackage(blob(fx.wip), { fileName: 'mxb-heightmap.zip' });
ok(wip.length === 1 && wip[0].info.kind === 'raw' && near(wip[0].grid.sizeX, 160, 1e-6) && near(wip[0].grid.relief, 14, 1e-6) && !wip[0].line, `heightmap sources (.hmf + .raw): ${wip[0] && wip[0].grid.w} samples, 160 m, no centre line`);
const ww = buildImportedWorld(wip[0], 1);
ok(ww.def.noTiming && ww.track.open && ww.track.length > 50, 'without a centre line: free ride on a short straight in the flattest spot');
const errOf = async (u8, name) => {
  try { await readTrackPackage(blob(u8), { fileName: name }); return ''; } catch (e) { return e instanceof TrackImportError ? e.message : 'OTHER ' + e.message; }
};
const eb = await errOf(fx.bike, 'bike.pkz');
ok(/No MX Bikes track terrain/.test(eb) && /bike/.test(eb), 'a bike mod is refused with a helpful message');
const en = await errOf(new Uint8Array(4096).fill(0x5a), 'protected.pkz');
ok(/not a plain ZIP/.test(en) && /encrypted/.test(en), 'a protected / non-ZIP package is refused, not decrypted');
const bad = fixtureTrh().bytes.slice(0, 5000);
const et = await (async () => { try { parseTrh(bad); return ''; } catch (e) { return e.message; } })();
ok(/truncated/.test(et), 'a truncated terrain file is reported');

console.log(fails ? `${fails} FAILURES` : 'TRACK IMPORT OK');
process.exitCode = fails ? 1 : 0;

// Lap timer unit test: node tests/timing-test.mjs
import { Track, DS } from '../src/track.js';
import { TRACKS } from '../src/tracks.js';
import { LapTimer } from '../src/timing.js';
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const tr = new Track(TRACKS[1]);
const ride = (timer, s0, s1, step, dtPerM, t0, lateral = 0) => {
  const evs = [];
  let t = t0;
  for (let s = s0; step > 0 ? s <= s1 : s >= s1; s += step) {
    const p = tr.pose(s, lateral);
    t += Math.abs(step) * dtPerM;
    for (const e of timer.update(p.x, p.z, t, null)) evs.push(e);
  }
  return { evs, t };
};
{
  const timer = new LapTimer(tr);
  const L = tr.length;
  const r = ride(timer, tr.gateS - 2, tr.gateS + 2.2 * L, 1, 0.1, 0);
  const laps = r.evs.filter((e) => e.type === 'lap');
  const cps = r.evs.filter((e) => e.type === 'cp');
  ok(laps.length === 2, `two complete laps detected (${laps.length})`);
  ok(laps.every((l) => Math.abs(l.time - L * 0.1) < 1), `lap times match distance (${laps.map((l) => l.time.toFixed(1)).join(', ')} vs ${(L * 0.1).toFixed(1)})`);
  ok(cps.length >= (tr.checkpoints.length - 1) * 2, `checkpoints passed (${cps.length})`);
  ok(laps[0].splits.length === tr.checkpoints.length - 1, 'splits recorded for each checkpoint');
}
{
  const timer = new LapTimer(tr);
  // start the lap, then teleport past two checkpoints (cut) and finish the lap
  let r = ride(timer, tr.gateS - 2, tr.finishS + 30, 1, 0.1, 0);
  const mid = tr.finishS + tr.length * 0.6;
  r = ride(timer, mid, tr.finishS + tr.length + 5, 1, 0.1, r.t);
  ok(r.evs.some((e) => e.type === 'invalid'), 'cutting the track invalidates the lap');
  ok(!r.evs.some((e) => e.type === 'lap'), 'cut lap is not recorded');
}
{
  const timer = new LapTimer(tr);
  let r = ride(timer, tr.gateS - 2, tr.finishS + 40, 1, 0.1, 0);
  r = ride(timer, tr.finishS + 40, tr.finishS - 20, -1, 0.1, r.t);
  ok(r.evs.some((e) => e.type === 'invalid'), 'riding backwards over the line invalidates the lap');
}
{
  const timer = new LapTimer(tr);
  let r = ride(timer, tr.gateS - 2, tr.finishS + 60, 1, 0.1, 0);
  r = ride(timer, tr.finishS + 60, tr.finishS + 160, 1, 0.1, r.t, 40);
  ok(r.evs.some((e) => e.type === 'invalid'), 'leaving the track far invalidates the lap (' + (r.evs.find((e) => e.type === 'invalid') || {}).reason + ')');
}
console.log(fails ? `${fails} FAILURES` : 'ALL OK');

const { chromium } = require('playwright');
// Big Air Line (point-to-point track) in the browser: node tests/jumpline.cjs <outDir> [url]
const path = require('path');
const dir = (process.argv[2] || '.') + path.sep;
const url = process.argv[3] || 'http://localhost:8765/';
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.addInitScript(() => localStorage.setItem('roostmx.settings.v1', JSON.stringify({ graphics: { quality: 'medium', fullscreen: false, dynamicRes: false }, game: { track: 'ridgeback', mode: 'free' } })));
  await page.goto(url);
  await page.waitForSelector('#screen-main.active', { timeout: 300000 });
  // track select screen shows the new track
  await page.evaluate(() => window.__roost.ui.go('tracks'));
  await page.waitForTimeout(800);
  await page.screenshot({ path: dir + 'jl-tracks.png' });
  ok(await page.evaluate(() => /Big Air Line/.test(document.body.textContent)), 'Big Air Line listed in track select');
  // load it
  await page.evaluate(() => window.__roost.selectTrack('jumpline'));
  await page.waitForFunction(() => window.__roost.world && window.__roost.world.def.id === 'jumpline' && window.__roost.state !== 'loading', null, { timeout: 300000, polling: 300 });
  const info = await page.evaluate(() => { const w = window.__roost.world; return { len: w.track.length, open: w.track.open, jumps: w.track.features.length, hf: [w.hf.nx, w.hf.nz], times: window.__roost.loadTimes, env: w.env.buildTimes }; });
  console.log('   ', JSON.stringify(info));
  ok(info.open && info.len > 2600 && info.jumps === 28, `jump line loaded: ${info.len.toFixed(0)} m, ${info.jumps} jumps, open`);
  await page.evaluate(() => window.__roost.startRide());
  await page.waitForFunction(() => window.__roost.state === 'riding', null, { timeout: 60000, polling: 200 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: dir + 'jl-start.png' });
  // place the bike on the approach to a big jump and look at it
  await page.evaluate(() => { const g = window.__roost, w = g.world, tr = w.track; const f = tr.features[16]; const p = tr.pose(f.s0 - 18, 0); w.physics.reset({ x: p.x, y: 0, z: p.z }, p.heading); w.rig.snapNext = true; g.state = 'paused'; g.dyn.pAcc = -1e9; for (let i = 0; i < 30; i++) { g.syncBikeVisual(0.05, false); w.rig.update(0.05, g._camCtx(g.input.state), null); } w.env.update(0.016, w.physics.pos, g.camera); g.render(); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: dir + 'jl-jump.png' });
  await page.evaluate(() => { window.__roost.state = 'riding'; });
  // finish -> return to start
  const r = await page.evaluate(() => {
    const g = window.__roost, w = g.world, tr = w.track, tm = w.timer;
    // start a run, then put the bike just before the finish line going forward
    tm.reset();
    const s0 = tr.startS - 1; let p = tr.pose(s0, 0);
    tm.update(p.x, p.z, g.time, null);
    p = tr.pose(tr.startS + 1, 0);
    const ev1 = tm.update(p.x, p.z, g.time + 0.1, null).map((e) => e.type);
    // ride every checkpoint
    const evs = [];
    for (let s = tr.startS + 2; s <= tr.finishS + 2; s += 4) { p = tr.pose(s, 0); evs.push(...tm.update(p.x, p.z, g.time + 0.2 + s / 20, null).map((e) => e.type)); }
    return { ev1, cps: evs.filter((e) => e === 'cp').length, finish: evs.includes('finish'), lap: evs.includes('lap'), next: tm.nextCheckpoint() };
  });
  ok(r.ev1.includes('lapStart') && r.cps === 9 && r.finish && r.lap && r.next === null, `run timing: start, ${r.cps} splits, finish + time (${JSON.stringify(r.ev1)})`);
  // full flow: teleport near the finish and let the physics ride across
  await page.evaluate(() => { const g = window.__roost, w = g.world, tr = w.track; w.timer.reset(); const p = tr.pose(tr.finishS - 8, 0); w.physics.reset({ x: p.x, y: 0, z: p.z }, p.heading); w.physics.vel.set(p.tx * 12, 0, p.tz * 12); w.timer.teleported(tr.finishS - 8); w.timer.lapStart = g.time - 60; w.timer.nextCp = w.timer.n; w.timer.valid = true; });
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => window.__roost.world.timer.finished, null, { timeout: 60000, polling: 100 });
  await page.keyboard.up('KeyW');
  const label = await page.textContent('#hud-lap');
  ok(/FINISHED/.test(label), 'HUD shows FINISHED · BACK TO START (' + label + ')');
  await page.waitForFunction(() => { const w = window.__roost.world; return !w.timer.finished && w.physics.pos.distanceTo({ x: w.track.pose(w.track.gateS, 0).x, y: w.physics.pos.y, z: w.track.pose(w.track.gateS, 0).z }) < 10; }, null, { timeout: 60000, polling: 200 });
  ok(true, 'automatically back at the start gate after the finish');
  const rec = await page.evaluate(() => window.__roost.records.jumpline);
  ok(rec && rec.best > 0, 'run time saved as the track record (' + (rec && rec.best.toFixed(2)) + ' s)');
  ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  console.log(fails ? fails + ' FAILURES' : 'JUMP LINE OK');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

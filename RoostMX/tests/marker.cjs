// Track marker in the browser: node tests/marker.cjs <outDir> [url]
// Hold the down arrow for 3 s on the ground to drop a marker, tap it to go back there.
const { chromium } = require('playwright');
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
  await page.addInitScript(() => localStorage.setItem('roostmx.settings.v1', JSON.stringify({ graphics: { quality: 'low', fullscreen: false, dynamicRes: false }, game: { track: 'pinehollow', mode: 'free' } })));
  await page.goto(url);
  await page.waitForSelector('#screen-main.active', { timeout: 300000 });
  const keys = await page.evaluate(() => ({ marker: window.__roost.settings.controls.keys.marker, back: window.__roost.settings.controls.keys.leanBack }));
  ok(keys.marker[0] === 'ArrowDown' && keys.back[0] === 'ArrowDown', 'down arrow: rider lean back and track marker');
  await page.evaluate(() => window.__roost.startRide());
  await page.waitForFunction(() => window.__roost.state === 'riding', null, { timeout: 60000, polling: 200 });
  const st = () => page.evaluate(() => { const g = window.__roost, ph = g.world.physics, m = g.markers[g.world.def.id]; return { x: ph.pos.x, z: ph.pos.z, v: ph.speed, air: ph.airborne, crashed: ph.crashed, marker: m || null, lean: g.input.state.lean, mesh: g.world.markerMesh.visible, bar: document.getElementById('hud-marker').classList.contains('on') }; });
  const stop = async () => {
    await page.keyboard.down('Space');
    await page.waitForFunction(() => window.__roost.world.physics.speed < 0.6, null, { timeout: 20000, polling: 100 });
    await page.keyboard.up('Space');
  };
  // ride a little and stop
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500);
  await page.keyboard.up('KeyW');
  await stop();

  // a 1.5 s hold: rider leans back, the bar shows, no marker yet
  await page.keyboard.down('ArrowDown');
  await page.waitForTimeout(1300);
  const mid = await st();
  await page.waitForTimeout(200);
  await page.keyboard.up('ArrowDown');
  await page.waitForTimeout(200);
  const after15 = await st();
  ok(mid.lean < -0.5, `holding the down arrow still leans the rider back (lean ${mid.lean.toFixed(2)})`);
  ok(mid.bar, 'a "setting a track marker" bar fills while it is held');
  ok(!after15.marker && !after15.bar, 'let go before 3 s: no marker');

  // a 3 s hold sets the marker where the bike is
  const before = await st();
  await page.keyboard.down('ArrowDown');
  await page.waitForTimeout(3400);
  await page.keyboard.up('ArrowDown');
  await page.waitForTimeout(250);
  const set = await st();
  const notice = await page.textContent('#hud-center');
  ok(set.marker && Math.hypot(set.marker.x - before.x, set.marker.z - before.z) < 1.5, 'held 3 s on the ground: marker set at the bike');
  ok(set.mesh && /Marker set/.test(notice) && /Tap ↓/.test(notice), 'flag shown on the track, "Marker set - Tap ↓ to come back here"');
  ok(Math.hypot(set.x - set.marker.x, set.z - set.marker.z) < 1.5, 'releasing after setting does not jump anywhere');
  await page.screenshot({ path: dir + 'marker-set.png' });

  // ride away, then tap: back at the marker
  await page.keyboard.down('KeyW');
  await page.waitForFunction((m) => { const p = window.__roost.world.physics.pos; return Math.hypot(p.x - m.x, p.z - m.z) > 6; }, set.marker, { timeout: 30000, polling: 50 });
  await page.keyboard.up('KeyW');
  const away = await st();
  ok(Math.hypot(away.x - set.marker.x, away.z - set.marker.z) > 4, `rode away from it (${Math.hypot(away.x - set.marker.x, away.z - set.marker.z).toFixed(0)} m)`);
  await page.keyboard.down('ArrowDown');
  await page.waitForTimeout(90);
  await page.keyboard.up('ArrowDown');
  await page.waitForTimeout(300);
  const back = await st();
  ok(Math.hypot(back.x - set.marker.x, back.z - set.marker.z) < 1.5 && back.v < 2, 'a tap brings the bike back to the marker');
  ok(/Back to the marker/.test(await page.textContent('#hud-center')), '"Back to the marker" shown');

  // a tap in the air is a pitch correction, not a teleport
  await page.keyboard.down('KeyW');
  await page.waitForFunction((m) => { const p = window.__roost.world.physics.pos; return Math.hypot(p.x - m.x, p.z - m.z) > 7; }, set.marker, { timeout: 30000, polling: 50 });
  await page.keyboard.up('KeyW');
  await page.evaluate(() => { const ph = window.__roost.world.physics; ph.pos.y += 9; ph.vel.y = 2; });
  await page.waitForFunction(() => window.__roost.world.physics.airborne, null, { timeout: 5000, polling: 20 });
  const inAir = await st();
  await page.keyboard.down('ArrowDown');
  await page.waitForTimeout(90);
  await page.keyboard.up('ArrowDown');
  await page.waitForTimeout(150);
  const afterAir = await st();
  ok(inAir.air && Math.hypot(afterAir.x - set.marker.x, afterAir.z - set.marker.z) > 5, 'a tap in the air does not teleport');

  // after a crash a tap goes back to the marker too
  await page.waitForFunction(() => !window.__roost.world.physics.airborne || window.__roost.world.physics.crashed, null, { timeout: 10000, polling: 50 });
  await page.evaluate(() => { const ph = window.__roost.world.physics; if (!ph.crashed) ph.crash('test'); });
  await page.waitForTimeout(300);
  await page.keyboard.down('ArrowDown');
  await page.waitForTimeout(90);
  await page.keyboard.up('ArrowDown');
  await page.waitForTimeout(300);
  const fromCrash = await st();
  ok(!fromCrash.crashed && Math.hypot(fromCrash.x - set.marker.x, fromCrash.z - set.marker.z) < 1.5, 'crashed: a tap goes back to the marker');
  await page.screenshot({ path: dir + 'marker-back.png' });
  ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  console.log(fails ? fails + ' FAILURES' : 'MARKER OK');
  await browser.close();
  process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });

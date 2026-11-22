// MX Bikes track import in the browser: node tests/track-import.cjs <outDir> [url]
// Needs tests/fixtures/mxb-testtrack.pkz (node tests/make-mxb-fixtures.mjs) and `npm run serve`.
const { chromium } = require('playwright');
const path = require('path');
const dir = (process.argv[2] || '.') + path.sep;
const url = process.argv[3] || 'http://localhost:8765/';
const FIX = path.join(__dirname, 'fixtures');
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('roostmx.settings.v1', JSON.stringify({ graphics: { quality: 'low', fullscreen: false, dynamicRes: false }, game: { track: 'pinehollow', mode: 'free' } }));
    }
  });
  await page.goto(url);
  await page.waitForSelector('#screen-main.active', { timeout: 300000 });
  await page.evaluate(() => window.__roost.ui.go('tracks'));
  await page.waitForSelector('#track-import', { timeout: 10000 });
  ok(true, 'track list has an "Import a track" card');

  // 1) import through the file picker
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#track-import')]);
  await chooser.setFiles(path.join(FIX, 'mxb-testtrack.pkz'));
  await page.waitForSelector('.import-dialog', { timeout: 60000 });
  const facts = await page.textContent('.import-facts');
  ok(/Roost Test MX/.test(facts) && /256 × 256 m/.test(facts) && /0\.39 km/.test(facts), 'import dialog shows the track, its size and lap length: ' + facts.replace(/\s+/g, ' ').trim().slice(0, 140));
  ok(/from the race data/.test(facts), 'start / finish come from the race data');
  await page.screenshot({ path: dir + 'import-dialog.png' });
  await page.evaluate(() => { const s = document.getElementById('import-scale'); s.value = '150'; s.dispatchEvent(new Event('input')); });
  const val = await page.textContent('.import-scale-val');
  const facts2 = await page.textContent('.import-facts');
  ok(/150 %/.test(val) && /384 × 384 m/.test(facts2) && /0\.58 km/.test(facts2), `scale slider: ${val.trim()}, map and lap scale with it`);
  await page.click('#modal-btns .btn.primary');
  await page.waitForFunction(() => { const g = window.__roost; return g.world && g.world.def.imported && g.state !== 'loading' && g.ui.screen === 'tracks'; }, null, { timeout: 120000, polling: 250 });
  const w = await page.evaluate(() => { const g = window.__roost, w = g.world; return { id: w.def.id, sel: g.settings.game.track, size: w.hf.sizeX, len: w.track.length, scale: w.def.scale, cards: document.querySelectorAll('.track-card.imported').length }; });
  ok(w.id === w.sel && w.size === 384 && Math.abs(w.len - 582.7) < 2 && w.scale === 1.5, `imported and selected: ${w.id}, ${w.size} m map, ${w.len.toFixed(1)} m lap at ${w.scale * 100} %`);
  ok(w.cards === 1, 'imported track card in the list');
  await page.screenshot({ path: dir + 'import-tracks.png' });

  // 2) ride it
  await page.evaluate(() => window.__roost.startRide());
  await page.waitForFunction(() => window.__roost.state === 'riding', null, { timeout: 60000, polling: 200 });
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(4000);
  await page.keyboard.up('KeyW');
  const ride = await page.evaluate(() => { const w = window.__roost.world, ph = w.physics; return { v: ph.speed, crashed: ph.crashed, y: ph.pos.y - w.hf.height(ph.pos.x, ph.pos.z), name: document.getElementById('hud-mode').textContent }; });
  ok(ride.v > 3 && !ride.crashed && ride.y > 0 && ride.y < 2, `riding the imported track (${ride.v.toFixed(1)} m/s, ${ride.y.toFixed(2)} m above the ground)`);
  await page.screenshot({ path: dir + 'import-ride.png' });
  await page.evaluate(() => window.__roost.toMainMenu());
  await page.waitForFunction(() => window.__roost.state === 'menu', null, { timeout: 30000 });
  ok(/Roost Test MX/.test(await page.textContent('#card-track')), 'main menu card shows the imported track');

  // 3) rescale it
  await page.evaluate(() => window.__roost.ui.go('tracks'));
  await page.click('.track-card.imported');
  await page.waitForSelector('#modal:not(.hidden)');
  await page.click('#modal-btns button:nth-child(2)'); // Scale & ground
  await page.waitForSelector('.import-dialog');
  await page.evaluate(() => { const s = document.getElementById('import-scale'); s.value = '100'; s.dispatchEvent(new Event('input')); });
  await page.click('#modal-btns .btn.primary');
  await page.waitForFunction(() => { const g = window.__roost; return g.world && g.world.hf.sizeX === 256 && g.state !== 'loading'; }, null, { timeout: 120000, polling: 250 });
  ok(true, 'rescaled to 100 %: the world is rebuilt at 256 m');

  // 4) still there after a reload
  await page.reload();
  await page.waitForSelector('#screen-main.active', { timeout: 300000 });
  const after = await page.evaluate(() => { const g = window.__roost; return { id: g.world.def.id, imported: !!g.world.def.imported, n: g.importedTracks.length, size: g.world.hf.sizeX }; });
  ok(after.imported && after.n === 1 && after.size === 256, `kept in storage and loaded at start-up (${after.id})`);

  // 5) a package that is not a track
  await page.evaluate(() => window.__roost.ui.go('tracks'));
  const [ch2] = await Promise.all([page.waitForEvent('filechooser'), page.click('#track-import')]);
  await ch2.setFiles(path.join(FIX, 'mxb-bike-mod.pkz'));
  await page.waitForSelector('#modal:not(.hidden)', { timeout: 60000 });
  const errText = (await page.textContent('#modal-title')) + ' ' + (await page.textContent('#modal-body'));
  ok(/import failed/i.test(errText) && /bike/.test(errText), 'a bike mod gets a clear message: ' + errText.replace(/\s+/g, ' ').slice(0, 120));
  await page.click('#modal-btns button');

  // 6) delete
  await page.click('.track-card.imported');
  await page.waitForSelector('#modal:not(.hidden)');
  await page.click('#modal-btns button:nth-child(3)'); // Delete
  await page.waitForFunction(() => /Delete track/.test(document.getElementById('modal-title').textContent) && !document.getElementById('modal').classList.contains('hidden'));
  await page.click('#modal-btns .btn.primary');
  await page.waitForFunction(() => { const g = window.__roost; return g.world && !g.world.def.imported && g.state !== 'loading' && document.querySelectorAll('.track-card.imported').length === 0; }, null, { timeout: 120000, polling: 250 });
  ok(true, 'deleted: back on a built-in track, the card is gone');
  ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  console.log(fails ? fails + ' FAILURES' : 'TRACK IMPORT (BROWSER) OK');
  await browser.close();
  process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });

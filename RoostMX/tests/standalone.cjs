// Opens the single-file play/index.html via file:// and checks it works: node tests/standalone.cjs <file> <outDir>
const { chromium } = require('playwright');
const path = require('path');
const file = process.argv[2];
const out = process.argv[3] || '.';
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const logs = [];
  page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') logs.push('[error] ' + m.text()); });
  page.on('requestfailed', (r) => logs.push('[reqfail] ' + r.url().slice(0, 100)));
  await page.addInitScript(() => localStorage.setItem('roostmx.settings.v1', JSON.stringify({ graphics: { quality: 'low', fullscreen: false } })));
  await page.goto('file://' + file);
  await page.waitForSelector('#screen-main.active', { timeout: 120000 });
  ok(true, 'main menu loads from a lone file:// HTML');
  ok(await page.evaluate(() => document.fonts.check('italic 900 40px "Barlow Condensed"')), 'embedded fonts available');
  await page.screenshot({ path: path.join(out, 'standalone-menu.png') });
  await page.click('[data-action="play"]');
  await page.click('[data-mode="free"]');
  await page.click('[data-action="ride"]');
  await page.waitForFunction(() => window.__roost.state === 'riding', null, { timeout: 60000 });
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(3000);
  await page.keyboard.up('KeyW');
  ok(await page.evaluate(() => window.__roost.world.physics.speed) > 2, 'riding works');
  const au = await page.evaluate(() => ({ ready: window.__roost.audio.ready, worklet: !!window.__roost.audio.engineNode }));
  ok(au.ready && au.worklet, 'audio worklet engine runs from file://');
  await page.screenshot({ path: path.join(out, 'standalone-ride.png') });
  await page.keyboard.press('Escape');
  await page.click('#screen-pause [data-action="garage"]');
  await page.waitForSelector('#screen-garage.active');
  await page.click('#garage-tabs [data-gtab="import"]');
  for (const f of ['test-bike.glb', 'test-bike-draco.glb']) {
    await page.setInputFiles('#garage-body input[type=file]', path.join(__dirname, 'fixtures', f));
    await page.waitForFunction(() => /Loaded|fail/i.test(document.getElementById('garage-status').textContent), null, { timeout: 30000 }).catch(() => {});
    const st = await page.textContent('#garage-status');
    ok(/^Loaded/.test(st), f + ' imports: ' + st.slice(0, 70));
    await page.evaluate(() => (document.getElementById('garage-status').textContent = ''));
  }
  await page.click('button:has-text("Save & use")');
  await page.waitForFunction(() => window.__roost.settings.game.activeBike !== 'procedural', null, { timeout: 15000 }).then(() => ok(true, 'imported bike saved (IndexedDB on file://)')).catch(() => ok(false, 'saving imported bike'));
  console.log(logs.slice(0, 10).join('\n'));
  console.log(fails ? fails + ' FAILURES' : 'STANDALONE OK');
  await browser.close();
})().catch((e) => { console.error('STANDALONE TEST CRASHED', e); process.exit(1); });

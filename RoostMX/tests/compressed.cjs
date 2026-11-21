// Imports Draco and Meshopt compressed GLBs in the garage: node tests/compressed.cjs [url]
const { chromium } = require('playwright');
const path = require('path');
const url = process.argv[2] || 'http://localhost:8765/';
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const logs = [];
  page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') logs.push('[error] ' + m.text()); });
  await page.addInitScript(() => localStorage.setItem('roostmx.settings.v1', JSON.stringify({ graphics: { quality: 'low', fullscreen: false } })));
  await page.goto(url);
  await page.waitForSelector('#screen-main.active', { timeout: 120000 });
  await page.click('[data-action="garage"]');
  await page.waitForSelector('#screen-garage.active');
  await page.click('#garage-tabs [data-gtab="import"]');
  let fails = 0;
  for (const f of ['test-bike-draco.glb', 'test-bike-meshopt.glb', ['test-bike.obj', 'test-bike.mtl']]) {
    const files = (Array.isArray(f) ? f : [f]).map((x) => path.join(__dirname, 'fixtures', x));
    await page.setInputFiles('#garage-body input[type=file]', files);
    try {
      await page.waitForFunction(() => /Loaded|failed|Failed/.test(document.getElementById('garage-status').textContent), null, { timeout: 30000 });
    } catch (e) { /* timeout */ }
    const st = await page.textContent('#garage-status');
    const good = /^Loaded/.test(st) && /(8 meshes|8 meshes)/.test(st) || (/^Loaded/.test(st) && Array.isArray(f));
    if (!good) fails++;
    console.log((good ? '  ok   ' : '  FAIL ') + f + ': ' + st.slice(0, 110));
    await page.evaluate(() => (document.getElementById('garage-status').textContent = ''));
  }
  console.log(logs.join('\n'));
  console.log(fails ? fails + ' FAILURES' : 'ALL OK');
  await browser.close();
})();

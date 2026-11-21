// Captures documentation screenshots at High quality: node tests/screenshots.cjs <outDir> [url]
const { chromium } = require('playwright');
const path = require('path');
const out = process.argv[2] || 'docs';
const url = process.argv[3] || 'http://localhost:8765/';
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await page.addInitScript(() => localStorage.setItem('roostmx.settings.v1', JSON.stringify({ graphics: { quality: 'high', fullscreen: false } })));
  await page.goto(url);
  await page.waitForSelector('#screen-main.active', { timeout: 300000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(out, 'menu.jpg'), type: 'jpeg', quality: 82 });
  await page.evaluate(() => { const g = window.__roost; g.settings.game.mode = 'free'; g.startRide(); });
  await page.waitForFunction(() => window.__roost.state === 'riding', null, { timeout: 120000, polling: 500 });
  // put the bike on the approach to the first double, at speed, and let it fly
  await page.evaluate(() => {
    const g = window.__roost, w = g.world, tr = w.track, ph = w.physics;
    const f = tr.features.find((x) => x.type === 'double');
    const s = f.lips[0] - 12;
    const p = tr.pose(s, 0);
    ph.reset({ x: p.x, y: 0, z: p.z }, p.heading);
    ph.vel.set(Math.sin(p.heading) * 15.5, 0, Math.cos(p.heading) * 15.5);
    for (const wh of ph.wheels) wh.omega = 15.5 / wh.radius;
    ph.engine.gear = 3;
    w.rig.snapNext = true;
    window.__hold = true;
  });
  await page.waitForFunction(() => window.__roost.world.physics.airborne && window.__roost.world.physics.airTime > 0.45, null, { timeout: 120000, polling: 50 }).catch(() => {});
  await page.screenshot({ path: path.join(out, 'jump.jpg'), type: 'jpeg', quality: 82 });
  await page.evaluate(() => { window.__roost.pause(); window.__roost.openGarage(); });
  await page.waitForFunction(() => window.__roost.state === 'garage', null, { timeout: 60000, polling: 500 });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: path.join(out, 'garage.jpg'), type: 'jpeg', quality: 82 });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

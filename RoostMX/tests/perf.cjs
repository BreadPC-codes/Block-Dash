// Performance probe: node tests/perf.cjs <quality> [url]
// Rides on Ridgeback with a fixed input pattern and reports frame time, JS time,
// draw calls and triangles. Under SwiftShader the frame time is CPU rasterisation,
// so it is a fair *relative* measure of GPU work between builds.
const { chromium } = require('playwright');
const quality = process.argv[2] || 'low';
const url = process.argv[3] || 'http://localhost:8765/';
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await page.addInitScript((q) => localStorage.setItem('roostmx.settings.v1', JSON.stringify({ graphics: { quality: q, fullscreen: false, showFps: false, dynamicRes: false }, game: { track: 'ridgeback', mode: 'free' } })), quality);
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForSelector('#screen-main.active', { timeout: 300000 });
  const loadS = (Date.now() - t0) / 1000;
  await page.evaluate(() => { const g = window.__roost; g.startRide(); });
  await page.waitForFunction(() => window.__roost.state === 'riding', null, { timeout: 60000, polling: 200 });
  // instrument
  await page.evaluate(() => {
    const g = window.__roost;
    const stats = { frames: 0, upd: 0, ren: 0, calls: 0, tris: 0, maxCalls: 0 };
    window.__perf = stats;
    const ou = g.updateRide.bind(g), or = g.render.bind(g);
    g.updateRide = (dt, inp) => { const a = performance.now(); ou(dt, inp); stats.upd += performance.now() - a; };
    g.render = () => { const a = performance.now(); or(); stats.ren += performance.now() - a; stats.frames++; const i = g.renderer.info.render; stats.calls += i.calls; stats.tris += i.triangles; stats.maxCalls = Math.max(stats.maxCalls, i.calls); };
  });
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2000);
  await page.evaluate(() => { const s = window.__perf; s.frames = s.upd = s.ren = s.calls = s.tris = s.maxCalls = 0; s.t = performance.now(); });
  await page.waitForTimeout(8000);
  await page.keyboard.up('KeyW');
  const r = await page.evaluate(() => { const s = window.__perf; const T = performance.now() - s.t; return { fps: s.frames / (T / 1000), frameMs: T / s.frames, updMs: s.upd / s.frames, renMs: s.ren / s.frames, calls: s.calls / s.frames, maxCalls: s.maxCalls, tris: s.tris / s.frames, heap: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0 }; });
  console.log(`${quality.padEnd(6)} load ${loadS.toFixed(1)}s | fps ${r.fps.toFixed(1)} frame ${r.frameMs.toFixed(1)}ms (update ${r.updMs.toFixed(2)}ms, render ${r.renMs.toFixed(1)}ms) | calls ${r.calls.toFixed(0)} (max ${r.maxCalls}) | tris ${(r.tris / 1000).toFixed(0)}k | heap ${r.heap.toFixed(0)}MB`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

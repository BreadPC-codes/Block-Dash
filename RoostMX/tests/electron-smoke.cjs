// Launches the packaged-style Electron app and checks it boots: xvfb-run node tests/electron-smoke.cjs <outDir>
const { _electron: electron } = require('playwright');
const path = require('path');
(async () => {
  const out = process.argv[2] || '.';
  const app = await electron.launch({
    executablePath: require('path').join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron'),
    args: [path.join(__dirname, '..'), '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'false' },
  });
  const logs = [];
  const page = await app.firstWindow();
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
  await page.evaluate(() => { try { localStorage.setItem('roostmx.settings.v1', JSON.stringify({ graphics: { quality: 'low', fullscreen: false } })); } catch (e) {} });
  await page.reload();
  await page.waitForSelector('#screen-main.active', { timeout: 90000 });
  console.log('title:', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()));
  console.log('url:', page.url());
  console.log('native api:', await page.evaluate(() => JSON.stringify({ isElectron: window.roostNative && window.roostNative.isElectron, fs: window.roostNative && window.roostNative.isFullscreenSync() })));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, 'e1-menu.png') });
  // fullscreen toggle through the settings path
  await page.evaluate(() => window.__roost.setFullscreen(true));
  await page.waitForTimeout(800);
  console.log('fullscreen after toggle:', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()));
  await page.evaluate(() => window.__roost.setFullscreen(false));
  await page.waitForTimeout(500);
  // quit through the menu button
  const closed = new Promise((r) => app.on('close', r));
  await page.click('[data-action="quit"]');
  await Promise.race([closed, new Promise((r) => setTimeout(r, 5000))]);
  console.log('app closed via Quit button');
  console.log('LOGS:\n' + logs.filter((l) => !/GPU stall|KHR_parallel/.test(l)).slice(0, 20).join('\n'));
})().catch((e) => { console.error('ELECTRON TEST FAILED', e); process.exit(1); });

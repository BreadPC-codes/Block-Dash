// Virtual gamepad test: node tests/gamepad.cjs <outDir> [url]
const { chromium } = require('playwright');
const path = require('path');
const out = process.argv[2] || '.';
const url = process.argv[3] || 'http://localhost:8765/';
let failures = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) failures++; };
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const logs = [];
  page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') logs.push('[error] ' + m.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('roostmx.settings.v1', JSON.stringify({ graphics: { quality: 'low', fullscreen: false }, game: { mode: 'free' } }));
    // virtual Xbox-style pad
    const pad = { id: 'Virtual Xbox Controller (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0,
      axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
    window.__pad = pad;
    window.__setBtn = (i, v) => { pad.buttons[i] = { pressed: v > 0.5, touched: v > 0, value: v }; pad.timestamp++; };
    window.__padOn = false;
    navigator.getGamepads = () => (window.__padOn ? [pad, null, null, null] : [null, null, null, null]);
  });
  await page.goto(url);
  await page.waitForSelector('#screen-main.active', { timeout: 120000 });
  await page.evaluate(() => { window.__padOn = true; window.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: window.__pad })); });
  await page.waitForTimeout(400);
  ok(/Controller/.test(await page.textContent('#pad-status')), 'controller detected: ' + (await page.textContent('#pad-status')));
  ok(await page.isVisible('.toast'), 'on-screen notification shown');
  const press = async (b) => { await page.evaluate((b) => window.__setBtn(b, 1), b); await page.waitForTimeout(150); await page.evaluate((b) => window.__setBtn(b, 0), b); await page.waitForTimeout(150); };
  // menu navigation: down (13) twice then A (0) -> Garage? first item focused is Play; press A on Play
  await press(0);
  await page.waitForTimeout(300);
  ok(await page.isVisible('#screen-play.active'), 'A opens Play');
  await press(1);
  await page.waitForTimeout(300);
  ok(await page.isVisible('#screen-main.active'), 'B goes back');
  await press(0);
  await page.waitForTimeout(300);
  // focus the Ride button via d-pad and press A
  await page.focus('[data-action="ride"]');
  await page.evaluate(() => window.__roost.ui.setFocus(document.querySelector('[data-action="ride"]'), true));
  await press(0);
  await page.waitForFunction(() => window.__roost.state === 'riding', null, { timeout: 30000 });
  ok(true, 'A on Ride starts riding');
  // throttle with RT (7), steer with left stick
  await page.evaluate(() => window.__setBtn(7, 1));
  await page.waitForTimeout(3500);
  const s1 = await page.evaluate(() => ({ thr: window.__roost.input.state.throttle, v: window.__roost.world.physics.speed, dev: window.__roost.input.lastDevice }));
  ok(s1.thr > 0.95 && s1.v > 2, `RT throttle accelerates (thr ${s1.thr.toFixed(2)}, ${s1.v.toFixed(1)} m/s, device ${s1.dev})`);
  await page.evaluate(() => { window.__pad.axes[0] = -0.8; });
  await page.waitForTimeout(1200);
  const s2 = await page.evaluate(() => ({ steer: window.__roost.input.state.steer, lean: window.__roost.world.physics.leanAngle }));
  ok(s2.steer < -0.5 && s2.lean < -0.05, `left stick steers and leans the bike (steer ${s2.steer.toFixed(2)}, lean ${(s2.lean * 57.3).toFixed(0)}°)`);
  await page.evaluate(() => { window.__pad.axes[0] = 0; window.__setBtn(7, 0); window.__setBtn(6, 1); });
  await page.waitForTimeout(800);
  const s3 = await page.evaluate(() => window.__roost.input.state.brakeF);
  ok(s3 > 0.9, 'LT applies the brake');
  await page.evaluate(() => window.__setBtn(6, 0));
  const cam0 = await page.evaluate(() => window.__roost.world.rig.mode);
  await press(3);
  ok(await page.evaluate(() => window.__roost.world.rig.mode) !== cam0, 'Y changes camera');
  await press(9);
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => window.__roost.state) === 'paused', 'Start pauses');
  await press(9);
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => window.__roost.state) === 'riding', 'Start resumes');
  // disconnect -> auto pause + toast
  await page.evaluate(() => { window.__pad.connected = false; window.dispatchEvent(Object.assign(new Event('gamepaddisconnected'), { gamepad: window.__pad })); });
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => window.__roost.state) === 'paused', 'disconnect pauses the game');
  // audio
  await page.mouse.click(640, 360);
  await page.waitForTimeout(1500);
  const au = await page.evaluate(() => ({ ready: window.__roost.audio.ready, worklet: !!window.__roost.audio.engineNode, fallback: !!window.__roost.audio.fallback, state: window.__roost.audio.ctx && window.__roost.audio.ctx.state }));
  ok(au.ready && (au.worklet || au.fallback), `audio initialised (worklet ${au.worklet}, fallback ${au.fallback}, ${au.state})`);
  console.log(logs.slice(0, 10).join('\n'));
  console.log(failures ? `${failures} FAILURES` : 'ALL GAMEPAD/AUDIO OK');
  await browser.close();
})().catch((e) => { console.error('GAMEPAD TEST CRASHED', e); process.exit(1); });

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
    // a layout saved by the previous version (rider forward/back on the right stick) must migrate
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('roostmx.settings.v1', JSON.stringify({ graphics: { quality: 'low', fullscreen: false }, game: { mode: 'free' }, controls: { padVersion: 2, pad: { leanForward: ['a3-', ''], leanBack: ['a3+', ''] } } }));
    }
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
  const mig = await page.evaluate(() => ({ f: window.__roost.settings.controls.pad.leanForward[0], b: window.__roost.settings.controls.pad.leanBack[0], v: window.__roost.settings.controls.padVersion }));
  ok(mig.f === 'a1-' && mig.b === 'a1+' && mig.v === 3, `old saved layout migrated: rider forward/back on the left stick (${mig.f} / ${mig.b}, v${mig.v})`);
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
  // right stick moves the rider separately from the bike (MX Bikes style)
  // the hard brake above may have tucked the front: start the rider-lean check from a fresh bike
  await page.evaluate(() => window.__roost.resetBike());
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.__setBtn(7, 0.6); window.__pad.axes[2] = 0.9; });
  await page.waitForTimeout(900);
  const r1 = await page.evaluate(() => ({ side: window.__roost.input.state.side, rs: window.__roost.world.physics.riderSide, steer: window.__roost.input.state.steer, comLean: window.__roost.world.physics.comLean, crashed: window.__roost.world.physics.crashed, why: window.__roost.world.physics.crashReason, st: window.__roost.state, v: window.__roost.world.physics.speed }));
  ok(!r1.crashed && r1.side > 0.8 && r1.rs > 0.6 && Math.abs(r1.steer) < 0.05 && r1.comLean > 0.05, `right stick X leans the rider, not the steering (input ${r1.side.toFixed(2)}, rider ${r1.rs.toFixed(2)}, steer ${r1.steer.toFixed(2)}, CoM shift ${(r1.comLean * 57.3).toFixed(1)}°)`);
  await page.evaluate(() => { window.__pad.axes[2] = 0; window.__pad.axes[1] = -0.9; });
  await page.waitForTimeout(500);
  const r2 = await page.evaluate(() => ({ lean: window.__roost.input.state.lean, steer: window.__roost.input.state.steer }));
  ok(r2.lean > 0.8 && Math.abs(r2.steer) < 0.05, `left stick up leans the rider forward without steering (${r2.lean.toFixed(2)})`);
  await page.evaluate(() => { window.__pad.axes[1] = 0.9; });
  await page.waitForTimeout(500);
  const r3 = await page.evaluate(() => window.__roost.input.state.lean);
  ok(r3 < -0.8, `left stick down leans the rider back (${r3.toFixed(2)})`);
  await page.evaluate(() => { window.__pad.axes[1] = 0; window.__setBtn(7, 0); window.__setBtn(15, 1); });
  const yaw0 = await page.evaluate(() => window.__roost.world.rig.yawOff);
  await page.waitForTimeout(500);
  const yaw1 = await page.evaluate(() => window.__roost.world.rig.yawOff);
  await page.evaluate(() => window.__setBtn(15, 0));
  ok(Math.abs(yaw1 - yaw0) > 0.3, `d-pad right orbits the camera (${yaw0.toFixed(2)} -> ${yaw1.toFixed(2)})`);
  const cam0 = await page.evaluate(() => window.__roost.world.rig.mode);
  await press(3);
  ok(await page.evaluate(() => window.__roost.world.rig.mode) !== cam0, 'Y changes camera');
  await press(9);
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => window.__roost.state) === 'paused', 'Start pauses');
  await press(9);
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => window.__roost.state) === 'riding', 'Start resumes');
  // remap throttle to the A button in Settings > Controls with the controller itself
  await press(9);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__roost.ui.go('settings'));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__roost.ui.showSettingsTab('controls'));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__roost.ui.setFocus(document.querySelector('[data-bind="pad:throttle:0"]'), true));
  await press(0); // A on the slot starts listening (that press must not be captured)
  await page.waitForTimeout(200);
  const listening = await page.evaluate(() => !!window.__roost.input.pad.capture && /Press/.test(document.querySelector('[data-bind="pad:throttle:0"]').textContent));
  ok(listening, 'A on a controller slot starts listening');
  await press(0); // the next press is the new binding
  await page.waitForTimeout(300);
  const bind = await page.evaluate(() => ({ thr: window.__roost.settings.controls.pad.throttle[0], reset: window.__roost.settings.controls.pad.reset[0], label: document.querySelector('[data-bind="pad:throttle:0"]').textContent, saved: JSON.parse(localStorage.getItem('roostmx.settings.v1')).controls.pad.throttle[0] }));
  ok(bind.thr === 'b0' && bind.label === 'A' && bind.saved === 'b0', `throttle remapped to A (${bind.thr}, shown as "${bind.label}", saved)`);
  ok(bind.reset !== 'b0', 'A removed from its previous action (reset) to avoid conflicts');
  // map rider lean right to a stick by moving it
  await page.evaluate(() => window.__roost.ui.setFocus(document.querySelector('[data-bind="pad:riderRight:1"]'), true));
  await press(0);
  await page.evaluate(() => { window.__pad.axes[1] = 0.95; });
  await page.waitForTimeout(250);
  await page.evaluate(() => { window.__pad.axes[1] = 0; });
  await page.waitForTimeout(250);
  const bind2 = await page.evaluate(() => window.__roost.settings.controls.pad.riderRight[1]);
  ok(bind2 === 'a1+', `moving a stick binds that axis direction (${bind2})`);
  // the new throttle button works when riding
  await page.evaluate(() => { const g = window.__roost; g.ui.go('pause', { push: false }); g.resume(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__setBtn(0, 1));
  await page.waitForTimeout(800);
  const thrA = await page.evaluate(() => ({ thr: window.__roost.input.state.throttle, st: window.__roost.state }));
  await page.evaluate(() => window.__setBtn(0, 0));
  ok(thrA.thr > 0.9 && thrA.st === 'riding', `A now opens the throttle while riding (${thrA.thr.toFixed(2)})`);
  // reset controller bindings to defaults
  await press(9);
  await page.waitForTimeout(300);
  await page.evaluate(() => { const g = window.__roost; g.ui.go('settings'); g.ui.showSettingsTab('controls'); });
  await page.evaluate(() => Array.from(document.querySelectorAll('#settings-body .btn')).find((b) => /Reset controller/.test(b.textContent)).click());
  await page.waitForTimeout(200);
  ok(await page.evaluate(() => window.__roost.settings.controls.pad.throttle[0] === 'b7' && window.__roost.settings.controls.pad.reset[0] === 'b0'), 'Reset controller restores the defaults');
  await page.evaluate(() => { const g = window.__roost; g.ui.go('pause', { push: false }); });
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

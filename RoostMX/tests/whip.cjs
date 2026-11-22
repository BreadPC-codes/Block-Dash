// Whips in the real game: node tests/whip.cjs <outDir> [url]
// Rides big jumps on the Big Air Line, whips with the keyboard (A/D) and with a virtual
// controller (left stick), and checks the physics debug overlay (F3), the rider's
// counterbalance and the landings.
const { chromium } = require('playwright');
const path = require('path');
const dir = (process.argv[2] || '.') + path.sep;
const url = process.argv[3] || 'http://localhost:8765/';
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const DEG = 180 / Math.PI;

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('roostmx.settings.v1', JSON.stringify({ graphics: { quality: 'low', fullscreen: false, dynamicRes: false }, game: { track: 'jumpline', mode: 'free' } }));
    const pad = { id: 'Virtual Xbox Controller (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0,
      axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
    window.__pad = pad;
    window.__padOn = false;
    navigator.getGamepads = () => (window.__padOn ? [pad, null, null, null] : [null, null, null, null]);
  });
  await page.goto(url);
  await page.waitForSelector('#screen-main.active', { timeout: 300000 });
  const def = await page.evaluate(() => ({ dbg: window.__roost.settings.graphics.physicsDebug, air: window.__roost.settings.bike.airControl }));
  ok(def.dbg === false, 'physics debug overlay is off by default');
  ok(def.air === 1, 'Air control setting defaults to 100 %');
  await page.evaluate(() => window.__roost.selectTrack('jumpline'));
  await page.waitForFunction(() => window.__roost.world && window.__roost.world.def.id === 'jumpline' && window.__roost.state !== 'loading', null, { timeout: 300000, polling: 300 });
  await page.evaluate(() => window.__roost.startRide());
  await page.waitForFunction(() => window.__roost.state === 'riding', null, { timeout: 60000, polling: 200 });
  await page.waitForTimeout(1200);
  ok(!(await page.isVisible('#whip-debug')), 'overlay hidden while riding');
  await page.keyboard.press('F3');
  await page.waitForTimeout(300);
  ok(await page.isVisible('#whip-debug'), 'F3 shows the overlay');
  const txt0 = await page.textContent('#whip-debug');
  ok(/WHIP \/ AIR PHYSICS/.test(txt0) && /whip angle/.test(txt0) && /recovery/.test(txt0) && /torque/.test(txt0) && /input/.test(txt0), 'overlay lists whip angle, torques, recovery and inputs');

  // Air control setting reaches the physics
  await page.evaluate(() => { window.__roost.settings.bike.airControl = 1.3; window.__roost.applySetting('bike.airControl', 1.3); });
  ok(await page.evaluate(() => window.__roost.world.physics.tune.airControl === 1.3), 'Air control setting applies to the physics');
  await page.evaluate(() => { window.__roost.settings.bike.airControl = 1; window.__roost.applySetting('bike.airControl', 1); });

  // Put the bike on the run-up of a big jump. A small controller in front of the physics
  // holds the jump's speed hint up to the lip; after that only the real inputs act.
  const setup = async (index) => page.evaluate((index) => {
    const g = window.__roost, w = g.world, tr = w.track, ph = w.physics;
    const jumps = tr.features.filter((f) => f.type === 'double' && f.spec.speed >= 19);
    const f = jumps[index];
    const v = f.spec.speed;
    const p = tr.pose(f.s0 - 30, 0);
    g.resetBike();
    ph.reset({ x: p.x, y: 0, z: p.z }, p.heading);
    ph.vel.set(p.tx * v, 0, p.tz * v);
    for (const wh of ph.wheels) wh.omega = v / wh.radius;
    w.rig.snapNext = true;
    const lip = tr.pose(f.lips[0], 0);
    const state = { lip, tx: p.tx, tz: p.tz, v, leftLip: false, maxWhip: 0, maxTwist: 0, maxCounter: 0, maxRoll: 0, air: 0, landed: false, crashed: '', overlayAir: false };
    window.__whipTest = state;
    if (!ph.__origStep) ph.__origStep = ph.step;
    ph.step = function (dt, inp) {
      const s = window.__whipTest;
      const along = (this.pos.x - s.lip.x) * s.tx + (this.pos.z - s.lip.z) * s.tz;
      if (!s.leftLip) {
        if (this.airborne && along > -1) s.leftLip = true;
        else inp.throttle = Math.min(1, Math.max(0, (s.v - this.forwardSpeed) * 0.9 + 0.65));
      }
      this.__origStep(dt, inp);
      if (s.leftLip && !s.landed) {
        if (this.airborne) s.air += dt;
        const W = this.whip;
        if (Math.abs(W.whipAngle) > Math.abs(s.maxWhip)) s.maxWhip = W.whipAngle;
        if (Math.abs(W.riderTwist) > Math.abs(s.maxTwist)) s.maxTwist = W.riderTwist;
        // counterbalance: the rider's upper body turns against the whip
        s.maxCounter = Math.max(s.maxCounter, -W.riderTwist * Math.sign(W.whipAngle));
        s.maxRoll = Math.max(s.maxRoll, Math.abs(this.leanAngle));
        if (s.air > 0.3 && !this.airborne) s.landed = true;
      }
      if (this.crashed && !s.crashed) s.crashed = this.crashReason;
    };
    return { v, at: f.s0, gap: f.spec.gap, h: f.spec.h1 };
  }, index);

  const ride = async (label, index, whipDown, whipUp, shot) => {
    const info = await setup(index);
    await page.waitForFunction(() => window.__whipTest.leftLip, null, { timeout: 60000, polling: 30 });
    await page.waitForTimeout(80);
    await whipDown();
    await page.waitForTimeout(450);
    await whipUp();
    // screenshot around the peak of the whip, overlay on
    await page.waitForFunction(() => Math.abs(window.__roost.world.physics.whip.whipAngle) > 0.3 || window.__whipTest.landed, null, { timeout: 20000, polling: 30 });
    const txt = await page.textContent('#whip-debug');
    if (shot) await page.screenshot({ path: dir + shot });
    await page.waitForFunction(() => window.__whipTest.landed || window.__whipTest.crashed, null, { timeout: 30000, polling: 50 });
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => ({ ...window.__whipTest, crashedNow: window.__roost.world.physics.crashed }));
    console.log(`    ${label}: jump at ${info.at.toFixed(0)} m (${info.gap} m gap, ${info.v} m/s), air ${r.air.toFixed(2)} s, whip peak ${(r.maxWhip * DEG).toFixed(1)} deg, roll ${(r.maxRoll * DEG).toFixed(1)} deg, rider counter-twist ${(r.maxCounter * DEG).toFixed(1)} deg, ${r.crashed || 'rode away'}`);
    return { ...r, txt };
  };

  // 1) keyboard: D for 0.45 s
  const k = await ride('keyboard D', 0, () => page.keyboard.down('KeyD'), () => page.keyboard.up('KeyD'), 'whip-keyboard.png');
  ok(k.maxWhip * DEG > 15, `keyboard D whips the bike right (${(k.maxWhip * DEG).toFixed(1)} deg)`);
  ok(k.maxCounter * DEG > 4, `the rider's upper body counter-rotates (${(k.maxCounter * DEG).toFixed(1)} deg)`);
  ok(/AIRBORNE/.test(k.txt), 'overlay shows AIRBORNE in the air');
  ok(!k.crashed && !k.crashedNow, 'lands the whip and rides away');

  // 2) controller: left stick left for 0.45 s (keyboard untouched)
  await page.evaluate(() => { window.__padOn = true; window.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: window.__pad })); });
  await page.waitForTimeout(300);
  const c = await ride('left stick', 1, () => page.evaluate(() => { window.__pad.axes[0] = -1; window.__pad.timestamp++; }), () => page.evaluate(() => { window.__pad.axes[0] = 0; window.__pad.timestamp++; }), 'whip-pad.png');
  ok(c.maxWhip * DEG < -15, `left stick whips the bike left (${(c.maxWhip * DEG).toFixed(1)} deg)`);
  ok(/controller LS/.test(c.txt), 'overlay shows the controller axes');
  ok(!c.crashed && !c.crashedNow, 'lands the controller whip and rides away');

  // 3) keyboard and controller together: stick pitch + keyboard whip at the same time
  const both = await ride('stick back + D', 2, () => page.evaluate(() => { window.__pad.axes[1] = 0.6; window.__pad.timestamp++; }).then(() => page.keyboard.down('KeyD')), () => page.evaluate(() => { window.__pad.axes[1] = 0; window.__pad.timestamp++; }).then(() => page.keyboard.up('KeyD')), null);
  ok(both.maxWhip * DEG > 15, `keyboard whip still works while the stick is used for pitch (${(both.maxWhip * DEG).toFixed(1)} deg)`);

  // F3 hides it again
  await page.keyboard.press('F3');
  await page.waitForTimeout(300);
  ok(!(await page.isVisible('#whip-debug')), 'F3 hides the overlay');
  ok(await page.evaluate(() => window.__roost.settings.graphics.physicsDebug === false), 'setting follows F3');
  await page.evaluate(() => { const ph = window.__roost.world.physics; if (ph.__origStep) { ph.step = ph.__origStep; delete ph.__origStep; } });
  ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  console.log(fails ? fails + ' FAILURES' : 'WHIPS OK');
  await browser.close();
  process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });

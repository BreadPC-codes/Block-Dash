const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 6).join('\n')));
  page.on('requestfailed', (r) => logs.push('[reqfail] ' + r.url() + ' ' + (r.failure() && r.failure().errorText)));
  await page.goto(process.argv[2] || 'http://localhost:8765/');
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(2500);
    const s = await page.evaluate(() => ({ text: document.getElementById('loading-text').textContent, fill: document.getElementById('loading-fill').style.width, state: window.__roost && window.__roost.state, gl: !!document.getElementById('gl').getContext }));
    console.log(i, JSON.stringify(s));
    if (s.state === 'menu') break;
  }
  await page.screenshot({ path: process.argv[3] || '/tmp/diag.png' });
  console.log(logs.slice(0, 40).join('\n'));
  await browser.close();
})();

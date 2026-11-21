// Renders the app icon with headless Chromium (Playwright) and writes
// assets/icons/icon.png (512) and a multi-size assets/icons/icon.ico.
// Dev-only helper: node scripts/make-icons.cjs   (needs `playwright` available)
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const fontUrl = 'file://' + path.join(root, 'assets/fonts/barlow-condensed-latin-900-italic.woff2');
const html = `<!doctype html><html><head><style>
@font-face{font-family:BC;font-weight:900;font-style:italic;src:url(${fontUrl})}
body{margin:0;background:transparent}</style></head><body><canvas id=c width=512 height=512></canvas>
<script>
document.fonts.load('italic 900 100px BC').then(()=>{
const c=document.getElementById('c'),x=c.getContext('2d');
const r=96;x.beginPath();x.moveTo(r,0);x.arcTo(512,0,512,512,r);x.arcTo(512,512,0,512,r);x.arcTo(0,512,0,0,r);x.arcTo(0,0,512,0,r);x.closePath();
const g=x.createLinearGradient(0,0,512,512);g.addColorStop(0,'#1c1c20');g.addColorStop(1,'#08080a');x.fillStyle=g;x.fill();
x.save();x.clip();
// roost spray
x.fillStyle='rgba(242,106,16,0.18)';for(let i=0;i<70;i++){const a=Math.random()*Math.PI*0.5+Math.PI*0.95,d=Math.random()*240;x.beginPath();x.arc(150+Math.cos(a)*d,400+Math.sin(a)*d*0.5,3+Math.random()*9,0,7);x.fill();}
x.restore();
x.save();x.translate(256,226);x.transform(1,0,-0.22,1,0,0);
x.font='italic 900 330px BC';x.textAlign='center';x.textBaseline='middle';x.fillStyle='#ffffff';x.fillText('R',-6,0);x.restore();
x.save();x.translate(256,400);x.transform(1,0,-0.25,1,0,0);x.fillStyle='#f26a10';x.fillRect(-150,-58,300,116);
x.font='italic 900 120px BC';x.textAlign='center';x.textBaseline='middle';x.fillStyle='#111';x.fillText('MX',0,6);x.restore();
document.title='done';});
</script></body></html>`;
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  const tmp = path.join(root, 'assets/icons/_icon.html');
  fs.writeFileSync(tmp, html);
  await page.goto('file://' + tmp);
  await page.waitForFunction(() => document.title === 'done');
  const dataUrl = await page.evaluate(() => document.getElementById('c').toDataURL('image/png'));
  const png512 = Buffer.from(dataUrl.split(',')[1], 'base64');
  fs.writeFileSync(path.join(root, 'assets/icons/icon.png'), png512);
  const sizes = [256, 128, 64, 48, 32, 16];
  const pngs = [];
  for (const s of sizes) {
    const d = await page.evaluate((s) => { const o = document.createElement('canvas'); o.width = o.height = s; const x = o.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(document.getElementById('c'), 0, 0, s, s); return o.toDataURL('image/png'); }, s);
    pngs.push(Buffer.from(d.split(',')[1], 'base64'));
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + 16 * sizes.length;
  sizes.forEach((s, i) => {
    const o = i * 16;
    dir.writeUInt8(s >= 256 ? 0 : s, o); dir.writeUInt8(s >= 256 ? 0 : s, o + 1);
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(pngs[i].length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += pngs[i].length;
  });
  fs.writeFileSync(path.join(root, 'assets/icons/icon.ico'), Buffer.concat([header, dir, ...pngs]));
  fs.unlinkSync(tmp);
  await browser.close();
  console.log('icons written');
})();

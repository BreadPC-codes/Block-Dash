// Builds play/index.html: the whole game in ONE file (code, styles, fonts, icon and the
// Draco decoder inlined) that runs by double-clicking it - no install, no server.
// Usage: node scripts/build-standalone.mjs
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.join(root, p);

const result = await esbuild.build({
  entryPoints: [rel('src/main.js')],
  bundle: true,
  format: 'iife',
  target: ['chrome110', 'firefox115', 'safari16'],
  minify: true,
  legalComments: 'none',
  write: false,
  define: { 'import.meta.url': 'document.baseURI' },
  logLevel: 'warning',
});
// keep the HTML parser from ending the inline script early
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

const b64 = (p) => fs.readFileSync(rel(p)).toString('base64');
const css = fs
  .readFileSync(rel('styles.css'), 'utf8')
  .replace(/url\((assets\/fonts\/[^)]+\.woff2)\)/g, (m, p) => `url(data:font/woff2;base64,${b64(p)})`);

// 64 px PNG from the .ico for the favicon
const ico = fs.readFileSync(rel('assets/icons/icon.ico'));
let favicon = '';
for (let i = 0; i < ico.readUInt16LE(4); i++) {
  const o = 6 + i * 16;
  if (ico[o] === 64) favicon = ico.subarray(ico.readUInt32LE(o + 12), ico.readUInt32LE(o + 12) + ico.readUInt32LE(o + 8)).toString('base64');
}

const dracoDir = 'node_modules/three/examples/jsm/libs/draco/gltf';
const decoders =
  '<script>(function(){function u(s,t){var r=atob(s),a=new Uint8Array(r.length);for(var i=0;i<r.length;i++)a[i]=r.charCodeAt(i);' +
  'return URL.createObjectURL(new Blob([a],{type:t}));}' +
  `window.__ROOST_DECODERS={draco:{js:u("${b64(dracoDir + '/draco_wasm_wrapper.js')}","text/javascript"),` +
  `wasm:u("${b64(dracoDir + '/draco_decoder.wasm')}","application/wasm")}};})();</script>`;

let html = fs.readFileSync(rel('index.html'), 'utf8');
const swap = (from, to) => {
  const found = from instanceof RegExp ? from.test(html) : html.includes(from);
  if (!found) throw new Error('marker not found: ' + from);
  html = html.replace(from, () => to);
};
swap(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/, '');
swap('<link rel="icon" href="assets/icons/icon.png">', favicon ? `<link rel="icon" href="data:image/png;base64,${favicon}">` : '');
swap('<link rel="stylesheet" href="styles.css">', `<style>\n${css}\n</style>`);
swap('<script src="dist/game.js"></script>', `${decoders}\n<script>\n${js}\n</script>`);

fs.mkdirSync(rel('play'), { recursive: true });
fs.writeFileSync(rel('play/index.html'), html);
console.log(`play/index.html written (${(html.length / 1048576).toFixed(2)} MB)`);

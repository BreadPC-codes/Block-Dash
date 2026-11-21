// Bundles src/ into dist/game.js (single classic script, works from file:// too)
// and copies the Draco / Basis decoders used by the GLB importer.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev') || watch;

function copyDir(src, dst, filter = () => true) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f);
    if (fs.statSync(s).isFile() && filter(f)) fs.copyFileSync(s, path.join(dst, f));
  }
}
const libs = path.join(root, 'node_modules/three/examples/jsm/libs');
copyDir(path.join(libs, 'draco/gltf'), path.join(root, 'dist/draco'), (f) => !f.includes('encoder'));
copyDir(path.join(libs, 'basis'), path.join(root, 'dist/basis'), (f) => f.endsWith('.js') || f.endsWith('.wasm'));

const opts = {
  entryPoints: [path.join(root, 'src/main.js')],
  bundle: true,
  format: 'iife',
  target: ['chrome110'],
  outfile: path.join(root, 'dist/game.js'),
  minify: !dev,
  sourcemap: dev ? 'linked' : false,
  legalComments: 'none',
  logLevel: 'info',
};
if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  console.log('watching src/ ...');
} else {
  await esbuild.build(opts);
}

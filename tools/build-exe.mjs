#!/usr/bin/env node
// Builds BlockDash.exe: one file for Windows with the game, the rooms server and Three.js inside. Double-click it and
// it starts the server (rooms for everyone on your Wi-Fi) and opens the game. Nothing to install, no internet needed.
//
//   node tools/build-exe.mjs                 → dist/BlockDash.exe   (Windows x64)
//   node tools/build-exe.mjs --target linux  → dist/blockdash-linux (Linux x64, the same thing; handy for testing)
//
// Run it with Node.js 20.12 or newer (22 recommended), from any system. It's a Node.js "single executable
// application": a copy of Node.js itself (node.exe, the very version running this script, from nodejs.org unless this
// is Windows) with server.js as its program and index.html and Three.js (from npm) packed in as assets. The icon and
// the name in its properties are Block Dash's own. Downloads are checked against their published checksums, and
// cached in .build-cache/ (delete it to start afresh).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.build-cache');
const DIST = path.join(ROOT, 'dist');
const TARGET = process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : 'win';
const VERSION = '1.0.0';                                  // (shown in the exe's properties)
const TOOLS = { postject: '1.0.0-alpha.6', resedit: '3.1.0', 'pe-library': '2.0.1' };   // (pinned: known versions only)
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const say = (s) => console.log(`  ${s}`);
const sha = (algo, buf, enc = 'hex') => createHash(algo).update(buf).digest(enc);
async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
async function cached(name, make) {                       // a file in .build-cache, made once
  const file = path.join(CACHE, name);
  if (!fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, await make()); }
  return file;
}

// Three.js, the same version the game asks for, from the npm registry (checked against its published integrity).
async function threeJs() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const version = (html.match(/const THREE_VERSION = '([\d.]+)'/) || [])[1];
  if (!version) throw new Error('THREE_VERSION not found in index.html');
  return cached(`three-${version}.module.min.js`, async () => {
    say(`Three.js ${version} from npm…`);
    const meta = JSON.parse((await download(`https://registry.npmjs.org/three/${version}`)).toString());
    const tgz = await download(meta.dist.tarball);
    const [algo, want] = meta.dist.integrity.split('-');
    if (sha(algo, tgz, 'base64') !== want) throw new Error('three: the download does not match its integrity');
    const tar = zlib.gunzipSync(tgz);
    for (let off = 0; off + 512 <= tar.length;) {        // (a tar file: 512-byte headers, each followed by its file)
      const head = tar.subarray(off, off + 512);
      if (head.every((b) => b === 0)) break;
      const str = (a, b) => head.subarray(a, b).toString().replace(/\0.*$/s, '');
      const name = (str(345, 500) ? `${str(345, 500)}/` : '') + str(0, 100), size = parseInt(str(124, 136).trim() || '0', 8);
      if (name === 'package/build/three.module.min.js') return Buffer.from(tar.subarray(off + 512, off + 512 + size));
      off += 512 + Math.ceil(size / 512) * 512;
    }
    throw new Error('three.module.min.js not found in the three package');
  });
}

// The Node.js to build on: this one, or (building for Windows anywhere else) its Windows build from nodejs.org.
async function baseBinary() {
  if (TARGET === 'linux') {
    if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('--target linux: build it on Linux x64');
    return process.execPath;
  }
  if (TARGET !== 'win') throw new Error(`unknown --target ${TARGET} (win or linux)`);
  if (process.platform === 'win32' && process.arch === 'x64') return process.execPath;
  return cached(`node-${process.version}-win-x64.exe`, async () => {
    say(`Node.js ${process.version} for Windows from nodejs.org (about 80 MB)…`);
    const base = `https://nodejs.org/dist/${process.version}`;
    const sums = (await download(`${base}/SHASUMS256.txt`)).toString();
    const want = (sums.split('\n').find((l) => l.endsWith(' win-x64/node.exe')) || '').split(/\s+/)[0];
    const exe = await download(`${base}/win-x64/node.exe`);
    if (!want || sha('sha256', exe) !== want) throw new Error('node.exe does not match nodejs.org\'s SHASUMS256.txt');
    return exe;
  });
}

// The tools that edit the executable (postject puts the program in; resedit and pe-library set the icon and name).
function tools() {
  const dir = path.join(CACHE, 'tools');
  const ok = Object.entries(TOOLS).every(([n, v]) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', n, 'package.json'))).version === v; } catch { return false; } });
  if (!ok) {
    say('Tools from npm (postject, resedit)…');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true}');
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', '--save-exact', ...Object.entries(TOOLS).map(([n, v]) => `${n}@${v}`)],
      { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
  }
  return (name) => import(pathToFileURL(path.join(dir, 'node_modules', name, JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', name, 'package.json'))).main || 'dist/index.js')).href);
}

// A Windows executable carries a digital signature (node.exe's is the Node.js project's). Changing the file breaks
// it, so it comes off first, as `signtool remove /s` would: the certificate table is dropped from the end.
function stripSignature(buf) {
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('not a Windows executable');
  const opt = pe + 24, magic = buf.readUInt16LE(opt), dirs = opt + (magic === 0x20b ? 112 : 96), sec = dirs + 4 * 8;
  const at = buf.readUInt32LE(sec), size = buf.readUInt32LE(sec + 4);
  if (!at || !size) return buf;
  buf.writeUInt32LE(0, sec); buf.writeUInt32LE(0, sec + 4);
  buf.writeUInt32LE(0, opt + 64);                         // (the header checksum, no longer right either)
  return at + size >= buf.length - 8 ? buf.subarray(0, at) : buf;
}

// Block Dash's icon: a 16 × 16 pixel-art block with a B on it (the logo's first tile), drawn here and scaled up in whole
// pixels to each size an icon needs, as PNGs in an .ico.
const ICON = [
  '................',
  '..############..',
  '.#hhhhhhhhhhhh#.',
  '.#hhhhhhhhhhhy#.',
  '.#hhhBBBBhhhyy#.',
  '.#hhhBhhhBhyyy#.',
  '.#hhhBhhhByyyy#.',
  '.#hhhBBBByyyyy#.',
  '.#hhhByyyByyyy#.',
  '.#hhyByyyByyyy#.',
  '.#hyyBBBByyyyy#.',
  '.#yyyyyyyyyyyy#.',
  '.#oooooooooooo#.',
  '.#oooooooooooo#.',
  '..############..',
  '................',
];
const ICON_COLORS = { '#': [74, 34, 0], h: [255, 236, 140], y: [255, 181, 46], o: [179, 106, 0], B: [92, 40, 0] };
function png(size) {
  const k = size / 16, row = 1 + size * 4, raw = Buffer.alloc(row * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = ICON_COLORS[ICON[Math.floor(y / k)][Math.floor(x / k)]], i = y * row + 1 + x * 4;
      if (c) { raw[i] = c[0]; raw[i + 1] = c[1]; raw[i + 2] = c[2]; raw[i + 3] = 255; }
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.concat([Buffer.from(type, 'latin1'), data]), out = Buffer.alloc(t.length + 8);
    out.writeUInt32BE(data.length, 0); t.copy(out, 4); out.writeUInt32BE(crc(t), t.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;   // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function ico() {
  const pngs = [16, 24, 32, 48, 64, 128, 256].map((s) => [s, png(s)]);
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(([s, data], i) => {
    const e = 6 + 16 * i;
    head[e] = s % 256; head[e + 1] = s % 256; head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += data.length;
  });
  return Buffer.concat([head, ...pngs.map(([, d]) => d)]);
}

async function main() {
  if (process.argv.includes('--icon-preview')) {        // (just the icon, as dist/icon.png, to look at)
    fs.mkdirSync(DIST, { recursive: true });
    fs.writeFileSync(path.join(DIST, 'icon.png'), png(256));
    say('Wrote dist/icon.png');
    return;
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 12)) throw new Error(`Node.js 20.12 or newer is needed (this is ${process.version})`);
  console.log(`\n  Building Block Dash for ${TARGET === 'win' ? 'Windows' : 'Linux'} with Node.js ${process.version}`);
  fs.mkdirSync(DIST, { recursive: true });
  const three = await threeJs();
  const base = await baseBinary();
  const load = tools();
  const out = path.join(DIST, TARGET === 'win' ? 'BlockDash.exe' : 'blockdash-linux');

  // 1. the copy of Node.js (unsigned, on Windows)
  let exe = fs.readFileSync(base);
  if (TARGET === 'win') exe = stripSignature(Buffer.from(exe));
  fs.writeFileSync(out, exe);

  // 2. the program and its assets, as Node.js's "preparation blob"…
  const config = path.join(CACHE, 'sea-config.json'), blob = path.join(CACHE, 'sea-prep.blob');
  fs.writeFileSync(config, JSON.stringify({ main: path.join(ROOT, 'server.js'), output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false,
    assets: { 'index.html': path.join(ROOT, 'index.html'), 'three.module.min.js': three } }, null, 2));
  execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });

  // 3. …put into the copy (and the fuse that tells it there's a program inside flipped)
  const postject = await load('postject'), inject = postject.inject || (postject.default && postject.default.inject);
  await inject(out, 'NODE_SEA_BLOB', fs.readFileSync(blob), { sentinelFuse: SEA_FUSE, overwrite: true });

  // 4. Block Dash's icon and name in its properties (Windows). (Last: done first, the resource section it grows ends
  //    up where postject's PE reader can't follow the relocations past it.)
  if (TARGET === 'win') {
    const ResEdit = await load('resedit'), PE = await load('pe-library');
    const bin = PE.NtExecutable.from(fs.readFileSync(out), { ignoreCert: true }), res = PE.NtExecutableResource.from(bin);
    const group = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)[0] || { id: 1, lang: 1033 };
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, ResEdit.Data.IconFile.from(ico()).icons.map((i) => i.data));
    const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
    const lang = vi.getAllLanguagesForStringValues()[0] || { lang: 1033, codepage: 1200 };
    const [a, b, c] = VERSION.split('.').map(Number);
    vi.setFileVersion(a, b, c, 0, lang.lang);
    vi.setProductVersion(a, b, c, 0, lang.lang);
    vi.setStringValues(lang, { FileDescription: 'Block Dash', ProductName: 'Block Dash', InternalName: 'BlockDash', OriginalFilename: 'BlockDash.exe',
      CompanyName: 'Block Dash', LegalCopyright: `Block Dash. Built on Node.js ${process.version} (MIT licence).`, FileVersion: VERSION, ProductVersion: VERSION });
    vi.outputToResourceEntries(res.entries);
    res.outputResource(bin);
    fs.writeFileSync(out, Buffer.from(bin.generate()));
  }
  if (TARGET === 'linux') fs.chmodSync(out, 0o755);
  const done = fs.readFileSync(out);
  console.log(`\n  Built ${path.relative(ROOT, out)}: ${(done.length / 1048576).toFixed(1)} MB, SHA-256 ${sha('sha256', done)}\n`);
}
main().catch((e) => { console.error(`\n  Build failed: ${e.message}\n`); process.exit(1); });

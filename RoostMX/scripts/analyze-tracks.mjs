// Validates track layouts and writes SVG previews.
// Usage: node scripts/analyze-tracks.mjs [outDir]
import { Track, DS, generateTerrain } from '../src/track.js';
import { TRACKS } from '../src/tracks.js';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || '.';
const doTerrain = process.argv.includes('--terrain');
for (const def of TRACKS) {
  const t0 = performance.now();
  const tr = new Track(def);
  const t1 = performance.now();
  console.log(`\n== ${def.name}: length ${tr.length.toFixed(0)} m, closure err ${tr.closureError.toFixed(2)} m, build ${(t1 - t0).toFixed(0)} ms`);
  console.log(`   bounds x[${tr.bounds.minX.toFixed(0)}, ${tr.bounds.maxX.toFixed(0)}] z[${tr.bounds.minZ.toFixed(0)}, ${tr.bounds.maxZ.toFixed(0)}] map half ${def.size / 2}`);
  for (const f of tr.features) {
    if (!f.fits) console.log(`   WARN feature ${f.type} on seg ${f.seg} overruns its straight (ends ${f.s1.toFixed(1)}, seg end ${tr.segEnd(f.seg).toFixed(1)})`);
  }
  // closure prims
  const closing = tr.prims.filter((p) => p.seg === def.layout.length - 1);
  console.log('   closure:', closing.map((p) => p.kind === 'line' ? `S${p.len.toFixed(0)}` : `${p.dir < 0 ? 'L' : 'R'}${(p.ang * 180 / Math.PI).toFixed(0)}r${p.r}`).join(' '));
  // min separation between non-adjacent parts
  const step = Math.round(2 / DS);
  let worst = [];
  for (let i = 0; i < tr.n; i += step) {
    for (let j = i + step; j < tr.n; j += step) {
      const along = Math.min(j - i, tr.n - (j - i)) * DS;
      if (along < 90) continue;
      const d = Math.hypot(tr.x[i] - tr.x[j], tr.z[i] - tr.z[j]);
      if (d < 26) worst.push({ d, si: i * DS, sj: j * DS });
    }
  }
  worst.sort((a, b) => a.d - b.d);
  const shown = new Set();
  for (const w of worst) {
    const key = Math.round(w.si / 30) + ':' + Math.round(w.sj / 30);
    if (shown.has(key)) continue;
    shown.add(key);
    console.log(`   CLOSE sections: ${w.d.toFixed(1)} m between s=${w.si.toFixed(0)} and s=${w.sj.toFixed(0)}`);
    if (shown.size > 6) break;
  }
  if (doTerrain) {
    const t2 = performance.now();
    const hf = generateTerrain(tr);
    console.log(`   terrain ${hf.n}x${hf.n} in ${(performance.now() - t2).toFixed(0)} ms, h range ${hf.minH.toFixed(1)}..${hf.maxH.toFixed(1)}`);
  }
  // SVG
  const half = def.size / 2;
  let pts = '';
  for (let i = 0; i < tr.n; i += 4) pts += `${tr.x[i].toFixed(1)},${(tr.z[i]).toFixed(1)} `;
  let feats = '';
  const colors = { double: '#e33', table: '#f90', rhythm: '#c3c', whoops: '#39f', rollers: '#3c9', stepup: '#ff0', stepdown: '#0ff', hill: '#888' };
  for (const f of tr.features) {
    let fp = '';
    for (let s = f.s0; s <= f.s1; s += 1) { const i = tr.idx(s); fp += `${tr.x[i].toFixed(1)},${(tr.z[i]).toFixed(1)} `; }
    feats += `<polyline points="${fp}" fill="none" stroke="${colors[f.type] || '#fff'}" stroke-width="${2 * def.halfWidth}" stroke-opacity="0.8"/>`;
  }
  const g = tr.pose(tr.gateS), fi = tr.pose(tr.finishS);
  let cps = '';
  for (const c of tr.checkpoints) cps += `<circle cx="${c.x}" cy="${c.z}" r="3" fill="#ff0"/>`;
  let berms = '';
  for (let i = 0; i < tr.n; i += 8) {
    const B = tr.B[i];
    if (Math.abs(B) < 0.2) continue;
    const sgn = B > 0 ? -1 : 1;
    const nx = tr.tz[i] * sgn, nz = -tr.tx[i] * sgn;
    const w = tr.W[i];
    berms += `<circle cx="${(tr.x[i] + nx * w).toFixed(1)}" cy="${((tr.z[i] + nz * w)).toFixed(1)}" r="${(Math.abs(B) * 1.2).toFixed(1)}" fill="#a52"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-half} ${-half} ${def.size} ${def.size}" width="900" height="900">
<rect x="${-half}" y="${-half}" width="${def.size}" height="${def.size}" fill="#2d4a22"/>
<polyline points="${pts}" fill="none" stroke="#7a5535" stroke-width="${2 * def.halfWidth}" stroke-linejoin="round"/>
${feats}${berms}
<polyline points="${pts}" fill="none" stroke="#fff" stroke-width="0.4"/>
<line x1="${g.x - g.tz * 8}" y1="${(g.z - g.tx * 8)}" x2="${g.x + g.tz * 8}" y2="${(g.z + g.tx * 8)}" stroke="#fff" stroke-width="2"/>
<line x1="${fi.x - fi.tz * 8}" y1="${(fi.z - fi.tx * 8)}" x2="${fi.x + fi.tz * 8}" y2="${(fi.z + fi.tx * 8)}" stroke="#000" stroke-width="2"/>
${cps}
<circle cx="${tr.x[0]}" cy="${tr.z[0]}" r="4" fill="#0f0"/>
</svg>`;
  fs.writeFileSync(path.join(outDir, `track-${def.id}.svg`), svg);
}

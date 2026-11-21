// Generates importer test fixtures: a simple GLB "bike" with named parts and two PKZ archives.
// node tests/make-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'three/examples/jsm/libs/fflate.module.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function box(w, h, d) {
  const x = w / 2, y = h / 2, z = d / 2;
  const P = [], N = [], I = [];
  const faces = [[[1, 0, 0], [x, -y, -z], [x, y, -z], [x, y, z], [x, -y, z]], [[-1, 0, 0], [-x, -y, z], [-x, y, z], [-x, y, -z], [-x, -y, -z]],
    [[0, 1, 0], [-x, y, -z], [-x, y, z], [x, y, z], [x, y, -z]], [[0, -1, 0], [-x, -y, z], [-x, -y, -z], [x, -y, -z], [x, -y, z]],
    [[0, 0, 1], [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]], [[0, 0, -1], [x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]]];
  for (const [n, ...v] of faces) {
    const b = P.length / 3;
    for (const p of v) { P.push(...p); N.push(...n); }
    I.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  return { P, N, I };
}
function wheel(r, w, seg = 24) {
  // cylinder along X (axle), centered
  const P = [], N = [], I = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    P.push(-w / 2, c * r, s * r, w / 2, c * r, s * r);
    N.push(0, c, s, 0, c, s);
  }
  for (let i = 0; i < seg; i++) { const b = i * 2; I.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
  for (const side of [-1, 1]) {
    const center = P.length / 3;
    P.push(side * w / 2, 0, 0); N.push(side, 0, 0);
    for (let i = 0; i <= seg; i++) { const a = (i / seg) * Math.PI * 2; P.push(side * w / 2, Math.cos(a) * r, Math.sin(a) * r); N.push(side, 0, 0); }
    for (let i = 0; i < seg; i++) side > 0 ? I.push(center, center + 1 + i, center + 2 + i) : I.push(center, center + 2 + i, center + 1 + i);
  }
  return { P, N, I };
}

function makeGlb(parts, scale = 1) {
  const json = { asset: { version: '2.0', generator: 'roost-test' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'TestBike', children: [] }], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [] };
  const chunks = [];
  let offset = 0;
  const pushView = (arr, target) => {
    const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    const pad = (4 - (buf.length % 4)) % 4;
    chunks.push(buf, Buffer.alloc(pad));
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target });
    offset += buf.length + pad;
    return json.bufferViews.length - 1;
  };
  for (const p of parts) {
    const g = p.geo;
    const pos = new Float32Array(g.P.map((v) => v * scale));
    const nor = new Float32Array(g.N);
    const idx = new Uint16Array(g.I);
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
    const pv = pushView(pos, 34962), nv = pushView(nor, 34962), iv = pushView(idx, 34963);
    json.accessors.push({ bufferView: pv, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
    json.accessors.push({ bufferView: nv, componentType: 5126, count: nor.length / 3, type: 'VEC3' });
    json.accessors.push({ bufferView: iv, componentType: 5123, count: idx.length, type: 'SCALAR' });
    json.materials.push({ name: p.mat, pbrMetallicRoughness: { baseColorFactor: p.color, metallicFactor: 0.1, roughnessFactor: 0.6 } });
    json.meshes.push({ name: p.name + '_mesh', primitives: [{ attributes: { POSITION: json.accessors.length - 3, NORMAL: json.accessors.length - 2 }, indices: json.accessors.length - 1, material: json.materials.length - 1 }] });
    json.nodes.push({ name: p.name, mesh: json.meshes.length - 1, translation: p.t.map((v) => v * scale) });
    json.nodes[0].children.push(json.nodes.length - 1);
  }
  const bin = Buffer.concat(chunks);
  json.buffers.push({ byteLength: bin.length });
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonBuf, bh, bin]);
}

// a crude bike, modelled in centimetres facing +X (so the importer must scale and rotate it)
const parts = [
  { name: 'Frame', geo: box(90, 25, 14), t: [0, 70, 0], mat: 'Plastic_Body', color: [0.1, 0.4, 0.9, 1] },
  { name: 'Seat', geo: box(70, 8, 20), t: [-25, 92, 0], mat: 'Seat', color: [0.05, 0.05, 0.05, 1] },
  { name: 'Engine', geo: box(35, 30, 24), t: [5, 42, 0], mat: 'Engine', color: [0.2, 0.2, 0.2, 1] },
  { name: 'Wheel_Front', geo: wheel(36, 9), t: [74, 36, 0], mat: 'Tire', color: [0.05, 0.05, 0.05, 1] },
  { name: 'Wheel_Rear', geo: wheel(34, 12), t: [-74, 34, 0], mat: 'Tire', color: [0.05, 0.05, 0.05, 1] },
  { name: 'Fork_Lower', geo: box(6, 55, 18), t: [66, 62, 0], mat: 'Chrome', color: [0.8, 0.8, 0.8, 1] },
  { name: 'Handlebar', geo: box(6, 6, 80), t: [52, 108, 0], mat: 'Alu', color: [0.6, 0.6, 0.6, 1] },
  { name: 'Swingarm', geo: box(58, 7, 16), t: [-45, 40, 0], mat: 'Alu', color: [0.6, 0.6, 0.6, 1] },
];
// rotate: these boxes/wheels are defined with the wheel axle along X; for a bike facing +X the axle must be along Z
for (const p of parts) {
  const g = p.geo;
  for (let i = 0; i < g.P.length; i += 3) { const x = g.P[i], z = g.P[i + 2]; g.P[i] = -z; g.P[i + 2] = x; }
  for (let i = 0; i < g.N.length; i += 3) { const x = g.N[i], z = g.N[i + 2]; g.N[i] = -z; g.N[i + 2] = x; }
  if (p.name.startsWith('Wheel')) continue;
  // boxes were authored as (length along X, ., width along Z): undo the rotation for them
  for (let i = 0; i < g.P.length; i += 3) { const x = g.P[i], z = g.P[i + 2]; g.P[i] = z; g.P[i + 2] = -x; }
  for (let i = 0; i < g.N.length; i += 3) { const x = g.N[i], z = g.N[i + 2]; g.N[i] = z; g.N[i + 2] = -x; }
}
const glb = makeGlb(parts, 0.01 * 100); // keep centimetre units (scale 1 => values in cm)
fs.writeFileSync(path.join(dir, 'test-bike.glb'), glb);
fs.writeFileSync(path.join(dir, 'test-mod-native.pkz'), Buffer.from(zipSync({
  'bikes/testbike/testbike.edf': new Uint8Array([69, 68, 70, 0, 1, 2, 3, 4, 5, 6, 7, 8]),
  'bikes/testbike/testbike_wheel.edf': new Uint8Array(64),
  'bikes/testbike/paints/default.pnt': new Uint8Array(128),
  'bikes/testbike/testbike.ini': strToU8('[bike]\nname=Test Bike\n'),
  'bikes/testbike/textures/body.tga': new Uint8Array(32),
})));
fs.writeFileSync(path.join(dir, 'test-mod-with-glb.pkz'), Buffer.from(zipSync({
  'bikes/testbike/testbike.edf': new Uint8Array(64),
  'bikes/testbike/model/testbike.glb': new Uint8Array(glb),
  'bikes/testbike/testbike.ini': strToU8('[bike]\nname=Test Bike\n'),
})));
fs.writeFileSync(path.join(dir, 'not-a-zip.pkz'), Buffer.from('PIBOSO-ENCRYPTED-PACKAGE-0000000000'));
console.log('fixtures written:', fs.readdirSync(dir).map((f) => f + ' ' + fs.statSync(path.join(dir, f)).size).join(', '));

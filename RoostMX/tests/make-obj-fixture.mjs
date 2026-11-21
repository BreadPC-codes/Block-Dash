// Converts tests/fixtures/test-bike.glb parts into an OBJ + MTL pair (named objects).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const glb = fs.readFileSync(path.join(dir, 'test-bike.glb'));
const jsonLen = glb.readUInt32LE(12);
const json = JSON.parse(glb.slice(20, 20 + jsonLen).toString());
const binStart = 20 + jsonLen + 8;
const acc = (i) => {
  const a = json.accessors[i], v = json.bufferViews[a.bufferView];
  const start = binStart + (v.byteOffset || 0);
  if (a.componentType === 5126) return new Float32Array(glb.buffer.slice(glb.byteOffset + start, glb.byteOffset + start + v.byteLength));
  return new Uint16Array(glb.buffer.slice(glb.byteOffset + start, glb.byteOffset + start + v.byteLength));
};
let obj = 'mtllib test-bike.mtl\n', mtl = '', base = 1;
for (const node of json.nodes.slice(1)) {
  const mesh = json.meshes[node.mesh], prim = mesh.primitives[0];
  const P = acc(prim.attributes.POSITION), I = acc(prim.indices), t = node.translation || [0, 0, 0];
  const mat = json.materials[prim.material];
  obj += `o ${node.name}\nusemtl ${mat.name}\n`;
  for (let i = 0; i < P.length; i += 3) obj += `v ${(P[i] + t[0]).toFixed(3)} ${(P[i + 1] + t[1]).toFixed(3)} ${(P[i + 2] + t[2]).toFixed(3)}\n`;
  for (let i = 0; i < I.length; i += 3) obj += `f ${I[i] + base} ${I[i + 1] + base} ${I[i + 2] + base}\n`;
  base += P.length / 3;
  if (!mtl.includes('newmtl ' + mat.name + '\n')) { const c = mat.pbrMetallicRoughness.baseColorFactor; mtl += `newmtl ${mat.name}\nKd ${c[0]} ${c[1]} ${c[2]}\n\n`; }
}
fs.writeFileSync(path.join(dir, 'test-bike.obj'), obj);
fs.writeFileSync(path.join(dir, 'test-bike.mtl'), mtl);
console.log('obj', obj.length, 'mtl', mtl.length);

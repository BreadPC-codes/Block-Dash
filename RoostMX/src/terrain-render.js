// Terrain rendering: the heightfield is split into 64 m chunks. Each chunk has up to three
// levels of detail picked by camera distance every frame (THREE.LOD); a base step is
// chosen per chunk from its distance to the track. Skirts along every chunk edge hide
// the small cracks between neighbours at different levels. A splat shader blends dirt /
// grass / sand / gravel in world space; layers that are absent are skipped and distant
// pixels use fewer texture fetches.
import * as THREE from 'three';
import { patchRough, roughKey } from './ambient.js';

const CH = 128; // cells per chunk side (64 m at 0.5 m cells)

/** Mean linear colour of a (sRGB) canvas texture, used for distant terrain. */
function meanColor(tex) {
  const img = tex.image;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, 32, 32);
  const d = ctx.getImageData(0, 0, 32, 32).data;
  const lin = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) {
    r += lin(d[i]);
    g += lin(d[i + 1]);
    b += lin(d[i + 2]);
  }
  const n = d.length / 4;
  return new THREE.Vector3(r / n, g / n, b / n);
}

export function makeTerrainMaterial(tex, { sandy = false, quality = 'high' } = {}) {
  const Q = quality === 'low' ? 0 : quality === 'medium' ? 1 : 2;
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0 });
  mat.defines = { TERRAIN_Q: Q };
  if (!tex.avg) tex.avg = { dirt: meanColor(tex.dirt), grass: meanColor(tex.grass), sand: meanColor(tex.sand) };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.tDirt = { value: tex.dirt };
    shader.uniforms.tGrass = { value: tex.grass };
    shader.uniforms.tSand = { value: tex.sand };
    shader.uniforms.tGravel = { value: tex.gravel };
    shader.uniforms.tNormal = { value: tex.normal };
    shader.uniforms.tMacro = { value: tex.macro };
    shader.uniforms.uAvgDirt = { value: tex.avg.dirt };
    shader.uniforms.uAvgGrass = { value: tex.avg.grass };
    shader.uniforms.uAvgSand = { value: tex.avg.sand };
    shader.uniforms.uWearTint = { value: sandy ? new THREE.Vector3(0.82, 0.78, 0.72) : new THREE.Vector3(0.74, 0.7, 0.66) };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 aSplat;
        attribute float aWear;
        varying vec4 vSplat;
        varying float vWear;
        varying vec3 vWPos;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vSplat = aSplat;
        vWear = aWear;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D tDirt;
        uniform sampler2D tGrass;
        uniform sampler2D tSand;
        uniform sampler2D tGravel;
        uniform sampler2D tNormal;
        uniform sampler2D tMacro;
        uniform vec3 uAvgDirt;
        uniform vec3 uAvgGrass;
        uniform vec3 uAvgSand;
        uniform vec3 uWearTint;
        varying vec4 vSplat;
        varying float vWear;
        varying vec3 vWPos;`
      )
      .replace(
        '#include <map_fragment>',
        `
        vec4 sw = vSplat / max(dot(vSplat, vec4(1.0)), 0.001);
        float camDist = length(vViewPosition);
        vec2 wp = vWPos.xz;
        // explicit gradients: texture fetches below sit inside branches
        vec2 gx = dFdx(wp), gy = dFdy(wp);
        float macro = texture2D(tMacro, wp * 0.0045).r;
        vec3 tcol = vec3(0.0);
        #if TERRAIN_Q == 0
          vec2 uM = wp * 0.11;
          vec2 mx = gx * 0.11, my = gy * 0.11;
          if (sw.x > 0.004) tcol += textureGrad(tDirt, uM, mx, my).rgb * sw.x;
          if (sw.y > 0.004) tcol += textureGrad(tGrass, uM * 1.2, mx * 1.2, my * 1.2).rgb * sw.y;
          if (sw.z > 0.004) tcol += textureGrad(tSand, uM * 0.9, mx * 0.9, my * 0.9).rgb * sw.z;
          if (sw.w > 0.004) tcol += textureGrad(tGravel, uM * 1.4, mx * 1.4, my * 1.4).rgb * sw.w;
        #else
          // near detail fades into the texture's mean colour (what its far mips converge to)
          float nearW = 1.0 - smoothstep(24.0, 44.0, camDist);
          vec2 uvA = wp * 0.17;
          vec2 uvB = wp * 0.041 + vec2(0.37, 0.11);
          vec2 ax = gx * 0.17, ay = gy * 0.17, bx = gx * 0.041, by = gy * 0.041;
          if (sw.x > 0.004) {
            vec3 cA = uAvgDirt;
            if (nearW > 0.0) cA = mix(uAvgDirt, textureGrad(tDirt, uvA, ax, ay).rgb, nearW);
            tcol += mix(cA, textureGrad(tDirt, uvB, bx, by).rgb, 0.4) * sw.x;
          }
          if (sw.y > 0.004) {
            vec3 cA = uAvgGrass;
            if (nearW > 0.0) cA = mix(uAvgGrass, textureGrad(tGrass, uvA * 1.25, ax * 1.25, ay * 1.25).rgb, nearW);
            tcol += mix(cA, textureGrad(tGrass, uvB * 1.1, bx * 1.1, by * 1.1).rgb, 0.45) * sw.y;
          }
          if (sw.z > 0.004) {
            vec3 cA = uAvgSand;
            if (nearW > 0.0) cA = mix(uAvgSand, textureGrad(tSand, uvA * 0.8, ax * 0.8, ay * 0.8).rgb, nearW);
            tcol += mix(cA, textureGrad(tSand, uvB, bx, by).rgb, 0.45) * sw.z;
          }
          if (sw.w > 0.004) tcol += textureGrad(tGravel, uvA * 1.35, ax * 1.35, ay * 1.35).rgb * sw.w;
        #endif
        tcol *= mix(vec3(1.0), uWearTint, vWear);
        tcol *= 0.8 + macro * 0.4;
        diffuseColor.rgb *= tcol;
        `
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        #if TERRAIN_Q > 0
        if (camDist < 60.0) {
          vec3 nt = textureGrad(tNormal, wp * 0.23, gx * 0.23, gy * 0.23).xyz * 2.0 - 1.0;
          #if TERRAIN_Q > 1
          if (camDist < 32.0) {
            vec3 nt2 = textureGrad(tNormal, wp * 0.061, gx * 0.061, gy * 0.061).xyz * 2.0 - 1.0;
            nt = normalize(nt + nt2 * 0.6 * (1.0 - smoothstep(22.0, 32.0, camDist)));
          }
          #endif
          float ns = (sw.x * 0.9 + sw.z * 0.55 + sw.w * 1.1 + sw.y * 0.35) * (1.0 - smoothstep(38.0, 60.0, camDist));
          vec3 wN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          vec3 T = normalize(vec3(1.0, 0.0, 0.0) - wN * wN.x);
          vec3 B = normalize(cross(T, wN));
          vec3 pN = normalize(wN + (T * nt.x + B * nt.y) * ns * 0.55);
          normal = normalize((viewMatrix * vec4(pN, 0.0)).xyz);
        }
        #endif`
      );
    patchRough(shader);
  };
  mat.customProgramCacheKey = () => 'roost-terrain-v3' + (sandy ? 's' : 'd') + Q + roughKey();
  return mat;
}

/** Camera distances (to a chunk centre) at which the 2nd and 3rd detail levels take over. */
const LOD_DIST = { low: [70, 170], medium: [80, 190], high: [85, 210] };

export class TerrainView {
  constructor(hf, track) {
    this.hf = hf;
    this.track = track;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    this.meshes = [];
    this.lods = [];
  }

  chunkSteps(quality) {
    const hf = this.hf;
    const cnx = Math.ceil((hf.nx - 1) / CH), cnz = Math.ceil((hf.nz - 1) / CH);
    const steps = new Int32Array(cnx * cnz);
    const near = quality === 'high' ? 1 : 2;
    const mid = quality === 'high' ? 2 : 4;
    const far = quality === 'low' ? 8 : 4;
    for (let cz = 0; cz < cnz; cz++) {
      for (let cx = 0; cx < cnx; cx++) {
        let minD = 1e9;
        for (let j = 0; j <= CH; j += 4) {
          for (let i = 0; i <= CH; i += 4) {
            const gx = Math.min(hf.nx - 1, cx * CH + i), gz = Math.min(hf.nz - 1, cz * CH + j);
            const d = hf.trackDist[gz * hf.nx + gx];
            if (d < minD) minD = d;
          }
        }
        steps[cz * cnx + cx] = minD < 34 ? near : minD < 95 ? mid : far;
      }
    }
    return { cnx, cnz, steps };
  }

  /** Largest height error along a chunk's edges when sampled every `s` cells. */
  _edgeError(gx0, gz0, size, sizeZ, s) {
    const H = this.hf.h, n = this.hf.nx;
    let err = 0;
    const along = (fixed, len, isX) => {
      for (let a = 0; a <= len; a++) {
        const c0 = Math.min(Math.floor(a / s) * s, len), c1 = Math.min(c0 + s, len);
        const t = c1 > c0 ? (a - c0) / (c1 - c0) : 0;
        const hA = isX ? H[fixed * n + gx0 + c0] : H[(gz0 + c0) * n + fixed];
        const hB = isX ? H[fixed * n + gx0 + c1] : H[(gz0 + c1) * n + fixed];
        const h = isX ? H[fixed * n + gx0 + a] : H[(gz0 + a) * n + fixed];
        err = Math.max(err, Math.abs(h - (hA + (hB - hA) * t)));
      }
    };
    along(gz0, size, true);
    along(gz0 + sizeZ, size, true);
    along(gx0, sizeZ, false);
    along(gx0 + size, sizeZ, false);
    return err;
  }

  _chunkGeo(gx0, gz0, size, sizeZ, s, ox, oy, oz, skirt) {
    const hf = this.hf;
    const n = hf.nx, nzMax = hf.nz - 1, H = hf.h, cell = hf.cell, halfX = hf.halfX, halfZ = hf.halfZ;
    const mx = Math.ceil(size / s), mz = Math.ceil(sizeZ / s);
    const vx = mx + 1, vz = mz + 1;
    const nMain = vx * vz;
    const total = nMain + 2 * (vx + vz);
    const pos = new Float32Array(total * 3);
    const nor = new Float32Array(total * 3);
    const spl = new Uint8Array(total * 4);
    const wear = new Uint8Array(total);
    const d = Math.max(1, Math.round(s * 0.75)); // normal sampling radius in cells
    let k = 0;
    for (let j = 0; j < vz; j++) {
      const gz = gz0 + Math.min(j * s, sizeZ);
      const zm = Math.max(0, gz - d), zp = Math.min(nzMax, gz + d);
      for (let i = 0; i < vx; i++, k++) {
        const gx = gx0 + Math.min(i * s, size);
        const xm = Math.max(0, gx - d), xp = Math.min(n - 1, gx + d);
        const c = gz * n + gx;
        pos[k * 3] = gx * cell - halfX - ox;
        pos[k * 3 + 1] = H[c] - oy;
        pos[k * 3 + 2] = gz * cell - halfZ - oz;
        const nx = -(H[gz * n + xp] - H[gz * n + xm]) / ((xp - xm) * cell);
        const nz = -(H[zp * n + gx] - H[zm * n + gx]) / ((zp - zm) * cell);
        const il = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
        nor[k * 3] = nx * il;
        nor[k * 3 + 1] = il;
        nor[k * 3 + 2] = nz * il;
        spl[k * 4] = hf.splat[c * 4];
        spl[k * 4 + 1] = hf.splat[c * 4 + 1];
        spl[k * 4 + 2] = hf.splat[c * 4 + 2];
        spl[k * 4 + 3] = hf.splat[c * 4 + 3];
        wear[k] = hf.wear[c];
      }
    }
    const idx = [];
    for (let j = 0; j < mz; j++) {
      for (let i = 0; i < mx; i++) {
        const a = j * vx + i, b = a + 1, c = a + vx, dd = c + 1;
        // diagonal (1,0)-(0,1) matches Heightfield.height()
        idx.push(a, c, b, b, c, dd);
      }
    }
    // skirts: a strip hanging below every edge, facing outward
    const edge = (list, ox_, oz_) => {
      const base = k;
      for (const v of list) {
        pos[k * 3] = pos[v * 3];
        pos[k * 3 + 1] = pos[v * 3 + 1] - skirt;
        pos[k * 3 + 2] = pos[v * 3 + 2];
        nor[k * 3] = nor[v * 3]; nor[k * 3 + 1] = nor[v * 3 + 1]; nor[k * 3 + 2] = nor[v * 3 + 2];
        spl[k * 4] = spl[v * 4]; spl[k * 4 + 1] = spl[v * 4 + 1]; spl[k * 4 + 2] = spl[v * 4 + 2]; spl[k * 4 + 3] = spl[v * 4 + 3];
        wear[k] = wear[v];
        k++;
      }
      for (let q = 0; q < list.length - 1; q++) {
        const A = list[q], B = list[q + 1], A2 = base + q, B2 = base + q + 1;
        // outward test: (B - A) x (A2 - A) . outward  (A2 - A is straight down)
        const ex = pos[B * 3] - pos[A * 3], ez = pos[B * 3 + 2] - pos[A * 3 + 2];
        // (ex, ey, ez) x (0, -1, 0) = (ez, 0, -ex)
        if (ez * ox_ - ex * oz_ > 0) idx.push(A, B, A2, B, B2, A2);
        else idx.push(A, A2, B, B, A2, B2);
      }
    };
    const row = (j) => Array.from({ length: vx }, (_, i) => j * vx + i);
    const col = (i) => Array.from({ length: vz }, (_, j) => j * vx + i);
    edge(row(0), 0, -1);
    edge(row(vz - 1), 0, 1);
    edge(col(0), -1, 0);
    edge(col(vx - 1), 1, 0);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('aSplat', new THREE.BufferAttribute(spl, 4, true));
    geo.setAttribute('aWear', new THREE.BufferAttribute(wear, 1, true));
    geo.setIndex(new THREE.BufferAttribute(total > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return { geo, tris: idx.length / 3 };
  }

  build(quality, material) {
    this.dispose();
    const hf = this.hf;
    const { cnx, cnz, steps } = this.chunkSteps(quality);
    const dist = LOD_DIST[quality] || LOD_DIST.medium;
    const n = hf.nx, H = hf.h, cell = hf.cell, halfX = hf.halfX, halfZ = hf.halfZ;
    // per-chunk levels and the skirt depth needed to cover the worst neighbour mismatch
    const info = [];
    for (let cz = 0; cz < cnz; cz++) {
      for (let cx = 0; cx < cnx; cx++) {
        const s0 = steps[cz * cnx + cx];
        const gx0 = cx * CH, gz0 = cz * CH;
        const size = Math.min(CH, hf.nx - 1 - gx0), sizeZ = Math.min(CH, hf.nz - 1 - gz0);
        const levels = [s0];
        while (levels.length < 3 && levels[levels.length - 1] * 2 <= Math.min(32, size)) levels.push(levels[levels.length - 1] * 2);
        const err = size > 0 && sizeZ > 0 ? this._edgeError(gx0, gz0, size, sizeZ, levels[levels.length - 1]) : 0;
        info.push({ cx, cz, gx0, gz0, size, sizeZ, levels, err });
      }
    }
    const errAt = (cx, cz) => (cx < 0 || cz < 0 || cx >= cnx || cz >= cnz ? 0 : info[cz * cnx + cx].err);
    let tris = 0;
    for (const c of info) {
      if (c.size <= 0 || c.sizeZ <= 0) continue;
      const neigh = Math.max(errAt(c.cx - 1, c.cz), errAt(c.cx + 1, c.cz), errAt(c.cx, c.cz - 1), errAt(c.cx, c.cz + 1));
      const skirt = c.err + neigh + 0.35;
      // LOD origin at the chunk centre (mean height) so distances are measured from there
      const gxc = c.gx0 + (c.size >> 1), gzc = c.gz0 + (c.sizeZ >> 1);
      const ox = gxc * cell - halfX, oz = gzc * cell - halfZ, oy = H[gzc * n + gxc];
      const lod = new THREE.LOD();
      lod.position.set(ox, oy, oz);
      lod.updateMatrix();
      lod.matrixAutoUpdate = false;
      c.levels.forEach((st, li) => {
        const { geo, tris: t } = this._chunkGeo(c.gx0, c.gz0, c.size, c.sizeZ, st, ox, oy, oz, skirt);
        if (li === 0) tris += t;
        const mesh = new THREE.Mesh(geo, material);
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        mesh.matrixAutoUpdate = false;
        lod.addLevel(mesh, li === 0 ? 0 : dist[li - 1], 0.06);
        this.meshes.push(mesh);
      });
      this.group.add(lod);
      this.lods.push(lod);
    }
    this.group.updateMatrixWorld(true);
    this.triangles = tris;
    return this.group;
  }

  /**
   * Hide chunks that lie entirely beyond `maxDist` (the fog's far distance): they would be
   * drawn in pure fog colour, which is what the background shows there anyway.
   */
  cull(cam, maxDist) {
    const r = CH * this.hf.cell * 0.75; // chunk half-diagonal plus a margin
    const lim = maxDist + r;
    const lim2 = lim * lim;
    for (const l of this.lods) {
      const p = l.position;
      const dx = p.x - cam.x, dz = p.z - cam.z;
      l.visible = dx * dx + dz * dz < lim2;
    }
  }

  dispose() {
    for (const m of this.meshes) m.geometry.dispose();
    for (const l of this.lods) this.group.remove(l);
    this.meshes.length = 0;
    this.lods.length = 0;
  }
}

/** Far landscape beyond the playable heightfield (mountains or dunes), vertex coloured. */
export function buildBackdrop(track, hf, style, quality) {
  const ext = 3400;
  const cellB = quality === 'low' ? 80 : 50;
  const m = Math.round((ext * 2) / cellB);
  const vcount = (m + 1) * (m + 1);
  const pos = new Float32Array(vcount * 3);
  const col = new Float32Array(vcount * 3);
  const halfX = hf.halfX, halfZ = hf.halfZ;
  const innerX = halfX - cellB * 1.2, innerZ = halfZ - cellB * 1.2;
  const G = track.ground;
  const c1 = new THREE.Color(), c2 = new THREE.Color();
  const grassLow = new THREE.Color(style === 'dunes' ? 0xc9b48a : 0x4c6a30);
  const grassHigh = new THREE.Color(style === 'dunes' ? 0xd9c49a : 0x3d5a2a);
  const rock = new THREE.Color(style === 'dunes' ? 0xbca37a : 0x6f6a62);
  const snow = new THREE.Color(0xeef2f5);
  for (let j = 0; j <= m; j++) {
    for (let i = 0; i <= m; i++) {
      const k = j * (m + 1) + i;
      const x = -ext + i * cellB, z = -ext + j * cellB;
      let h;
      if (Math.abs(x) <= halfX && Math.abs(z) <= halfZ) h = hf.height(x, z) - 2.5;
      else h = G(x, z);
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      const hn = h / 120;
      c1.copy(grassLow).lerp(grassHigh, Math.min(1, Math.max(0, hn * 2)));
      c2.copy(c1).lerp(rock, Math.min(1, Math.max(0, (h - 45) / 70)));
      if (style !== 'dunes' && h > 150) c2.lerp(snow, Math.min(1, (h - 150) / 60));
      col[k * 3] = c2.r; col[k * 3 + 1] = c2.g; col[k * 3 + 2] = c2.b;
    }
  }
  const idx = [];
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const x0 = -ext + i * cellB, z0 = -ext + j * cellB;
      if (x0 >= -innerX && x0 + cellB <= innerX && z0 >= -innerZ && z0 + cellB <= innerZ) continue;
      const a = j * (m + 1) + i, b = a + 1, c = a + m + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  mat.onBeforeCompile = (sh) => patchRough(sh);
  mat.customProgramCacheKey = () => 'backdrop-' + roughKey();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'backdrop';
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

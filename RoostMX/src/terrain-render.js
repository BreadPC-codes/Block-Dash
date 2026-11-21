// Terrain rendering: the heightfield is split into chunks with a static level of detail
// (full resolution near the track, coarser far away). Chunk edges are stitched to the
// coarser neighbour so there are no cracks. A splat shader blends dirt / grass / sand /
// gravel textures in world space, darkens the worn racing line and adds detail normals.
import * as THREE from 'three';

const CH = 64; // cells per chunk side

export function makeTerrainMaterial(tex, { sandy = false } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.tDirt = { value: tex.dirt };
    shader.uniforms.tGrass = { value: tex.grass };
    shader.uniforms.tSand = { value: tex.sand };
    shader.uniforms.tGravel = { value: tex.gravel };
    shader.uniforms.tNormal = { value: tex.normal };
    shader.uniforms.tMacro = { value: tex.macro };
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
        uniform vec3 uWearTint;
        varying vec4 vSplat;
        varying float vWear;
        varying vec3 vWPos;`
      )
      .replace(
        '#include <map_fragment>',
        `
        vec4 sw = vSplat / max(dot(vSplat, vec4(1.0)), 0.001);
        vec2 uvA = vWPos.xz * 0.17;
        vec2 uvB = vWPos.xz * 0.041 + vec2(0.37, 0.11);
        float macro = texture2D(tMacro, vWPos.xz * 0.0045).r;
        vec3 cd = mix(texture2D(tDirt, uvA).rgb, texture2D(tDirt, uvB).rgb, 0.4);
        vec3 cg = mix(texture2D(tGrass, uvA * 1.25).rgb, texture2D(tGrass, uvB * 1.1).rgb, 0.45);
        vec3 cs = mix(texture2D(tSand, uvA * 0.8).rgb, texture2D(tSand, uvB).rgb, 0.45);
        vec3 cv = texture2D(tGravel, uvA * 1.35).rgb;
        vec3 tcol = cd * sw.x + cg * sw.y + cs * sw.z + cv * sw.w;
        tcol *= mix(vec3(1.0), uWearTint, vWear);
        tcol *= 0.8 + macro * 0.4;
        diffuseColor.rgb *= tcol;
        `
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          vec3 nt = texture2D(tNormal, vWPos.xz * 0.23).xyz * 2.0 - 1.0;
          vec3 nt2 = texture2D(tNormal, vWPos.xz * 0.061).xyz * 2.0 - 1.0;
          nt = normalize(nt + nt2 * 0.6);
          float ns = (sw.x * 0.9 + sw.z * 0.55 + sw.w * 1.1 + sw.y * 0.35);
          vec3 wN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          vec3 T = normalize(vec3(1.0, 0.0, 0.0) - wN * wN.x);
          vec3 B = normalize(cross(T, wN));
          vec3 pN = normalize(wN + (T * nt.x + B * nt.y) * ns * 0.55);
          normal = normalize((viewMatrix * vec4(pN, 0.0)).xyz);
        }`
      );
  };
  mat.customProgramCacheKey = () => 'roost-terrain-v1' + (sandy ? 's' : 'd');
  return mat;
}

export class TerrainView {
  constructor(hf, track) {
    this.hf = hf;
    this.track = track;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    this.meshes = [];
  }

  chunkSteps(quality) {
    const hf = this.hf;
    const cn = Math.ceil((hf.n - 1) / CH);
    const steps = new Int32Array(cn * cn);
    const near = quality === 'high' ? 1 : 2;
    const mid = quality === 'high' ? 2 : 4;
    const far = quality === 'low' ? 8 : 4;
    for (let cz = 0; cz < cn; cz++) {
      for (let cx = 0; cx < cn; cx++) {
        let minD = 1e9;
        for (let j = 0; j <= CH; j += 4) {
          for (let i = 0; i <= CH; i += 4) {
            const gx = Math.min(hf.n - 1, cx * CH + i), gz = Math.min(hf.n - 1, cz * CH + j);
            const d = hf.trackDist[gz * hf.n + gx];
            if (d < minD) minD = d;
          }
        }
        steps[cz * cn + cx] = minD < 34 ? near : minD < 95 ? mid : far;
      }
    }
    return { cn, steps };
  }

  build(quality, material) {
    this.dispose();
    const hf = this.hf;
    const { cn, steps } = this.chunkSteps(quality);
    const stepAt = (cx, cz) => (cx < 0 || cz < 0 || cx >= cn || cz >= cn ? 0 : steps[cz * cn + cx]);
    const n = hf.n, H = hf.h, cell = hf.cell, half = hf.half;
    const nrm = { x: 0, y: 1, z: 0 };
    let tris = 0;
    for (let cz = 0; cz < cn; cz++) {
      for (let cx = 0; cx < cn; cx++) {
        const s = steps[cz * cn + cx];
        const gx0 = cx * CH, gz0 = cz * CH;
        const size = Math.min(CH, n - 1 - gx0), sizeZ = Math.min(CH, n - 1 - gz0);
        if (size <= 0 || sizeZ <= 0) continue;
        const mx = Math.ceil(size / s), mz = Math.ceil(sizeZ / s);
        const vx = mx + 1, vz = mz + 1;
        const pos = new Float32Array(vx * vz * 3);
        const nor = new Float32Array(vx * vz * 3);
        const spl = new Uint8Array(vx * vz * 4);
        const wear = new Uint8Array(vx * vz);
        const sN = stepAt(cx, cz - 1), sS = stepAt(cx, cz + 1), sW = stepAt(cx - 1, cz), sE = stepAt(cx + 1, cz);
        const hAt = (gx, gz) => H[Math.min(n - 1, gz) * n + Math.min(n - 1, gx)];
        const edgeH = (gx, gz, along, ns, isX) => {
          // interpolate along an edge at a coarser neighbour step
          const a = Math.floor(along / ns) * ns, t = (along - a) / ns;
          if (t === 0) return hAt(gx, gz);
          if (isX) return hAt(gx0 + a, gz) * (1 - t) + hAt(gx0 + a + ns, gz) * t;
          return hAt(gx, gz0 + a) * (1 - t) + hAt(gx, gz0 + a + ns) * t;
        };
        let k = 0;
        for (let j = 0; j < vz; j++) {
          const lj = Math.min(j * s, sizeZ);
          const gz = gz0 + lj;
          for (let i = 0; i < vx; i++, k++) {
            const li = Math.min(i * s, size);
            const gx = gx0 + li;
            let h = hAt(gx, gz);
            if (j === 0 && sN > s) h = edgeH(gx, gz, li, sN, true);
            else if (j === vz - 1 && sS > s) h = edgeH(gx, gz, li, sS, true);
            if (i === 0 && sW > s) h = edgeH(gx, gz, lj, sW, false);
            else if (i === vx - 1 && sE > s) h = edgeH(gx, gz, lj, sE, false);
            const x = gx * cell - half, z = gz * cell - half;
            pos[k * 3] = x;
            pos[k * 3 + 1] = h;
            pos[k * 3 + 2] = z;
            hf.normal(x, z, nrm, Math.max(0.35, s * cell * 0.75));
            nor[k * 3] = nrm.x;
            nor[k * 3 + 1] = nrm.y;
            nor[k * 3 + 2] = nrm.z;
            const c = Math.min(n - 1, gz) * n + Math.min(n - 1, gx);
            spl[k * 4] = hf.splat[c * 4];
            spl[k * 4 + 1] = hf.splat[c * 4 + 1];
            spl[k * 4 + 2] = hf.splat[c * 4 + 2];
            spl[k * 4 + 3] = hf.splat[c * 4 + 3];
            wear[k] = hf.wear[c];
          }
        }
        const idx = new (vx * vz > 65535 ? Uint32Array : Uint16Array)(mx * mz * 6);
        let t = 0;
        for (let j = 0; j < mz; j++) {
          for (let i = 0; i < mx; i++) {
            const a = j * vx + i, b = a + 1, c = a + vx, d = c + 1;
            // diagonal (1,0)-(0,1) matches Heightfield.height()
            idx[t++] = a; idx[t++] = c; idx[t++] = b;
            idx[t++] = b; idx[t++] = c; idx[t++] = d;
          }
        }
        tris += t / 3;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
        geo.setAttribute('aSplat', new THREE.BufferAttribute(spl, 4, true));
        geo.setAttribute('aWear', new THREE.BufferAttribute(wear, 1, true));
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
        geo.computeBoundingSphere();
        geo.computeBoundingBox();
        const mesh = new THREE.Mesh(geo, material);
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        this.group.add(mesh);
        this.meshes.push(mesh);
      }
    }
    this.triangles = tris;
    return this.group;
  }

  dispose() {
    for (const m of this.meshes) {
      m.geometry.dispose();
      this.group.remove(m);
    }
    this.meshes.length = 0;
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
  const half = hf.half;
  const inner = half - cellB * 1.2;
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
      if (Math.abs(x) <= half && Math.abs(z) <= half) h = hf.height(x, z) - 2.5;
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
      if (x0 >= -inner && x0 + cellB <= inner && z0 >= -inner && z0 + cellB <= inner) continue;
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
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'backdrop';
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

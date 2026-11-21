// "Part" materials: one MeshStandardMaterial that reads colour, roughness, metalness and a
// paint flag per vertex. Lets many differently coloured pieces (a bike, a rider, a pit
// area full of props) share a single material and therefore a single draw call.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * @param {object} o
 * @param {THREE.Texture} [o.map]   optional atlas (untextured parts sample a white texel)
 * @param {number|string} [o.paint] colour used where the paint flag is set (changeable later)
 * @param {THREE.Side} [o.side]
 */
export function makePartMaterial({ map = null, paint = 0xffffff, side = THREE.FrontSide, name = 'parts' } = {}) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, map, side, name });
  const uPaint = { value: new THREE.Color(paint) };
  mat.userData.uPaint = uPaint;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uPaint = uPaint;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aRMP;\nvarying vec3 vRMP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvRMP = aRMP;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uPaint;\nvarying vec3 vRMP;')
      .replace('#include <color_fragment>', '#if defined( USE_COLOR )\n\tdiffuseColor.rgb *= mix( vColor.rgb, uPaint, vRMP.z );\n#endif')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vRMP.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vRMP.y;');
  };
  mat.customProgramCacheKey = () => 'roost-parts-1';
  return mat;
}

export function setPaint(mat, color) {
  if (mat && mat.userData.uPaint) mat.userData.uPaint.value.set(color);
}

const _c = new THREE.Color();

/**
 * Bake one piece into a non-indexed geometry with position/normal/uv/color/aRMP
 * (and optionally a skin bone index).
 * @param {THREE.BufferGeometry} geo
 * @param {object} p  { color, roughness, metalness, paint (0|1), matrix?, uv?: 'keep'|[u,v], uvMap?: (u,v,out)=>void, bone? }
 */
export function bakePart(geo, p) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  if (p.matrix) {
    g.applyMatrix4(p.matrix);
  }
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const n = g.getAttribute('position').count;
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', g.getAttribute('position'));
  out.setAttribute('normal', g.getAttribute('normal'));
  const uv = new Float32Array(n * 2);
  const src = g.getAttribute('uv');
  if (p.uvMap && src) {
    const o = [0, 0];
    for (let i = 0; i < n; i++) {
      p.uvMap(src.getX(i), src.getY(i), o);
      uv[i * 2] = o[0];
      uv[i * 2 + 1] = o[1];
    }
  } else if (p.uv === 'keep' && src) {
    for (let i = 0; i < n; i++) {
      uv[i * 2] = src.getX(i);
      uv[i * 2 + 1] = src.getY(i);
    }
  } else {
    const u0 = p.uv ? p.uv[0] : 0.5, v0 = p.uv ? p.uv[1] : 0.5;
    for (let i = 0; i < n; i++) {
      uv[i * 2] = u0;
      uv[i * 2 + 1] = v0;
    }
  }
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const col = new Float32Array(n * 3);
  _c.set(p.color === undefined ? 0xffffff : p.color);
  const srcCol = p.keepColors ? g.getAttribute('color') : null;
  for (let i = 0; i < n; i++) {
    if (srcCol) {
      col[i * 3] = srcCol.getX(i) * _c.r;
      col[i * 3 + 1] = srcCol.getY(i) * _c.g;
      col[i * 3 + 2] = srcCol.getZ(i) * _c.b;
    } else {
      col[i * 3] = _c.r;
      col[i * 3 + 1] = _c.g;
      col[i * 3 + 2] = _c.b;
    }
  }
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const rmp = new Uint8Array(n * 3);
  const r = Math.round((p.roughness === undefined ? 0.8 : p.roughness) * 255);
  const m = Math.round((p.metalness || 0) * 255);
  const pf = p.paint ? 255 : 0;
  for (let i = 0; i < n; i++) {
    rmp[i * 3] = r;
    rmp[i * 3 + 1] = m;
    rmp[i * 3 + 2] = pf;
  }
  out.setAttribute('aRMP', new THREE.BufferAttribute(rmp, 3, true));
  if (p.bone !== undefined) {
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      si[i * 4] = p.bone;
      sw[i * 4] = 1;
    }
    out.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    out.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  }
  if (g !== geo) g.dispose();
  return out;
}

/** Description of a classic material as part parameters. */
export function partParams(mat) {
  return {
    color: mat.color ? mat.color.getHex() : 0xffffff,
    roughness: mat.roughness !== undefined ? mat.roughness : 0.8,
    metalness: mat.metalness || 0,
  };
}

export function mergeBaked(list) {
  if (!list.length) return null;
  const merged = mergeGeometries(list, false);
  for (const g of list) g.dispose();
  return merged;
}

// Cheap ambient light for rough surfaces (terrain, vegetation, backdrop).
// The sky's diffuse light is captured once as 9 spherical-harmonics coefficients, so those
// shaders get their ambient term from a few multiply-adds instead of environment-map
// texture fetches, and their (barely visible) specular reflection is derived from it too.
import * as THREE from 'three';

export const ENV_SH = { value: Array.from({ length: 9 }, () => new THREE.Vector3()), ready: false };

/** Render `envScene` into a tiny float cube map and project it onto SH (sync, ~1 ms). */
export function computeEnvSH(renderer, envScene, intensity = 1) {
  ENV_SH.ready = false;
  const ext = renderer.extensions;
  if (!ext || !ext.has('EXT_color_buffer_float')) return false;
  const size = 16;
  const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.FloatType, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  try {
    new THREE.CubeCamera(1, 10000, rt).update(renderer, envScene);
    const sh = new THREE.SphericalHarmonics3();
    const co = sh.coefficients;
    const data = new Float32Array(size * size * 4);
    const basis = new Array(9).fill(0);
    const coord = new THREE.Vector3(), dir = new THREE.Vector3();
    const flip = -1; // WebGL coordinate system
    const px = 2 / size;
    let total = 0;
    for (let face = 0; face < 6; face++) {
      renderer.readRenderTargetPixels(rt, 0, 0, size, size, data, face);
      for (let i = 0; i < data.length; i += 4) {
        const pi = i / 4;
        const col = (1 - ((pi % size) + 0.5) * px) * flip;
        const row = 1 - (Math.floor(pi / size) + 0.5) * px;
        switch (face) {
          case 0: coord.set(-1 * flip, row, col * flip); break;
          case 1: coord.set(1 * flip, row, -col * flip); break;
          case 2: coord.set(col, 1, -row); break;
          case 3: coord.set(col, -1, row); break;
          case 4: coord.set(col, row, 1); break;
          default: coord.set(-col, row, -1); break;
        }
        const l2 = coord.lengthSq();
        const w = 4 / (Math.sqrt(l2) * l2);
        total += w;
        dir.copy(coord).normalize();
        THREE.SphericalHarmonics3.getBasisAt(dir, basis);
        const r = data[i], g = data[i + 1], b = data[i + 2];
        for (let j = 0; j < 9; j++) {
          co[j].x += basis[j] * r * w;
          co[j].y += basis[j] * g * w;
          co[j].z += basis[j] * b * w;
        }
      }
    }
    const norm = ((4 * Math.PI) / total) * intensity;
    for (let j = 0; j < 9; j++) ENV_SH.value[j].copy(co[j]).multiplyScalar(norm);
    ENV_SH.ready = Number.isFinite(ENV_SH.value[0].x) && ENV_SH.value[0].lengthSq() > 0;
  } catch (e) {
    ENV_SH.ready = false;
  } finally {
    rt.dispose();
  }
  return ENV_SH.ready;
}

/** lights_fragment_maps for rough materials: SH ambient + radiance derived from it. */
export function roughLightsChunk() {
  let c = THREE.ShaderChunk.lights_fragment_maps.replace(
    'vec3 iblRadiance = getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );',
    'vec3 iblRadiance = iblIrradiance * RECIPROCAL_PI;'
  );
  if (ENV_SH.ready) {
    c = c.replace(
      'iblIrradiance += getIBLIrradiance( geometryNormal );',
      'iblIrradiance += shGetIrradianceAt( inverseTransformDirection( geometryNormal, viewMatrix ), uEnvSH );'
    );
  }
  return c;
}

/** Apply the cheap ambient to a shader in onBeforeCompile. */
export function patchRough(shader) {
  shader.uniforms.uEnvSH = ENV_SH;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform vec3 uEnvSH[ 9 ];')
    .replace('#include <lights_fragment_maps>', roughLightsChunk());
}

export const roughKey = () => (ENV_SH.ready ? 'sh' : 'ibl');

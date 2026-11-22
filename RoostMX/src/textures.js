// Procedural textures generated on canvases at startup, so the game needs no image files.
import * as THREE from 'three';
import { makeRng, clamp } from './util.js';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Tileable multi-octave value noise in [0,1]. */
export function tileNoise(size, baseCells, octaves, seed, persistence = 0.5) {
  const out = new Float32Array(size * size);
  const rng = makeRng(seed);
  let amp = 1, norm = 0;
  let cells = baseCells;
  for (let o = 0; o < octaves; o++) {
    const grid = new Float32Array(cells * cells);
    for (let i = 0; i < grid.length; i++) grid[i] = rng();
    const scale = cells / size;
    for (let y = 0; y < size; y++) {
      const gy = y * scale;
      const y0 = Math.floor(gy), ty = gy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const r0 = (y0 % cells) * cells, r1 = ((y0 + 1) % cells) * cells;
      for (let x = 0; x < size; x++) {
        const gx = x * scale;
        const x0 = Math.floor(gx), tx = gx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const c0 = x0 % cells, c1 = (x0 + 1) % cells;
        const a = grid[r0 + c0], b = grid[r0 + c1], c = grid[r1 + c0], d = grid[r1 + c1];
        out[y * size + x] += amp * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
      }
    }
    norm += amp;
    amp *= persistence;
    cells *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

function toTexture(c, { repeat = true, srgb = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

function fillFromFn(size, fn) {
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const col = fn(x, y, y * size + x);
      d[i] = clamp(col[0], 0, 255);
      d[i + 1] = clamp(col[1], 0, 255);
      d[i + 2] = clamp(col[2], 0, 255);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function sprinkleStones(ctx, size, count, rng, colors, minR, maxR) {
  for (let i = 0; i < count; i++) {
    const x = rng() * size, y = rng() * size;
    const r = minR + rng() * (maxR - minR);
    const col = colors[Math.floor(rng() * colors.length)];
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        const px = x + ox, py = y + oy;
        if (px < -r || py < -r || px > size + r || py > size + r) continue;
        const g = ctx.createRadialGradient(px - r * 0.3, py - r * 0.3, r * 0.1, px, py, r);
        g.addColorStop(0, col[0]);
        g.addColorStop(1, col[1]);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(px, py, r, r * (0.7 + rng() * 0.3), rng() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

export function makeTerrainTextures(size = 1024, aniso = 8) {
  const rng = makeRng(42);
  // --- dirt
  const n1 = tileNoise(size, 8, 6, 11, 0.55);
  const n2 = tileNoise(size, 32, 3, 12, 0.5);
  const dirtC = fillFromFn(size, (x, y, i) => {
    const v = n1[i], w = n2[i];
    const clump = Math.max(0, w - 0.55) * 2.2;
    const base = 0.75 + (v - 0.5) * 0.7 - clump * 0.25;
    return [118 * base + 10, 86 * base + 6, 60 * base + 4];
  });
  const dctx = dirtC.getContext('2d');
  sprinkleStones(dctx, size, size * 0.35, rng, [['#9a8a74', '#5d4d3c'], ['#7d6a55', '#4a3b2d'], ['#b5a48c', '#6d5e4c']], size / 900, size / 300);
  // --- grass
  const g1 = tileNoise(size, 8, 6, 21, 0.55);
  const g2 = tileNoise(size, 64, 2, 22, 0.5);
  const grassC = fillFromFn(size, (x, y, i) => {
    const v = g1[i], w = g2[i];
    const blade = (w - 0.5) * 0.5;
    const dry = Math.max(0, v - 0.62) * 1.8;
    const base = 0.68 + (v - 0.5) * 0.55 + blade;
    return [62 * base + dry * 60, 96 * base + dry * 30, 34 * base + dry * 8];
  });
  const gctx = grassC.getContext('2d');
  gctx.globalAlpha = 0.35;
  for (let i = 0; i < size * 6; i++) {
    const x = rng() * size, y = rng() * size;
    const len = (2 + rng() * 6) * (size / 512);
    const a = rng() * Math.PI * 2;
    gctx.strokeStyle = rng() < 0.5 ? '#8fb35a' : '#2f4a1c';
    gctx.lineWidth = Math.max(1, size / 700);
    gctx.beginPath();
    gctx.moveTo(x, y);
    gctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    gctx.stroke();
  }
  gctx.globalAlpha = 1;
  // --- sand
  const s1 = tileNoise(size, 8, 5, 31, 0.5);
  const s2 = tileNoise(size, 128, 1, 32, 0.5);
  const sandC = fillFromFn(size, (x, y, i) => {
    const v = s1[i];
    const ripple = Math.sin((x / size) * Math.PI * 2 * 22 + Math.sin((y / size) * Math.PI * 2 * 3) * 3 + v * 6) * 0.04;
    const base = 0.9 + (v - 0.5) * 0.25 + ripple + (s2[i] - 0.5) * 0.12;
    return [208 * base, 184 * base, 140 * base];
  });
  // --- gravel
  const v1 = tileNoise(size, 8, 4, 41, 0.5);
  const gravelC = fillFromFn(size, (x, y, i) => {
    const b = 0.65 + (v1[i] - 0.5) * 0.4;
    return [122 * b, 116 * b, 106 * b];
  });
  const vctx = gravelC.getContext('2d');
  sprinkleStones(vctx, size, size * 4, rng, [['#b7b1a6', '#615c55'], ['#9c968c', '#4f4b45'], ['#d2cbbf', '#7b746a'], ['#8a7f73', '#4b4038']], size / 500, size / 160);

  // --- detail normal map from dirt noise
  const hN = tileNoise(size, 16, 5, 51, 0.55);
  const nrmC = fillFromFn(size, (x, y) => {
    const xm = (x - 1 + size) % size, xp = (x + 1) % size;
    const ym = (y - 1 + size) % size, yp = (y + 1) % size;
    const dx = (hN[y * size + xp] - hN[y * size + xm]) * 6;
    const dy = (hN[yp * size + x] - hN[ym * size + x]) * 6;
    const l = Math.hypot(dx, dy, 1);
    return [(-dx / l * 0.5 + 0.5) * 255, (-dy / l * 0.5 + 0.5) * 255, (1 / l * 0.5 + 0.5) * 255];
  });
  // --- macro variation (low frequency)
  const m1 = tileNoise(256, 4, 4, 61, 0.5);
  const macroC = fillFromFn(256, (x, y, i) => {
    const v = m1[i] * 255;
    return [v, v, v];
  });

  return {
    dirt: toTexture(dirtC, { aniso }),
    grass: toTexture(grassC, { aniso }),
    sand: toTexture(sandC, { aniso }),
    gravel: toTexture(gravelC, { aniso }),
    normal: toTexture(nrmC, { srgb: false, aniso }),
    macro: toTexture(macroC, { srgb: false, aniso: 1 }),
  };
}

/** Soft round sprite for dust/dirt particles. */
export function makeParticleTexture() {
  const s = 64;
  const c = canvas(s, s);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return toTexture(c, { repeat: false, srgb: false, aniso: 1 });
}

/** Leafy texture for deciduous tree canopies / bushes (tileable). */
export function makeLeafTexture(size = 256) {
  const n = tileNoise(size, 8, 5, 91, 0.6);
  const c = fillFromFn(size, (x, y, i) => {
    const v = n[i];
    const b = 0.55 + v * 0.7;
    return [70 * b, 102 * b, 44 * b];
  });
  const ctx = c.getContext('2d');
  const rng = makeRng(92);
  for (let i = 0; i < 1600; i++) {
    const x = rng() * size, y = rng() * size;
    ctx.fillStyle = rng() < 0.5 ? 'rgba(30,50,18,0.5)' : 'rgba(150,180,90,0.35)';
    ctx.beginPath();
    ctx.ellipse(x, y, 2 + rng() * 3, 1 + rng() * 2, rng() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  return toTexture(c);
}

export function makeBarkTexture(size = 128) {
  const n = tileNoise(size, 4, 4, 95, 0.5);
  const c = fillFromFn(size, (x, y, i) => {
    const stripe = Math.sin((x / size) * Math.PI * 2 * 8 + n[i] * 8) * 0.15;
    const b = 0.6 + n[i] * 0.5 + stripe;
    return [78 * b, 58 * b, 42 * b];
  });
  return toTexture(c);
}

function drawBanner(ctx, x0, y0, w, h, text, bg, fg, accent) {
  const k = w / 1024;
  ctx.save();
  ctx.translate(x0, y0);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(150 * k, 0); ctx.lineTo(90 * k, h); ctx.lineTo(0, h);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(w, 0); ctx.lineTo(w - 90 * k, 0); ctx.lineTo(w - 150 * k, h); ctx.lineTo(w, h);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.font = `italic 900 ${Math.round(150 * k)}px "Barlow Condensed", "Arial Narrow", Impact, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + 8 * k, w - 320 * k);
  ctx.restore();
}

/** Text banner (trackside advertising) with fictional sponsor names. */
export function makeBannerTexture(text, bg, fg, accent) {
  const w = 1024, h = 256;
  const c = canvas(w, h);
  drawBanner(c.getContext('2d'), 0, 0, w, h, text, bg, fg, accent);
  return toTexture(c, { repeat: false });
}

/**
 * All sponsor banners stacked in one texture (one material, one draw call).
 * Returns { texture, rect(i) -> [v0, v1] } with v measured bottom-up (flipY).
 */
export function makeBannerAtlas(sponsors) {
  const w = 512, h = 128, n = sponsors.length;
  const c = canvas(w, h * n);
  const ctx = c.getContext('2d');
  sponsors.forEach((sp, i) => drawBanner(ctx, 0, i * h, w, h, sp[0], sp[1], sp[2], sp[3]));
  const texture = toTexture(c, { repeat: false, aniso: 4 });
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  const pad = 1.5 / (h * n);
  return { texture, rect: (i) => [1 - (i + 1) / n + pad, 1 - i / n - pad] };
}

export function makeCheckerTexture() {
  const s = 256;
  const c = canvas(s, s / 4);
  const ctx = c.getContext('2d');
  const q = s / 16;
  for (let y = 0; y < 4; y++) for (let x = 0; x < 16; x++) {
    ctx.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4';
    ctx.fillRect(x * q, y * q, q, q);
  }
  const t = toTexture(c, { repeat: true });
  return t;
}

/**
 * Bike atlas: number plate (4:3) in the top three quarters, plain white below so the
 * untextured parts of the bike can share the same material.
 */
export function makeBikeAtlas(number = '27', bg = '#f2f2f2', fg = '#111') {
  const w = 256, h = 256;
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, 192);
  ctx.fillStyle = fg;
  ctx.font = '900 150px "Barlow Condensed", Impact, "Arial Narrow", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(number, w / 2, 96 + 8, w - 24);
  const t = toTexture(c, { repeat: false, aniso: 4 });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Rider atlas: jersey graphic (top), helmet graphic (middle) and a white strip (bottom). */
export function drawRiderAtlas(c, primary) {
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  drawGraphic(ctx, 0, 0, 512, 256, primary, '#ffffff', '#111111', 7);
  drawGraphic(ctx, 0, 256, 512, 256, '#f4f4f4', primary, '#111111', 11);
}
export function makeRiderAtlas(primary) {
  const c = canvas(512, 576);
  drawRiderAtlas(c, primary);
  const t = toTexture(c, { repeat: false, aniso: 4 });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Number plate with a race number. */
export function makeNumberPlate(number = '27', bg = '#f2f2f2', fg = '#111') {
  const w = 256, h = 256;
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = fg;
  ctx.font = '900 170px "Barlow Condensed", Impact, "Arial Narrow", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(number, w / 2, h / 2 + 10);
  return toTexture(c, { repeat: false });
}

function drawGraphic(ctx, x0, y0, w, h, base, stripe, accent, seed) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, w, h);
  ctx.clip();
  ctx.translate(x0, y0);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  const rng = makeRng(seed);
  ctx.fillStyle = stripe;
  for (let i = 0; i < 3; i++) {
    const x = rng() * w;
    ctx.beginPath();
    ctx.moveTo(x, 0); ctx.lineTo(x + 60, 0); ctx.lineTo(x + 140, h); ctx.lineTo(x + 80, h);
    ctx.fill();
  }
  ctx.fillStyle = accent;
  ctx.fillRect(0, h * 0.46, w, h * 0.08);
  ctx.restore();
}

/** Helmet / jersey graphics: base color with stripes. */
export function makeGraphicTexture(base, stripe, accent, seed = 3) {
  const w = 512, h = 256;
  const c = canvas(w, h);
  drawGraphic(c.getContext('2d'), 0, 0, w, h, base, stripe, accent, seed);
  return toTexture(c, { repeat: true });
}

export function makeCloudTexture(seed = 5) {
  const s = 256;
  const n = tileNoise(s, 4, 5, seed, 0.55);
  const c = canvas(s, s);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(s, s);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const dx = (x - s / 2) / (s / 2), dy = (y - s / 2) / (s / 2);
    const r = Math.sqrt(dx * dx + dy * dy * 1.8);
    const fall = Math.max(0, 1 - r);
    const v = Math.max(0, n[y * s + x] - 0.35) * 2.2 * fall;
    const i = (y * s + x) * 4;
    img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
    img.data[i + 3] = clamp(v * 255, 0, 255);
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c, { repeat: false, aniso: 1 });
}

export function makeWindowTexture() {
  const w = 128, h = 128;
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#d8d4c8';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#2d3b48';
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) ctx.fillRect(12 + x * 60, 16 + y * 60, 44, 36);
  return toTexture(c);
}

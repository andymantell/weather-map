import * as THREE from 'three';

// Tileable 3D noise textures for cloud shapes, after Schneider's "Real-time Volumetric Cloudscapes of
// Horizon Zero Dawn" (SIGGRAPH 2015): a Perlin-Worley base texture plus Worley octaves for erosion.

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One random feature point per cell, on a grid that wraps every `cells` cells. */
function worleyPoints(cells: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const points = new Float32Array(cells * cells * cells * 3);
  for (let i = 0; i < points.length; i++) points[i] = rand();
  return points;
}

/** Inverted, tileable Worley noise in [0, 1]; (x, y, z) are in [0, 1). */
function worley(points: Float32Array, cells: number, x: number, y: number, z: number): number {
  const fx = x * cells;
  const fy = y * cells;
  const fz = z * cells;
  const cx = Math.floor(fx);
  const cy = Math.floor(fy);
  const cz = Math.floor(fz);
  let best = 1e9;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ix = cx + dx;
        const iy = cy + dy;
        const iz = cz + dz;
        const wx = ((ix % cells) + cells) % cells;
        const wy = ((iy % cells) + cells) % cells;
        const wz = ((iz % cells) + cells) % cells;
        const o = ((wz * cells + wy) * cells + wx) * 3;
        const px = ix + points[o] - fx;
        const py = iy + points[o + 1] - fy;
        const pz = iz + points[o + 2] - fz;
        const d = px * px + py * py + pz * pz;
        if (d < best) best = d;
      }
    }
  }
  return 1 - Math.min(Math.sqrt(best), 1);
}

/** Tileable gradient (Perlin) noise with the given integer period, roughly in [-1, 1]. */
function makePerlin(seed: number) {
  const rand = mulberry32(seed);
  const perm = new Uint8Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const grads = [
    [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
    [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
    [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
  ];
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h: number, x: number, y: number, z: number) => {
    const g = grads[h % 12];
    return g[0] * x + g[1] * y + g[2] * z;
  };
  return (x: number, y: number, z: number, period: number) => {
    const X = Math.floor(x);
    const Y = Math.floor(y);
    const Z = Math.floor(z);
    x -= X;
    y -= Y;
    z -= Z;
    const u = fade(x);
    const v = fade(y);
    const w = fade(z);
    const h = (i: number, j: number, k: number) =>
      perm[perm[perm[(X + i) % period] + ((Y + j) % period)] + ((Z + k) % period)];
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    return lerp(
      lerp(
        lerp(grad(h(0, 0, 0), x, y, z), grad(h(1, 0, 0), x - 1, y, z), u),
        lerp(grad(h(0, 1, 0), x, y - 1, z), grad(h(1, 1, 0), x - 1, y - 1, z), u),
        v,
      ),
      lerp(
        lerp(grad(h(0, 0, 1), x, y, z - 1), grad(h(1, 0, 1), x - 1, y, z - 1), u),
        lerp(grad(h(0, 1, 1), x, y - 1, z - 1), grad(h(1, 1, 1), x - 1, y - 1, z - 1), u),
        v,
      ),
      w,
    );
  };
}

function makeTexture(data: Uint8Array, size: number): THREE.Data3DTexture {
  const texture = new THREE.Data3DTexture(data, size, size, size);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

const toByte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

/**
 * Base shape texture. R: Perlin-Worley (billowy but connected). G, B, A: inverted Worley at 4, 8 and 16 cells
 * per tile, used as an FBM to erode the base shape.
 */
export function createShapeTexture(size = 128): THREE.Data3DTexture {
  const perlin = makePerlin(7);
  const w4 = worleyPoints(4, 11);
  const w8 = worleyPoints(8, 12);
  const w16 = worleyPoints(16, 13);
  const data = new Uint8Array(size * size * size * 4);
  let o = 0;
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        const w = z / size;
        let p = 0;
        let amp = 1;
        let norm = 0;
        for (let oct = 0, f = 4; oct < 4; oct++, f *= 2) {
          p += perlin(u * f, v * f, w * f, f) * amp;
          norm += amp;
          amp *= 0.5;
        }
        p = p / norm * 0.5 + 0.5;
        const a = worley(w4, 4, u, v, w);
        const b = worley(w8, 8, u, v, w);
        const c = worley(w16, 16, u, v, w);
        const worleyFbm = a * 0.625 + b * 0.25 + c * 0.125;
        // Perlin-Worley: dilate the Perlin noise with inverted Worley to add billows.
        const pw = Math.max(0, Math.min(1, (p - (worleyFbm - 1)) / (1 - (worleyFbm - 1))));
        data[o++] = toByte(pw * 1.15 - 0.1);
        data[o++] = toByte(a);
        data[o++] = toByte(b);
        data[o++] = toByte(c);
      }
    }
  }
  return makeTexture(data, size);
}

/** Detail texture: inverted Worley at 4, 8 and 16 cells per tile, used to erode cloud edges into wisps. */
export function createDetailTexture(size = 32): THREE.Data3DTexture {
  const w4 = worleyPoints(4, 21);
  const w8 = worleyPoints(8, 22);
  const w16 = worleyPoints(16, 23);
  const data = new Uint8Array(size * size * size * 4);
  let o = 0;
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        const w = z / size;
        data[o++] = toByte(worley(w4, 4, u, v, w));
        data[o++] = toByte(worley(w8, 8, u, v, w));
        data[o++] = toByte(worley(w16, 16, u, v, w));
        data[o++] = 255;
      }
    }
  }
  return makeTexture(data, size);
}

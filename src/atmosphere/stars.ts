import * as THREE from 'three';
import { planets } from './astronomy';

/**
 * The real night sky: every Hipparcos star to magnitude 8 (public/data/stars.bin, built by
 * scripts/stars/build_stars.py) and the planets, as data textures the sky shader looks stars up in.
 *
 * The sky is split into a cube-map grid in J2000 equatorial coordinates, the same mapping the shader uses. Each cell
 * lists every star within STAR_MARGIN of it, so a pixel only has to read its own cell, even across cube faces.
 */

export const STAR_GRID = 64;
/** How far a star's light may spread from its cell, radians. Caps the size of a star's image. */
export const STAR_MARGIN = 0.3 * THREE.MathUtils.DEG2RAD;
/** Planets first, then the brightest stars (to about magnitude 2), drawn apart from the grid so they can grow. */
export const BRIGHT_COUNT = 64;
const PLANET_COUNT = 7;
export const STAR_TEXTURE_WIDTH = 1024;

/** Illuminance relative to the sun's (V = -26.74). */
export function magnitudeToIlluminance(mag: number): number {
  return Math.pow(10, -0.4 * (mag + 26.74));
}

/**
 * Wyman, Sloan & Shirley (2013) piecewise-Gaussian fit to the CIE 1931 colour matching functions.
 */
function cie(lambda: number): [number, number, number] {
  const g = (mu: number, s1: number, s2: number) => {
    const t = (lambda - mu) / (lambda < mu ? s1 : s2);
    return Math.exp(-0.5 * t * t);
  };
  return [
    1.056 * g(599.8, 37.9, 31.0) + 0.362 * g(442.0, 16.0, 26.7) - 0.065 * g(501.1, 20.4, 26.2),
    0.821 * g(568.8, 46.9, 40.5) + 0.286 * g(530.9, 16.3, 31.1),
    1.217 * g(437.0, 11.8, 36.0) + 0.681 * g(459.0, 26.0, 13.8),
  ];
}

/** Linear sRGB of a black body at temperature T kelvin, scaled to unit luminance. */
function blackbody(T: number): THREE.Vector3 {
  let X = 0;
  let Y = 0;
  let Z = 0;
  for (let lambda = 380; lambda <= 780; lambda += 5) {
    const l = lambda * 1e-9;
    const planck = 1 / (Math.pow(l, 5) * (Math.exp(1.4388e-2 / (l * T)) - 1));
    const [x, y, z] = cie(lambda);
    X += planck * x;
    Y += planck * y;
    Z += planck * z;
  }
  const r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  const g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  const b = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  const c = new THREE.Vector3(Math.max(r, 0), Math.max(g, 0), Math.max(b, 0));
  return c.divideScalar(0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z);
}

/** Colour temperature from B-V (Ballesteros 2012). */
function temperature(bv: number): number {
  const b = THREE.MathUtils.clamp(bv, -0.4, 2.0);
  return 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
}

const colourCache = new Map<number, THREE.Vector3>();
/**
 * A star's colour at unit luminance. Balanced so that a 6500 K star is white (Sirius and Vega a little blue, the sun
 * a little warm), and faint stars lose their colour: the eye sees colour only in the brightest ones.
 */
export function starColour(bv: number, mag: number): THREE.Vector3 {
  const key = Math.round(bv * 100);
  let c = colourCache.get(key);
  if (!c) {
    const white = blackbody(6500);
    c = blackbody(temperature(key / 100)).divide(white);
    c.divideScalar(0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z);
    colourCache.set(key, c);
  }
  const saturation = THREE.MathUtils.lerp(0.35, 1.15, THREE.MathUtils.clamp((4.5 - mag) / 5, 0, 1));
  return new THREE.Vector3(1, 1, 1).lerp(c, saturation).max(new THREE.Vector3());
}

function floatTexture(data: Float32Array, width: number, height: number, format: THREE.PixelFormat): THREE.DataTexture {
  const t = new THREE.DataTexture(data, width, height, format, THREE.FloatType);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export class StarField {
  readonly uniforms = {
    uStarCells: { value: floatTexture(new Float32Array(2), 1, 1, THREE.RGFormat) },
    uStarDir: { value: floatTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat) },
    uStarColour: { value: floatTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat) },
    uStarsReady: { value: 0 },
    /** xyz: J2000 direction; w unused. */
    uBrightDir: { value: Array.from({ length: BRIGHT_COUNT }, () => new THREE.Vector4()) },
    /** rgb: illuminance relative to the sun's; w: how much it twinkles (1 for a star). */
    uBrightLight: { value: Array.from({ length: BRIGHT_COUNT }, () => new THREE.Vector4()) },
  };
  private planetsAt = NaN;

  constructor(url = `${import.meta.env.BASE_URL}data/stars.bin`) {
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${url}`);
        return r.arrayBuffer();
      })
      .then((buffer) => this.build(buffer))
      .catch((error) => console.warn('Star catalogue failed to load', error));
  }

  /** Moves the planets to the given moment (they shift by a fraction of a degree a day, so once an hour will do). */
  update(date: Date): void {
    const t = date.getTime();
    if (Math.abs(t - this.planetsAt) < 3600e3) return;
    this.planetsAt = t;
    const list = planets(date);
    list.forEach((p, k) => {
      this.uniforms.uBrightDir.value[k].set(p.direction.x, p.direction.y, p.direction.z, 1);
      const c = starColour(p.bv, p.magnitude).multiplyScalar(magnitudeToIlluminance(p.magnitude));
      // Planets are discs, not points, so the air's turbulence averages out and they hardly twinkle.
      this.uniforms.uBrightLight.value[k].set(c.x, c.y, c.z, 0.15);
    });
  }

  private build(buffer: ArrayBuffer): void {
    const n = new DataView(buffer).getUint32(0, true);
    const ra = new Float32Array(buffer, 4, n);
    const dec = new Float32Array(buffer, 4 + 4 * n, n);
    const mag = new Int16Array(buffer, 4 + 8 * n, n);
    const bv = new Int16Array(buffer, 4 + 8 * n + 2 * n, n);
    const dirs = new Float32Array(3 * n);
    for (let k = 0; k < n; k++) {
      const cd = Math.cos(dec[k]);
      dirs[3 * k] = cd * Math.cos(ra[k]);
      dirs[3 * k + 1] = cd * Math.sin(ra[k]);
      dirs[3 * k + 2] = Math.sin(dec[k]);
    }

    // Cells each star reaches, in two passes: count, then fill.
    const N = STAR_GRID;
    const counts = new Uint32Array(6 * N * N);
    const visit = (k: number, fn: (cell: number) => void) => {
      const v = [dirs[3 * k], dirs[3 * k + 1], dirs[3 * k + 2]];
      for (let axis = 0; axis < 3; axis++) {
        for (const sign of [1, -1]) {
          const along = sign * v[axis];
          if (along < 0.5) continue;
          // Same face layout as the shader: x faces use (y, z), y faces (x, z), z faces (x, y).
          const [i, j] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
          const u = v[i] / along;
          const w = v[j] / along;
          const m = STAR_MARGIN * (1 + u * u + w * w);
          if (Math.abs(u) > 1 + m || Math.abs(w) > 1 + m) continue;
          const face = axis * 2 + (sign > 0 ? 0 : 1);
          const x0 = Math.max(0, Math.floor(((u - m) * 0.5 + 0.5) * N));
          const x1 = Math.min(N - 1, Math.floor(((u + m) * 0.5 + 0.5) * N));
          const y0 = Math.max(0, Math.floor(((w - m) * 0.5 + 0.5) * N));
          const y1 = Math.min(N - 1, Math.floor(((w + m) * 0.5 + 0.5) * N));
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) fn((face * N + y) * N + x);
        }
      }
    };
    // The brightest stars are drawn from the bright list instead.
    const firstInGrid = BRIGHT_COUNT - PLANET_COUNT;
    for (let k = firstInGrid; k < n; k++) visit(k, (c) => counts[c]++);
    const starts = new Uint32Array(counts.length);
    let total = 0;
    let most = 0;
    for (let c = 0; c < counts.length; c++) {
      starts[c] = total;
      total += counts[c];
      most = Math.max(most, counts[c]);
    }
    const height = Math.ceil(total / STAR_TEXTURE_WIDTH);
    const dirData = new Float32Array(STAR_TEXTURE_WIDTH * height * 4);
    const colourData = new Float32Array(STAR_TEXTURE_WIDTH * height * 4);
    const fill = starts.slice();
    for (let k = firstInGrid; k < n; k++) {
      const m = mag[k] / 100;
      const e = magnitudeToIlluminance(m);
      const c = starColour(bv[k] / 1000, m);
      visit(k, (cell) => {
        const o = 4 * fill[cell]++;
        dirData.set([dirs[3 * k], dirs[3 * k + 1], dirs[3 * k + 2], e], o);
        colourData.set([c.x, c.y, c.z, 1], o);
      });
    }
    const cellData = new Float32Array(2 * counts.length);
    for (let c = 0; c < counts.length; c++) {
      cellData[2 * c] = starts[c];
      cellData[2 * c + 1] = counts[c];
    }
    const u = this.uniforms;
    u.uStarCells.value.dispose();
    u.uStarDir.value.dispose();
    u.uStarColour.value.dispose();
    u.uStarCells.value = floatTexture(cellData, N, 6 * N, THREE.RGFormat);
    u.uStarDir.value = floatTexture(dirData, STAR_TEXTURE_WIDTH, height, THREE.RGBAFormat);
    u.uStarColour.value = floatTexture(colourData, STAR_TEXTURE_WIDTH, height, THREE.RGBAFormat);

    // The brightest stars after the planets (the catalogue is sorted brightest first).
    for (let k = 0; k < firstInGrid; k++) {
      const m = mag[k] / 100;
      const c = starColour(bv[k] / 1000, m).multiplyScalar(magnitudeToIlluminance(m));
      u.uBrightDir.value[PLANET_COUNT + k].set(dirs[3 * k], dirs[3 * k + 1], dirs[3 * k + 2], 1);
      u.uBrightLight.value[PLANET_COUNT + k].set(c.x, c.y, c.z, 1);
    }
    u.uStarsReady.value = 1;
    console.info(`Stars: ${n} from the catalogue (to magnitude ${mag[firstInGrid] / 100} in the bright list), ${total} cell entries, at most ${most} in a cell`);
  }
}

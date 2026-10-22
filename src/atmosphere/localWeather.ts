import * as THREE from 'three';
import type { UkvCloudData } from '../weather/clouds';

/** Sidecar written by pipeline/ukv_surface.py. */
export interface UkvSurfaceMeta {
  valid_time: string;
  grid: { width: number; height: number; x_west: number; y_north: number; dx: number; dy: number };
}

/** Screen-level visibility (km) on the cloud grid, row 0 north. */
export interface SurfaceField {
  meta: UkvSurfaceMeta;
  visibility: Float32Array;
}

const VIS_MIN_M = 10;
const VIS_MAX_M = 100000;

/** Loads the visibility baked by pipeline/ukv_surface.py; resolves undefined if there is none. */
export async function loadUkvSurface(baseUrl: string): Promise<SurfaceField | undefined> {
  try {
    const meta = (await fetch(`${baseUrl}data/ukv-surface.json`).then((r) => r.json())) as UkvSurfaceMeta;
    const blob = await fetch(`${baseUrl}data/ukv-surface.png`).then((r) => r.blob());
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const visibility = new Float32Array(bitmap.width * bitmap.height);
    for (let i = 0; i < visibility.length; i++) {
      visibility[i] = (VIS_MIN_M * Math.pow(VIS_MAX_M / VIS_MIN_M, data[i * 4] / 255)) / 1000;
    }
    return { meta, visibility };
  } catch (error) {
    console.warn('No UKV surface fields; haze falls back to rain and low cloud', error);
    return undefined;
  }
}

/** The weather over one spot, as the atmosphere needs it. */
export interface LocalWeather {
  /** Fraction of the sky overhead covered by cloud, 0 to 1. */
  cover: number;
  /** Cloud base and top over the spot, km above the ground as drawn (times the cloud height scale). */
  base: number;
  top: number;
  /** Fraction of the key light (sun or moon) that reaches the air near the ground through the cloud. */
  keyLight: number;
  /** Meteorological visibility near the ground, km. */
  visibility: number;
}

/**
 * Reads the UKV fields around a point on the CPU: the cloud volume (the same bytes the clouds draw from), the
 * rain rate and, when baked, the screen-level visibility.
 */
export class WeatherSampler {
  private regionalVisibility = 25;

  constructor(
    private readonly data: UkvCloudData,
    private surface?: SurfaceField,
  ) {
    this.dataChanged();
  }

  setSurface(surface: SurfaceField | undefined): void {
    this.surface = surface;
    this.dataChanged();
  }

  /** Recomputes anything derived from the whole grid; call after the fields change (a new time step). */
  dataChanged(): void {
    if (!this.surface) return;
    // Log-mean visibility over the land and sea, for views from high up.
    const v = this.surface.visibility;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < v.length; i += 7) {
      sum += Math.log(v[i]);
      n++;
    }
    this.regionalVisibility = Math.exp(sum / n);
  }

  private cell(x: number, z: number): { col: number; row: number } {
    const g = this.data.meta.grid;
    return { col: (x * 1000 - g.x_west) / g.dx, row: (g.y_north + z * 1000) / Math.abs(g.dy) };
  }

  /** Cloud fraction at slice k, nearest cell, 0 outside the grid. */
  private fraction(col: number, row: number, k: number): number {
    const { width: nx, height: ny } = this.data.meta.grid;
    const c = Math.round(col);
    const r = Math.round(row);
    if (c < 0 || r < 0 || c >= nx || r >= ny) return 0;
    const voxels = this.data.volume.image.data as Uint8Array;
    return voxels[(k * ny + r) * nx + c] / 255;
  }

  private rain(col: number, row: number): number {
    const { width: nx, height: ny } = this.data.meta.grid;
    const c = THREE.MathUtils.clamp(Math.round(col), 0, nx - 1);
    const r = THREE.MathUtils.clamp(Math.round(row), 0, ny - 1);
    const px = this.data.fields.image.data as Uint8Array;
    const v = px[(r * nx + c) * 4] / 255;
    return 64 * v * v;
  }

  /**
   * Weather at world point (x, z) km for a camera altH km above the ground there. keyDir is the direction to the
   * sun or moon; cloudScale is the clouds' vertical stretch.
   */
  sample(x: number, z: number, altH: number, keyDir: THREE.Vector3, cloudScale: number): LocalWeather {
    const { slices, slice_height_m } = this.data.meta.volume;
    const dz = slice_height_m / 1000;
    const { col, row } = this.cell(x, z);
    const spacing = this.data.meta.grid.dx / 1000;

    // Mean cloud fraction per slice over a disc about 10 km across, and the cover (column maximum) there.
    const profile = new Float32Array(slices);
    let cover = 0;
    let n = 0;
    const R = Math.max(1, Math.round(5 / spacing));
    for (let dr = -R; dr <= R; dr++) {
      for (let dc = -R; dc <= R; dc++) {
        if (dr * dr + dc * dc > R * R) continue;
        let colMax = 0;
        for (let k = 0; k < slices; k++) {
          const f = this.fraction(col + dc, row + dr, k);
          profile[k] += f;
          colMax = Math.max(colMax, f);
        }
        cover += colMax;
        n++;
      }
    }
    cover /= n;
    for (let k = 0; k < slices; k++) profile[k] /= n;
    let kBase = profile.findIndex((f) => f > 0.2);
    let kTop = kBase;
    if (kBase >= 0) {
      for (let k = kBase; k < slices; k++) if (profile[k] > 0.2) kTop = k;
    } else {
      kBase = kTop = slices;
    }

    // How much of the key light gets down through the cloud along its path to the air around here. Cloud cells
    // overlap at random, but each layer's fraction mostly stacks with the one below, so take the worst layer.
    const elevation = Math.asin(THREE.MathUtils.clamp(keyDir.y, -1, 1));
    const horiz = new THREE.Vector2(keyDir.x, keyDir.z);
    if (horiz.lengthSq() > 1e-8) horiz.normalize();
    let blocked = 0;
    for (let k = 0; k < slices; k++) {
      const height = (k + 0.5) * dz * cloudScale;
      const reach = Math.min(height / Math.tan(Math.max(elevation, 0.03)), 120);
      let f = 0;
      for (let s = -1; s <= 1; s++) {
        const ox = horiz.x * reach + -horiz.y * s * 1.5;
        const oz = horiz.y * reach + horiz.x * s * 1.5;
        f += this.fraction(col + ox / spacing, row + oz / spacing, k) / 3;
      }
      blocked = Math.max(blocked, f);
    }
    const keyLight = 1 - blocked;

    // Visibility: UKV's own when baked, else clean air thinned by rain, or fog if cloud sits on the ground.
    let visibility: number;
    const local = this.surfaceVisibility(col, row);
    if (local !== undefined) {
      visibility = local;
    } else {
      const rain = this.rain(col, row);
      const extinction = 3.912 / 30 + (rain > 0.05 ? 0.16 * Math.pow(rain, 0.74) * 0.6 : 0);
      visibility = 3.912 / extinction;
      const ground = this.fraction(col, row, 0);
      if (ground > 0.3) visibility = Math.min(visibility, THREE.MathUtils.lerp(2, 0.15, (ground - 0.3) / 0.7));
    }
    // From high up the view takes in the whole region's haze rather than this spot's.
    const high = THREE.MathUtils.smoothstep(Math.log(altH + 1e-3), Math.log(1), Math.log(40));
    visibility = Math.exp(THREE.MathUtils.lerp(Math.log(visibility), Math.log(this.regionalVisibility), high));

    return { cover, base: kBase * dz * cloudScale, top: (kTop + 1) * dz * cloudScale, keyLight, visibility };
  }

  /** Log-mean visibility over a few km, or undefined without the surface field. */
  private surfaceVisibility(col: number, row: number): number | undefined {
    if (!this.surface) return undefined;
    const { width: nx, height: ny } = this.surface.meta.grid;
    let sum = 0;
    let n = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const c = THREE.MathUtils.clamp(Math.round(col) + dc, 0, nx - 1);
        const r = THREE.MathUtils.clamp(Math.round(row) + dr, 0, ny - 1);
        const w = dr === 0 && dc === 0 ? 4 : 1;
        sum += w * Math.log(this.surface.visibility[r * nx + c]);
        n += w;
      }
    }
    return Math.exp(sum / n);
  }
}

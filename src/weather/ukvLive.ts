import * as THREE from 'three';
import { Hdf5File } from '../data/hdf5';
import type { HeightmapMeta } from '../heightmap';
import type { UkvFieldMeta } from '../rain';
import type { UkvCloudData, UkvCloudMeta } from './clouds';

/**
 * Reads Met Office UKV NetCDF straight from the public S3 bucket in the browser and bakes, for any moment in the
 * next hour, the same cloud volume and 2D fields that pipeline/ukv_clouds.py writes. Each file holds one field at
 * one time, so a timeline is a set of files: the hourly cloud volume, cloud base and high cloud, and the 15-minute
 * precipitation rate and CAPE. Only the 128x128 chunks over the terrain are fetched.
 */

const BUCKET = 'https://met-office-atmospheric-model-data.s3.eu-west-2.amazonaws.com/uk-deterministic-2km/';
/** UKV standard grid, cell centres in LAEA metres; the files store rows from the south. */
const UKV = { x0: -1158000, y0: -1036000, dx: 2000, width: 1042, height: 970 };
const ATTRIBUTION = 'Contains Met Office data © Crown copyright, licensed under CC BY-SA 4.0';
const HOUR = 3600e3;
const QUARTER = 900e3;

const VOLUME = { param: 'cloud_amount_on_height_levels', variable: 'cloud_volume_fraction_in_atmosphere_layer' };
const HOURLY = {
  base: { param: 'height_AGL_at_cloud_base_where_cloud_cover_2p5_oktas', variable: 'cloud_base_height_2p5_oktas' },
  high: { param: 'cloud_amount_of_high_cloud', variable: 'high_type_cloud_area_fraction' },
};
const QUARTERLY = {
  precip: { param: 'precipitation_rate', variable: 'lwe_precipitation_rate' },
  cape: { param: 'CAPE_surface', variable: 'atmosphere_convective_available_potential_energy_wrt_surface' },
};
/** Same encodings as pipeline/ukv_clouds.py. */
const RAIN_MAX_MM_H = 64;
const BASE_MAX_KM = 8;
const CAPE_MAX = 2000;
const SLICES = 30;
const TOP_M = 6000;
/** The flat rain overlay's 16-bit code: rate (m/s) = offset + scale * code, 0 = no data. */
const RAIN_SCALE = 1e-7;

const stamp = (t: Date) => t.toISOString().slice(0, 16).replace(/[-:]/g, '') + 'Z';

function fileUrl(run: Date, valid: Date, param: string): string {
  const minutes = Math.round((valid.getTime() - run.getTime()) / 60e3);
  const period = `PT${String(Math.floor(minutes / 60)).padStart(4, '0')}H${String(minutes % 60).padStart(2, '0')}M`;
  return `${BUCKET}${stamp(run)}/${stamp(valid)}-${period}-${param}.nc`;
}

export interface LiveStats {
  files: number;
  bytes: number;
  requests: number;
  /** What the same files weigh whole. */
  fileBytes: number;
  seconds: number;
}

export interface UkvLive {
  data: UkvCloudData;
  /** The flat precipitation overlay's field, kept in step with the timeline. */
  rainField: { meta: UkvFieldMeta; texture: THREE.DataTexture };
  run: Date;
  start: Date;
  end: Date;
  /** Bakes the fields for time t (clamped to what has loaded) into the shared textures. */
  setTime(t: Date): void;
  /** Latest time whose data has loaded. */
  loadedUntil(): Date;
  /** Resolves when every file in the hour has loaded. */
  complete: Promise<LiveStats>;
  stats: LiveStats;
}

/** Index ranges of the crop in the file's own (south-first) row order. */
interface Crop {
  col: number;
  row: number;
  nx: number;
  ny: number;
}

function cropFor(hm: HeightmapMeta): Crop {
  const col = Math.round((hm.xMin - UKV.x0) / UKV.dx);
  const row = Math.round((hm.yMin - UKV.y0) / UKV.dx);
  const nx = Math.round((hm.xMax - hm.xMin) / UKV.dx) + 1;
  const ny = Math.round((hm.yMax - hm.yMin) / UKV.dx) + 1;
  if (col < 0 || row < 0 || col + nx > UKV.width || row + ny > UKV.height) throw new Error('Terrain is outside UKV');
  return { col, row, nx, ny };
}

/** Newest run (hourly, up to 12 h ahead) that already has the cloud volume valid at `last`. */
async function findRun(now: Date, last: Date): Promise<Date> {
  const hour = Math.floor(now.getTime() / HOUR) * HOUR;
  // UKV runs appear about 3 h 15 min after their nominal time.
  for (let back = 2; back <= 11; back++) {
    const run = new Date(hour - back * HOUR);
    if (last.getTime() - run.getTime() > 12 * HOUR) break;
    const response = await fetch(fileUrl(run, last, VOLUME.param), { method: 'HEAD' });
    if (response.ok) return run;
  }
  throw new Error('No UKV run in the bucket covers the next hour');
}

async function readField(
  url: string,
  variable: string,
  crop: Crop,
  stats: LiveStats,
  levels?: [number, number],
): Promise<{ data: Float32Array; fill?: number; heights?: Float32Array }> {
  const file = await Hdf5File.open(url);
  const ds = await file.dataset(variable);
  const yx = ds.shape.slice(-2);
  if (yx[0] !== UKV.height || yx[1] !== UKV.width) throw new Error(`${url}: unexpected grid ${ds.shape}`);
  let heights: Float32Array | undefined;
  let start = [crop.row, crop.col];
  let count = [crop.ny, crop.nx];
  if (ds.shape.length === 3) {
    heights = await file.readSlab(await file.dataset('height'), [0], [ds.shape[0]]);
    const [k0, k1] = levels ?? [0, ds.shape[0] - 1];
    start = [k0, ...start];
    count = [k1 - k0 + 1, ...count];
  }
  const data = await file.readSlab(ds, start, count);
  stats.files++;
  stats.bytes += file.reader.bytes;
  stats.requests += file.reader.requests;
  stats.fileBytes += file.reader.size;
  return { data, fill: ds.fillValue, heights };
}

/** Native UKV heights the uniform slices need, and how to blend them. */
function sliceWeights(heights: Float32Array) {
  const dz = TOP_M / SLICES;
  return Array.from({ length: SLICES }, (_, k) => {
    const h = (k + 0.5) * dz;
    let i = heights.findIndex((z) => z >= h) - 1;
    i = Math.min(Math.max(i, 0), heights.length - 2);
    const t = Math.min(Math.max((h - heights[i]) / (heights[i + 1] - heights[i]), 0), 1);
    return { i, t };
  });
}

/** UKV's standard height levels (metres AGL), used to choose which levels to fetch before any file is open. */
const UKV_HEIGHTS = new Float32Array([
  5, 10, 20, 30, 50, 75, 100, 150, 200, 250, 300, 400, 500, 600, 700, 800, 1000, 1250, 1500, 1750, 2000, 2250, 2500,
  2750, 3000, 3250, 3500, 3750, 4000, 4500, 5000, 5500, 6000,
]);

/** Resamples a (levels, south-first rows, cols) block into uniform north-first slices, 0..255. */
function bakeVolume(block: Float32Array, k0: number, heights: Float32Array, crop: Crop, fill?: number): Uint8Array {
  const { nx, ny } = crop;
  const plane = nx * ny;
  const out = new Uint8Array(plane * SLICES);
  const at = (k: number, i: number) => {
    const v = block[(k - k0) * plane + i];
    return v === fill || !(v > 0) ? 0 : Math.min(v, 1);
  };
  sliceWeights(heights).forEach(({ i: k, t }, s) => {
    for (let r = 0; r < ny; r++) {
      const src = r * nx;
      const dst = s * plane + (ny - 1 - r) * nx;
      for (let c = 0; c < nx; c++) {
        const v = at(k, src + c) * (1 - t) + at(k + 1, src + c) * t;
        out[dst + c] = Math.round(v * 255);
      }
    }
  });
  return out;
}

/** Flips a south-first field to north-first and turns fill values into NaN. */
function northFirst(field: Float32Array, crop: Crop, fill?: number): Float32Array {
  const { nx, ny } = crop;
  const out = new Float32Array(nx * ny);
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const v = field[r * nx + c];
      out[(ny - 1 - r) * nx + c] = v === fill || Math.abs(v) > 1e30 ? NaN : v;
    }
  }
  return out;
}

function lerpField(a: Float32Array, b: Float32Array, t: number, out: Float32Array) {
  for (let i = 0; i < out.length; i++) {
    const x = a[i];
    const y = b[i];
    // A cloud base that appears or vanishes cannot be blended; take the nearer step.
    out[i] = Number.isNaN(x) || Number.isNaN(y) ? (t < 0.5 ? x : y) : x + (y - x) * t;
  }
}

/** Finds the two loaded steps around t and the blend between them. */
function bracket<T>(steps: { time: number; value?: T }[], t: number): { a: T; b: T; f: number } | undefined {
  const loaded = steps.filter((s) => s.value);
  if (!loaded.length) return undefined;
  if (t <= loaded[0].time) return { a: loaded[0].value!, b: loaded[0].value!, f: 0 };
  for (let i = 0; i < loaded.length - 1; i++) {
    const s0 = loaded[i];
    const s1 = loaded[i + 1];
    if (t <= s1.time) return { a: s0.value!, b: s1.value!, f: (t - s0.time) / (s1.time - s0.time) };
  }
  const last = loaded[loaded.length - 1].value!;
  return { a: last, b: last, f: 0 };
}

/**
 * Starts loading the hour from `now` (rounded down to the quarter hour). Resolves once the first hour's cloud
 * volume and the first 2D fields are in, so the map can show them; the rest of the hour keeps loading behind.
 */
export async function loadUkvLive(hm: HeightmapMeta, now = new Date()): Promise<UkvLive> {
  const t0 = performance.now();
  const crop = cropFor(hm);
  const start = new Date(Math.floor(now.getTime() / QUARTER) * QUARTER);
  const end = new Date(start.getTime() + HOUR);
  const firstHour = Math.floor(start.getTime() / HOUR) * HOUR;
  const lastHour = Math.ceil(end.getTime() / HOUR) * HOUR;
  const run = await findRun(now, new Date(lastHour));
  const stats: LiveStats = { files: 0, bytes: 0, requests: 0, fileBytes: 0, seconds: 0 };

  const weights = sliceWeights(UKV_HEIGHTS);
  const levels: [number, number] = [weights[0].i, weights[weights.length - 1].i + 1];

  type Hourly = { volume: Uint8Array; base: Float32Array; high: Float32Array };
  type Quarterly = { precip: Float32Array; cape: Float32Array };
  const hours: { time: number; value?: Hourly }[] = [];
  for (let t = firstHour; t <= lastHour; t += HOUR) hours.push({ time: t });
  const quarters: { time: number; value?: Quarterly }[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += QUARTER) quarters.push({ time: t });

  const loadHour = async (slot: (typeof hours)[number]) => {
    const valid = new Date(slot.time);
    const [vol, base, high] = await Promise.all([
      readField(fileUrl(run, valid, VOLUME.param), VOLUME.variable, crop, stats, levels),
      readField(fileUrl(run, valid, HOURLY.base.param), HOURLY.base.variable, crop, stats),
      readField(fileUrl(run, valid, HOURLY.high.param), HOURLY.high.variable, crop, stats),
    ]);
    if (vol.heights && vol.heights.some((h, i) => Math.abs(h - UKV_HEIGHTS[i]) > 0.5)) {
      throw new Error('UKV height levels have changed');
    }
    slot.value = {
      volume: bakeVolume(vol.data, levels[0], UKV_HEIGHTS, crop, vol.fill),
      base: northFirst(base.data, crop, base.fill),
      high: northFirst(high.data, crop, high.fill),
    };
  };
  const loadQuarter = async (slot: (typeof quarters)[number]) => {
    const valid = new Date(slot.time);
    const [precip, cape] = await Promise.all([
      readField(fileUrl(run, valid, QUARTERLY.precip.param), QUARTERLY.precip.variable, crop, stats),
      readField(fileUrl(run, valid, QUARTERLY.cape.param), QUARTERLY.cape.variable, crop, stats),
    ]);
    slot.value = { precip: northFirst(precip.data, crop, precip.fill), cape: northFirst(cape.data, crop, cape.fill) };
  };

  // The first hour and quarter first, so there is something to show; then the rest in time order.
  await Promise.all([loadHour(hours[0]), loadQuarter(quarters[0])]);
  const firstSeconds = (performance.now() - t0) / 1000;
  const complete = (async () => {
    for (let i = 1; i < Math.max(hours.length, quarters.length); i++) {
      await Promise.all([hours[i] && loadHour(hours[i]), quarters[i] && loadQuarter(quarters[i])]);
    }
    stats.seconds = (performance.now() - t0) / 1000;
    return stats;
  })();

  const { nx, ny } = crop;
  const grid = {
    width: nx,
    height: ny,
    x_west: hm.xMin,
    y_north: hm.yMax,
    dx: UKV.dx,
    dy: -UKV.dx,
  };
  const meta: UkvCloudMeta = {
    valid_time: start.toISOString(),
    forecast_reference_time: run.toISOString(),
    grid,
    volume: { slices: SLICES, slice_height_m: TOP_M / SLICES, atlas_columns: 0, atlas_rows: 0 },
    max_precip_mm_h: 0,
    attribution: ATTRIBUTION,
  };
  const volume = new THREE.Data3DTexture(new Uint8Array(nx * ny * SLICES), nx, ny, SLICES);
  volume.format = THREE.RedFormat;
  volume.type = THREE.UnsignedByteType;
  volume.minFilter = volume.magFilter = THREE.LinearFilter;
  volume.wrapS = volume.wrapT = volume.wrapR = THREE.ClampToEdgeWrapping;
  volume.unpackAlignment = 1;
  const fields = new THREE.DataTexture(new Uint8Array(nx * ny * 4), nx, ny, THREE.RGBAFormat);
  fields.minFilter = fields.magFilter = THREE.LinearFilter;

  // The flat overlay samples rows from the south (a DataTexture is not flipped), with 16-bit codes in R and G.
  const rainTexture = new THREE.DataTexture(new Uint8Array(nx * ny * 4), nx, ny, THREE.RGBAFormat);
  rainTexture.magFilter = rainTexture.minFilter = THREE.NearestFilter;
  rainTexture.generateMipmaps = false;
  const rainMeta = {
    units: 'm s-1',
    valid_time: meta.valid_time,
    forecast_reference_time: meta.forecast_reference_time,
    grid,
    encoding: { offset: -RAIN_SCALE, scale: RAIN_SCALE },
    attribution: ATTRIBUTION,
  } satisfies UkvFieldMeta;

  const scratch = {
    precip: new Float32Array(nx * ny),
    cape: new Float32Array(nx * ny),
    base: new Float32Array(nx * ny),
    high: new Float32Array(nx * ny),
  };

  // Steps load in time order, so the timeline is good up to the last step loaded in each series.
  const lastLoaded = (steps: { time: number; value?: unknown }[]) => {
    const i = steps.findIndex((s) => !s.value);
    return steps[(i < 0 ? steps.length : i) - 1].time;
  };
  const loadedUntil = () =>
    new Date(Math.max(start.getTime(), Math.min(lastLoaded(hours), lastLoaded(quarters))));

  const setTime = (time: Date) => {
    const t = Math.min(time.getTime(), loadedUntil().getTime());
    const h = bracket(hours, t)!;
    const q = bracket(quarters, t)!;
    const vox = volume.image.data as Uint8Array;
    const f = h.f;
    for (let i = 0; i < vox.length; i++) vox[i] = h.a.volume[i] + (h.b.volume[i] - h.a.volume[i]) * f + 0.5;
    lerpField(h.a.base, h.b.base, f, scratch.base);
    lerpField(h.a.high, h.b.high, f, scratch.high);
    lerpField(q.a.precip, q.b.precip, q.f, scratch.precip);
    lerpField(q.a.cape, q.b.cape, q.f, scratch.cape);

    const px = fields.image.data as Uint8Array;
    const rain = rainTexture.image.data as Uint8Array;
    let maxRain = 0;
    for (let i = 0; i < nx * ny; i++) {
      const rate = Number.isNaN(scratch.precip[i]) ? 0 : Math.max(scratch.precip[i], 0);
      const mmh = rate * 3.6e6;
      maxRain = Math.max(maxRain, mmh);
      const baseKm = scratch.base[i] / 1000;
      px[i * 4] = Math.round(Math.sqrt(Math.min(mmh / RAIN_MAX_MM_H, 1)) * 255);
      px[i * 4 + 1] = Number.isNaN(baseKm) ? 255 : Math.round(Math.min(baseKm / BASE_MAX_KM, 254 / 255) * 255);
      px[i * 4 + 2] = Math.round(Math.min(Math.max(scratch.high[i] || 0, 0), 1) * 255);
      px[i * 4 + 3] = Math.round(Math.sqrt(Math.min(Math.max(scratch.cape[i] || 0, 0) / CAPE_MAX, 1)) * 255);
      // Rain overlay: back to south-first rows.
      const r = ny - 1 - Math.floor(i / nx);
      const j = (r * nx + (i % nx)) * 4;
      const code = Number.isNaN(scratch.precip[i]) ? 0 : Math.min(Math.round(rate / RAIN_SCALE) + 1, 65535);
      rain[j] = code >> 8;
      rain[j + 1] = code & 255;
      rain[j + 3] = 255;
    }
    meta.valid_time = rainMeta.valid_time = new Date(t).toISOString();
    meta.max_precip_mm_h = maxRain;
    volume.needsUpdate = fields.needsUpdate = rainTexture.needsUpdate = true;
  };

  stats.seconds = firstSeconds;
  const live: UkvLive = {
    data: { meta, volume, fields },
    rainField: { meta: rainMeta, texture: rainTexture },
    run,
    start,
    end,
    setTime,
    loadedUntil,
    complete,
    stats,
  };
  setTime(start);
  return live;
}

const hhmm = (t: Date) => t.toISOString().slice(11, 16);

/** Adds a time slider across the hour, with what has loaded and what it cost, to the HUD. */
export function mountTimeControls(hud: HTMLElement, live: UkvLive, onChange: () => void): void {
  const box = document.createElement('div');
  box.innerHTML = `
    <label>Time <input type="range" min="0" max="60" step="1" value="0" /> <output></output></label>
    <p class="hint"></p>`;
  const input = box.querySelector('input')!;
  const output = box.querySelector('output')!;
  const hint = box.querySelector('p')!;
  const describe = () => {
    const { files, bytes, requests, seconds } = live.stats;
    const until = live.loadedUntil();
    const loading = until < live.end ? ` Loaded to ${hhmm(until)}…` : '';
    hint.textContent =
      `Live UKV, run ${live.run.toISOString().slice(0, 13).replace('T', ' ')}Z, read in the browser from the ` +
      `Met Office bucket: ${files} files, ${(bytes / 1e6).toFixed(1)} MB in ${requests} requests, ` +
      `${seconds.toFixed(1)} s.${loading}`;
  };
  const update = () => {
    const t = new Date(live.start.getTime() + Number(input.value) * 60e3);
    const shown = t > live.loadedUntil() ? live.loadedUntil() : t;
    live.setTime(shown);
    output.textContent = `${hhmm(shown)} UTC`;
    onChange();
  };
  input.addEventListener('input', update);
  live.complete.then(describe, (error) => {
    console.error('Live UKV failed to load the rest of the hour', error);
    hint.textContent += ' The rest of the hour failed to load.';
  });
  describe();
  output.textContent = `${hhmm(live.start)} UTC`;
  hud.appendChild(box);
}

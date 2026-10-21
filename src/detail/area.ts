/** Loads one detailed terrain area built by scripts/detail/build_area.py. */

export interface AreaMeta {
  proj: string;
  /** Grid extent in LAEA metres. */
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  spacing: number;
  width: number;
  height: number;
  coverTexel: number;
  coverWidth: number;
  coverHeight: number;
  minHeight: number;
  maxHeight: number;
  buildings: number;
  trees: number;
  hasCoast: boolean;
  classes: Record<string, number>;
  /** Sentinel-2 colour image (scripts/detail/build_imagery.py), north up from xMin, yMax. */
  imagery?: { pixel: number; width: number; height: number; scenes: number };
  attribution: string;
}

export interface Area {
  name: string;
  meta: AreaMeta;
  /** Heights in metres, row-major from the north-west corner. */
  heights: Float32Array;
  /** Land-cover class per texel, row-major from the north-west corner. */
  cover: Uint8Array;
  buildings: ArrayBuffer;
  trees: Float32Array;
  /** Satellite colour, if the area has it. */
  imagery: ImageBitmap | null;
  /** Size in metres; local scene X runs east from xMin, Z runs south from yMax. */
  sizeX: number;
  sizeZ: number;
}

async function pixels(url: string): Promise<Uint8ClampedArray> {
  const blob = await fetch(url).then((r) => r.blob());
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

export async function loadArea(baseUrl: string, name: string): Promise<Area> {
  const dir = `${baseUrl}data/detail/${name}/`;
  const [meta, heightPx, coverPx, buildings, trees] = await Promise.all([
    fetch(`${dir}meta.json`).then((r) => r.json() as Promise<AreaMeta>),
    pixels(`${dir}height.png`),
    pixels(`${dir}cover.png`),
    fetch(`${dir}buildings.bin`).then((r) => r.arrayBuffer()),
    fetch(`${dir}trees.bin`).then((r) => r.arrayBuffer()),
  ]);
  const imagery = meta.imagery
    ? await fetch(`${dir}imagery.jpg`)
        .then((r) => r.blob())
        .then((b) => createImageBitmap(b, { imageOrientation: 'none' }))
    : null;
  const heights = new Float32Array(meta.width * meta.height);
  for (let i = 0; i < heights.length; i++) {
    const p = i * 4;
    heights[i] = heightPx[p] * 256 + heightPx[p + 1] + heightPx[p + 2] / 256 - 32768;
  }
  const cover = new Uint8Array(meta.coverWidth * meta.coverHeight);
  for (let i = 0; i < cover.length; i++) cover[i] = coverPx[i * 4];
  return {
    name,
    meta,
    heights,
    cover,
    buildings,
    trees: new Float32Array(trees),
    imagery,
    sizeX: meta.xMax - meta.xMin,
    sizeZ: meta.yMax - meta.yMin,
  };
}

/** Bilinear terrain height (metres) at local scene x/z metres. */
export function heightAt(area: Area, x: number, z: number): number {
  const { meta, heights } = area;
  const fx = Math.min(Math.max(x / meta.spacing, 0), meta.width - 1.001);
  const fz = Math.min(Math.max(z / meta.spacing, 0), meta.height - 1.001);
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const a = fx - i;
  const b = fz - j;
  const w = meta.width;
  return (
    heights[j * w + i] * (1 - a) * (1 - b) +
    heights[j * w + i + 1] * a * (1 - b) +
    heights[(j + 1) * w + i] * (1 - a) * b +
    heights[(j + 1) * w + i + 1] * a * b
  );
}

/** Land-cover class at local scene x/z metres. */
export function coverAt(area: Area, x: number, z: number): number {
  const { meta, cover } = area;
  const i = Math.min(Math.max(Math.floor(x / meta.coverTexel), 0), meta.coverWidth - 1);
  const j = Math.min(Math.max(Math.floor(z / meta.coverTexel), 0), meta.coverHeight - 1);
  return cover[j * meta.coverWidth + i];
}

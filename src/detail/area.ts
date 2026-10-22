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
  /** The adaptive ground mesh in ground.bin, if the area has one (fine raster step in m). */
  mesh?: { step: number; vertices: number; triangles: number; maxError: number };
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
  /** The adaptive ground mesh, if the area has one; otherwise the ground is the height grid. */
  tin: Tin | null;
  /** Satellite colour, if the area has it. */
  imagery: ImageBitmap | null;
  /** Size in metres; local scene X runs east from xMin, Z runs south from yMax. */
  sizeX: number;
  sizeZ: number;
}

/**
 * An adaptive triangle mesh of the ground (scripts/detail/build_area.py write_mesh): dense on
 * cliffs and slopes, sparse on flat ground. A grid of cells lists the triangles over each, so
 * heights exactly on the mesh can be looked up quickly.
 */
export interface Tin {
  /** Per vertex: x east, height, z south, in local metres. */
  positions: Float32Array;
  /** Counter-clockwise seen from above. */
  indices: Uint32Array;
  cell: number;
  cols: number;
  rows: number;
  /** Triangles over cell c are cellTris[cellStart[c] .. cellStart[c + 1]). */
  cellStart: Uint32Array;
  cellTris: Uint32Array;
}

const TIN_CELL = 32;

function parseTin(buf: ArrayBuffer, step: number): Tin {
  const head = new DataView(buf);
  const n = head.getUint32(0, true);
  const t = head.getUint32(4, true);
  // Copies, because the int16 and uint32 arrays need not start on aligned offsets.
  const cols = new Uint16Array(buf.slice(12, 12 + 2 * n));
  const rows = new Uint16Array(buf.slice(12 + 2 * n, 12 + 4 * n));
  const h = new Int16Array(buf.slice(12 + 4 * n, 12 + 6 * n));
  const start = 12 + 6 * n + ((4 - ((12 + 6 * n) % 4)) % 4);
  const indices = new Uint32Array(buf.slice(start, start + 12 * t));
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = cols[i] * step;
    positions[i * 3 + 1] = h[i] / 4;
    positions[i * 3 + 2] = rows[i] * step;
  }
  return { positions, indices, cell: TIN_CELL, cols: 0, rows: 0, cellStart: new Uint32Array(1), cellTris: new Uint32Array(0) };
}

/** Builds the cell lists; call again after vertices move sideways (heights may change freely). */
export function indexTin(tin: Tin, sizeX: number, sizeZ: number) {
  const { positions: p, indices, cell } = tin;
  const cols = Math.ceil(sizeX / cell) + 1;
  const rows = Math.ceil(sizeZ / cell) + 1;
  const t = indices.length / 3;
  const range = (k: number) => {
    const a = indices[k * 3] * 3, b = indices[k * 3 + 1] * 3, c = indices[k * 3 + 2] * 3;
    return [
      Math.floor(Math.min(p[a], p[b], p[c]) / cell),
      Math.floor(Math.max(p[a], p[b], p[c]) / cell),
      Math.floor(Math.min(p[a + 2], p[b + 2], p[c + 2]) / cell),
      Math.floor(Math.max(p[a + 2], p[b + 2], p[c + 2]) / cell),
    ];
  };
  const counts = new Uint32Array(cols * rows + 1);
  for (let k = 0; k < t; k++) {
    const [i0, i1, j0, j1] = range(k);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) counts[j * cols + i + 1]++;
  }
  for (let c = 1; c < counts.length; c++) counts[c] += counts[c - 1];
  const fill = counts.slice();
  const tris = new Uint32Array(counts[counts.length - 1]);
  for (let k = 0; k < t; k++) {
    const [i0, i1, j0, j1] = range(k);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) tris[fill[j * cols + i]++] = k;
  }
  Object.assign(tin, { cols, rows, cellStart: counts, cellTris: tris });
}

/** Height (m) exactly on the mesh at local x/z, or null if no triangle covers the point. */
export function tinHeight(tin: Tin, x: number, z: number): number | null {
  const i = Math.floor(x / tin.cell);
  const j = Math.floor(z / tin.cell);
  if (i < 0 || j < 0 || i >= tin.cols || j >= tin.rows) return null;
  const c = j * tin.cols + i;
  const { positions: p, indices } = tin;
  for (let s = tin.cellStart[c]; s < tin.cellStart[c + 1]; s++) {
    const k = tin.cellTris[s] * 3;
    const a = indices[k] * 3, b = indices[k + 1] * 3, d = indices[k + 2] * 3;
    const ux = p[b] - p[a], uz = p[b + 2] - p[a + 2];
    const vx = p[d] - p[a], vz = p[d + 2] - p[a + 2];
    const wx = x - p[a], wz = z - p[a + 2];
    const det = ux * vz - uz * vx;
    if (det === 0) continue;
    const s1 = (wx * vz - wz * vx) / det;
    const s2 = (ux * wz - uz * wx) / det;
    if (s1 >= -1e-6 && s2 >= -1e-6 && s1 + s2 <= 1 + 1e-6) {
      return p[a + 1] + (p[b + 1] - p[a + 1]) * s1 + (p[d + 1] - p[a + 1]) * s2;
    }
  }
  return null;
}

/** URL of one of an area's data files. */
export function detailUrl(baseUrl: string, name: string, file: string): string {
  return `${baseUrl}data/detail/${name}/${file}`;
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
  const url = (file: string) => detailUrl(baseUrl, name, file);
  const [meta, heightPx, coverPx, buildings, trees] = await Promise.all([
    fetch(url('meta.json')).then((r) => r.json() as Promise<AreaMeta>),
    pixels(url('height.png')),
    pixels(url('cover.png')),
    fetch(url('buildings.bin')).then((r) => r.arrayBuffer()),
    fetch(url('trees.bin')).then((r) => r.arrayBuffer()),
  ]);
  const imagery = meta.imagery
    ? await fetch(url('imagery.jpg'))
        .then((r) => r.blob())
        .then((b) => createImageBitmap(b, { imageOrientation: 'none' }))
    : null;
  const tin = meta.mesh
    ? parseTin(await fetch(url('ground.bin')).then((r) => r.arrayBuffer()), meta.mesh.step)
    : null;
  const heights = new Float32Array(meta.width * meta.height);
  for (let i = 0; i < heights.length; i++) {
    const p = i * 4;
    heights[i] = heightPx[p] * 256 + heightPx[p + 1] + heightPx[p + 2] / 256 - 32768;
  }
  if (tin) indexTin(tin, meta.xMax - meta.xMin, meta.yMax - meta.yMin);
  const cover = new Uint8Array(meta.coverWidth * meta.coverHeight);
  for (let i = 0; i < cover.length; i++) cover[i] = coverPx[i * 4];
  return {
    name,
    meta,
    heights,
    cover,
    tin,
    buildings,
    trees: new Float32Array(trees),
    imagery,
    sizeX: meta.xMax - meta.xMin,
    sizeZ: meta.yMax - meta.yMin,
  };
}

/** Terrain height (metres) at local scene x/z metres: on the mesh if there is one, else bilinear. */
export function heightAt(area: Area, x: number, z: number): number {
  const { meta, heights } = area;
  if (area.tin) {
    const h = tinHeight(area.tin, Math.min(Math.max(x, 0), area.sizeX), Math.min(Math.max(z, 0), area.sizeZ));
    if (h !== null) return h;
  }
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

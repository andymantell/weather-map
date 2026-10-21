export interface HeightmapMeta {
  /** proj4 definition of the grid's projection (UKV LAEA). */
  proj: string;
  /** Grid extent in projected metres; samples sit on these edges. */
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  spacing: number;
  width: number;
  height: number;
  minHeight: number;
  maxHeight: number;
}

export interface Heightmap {
  meta: HeightmapMeta;
  /** Heights in metres, row-major from the north-west corner. */
  heights: Float32Array;
}

/** Loads the Terrarium-encoded heightmap built by scripts/build_heightmap.py. */
export async function loadHeightmap(baseUrl: string): Promise<Heightmap> {
  const [meta, blob] = await Promise.all([
    fetch(`${baseUrl}data/uk-heightmap.json`).then((r) => r.json() as Promise<HeightmapMeta>),
    fetch(`${baseUrl}data/uk-heightmap.png`).then((r) => r.blob()),
  ]);

  // Skip colour management so the encoded RGB values come through untouched.
  const bitmap = await createImageBitmap(blob, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

  const heights = new Float32Array(bitmap.width * bitmap.height);
  for (let i = 0; i < heights.length; i++) {
    const p = i * 4;
    heights[i] = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768;
  }
  return { meta, heights };
}

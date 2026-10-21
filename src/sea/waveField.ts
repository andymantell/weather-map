import * as THREE from 'three';

/** Sidecar written by pipeline/wave_to_grid.py (only the fields used here). */
export interface WaveFieldMeta {
  forecast_reference_time: string;
  valid_time: string;
  grid: { width: number; height: number; x_west_edge: number; y_north_edge: number; spacing: number };
  textures: Record<'windsea' | 'swell' | 'period', { file: string }>;
  scale: { hs: number; tp: number; wind: number };
  attribution: string;
}

export interface WaveField {
  meta: WaveFieldMeta;
  windSea: THREE.Texture;
  swell: THREE.Texture;
  period: THREE.Texture;
}

async function loadDataTexture(url: string): Promise<THREE.Texture> {
  const blob = await fetch(url).then((r) => r.blob());
  // Raw bytes: no colour management or premultiplication. Row 0 (north) lands at v = 0.
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const texture = new THREE.Texture(bitmap);
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** Loads the Met Office UK wave model snapshot built by pipeline/wave_to_grid.py. */
export async function loadWaveField(baseUrl: string): Promise<WaveField> {
  const dir = `${baseUrl}data/waves/`;
  const meta = (await fetch(`${dir}nws-waves.json`).then((r) => r.json())) as WaveFieldMeta;
  const [windSea, swell, period] = await Promise.all(
    (['windsea', 'swell', 'period'] as const).map((k) => loadDataTexture(dir + meta.textures[k].file)),
  );
  return { meta, windSea, swell, period };
}

import * as THREE from 'three';

/** Sidecar written by pipeline/ukv_to_grid.py (only the fields used here). */
export interface UkvFieldMeta {
  units: string;
  valid_time: string;
  forecast_reference_time: string;
  grid: { width: number; height: number; x_west: number; y_north: number; dx: number; dy: number };
  encoding: { offset: number; scale: number };
  attribution: string;
}

/** Lower edge of each band in mm/h and its colour, from the Met Office website's rainfall key. */
const BANDS: [number, string][] = [
  [0.1, '#0000fe'], // <0.5 (cells below 0.1 mm/h are drawn as dry)
  [0.5, '#3265fe'],
  [1, '#0cbcfe'],
  [2, '#00a300'],
  [4, '#fecb00'],
  [8, '#fe9800'],
  [16, '#fe0000'],
  [32, '#b30000'],
];

const MM_PER_HOUR_PER_M_PER_S = 1000 * 3600;

const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec2 vLaea;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    // World units are km with Z = -northing; convert back to LAEA metres.
    vLaea = vec2(world.x, -world.z) * 1000.0;
    gl_Position = projectionMatrix * viewMatrix * world;
    #include <logdepthbuf_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D field;
  uniform vec2 gridOrigin; // outer north-west corner of the grid, LAEA metres
  uniform vec2 gridSize;   // grid extent, metres
  uniform float offset;
  uniform float scale;
  uniform float opacity;
  uniform float thresholds[${BANDS.length}];
  uniform vec3 colours[${BANDS.length}];
  varying vec2 vLaea;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 uv = vec2((vLaea.x - gridOrigin.x) / gridSize.x, 1.0 - (gridOrigin.y - vLaea.y) / gridSize.y);
    vec4 t = texture2D(field, uv);
    float code = floor(t.r * 255.0 + 0.5) * 256.0 + floor(t.g * 255.0 + 0.5);
    if (code == 0.0) discard;
    float rate = (offset + scale * code) * ${MM_PER_HOUR_PER_M_PER_S.toFixed(1)};
    if (rate < thresholds[0]) discard;
    vec3 colour = colours[0];
    for (int i = 1; i < ${BANDS.length}; i++) {
      if (rate >= thresholds[i]) colour = colours[i];
    }
    gl_FragColor = vec4(colour, opacity);
  }
`;

export async function loadRainField(baseUrl: string): Promise<{ meta: UkvFieldMeta; texture: THREE.Texture }> {
  const [meta, texture] = await Promise.all([
    fetch(`${baseUrl}data/ukv-precipitation-rate.json`).then((r) => r.json() as Promise<UkvFieldMeta>),
    new THREE.TextureLoader().loadAsync(`${baseUrl}data/ukv-precipitation-rate.png`),
  ]);
  if (meta.units !== 'm s-1') throw new Error(`Unexpected precipitation units: ${meta.units}`);
  // Raw 16-bit codes: no colour management, no blending between cells.
  texture.colorSpace = THREE.NoColorSpace;
  texture.premultiplyAlpha = false;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return { meta, texture };
}

/**
 * A flat, half-transparent plane showing UKV precipitation rate in the Met Office's
 * colour bands. It covers `extent` (LAEA metres) and samples the UKV grid by world
 * position, so any misregistration with the terrain shows up directly.
 */
export function createRainPlane(
  { meta, texture }: { meta: UkvFieldMeta; texture: THREE.Texture },
  extent: { xMin: number; xMax: number; yMin: number; yMax: number },
): THREE.Mesh {
  const { grid, encoding } = meta;
  // Grid coordinates are cell centres, so the outer edge is half a cell further out.
  const west = grid.x_west - grid.dx / 2;
  const north = grid.y_north - grid.dy / 2;

  const geometry = new THREE.PlaneGeometry((extent.xMax - extent.xMin) / 1000, (extent.yMax - extent.yMin) / 1000);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate((extent.xMin + extent.xMax) / 2000, 0, -(extent.yMin + extent.yMax) / 2000);

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      field: { value: texture },
      gridOrigin: { value: new THREE.Vector2(west, north) },
      gridSize: { value: new THREE.Vector2(grid.width * grid.dx, grid.height * -grid.dy) },
      offset: { value: encoding.offset },
      scale: { value: encoding.scale },
      opacity: { value: 0.5 },
      thresholds: { value: BANDS.map(([mm]) => mm) },
      // Raw sRGB values: the shader skips colour-space conversion and tone mapping.
      colours: { value: BANDS.map(([, hex]) => new THREE.Vector3(...new THREE.Color().setStyle(hex, THREE.NoColorSpace).toArray())) },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geometry, material);
}

import * as THREE from 'three';
import { FIELDS, NOISE } from './detail/ground';
import type { Heightmap } from './heightmap';

/**
 * Land is lifted and the seabed lowered (metres) so low-lying land such as the
 * Fens never z-fights with the sea surface, and coastlines stay crisp.
 */
const LAND_LIFT = 5;
const SEABED_DROP = 20;

/** Every Nth heightmap sample becomes a vertex; 2 matches the 2 km UKV grid (~370k vertices). */
const STRIDE = 2;

// Hypsometric tint: [height in metres, colour].
const LAND_COLOURS: [number, THREE.Color][] = [
  [0, new THREE.Color('#5d7f3c')],
  [150, new THREE.Color('#6f8b45')],
  [400, new THREE.Color('#8a8455')],
  [700, new THREE.Color('#7d6f58')],
  [1000, new THREE.Color('#8b8680')],
  [1300, new THREE.Color('#d8d8d4')],
];
const SEABED_SHALLOW = new THREE.Color('#9a9474');
const SEABED_DEEP = new THREE.Color('#2b4a5c');
const ROCK = new THREE.Color('#6e6a64');

function landColour(h: number, out: THREE.Color): THREE.Color {
  if (h <= LAND_COLOURS[0][0]) return out.copy(LAND_COLOURS[0][1]);
  for (let i = 1; i < LAND_COLOURS.length; i++) {
    const [h1, c1] = LAND_COLOURS[i];
    if (h <= h1) {
      const [h0, c0] = LAND_COLOURS[i - 1];
      return out.copy(c0).lerp(c1, (h - h0) / (h1 - h0));
    }
  }
  return out.copy(LAND_COLOURS[LAND_COLOURS.length - 1][1]);
}

/**
 * Builds the terrain mesh in kilometres with heights at true scale; set
 * mesh.scale.y to exaggerate relief.
 */
export function createTerrain(heightmap: Heightmap): THREE.Mesh {
  const { meta, heights } = heightmap;
  const cols = Math.floor((meta.width - 1) / STRIDE) + 1;
  const rows = Math.floor((meta.height - 1) / STRIDE) + 1;

  const positions = new Float32Array(cols * rows * 3);
  const colours = new Float32Array(cols * rows * 3);
  const colour = new THREE.Color();
  const sample = (c: number, r: number) =>
    heights[Math.min(r, meta.height - 1) * meta.width + Math.min(c, meta.width - 1)];

  for (let r = 0; r < rows; r++) {
    const sr = r * STRIDE;
    const z = -(meta.yMax - sr * meta.spacing) / 1000;
    for (let c = 0; c < cols; c++) {
      const sc = c * STRIDE;
      const x = (meta.xMin + sc * meta.spacing) / 1000;
      const h = sample(sc, sr);
      const i = (r * cols + c) * 3;
      positions[i] = x;
      positions[i + 1] = (h > 0 ? h + LAND_LIFT : h - SEABED_DROP) / 1000;
      positions[i + 2] = z;

      if (h > 0) {
        landColour(h, colour);
        // Blend towards bare rock on steep slopes.
        const dx = (sample(sc + 1, sr) - sample(Math.max(sc - 1, 0), sr)) / (2 * meta.spacing);
        const dz = (sample(sc, sr + 1) - sample(sc, Math.max(sr - 1, 0))) / (2 * meta.spacing);
        const slope = Math.sqrt(dx * dx + dz * dz);
        colour.lerp(ROCK, THREE.MathUtils.smoothstep(slope, 0.15, 0.45));
      } else {
        colour.copy(SEABED_SHALLOW).lerp(SEABED_DEEP, THREE.MathUtils.clamp(-h / 150, 0, 1));
      }
      colours[i] = colour.r;
      colours[i + 1] = colour.g;
      colours[i + 2] = colour.b;
    }
  }

  const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      indices[k++] = a;
      indices[k++] = d;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = d;
      indices[k++] = e;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, terrainUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTerrainWorld;\nvarying float vTrueHeight;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvTerrainWorld = (modelMatrix * vec4(position, 1.0)).xyz;\nvTrueHeight = position.y * 1000.0;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE}\n${FIELDS}\n${GROUND_DETAIL}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\ngroundDetail(diffuseColor.rgb);');
  };
  return new THREE.Mesh(geometry, material);
}

/** Up to this many detailed tiles (src/detail/) can cut holes in the coarse terrain. */
export const MAX_DETAIL_RECTS = 16;

/** Shared by every terrain material; set via setDetailRects. */
const terrainUniforms = {
  uDetailRects: { value: Array.from({ length: MAX_DETAIL_RECTS }, () => new THREE.Vector4(1e9, 1e9, -1e9, -1e9)) },
};

/**
 * Hides the coarse terrain inside the given world rectangles (km: xMin, zMin, xMax, zMax),
 * where detailed tiles draw their own ground.
 */
export function setDetailRects(rects: THREE.Vector4[]) {
  // Inset so the coarse ground runs a little under each tile's edge (where the tile has blended
  // to the same heights) and no pixel cracks open between the two.
  const inset = 0.04;
  terrainUniforms.uDetailRects.value.forEach((r, i) =>
    rects[i]
      ? r.set(rects[i].x + inset, rects[i].y + inset, rects[i].z - inset, rects[i].w - inset)
      : r.set(1e9, 1e9, -1e9, -1e9),
  );
}

/**
 * Close-up ground detail for the whole UK, faded in as the camera gets near enough
 * to resolve it: a field patchwork with hedgerows in the lowlands and mottled moorland
 * on high ground. From further away the hypsometric vertex colours show unchanged.
 */
const GROUND_DETAIL = /* glsl */ `
uniform vec4 uDetailRects[${MAX_DETAIL_RECTS}];
varying vec3 vTerrainWorld;
varying float vTrueHeight;

void groundDetail(inout vec3 colour) {
  for (int i = 0; i < ${MAX_DETAIL_RECTS}; i++) {
    vec4 r = uDetailRects[i];
    if (vTerrainWorld.x > r.x && vTerrainWorld.x < r.z && vTerrainWorld.z > r.y && vTerrainWorld.z < r.w) discard;
  }
  if (vTrueHeight <= ${LAND_LIFT}.0) return;
  vec2 p = vTerrainWorld.xz * 1000.0;
  // Metres per pixel: the detail fades out before it would shimmer.
  float footprint = length(fwidth(p));
  // Hedges and furrows fade first (in fieldColour); whole fields go when they are a few pixels wide.
  // The patchwork's average colour carries on to the far distance; only the map view keeps
  // the plain hypsometric colours.
  float fade = 1.0 - smoothstep(300.0, 1200.0, footprint);
  // Beyond that, a broad mottle of farmland and moor keeps the land from looking flat.
  float mottle = fbm(vTerrainWorld.xz / 1.8) * 0.6 + fbm(vTerrainWorld.xz / 7.0) * 0.4;
  colour *= 1.0 + (0.36 * mottle - 0.18) * (1.0 - smoothstep(300.0, 1200.0, footprint));
  if (fade <= 0.0) return;
  float rough;
  vec3 lowland = patchwork(p, 160.0, rough);
  vec3 a = vec3(0.36, 0.30, 0.20), b = vec3(0.32, 0.25, 0.27), g = vec3(0.40, 0.40, 0.20);
  float n = fbm(p / 9.0);
  vec3 moor = mix(mix(a, b, smoothstep(0.35, 0.65, fbm(p / 40.0))), g, smoothstep(0.55, 0.8, n)) * (0.85 + 0.3 * vnoise(p / 1.7));
  float upland = smoothstep(230.0, 340.0, vTrueHeight + 120.0 * (fbm(p / 900.0) - 0.5));
  vec3 detail = pow(mix(lowland, moor, upland), vec3(2.2));
  // Keep the rock and snow the vertex colours already paint on steep or high ground.
  float green = smoothstep(0.02, 0.08, colour.g - colour.b);
  colour = mix(colour, detail, fade * green);
}
`;

/** A flat sea surface at sea level covering the terrain extent. */
export function createSea(heightmap: Heightmap): THREE.Mesh {
  const { xMin, xMax, yMin, yMax } = heightmap.meta;
  const geometry = new THREE.PlaneGeometry((xMax - xMin) / 1000, (yMax - yMin) / 1000);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate((xMin + xMax) / 2000, 0, -(yMin + yMax) / 2000);
  const material = new THREE.MeshStandardMaterial({
    color: '#1f4e6b',
    roughness: 0.25,
    metalness: 0.1,
    transparent: true,
    opacity: 0.88,
  });
  return new THREE.Mesh(geometry, material);
}

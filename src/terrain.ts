import * as THREE from 'three';
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
  return new THREE.Mesh(geometry, material);
}

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

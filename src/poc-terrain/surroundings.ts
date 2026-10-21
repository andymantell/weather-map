import * as THREE from 'three';
import type { Heightmap } from '../heightmap';
import type { Area } from './area';

/**
 * The app's 1 km UK heightmap around the PoC area, so the detailed tile sits in a
 * landscape instead of floating at the edge of the world. Vertices under the tile
 * are sunk out of the way; the rim overlap is hidden by sitting a few metres lower.
 */

const RADIUS = 70000;
const DROP = 6;

export function createSurroundings(area: Area, uk: Heightmap, material: THREE.Material): THREE.Mesh {
  const m = uk.meta;
  const s = m.spacing;
  // Window of UK samples in LAEA metres.
  const i0 = Math.max(0, Math.floor((area.meta.xMin - RADIUS - m.xMin) / s));
  const i1 = Math.min(m.width - 1, Math.ceil((area.meta.xMax + RADIUS - m.xMin) / s));
  const j0 = Math.max(0, Math.floor((m.yMax - (area.meta.yMax + RADIUS)) / s));
  const j1 = Math.min(m.height - 1, Math.ceil((m.yMax - (area.meta.yMin - RADIUS)) / s));
  const w = i1 - i0 + 1;
  const h = j1 - j0 + 1;
  const positions = new Float32Array(w * h * 3);
  const margin = 2 * s;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const X = m.xMin + (i0 + i) * s;
      const Y = m.yMax - (j0 + j) * s;
      const x = X - area.meta.xMin;
      const z = area.meta.yMax - Y;
      const y = uk.heights[(j0 + j) * m.width + i0 + i];
      const inside = x > margin && x < area.sizeX - margin && z > margin && z < area.sizeZ - margin;
      const k = (j * w + i) * 3;
      positions[k] = x;
      positions[k + 1] = inside ? -80 : (y > 0 ? y : y - 15) - DROP;
      positions[k + 2] = z;
    }
  }
  const indices = new Uint32Array((w - 1) * (h - 1) * 6);
  let n = 0;
  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const a = j * w + i;
      indices[n++] = a;
      indices[n++] = a + w;
      indices[n++] = a + 1;
      indices[n++] = a + 1;
      indices[n++] = a + w;
      indices[n++] = a + w + 1;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
}

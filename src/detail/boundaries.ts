import * as THREE from 'three';
import { heightAt, type Area } from './area';
import { scaledMaterial, type ScaledUniforms } from './buildings';
import { NOISE } from './ground';

/**
 * Field boundaries from scripts/detail/build_boundaries.py: Devon hedge banks and Cheviot
 * dry-stone walls as low, terrain-following strips. Hedges get a lumpy, uneven top and leafy
 * mottling; walls are a narrow grey course of stones.
 */

const KINDS = [
  // Half width at the base, at the top, height (m), colour (sRGB).
  { base: 1.1, top: 0.7, height: 2.0, colour: new THREE.Color().setRGB(0.3, 0.42, 0.15, THREE.SRGBColorSpace) },
  { base: 0.35, top: 0.25, height: 1.2, colour: new THREE.Color().setRGB(0.42, 0.41, 0.38, THREE.SRGBColorSpace) },
];

function hash(x: number, z: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

export function parseBoundaries(buffer: ArrayBuffer): { kind: number; points: Float32Array }[] {
  const view = new DataView(buffer);
  const out: { kind: number; points: Float32Array }[] = [];
  let o = 0;
  while (o < buffer.byteLength) {
    const n = view.getUint16(o, true);
    const kind = view.getUint8(o + 2);
    o += 4;
    out.push({ kind, points: new Float32Array(buffer.slice(o, o + n * 8)) });
    o += n * 8;
  }
  return out;
}

const LEAVES = /* glsl */ `
varying vec3 vHedgePos;
varying float vKind;
${NOISE}
void hedgeSurface(inout vec3 colour) {
  vec3 p = vHedgePos;
  float near = 1.0 - smoothstep(0.3, 1.5, length(fwidth(p)));
  if (vKind < 0.5) {
    // Leaves: clumps and gaps, darker towards the base and inside.
    float leaf = vnoise(p.xz * 2.3 + p.y * 1.7) * 0.6 + vnoise(p.xz * 7.0 - p.y * 5.0) * 0.4;
    colour *= mix(1.0, 0.7 + 0.6 * leaf, near);
    colour *= 0.85 + 0.25 * smoothstep(0.0, 1.8, p.y);
    colour *= 0.85 + 0.3 * fbm(p.xz / 25.0);
  } else {
    // Stones: irregular courses.
    vec2 c = vec2(dot(p.xz, vec2(0.7071)) / 0.45, p.y / 0.22);
    float row = floor(c.y);
    vec2 f = fract(vec2(c.x + hash12(vec2(row, 1.0)), c.y));
    float joint = min(min(f.x, 1.0 - f.x) * 2.0, min(f.y, 1.0 - f.y) * 4.0);
    float stone = hash12(vec2(floor(c.x + hash12(vec2(row, 1.0))), row));
    colour *= mix(1.0, (0.75 + 0.45 * stone) * mix(0.55, 1.0, smoothstep(0.0, 0.25, joint)), near);
  }
}
`;

/** One mesh of every hedge and wall in the area, following the terrain per vertex. */
export function createBoundaries(area: Area, buffer: ArrayBuffer, uniforms: ScaledUniforms): THREE.Mesh {
  const lines = parseBoundaries(buffer);
  const pos: number[] = [];
  const col: number[] = [];
  const base: number[] = [];
  const kinds: number[] = [];
  const index: number[] = [];
  const colour = new THREE.Color();
  for (const { kind, points } of lines) {
    const k = KINDS[kind] ?? KINDS[0];
    const n = points.length / 2;
    const first = pos.length / 3;
    for (let i = 0; i < n; i++) {
      const x = points[i * 2];
      const z = points[i * 2 + 1];
      // Direction along the line, averaged at corners.
      const a = Math.max(i - 1, 0);
      const b = Math.min(i + 1, n - 1);
      let dx = points[b * 2] - points[a * 2];
      let dz = points[b * 2 + 1] - points[a * 2 + 1];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      const r = hash(x, z);
      // Hedges vary in height and bulge; walls barely.
      const h = k.height * (kind === 0 ? 0.75 + 0.5 * r : 0.9 + 0.2 * r);
      const wb = k.base * (kind === 0 ? 0.8 + 0.5 * hash(z, x) : 1);
      const wt = k.top * (kind === 0 ? 0.7 + 0.7 * hash(x + 1, z) : 1);
      const ground = heightAt(area, x, z) - 0.4;
      colour.copy(k.colour).multiplyScalar(0.85 + 0.3 * hash(x * 0.03, z * 0.03));
      // Left base, left top, ridge, right top, right base.
      const ring = [
        [-wb, 0],
        [-wt, h * 0.92],
        [0, h],
        [wt, h * 0.92],
        [wb, 0],
      ];
      for (const [side, y] of ring) {
        pos.push(x - dz * side, y + 0.4, z + dx * side);
        col.push(colour.r, colour.g, colour.b);
        base.push(ground);
        kinds.push(kind);
      }
      if (i > 0) {
        const p = first + (i - 1) * 5;
        const q = first + i * 5;
        for (let s = 0; s < 4; s++) index.push(p + s, q + s, p + s + 1, p + s + 1, q + s, q + s + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geometry.setAttribute('aBase', new THREE.Float32BufferAttribute(base, 1));
  geometry.setAttribute('aKind', new THREE.Float32BufferAttribute(kinds, 1));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aBase;\nattribute float aKind;\nuniform float terrainScale;\nuniform float buildingScale;\nvarying vec3 vHedgePos;\nvarying float vKind;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvHedgePos = position;\nvKind = aKind;\ntransformed.y = aBase * terrainScale + transformed.y * buildingScale;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${LEAVES}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\nhedgeSurface(diffuseColor.rgb);');
  };
  const mesh = new THREE.Mesh(geometry, material);
  mesh.customDepthMaterial = scaledMaterial(
    new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }),
    uniforms,
  ) as THREE.MeshDepthMaterial;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

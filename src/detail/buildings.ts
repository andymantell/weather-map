import * as THREE from 'three';
import { type Area, heightAt } from './area';

/**
 * Buildings for a PoC area, in two representations:
 *
 * - footprints: every Overture footprint extruded to its height, with gable roofs
 *   on simple rectangular houses.
 * - blocks: footprints aggregated onto a coarse grid, one box per cell sized by
 *   built-up fraction and mean height. This is the form that could be baked for
 *   the whole UK and read from far away.
 *
 * - masses: footprints merged into street blocks by scripts/poc_terrain/build_masses.py,
 *   so a town keeps its real shape and street pattern with far fewer polygons.
 *
 * All take a vertical scale, so a town can be drawn taller than life.
 */

export interface Building {
  /** Footprint in local scene metres (x east, z south), counter-clockwise on the map. */
  ring: Float32Array;
  roof: number;
  height: number;
  base: number;
}

export function parseBuildings(area: Area): Building[] {
  const view = new DataView(area.buildings);
  const out: Building[] = [];
  let o = 0;
  while (o < view.byteLength) {
    const n = view.getUint16(o, true);
    const roof = view.getUint8(o + 2);
    const height = view.getFloat32(o + 4, true);
    const base = view.getFloat32(o + 8, true);
    o += 12;
    const ring = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      ring[i * 2] = view.getFloat32(o, true);
      ring[i * 2 + 1] = -view.getFloat32(o + 4, true);
      o += 8;
    }
    out.push({ ring, roof, height, base });
  }
  return out;
}

const hash = (x: number, z: number) => {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
};

// Devon/Cornwall-ish palette: rendered walls, some stone and brick; slate roofs.
const WALLS = ['#c9c2b3', '#bdb3a0', '#d4cfc4', '#ada38e', '#9c7660', '#8a6754', '#b1a99b', '#c4b9a2'].map(
  (c) => new THREE.Color(c),
);
const ROOFS = ['#4a4d52', '#55585c', '#3e4146', '#6a5a50', '#8a5a44', '#5c5f63'].map((c) => new THREE.Color(c));
const FLAT_ROOF = new THREE.Color('#6d6e6f');
const BIG_WALL = new THREE.Color('#a9abad');

/** Accumulates triangles with flat normals, fixing winding to face along the normal. */
class Builder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  base: number[] = [];
  private v = new THREE.Vector3();
  private w = new THREE.Vector3();
  private c = new THREE.Vector3();

  tri(a: number[], b: number[], c: number[], n: THREE.Vector3, colour: THREE.Color, base: number) {
    this.v.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    this.w.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    this.c.crossVectors(this.v, this.w);
    if (this.c.dot(n) < 0) [b, c] = [c, b];
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(n.x, n.y, n.z);
      this.col.push(colour.r, colour.g, colour.b);
      // A fourth coordinate overrides the base height for that vertex.
      this.base.push(p.length > 3 ? p[3] : base);
    }
  }

  quad(a: number[], b: number[], c: number[], d: number[], n: THREE.Vector3, colour: THREE.Color, base: number) {
    this.tri(a, b, c, n, colour, base);
    this.tri(a, c, d, n, colour, base);
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aBase', new THREE.Float32BufferAttribute(this.base, 1));
    return g;
  }
}

/** Walls start this far below the lowest footprint corner so slopes never show a gap. */
const SINK = 3;

function addFootprint(b: Builder, bld: Building) {
  const { ring, height, base } = bld;
  const n = ring.length / 2;
  const cx = ring[0];
  const cz = ring[1];
  const r = hash(cx, cz);
  const wall = height > 12 || n > 8 ? BIG_WALL.clone().lerp(WALLS[Math.floor(r * WALLS.length)], 0.4) : WALLS[Math.floor(r * WALLS.length)];
  const normal = new THREE.Vector3();

  if (bld.roof === 1 && n === 4) {
    // Gable roof along the longer axis of the oriented rectangle.
    const p = [0, 1, 2, 3].map((i) => [ring[i * 2], ring[i * 2 + 1]]);
    const l01 = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]);
    const l12 = Math.hypot(p[2][0] - p[1][0], p[2][1] - p[1][1]);
    const q = l01 >= l12 ? p : [p[1], p[2], p[3], p[0]];
    const short = Math.min(l01, l12);
    const eave = height;
    const ridge = height + Math.min(0.45 * short, 4.5);
    // Ridge runs between midpoints of the two short edges (q1-q2 and q3-q0).
    const m1 = [(q[1][0] + q[2][0]) / 2, (q[1][1] + q[2][1]) / 2];
    const m2 = [(q[3][0] + q[0][0]) / 2, (q[3][1] + q[0][1]) / 2];
    const roofCol = ROOFS[Math.floor(hash(cz, cx) * ROOFS.length)];
    const P = (xz: number[], y: number) => [xz[0], y, xz[1]];
    for (let i = 0; i < 4; i++) {
      const a = q[i];
      const c = q[(i + 1) % 4];
      normal.set(c[1] - a[1], 0, -(c[0] - a[0])).normalize();
      const mx = (a[0] + c[0]) / 2;
      const mz = (a[1] + c[1]) / 2;
      // Point the normal away from the centre.
      const ox = (q[0][0] + q[2][0]) / 2;
      const oz = (q[0][1] + q[2][1]) / 2;
      if (normal.x * (mx - ox) + normal.z * (mz - oz) < 0) normal.negate();
      b.quad(P(a, -SINK), P(c, -SINK), P(c, eave), P(a, eave), normal, wall, base);
      if (i === 1 || i === 3) b.tri(P(a, eave), P(c, eave), P(i === 1 ? m1 : m2, ridge), normal, wall, base);
    }
    // Two roof slopes over the long edges q0-q1 and q2-q3.
    for (const [a, c] of [
      [q[0], q[1]],
      [q[2], q[3]],
    ]) {
      const A = P(a, eave);
      const C = P(c, eave);
      const R1 = P(a === q[0] ? m2 : m1, ridge);
      const R2 = P(a === q[0] ? m1 : m2, ridge);
      const e1 = new THREE.Vector3(C[0] - A[0], C[1] - A[1], C[2] - A[2]);
      const e2 = new THREE.Vector3(R1[0] - A[0], R1[1] - A[1], R1[2] - A[2]);
      normal.crossVectors(e1, e2).normalize();
      if (normal.y < 0) normal.negate();
      b.quad(A, C, R2, R1, normal, roofCol, base);
    }
    return;
  }

  // Flat-roofed extrusion.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[i * 2];
    const az = ring[i * 2 + 1];
    const bx = ring[j * 2];
    const bz = ring[j * 2 + 1];
    // Map-CCW rings become clockwise once z = -northing, so the outward normal is (dz, -dx) negated.
    normal.set(-(bz - az), 0, bx - ax).normalize();
    b.quad([ax, -SINK, az], [bx, -SINK, bz], [bx, height, bz], [ax, height, az], normal, wall, base);
  }
  const contour = [];
  for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(ring[i * 2], ring[i * 2 + 1]));
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  normal.set(0, 1, 0);
  const roofCol = height > 10 ? FLAT_ROOF : ROOFS[Math.floor(hash(cz, cx) * ROOFS.length)].clone().lerp(FLAT_ROOF, 0.5);
  for (const [a, c, d] of tris) {
    b.tri(
      [contour[a].x, height, contour[a].y],
      [contour[c].x, height, contour[c].y],
      [contour[d].x, height, contour[d].y],
      normal,
      roofCol,
      base,
    );
  }
}

export interface ScaledUniforms {
  terrainScale: { value: number };
  buildingScale: { value: number };
}

/** Adds the aBase attribute and vertical scales to a material and its shadow depth material. */
export function scaledMaterial(material: THREE.Material, uniforms: ScaledUniforms): THREE.Material {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aBase;\nuniform float terrainScale;\nuniform float buildingScale;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\ntransformed.y = aBase * terrainScale + transformed.y * buildingScale;',
      );
  };
  return material;
}

/**
 * Facade and roof detail, in sRGB-free multipliers on the vertex colour: rows of windows on walls
 * (by storey, from the wall's own coordinates, so no UVs are needed), a darker plinth, and slate
 * courses on pitched roofs. It all fades out with distance before it would shimmer.
 */
const FACADE = /* glsl */ `
varying vec3 vFacadePos;
varying vec3 vFacadeNormal;

float facadeHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void facade(inout vec3 colour, inout float rough) {
  vec3 n = normalize(vFacadeNormal);
  vec3 p = vFacadePos;
  if (abs(n.y) < 0.5) {
    // Wall: u runs along the wall, v up from the ground.
    float u = dot(p.xz, normalize(vec2(-n.z, n.x)));
    float v = p.y;
    vec2 cell = vec2(u / 3.1, (v - 0.9) / 3.0);
    vec2 id = floor(cell);
    vec2 f = fract(cell);
    float footprint = max(fwidth(u), fwidth(v));
    float fade = 1.0 - smoothstep(0.6, 1.6, footprint);
    float h = facadeHash(id + floor(p.xz / 50.0));
    float win = step(0.22, f.x) * step(f.x, 0.78) * step(0.28, f.y) * step(f.y, 0.82) * step(0.0, v - 0.9);
    // Glass: dark sky-tinted, a few lit or curtained panes.
    vec3 glass = mix(vec3(0.10, 0.13, 0.17), vec3(0.32, 0.36, 0.42), h * h);
    colour = mix(colour, glass, win * fade);
    rough = mix(rough, 0.15, win * fade);
    // Plinth and a faint string course at each floor.
    colour *= mix(1.0, 0.72, (1.0 - step(0.8, v)) * fade);
    colour *= 1.0 - 0.06 * fade * (1.0 - smoothstep(0.0, 0.06, abs(f.y - 0.04)));
    // Mass shading so blank walls are not flat: lighter higher up.
    colour *= 0.88 + 0.12 * clamp(v / 12.0, 0.0, 1.0);
  } else if (n.y < 0.97) {
    // Pitched roof: slate courses across the slope.
    float footprint = fwidth(p.y);
    float fade = 1.0 - smoothstep(0.05, 0.25, footprint);
    float course = fract(p.y / 0.12);
    colour *= 1.0 - 0.18 * fade * (1.0 - smoothstep(0.0, 0.25, course));
    colour *= 0.92 + 0.16 * facadeHash(floor(p.xz / 0.4) + floor(p.y / 0.12));
  } else {
    // Flat roof: weathered felt and gravel.
    colour *= 0.85 + 0.2 * facadeHash(floor(p.xz / 2.0));
  }
}
`;

/** Vertical scaling plus facade detail; shared by footprints and street blocks. */
function buildingMaterial(uniforms: ScaledUniforms): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aBase;\nuniform float terrainScale;\nuniform float buildingScale;\nvarying vec3 vFacadePos;\nvarying vec3 vFacadeNormal;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvFacadePos = position;\nvFacadeNormal = normal;\ntransformed.y = aBase * terrainScale + transformed.y * buildingScale;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FACADE}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nfacade(diffuseColor.rgb, roughnessFactor);');
  };
  return material;
}

export function createFootprints(buildings: Building[], uniforms: ScaledUniforms): THREE.Mesh {
  const b = new Builder();
  for (const bld of buildings) addFootprint(b, bld);
  const geometry = b.geometry();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(
    geometry,
    buildingMaterial(uniforms),
  );
  mesh.customDepthMaterial = scaledMaterial(
    new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }),
    uniforms,
  ) as THREE.MeshDepthMaterial;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

/** Aggregates footprints onto a grid of `cell` metres: one box per occupied cell. */
export function createBlocks(
  buildings: Building[],
  area: Area,
  cell: number,
  uniforms: ScaledUniforms,
): THREE.Mesh {
  const nx = Math.ceil(area.sizeX / cell);
  const nz = Math.ceil(area.sizeZ / cell);
  const built = new Float32Array(nx * nz);
  const heightSum = new Float32Array(nx * nz);
  const baseMin = new Float32Array(nx * nz).fill(1e9);
  for (const bld of buildings) {
    const { ring } = bld;
    let a = 0;
    let cx = 0;
    let cz = 0;
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      a += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
      cx += ring[i * 2];
      cz += ring[i * 2 + 1];
    }
    a = Math.abs(a) / 2;
    const i = Math.floor(cx / n / cell);
    const k = Math.floor(cz / n / cell);
    if (i < 0 || k < 0 || i >= nx || k >= nz) continue;
    const c = k * nx + i;
    built[c] += a;
    heightSum[c] += a * bld.height;
    baseMin[c] = Math.min(baseMin[c], bld.base);
  }
  const b = new Builder();
  const normal = new THREE.Vector3();
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < nx; i++) {
      const c = k * nx + i;
      if (built[c] <= 0) continue;
      const frac = Math.min(built[c] / (cell * cell), 1);
      if (frac < 0.02) continue;
      const side = cell * Math.min(0.94, Math.sqrt(frac) * 1.35);
      const h = heightSum[c] / built[c];
      const x0 = (i + 0.5) * cell - side / 2;
      const z0 = (k + 0.5) * cell - side / 2;
      const ring = new Float32Array([x0, z0, x0 + side, z0, x0 + side, z0 + side, x0, z0 + side]);
      const r = hash(i, k);
      const wall = WALLS[Math.floor(r * WALLS.length)].clone().lerp(BIG_WALL, h > 12 ? 0.6 : 0.2);
      for (let e = 0; e < 4; e++) {
        const f = (e + 1) % 4;
        const ax = ring[e * 2];
        const az = ring[e * 2 + 1];
        const bx = ring[f * 2];
        const bz = ring[f * 2 + 1];
        normal.set(bz - az, 0, -(bx - ax)).normalize();
        if (normal.x * (ax + bx - 2 * x0 - side) + normal.z * (az + bz - 2 * z0 - side) < 0) normal.negate();
        b.quad([ax, -SINK, az], [bx, -SINK, bz], [bx, h, bz], [ax, h, az], normal, wall, baseMin[c]);
      }
      normal.set(0, 1, 0);
      const roof = ROOFS[Math.floor(hash(k, i) * ROOFS.length)];
      b.quad([x0, h, z0], [x0 + side, h, z0], [x0 + side, h, z0 + side], [x0, h, z0 + side], normal, roof, baseMin[c]);
    }
  }
  const mesh = new THREE.Mesh(
    b.geometry(),
    buildingMaterial(uniforms),
  );
  mesh.customDepthMaterial = scaledMaterial(
    new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }),
    uniforms,
  ) as THREE.MeshDepthMaterial;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

export interface Mass {
  /** Outer ring first, then holes, in local scene metres (x east, z south). */
  rings: Float32Array[];
  height: number;
}

export function parseMasses(buffer: ArrayBuffer): Mass[] {
  const view = new DataView(buffer);
  const out: Mass[] = [];
  let o = 0;
  while (o < view.byteLength) {
    const count = view.getUint16(o, true);
    const height = view.getFloat32(o + 4, true);
    o += 8;
    const rings: Float32Array[] = [];
    for (let r = 0; r < count; r++) {
      const n = view.getUint16(o, true);
      o += 4;
      const ring = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        ring[i * 2] = view.getFloat32(o, true);
        ring[i * 2 + 1] = -view.getFloat32(o + 4, true);
        o += 8;
      }
      rings.push(ring);
    }
    out.push({ rings, height });
  }
  return out;
}

/**
 * Extrudes merged masses. Unlike single buildings a mass can run a long way up a
 * hill, so every wall and roof vertex sits on the terrain beneath it rather than on
 * one base height.
 */
export function createMasses(masses: Mass[], area: Area, uniforms: ScaledUniforms): THREE.Mesh {
  const b = new Builder();
  const normal = new THREE.Vector3();
  for (const mass of masses) {
    const h = mass.height;
    const r = hash(mass.rings[0][0], mass.rings[0][1]);
    const wall = WALLS[Math.floor(r * WALLS.length)].clone().lerp(BIG_WALL, h > 12 ? 0.6 : 0.25);
    const roof = ROOFS[Math.floor(hash(mass.rings[0][1], mass.rings[0][0]) * ROOFS.length)];
    for (const ring of mass.rings) {
      const n = ring.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = ring[i * 2];
        const az = ring[i * 2 + 1];
        const bx = ring[j * 2];
        const bz = ring[j * 2 + 1];
        const ga = heightAt(area, ax, az);
        const gb = heightAt(area, bx, bz);
        // Outer rings are counter-clockwise on the map and holes clockwise, so this faces out of the solid.
        normal.set(-(bz - az), 0, bx - ax).normalize();
        b.quad([ax, -SINK, az, ga], [bx, -SINK, bz, gb], [bx, h, bz, gb], [ax, h, az, ga], normal, wall, 0);
      }
    }
    const toVec = (ring: Float32Array) => {
      const v: THREE.Vector2[] = [];
      for (let i = 0; i < ring.length; i += 2) v.push(new THREE.Vector2(ring[i], ring[i + 1]));
      return v;
    };
    const contour = toVec(mass.rings[0]);
    const holes = mass.rings.slice(1).map(toVec);
    const all = contour.concat(...holes);
    normal.set(0, 1, 0);
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, holes)) {
      const p = (v: THREE.Vector2) => [v.x, h, v.y, heightAt(area, v.x, v.y)];
      b.tri(p(all[i]), p(all[j]), p(all[k]), normal, roof, 0);
    }
  }
  const mesh = new THREE.Mesh(
    b.geometry(),
    buildingMaterial(uniforms),
  );
  mesh.customDepthMaterial = scaledMaterial(
    new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }),
    uniforms,
  ) as THREE.MeshDepthMaterial;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

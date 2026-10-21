import * as THREE from 'three';
import type { Area } from './area';

/**
 * Buildings for a PoC area, in two representations:
 *
 * - footprints: every Overture footprint extruded to its height, with gable roofs
 *   on simple rectangular houses.
 * - blocks: footprints aggregated onto a coarse grid, one box per cell sized by
 *   built-up fraction and mean height. This is the form that could be baked for
 *   the whole UK and read from far away.
 *
 * Both take a vertical scale, so a town can be drawn taller than life.
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
      this.base.push(base);
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

export function createFootprints(buildings: Building[], uniforms: ScaledUniforms): THREE.Mesh {
  const b = new Builder();
  for (const bld of buildings) addFootprint(b, bld);
  const geometry = b.geometry();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(
    geometry,
    scaledMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), uniforms),
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
    scaledMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), uniforms),
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

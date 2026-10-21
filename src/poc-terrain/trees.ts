import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { type Area, coverAt, heightAt } from './area';
import type { ScaledUniforms } from './buildings';

/**
 * Trees scattered over the woodland classes of the land-cover raster, plus the
 * individually mapped OpenStreetMap trees. `scale` enlarges every tree and spreads
 * them out by the same factor, so a forest stays a forest when drawn bigger than life.
 */

export interface TreeOptions {
  /** 1 is life size (roughly 10 m spacing, 8 to 22 m tall). */
  scale: number;
}

function conifer(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.03, 0.04, 0.2, 5).translate(0, 0.1, 0);
  const lower = new THREE.ConeGeometry(0.3, 0.55, 7).translate(0, 0.4, 0);
  const upper = new THREE.ConeGeometry(0.22, 0.5, 7).translate(0, 0.72, 0);
  return tinted([trunk, lower, upper], [0.35, 1, 1]);
}

function broadleaf(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.035, 0.05, 0.4, 5).translate(0, 0.2, 0);
  const crown = mergeVertices(new THREE.IcosahedronGeometry(0.34, 1).deleteAttribute('normal').deleteAttribute('uv'));
  crown.scale(1, 0.85, 1).translate(0, 0.62, 0);
  crown.computeVertexNormals();
  // Knobbly crown so it does not read as a ball.
  const p = crown.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const s = 1 + 0.12 * Math.sin(p.getX(i) * 23 + p.getZ(i) * 17) * Math.cos(p.getY(i) * 19);
    p.setXYZ(i, p.getX(i) * s, 0.62 + (p.getY(i) - 0.62) * s, p.getZ(i) * s);
  }
  return tinted([trunk.deleteAttribute('uv'), crown], [0.35, 1]);
}

/** Merges parts with a per-part brightness in the colour attribute (trunks darker). */
function tinted(parts: THREE.BufferGeometry[], shade: number[]): THREE.BufferGeometry {
  const prepared = parts.map((g, i) => {
    const geo = g.index ? g.toNonIndexed() : g;
    if (geo.hasAttribute('uv')) geo.deleteAttribute('uv');
    const c = new Float32Array(geo.getAttribute('position').count * 3);
    const trunk = shade[i] < 1;
    for (let k = 0; k < c.length; k += 3) {
      c[k] = trunk ? 0.5 : 1;
      c[k + 1] = trunk ? 0.33 : 1;
      c[k + 2] = trunk ? 0.22 : 1;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geo;
  });
  return mergeGeometries(prepared)!;
}

const CONIFER_GREENS = ['#1d3a26', '#25432b', '#1a3323', '#2b4a2f'].map((c) => new THREE.Color(c));
const BROAD_GREENS = ['#3b5a22', '#46652a', '#2f4d1d', '#557030', '#4a5f24'].map((c) => new THREE.Color(c));

/** Splits trees into square tiles so the GPU can frustum-cull most of a big forest. */
const TILE = 1500;

export function createTrees(area: Area, opts: TreeOptions, uniforms: ScaledUniforms): THREE.Group {
  const group = new THREE.Group();
  const s = opts.scale;
  const spacing = 10 * s;
  const C = area.meta.classes;
  const tilesX = Math.ceil(area.sizeX / TILE);
  const tilesZ = Math.ceil(area.sizeZ / TILE);
  const buckets: { c: number[]; b: number[] }[] = [];
  for (let i = 0; i < tilesX * tilesZ; i++) buckets.push({ c: [], b: [] });
  let seed = 1;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };

  // Jittered grid over the whole area; keep points that land in woodland.
  for (let z = 0; z < area.sizeZ; z += spacing) {
    for (let x = 0; x < area.sizeX; x += spacing) {
      const px = x + rand() * spacing;
      const pz = z + rand() * spacing;
      const k = coverAt(area, px, pz);
      const t = Math.min(Math.floor(pz / TILE), tilesZ - 1) * tilesX + Math.min(Math.floor(px / TILE), tilesX - 1);
      if (k === C.conifer) buckets[t].c.push(px, pz);
      else if (k === C.broadleaf) buckets[t].b.push(px, pz);
      else if ((k === C.urban || k === C.park) && rand() < 0.04 / s) buckets[t].b.push(px, pz);
    }
  }
  // Individually mapped trees (street and park trees).
  if (s < 2) {
    for (let i = 0; i < area.trees.length; i += 3) {
      const px = area.trees[i];
      const pz = -area.trees[i + 1];
      const t = Math.min(Math.floor(pz / TILE), tilesZ - 1) * tilesX + Math.min(Math.floor(px / TILE), tilesX - 1);
      if (t >= 0) buckets[t].b.push(px, pz);
    }
  }

  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  // Trees ride on the terrain but are not stretched with it: only their base moves.
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aBase;\nuniform float terrainScale;')
      .replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
  mvPosition.y += aBase * terrainScale;
  mvPosition = modelViewMatrix * mvPosition;
  gl_Position = projectionMatrix * mvPosition;`,
      );
  };
  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depthMaterial.onBeforeCompile = material.onBeforeCompile;

  const geos = { c: conifer(), b: broadleaf() };
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  for (const bucket of buckets) {
    for (const kind of ['c', 'b'] as const) {
      const pts = bucket[kind];
      const n = pts.length / 2;
      if (!n) continue;
      const geo = geos[kind].clone();
      const bases = new Float32Array(n);
      const mesh = new THREE.InstancedMesh(geo, material, n);
      const greens = kind === 'c' ? CONIFER_GREENS : BROAD_GREENS;
      for (let i = 0; i < n; i++) {
        const x = pts[i * 2];
        const z = pts[i * 2 + 1];
        bases[i] = heightAt(area, x, z) - 0.5;
        const h = (kind === 'c' ? 14 + rand() * 9 : 9 + rand() * 10) * s;
        q.setFromAxisAngle(up, rand() * Math.PI * 2);
        mesh.setMatrixAt(i, m.compose(pos.set(x, 0, z), q, scl.set(h * (0.9 + rand() * 0.25), h, h)));
        mesh.setColorAt(i, greens[Math.floor(rand() * greens.length)]);
      }
      geo.setAttribute('aBase', new THREE.InstancedBufferAttribute(bases, 1));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = depthMaterial;
      // Bounding sphere ignores aBase, so give the tile a tall box by hand.
      mesh.computeBoundingSphere();
      mesh.boundingSphere!.radius += area.meta.maxHeight * 3 + 100 * s;
      mesh.boundingSphere!.center.y += area.meta.maxHeight;
      group.add(mesh);
    }
  }
  return group;
}

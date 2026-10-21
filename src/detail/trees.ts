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
  /** Only scatter inside this local rectangle (metres: x0, z0, x1, z1). Defaults to the whole area. */
  bounds?: [number, number, number, number];
}

// Tree geometry is built in a unit box (1 = tree height) and scaled per instance. Vertex colours
// carry baked ambient occlusion (darker inside and under the crown) and the trunk colour, and the
// normals are bent outwards from the crown centre so foliage shades softly, like a mass of leaves.

const rnd = (() => {
  let s = 7;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
})();

function trunk(height: number, radius: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius * 0.7, radius, height, 6, 1, true).translate(0, height / 2, 0);
  return finish(g, () => [0.36, 0.27, 0.2]);
}

/** Bends normals towards the direction from `centre`, and bakes occlusion into colours. */
function foliage(g: THREE.BufferGeometry, centre: THREE.Vector3, bottom: number, top: number, bend: number) {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const v = new THREE.Vector3();
  const r = new THREE.Vector3();
  const colours: number[] = [];
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    r.copy(v).sub(centre).normalize();
    const nv = new THREE.Vector3().fromBufferAttribute(n, i).lerp(r, bend).normalize();
    n.setXYZ(i, nv.x, nv.y, nv.z);
    // Darker low in the crown and towards its core; tips catch the light.
    const height = THREE.MathUtils.clamp((v.y - bottom) / (top - bottom), 0, 1);
    const radial = Math.min(v.clone().sub(centre).setY(0).length() / 0.3, 1);
    const ao = 0.6 + 0.35 * height + 0.2 * radial;
    const k = Math.min(ao, 1.15);
    colours.push(k, k, k);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  return g;
}

function finish(g: THREE.BufferGeometry, colour: () => number[]): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  if (geo.hasAttribute('uv')) geo.deleteAttribute('uv');
  const c: number[] = [];
  for (let i = 0; i < geo.getAttribute('position').count; i++) c.push(...colour());
  geo.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  return geo;
}

/** A spruce: tiers of drooping, ragged branch skirts narrowing to a spire. */
function conifer(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [trunk(0.25, 0.025)];
  const tiers = 7;
  for (let t = 0; t < tiers; t++) {
    const f = t / (tiers - 1);
    const y0 = 0.12 + f * 0.7;
    const radius = 0.26 * (1 - f * 0.85) + 0.015;
    const height = 0.2 - f * 0.06;
    const segments = 10;
    const cone = new THREE.ConeGeometry(radius, height, segments, 1, true).translate(0, y0 + height / 2, 0);
    const p = cone.getAttribute('position');
    const twist = rnd() * Math.PI;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y > y0 + 0.001) continue;
      // Ragged, drooping skirt: alternate branch tips out and down.
      const a = Math.atan2(p.getZ(i), p.getX(i)) + twist;
      const tip = 0.75 + 0.35 * Math.abs(Math.sin(a * 2.5)) + 0.15 * rnd();
      p.setXYZ(i, p.getX(i) * tip, y - 0.03 * tip, p.getZ(i) * tip);
    }
    cone.computeVertexNormals();
    parts.push(foliage(cone.toNonIndexed(), new THREE.Vector3(0, y0, 0), 0.1, 1, 0.45));
  }
  return merged(parts);
}

/** A broadleaf: a trunk under a crown of overlapping leafy lumps. */
function broadleaf(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [trunk(0.45, 0.035)];
  const centre = new THREE.Vector3(0, 0.62, 0);
  const lumps = 7;
  for (let i = 0; i < lumps; i++) {
    const a = (i / lumps) * Math.PI * 2 + rnd();
    const up = i === 0 ? 0.14 : (rnd() - 0.4) * 0.2;
    const out = i === 0 ? 0 : 0.14 + rnd() * 0.06;
    const r = i === 0 ? 0.24 : 0.15 + rnd() * 0.06;
    const lump = new THREE.IcosahedronGeometry(r, 1);
    const p = lump.getAttribute('position');
    for (let k = 0; k < p.count; k++) {
      const s = 1 + 0.18 * (Math.sin(p.getX(k) * 41 + i) * Math.cos(p.getZ(k) * 37 - i) * Math.sin(p.getY(k) * 29));
      p.setXYZ(k, p.getX(k) * s, p.getY(k) * s * 0.85, p.getZ(k) * s);
    }
    lump.translate(Math.cos(a) * out, centre.y + up, Math.sin(a) * out);
    // Weld the icosahedron so its normals are smooth, not faceted.
    const smooth = mergeVertices(lump.deleteAttribute('normal').deleteAttribute('uv'));
    smooth.computeVertexNormals();
    parts.push(foliage(smooth.toNonIndexed(), centre, 0.38, 0.95, 0.65));
  }
  return merged(parts);
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  for (const g of parts) if (g.hasAttribute('uv')) g.deleteAttribute('uv');
  return mergeGeometries(parts)!;
}

const CONIFER_GREENS = ['#3f6a44', '#47724a', '#38603d', '#517a50', '#456b43'].map((c) => new THREE.Color(c));
const BROAD_GREENS = ['#567a32', '#62863a', '#4b6e2c', '#6e9142', '#5c7a30', '#7a8f3c'].map((c) => new THREE.Color(c));

/** Splits trees into square chunks (m) so the GPU can frustum-cull most of a big forest. */
export const TREE_CHUNK = 1500;
const TILE = TREE_CHUNK;

export function createTrees(area: Area, opts: TreeOptions, uniforms: ScaledUniforms): THREE.Group {
  const group = new THREE.Group();
  const s = opts.scale;
  const spacing = 10 * s;
  const C = area.meta.classes;
  const tilesX = Math.ceil(area.sizeX / TILE);
  const tilesZ = Math.ceil(area.sizeZ / TILE);
  // c conifer, b broadleaf, y young plantation (small conifers).
  const buckets: { c: number[]; b: number[]; y: number[] }[] = [];
  for (let i = 0; i < tilesX * tilesZ; i++) buckets.push({ c: [], b: [], y: [] });
  const [bx0, bz0, bx1, bz1] = opts.bounds ?? [0, 0, area.sizeX, area.sizeZ];
  // Seed from the bounds so a chunk always gets the same trees.
  let seed = (Math.abs((Math.floor(bx0) * 73856093) ^ (Math.floor(bz0) * 19349663)) % 2147483646) + 1;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };

  // Jittered grid over the whole area; keep points that land in woodland.
  for (let z = bz0; z < bz1; z += spacing) {
    for (let x = bx0; x < bx1; x += spacing) {
      const px = x + rand() * spacing;
      const pz = z + rand() * spacing;
      const k = coverAt(area, px, pz);
      const t = Math.min(Math.floor(pz / TILE), tilesZ - 1) * tilesX + Math.min(Math.floor(px / TILE), tilesX - 1);
      if (k === C.conifer) buckets[t].c.push(px, pz);
      else if (k === C.broadleaf) buckets[t].b.push(px, pz);
      else if (k === C.mixed) buckets[t][rand() < 0.55 ? 'c' : 'b'].push(px, pz);
      else if (k === C.young) buckets[t].y.push(px, pz);
      else if ((k === C.urban || k === C.park) && rand() < 0.04 / s) buckets[t].b.push(px, pz);
    }
  }
  // Individually mapped trees (street and park trees).
  if (s < 2) {
    for (let i = 0; i < area.trees.length; i += 3) {
      const px = area.trees[i];
      const pz = -area.trees[i + 1];
      if (px < bx0 || px >= bx1 || pz < bz0 || pz >= bz1) continue;
      const t = Math.min(Math.floor(pz / TILE), tilesZ - 1) * tilesX + Math.min(Math.floor(px / TILE), tilesX - 1);
      if (t >= 0) buckets[t].b.push(px, pz);
    }
  }

  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
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
    // Light through and between leaves: a little of the albedo glows, so crowns are never black.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.12;',
    );
  };
  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depthMaterial.onBeforeCompile = material.onBeforeCompile;

  const geos = { c: conifer(), b: broadleaf(), y: conifer() };
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  for (const [t, bucket] of buckets.entries()) {
    // Chunk centre in local metres, so callers can show or hide chunks by distance.
    const centre = new THREE.Vector3(((t % tilesX) + 0.5) * TILE, 0, (Math.floor(t / tilesX) + 0.5) * TILE);
    for (const kind of ['c', 'b', 'y'] as const) {
      const pts = bucket[kind];
      const n = pts.length / 2;
      if (!n) continue;
      const geo = geos[kind].clone();
      const bases = new Float32Array(n);
      const mesh = new THREE.InstancedMesh(geo, material, n);
      const greens = kind === 'b' ? BROAD_GREENS : CONIFER_GREENS;
      for (let i = 0; i < n; i++) {
        const x = pts[i * 2];
        const z = pts[i * 2 + 1];
        bases[i] = heightAt(area, x, z) - 0.5;
        const h = (kind === 'c' ? 14 + rand() * 9 : kind === 'y' ? 2.5 + rand() * 4 : 9 + rand() * 10) * s;
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
      mesh.userData.centre = centre;
      group.add(mesh);
    }
  }
  return group;
}

import * as THREE from 'three';
import { GroundSampler } from '../camera/groundSampler';
import { type Area, heightAt, loadArea } from './area';
import {
  type Building,
  createFootprints,
  createMasses,
  parseBuildings,
  parseMasses,
  type ScaledUniforms,
} from './buildings';
import { createBoundaries } from './boundaries';
import { createGround } from './ground';
import { createTrees, TREE_CHUNK } from './trees';

/**
 * Detailed terrain tiles in the main map (docs/terrain-detail.md): a fine height grid with
 * land-cover shading, buildings and trees, cut into the coarse UK terrain.
 *
 * Each tile is built in local metres and placed in the world (km) by its group's transform.
 * What it draws depends on how far away the camera is:
 *
 * - buildings: real footprints close up, fine merged street blocks in the middle distance,
 *   coarse street blocks far away, stretched taller the further the camera is;
 * - trees: life-size near the camera and larger, sparser stand-ins further out.
 */

/** Tiles baked so far by scripts/detail/build_area.py. */
export const DETAIL_AREAS = ['plymouth', 'kielder'];

/** Heights are blended into the coarse terrain over this distance from a tile's edge (m). */
const EDGE_BLEND = 600;
/** Depth of the skirt hung from a tile's edge to hide any crack against the coarse terrain (m). */
const SKIRT = 150;

// View distances (km, from the camera to the nearest point of a tile, including height).
const FOOTPRINTS_WITHIN = 2.5;
const FINE_BLOCKS_WITHIN = 12;
const BOUNDARIES_WITHIN = 4;
const TILE_HIDDEN_BEYOND = 250;
/** Life-size trees are drawn in chunks within this distance (km); further chunks use the far trees. */
const NEAR_TREES_WITHIN = 4;
/** At most this many chunks of near trees are generated per frame, to avoid a hitch. */
const NEAR_CHUNKS_PER_FRAME = 2;
const NEAR_TREE_SCALE = 1.5;
const FAR_TREE_SCALE = 4;

interface Tile {
  area: Area;
  group: THREE.Group;
  ground: THREE.Mesh;
  skirt: THREE.Mesh;
  uniforms: ScaledUniforms;
  /** World rectangle in km: xMin, zMin, xMax, zMax. */
  rect: THREE.Vector4;
  buildings: Building[];
  footprints?: THREE.Mesh;
  /** Hedges and walls (boundaries.bin), built when the camera first comes near. */
  boundaryData: ArrayBuffer | null;
  boundaries?: THREE.Mesh;
  fineBlocks?: THREE.Mesh;
  coarseBlocks?: THREE.Mesh;
  /** Life-size trees, generated per chunk as the camera approaches; key "i,j". */
  nearTrees: Map<string, THREE.Group>;
  farTrees: THREE.Group;
}

export interface DetailTerrain {
  group: THREE.Group;
  rects: THREE.Vector4[];
  /** Each tile's drawn ground heights (m, true scale) and grid, for the sea's surf. */
  grounds: { heights: Float32Array; width: number; height: number; x0: number; yMax: number; spacing: number }[];
  /** Drawn ground height (km, exaggerated) inside a tile, or null outside every tile. */
  terrainAt(x: number, z: number): number | null;
  setExaggeration(value: number): void;
  /** Picks levels of detail for the camera; call once per frame. */
  update(camera: THREE.Camera, heightAboveGround: number): void;
}

/** Pulls heights near the tile edge onto the coarse terrain so the two surfaces meet. */
function blendEdges(area: Area, coarse: GroundSampler, coarseScale: number) {
  const { meta, heights } = area;
  for (let j = 0; j < meta.height; j++) {
    for (let i = 0; i < meta.width; i++) {
      const x = i * meta.spacing;
      const z = j * meta.spacing;
      const edge = Math.min(x, z, area.sizeX - x, area.sizeZ - z);
      if (edge >= EDGE_BLEND) continue;
      const worldX = (meta.xMin + x) / 1000;
      const worldZ = -(meta.yMax - z) / 1000;
      const coarseM = (coarse.terrainAt(worldX, worldZ) / coarseScale) * 1000;
      const t = THREE.MathUtils.smoothstep(edge, 0, EDGE_BLEND);
      const k = j * meta.width + i;
      heights[k] = coarseM + (heights[k] - coarseM) * t;
    }
  }
}

/** A curtain around the tile from its edge heights down by SKIRT metres. */
function createSkirt(area: Area): THREE.Mesh {
  const { meta, heights } = area;
  const ring: [number, number][] = [];
  for (let i = 0; i < meta.width; i++) ring.push([i, 0]);
  for (let j = 1; j < meta.height; j++) ring.push([meta.width - 1, j]);
  for (let i = meta.width - 2; i >= 0; i--) ring.push([i, meta.height - 1]);
  for (let j = meta.height - 2; j > 0; j--) ring.push([0, j]);
  const positions: number[] = [];
  for (const [i, j] of ring) {
    const h = heights[j * meta.width + i];
    positions.push(i * meta.spacing, h, j * meta.spacing, i * meta.spacing, h - SKIRT, j * meta.spacing);
  }
  const indices: number[] = [];
  const n = ring.length;
  for (let k = 0; k < n; k++) {
    const a = k * 2;
    const b = ((k + 1) % n) * 2;
    indices.push(a, a + 1, b, b, a + 1, b + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  // Seen through pixel cracks from either side, so double sided, in the far patchwork's colour.
  const material = new THREE.MeshStandardMaterial({ color: '#5d6a2e', roughness: 1, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
}

async function createTile(baseUrl: string, name: string, coarse: GroundSampler, coarseScale: number): Promise<Tile> {
  const area = await loadArea(baseUrl, name);
  const dir = `${baseUrl}data/detail/${name}/`;
  const [fine, coarseMasses, boundaryData] = await Promise.all(
    ['masses-10', 'masses-18', 'boundaries'].map((f) =>
      fetch(`${dir}${f}.bin`).then((r) => (r.ok ? r.arrayBuffer() : null)),
    ),
  );
  blendEdges(area, coarse, coarseScale);

  const { meta } = area;
  const group = new THREE.Group();
  group.name = `detail:${name}`;
  group.position.set(meta.xMin / 1000, 0, -meta.yMax / 1000);
  group.scale.setScalar(0.001);

  const uniforms: ScaledUniforms = { terrainScale: { value: coarseScale }, buildingScale: { value: 1 } };
  const g = createGround(area);
  const skirt = createSkirt(area);
  group.add(g.mesh, skirt);

  const tile: Tile = {
    area,
    group,
    ground: g.mesh,
    skirt,
    uniforms,
    rect: new THREE.Vector4(meta.xMin / 1000, -meta.yMax / 1000, meta.xMax / 1000, -meta.yMin / 1000),
    buildings: parseBuildings(area),
    boundaryData,
    fineBlocks: createMasses(parseMasses(fine!), area, uniforms),
    coarseBlocks: createMasses(parseMasses(coarseMasses!), area, uniforms),
    nearTrees: new Map(),
    farTrees: createTrees(area, { scale: FAR_TREE_SCALE }, uniforms),
  };
  group.add(tile.fineBlocks!, tile.coarseBlocks!, tile.farTrees);
  return tile;
}

export async function createDetailTerrain(
  baseUrl: string,
  coarseTerrain: THREE.Mesh,
  sun: THREE.DirectionalLight,
  renderer: THREE.WebGLRenderer,
): Promise<DetailTerrain> {
  // A sampler of the coarse mesh alone, before any tile overrides the camera's ground.
  const coarse = new GroundSampler(coarseTerrain);
  const tiles = await Promise.all(DETAIL_AREAS.map((n) => createTile(baseUrl, n, coarse, coarseTerrain.scale.y)));
  const group = new THREE.Group();
  group.name = 'detail-terrain';
  for (const t of tiles) group.add(t.group);
  let exaggeration = coarseTerrain.scale.y;

  // Sun shadows for buildings and trees when the camera is low enough to see them.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  sun.shadow.mapSize.set(4096, 4096);
  // The shadow camera spans 150 km of depth (km units), so bias is tiny: about 0.3 m.
  sun.shadow.bias = -0.000002;
  sun.shadow.normalBias = 0.0005;
  const sunDirection = sun.position.clone().normalize();
  sun.shadow.camera.near = 150;
  sun.shadow.camera.far = 300;
  if (!sun.target.parent) group.add(sun.target);

  const tilePos = new THREE.Vector3();
  const chunkPos = new THREE.Vector3();

  const terrainAt = (x: number, z: number): number | null => {
    for (const t of tiles) {
      const r = t.rect;
      if (x > r.x && x < r.z && z > r.y && z < r.w) {
        const lx = (x - r.x) * 1000;
        const lz = (z - r.y) * 1000;
        return (heightAt(t.area, lx, lz) / 1000) * exaggeration;
      }
    }
    return null;
  };

  const setExaggeration = (value: number) => {
    exaggeration = value;
    for (const t of tiles) {
      t.ground.scale.y = value;
      t.skirt.scale.y = value;
      t.uniforms.terrainScale.value = value;
    }
  };
  setExaggeration(exaggeration);

  const update = (camera: THREE.Camera, heightAboveGround: number) => {
    const cam = camera.position;
    let shadowFocus: THREE.Vector3 | null = null;
    let built = 0;
    for (const t of tiles) {
      const r = t.rect;
      // Horizontal distance to the tile (0 inside), combined with height above ground.
      const dx = Math.max(r.x - cam.x, 0, cam.x - r.z);
      const dz = Math.max(r.y - cam.z, 0, cam.z - r.w);
      const view = Math.hypot(dx, dz, heightAboveGround);
      t.group.visible = view < TILE_HIDDEN_BEYOND;
      if (!t.group.visible) continue;

      // Buildings: footprints, fine or coarse blocks, eased from life size near to 5x far.
      if (view < FOOTPRINTS_WITHIN && !t.footprints) {
        t.footprints = createFootprints(t.buildings, t.uniforms);
        t.group.add(t.footprints);
      }
      if (t.footprints) t.footprints.visible = view < FOOTPRINTS_WITHIN;
      if (view < BOUNDARIES_WITHIN && !t.boundaries && t.boundaryData) {
        t.boundaries = createBoundaries(t.area, t.boundaryData, t.uniforms);
        t.group.add(t.boundaries);
      }
      if (t.boundaries) t.boundaries.visible = view < BOUNDARIES_WITHIN;
      t.fineBlocks!.visible = view >= FOOTPRINTS_WITHIN && view < FINE_BLOCKS_WITHIN;
      t.coarseBlocks!.visible = view >= FINE_BLOCKS_WITHIN;
      const e = THREE.MathUtils.clamp(Math.log(Math.max(view, 0.3) / 0.3) / Math.log(30 / 0.3), 0, 1);
      t.uniforms.buildingScale.value = 1 + 4 * e * e;

      // Trees: life-size chunks near the camera, larger stand-ins beyond.
      t.group.getWorldPosition(tilePos);
      const ground = cam.y - heightAboveGround;
      const chunkDistance = (cx: number, cz: number) =>
        chunkPos.set(tilePos.x + cx / 1000, ground, tilePos.z + cz / 1000).distanceTo(cam);
      const nearKeys = new Set<string>();
      if (view < NEAR_TREES_WITHIN + 1) {
        const nx = Math.ceil(t.area.sizeX / TREE_CHUNK);
        const nz = Math.ceil(t.area.sizeZ / TREE_CHUNK);
        for (let j = 0; j < nz; j++) {
          for (let i = 0; i < nx; i++) {
            if (chunkDistance((i + 0.5) * TREE_CHUNK, (j + 0.5) * TREE_CHUNK) >= NEAR_TREES_WITHIN) continue;
            const key = `${i},${j}`;
            if (!t.nearTrees.has(key)) {
              // Chunks right around the camera are built at once; further ones a few per frame.
              const close = chunkDistance((i + 0.5) * TREE_CHUNK, (j + 0.5) * TREE_CHUNK) < 1.6;
              if (!close && built >= NEAR_CHUNKS_PER_FRAME) continue;
              const bounds: [number, number, number, number] = [
                i * TREE_CHUNK,
                j * TREE_CHUNK,
                Math.min((i + 1) * TREE_CHUNK, t.area.sizeX),
                Math.min((j + 1) * TREE_CHUNK, t.area.sizeZ),
              ];
              const chunk = createTrees(t.area, { scale: NEAR_TREE_SCALE, bounds }, t.uniforms);
              t.nearTrees.set(key, chunk);
              t.group.add(chunk);
              built++;
            }
            nearKeys.add(key);
          }
        }
      }
      for (const [key, chunk] of t.nearTrees) chunk.visible = nearKeys.has(key);
      for (const chunk of t.farTrees.children) {
        const c = chunk.userData.centre as THREE.Vector3;
        const key = `${Math.floor(c.x / TREE_CHUNK)},${Math.floor(c.z / TREE_CHUNK)}`;
        chunk.visible = !nearKeys.has(key);
      }

      if (view < 30) shadowFocus = cam;
    }

    // Shadows over the area around the camera while it is low over a tile.
    sun.castShadow = shadowFocus !== null && heightAboveGround < 20;
    if (sun.castShadow) {
      const extent = THREE.MathUtils.clamp(heightAboveGround * 3 + 1.5, 2, 30);
      const sc = sun.shadow.camera;
      sc.left = -extent;
      sc.right = extent;
      sc.top = extent;
      sc.bottom = -extent;
      sc.updateProjectionMatrix();
      sun.target.position.set(cam.x, 0, cam.z);
      sun.position.copy(sun.target.position).addScaledVector(sunDirection, 200);
    }
  };

  const grounds = tiles.map(({ area: { heights, meta } }) => ({
    heights,
    width: meta.width,
    height: meta.height,
    x0: meta.xMin,
    yMax: meta.yMax,
    spacing: meta.spacing,
  }));
  return { group, rects: tiles.map((t) => t.rect), grounds, terrainAt, setExaggeration, update };
}

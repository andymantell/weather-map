import * as THREE from 'three';
import type { Area } from './area';
import type { ScaledUniforms } from './buildings';
import { NOISE } from './ground';

/**
 * Roads from scripts/detail/build_roads.py as ribbons laid on the terrain, so close up they
 * have crisp edges, real widths and markings rather than the 4 m cover raster's steps.
 * Classes (as in the script): 0 motorway, 1 trunk, 2 primary, 3 secondary, 4 tertiary,
 * 5 residential, 6 service, 7 track, 8 footway.
 */

/** Ground height (m) exactly on the tile mesh's triangles, so ribbons never cut into it. */
function meshHeight(area: Area, x: number, z: number): number {
  const { meta, heights } = area;
  const fx = Math.min(Math.max(x / meta.spacing, 0), meta.width - 1.0001);
  const fz = Math.min(Math.max(z / meta.spacing, 0), meta.height - 1.0001);
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  const w = meta.width;
  const a = heights[j * w + i];
  const b = heights[j * w + i + 1];
  const c = heights[(j + 1) * w + i];
  const d = heights[(j + 1) * w + i + 1];
  // Same split as createGround: triangles (a, c, b) and (b, c, d).
  return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
}

const ROAD = /* glsl */ `
varying vec2 vRoad;   // metres along, -1..1 across
varying vec4 vInfo;   // class, width, flags, piece length
varying vec2 vRoadPos;
${NOISE}
void roadSurface(inout vec3 colour, inout float rough) {
  float cls = vInfo.x;
  float width = vInfo.y;
  bool unpaved = mod(floor(vInfo.z / 2.0), 2.0) > 0.5;
  float across = vRoad.y * width * 0.5; // metres from the centreline
  float edge = width * 0.5 - abs(across);
  vec2 p = vRoadPos;
  float footprint = length(fwidth(p));
  float near = 1.0 - smoothstep(0.15, 0.6, footprint);
  float grain = vnoise(p * 3.0) * 0.5 + vnoise(p * 0.7) * 0.5;
  vec3 c;
  if (cls > 7.5) {
    // Footway: paving in town, trodden earth elsewhere.
    c = unpaved ? vec3(0.46, 0.40, 0.31) : vec3(0.52, 0.51, 0.49);
    c *= 0.9 + 0.2 * grain;
  } else if (unpaved) {
    // Farm track: two gravel wheel ruts with grass between and along the sides.
    vec3 gravel = vec3(0.50, 0.45, 0.36) * (0.85 + 0.3 * grain);
    vec3 grass = vec3(0.26, 0.36, 0.13) * (0.85 + 0.3 * vnoise(p * 1.3));
    float rut = 1.0 - smoothstep(0.25, 0.55, abs(abs(across) - 0.8));
    c = mix(grass, gravel, max(rut, 1.0 - near));
  } else {
    // Asphalt: darker and smoother on main roads, patched on lanes, oily down each lane.
    float shade = cls < 3.5 ? 0.24 : 0.29;
    c = vec3(shade, shade, shade + 0.01) * (0.9 + 0.18 * grain);
    c *= 1.0 - 0.06 * smoothstep(0.4, 0.8, fbm(p / 6.0)) * step(4.5, cls);
    rough = 0.85;
    // Worn, gritty edge where the verge meets the road.
    c = mix(c, vec3(0.38, 0.36, 0.31), (1.0 - smoothstep(0.0, 0.35, edge)) * 0.6);
    float line = 0.0;
    // Away from piece ends, so markings stop short of junctions.
    float ends = smoothstep(6.0, 9.0, min(vRoad.x, vInfo.w - vRoad.x));
    if (cls < 3.5) {
      // Solid edge lines on main roads.
      line = max(line, 1.0 - smoothstep(0.05, 0.08, abs(edge - 0.45)));
    }
    if (cls < 4.5 && width > 5.5) {
      // Dashed centre line: 3 m line, 6 m gap (main roads), 2 m and 7 m on minor ones.
      float dash = cls < 2.5 ? 3.0 : 2.0;
      float on = step(fract(vRoad.x / 9.0), dash / 9.0);
      line = max(line, (1.0 - smoothstep(0.05, 0.08, abs(across))) * on * ends);
    }
    c = mix(c, vec3(0.85, 0.85, 0.82), line * near * 0.9);
  }
  // Written in sRGB like the ground's colours.
  colour = pow(c, vec3(2.2));
}
`;

export function createRoads(area: Area, buffer: ArrayBuffer, uniforms: ScaledUniforms): THREE.Mesh {
  const view = new DataView(buffer);
  const pos: number[] = [];
  const road: number[] = [];
  const info: number[] = [];
  const base: number[] = [];
  const index: number[] = [];
  let o = 0;
  while (o < buffer.byteLength) {
    const n = view.getUint16(o, true);
    const cls = view.getUint8(o + 2);
    const flags = view.getUint8(o + 3);
    const width = view.getFloat32(o + 4, true);
    const pts = new Float32Array(buffer.slice(o + 8, o + 8 + n * 8));
    o += 8 + n * 8;
    const bridge = (flags & 1) !== 0;
    // Wider roads sit a little higher, so they draw over narrower ones where they cross.
    const lift = 0.12 + 0.015 * (8 - cls);
    let length = 0;
    for (let i = 1; i < n; i++) length += Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
    const h0 = meshHeight(area, pts[0], pts[1]);
    const h1 = meshHeight(area, pts[(n - 1) * 2], pts[(n - 1) * 2 + 1]);
    const first = pos.length / 3;
    let along = 0;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2];
      const z = pts[i * 2 + 1];
      if (i > 0) along += Math.hypot(x - pts[i * 2 - 2], z - pts[i * 2 - 1]);
      const a = Math.max(i - 1, 0);
      const b = Math.min(i + 1, n - 1);
      let dx = pts[b * 2] - pts[a * 2];
      let dz = pts[b * 2 + 1] - pts[a * 2 + 1];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      const half = width / 2;
      for (const side of [-1, 1]) {
        const vx = x - dz * half * side;
        const vz = z + dx * half * side;
        // A bridge deck runs straight between the ground at its two ends.
        const ground = bridge ? h0 + (h1 - h0) * (along / (length || 1)) : meshHeight(area, vx, vz);
        pos.push(vx, lift, vz);
        base.push(ground);
        road.push(along, side);
        info.push(cls, width, flags, length);
      }
      if (i > 0) {
        const p = first + (i - 1) * 2;
        index.push(p, p + 2, p + 1, p + 1, p + 2, p + 3);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('aBase', new THREE.Float32BufferAttribute(base, 1));
  geometry.setAttribute('aRoad', new THREE.Float32BufferAttribute(road, 2));
  geometry.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 4));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({ roughness: 0.9, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aBase;\nattribute vec2 aRoad;\nattribute vec4 aInfo;\nuniform float terrainScale;\nvarying vec2 vRoad;\nvarying vec4 vInfo;\nvarying vec2 vRoadPos;',
      )
      // Ribbons lie on the ground, so their normal is the terrain's: straight up is close enough.
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvRoad = aRoad;\nvInfo = aInfo;\nvRoadPos = position.xz;\ntransformed.y = aBase * terrainScale + transformed.y;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${ROAD}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\nfloat roadRough = 0.92;\nroadSurface(diffuseColor.rgb, roadRough);')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roadRough;');
  };
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

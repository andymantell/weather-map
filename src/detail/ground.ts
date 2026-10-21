import * as THREE from 'three';
import type { Area } from './area';

// Colours in the shader are written in sRGB and linearised before lighting.

/**
 * Terrain surface for a detailed area: a fine height grid shaded from the land-cover
 * raster, with procedural detail per class (field patchwork with hedgerows, mottled
 * woodland and moorland, gardens speckled through housing, road tarmac).
 */

/** Hash, value noise, fbm and Voronoi helpers shared with the UK-wide terrain shader. */
export const NOISE = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
// Voronoi fields: returns cell id hash in .x, distance to the nearest edge in .y (cell units).
vec2 fields(vec2 p) {
  vec2 n = floor(p);
  vec2 f = fract(p);
  vec2 mg, mr;
  float md = 8.0;
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 o = 0.15 + 0.7 * hash22(n + g);
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  float ed = 8.0;
  for (int j = -2; j <= 2; j++)
  for (int i = -2; i <= 2; i++) {
    vec2 g = mg + vec2(float(i), float(j));
    vec2 o = 0.15 + 0.7 * hash22(n + g);
    vec2 r = g + o - f;
    if (dot(mr - r, mr - r) > 0.00001) ed = min(ed, dot(0.5 * (mr + r), normalize(r - mr)));
  }
  return vec2(hash12(n + mg), ed);
}
`;

/** One field of the UK patchwork (sRGB): pasture, arable or ploughed, with hedgerows at its edge. */
export const FIELDS = /* glsl */ `
vec3 fieldColour(float id, vec2 p, float edge, float fieldSize, out float rough) {
  // UK patchwork: mostly pasture greens, some arable yellows and ploughed browns.
  vec3 c;
  rough = 0.95;
  if (id < 0.55) c = mix(vec3(0.24, 0.36, 0.12), vec3(0.36, 0.46, 0.16), fract(id * 7.3));
  else if (id < 0.75) c = mix(vec3(0.42, 0.45, 0.17), vec3(0.55, 0.50, 0.24), fract(id * 5.1));
  else if (id < 0.88) c = mix(vec3(0.62, 0.54, 0.28), vec3(0.70, 0.62, 0.34), fract(id * 3.7));
  else c = mix(vec3(0.33, 0.25, 0.16), vec3(0.43, 0.33, 0.21), fract(id * 9.1));
  // Tramlines / furrows in arable fields along a per-field direction.
  float near = 1.0 - smoothstep(3.0, 14.0, length(fwidth(p)));
  if (id >= 0.55) {
    float a = id * 31.0;
    vec2 dir = vec2(cos(a), sin(a));
    float rows = sin(dot(p, dir) * (id > 0.88 ? 2.2 : 0.35));
    c *= 1.0 - 0.07 * near * (1.0 - rows);
  }
  c *= 0.88 + 0.24 * fbm(p / 18.0);
  // Hedgerows along field edges, broken up so they read as bushes.
  float hedge = 1.0 - smoothstep(1.5, 3.5, edge * fieldSize + 1.5 * vnoise(p / 4.0));
  c = mix(c, vec3(0.10, 0.17, 0.06) * (0.8 + 0.4 * vnoise(p / 3.0)), hedge * mix(0.5, 1.0, near));
  // Tussocks and patchy grass close up.
  c *= 1.0 + near * 0.18 * (vnoise(p / 0.7) - 0.5);
  return c;
}
`;

const SURFACE = /* glsl */ `
uniform sampler2D coverTex;
uniform vec2 areaSize;
uniform float coverTexel;
uniform float fieldSize;
varying vec2 vLocal;
varying float vHeight;
/** Surface relief (m) for bump shading, set by surfaceColour. */
float surfBump;

int coverClass(vec2 p) {
  // Beyond the detailed tile (the 1 km surroundings) land is all field patchwork.
  if (any(lessThan(p, vec2(0.0))) || any(greaterThan(p, areaSize))) return vHeight > 0.0 ? 1 : 0;
  return int(texture2D(coverTex, p / areaSize).r * 255.0 + 0.5);
}

vec3 surfaceColour(vec2 p, out float rough) {
  // Warp the lookup so class edges are organic rather than texel steps.
  vec2 warp = vec2(vnoise(p / 7.0), vnoise(p / 7.0 + 13.7)) - 0.5;
  int k = coverClass(p + warp * coverTexel * 1.6);
  float n = fbm(p / 9.0);
  float fine = vnoise(p / 1.7);
  rough = 0.95;
  float bumpFade = 1.0 - smoothstep(1.0, 6.0, length(fwidth(p)));
  float relief = fbm(p / 1.3) * 0.25 + vnoise(p / 0.4) * 0.05;
  surfBump = relief * bumpFade;
  if (k == 1) {
    vec2 f = fields(p / fieldSize + vec2(fbm(p / 300.0), fbm(p / 300.0 + 5.0)) * 0.6);
    return fieldColour(f.x, p, f.y, fieldSize, rough);
  }
  if (k == 2) return mix(vec3(0.27, 0.40, 0.15), vec3(0.34, 0.46, 0.20), n) * (0.95 + 0.05 * sin(p.x * 0.4)) * (0.9 + 0.2 * fine);
  if (k == 3 || k == 4) surfBump = (fbm(p / 3.0) * 0.8 + vnoise(p / 0.8) * 0.15) * bumpFade;
  if (k == 6) surfBump = (fbm(p / 2.0) * 1.2) * bumpFade;
  if (k >= 9 && k != 14) surfBump = 0.0;
  if (k == 3) return mix(vec3(0.08, 0.16, 0.05), vec3(0.17, 0.27, 0.08), n * 0.7 + fine * 0.3);
  if (k == 4) return mix(vec3(0.05, 0.11, 0.06), vec3(0.10, 0.18, 0.09), n * 0.7 + fine * 0.3);
  if (k == 5) {
    vec3 a = vec3(0.36, 0.30, 0.20), b = vec3(0.32, 0.25, 0.27), g = vec3(0.40, 0.40, 0.20);
    return mix(mix(a, b, smoothstep(0.35, 0.65, fbm(p / 40.0))), g, smoothstep(0.55, 0.8, n)) * (0.85 + 0.3 * fine);
  }
  if (k == 6) return vec3(0.45, 0.44, 0.42) * (0.7 + 0.5 * n);
  if (k == 7) return vec3(0.76, 0.69, 0.52) * (0.9 + 0.15 * n);
  if (k == 8) return mix(vec3(0.27, 0.30, 0.17), vec3(0.15, 0.22, 0.20), fine);
  if (k == 9) { rough = 0.12; return vec3(0.10, 0.16, 0.19); }
  if (k == 10) {
    // Housing: pavement and roofs-in-between greys speckled with gardens and trees.
    vec3 hard = vec3(0.47, 0.45, 0.42) * (0.85 + 0.3 * fine);
    vec3 garden = mix(vec3(0.20, 0.33, 0.11), vec3(0.12, 0.22, 0.07), vnoise(p / 2.5));
    return mix(hard, garden, smoothstep(0.42, 0.6, fbm(p / 6.0)));
  }
  if (k == 11) return vec3(0.42, 0.42, 0.43) * (0.85 + 0.25 * n);
  if (k == 12) { rough = 0.8; return vec3(0.33, 0.33, 0.34) * (0.9 + 0.2 * fine); }
  if (k == 13) { rough = 0.75; return vec3(0.27, 0.27, 0.28) * (0.9 + 0.2 * fine); }
  if (k == 14) return vec3(0.40, 0.35, 0.27) * (0.85 + 0.3 * n);
  if (k == 15) return vec3(0.30, 0.26, 0.23) * (0.85 + 0.3 * fine);
  if (k == 16) return vec3(0.52, 0.47, 0.37);
  // Sea bed / foreshore under the water plane.
  return mix(vec3(0.45, 0.42, 0.33), vec3(0.20, 0.25, 0.24), smoothstep(-0.5, -3.0, vHeight));
}
`;

/**
 * Bump shading from surfBump (metres) by screen-space derivatives, as in Mikkelsen (2010),
 * "Bump Mapping Unparametrized Surfaces on the GPU". Tile meshes are in metres scaled to km.
 */
const BUMP = /* glsl */ `
{
  vec3 pos = -vViewPosition;
  vec3 dpdx = dFdx(pos);
  vec3 dpdy = dFdy(pos);
  float b = surfBump * 0.001;
  float bx = dFdx(b);
  float by = dFdy(b);
  vec3 r1 = cross(dpdy, normal);
  vec3 r2 = cross(normal, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (bx * r1 + by * r2);
  normal = normalize(abs(det) * normal - grad);
}
`;

export interface Ground {
  mesh: THREE.Mesh;
  /** Shared with the surroundings so both get the same surface treatment. */
  material: THREE.MeshStandardMaterial;
  uniforms: { fieldSize: { value: number } };
}

export function createGround(area: Area): Ground {
  const { meta, heights } = area;
  const w = meta.width;
  const h = meta.height;
  const positions = new Float32Array(w * h * 3);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = (j * w + i) * 3;
      positions[k] = i * meta.spacing;
      positions[k + 1] = heights[j * w + i];
      positions[k + 2] = j * meta.spacing;
    }
  }
  const indices = new Uint32Array((w - 1) * (h - 1) * 6);
  let n = 0;
  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const a = j * w + i;
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      indices[n++] = a;
      indices[n++] = c;
      indices[n++] = b;
      indices[n++] = b;
      indices[n++] = c;
      indices[n++] = d;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  const coverTex = new THREE.DataTexture(area.cover, meta.coverWidth, meta.coverHeight, THREE.RedFormat);
  coverTex.magFilter = THREE.NearestFilter;
  coverTex.minFilter = THREE.NearestFilter;
  coverTex.needsUpdate = true;

  const uniforms = {
    coverTex: { value: coverTex },
    areaSize: { value: new THREE.Vector2(area.sizeX, area.sizeZ) },
    coverTexel: { value: meta.coverTexel },
    fieldSize: { value: 140 },
  };

  const material = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vLocal;\nvarying float vHeight;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position.xz;\nvHeight = position.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE}\n${FIELDS}\n${SURFACE}`)
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\nfloat surfRough;\ndiffuseColor.rgb = pow(surfaceColour(vLocal, surfRough), vec3(2.2));',
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = surfRough;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${BUMP}`);
  };
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return { mesh, material, uniforms };
}

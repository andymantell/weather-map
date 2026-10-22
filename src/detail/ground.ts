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

/**
 * The patchwork once single fields are under a few pixels: their average colour, with
 * broad swathes of pasture and arable so it still reads as farmland rather than lawn.
 */
vec3 fieldsFar(vec2 p) {
  vec3 pasture = vec3(0.29, 0.40, 0.13), arable = vec3(0.50, 0.46, 0.23);
  vec3 c = mix(pasture, arable, 0.25 + 0.6 * smoothstep(0.4, 0.7, fbm(p / 900.0)));
  return c * (0.82 + 0.3 * fbm(p / 260.0 + 3.0));
}

/** Fields near, their average far, crossfading as fields shrink to a few pixels. */
vec3 patchwork(vec2 p, float fieldSize, out float rough) {
  float footprint = length(fwidth(p));
  float far = smoothstep(0.15, 0.5, footprint / fieldSize);
  rough = 0.95;
  vec3 c = fieldsFar(p);
  if (far < 1.0) {
    vec2 f = fields(p / fieldSize + vec2(fbm(p / 300.0), fbm(p / 300.0 + 5.0)) * 0.6);
    c = mix(fieldColour(f.x, p, f.y, fieldSize, rough), c, far);
  }
  return c;
}
`;

const SURFACE = /* glsl */ `
uniform sampler2D coverTex;
uniform vec2 areaSize;
uniform float coverTexel;
uniform float fieldSize;
uniform sampler2D imageryTex;
uniform vec2 imagerySize;
uniform float useImagery;
/** 1 while the road ribbons are drawn, so the cover raster's own roads step aside. */
uniform float roadRibbons;
varying vec2 vLocal;
varying float vHeight;
/** Surface relief (m) for bump shading, set by surfaceColour. */
float surfBump;

int coverClass(vec2 p) {
  // Beyond the detailed tile (the 1 km surroundings) land is all field patchwork.
  if (any(lessThan(p, vec2(0.0))) || any(greaterThan(p, areaSize))) return vHeight > 0.0 ? 1 : 0;
  return int(texture2D(coverTex, p / areaSize).r * 255.0 + 0.5);
}

vec3 proceduralColour(vec2 p, int k, out float rough) {
  float n = fbm(p / 9.0);
  float fine = vnoise(p / 1.7);
  rough = 0.95;
  float bumpFade = 1.0 - smoothstep(1.0, 6.0, length(fwidth(p)));
  float relief = fbm(p / 1.3) * 0.25 + vnoise(p / 0.4) * 0.05;
  surfBump = relief * bumpFade;
  if (k == 1) {
    return patchwork(p, fieldSize, rough);
  }
  if (k == 2) return mix(vec3(0.27, 0.40, 0.15), vec3(0.34, 0.46, 0.20), n) * (0.95 + 0.05 * sin(p.x * 0.4)) * (0.9 + 0.2 * fine);
  if (k == 3 || k == 4) surfBump = (fbm(p / 3.0) * 0.8 + vnoise(p / 0.8) * 0.15) * bumpFade;
  if (k == 6) surfBump = (fbm(p / 2.0) * 1.2) * bumpFade;
  if (k >= 10 && k != 14 && k < 17) surfBump = 0.0;
  if (k == 3) return mix(vec3(0.12, 0.21, 0.07), vec3(0.22, 0.32, 0.11), n * 0.7 + fine * 0.3);
  if (k == 4) return mix(vec3(0.08, 0.15, 0.08), vec3(0.15, 0.24, 0.12), n * 0.7 + fine * 0.3);
  if (k == 5) {
    vec3 a = vec3(0.36, 0.30, 0.20), b = vec3(0.32, 0.25, 0.27), g = vec3(0.40, 0.40, 0.20);
    return mix(mix(a, b, smoothstep(0.35, 0.65, fbm(p / 40.0))), g, smoothstep(0.55, 0.8, n)) * (0.85 + 0.3 * fine);
  }
  if (k == 6) return vec3(0.45, 0.44, 0.42) * (0.7 + 0.5 * n);
  if (k == 7) return vec3(0.76, 0.69, 0.52) * (0.9 + 0.15 * n);
  if (k == 8) return mix(vec3(0.27, 0.30, 0.17), vec3(0.15, 0.22, 0.20), fine);
  if (k == 9) {
    // Inland water sits at its own level above the sea plane, so it is shaded here: dark
    // water with wind ripples, lit mostly by the sky it reflects.
    rough = 0.08;
    surfBump = (vnoise(p / 1.5) * 0.04 + vnoise(p / 6.0 + 3.0) * 0.08) * bumpFade;
    return vec3(0.06, 0.10, 0.11);
  }
  if (k == 10) {
    // Housing: pavement and roofs-in-between greys speckled with gardens and trees.
    // Larger, calmer patches now that roads are drawn on top.
    vec3 hard = vec3(0.50, 0.48, 0.45) * (0.92 + 0.12 * fine);
    vec3 garden = mix(vec3(0.24, 0.36, 0.13), vec3(0.17, 0.28, 0.10), vnoise(p / 4.0));
    return mix(hard, garden, smoothstep(0.42, 0.58, fbm(p / 8.0)));
  }
  if (k == 11) return vec3(0.42, 0.42, 0.43) * (0.85 + 0.25 * n);
  if (k == 12) { rough = 0.8; return vec3(0.33, 0.33, 0.34) * (0.9 + 0.2 * fine); }
  if (k == 13) { rough = 0.75; return vec3(0.27, 0.27, 0.28) * (0.9 + 0.2 * fine); }
  if (k == 14) return vec3(0.40, 0.35, 0.27) * (0.85 + 0.3 * n);
  if (k == 15) return vec3(0.30, 0.26, 0.23) * (0.85 + 0.3 * fine);
  if (k == 16) return vec3(0.52, 0.47, 0.37);
  if (k == 17) return mix(vec3(0.30, 0.32, 0.18), vec3(0.20, 0.28, 0.14), n) * (0.85 + 0.3 * fine);
  if (k == 18) {
    // Clear-fell: grey-brown brash, stumps and regrowth.
    surfBump = (fbm(p / 1.5) * 0.6 + vnoise(p / 0.5) * 0.2) * bumpFade;
    return mix(vec3(0.38, 0.32, 0.25), vec3(0.30, 0.30, 0.20), smoothstep(0.4, 0.7, n)) * (0.8 + 0.4 * fine);
  }
  if (k == 19) {
    surfBump = (fbm(p / 3.0) * 0.8 + vnoise(p / 0.8) * 0.15) * bumpFade;
    return mix(vec3(0.10, 0.19, 0.08), vec3(0.19, 0.29, 0.11), n * 0.7 + fine * 0.3);
  }
  if (k == 20) {
    // Tidal mud and sand flats at mid tide: damp, ripple-marked mud with pools and creek beds
    // holding water where the flats dip below the waterline. The edge is broken up with noise
    // because the mesh draws the flats as a few large, nearly level triangles: any shading
    // tied straight to their height or normal (a glossy sun glint, a sky mirror) lights whole
    // triangles at once and reads as hard-edged white patches. So the mud is matt and only the
    // pools are glossy enough to mirror the sky (scene.environment).
    float edge = vHeight + 0.35 * (fbm(p / 30.0) - 0.5) + 0.1 * (fine - 0.5);
    float pool = 1.0 - smoothstep(-0.12, 0.02, edge);
    float wet = 1.0 - smoothstep(0.0, 0.8, edge);
    vec3 bed = mix(vec3(0.36, 0.32, 0.26), vec3(0.50, 0.45, 0.35), smoothstep(0.3, 0.7, fbm(p / 70.0)));
    bed *= (0.85 + 0.25 * n) * mix(1.0, 0.88, wet);
    float ripple = sin(dot(p, vec2(0.9, 0.4)) * 2.2 + fbm(p / 5.0) * 6.0);
    float wind = vnoise(p / 1.5) * 0.04 + vnoise(p / 6.0 + 3.0) * 0.08;
    surfBump = mix(ripple * 0.015 + fbm(p / 2.0) * 0.05, wind, pool) * bumpFade;
    rough = mix(mix(0.85, 0.6, wet), 0.1, pool);
    // Turbid estuary water: brown-grey, lit mostly by the sky it reflects.
    return mix(bed, vec3(0.16, 0.15, 0.12), pool);
  }
  if (k == 21) {
    // Saltmarsh: tussocky green-brown sward.
    surfBump = fbm(p / 1.5) * 0.2 * bumpFade;
    return mix(vec3(0.30, 0.34, 0.18), vec3(0.42, 0.38, 0.26), smoothstep(0.35, 0.65, fbm(p / 25.0))) * (0.85 + 0.3 * fine);
  }
  // Sea bed / foreshore under the water plane.
  return mix(vec3(0.45, 0.42, 0.33), vec3(0.20, 0.25, 0.24), 1.0 - smoothstep(-3.0, -0.5, vHeight));
}

/**
 * Ground colour: the land-cover class picks the treatment. Farmland, parks, woodland floor,
 * moor, rock, sand and wetland take their colour from the Sentinel-2 image (the real field
 * pattern and crops) with procedural texture on top close up; built-up land, roads and
 * water stay procedural. The image fades out over the tile's last 600 m to match the
 * coarse terrain beyond.
 */
vec3 surfaceColour(vec2 p, out float rough) {
  // Warp the lookup so class edges are organic rather than texel steps.
  vec2 warp = vec2(vnoise(p / 7.0), vnoise(p / 7.0 + 13.7)) - 0.5;
  int k = coverClass(p + warp * coverTexel * 1.6);
  // Under ribbons the raster's roads would poke out in steps past the ribbon edges: draw
  // whatever lies beside the road there instead (housing in town, the verge in the country).
  if (roadRibbons > 0.5 && (k == 12 || k == 13 || k == 16)) {
    int side = 1;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.785398;
      int s = coverClass(p + vec2(cos(a), sin(a)) * 8.0);
      if (s != 12 && s != 13 && s != 16 && s != 15) { side = s; break; }
    }
    k = side;
  }
  vec3 c = proceduralColour(p, k, rough);
  // Not the flats: the summer image catches them at whatever state of tide.
  bool natural = (k >= 1 && k <= 8) || k == 14 || (k >= 17 && k != 20);
  if (useImagery < 0.5 || !natural) return c;
  vec2 edge = min(p, areaSize - p);
  float inside = smoothstep(0.0, 600.0, min(edge.x, edge.y));
  if (inside <= 0.0) return c;
  vec2 uv = p / imagerySize;
  vec3 sat = texture2D(imageryTex, uv).rgb;
  // Grade the image: haze makes it flat and grey, so stretch the contrast against a ~150 m
  // blur (to bring out field edges and crops) and warm it towards the palette elsewhere.
  vec3 blur = texture2D(imageryTex, uv, 4.0).rgb;
  sat = max(blur + (sat - blur) * 1.5, 0.0) * vec3(1.2, 1.34, 0.85);
  // Texture that the 10 m pixels cannot carry, stronger in woods and on moor.
  float amp = (k == 3 || k == 4 || k == 5 || k == 6) ? 1.6 : 1.0;
  float near = 1.0 - smoothstep(3.0, 14.0, length(fwidth(p)));
  float tex = 1.0 + amp * (0.24 * (fbm(p / 9.0) - 0.5) + 0.16 * (vnoise(p / 1.7) - 0.5))
            + near * 0.18 * (vnoise(p / 0.7) - 0.5);
  return mix(c, sat * tex, inside);
}
`;

/**
 * Bare rock on steep faces: sea cliffs, quarries and crags. The satellite image and the plan-view
 * textures smear down a near-vertical face, so steep ground gets its own rock, textured
 * triplanar so it never stretches: strata bands across the face, joints, yellow lichen above
 * the splash zone and a dark, wet, weedy foot. See docs/coastal-cliffs.md.
 */
const ROCK = /* glsl */ `
varying vec3 vObjNormal;

/** Face normal (true scale, y up) from screen-space derivatives of the local position. */
vec3 faceNormal() {
  vec3 pos = vec3(vLocal.x, vHeight, vLocal.y);
  vec3 n = normalize(cross(dFdx(pos), dFdy(pos)));
  return n.y < 0.0 ? -n : n;
}

/**
 * Share of rock from the true-scale slope: none below about 38 degrees, all above about 58.
 * Taken from the steeper of the face and the smoothed vertex normal, since on the adaptive mesh
 * a cliff can be a single strip of triangles whose vertex normals are averaged with the flat
 * ground above and below it.
 */
float rockWeight(vec2 p) {
  float up = min(normalize(vObjNormal).y, faceNormal().y);
  float w = 1.0 - smoothstep(0.53, 0.79, up);
  // Ragged edges, so grass reaches down gullies and rock breaks out along the lip.
  return clamp(w * 1.5 - 0.25 + 0.6 * (fbm(p / 6.0) - 0.5), 0.0, 1.0);
}

/** Cliff rock colour (sRGB) at pos (m, y up); sets bump (m) and rough. */
vec3 rockColour(vec3 pos, vec3 n, out float bump, out float rough) {
  vec3 w = abs(n);
  w /= w.x + w.y + w.z;
  float tri = vnoise(pos.zy / 2.5) * w.x + vnoise(pos.xz / 2.5) * w.y + vnoise(pos.xy / 2.5) * w.z;
  float fine = vnoise(pos.zy / 0.6) * w.x + vnoise(pos.xz / 0.6) * w.y + vnoise(pos.xy / 0.6) * w.z;
  // Strata: bands in height, warped and gently dipping across the coast.
  float layer = pos.y + fbm(pos.xz / 60.0) * 6.0 + dot(pos.xz, vec2(0.012, 0.007));
  float band = fbm(vec2(layer / 1.6, 0.37));
  float ledge = smoothstep(0.35, 0.65, fract(layer / 2.3 + 0.3 * tri));
  vec3 c = mix(vec3(0.53, 0.52, 0.49), vec3(0.57, 0.49, 0.39), smoothstep(0.3, 0.7, fbm(pos.xz / 150.0)));
  c = mix(c, vec3(0.30, 0.29, 0.28), 0.55 * band);
  c *= 0.78 + 0.38 * tri + 0.14 * (fine - 0.5);
  // Joints: dark vertical cracks.
  float joint = 1.0 - smoothstep(0.02, 0.07, abs(vnoise(vec2(dot(pos.xz, vec2(0.7, 0.7)) / 3.0, layer / 9.0)) - 0.5));
  c *= 1.0 - 0.35 * joint;
  // Yellow-orange lichen a few metres up, out of the spray.
  float lichen = smoothstep(2.0, 3.5, pos.y) * (1.0 - smoothstep(5.0, 10.0, pos.y)) * smoothstep(0.5, 0.75, fbm(pos.xz / 3.0 + pos.y));
  c = mix(c, vec3(0.62, 0.50, 0.22), 0.45 * lichen);
  // Wet, weedy foot up to the reach of the waves.
  float wet = 1.0 - smoothstep(0.3, 3.0, pos.y + 0.8 * (tri - 0.5));
  c = mix(c, vec3(0.16, 0.15, 0.10) * (0.8 + 0.4 * fine), wet * 0.8);
  rough = mix(0.9, 0.35, wet);
  bump = (band * 1.2 + ledge * 0.5 + tri * 0.5 + fine * 0.08 - joint * 0.3) * (1.0 - smoothstep(1.0, 6.0, length(fwidth(pos.xz))));
  return c;
}
`;

/**
 * Bump shading from surfBump (metres) by screen-space derivatives, as in Mikkelsen (2010),
 * "Bump Mapping Unparametrized Surfaces on the GPU". Tile meshes are in metres scaled to km.
 */
/**
 * Sky reflection on inland water: the material has no environment map, so a gradient sky
 * (horizon to zenith, linear, roughly matching the Sky shader after tone mapping) is added
 * by Schlick's Fresnel. Runs after the normal is final.
 */
/** Fragment colour, roughness and bump: the land-cover surface, with rock over steep faces. */
const SURFACE_WITH_ROCK = /* glsl */ `
float surfRough;
vec3 surf = surfaceColour(vLocal, surfRough);
float rockW = rockWeight(vLocal);
if (rockW > 0.0) {
  float rockBump, rockRough;
  vec3 rock = rockColour(vec3(vLocal.x, vHeight, vLocal.y), normalize(vObjNormal), rockBump, rockRough);
  surf = mix(surf, rock, rockW);
  surfRough = mix(surfRough, rockRough, rockW);
  surfBump = mix(surfBump, rockBump, rockW);
}
// Water mapped on sloping ground is a stream down a fold, not a lake: as a mirror it shows
// the bright horizon, and as dark water a black crack, across the hillside. Only level water
// stays water; elsewhere it is a damp, rushy strip.
if (surfRough < 0.2) {
  float level = smoothstep(0.985, 0.998, min(normalize(vObjNormal).y, faceNormal().y));
  surf = mix(vec3(0.20, 0.25, 0.13) * (0.85 + 0.3 * vnoise(vLocal / 1.5)), surf, level);
  surfRough = mix(0.9, surfRough, level);
}
diffuseColor.rgb = pow(surf, vec3(2.2));
`;

const BUMP = /* glsl */ `
// Rock faces light by their own face, not by normals averaged with the ground above and below.
if (rockW > 0.0) {
  vec3 face = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
  if (dot(face, normal) < 0.0) face = -face;
  normal = normalize(mix(normal, face, 0.8 * rockW));
}
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
  uniforms: { fieldSize: { value: number }; roadRibbons: { value: number } };
}

/** The area's satellite image as a texture, kept in sRGB values like the shader's colours. */
function imageryTexture(area: Area): THREE.Texture {
  if (!area.imagery) return new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const texture = new THREE.Texture(area.imagery);
  texture.flipY = false;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

/** The ground as the regular height grid, for areas built before the adaptive mesh. */
function gridGeometry(area: Area, geometry: THREE.BufferGeometry) {
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
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
}

export function createGround(area: Area): Ground {
  const { meta } = area;
  const geometry = new THREE.BufferGeometry();
  if (area.tin) {
    geometry.setAttribute('position', new THREE.BufferAttribute(area.tin.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(area.tin.indices, 1));
  } else {
    gridGeometry(area, geometry);
  }
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
    imageryTex: { value: imageryTexture(area) },
    imagerySize: {
      value: new THREE.Vector2(
        (meta.imagery?.width ?? 1) * (meta.imagery?.pixel ?? 1),
        (meta.imagery?.height ?? 1) * (meta.imagery?.pixel ?? 1),
      ),
    },
    useImagery: { value: area.imagery ? 1 : 0 },
    roadRibbons: { value: 0 },
  };

  const material = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vLocal;\nvarying float vHeight;\nvarying vec3 vObjNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position.xz;\nvHeight = position.y;\nvObjNormal = objectNormal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE}\n${FIELDS}\n${SURFACE}\n${ROCK}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${SURFACE_WITH_ROCK}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = surfRough;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${BUMP}`);
  };
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return { mesh, material, uniforms };
}

// Physically based sky and aerial perspective after Hillaire (2020), "A Scalable and Production Ready Sky and
// Atmosphere Rendering Technique": a transmittance LUT, a multiple-scattering LUT, a sky-view LUT per light (sun and
// moon) and a camera froxel volume of in-scattering and transmittance for everything the scene draws. Units are km.
// Radiance is physical, relative to the scene's sun illuminance, and multiplied by uPreExposure only where it is
// drawn, so moonlight (a few millionths of sunlight) keeps its precision. See docs/atmosphere.md.

import { BRIGHT_COUNT, STAR_GRID, STAR_MARGIN, STAR_TEXTURE_WIDTH } from './stars';

export const ATMOSPHERE_COMMON = /* glsl */ `
#ifndef PI
#define PI 3.14159265359
#endif
#define BOTTOM 6360.0
#define TOP 6460.0
#define AP_TOP 40.0

uniform sampler2D uTransmittanceLut;
uniform sampler2D uMultiScatteringLut;
uniform vec3 uRayleighScattering;
uniform float uRayleighScale;
uniform float uMieScattering;
uniform float uMieExtinction;
uniform float uMieScale;
uniform float uMieG;
uniform vec3 uOzoneAbsorption;
uniform vec3 uGroundAlbedo;
uniform float uHazeExtinction;
uniform float uHazeAlbedo;
uniform float uHazeScale;
uniform float uHazeBase;
// The cloud deck over the camera: direct light reaching the air below it, and the grey light from its base.
uniform float uCloudBase;
uniform float uCloudTop;
uniform float uUnderCloudLight;
uniform vec3 uCloudAmbient;

struct Medium {
  vec3 rayleigh;
  float mie;
  vec3 scattering;
  vec3 extinction;
};

Medium sampleMedium(float h) {
  float hp = max(h, 0.0);
  float r = exp(-hp / uRayleighScale);
  float m = exp(-hp / uMieScale);
  float z = exp(-max(h - uHazeBase, 0.0) / uHazeScale);
  float oz = max(0.0, 1.0 - abs(hp - 25.0) / 15.0);
  Medium s;
  s.rayleigh = uRayleighScattering * r;
  s.mie = uMieScattering * m + uHazeExtinction * uHazeAlbedo * z;
  s.scattering = s.rayleigh + s.mie;
  s.extinction = s.rayleigh + uMieExtinction * m + uHazeExtinction * z + uOzoneAbsorption * oz;
  return s;
}

float rayleighPhase(float c) {
  return 3.0 / (16.0 * PI) * (1.0 + c * c);
}

// Cornette-Shanks.
float miePhase(float g, float c) {
  float g2 = g * g;
  return 3.0 / (8.0 * PI) * (1.0 - g2) * (1.0 + c * c) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

// Both roots of a ray against a sphere at the origin, or (-1, -1) for a miss.
vec2 raySphere(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float d = b * b - c;
  if (d < 0.0) return vec2(-1.0);
  float s = sqrt(d);
  return vec2(-b - s, -b + s);
}

vec2 transmittanceUv(float r, float mu) {
  float H = sqrt((TOP - BOTTOM) * (TOP + BOTTOM));
  float rho = sqrt(max((r - BOTTOM) * (r + BOTTOM), 0.0));
  float disc = r * r * (mu * mu - 1.0) + TOP * TOP;
  float d = max(-r * mu + sqrt(max(disc, 0.0)), 0.0);
  float dMin = TOP - r;
  float dMax = rho + H;
  return vec2((d - dMin) / max(dMax - dMin, 1e-4), rho / H);
}

vec3 transmittanceToTop(float r, float mu) {
  return textureLod(uTransmittanceLut, transmittanceUv(r, mu), 0.0).rgb;
}

vec3 multiScattering(float h, float mu) {
  vec2 uv = clamp(vec2(mu * 0.5 + 0.5, h / (TOP - BOTTOM)), vec2(0.5 / 32.0), vec2(1.0 - 0.5 / 32.0));
  return textureLod(uMultiScatteringLut, uv, 0.0).rgb;
}

// 0 if the planet hides the light from a point at radius r whose local zenith cosine to the light is mu.
float planetShadow(float r, float mu) {
  float d = r * r * (mu * mu - 1.0) + BOTTOM * BOTTOM;
  return (mu < 0.0 && d >= 0.0) ? 0.0 : 1.0;
}
`;

/** Lights (sun, moon) and the in-scattering march shared by the sky-view and aerial perspective passes. */
const SCATTERING = /* glsl */ `
uniform vec3 uLightDir[2];
uniform vec3 uLightIlluminance[2];
uniform int uLightCount;
uniform int uAmbient;

vec3 inScattering(float r, float h, vec3 up, vec3 rd, Medium m) {
  float deck = smoothstep(uCloudBase, uCloudTop, h);
  float cloudLight = mix(uUnderCloudLight, 1.0, deck);
  vec3 S = vec3(0.0);
  for (int k = 0; k < 2; k++) {
    if (k >= uLightCount) break;
    vec3 l = uLightDir[k];
    float mu = dot(up, l);
    float c = dot(rd, l);
    vec3 single = transmittanceToTop(r, mu) * planetShadow(r, mu) *
      (m.rayleigh * rayleighPhase(c) + m.mie * miePhase(uMieG, c));
    S += uLightIlluminance[k] * cloudLight * (single + multiScattering(h, mu) * m.scattering);
  }
  if (uAmbient == 1) S += uCloudAmbient * (1.0 - deck) * m.scattering;
  return S;
}

// Marches from altitude camAlt (km) along rd for t in [t0, t1]. flatness 0 follows the planet's curve; 1 treats the
// ground as flat, as the map is, for views from far above where the curve would lift distant ground off the map.
void march(float camAlt, vec3 rd, float t0, float t1, int steps, float flatness, out vec3 L, out vec3 T) {
  L = vec3(0.0);
  T = vec3(1.0);
  float r0 = BOTTOM + camAlt;
  float prev = 0.0;
  for (int i = 0; i < 64; i++) {
    if (i >= steps) break;
    // Samples bunch up near the camera, where nearby haze changes fastest.
    float f = (float(i) + 1.0) / float(steps);
    float next = f * f;
    float dt = (next - prev) * (t1 - t0);
    float t = t0 + (prev + 0.5 * (next - prev)) * (t1 - t0);
    prev = next;
    vec3 pos = vec3(0.0, r0, 0.0) + rd * t;
    float r = length(pos);
    float h = mix(r - BOTTOM, camAlt + rd.y * t, flatness);
    vec3 up = normalize(mix(pos / r, vec3(0.0, 1.0, 0.0), flatness));
    r = BOTTOM + max(h, 0.0);
    Medium m = sampleMedium(h);
    vec3 stepT = exp(-m.extinction * dt);
    vec3 S = inScattering(r, h, up, rd, m);
    L += T * (S - S * stepT) / max(m.extinction, vec3(1e-7));
    T *= stepT;
  }
}
`;

export const fullscreenVertex = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const transmittanceFragment = /* glsl */ `
precision highp float;
${ATMOSPHERE_COMMON}
layout(location = 0) out highp vec4 outColor;
uniform vec2 uSize;

void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  float H = sqrt((TOP - BOTTOM) * (TOP + BOTTOM));
  float rho = H * uv.y;
  float r = sqrt(rho * rho + BOTTOM * BOTTOM);
  float dMin = TOP - r;
  float dMax = rho + H;
  float d = dMin + uv.x * (dMax - dMin);
  float mu = d == 0.0 ? 1.0 : clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
  vec3 depth = vec3(0.0);
  const int STEPS = 48;
  float prev = 0.0;
  for (int i = 0; i < STEPS; i++) {
    float f = (float(i) + 1.0) / float(STEPS);
    float next = f * f;
    float t = d * (prev + next) * 0.5;
    float h = sqrt(r * r + t * t + 2.0 * r * t * mu) - BOTTOM;
    depth += sampleMedium(h).extinction * d * (next - prev);
    prev = next;
  }
  outColor = vec4(exp(-depth), 1.0);
}
`;

// Hillaire's multiple scattering: the second order of scattering for an isotropic unit illuminance, integrated over
// the sphere of directions, then summed as a geometric series of higher orders.
export const multiScatteringFragment = /* glsl */ `
precision highp float;
${ATMOSPHERE_COMMON}
layout(location = 0) out highp vec4 outColor;

void main() {
  vec2 uv = gl_FragCoord.xy / 32.0;
  float muS = uv.x * 2.0 - 1.0;
  float h = max(uv.y * (TOP - BOTTOM), 0.005);
  vec3 P = vec3(0.0, BOTTOM + h, 0.0);
  vec3 sun = vec3(sqrt(max(1.0 - muS * muS, 0.0)), muS, 0.0);
  vec3 lum = vec3(0.0);
  vec3 fms = vec3(0.0);
  const int N = 8;
  const int STEPS = 20;
  for (int i = 0; i < N; i++) {
    for (int j = 0; j < N; j++) {
      float phi = 2.0 * PI * (float(i) + 0.5) / float(N);
      float cosTheta = 1.0 - 2.0 * (float(j) + 0.5) / float(N);
      float sinTheta = sqrt(max(1.0 - cosTheta * cosTheta, 0.0));
      vec3 rd = vec3(sinTheta * cos(phi), cosTheta, sinTheta * sin(phi));
      vec2 top = raySphere(P, rd, TOP);
      vec2 ground = raySphere(P, rd, BOTTOM);
      bool hitsGround = ground.x > 0.0;
      float tMax = hitsGround ? ground.x : top.y;
      float dt = tMax / float(STEPS);
      vec3 T = vec3(1.0);
      vec3 L = vec3(0.0);
      vec3 F = vec3(0.0);
      for (int s = 0; s < STEPS; s++) {
        vec3 pos = P + rd * (float(s) + 0.3) * dt;
        float r = length(pos);
        float hh = r - BOTTOM;
        float mu = dot(pos / r, sun);
        Medium m = sampleMedium(hh);
        vec3 stepT = exp(-m.extinction * dt);
        vec3 ext = max(m.extinction, vec3(1e-7));
        vec3 S = m.scattering * transmittanceToTop(r, mu) * planetShadow(r, mu) / (4.0 * PI);
        L += T * (S - S * stepT) / ext;
        F += T * (m.scattering - m.scattering * stepT) / ext;
        T *= stepT;
      }
      if (hitsGround) {
        vec3 pos = P + rd * tMax;
        float mu = dot(normalize(pos), sun);
        L += T * transmittanceToTop(BOTTOM, mu) * max(mu, 0.0) * uGroundAlbedo / PI;
      }
      lum += L;
      fms += F;
    }
  }
  lum /= float(N * N);
  fms /= float(N * N);
  outColor = vec4(lum / (1.0 - fms), 1.0);
}
`;

/** Maps a view direction to the sky-view LUT, which is symmetric about the light's vertical plane. */
export const SKY_VIEW_UV = /* glsl */ `
vec2 skyViewUv(float r, vec3 d, vec3 l) {
  float vHorizon = sqrt(max((r - BOTTOM) * (r + BOTTOM), 0.0));
  float beta = acos(clamp(vHorizon / r, -1.0, 1.0));
  float zenithHorizon = PI - beta;
  float vza = acos(clamp(d.y, -1.0, 1.0));
  float v;
  if (vza < zenithHorizon) {
    v = (1.0 - sqrt(max(1.0 - vza / zenithHorizon, 0.0))) * 0.5;
  } else {
    v = sqrt(clamp((vza - zenithHorizon) / max(beta, 1e-5), 0.0, 1.0)) * 0.5 + 0.5;
  }
  float dl = length(d.xz);
  float ll = length(l.xz);
  float cosLV = (dl < 1e-5 || ll < 1e-5) ? 1.0 : dot(d.xz / dl, l.xz / ll);
  return vec2(sqrt(clamp(0.5 - 0.5 * cosLV, 0.0, 1.0)), v);
}
`;

export const skyViewFragment = /* glsl */ `
precision highp float;
${ATMOSPHERE_COMMON}
${SCATTERING}
layout(location = 0) out highp vec4 outColor;
uniform vec2 uSize;
uniform float uCamAlt;

void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  float r = BOTTOM + max(uCamAlt, 0.002);
  float vHorizon = sqrt(max((r - BOTTOM) * (r + BOTTOM), 0.0));
  float beta = acos(clamp(vHorizon / r, -1.0, 1.0));
  float zenithHorizon = PI - beta;
  float vza;
  if (uv.y < 0.5) {
    float c = 1.0 - 2.0 * uv.y;
    vza = zenithHorizon * (1.0 - c * c);
  } else {
    float c = uv.y * 2.0 - 1.0;
    vza = zenithHorizon + beta * c * c;
  }
  float cosLV = 1.0 - 2.0 * uv.x * uv.x;
  float sinLV = sqrt(max(1.0 - cosLV * cosLV, 0.0));
  // In this local frame the light (the first, the LUT's own) sits in the x-y plane.
  vec3 l = uLightDir[0];
  float muL = l.y;
  vec3 lightLocal = vec3(sqrt(max(1.0 - muL * muL, 0.0)), muL, 0.0);
  vec3 rd = vec3(sin(vza) * cosLV, cos(vza), sin(vza) * sinLV);

  vec3 P = vec3(0.0, r, 0.0);
  vec2 top = raySphere(P, rd, TOP);
  vec2 ground = raySphere(P, rd, BOTTOM);
  vec3 L = vec3(0.0);
  if (top.y > 0.0) {
    float t0 = max(top.x, 0.0);
    bool hitsGround = ground.x > 0.0;
    float t1 = hitsGround ? ground.x : top.y;
    // The march uses world lights; rotate the ray into a frame where the first light has its world direction.
    float ll = length(l.xz);
    vec2 a = ll > 1e-5 ? l.xz / ll : vec2(1.0, 0.0);
    vec3 rdWorld = vec3(rd.x * a.x - rd.z * a.y, rd.y, rd.x * a.y + rd.z * a.x);
    vec3 T;
    march(r - BOTTOM, rdWorld, t0, t1, 40, 0.0, L, T);
    if (hitsGround) {
      vec3 pos = P + rd * t1;
      float mu = dot(normalize(pos), lightLocal);
      L += T * transmittanceToTop(BOTTOM, mu) * max(mu, 0.0) * uGroundAlbedo / PI * uLightIlluminance[0];
    }
  }
  outColor = vec4(L, 1.0);
}
`;

/** Froxels: 32 slices of 32x32, laid side by side in a 1024x32 atlas; slice k ends at maxDist ((k + 1) / 32)^2. */
export const aerialPerspectiveFragment = /* glsl */ `
precision highp float;
${ATMOSPHERE_COMMON}
${SCATTERING}
layout(location = 0) out highp vec4 outL;
layout(location = 1) out highp vec4 outT;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform float uCamAlt;
uniform float uMaxDist;
uniform float uFlatness;

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int slice = px.x / 32;
  vec2 suv = (vec2(float(px.x - slice * 32), float(px.y)) + 0.5) / 32.0;
  vec4 view = uInvProj * vec4(suv * 2.0 - 1.0, -1.0, 1.0);
  vec3 rd = normalize((uCamWorld * vec4(view.xyz / view.w, 0.0)).xyz);
  float s = (float(slice) + 1.0) / 32.0;
  float dist = uMaxDist * s * s;
  float alt = max(uCamAlt, 0.002);
  float t0 = 0.0;
  if (alt > AP_TOP) {
    // Above the air that matters: start where the ray comes down through AP_TOP.
    t0 = rd.y < -1e-4 ? (alt - AP_TOP) / -rd.y : dist;
  }
  vec3 L = vec3(0.0);
  vec3 T = vec3(1.0);
  if (t0 < dist) march(alt, rd, t0, dist, 24, uFlatness, L, T);
  outL = vec4(L, 1.0);
  outT = vec4(T, 1.0);
}
`;

/**
 * What the scene's composite and the clouds include to haze whatever lies at a distance along a screen pixel.
 * aerialPerspective returns physical radiance (no pre-exposure).
 */
export const AERIAL_PERSPECTIVE = /* glsl */ `
uniform sampler2D uApInScatter;
uniform sampler2D uApTransmittance;
uniform float uApMaxDist;
uniform float uApEnabled;
uniform float uPreExposure;
uniform float uCloudExposure;

void apFetch(vec2 uv, float slice, out vec3 L, out vec3 T) {
  vec2 inner = clamp(uv, vec2(0.5 / 32.0), vec2(1.0 - 0.5 / 32.0));
  vec2 st = vec2((slice + inner.x) / 32.0, inner.y);
  L = texture(uApInScatter, st).rgb;
  T = texture(uApTransmittance, st).rgb;
}

void aerialPerspective(vec2 uv, float dist, out vec3 L, out vec3 T) {
  L = vec3(0.0);
  T = vec3(1.0);
  if (uApEnabled < 0.5) return;
  float c = sqrt(max(dist, 0.0) / uApMaxDist) * 32.0 - 1.0;
  if (c < 0.0) {
    vec3 L0, T0;
    apFetch(uv, 0.0, L0, T0);
    float f = c + 1.0;
    L = L0 * f;
    T = mix(vec3(1.0), T0, f);
  } else {
    c = min(c, 31.0);
    float k0 = floor(c);
    float k1 = min(k0 + 1.0, 31.0);
    vec3 La, Ta, Lb, Tb;
    apFetch(uv, k0, La, Ta);
    apFetch(uv, k1, Lb, Tb);
    L = mix(La, Lb, c - k0);
    T = mix(Ta, Tb, c - k0);
  }
}

vec3 applyAerialPerspective(vec3 color, vec2 uv, float dist) {
  vec3 L, T;
  aerialPerspective(uv, dist, L, T);
  return color * T + L * uPreExposure;
}
`;

export const skyVertex = /* glsl */ `
out vec3 vDir;
void main() {
  vDir = position;
  // Rotation only, at the far plane: the sky is infinitely far away and follows the camera.
  vec4 clip = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = clip.xyww;
  gl_Position.z = gl_Position.w * 0.99999;
}
`;

/**
 * The sky dome: the sun's and moon's sky-view LUTs, the sun's disc with limb darkening, the moon with its phase and
 * maria, and the stars and Milky Way turning with sidereal time, all seen through the air's transmittance.
 */
export const skyFragment = /* glsl */ `
precision highp float;
#define STAR_GRID ${STAR_GRID}
#define STAR_TEXTURE_WIDTH ${STAR_TEXTURE_WIDTH}
#define STAR_MARGIN ${STAR_MARGIN.toFixed(6)}
#define BRIGHT_COUNT ${BRIGHT_COUNT}
// Pre-exposed radiance past which a bright star's image grows instead of getting brighter.
#define BRIGHT_PEAK 2.0
${ATMOSPHERE_COMMON}
${SKY_VIEW_UV}
layout(location = 0) out highp vec4 outColor;
in vec3 vDir;
uniform sampler2D uSkyViewSun;
uniform sampler2D uSkyViewMoon;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunIlluminance;
uniform float uMoonRadius;
uniform float uCamAlt;
uniform float uPreExposure;
uniform float uDiscs;
uniform float uEnvCloudCover;
uniform vec3 uEnvCloudRadiance;
uniform mat3 uEquatorialToWorld;
uniform mat3 uJ2000ToWorld;
uniform float uTime;
uniform highp sampler2D uStarCells;
uniform highp sampler2D uStarDir;
uniform highp sampler2D uStarColour;
uniform float uStarsReady;
uniform vec4 uBrightDir[BRIGHT_COUNT];
uniform vec4 uBrightLight[BRIGHT_COUNT];
uniform vec3 uNightGlow;
uniform sampler2D uMoonMap;
uniform float uMoonMapReady;

#define SUN_RADIUS 0.004654
// Pre-exposed radiance the full moon is held to at night (ACES at the app's exposure turns it a bright grey-white).
#define MOON_WHITE 1.2

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}
float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * noise2(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return s;
}

// The real stars, from the Hipparcos catalogue (see stars.ts): the pixel's cell of a cube-map grid in J2000
// equatorial coordinates lists every star close enough to light it. Each star is a pixel-sized Gaussian carrying
// its illuminance, so its brightness against the sky, the moon and the town glow is physical; it twinkles more the
// more air it shines through.
float starSeed(vec3 dir) {
  return fract(sin(dot(dir, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}
vec3 twinkle(vec3 dir, float amount, float scint) {
  float s = starSeed(dir);
  float t = uTime * (5.0 + 9.0 * s) + 40.0 * s;
  float w = 0.6 * sin(t) + 0.4 * sin(t * 2.37 + 3.1 * s);
  // Low down, the air splits the colours and each flickers on its own.
  vec3 chroma = vec3(sin(t * 1.9 + 1.0), sin(t * 2.3 + 2.0), sin(t * 2.9 + 3.0));
  return max(vec3(1.0) + amount * scint * (vec3(w) + chroma * 0.6 * smoothstep(0.25, 0.6, scint)), 0.0);
}
vec3 stars(vec3 eq, float pixelAngle, float scint) {
  if (uStarsReady < 0.5) return vec3(0.0);
  vec3 a = abs(eq);
  vec2 face;
  float faceId;
  if (a.x >= a.y && a.x >= a.z) { face = eq.yz / a.x; faceId = eq.x > 0.0 ? 0.0 : 1.0; }
  else if (a.y >= a.z) { face = eq.xz / a.y; faceId = eq.y > 0.0 ? 2.0 : 3.0; }
  else { face = eq.xy / a.z; faceId = eq.z > 0.0 ? 4.0 : 5.0; }
  ivec2 cell = clamp(ivec2((face * 0.5 + 0.5) * float(STAR_GRID)), ivec2(0), ivec2(STAR_GRID - 1));
  vec2 entry = texelFetch(uStarCells, ivec2(cell.x, int(faceId) * STAR_GRID + cell.y), 0).rg;
  int first = int(entry.x);
  int count = int(entry.y);
  float sigma = clamp(pixelAngle * 0.7, 1e-6, STAR_MARGIN * 0.25);
  float norm = 1.0 / (2.0 * PI * sigma * sigma);
  vec3 sum = vec3(0.0);
  for (int k = 0; k < 256; k++) {
    if (k >= count) break;
    int i = first + k;
    ivec2 at = ivec2(i % STAR_TEXTURE_WIDTH, i / STAR_TEXTURE_WIDTH);
    vec4 star = texelFetch(uStarDir, at, 0);
    // The chord, not the angle from a dot product: float precision runs out for arcsecond separations.
    vec3 off = eq - star.xyz;
    float d2 = dot(off, off);
    if (d2 > 16.0 * sigma * sigma) continue;
    vec3 colour = texelFetch(uStarColour, at, 0).rgb;
    sum += colour * star.w * norm * exp(-0.5 * d2 / (sigma * sigma)) * twinkle(star.xyz, 1.0, scint);
  }
  // The planets and the brightest stars, drawn here rather than from the grid so that they can grow: a display
  // cannot show a point as bright as Sirius, so once a point would be past white its light spreads over a larger
  // disc (as planetarium software does), with a soft glare round it as the eye sees.
  float exposure = uPreExposure * uSunIlluminance.y;
  for (int k = 0; k < BRIGHT_COUNT; k++) {
    vec4 dir = uBrightDir[k];
    vec3 off = eq - dir.xyz;
    float d2 = dot(off, off);
    vec4 light = uBrightLight[k];
    float peak = dot(light.rgb, vec3(0.2126, 0.7152, 0.0722)) * norm * exposure;
    float s = sigma * min(pow(max(peak / BRIGHT_PEAK, 1.0), 1.0 / 3.0), 6.0);
    float gs = 3.0 * s;
    if (d2 > 16.0 * gs * gs) continue;
    float point = 0.94 * exp(-0.5 * d2 / (s * s)) / (2.0 * PI * s * s);
    float glare = 0.06 * exp(-0.5 * d2 / (gs * gs)) / (2.0 * PI * gs * gs);
    sum += light.rgb * twinkle(dir.xyz, light.w, scint) * (point + glare);
  }
  return sum;
}

// Atmospheric refraction lifts what is near the horizon by up to half a degree (Bennett 1982): given the direction
// a pixel looks along, the true direction its light came from.
vec3 unrefract(vec3 d) {
  float h = degrees(asin(clamp(d.y, -1.0, 1.0)));
  if (h > 89.0 || h < -2.0) return d;
  float hc = max(h, -1.0);
  float r = 1.0 / tan(radians(hc + 7.31 / (hc + 4.4))) / 60.0;
  float alt = radians(h - r);
  vec2 hz = normalize(d.xz);
  return vec3(hz.x * cos(alt), sin(alt), hz.y * cos(alt));
}

// The Milky Way: a band about the galactic equator, brightest towards the centre in Sagittarius.
float milkyWay(vec3 eq) {
  const vec3 NGP = vec3(-0.8676, -0.1981, 0.4560);
  const vec3 CENTRE = vec3(-0.0549, -0.8734, -0.4838);
  float b = asin(clamp(dot(eq, NGP), -1.0, 1.0));
  float l = dot(eq, CENTRE);
  vec3 side = cross(NGP, CENTRE);
  vec2 gp = vec2(atan(dot(eq, side), l), b);
  float band = exp(-b * b / (0.18 * 0.18)) * (0.55 + 0.45 * l);
  float dust = smoothstep(0.35, 0.75, fbm(gp * vec2(6.0, 14.0)));
  float rift = 1.0 - 0.7 * exp(-b * b / (0.03 * 0.03)) * smoothstep(-0.2, 0.6, l);
  return band * mix(0.6, 1.2, dust) * rift;
}

// Albedo of the moon's near side in disc coordinates (x to the right of the disc as seen with celestial north up,
// y up, radius 1): the main maria as soft patches, highlands brighter, Tycho's bright ray crater to the south.
float moonAlbedo(vec2 q) {
  if (uMoonMapReady > 0.5) {
    // The near side from the map: selenographic longitude 0 at the map's centre, east to the right.
    float z = sqrt(max(1.0 - dot(q, q), 0.0));
    vec2 uv = vec2(0.5 + atan(q.x, z) / (2.0 * PI), 0.5 + asin(clamp(q.y, -1.0, 1.0)) / PI);
    float lum = dot(texture(uMoonMap, uv).rgb, vec3(0.2126, 0.7152, 0.0722));
    // The map is a shaded relief with more contrast than the moon (maria 0.07, highlands 0.16): soften it a little.
    return 0.12 * pow(lum / 0.27, 0.75);
  }
  float m = 0.0;
  m += smoothstep(0.32, 0.12, length(q - vec2(-0.28, 0.42)));  // Imbrium
  m += smoothstep(0.2, 0.06, length(q - vec2(0.23, 0.4)));     // Serenitatis
  m += smoothstep(0.24, 0.08, length(q - vec2(0.4, 0.13)));    // Tranquillitatis
  m += smoothstep(0.13, 0.04, length(q - vec2(0.74, 0.3)));    // Crisium
  m += smoothstep(0.17, 0.05, length(q - vec2(0.62, -0.16)));  // Fecunditatis
  m += smoothstep(0.11, 0.03, length(q - vec2(0.38, -0.32)));  // Nectaris
  m += smoothstep(0.45, 0.15, length((q - vec2(-0.62, 0.05)) * vec2(1.0, 0.7)));  // Procellarum
  m += smoothstep(0.19, 0.05, length(q - vec2(-0.15, -0.35))); // Nubium
  m += smoothstep(0.11, 0.03, length(q - vec2(-0.47, -0.42))); // Humorum
  m += smoothstep(0.1, 0.02, abs(q.y - 0.74 - 0.05 * q.x)) * smoothstep(0.8, 0.3, abs(q.x)); // Frigoris
  m = clamp(m, 0.0, 1.0) * (0.75 + 0.5 * fbm(q * 6.0));
  float albedo = mix(0.16, 0.075, clamp(m, 0.0, 1.0)) * (0.85 + 0.3 * fbm(q * 23.0 + 5.0));
  vec2 tycho = q - vec2(-0.13, -0.72);
  float rays = pow(max(cos(atan(tycho.y, tycho.x) * 9.0 + fbm(q * 9.0) * 3.0), 0.0), 6.0) * exp(-length(tycho) * 3.0);
  albedo += 0.08 * exp(-dot(tycho, tycho) / 0.0015) + 0.03 * rays;
  return albedo;
}

void main() {
  vec3 d = normalize(vDir);
  float r = BOTTOM + max(uCamAlt, 0.002);
  vec3 L = texture(uSkyViewSun, skyViewUv(r, d, uSunDir)).rgb + texture(uSkyViewMoon, skyViewUv(r, d, uMoonDir)).rgb;

  // Transmittance from the camera to space along the view, zero into the ground.
  float mu = d.y;
  vec3 T = transmittanceToTop(r, mu) * planetShadow(r, mu);

  if (uDiscs > 0.5) {
    float pixelAngle = length(fwidth(d));
    // The stars and the Milky Way, where they truly are: through refraction, then precession back to J2000.
    vec3 eq = transpose(uJ2000ToWorld) * unrefract(d);
    // Night sky: stars, planets, the Milky Way and a faint airglow (plus town glow, the UK being what it is).
    vec3 glow = uNightGlow * (1.0 + 2.0 * pow(1.0 - max(d.y, 0.0), 4.0));
    // Scintillation grows with the air the light comes through: faint overhead, strong near the horizon.
    float airmass = 1.0 / max(d.y + 0.025, 0.03);
    float scint = clamp(0.08 * pow(airmass, 1.1), 0.0, 0.7);
    vec3 night = stars(eq, pixelAngle, scint) * uSunIlluminance;
    night += uSunIlluminance * 2.2e-9 * milkyWay(eq) * vec3(0.9, 0.93, 1.0);
    vec3 behind = night;

    // The moon, hiding what is behind it.
    float cm = dot(d, uMoonDir);
    float am = acos(clamp(cm, -1.0, 1.0));
    if (am < uMoonRadius * 1.02) {
      vec3 north = normalize(uEquatorialToWorld * vec3(0.0, 0.0, 1.0) - uMoonDir * dot(uEquatorialToWorld * vec3(0.0, 0.0, 1.0), uMoonDir));
      vec3 right = cross(north, -uMoonDir);
      vec3 off = (d - uMoonDir * cm) / sin(uMoonRadius);
      vec2 q = vec2(dot(off, right), dot(off, north));
      float q2 = dot(q, q);
      float edge = 1.0 - smoothstep(1.0 - 2.0 * pixelAngle / uMoonRadius, 1.0, sqrt(q2));
      vec3 n = normalize(off + -uMoonDir * sqrt(max(1.0 - q2, 0.0)));
      float mu0 = max(dot(n, uSunDir), 0.0);
      float mue = max(dot(n, -uMoonDir), 1e-3);
      // Lommel-Seeliger: the full moon looks flat, with no limb darkening.
      float ls = 2.0 * mu0 / (mu0 + mue);
      float earthshine = 3e-4 * (1.0 + dot(uSunDir, -uMoonDir));
      vec3 moon = uSunIlluminance * moonAlbedo(q) * (ls + earthshine) / PI * vec3(1.0, 0.97, 0.92);
      // Night-adapted, the moon would clip to a white disc; the eye still sees its markings, so hold the full moon
      // just under white. By day this does nothing.
      float fullMoon = uSunIlluminance.y * 0.12 / PI;
      moon *= min(1.0, MOON_WHITE / max(uPreExposure * fullMoon, 1e-20));
      behind = mix(behind, moon, edge);
    }

    // The sun, with limb darkening.
    float cs = dot(d, uSunDir);
    float as_ = acos(clamp(cs, -1.0, 1.0));
    if (as_ < SUN_RADIUS * 1.05) {
      float x = clamp(as_ / SUN_RADIUS, 0.0, 1.0);
      float muLimb = sqrt(1.0 - x * x);
      vec3 limb = vec3(1.0) - vec3(0.4, 0.55, 0.7) * (1.0 - pow(vec3(muLimb), vec3(0.6, 0.7, 0.8)));
      float edge = 1.0 - smoothstep(1.0 - pixelAngle / SUN_RADIUS, 1.0 + pixelAngle / SUN_RADIUS, as_ / SUN_RADIUS);
      // Physically about 15000x the illuminance per steradian; capped so it cannot glare through thick cloud.
      vec3 sun = uSunIlluminance * limb / (PI * SUN_RADIUS * SUN_RADIUS);
      behind = mix(behind, min(sun, uSunIlluminance * 3000.0), edge);
    }
    // Airglow and town glow are in the air, in front of the moon.
    L += (behind + glow) * T;
  } else {
    L += uNightGlow * 1.5;
  }

  // Environment lighting under cloud: the sky above the horizon turns into the cloud base.
  if (uEnvCloudCover > 0.0) L = mix(L, uEnvCloudRadiance, uEnvCloudCover * smoothstep(-0.1, 0.2, d.y));
  outColor = vec4(L * uPreExposure, 1.0);
}
`;

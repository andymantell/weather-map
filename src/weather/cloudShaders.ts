// Volumetric UKV clouds over the map. World units are km: x = LAEA easting, z = -northing, y = height times the
// terrain exaggeration. Cloud heights are above ground, so each column sits on the (exaggerated) terrain and is
// stretched by its own vertical scale. Same lighting model as the cloud lab (src/clouds/cloudShader.ts); see
// docs/ukv-clouds.md.

export const fullscreenVertexShader = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const ukvCloudFragmentShader = /* glsl */ `
precision highp float;
precision highp sampler3D;

#define PI 3.14159265359

layout(location = 0) out highp vec4 outCloud;
layout(location = 1) out highp vec4 outShadow;
in vec2 vUv;

uniform sampler3D uVolume;   // cloud fraction on uniform AGL slices
uniform sampler2D uFields;   // r: rain, g: cloud base, b: high cloud, a: CAPE
uniform sampler2D uTerrain;  // ground height, km
uniform sampler2D uDepth;    // scene depth (logarithmic depth buffer)
uniform sampler3D uShape;
uniform sampler3D uDetail;

uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform vec3 uCamForward;
uniform float uFar;
uniform float uFrame;
uniform vec2 uTexel;        // one cloud-target pixel in uv
uniform int uSteps;

uniform vec2 uGridWest;      // x of the first cell centre, y of the first row's centre (LAEA m)
uniform vec2 uGridSize;      // cells
uniform float uGridDx;       // m
uniform float uVolumeTop;    // km AGL
uniform vec4 uTerrainBox;    // xMin, xMax, yMin, yMax of the terrain samples (LAEA m)
uniform vec2 uTerrainSize;   // samples

uniform float uExaggeration;
uniform float uCloudScale;
uniform float uDensity;
uniform float uYTop;
uniform float uRainShafts;  // 1 draws the old Shipley rain shafts; 0 leaves rain to src/weather/rain

uniform vec3 uSunDir;
uniform vec3 uSunRadiance;
uniform vec3 uAmbientTop;
uniform vec3 uAmbientBottom;
uniform vec3 uFogColor;
uniform vec2 uFogRange;

float remap(float v, float a, float b, float c, float d) {
  return c + (v - a) / max(b - a, 1e-4) * (d - c);
}

float hg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

float phase(float c, float k) {
  return mix(hg(c, 0.8 * k), hg(c, -0.25 * k), 0.25);
}

vec2 toLaea(vec3 p) {
  return vec2(p.x, -p.z) * 1000.0;
}

// Texture coordinates of the UKV grid, row 0 north; outside the grid when not in [0, 1].
vec2 gridUv(vec2 laea) {
  return vec2((laea.x - uGridWest.x) / uGridDx + 0.5, (uGridWest.y - laea.y) / uGridDx + 0.5) / uGridSize;
}

float groundKm(vec2 laea) {
  vec2 uv = vec2((laea.x - uTerrainBox.x) / (uTerrainBox.y - uTerrainBox.x),
                 (uTerrainBox.w - laea.y) / (uTerrainBox.w - uTerrainBox.z));
  uv = (uv * (uTerrainSize - 1.0) + 0.5) / uTerrainSize;
  return max(texture(uTerrain, uv).r, 0.0);
}

struct Sample {
  float cloud;   // extinction of cloud, per km
  float rain;    // rain rate, mm/h
  float hFrac;   // height through the cloud column, for ambient light
};

// lod: 0 near, 1 far. Far away the noise is finer than a pixel and only sparkles, so it fades out.
Sample sampleAt(vec3 p, bool cheap, float lod) {
  Sample s = Sample(0.0, 0.0, 0.5);
  vec2 laea = toLaea(p);
  vec2 uv = gridUv(laea);
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return s;
  float ground = groundKm(laea) * uExaggeration;
  float h = (p.y - ground) / uCloudScale;  // km above ground, physical
  if (h < 0.0) return s;
  vec4 f2 = texture(uFields, uv);

  float coverage = 0.0;
  float sigma = uDensity;
  if (h < uVolumeTop) {
    coverage = texture(uVolume, vec3(uv, h / uVolumeTop)).r;
    // Thin the cloud just below its top so the noise breaks a flat deck into billows.
    float above = texture(uVolume, vec3(uv, (h + 0.5) / uVolumeTop)).r;
    coverage *= mix(0.6, 1.0, above);
    s.hFrac = h / uVolumeTop;
  } else if (h > 7.5 && h < 10.5) {
    // High cloud above the 3D data: a thin cirrus sheet from the high-cloud fraction.
    coverage = f2.b * smoothstep(7.5, 8.3, h) * (1.0 - smoothstep(9.6, 10.5, h));
    sigma = 0.06;
    s.hFrac = 1.0;
  }

  float base = f2.g > 0.999 ? 1.0 : f2.g * 8.0;
  float rain = 64.0 * f2.r * f2.r;
  // Convective columns (high CAPE) billow; layered cloud is flatter and smoother.
  float convective = smoothstep(0.15, 0.6, f2.a);
  if (uRainShafts > 0.0 && rain > 0.1 && h < base) {
    // Rain falls only from where the noise left cloud at the base, so shafts hang under clouds instead of
    // filling the whole 2 km grid cell as a smooth column. A 0.6 coverage floor keeps light drizzle patches.
    float hb = min(base + 0.15, uVolumeTop - 0.01);
    float cov = max(texture(uVolume, vec3(uv, hb / uVolumeTop)).r, 0.6);
    vec4 nb = texture(uShape, vec3(p.x, hb * mix(2.2, 1.0, convective), p.z) / 9.0);
    float shapeB = remap(nb.r, nb.g * 0.625 + nb.b * 0.25 + nb.a * 0.125 - 1.0, 1.0, 0.0, 1.0);
    float underCloud = smoothstep(0.0, 0.25, remap(shapeB, 1.0 - cov, 1.0, 0.0, 1.0));
    vec3 sp = vec3(p.x / 1.2, h / 7.0, p.z / 1.2);
    s.rain = rain * underCloud * (0.4 + texture(uDetail, sp).r) * smoothstep(0.0, 0.3, base - h + 0.15);
  }
  // Fade out towards the edge of the baked grid instead of stopping at a straight line.
  vec2 edge = min(uv, 1.0 - uv);
  coverage *= smoothstep(0.0, 0.03, min(edge.x, edge.y));
  if (coverage < 0.02) return s;

  vec3 q = vec3(p.x, h * mix(2.2, 1.0, convective), p.z);
  vec4 n = texture(uShape, q / 9.0);
  float fbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  float shape = remap(n.r, fbm - 1.0, 1.0, 0.0, 1.0);
  float d = clamp(remap(shape, 1.0 - coverage, 1.0, 0.0, 1.0), 0.0, 1.0) * coverage;
  d = mix(d, coverage * 0.6, lod * 0.8);
  if (!cheap && d > 0.0 && lod < 0.98) {
    vec3 dn = texture(uDetail, q / 1.4 + n.gba * 0.3).rgb;
    float dfbm = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    float erosion = mix(0.25, 0.45, convective) * (1.0 - lod);
    d = clamp(remap(d, dfbm * erosion, 1.0, 0.0, 1.0), 0.0, 1.0);
  }
  s.cloud = d * sigma;
  return s;
}

float sunOpticalDepth(vec3 p, int steps, float firstStep) {
  float od = 0.0;
  float s = firstStep;
  vec3 pos = p;
  for (int i = 0; i < 8; i++) {
    if (i >= steps) break;
    pos += uSunDir * s * 0.5;
    od += sampleAt(pos, true, 1.0).cloud * s;
    pos += uSunDir * s * 0.5;
    s *= 1.7;
  }
  return od;
}

vec2 slab(vec3 ro, vec3 rd, float y0, float y1) {
  if (abs(rd.y) < 1e-6) return (ro.y >= y0 && ro.y <= y1) ? vec2(0.0, 1e6) : vec2(1.0, 0.0);
  float a = (y0 - ro.y) / rd.y;
  float b = (y1 - ro.y) / rd.y;
  return vec2(max(min(a, b), 0.0), max(a, b));
}

float ign(vec2 px) {
  return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
}

void main() {
  // Sub-pixel jitter (R2 sequence) so accumulated frames also antialias.
  vec2 sub = fract(vec2(0.7548776662, 0.5698402910) * uFrame) - 0.5;
  vec4 view = uInvProj * vec4((vUv + sub * uTexel) * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize((uCamWorld * vec4(view.xyz / view.w, 0.0)).xyz);
  vec3 ro = uCamPos;

  // Logarithmic depth buffer: depth = log2(1 + w) / log2(far + 1), w = view-space distance along the axis.
  float depth = texture(uDepth, vUv).r;
  float w = pow(uFar + 1.0, depth) - 1.0;
  bool hitScene = w < 10000.0;
  float tScene = hitScene ? w / max(dot(rd, uCamForward), 1e-4) : 1e9;

  float jitter = fract(ign(gl_FragCoord.xy) + uFrame * 0.618034);
  float cosTheta = dot(rd, uSunDir);

  vec2 range = slab(ro, rd, 0.0, uYTop);
  range.y = min(range.y, tScene);
  vec3 radiance = vec3(0.0);
  float T = 1.0;
  float depthSum = 0.0;
  float weightSum = 0.0;

  if (range.y > range.x) {
    float dt = max((range.y - range.x) / float(uSteps), 0.08);
    float t = range.x + dt * jitter;
    for (int i = 0; i < 1024; i++) {
      if (i >= uSteps || t > range.y || T < 0.01) break;
      vec3 p = ro + rd * t;
      Sample s = sampleAt(p, false, smoothstep(60.0, 450.0, t));
      float sigmaRain = s.rain > 0.0 ? 0.16 * pow(s.rain, 0.74) : 0.0;
      float sigmaT = s.cloud + sigmaRain;
      if (sigmaT > 1e-4) {
        vec3 S = vec3(0.0);
        if (s.cloud > 0.0) {
          float od = sunOpticalDepth(p, 5, 0.25);
          float sunTerm = 0.0;
          float a = 1.0;
          float b = 1.0;
          float g = 1.0;
          for (int k = 0; k < 4; k++) {
            sunTerm += a * exp(-od * b) * phase(cosTheta, g);
            a *= 0.55;
            b *= 0.25;
            g *= 0.5;
          }
          float powder = 1.0 - exp(-s.cloud * 0.25);
          sunTerm *= mix(1.0, powder, 0.5 * (1.0 - cosTheta));
          S += s.cloud * (uSunRadiance * sunTerm + mix(uAmbientBottom, uAmbientTop, s.hFrac) * 0.9);
        }
        if (sigmaRain > 0.0) {
          float od = sunOpticalDepth(p, 6, 0.5);
          S += sigmaRain * 0.7 * (uSunRadiance * exp(-od) * phase(cosTheta, 0.5) + uAmbientBottom * 0.6);
        }
        float stepT = exp(-sigmaT * dt);
        radiance += T * (S - S * stepT) / sigmaT;
        float absorbed = T * (1.0 - stepT);
        depthSum += absorbed * t;
        weightSum += absorbed;
        T *= stepT;
      }
      t += dt;
    }
  }

  // Match the scene's linear fog at the cloud's transmittance-weighted mean distance.
  if (weightSum > 0.0) {
    float fog = clamp((depthSum / weightSum - uFogRange.x) / (uFogRange.y - uFogRange.x), 0.0, 1.0);
    radiance = mix(radiance, uFogColor * (1.0 - T), fog);
  }

  // Cloud shadow on whatever the scene drew at this pixel.
  float shadow = 1.0;
  if (hitScene) {
    vec3 p = ro + rd * tScene;
    float toTop = max(uYTop - p.y, 0.0) / max(uSunDir.y, 0.1);
    float od = 0.0;
    float s = toTop / 10.0;
    vec3 pos = p + uSunDir * s * jitter;
    for (int i = 0; i < 10; i++) {
      od += sampleAt(pos, true, 1.0).cloud * s;
      pos += uSunDir * s;
    }
    shadow = exp(-od);
  }

  // Distance used to reproject this pixel next frame: where the cloud is, else the ground, else far away.
  float reprojectT = weightSum > 1e-3 ? depthSum / weightSum : min(tScene, 5000.0);

  outCloud = vec4(radiance, 1.0 - T);
  outShadow = vec4(shadow, reprojectT, 0.0, 1.0);
}
`;

// Temporal accumulation with reprojection. Each pixel's history is fetched from where its cloud (or, for the
// shadow, its ground) was on screen last frame, clipped to the spread of this frame's neighbourhood so stale history
// cannot ghost far, and blended by the number of frames the pixel has been tracked. Channels of the second target:
// r shadow, g reprojection distance, b history length.
export const accumulateFragmentShader = /* glsl */ `
precision highp float;
layout(location = 0) out highp vec4 outCloud;
layout(location = 1) out highp vec4 outShadow;
in vec2 vUv;
uniform sampler2D uCloud;
uniform sampler2D uShadow;
uniform sampler2D uHistoryCloud;
uniform sampler2D uHistoryShadow;
uniform sampler2D uDepth;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform vec3 uCamForward;
uniform float uFar;
uniform mat4 uPrevViewProj;
uniform vec3 uPrevCamPos;
uniform vec2 uTexel;
uniform bool uMoving;
uniform bool uReset;
uniform float uMaxHistory;

vec2 reproject(vec3 p, out bool valid) {
  vec4 clip = uPrevViewProj * vec4(p, 1.0);
  vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
  valid = clip.w > 0.0 && all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
  return uv;
}

// Catmull-Rom history fetch in five bilinear taps (Jimenez's filmic SMAA approximation), so repeated reprojection
// does not blur the clouds the way plain bilinear resampling does.
vec4 sampleSharp(sampler2D tex, vec2 uv) {
  vec2 size = 1.0 / uTexel;
  vec2 pos = uv * size;
  vec2 c = floor(pos - 0.5) + 0.5;
  vec2 f = pos - c;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 tc0 = (c - 1.0) * uTexel;
  vec2 tc3 = (c + 2.0) * uTexel;
  vec2 tc12 = (c + w2 / w12) * uTexel;
  vec4 r = texture(tex, vec2(tc12.x, tc0.y)) * (w12.x * w0.y)
         + texture(tex, vec2(tc0.x, tc12.y)) * (w0.x * w12.y)
         + texture(tex, tc12) * (w12.x * w12.y)
         + texture(tex, vec2(tc3.x, tc12.y)) * (w3.x * w12.y)
         + texture(tex, vec2(tc12.x, tc3.y)) * (w12.x * w3.y);
  return r / (w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y);
}

void main() {
  vec4 cloud = texture(uCloud, vUv);
  vec4 shadow = texture(uShadow, vUv);
  if (uReset) {
    outCloud = cloud;
    outShadow = vec4(shadow.rg, 1.0, 1.0);
    return;
  }

  vec2 cloudUv = vUv;
  vec2 shadowUv = vUv;
  bool cloudValid = true;
  bool shadowValid = true;
  if (uMoving) {
    vec4 view = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 rd = normalize((uCamWorld * vec4(view.xyz / view.w, 0.0)).xyz);
    vec3 p = uCamPos + rd * shadow.g;
    cloudUv = reproject(p, cloudValid);
    // Reject history that was at a very different distance (a cloud edge or hill moved across the pixel).
    float expected = distance(p, uPrevCamPos);
    cloudValid = cloudValid && abs(texture(uHistoryShadow, cloudUv).g - expected) < 0.25 * expected + 0.2;
    float w = pow(uFar + 1.0, texture(uDepth, vUv).r) - 1.0;
    float tScene = w < 10000.0 ? w / max(dot(rd, uCamForward), 1e-4) : shadow.g;
    shadowUv = reproject(uCamPos + rd * tScene, shadowValid);
  }

  vec4 histCloud = uMoving ? sampleSharp(uHistoryCloud, cloudUv) : texture(uHistoryCloud, cloudUv);
  vec4 histShadow = texture(uHistoryShadow, shadowUv);

  if (uMoving) {
    // Variance clipping against the 3x3 neighbourhood of this frame's (noisy, single sample) result.
    vec4 m1 = vec4(0.0);
    vec4 m2 = vec4(0.0);
    float s1 = 0.0;
    float s2 = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 o = vec2(x, y) * uTexel;
        vec4 c = texture(uCloud, vUv + o);
        m1 += c;
        m2 += c * c;
        float sh = texture(uShadow, vUv + o).r;
        s1 += sh;
        s2 += sh * sh;
      }
    }
    vec4 mean = m1 / 9.0;
    vec4 sigma = sqrt(max(m2 / 9.0 - mean * mean, 0.0));
    histCloud = clamp(histCloud, mean - 1.5 * sigma, mean + 1.5 * sigma);
    float shMean = s1 / 9.0;
    float shSigma = sqrt(max(s2 / 9.0 - shMean * shMean, 0.0));
    histShadow.r = clamp(histShadow.r, shMean - 1.5 * shSigma, shMean + 1.5 * shSigma);
  }

  float n = cloudValid ? min(texture(uHistoryShadow, cloudUv).b + 1.0, uMaxHistory) : 1.0;
  if (uMoving) {
    // A camera moving a large fraction of the distance to the cloud (diving through a deck a few km thick) sees
    // parallax that one depth per pixel cannot reproject, so lean on the current frame instead of smearing.
    float travel = distance(uCamPos, uPrevCamPos) / max(shadow.g, 0.05);
    n = min(n, mix(uMaxHistory, 1.0, smoothstep(0.01, 0.08, travel)));
  }
  float nShadow = shadowValid ? n : 1.0;
  outCloud = mix(histCloud, cloud, 1.0 / n);
  outShadow = vec4(mix(histShadow.r, shadow.r, 1.0 / nShadow), shadow.g, n, 1.0);
}
`;

export const compositeVertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const compositeFragmentShader = /* glsl */ `
uniform sampler2D uScene;
uniform sampler2D uCloud;
uniform sampler2D uShadow;
uniform sampler2D uDepth;
uniform sampler2D uTerrain;
uniform float uShadowStrength;
uniform float uOpacity;
uniform float uOutline;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform vec3 uCamForward;
uniform float uFar;
uniform vec4 uTerrainBox;
uniform vec2 uTerrainSize;
varying vec2 vUv;

// 1 on a line where value crosses a multiple of step, antialiased to about widthPx pixels.
float isoline(float value, float step, float widthPx) {
  float f = value / step;
  float d = abs(fract(f + 0.5) - 0.5) / max(fwidth(f), 1e-6);
  return 1.0 - smoothstep(widthPx * 0.5 - 0.5, widthPx * 0.5 + 0.5, d);
}

void main() {
  // Premultiplied, so scaling the whole vec4 fades the cloud evenly.
  vec4 cloud = texture2D(uCloud, vUv) * uOpacity;
  float shadow = texture2D(uShadow, vUv).r;
  // Shadow removes most of the direct sun; skylight still reaches the ground.
  vec3 scene = texture2D(uScene, vUv).rgb * mix(1.0, shadow, uShadowStrength);
  vec3 color = scene * (1.0 - cloud.a) + cloud.rgb;

  // Coastline and height contours of the ground under the cloud, drawn on top so the map stays readable.
  // Full resolution, from the scene depth, so the lines stay sharp while the clouds are still converging.
  if (uOutline > 0.0 && cloud.a > 0.02) {
    float w = pow(uFar + 1.0, texture2D(uDepth, vUv).r) - 1.0;
    if (w < 10000.0) {
      vec4 view = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
      vec3 rd = normalize((uCamWorld * vec4(view.xyz / view.w, 0.0)).xyz);
      vec3 p = uCamPos + rd * (w / max(dot(rd, uCamForward), 1e-4));
      vec2 uv = vec2((p.x * 1000.0 - uTerrainBox.x) / (uTerrainBox.y - uTerrainBox.x),
                     (uTerrainBox.w + p.z * 1000.0) / (uTerrainBox.w - uTerrainBox.z));
      uv = (uv * (uTerrainSize - 1.0) + 0.5) / uTerrainSize;
      float h = texture2D(uTerrain, uv).r;  // km; land is at least 1 m, sea at most -1 m
      float coast = 1.0 - smoothstep(0.5, 1.5, abs(h) / max(fwidth(h), 1e-6));
      // Contours fade out where they would bunch up closer than a few pixels and turn to speckle.
      float spacing = fwidth(h / 0.2);
      float contour = h > 0.0 ? isoline(h, 0.2, 1.0) * 0.35 * (1.0 - smoothstep(0.12, 0.3, spacing)) : 0.0;
      float a = max(coast, contour) * cloud.a * uOutline;
      color = mix(color, vec3(0.08, 0.12, 0.18), a);
    }
  }

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

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
  if (rain > 0.1 && h < base) {
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

  outCloud = vec4(radiance, 1.0 - T);
  outShadow = vec4(shadow, 0.0, 0.0, 1.0);
}
`;

export const accumulateFragmentShader = /* glsl */ `
precision highp float;
layout(location = 0) out highp vec4 outCloud;
layout(location = 1) out highp vec4 outShadow;
in vec2 vUv;
uniform sampler2D uCloud;
uniform sampler2D uShadow;
uniform sampler2D uHistoryCloud;
uniform sampler2D uHistoryShadow;
uniform float uBlend;
void main() {
  outCloud = mix(texture(uHistoryCloud, vUv), texture(uCloud, vUv), uBlend);
  outShadow = mix(texture(uHistoryShadow, vUv), texture(uShadow, vUv), uBlend);
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

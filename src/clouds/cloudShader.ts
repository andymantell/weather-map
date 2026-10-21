// Raymarched cloud layer, rain shafts and a flat ground, all in km. Outputs premultiplied radiance and alpha so the
// sky can be composited behind it. Techniques: Schneider 2015 (shape and detail noise, height profiles, powder),
// Wrenninge-style multiple-scattering octaves, Hillaire 2016 energy-conserving step integration, and the
// Shipley et al. 1974 rain extinction law (sigma = 0.16 R^0.74 per km, R in mm/h).
export const cloudVertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const cloudFragmentShader = /* glsl */ `
precision highp float;
precision highp sampler3D;

#define PI 3.14159265359

uniform sampler3D uShape;
uniform sampler3D uDetail;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform float uFrame;
uniform float uTime;
uniform int uSteps;

uniform vec3 uSunDir;
uniform vec3 uSunRadiance;
uniform vec3 uAmbientTop;
uniform vec3 uAmbientBottom;
uniform vec3 uHaze;
uniform float uVisibility;
uniform vec3 uGroundAlbedo;
uniform float uDomain;
uniform vec3 uWind;

uniform float uBase;
uniform float uTop;
uniform float uCoverage;
uniform float uDensity;
uniform float uWeatherScale;
uniform float uShapeScale;
uniform float uVerticalScale;
uniform float uStreak;
uniform float uDetailScale;
uniform float uErosion;
uniform float uBottomRound;
uniform float uTopRound;
uniform float uAnvil;
uniform float uRain;
uniform float uRainDarkening;
uniform float uPowder;
uniform vec3 uFlashPos;
uniform float uFlash;

varying vec2 vUv;

float remap(float v, float a, float b, float c, float d) {
  return c + (v - a) / max(b - a, 1e-4) * (d - c);
}

float hg(float cosTheta, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5));
}

// Strong forward lobe for the silver lining plus a weak back lobe.
float phase(float cosTheta, float k) {
  return mix(hg(cosTheta, 0.8 * k), hg(cosTheta, -0.25 * k), 0.25);
}

// Cell field that places clouds: high values where a cloud or clump sits.
float weather(vec2 xz) {
  float r = length(xz) / uDomain;
  xz.x /= uStreak;
  vec4 a = texture(uShape, vec3(xz / uWeatherScale, 0.37));
  vec4 b = texture(uShape, vec3(xz / (uWeatherScale * 0.37) + 0.21, 0.71));
  float w = a.r * 0.7 + b.g * 0.3;
  return w * (1.0 - smoothstep(0.7, 1.0, r));
}

float cellCoverage(float w, float widen) {
  float t = 1.0 - uCoverage - widen;
  return smoothstep(t, t + 0.18, w);
}

// Single storm cell centred on the origin: a tower that narrows upwards, then flares into an anvil that is
// sheared downwind (+x). The weather noise only roughens its edge.
float stormCoverage(vec2 xz, float hFrac, float w) {
  float flare = smoothstep(0.68, 0.9, hFrac);
  vec2 c = xz - vec2(7.0 * smoothstep(0.55, 1.0, hFrac), 0.0);
  float radius = mix(10.0 - 2.5 * hFrac, 17.0, flare);
  float edge = (w - 0.4) * mix(5.0, 8.0, flare);
  // Capped below 1 so the shape noise still carves billows into the tower and anvil edges.
  return 0.8 * smoothstep(radius + edge, radius + edge - 6.0, length(c));
}

// Fraction of a column that is cloudy at this height.
float coverageAt(vec2 xz, float hFrac) {
  float w = weather(xz);
  if (uAnvil > 0.0) return stormCoverage(xz, hFrac, w);
  return cellCoverage(w, 0.0);
}

float rainCoreAt(vec2 xz) {
  float w = weather(xz);
  if (uAnvil > 0.0) return smoothstep(7.0 + (w - 0.4) * 5.0, 2.0, length(xz));
  return smoothstep(1.0 - uCoverage + 0.08, 1.0 - uCoverage + 0.4, w);
}

float cloudDensity(vec3 p, bool cheap, out float hFrac) {
  hFrac = (p.y - uBase) / (uTop - uBase);
  if (hFrac <= 0.0 || hFrac >= 1.0) return 0.0;
  vec3 q = p + uWind * uTime;
  float cov = coverageAt(q.xz, hFrac);
  if (cov <= 0.01) return 0.0;

  float profile = smoothstep(0.0, uBottomRound, hFrac) * (1.0 - smoothstep(1.0 - uTopRound, 1.0, hFrac));
  vec3 sp = vec3(q.x / (uShapeScale * uStreak), q.y / (uShapeScale * uVerticalScale), q.z / uShapeScale);
  vec4 n = texture(uShape, sp);
  float fbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  float shape = remap(n.r, fbm - 1.0, 1.0, 0.0, 1.0);
  float c = cov;
  float d = clamp(remap(shape * profile, 1.0 - c, 1.0, 0.0, 1.0), 0.0, 1.0) * c;
  if (cheap || d <= 0.0) return d;

  vec3 dp = vec3(q.x / uStreak, q.y, q.z) / uDetailScale + n.gba * 0.3;
  vec3 dn = texture(uDetail, dp).rgb;
  float dfbm = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
  // Wispy at the base, billowy higher up.
  float dmod = mix(dfbm, 1.0 - dfbm, clamp(hFrac * 4.0, 0.0, 1.0));
  return clamp(remap(d, dmod * uErosion, 1.0, 0.0, 1.0), 0.0, 1.0);
}

// Rain rate in mm/h at a point below the cloud base.
float rainRate(vec3 p) {
  if (uRain <= 0.0 || p.y >= uBase) return 0.0;
  vec3 q = p + uWind * uTime;
  float core = rainCoreAt(q.xz);
  if (core <= 0.0) return 0.0;
  // Streaks: noise stretched vertically and scrolling downwards.
  vec3 sp = vec3(q.x / 1.5, (q.y + uTime * 6.0) / 9.0, q.z / 1.5);
  float streak = texture(uDetail, sp).r;
  float fade = smoothstep(0.0, 0.25, uBase - p.y) * 0.4 + 0.6;
  return uRain * core * (0.35 + streak) * fade;
}

float rainSigma(float rate) {
  return rate > 0.0 ? 0.16 * pow(rate, 0.74) : 0.0;
}

// Optical depth from p towards the sun through the cloud layer.
float sunOpticalDepth(vec3 p, int steps, bool cheap) {
  float span = (uTop - uBase) / max(uSunDir.y, 0.15);
  float stepLen = span / float(steps * 2);
  float od = 0.0;
  vec3 pos = p;
  float h;
  for (int i = 0; i < 8; i++) {
    if (i >= steps) break;
    float s = stepLen * (1.0 + float(i) * 0.6);
    pos += uSunDir * s * 0.5;
    od += cloudDensity(pos, cheap || i > 2, h) * uDensity * s;
    pos += uSunDir * s * 0.5;
  }
  return od;
}

// Optical depth from a point under the cloud up to the sun, entering the layer at its base.
float shadowOpticalDepth(vec3 p) {
  if (uSunDir.y <= 0.02) return 1e3;
  vec3 start = p + uSunDir * max((uBase - p.y) / uSunDir.y, 0.0);
  return sunOpticalDepth(start, 6, true);
}

vec2 slab(vec3 ro, vec3 rd, float y0, float y1) {
  if (abs(rd.y) < 1e-5) return (ro.y >= y0 && ro.y <= y1) ? vec2(0.0, 1e5) : vec2(1.0, 0.0);
  float a = (y0 - ro.y) / rd.y;
  float b = (y1 - ro.y) / rd.y;
  return vec2(max(min(a, b), 0.0), max(a, b));
}

float ign(vec2 px) {
  return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
}

void main() {
  vec4 clip = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec4 view = uInvProj * clip;
  vec3 rd = normalize((uCamWorld * vec4(view.xyz / view.w, 0.0)).xyz);
  vec3 ro = uCamPos;

  float tGround = rd.y < 0.0 ? -ro.y / rd.y : 1e9;
  float yMin = uRain > 0.0 ? 0.0 : uBase;
  vec2 range = slab(ro, rd, yMin, uTop);
  range.y = min(min(range.y, tGround), 250.0);

  float jitter = fract(ign(gl_FragCoord.xy) + uFrame * 0.618034);
  float cosTheta = dot(rd, uSunDir);
  vec3 radiance = vec3(0.0);
  float T = 1.0;
  float depthWeight = 0.0;
  float depthSum = 0.0;

  if (range.y > range.x) {
    float dt = max((range.y - range.x) / float(uSteps), 0.02);
    float t = range.x + dt * jitter;
    for (int i = 0; i < 512; i++) {
      if (i >= uSteps || t > range.y || T < 0.01) break;
      vec3 p = ro + rd * t;
      float h;
      float d = p.y >= uBase ? cloudDensity(p, false, h) : 0.0;
      float sigmaCloud = d * uDensity;
      float rate = rainRate(p);
      float sigmaRain = rainSigma(rate);
      float sigmaT = sigmaCloud * (1.0 + uRainDarkening * step(0.01, uRain)) + sigmaRain;
      if (sigmaT > 1e-4) {
        vec3 S = vec3(0.0);
        if (sigmaCloud > 0.0) {
          float od = sunOpticalDepth(p, 6, false);
          // Multiple-scattering octaves: each one less attenuated and less forward-peaked.
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
          // Powder: thin edges facing the sun hold less in-scattered light.
          float powder = 1.0 - exp(-sigmaCloud * 0.25);
          sunTerm *= mix(1.0, powder, uPowder * 0.5 * (1.0 - cosTheta));
          vec3 ambient = mix(uAmbientBottom, uAmbientTop, h);
          S += sigmaCloud * (uSunRadiance * sunTerm + ambient * 0.9);
          vec3 toFlash = uFlashPos - p;
          S += sigmaCloud * uFlash * vec3(0.8, 0.85, 1.0) * exp(-length(toFlash) * 0.9);
        }
        if (sigmaRain > 0.0) {
          float od = shadowOpticalDepth(p);
          S += sigmaRain * 0.7 * (uSunRadiance * exp(-od) * phase(cosTheta, 0.5) + uAmbientBottom * 0.6);
        }
        float stepT = exp(-sigmaT * dt);
        vec3 integ = (S - S * stepT) / sigmaT;
        radiance += T * integ;
        float absorbed = T * (1.0 - stepT);
        depthSum += absorbed * t;
        depthWeight += absorbed;
        T *= stepT;
      }
      t += dt;
    }
  }

  // Aerial perspective on the cloud, at its transmittance-weighted mean distance.
  if (depthWeight > 0.0) {
    float meanDist = depthSum / depthWeight;
    float haze = 1.0 - exp(-meanDist / uVisibility);
    radiance = mix(radiance, uHaze * (1.0 - T), haze);
  }

  float alpha = 1.0 - T;
  if (tGround < 1e8) {
    vec3 p = ro + rd * tGround;
    float od = shadowOpticalDepth(p);
    float sunE = max(uSunDir.y, 0.05);
    // Direct sun through the cloud, plus skylight; diffuse light gets through cloud far better than the direct beam.
    vec3 irradiance = uSunRadiance * sunE * (exp(-od) + 0.3 * (0.25 + 0.75 * exp(-od * 0.04)));
    float variation = texture(uShape, vec3(p.xz / 9.0, 0.11)).g * 0.5 + texture(uShape, vec3(p.xz / 2.0, 0.53)).b * 0.5;
    vec3 albedo = uGroundAlbedo * (0.7 + 0.6 * variation);
    vec3 ground = albedo / PI * irradiance;
    float haze = 1.0 - exp(-tGround / uVisibility);
    ground = mix(ground, uHaze, haze);
    radiance += T * ground;
    alpha = 1.0;
  }
  gl_FragColor = vec4(radiance, alpha);
}
`;

export const accumulateFragmentShader = /* glsl */ `
precision highp float;
uniform sampler2D uCurrent;
uniform sampler2D uHistory;
uniform float uBlend;
varying vec2 vUv;
void main() {
  gl_FragColor = mix(texture(uHistory, vUv), texture(uCurrent, vUv), uBlend);
}
`;

export const compositeFragmentShader = /* glsl */ `
precision highp float;
uniform sampler2D uSky;
uniform sampler2D uClouds;
varying vec2 vUv;
void main() {
  vec4 c = texture(uClouds, vUv);
  vec3 color = texture(uSky, vUv).rgb * (1.0 - c.a) + c.rgb;
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * GLSL injected into MeshPhysicalMaterial for the live sea surface.
 *
 * The surface is a sum of sinusoids taken from one fixed, world-wide bank of
 * wave vectors (BANDS wavelengths x DIRS directions). Only the amplitudes vary
 * across the map: each is set from a local directional spectrum built from the
 * Met Office wind-sea and swell parameters. Because the wave vectors never
 * change, phases stay continuous however fast the sea state varies.
 *
 * Components too short to resolve at the pixel's footprint are faded out and
 * their slope variance moves into the specular roughness instead (Bruneton,
 * Neyret & Holzschuch 2010), so the sea turns smoothly from visible waves up
 * close into a wind-dependent sun glint from altitude. See
 * docs/sea-state-research.md for sources.
 */

export const BANDS = 16;
export const DIRS = 12;
/** Longest and shortest modelled wavelengths in metres. */
export const LAMBDA_MAX = 600;
export const LAMBDA_MIN = 4;
/**
 * Wave vectors are snapped to a lattice that repeats every TILE metres, so the
 * shader can work relative to a nearby origin snapped to TILE without any phase
 * jump. That keeps sin() arguments small enough for 32-bit floats.
 */
export const TILE = 16384;

export const vertexPars = /* glsl */ `
  varying vec3 vSeaWorld;
`;

export const vertexMain = /* glsl */ `
  vSeaWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

export const fragmentPars = /* glsl */ `
  varying vec3 vSeaWorld;
  uniform sampler2D uWindSea;
  uniform sampler2D uSwell;
  uniform sampler2D uPeriod;
  uniform sampler2D uDepth;
  uniform vec4 uWaveGrid;   // west edge, north edge, width, height (metres)
  uniform vec4 uDepthGrid;  // first sample x, first sample y, spacing (metres), unused
                            // R = real height, G = terrain mesh height (see ocean.ts)
  uniform vec2 uDepthSize;  // samples
  // Detailed terrain tiles (src/detail/): drawn height (m) on their own fine grids, so the surf
  // follows the coastline they draw instead of the coarse one.
  uniform sampler2D uDetailDepth0;
  uniform sampler2D uDetailDepth1;
  uniform vec4 uDetailGrid[2]; // first sample x, first sample y, spacing (metres), 1 if in use
  uniform vec2 uDetailSize[2]; // samples
  uniform vec3 uWaveScaleBytes; // metres / seconds / m s-1 per byte for Hs, Tp, wind
  uniform vec2 uOrigin;     // metres, snapped to TILE * uWaveScale
  uniform float uTime;
  uniform float uWaveScale; // spatial exaggeration
  uniform float uStyle;     // 0 = realistic (Froude-scaled), 1 = stylised
  uniform float uSteep;     // stylised slope exaggeration
  uniform float uStyleSpeed; // stylised animation speed (wave periods per real period)
  uniform float uSurfScale; // surf zone width exaggeration
  uniform vec3 uCrestColour;
  uniform vec2 uSpread;     // cos^2s spreading exponent s: wind sea, swell
  uniform vec2 uSpreadNorm; // matching normalisation constants
  uniform float uFoam;
  uniform float uSurf;
  uniform float uGlint;     // extra strength for the sun's reflection
  uniform vec3 uShallowColour;
  uniform vec3 uDeepColour;

  #define SEA_G 9.81
  #define SEA_TAU 6.283185307
  #define SEA_BANDS ${BANDS}
  #define SEA_DIRS ${DIRS}
  #define SEA_LAMBDA_MAX ${LAMBDA_MAX.toFixed(1)}
  #define SEA_LAMBDA_MIN ${LAMBDA_MIN.toFixed(1)}
  #define SEA_TILE ${TILE.toFixed(1)}

  float seaAlpha = 1.0;

  float seaHash(float n) { return fract(sin(n * 127.1) * 43758.5453); }
  float seaHash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  float seaNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(seaHash2(i), seaHash2(i + vec2(1, 0)), u.x),
               mix(seaHash2(i + vec2(0, 1)), seaHash2(i + vec2(1, 1)), u.x), u.y);
  }

  float seaFbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * seaNoise(p);
      p = mat2(1.6, 1.2, -1.2, 1.6) * p;
      a *= 0.5;
    }
    return v;
  }

  // Bretschneider (two-parameter Pierson-Moskowitz) spectrum in angular frequency;
  // integrates to Hs^2 / 16.
  float seaSpectrum(float w, float hs, float tp) {
    if (hs < 0.01 || tp < 0.5) return 0.0;
    float r = SEA_TAU / tp / w;
    float r4 = r * r * r * r;
    return 0.3125 * hs * hs * r4 / w * exp(-1.25 * r4);
  }

  // Upper-tail inverse of the standard normal CDF (Abramowitz & Stegun 26.2.23).
  float seaNormalQuantile(float q) {
    float t = sqrt(-2.0 * log(q));
    return t - (2.515517 + 0.802853 * t + 0.010328 * t * t) /
               (1.0 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
  }

  struct SeaSurface {
    vec2 slope;        // d(eta)/d(east), d(eta)/d(north), resolved part
    float eta;         // resolved elevation, model metres
    float resolvedVar; // elevation variance carried by resolved waves
    float totalVar;    // elevation variance of the whole bank
    float filteredSlopeVar; // slope variance of waves too small for this pixel
    float bankSlopeVar;     // slope variance of the whole bank
    float windEta;          // resolved elevation of the wind sea alone
    float windResolvedVar;
    float windTotalVar;
  };

  SeaSurface seaEvaluate(vec2 p, float footprint, float depth, float t,
                         float hsW, vec2 dirW, float tpW, float hsS, vec2 dirS, float tpS) {
    SeaSurface o = SeaSurface(vec2(0.0), 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    float ratio = pow(SEA_LAMBDA_MAX / SEA_LAMBDA_MIN, 1.0 / float(SEA_BANDS - 1));
    float halfStep = pow(ratio, 0.25);
    float dTheta = SEA_TAU / float(SEA_DIRS);
    for (int b = 0; b < SEA_BANDS; b++) {
      float lambda = SEA_LAMBDA_MAX * pow(ratio, -float(b));
      float k = SEA_TAU / lambda;
      float w = sqrt(SEA_G * k);
      float dw = w * (halfStep - 1.0 / halfStep);
      float sW = seaSpectrum(w, hsW, tpW);
      float sS = seaSpectrum(w, hsS, tpS);
      float bandVar = (sW + sS) * dw;
      o.totalVar += bandVar;
      o.windTotalVar += sW * dw;
      o.bankSlopeVar += bandVar * k * k;
      // Fade out a band once it is under ~6 pixels per wavelength.
      float resolved = smoothstep(2.0 * footprint, 6.0 * footprint, lambda);
      o.filteredSlopeVar += (1.0 - resolved) * bandVar * k * k;
      if (resolved <= 0.0 || bandVar < 1e-8) continue;
      o.resolvedVar += resolved * bandVar;
      o.windResolvedVar += resolved * sW * dw;
      // Each band's directions are rotated by a different random offset so the
      // bank covers directions densely and never looks like a regular grid.
      float rot = seaHash(float(b) + 0.37) * dTheta;
      for (int d = 0; d < SEA_DIRS; d++) {
        float th = rot + float(d) * dTheta;
        vec2 u = vec2(cos(th), sin(th));
        float spreadW = sW * uSpreadNorm.x * pow(max(0.5 + 0.5 * dot(u, dirW), 0.0), uSpread.x);
        float spreadS = sS * uSpreadNorm.y * pow(max(0.5 + 0.5 * dot(u, dirS), 0.0), uSpread.y);
        float a = resolved * sqrt(2.0 * (spreadW + spreadS) * dw * dTheta);
        if (a < 1e-5) continue;
        // Jitter wavelengths within the band so components are never harmonics.
        float kj = k * (1.0 + 0.3 * (seaHash(float(b * SEA_DIRS + d) + 5.3) - 0.5));
        vec2 kv = round(u * kj * SEA_TILE / SEA_TAU) * SEA_TAU / SEA_TILE;
        float km = length(kv);
        // Finite-depth dispersion: waves slow and shorten over shallow water.
        float om = sqrt(SEA_G * km * tanh(km * depth));
        float phase = dot(kv, p) - om * t + SEA_TAU * seaHash(float(b * SEA_DIRS + d) + 17.0);
        o.eta += a * cos(phase);
        o.windEta += a * cos(phase) * spreadW / max(spreadW + spreadS, 1e-12);
        o.slope -= a * kv * sin(phase);
      }
    }
    return o;
  }
`;

/** Runs after <normal_fragment_maps>: replaces the normal, roughness, colour and alpha. */
export const fragmentMain = /* glsl */ `
  {
    vec2 mapPos = vec2(vSeaWorld.x, -vSeaWorld.z) * 1000.0; // LAEA metres (east, north)

    vec2 waveUv = vec2(mapPos.x - uWaveGrid.x, uWaveGrid.y - mapPos.y) / uWaveGrid.zw;
    vec3 windSea = texture2D(uWindSea, waveUv).rgb * 255.0;
    vec3 swell = texture2D(uSwell, waveUv).rgb * 255.0;
    vec3 period = texture2D(uPeriod, waveUv).rgb * 255.0;
    float hsW = windSea.r * uWaveScaleBytes.x;
    float hsS = swell.r * uWaveScaleBytes.x;
    vec2 dirW = normalize(windSea.gb / 127.5 - 1.0 + 1e-5);
    vec2 dirS = normalize(swell.gb / 127.5 - 1.0 + 1e-5);
    float tpW = period.r * uWaveScaleBytes.y;
    float tpS = period.g * uWaveScaleBytes.y;
    float wind = period.b * uWaveScaleBytes.z;
    float hs = sqrt(hsW * hsW + hsS * hsS);

    vec2 depthUv = (vec2(mapPos.x - uDepthGrid.x, uDepthGrid.y - mapPos.y) / uDepthGrid.z + 0.5) / uDepthSize;
    vec2 ground = texture2D(uDepth, depthUv).rg;
    float depth = max(-ground.r, 0.0);
    // Distance to the drawn coastline, to first order: mesh height over its gradient.
    vec2 texel = 1.0 / uDepthSize;
    vec2 meshGrad = vec2(
      texture2D(uDepth, depthUv + vec2(texel.x, 0.0)).g - texture2D(uDepth, depthUv - vec2(texel.x, 0.0)).g,
      texture2D(uDepth, depthUv + vec2(0.0, texel.y)).g - texture2D(uDepth, depthUv - vec2(0.0, texel.y)).g
    ) / (2.0 * uDepthGrid.z);
    float coastDistance = -ground.g / max(length(meshGrad), 1e-4);
    for (int i = 0; i < 2; i++) {
      vec4 grid = uDetailGrid[i];
      vec2 size = uDetailSize[i];
      vec2 cell = vec2(mapPos.x - grid.x, grid.y - mapPos.y) / grid.z;
      if (grid.w < 0.5 || any(lessThan(cell, vec2(1.0))) || any(greaterThan(cell, size - 2.0))) continue;
      vec2 uv = (cell + 0.5) / size;
      vec2 t = 1.0 / size;
      float h = i == 0 ? texture2D(uDetailDepth0, uv).r : texture2D(uDetailDepth1, uv).r;
      vec2 g = i == 0
        ? vec2(texture2D(uDetailDepth0, uv + vec2(t.x, 0.0)).r - texture2D(uDetailDepth0, uv - vec2(t.x, 0.0)).r,
               texture2D(uDetailDepth0, uv + vec2(0.0, t.y)).r - texture2D(uDetailDepth0, uv - vec2(0.0, t.y)).r)
        : vec2(texture2D(uDetailDepth1, uv + vec2(t.x, 0.0)).r - texture2D(uDetailDepth1, uv - vec2(t.x, 0.0)).r,
               texture2D(uDetailDepth1, uv + vec2(0.0, t.y)).r - texture2D(uDetailDepth1, uv - vec2(0.0, t.y)).r);
      coastDistance = -h / max(length(g) / (2.0 * grid.z), 1e-3);
      // The fine DEM has no real bathymetry, so shoal towards the drawn coast at about 3%.
      depth = min(depth, max(coastDistance, 0.0) * 0.03 + 0.5);
    }

    // Work in "model" metres. Realistic mode is a Froude-scaled copy of the real
    // sea, so slopes are unchanged and periods grow with sqrt(scale). Stylised
    // mode blows the waves up hugely so they read from the overview, keeps real
    // periods so they still move, and steepens them (uSteep) so their relative
    // size shows in the shading.
    vec2 local = (mapPos - uOrigin) / uWaveScale;
    // Gently warp the plane so the fixed wave bank never shows a regular lattice.
    local += 30.0 * (vec2(seaNoise(local / 350.0), seaNoise(local / 350.0 + 19.7)) - 0.5)
           + 8.0 * (vec2(seaNoise(local / 90.0 + 3.1), seaNoise(local / 90.0 + 41.3)) - 0.5);
    float footprint = max(length(dFdx(local)), length(dFdy(local)));
    float t = mix(uTime / sqrt(uWaveScale), uTime * uStyleSpeed, uStyle);
    SeaSurface sea = seaEvaluate(local, footprint, max(depth / uWaveScale, 0.5), t,
                                 hsW, dirW, tpW, hsS, dirS, tpS);

    // Normal from the resolved slopes. World X = east, world Z = -north.
    vec2 slope = sea.slope * mix(1.0, uSteep, uStyle);
    vec3 worldNormal = normalize(vec3(-slope.x, 1.0, slope.y));
    normal = normalize((viewMatrix * vec4(worldNormal, 0.0)).xyz);

    // Specular roughness from unresolved slopes. Cox & Munk (1954) give the
    // total mean square slope for a wind speed; the part the bank does not model
    // (capillaries and short gravity waves) is kept, plus the bank's own waves
    // that are too small for this pixel.
    float coxMunk = 0.003 + 0.00512 * wind;
    float unresolvedSlopeVar = max(coxMunk - sea.bankSlopeVar, 0.2 * coxMunk) + sea.filteredSlopeVar;
    roughnessFactor = clamp(pow(unresolvedSlopeVar, 0.25), 0.06, 0.9);

    // Whitecaps: Monahan & O'Muircheartaigh (1980) coverage, placed on the
    // highest resolved wind-sea crests (swell rarely breaks in open water), or
    // spread evenly where those waves are unresolved.
    float coverage = clamp(3.84e-6 * pow(wind, 3.41), 0.0, 0.35) * uFoam;
    float resolvedShare = sea.windResolvedVar / max(sea.windTotalVar, 1e-6);
    float etaNorm = sea.windEta / sqrt(max(sea.windResolvedVar, 1e-6));
    // Foam texture stretched along the wind-sea direction into streaks.
    vec2 along = vec2(dot(local, dirW), dot(local, vec2(-dirW.y, dirW.x)));
    float streaks = seaFbm(along / (vec2(12.0, 3.0) * (1.0 + 0.3 * tpW)) + vec2(t * 0.03, 0.0));
    float crestFoam = coverage > 1e-4
      ? smoothstep(-0.2, 1.2, etaNorm + 1.6 * (streaks - 0.5) - seaNormalQuantile(coverage))
      : 0.0;
    float foam = mix(coverage, crestFoam, resolvedShare);

    // Surf: waves break once height reaches ~0.78 x depth (McCowan), so on a
    // typical 1:50 beach the surf zone is about 60 x Hs wide. Below a pixel's
    // footprint it fades to its average coverage instead of aliasing.
    float surfWidth = 60.0 * hs * uSurfScale;
    float footprintMetres = footprint * uWaveScale;
    float surfNoise = seaFbm(vec2(coastDistance / (0.35 * surfWidth + 1.0) - t * 0.15, seaNoise(mapPos / 400.0) * 6.0));
    float surf = (1.0 - smoothstep(0.0, surfWidth + footprintMetres, coastDistance))
               * surfWidth / (surfWidth + footprintMetres)
               * smoothstep(0.25, 0.6, surfNoise) * step(0.0, coastDistance) * uSurf;
    foam = clamp(max(foam, surf), 0.0, 1.0);

    // Water body: absorb along the view path so shallow seabed shows through.
    float viewCos = max(abs(dot(normalize(vViewPosition), normal)), 0.15);
    float water = 1.0 - exp(-depth * 0.09 / viewCos);
    vec3 body = mix(uShallowColour, uDeepColour, 1.0 - exp(-depth / 25.0));
    // Stylised: light crests and dark troughs, so the waves read even away from the sun.
    float crest = sea.eta / sqrt(max(sea.resolvedVar, 1e-6));
    body = mix(body, uCrestColour, uStyle * 0.7 * smoothstep(0.3, 2.2, crest));
    body *= 1.0 - uStyle * 0.45 * smoothstep(0.3, 2.0, -crest);
    diffuseColor.rgb = mix(body, vec3(0.9), foam);
    roughnessFactor = mix(roughnessFactor, 1.0, foam);
    seaAlpha = max(water, foam);
  }
`;

/**
 * Replaces <opaque_fragment>. The sea is drawn with premultiplied blending so
 * the water body fades with depth while reflections and glint stay at full
 * strength over the shallows. The scene's sun is set for lighting land, far
 * dimmer relative to the sky than the real sun, so its glint is boosted.
 */
export const opaqueFragment = /* glsl */ `
  gl_FragColor = vec4(
    totalDiffuse * seaAlpha + reflectedLight.directSpecular * uGlint + reflectedLight.indirectSpecular + totalEmissiveRadiance,
    seaAlpha
  );
`;

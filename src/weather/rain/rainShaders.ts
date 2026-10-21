// Animated rain over the map, drawn after the cloud composite. World units are km: x = LAEA easting,
// z = -northing, y = height times the terrain exaggeration. See docs/animated-rain.md.
//
// Two kinds of instanced sprite share one column model (rain falls from just inside the cloud to the ground):
// - streaks: one falling, motion-blurred drop per instance, for views from a few km to a few hundred km;
// - veils: wide soft curtains with a scrolling streak texture, for the overview and as mist in heavy rain.
// Both come in tiers whose particles wrap in a box around the camera, so drops stay fixed in the world while the
// camera moves and the number of drops on screen stays about the same at every zoom.

export const rainCommon = /* glsl */ `
precision highp float;

uniform sampler2D uFields;   // r: sqrt(rain / 64 mm/h), g: cloud base / 8 km, b: high cloud, a: sqrt(CAPE / 2000)
uniform sampler2D uTerrain;  // ground height, km
uniform vec2 uGridWest;
uniform vec2 uGridSize;
uniform float uGridDx;
uniform vec4 uTerrainBox;
uniform vec2 uTerrainSize;
uniform float uExaggeration;
uniform float uCloudScale;
uniform float uTime;
uniform vec2 uWind;          // horizontal drift per unit of fall
uniform float uStrength;

vec2 gridUv(vec2 laea) {
  return vec2((laea.x - uGridWest.x) / uGridDx + 0.5, (uGridWest.y - laea.y) / uGridDx + 0.5) / uGridSize;
}

float groundKm(vec2 laea) {
  vec2 uv = vec2((laea.x - uTerrainBox.x) / (uTerrainBox.y - uTerrainBox.x),
                 (uTerrainBox.w - laea.y) / (uTerrainBox.w - uTerrainBox.z));
  uv = (uv * (uTerrainSize - 1.0) + 0.5) / uTerrainSize;
  return max(texture(uTerrain, uv).r, 0.0);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

struct Column {
  float rate;     // mm/h at the surface
  float ground;   // world y
  float top;      // world y where drops appear
  float period;   // seconds for a drop to fall the whole column
  float convective;
};

// Marshall-Palmer median volume diameter (mm) and the Atlas et al. (1973) fall speed (m/s).
float fallSpeed(float rate) {
  float d0 = 3.67 / (4.1 * pow(max(rate, 0.01), -0.21));
  return 9.65 - 10.3 * exp(-0.6 * d0);
}

Column columnAt(vec2 xz) {
  Column c = Column(0.0, 0.0, 0.0, 1.0, 0.0);
  vec2 laea = vec2(xz.x, -xz.y) * 1000.0;
  vec2 uv = gridUv(laea);
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return c;
  vec4 f = texture(uFields, uv);
  // Break up the bilinear 2 km field so rain areas have ragged, cellular edges instead of smooth blobs.
  float n = vnoise(xz / 7.0) * 0.6 + vnoise(xz / 2.3) * 0.4;
  float rate = 64.0 * f.r * f.r;
  vec2 edge = min(uv, 1.0 - uv);
  c.rate = rate * mix(0.35, 1.65, n) * smoothstep(0.0, 0.03, min(edge.x, edge.y));
  c.convective = smoothstep(0.15, 0.6, f.a);
  float base = f.g > 0.999 ? 1.0 : f.g * 8.0;
  // Rain forms inside the cloud, so drops start part way up it: deeper in showery (convective) cloud.
  float top = base + mix(0.8, 2.5, c.convective);
  c.ground = groundKm(laea) * uExaggeration;
  c.top = c.ground + top * uCloudScale;
  // Time-lapse: about 2 s to fall the column at 1 mm/h, faster for the bigger drops of heavy rain.
  c.period = 2.0 * fallSpeed(1.0) / fallSpeed(c.rate);
  return c;
}

`;

export const rainFragmentCommon = /* glsl */ `
${rainCommon}
// Scene depth along the view axis, from the logarithmic depth buffer.
uniform sampler2D uDepth;
uniform sampler2D uCloud;    // cloud colour and alpha (premultiplied, before opacity)
uniform vec2 uViewport;
uniform float uFar;
uniform float uCloudOpacity;
uniform float uThroughCloud; // how much rain behind cloud still shows, 0 to 1

// Fades a fragment at view depth w against the scene and the clouds in front of it.
float occlusion(float w) {
  vec2 uv = gl_FragCoord.xy / uViewport;
  float sceneW = pow(uFar + 1.0, texture(uDepth, uv).r) - 1.0;
  // Soft contact with the ground, so drops end without a hard cut.
  float vis = clamp((sceneW - w) / max(0.004 * w, 0.02), 0.0, 1.0);
  float cloud = texture(uCloud, uv).a * uCloudOpacity;
  return vis * (1.0 - cloud * (1.0 - uThroughCloud));
}
`;

export const streakVertexShader = /* glsl */ `
${rainCommon}
in vec4 seed;        // x, z in the tile, fall phase, id
in vec2 corner;      // x: -1..1 across, y: 0 at the drop's head to 1 at its tail
uniform float uTile;   // tile size, km
uniform float uDist;   // camera distance this tier is meant for, km
uniform float uPixel;  // world size of one pixel at 1 km
uniform float uFirst;  // 1 for the nearest tier, which also keeps every drop closer than its distance
out vec2 vCorner;
out float vAlpha;
out float vW;
out float vHeat;

void main() {
  vec3 cam = cameraPosition;
  vec2 xz = cam.xz + (fract(seed.xy - cam.xz / uTile + 0.5) - 0.5) * uTile;
  Column c = columnAt(xz);
  // Count-based LOD: a hat in log distance, summing to 1 over tiers spaced by 3x.
  float camDist = length(vec3(xz.x, 0.5 * (c.top + c.ground), xz.y) - cam);
  float lod = max(0.0, 1.0 - abs(log(camDist / uDist) / log(3.0)));
  if (uFirst > 0.0 && camDist < uDist) lod = 1.0;
  // Heavier rain: more drops, from about a fifth of the maximum in drizzle to all of them in a downpour.
  float density = smoothstep(0.02, 0.15, c.rate) * clamp(0.18 + 0.27 * log2(1.0 + c.rate), 0.0, 1.0);
  float keep = density * lod - seed.w;
  if (keep <= 0.0 || c.top <= c.ground) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float height = c.top - c.ground;
  float fallen = fract(seed.z + uTime / c.period);
  vec3 fall = normalize(vec3(uWind.x, -1.0, uWind.y));
  vec3 head = vec3(xz.x, c.top, xz.y) + fall * (fallen * height / -fall.y);
  // Motion-blur length: the distance fallen in a short exposure, at least a few pixels.
  float speed = height / c.period;
  float heavy = smoothstep(0.5, 16.0, c.rate);
  float dist = length(head - cam);
  float len = max(speed * mix(0.05, 0.11, heavy), dist * uPixel * mix(6.0, 14.0, heavy));
  float width = dist * uPixel * mix(1.3, 2.2, heavy);

  vec3 toCam = normalize(cam - head);
  vec3 side = normalize(cross(fall, toCam));
  vec3 p = head - fall * len * corner.y + side * corner.x * width * 0.5;

  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vW = -mv.z;
  vCorner = corner;
  vHeat = heavy;
  // Fade in at the top of the column (inside the cloud) and keep a soft threshold so LOD changes do not pop.
  vAlpha = clamp(keep * 12.0, 0.0, 1.0) * smoothstep(0.0, 0.15, fallen) * mix(0.22, 0.55, heavy) * uStrength;
}
`;

export const streakFragmentShader = /* glsl */ `
${rainFragmentCommon}
in vec2 vCorner;
in float vAlpha;
in float vW;
in float vHeat;
out vec4 outColor;

void main() {
  float across = 1.0 - vCorner.x * vCorner.x;
  // Bright head, fading tail.
  float along = (1.0 - vCorner.y) * smoothstep(0.0, 0.08, vCorner.y + 0.02);
  float a = vAlpha * across * along * occlusion(vW);
  if (a < 0.002) discard;
  // A mid blue-grey reads both against bright cloud and sky and against dark sea and land.
  vec3 color = mix(vec3(0.62, 0.67, 0.74), vec3(0.5, 0.55, 0.63), vHeat);
  outColor = vec4(color, a);
}
`;

export const veilVertexShader = /* glsl */ `
${rainCommon}
in vec4 seed;
in vec2 corner;      // x: -1..1 across, y: 0..1 along the fall
uniform float uTile;
uniform float uDist;
uniform float uWidth;  // km
out vec2 vCorner;
out float vAlpha;
flat out float vW;
out vec2 vTex;
out float vDark;
out float vSide;

// Each curtain is a camera-facing sprite standing in for a rain column: seen from the side it is a tall shaft,
// from above it is the column's footprint. The streak texture runs along the fall as projected onto the sprite.
void main() {
  vec3 cam = cameraPosition;
  vec2 xz = cam.xz + (fract(seed.xy - cam.xz / uTile + 0.5) - 0.5) * uTile;
  Column c = columnAt(xz);
  float height = c.top - c.ground;
  vec3 fall = normalize(vec3(uWind.x, -1.0, uWind.y));
  vec3 center = vec3(xz.x, c.ground, xz.y) - fall * (0.5 * height / -fall.y);
  vec3 view = center - cam;
  float camDist = length(view);
  float lod = max(0.0, 1.0 - abs(log(camDist / uDist) / log(3.0)));
  if (c.rate < 0.05 || lod <= 0.0 || height <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  view /= camDist;
  vec3 along = fall - dot(fall, view) * view;
  float cosE = length(along);  // 1 seen from the side, 0 looking straight down the fall
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  along = cosE > 1e-3 ? along / cosE : -camUp;
  vec3 side = normalize(cross(view, along));
  float w = uWidth * mix(0.7, 1.3, fract(seed.w * 7.3));
  float sinE = sqrt(max(1.0 - cosE * cosE, 0.0));
  float len = height * cosE + w * sinE;
  float y = corner.y * 2.0 - 1.0;
  vec3 p = center + side * corner.x * w * 0.5 + along * y * len * 0.5;

  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  // Test against the scene at the near edge of the column, so terrain does not slice the sprite.
  vW = -(viewMatrix * vec4(center, 1.0)).z - 0.5 * w;
  vCorner = vec2(corner.x, y);
  vSide = height * cosE / len;
  // Texture in km on the sprite, scrolling at the rain's projected fall speed.
  vTex = vec2(corner.x * w * 0.5 + seed.w * 97.0, y * len * 0.5 - uTime * height * cosE / c.period);
  // Shipley et al. (1974) extinction, sigma = 0.16 R^0.74 per km, along a fixed path so overlapping tiers of
  // different sprite sizes add up to about the same haze: 4 km across a shaft, the column depth looking down.
  float path = mix(height / uCloudScale, 4.0, cosE);
  float opacity = 1.0 - exp(-0.16 * pow(c.rate, 0.74) * path);
  // Far curtains stand in for many drops; near ones only add mist.
  float near = smoothstep(10.0, 60.0, camDist);
  vAlpha = lod * opacity * mix(0.08, 1.0, near) * uStrength;
  vDark = smoothstep(0.5, 16.0, c.rate);
}
`;

export const veilFragmentShader = /* glsl */ `
${rainFragmentCommon}
in vec2 vCorner;
in float vAlpha;
flat in float vW;
in vec2 vTex;
in float vDark;
in float vSide;
uniform float uStreakScale;  // streaks per km across the curtain
out vec4 outColor;

void main() {
  float across = exp(-3.0 * vCorner.x * vCorner.x);
  // Seen from the side: a shaft with a feathered top where the rain leaves the cloud. From above: a soft spot.
  float y = vCorner.y;
  float shaft = smoothstep(-1.0, -0.4, y) * (1.0 - smoothstep(0.85, 1.0, y));  // y = -1 at the top
  float alongFade = mix(exp(-3.0 * y * y), shaft, vSide);
  // Streaks stretched along the fall, scrolling with it; shorter where the fall points at the camera.
  vec2 q = vTex * uStreakScale * vec2(1.0, 1.0 / mix(1.0, 8.0, vSide));
  float s = vnoise(q) * 0.6 + vnoise(q * vec2(2.3, 1.7) + 4.1) * 0.4;
  float streaks = mix(0.15, 1.0, smoothstep(0.35, 0.75, s));
  float a = vAlpha * across * alongFade * streaks * occlusion(vW);
  if (a < 0.002) discard;
  // Light rain is a pale blue-grey haze, heavy rain a dark grey curtain.
  vec3 color = mix(vec3(0.6, 0.66, 0.74), vec3(0.22, 0.25, 0.3), vDark);
  outColor = vec4(color, a);
}
`;

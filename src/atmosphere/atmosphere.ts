import * as THREE from 'three';
import type { Projection } from '../projection';
import { skyState, type SkyState } from './astronomy';
import { type LocalWeather, type WeatherSampler } from './localWeather';
import {
  BOTTOM_RADIUS,
  GROUND_ALBEDO,
  hazeForVisibility,
  luminance,
  MIE_EXTINCTION,
  MIE_SCALE,
  MIE_SCATTERING,
  OZONE_ABSORPTION,
  RAYLEIGH_SCALE,
  RAYLEIGH_SCATTERING,
  transmittanceToSpace,
  type Haze,
} from './medium';
import {
  AERIAL_PERSPECTIVE,
  aerialPerspectiveFragment,
  fullscreenVertex,
  multiScatteringFragment,
  skyFragment,
  skyVertex,
  skyViewFragment,
  transmittanceFragment,
} from './shaders';

const TRANSMITTANCE_SIZE = new THREE.Vector2(256, 64);
const SKY_VIEW_SIZE = new THREE.Vector2(192, 108);

/** The old fixed sun: 3.2 at 28 degrees. Materials and clouds were tuned against it, so it sets the scale. */
const REFERENCE_ELEVATION = THREE.MathUtils.degToRad(28);
const REFERENCE_SUN_INTENSITY = 3.2;
const REFERENCE_VISIBILITY = 30;
/** Full moon illuminance relative to the sun's (magnitude -12.7 against -26.7). */
const FULL_MOON = 2.5e-6;
/** Natural night sky (airglow, zodiacal light, starlight) plus some town glow, radiance relative to sunlight. */
const NIGHT_GLOW = new THREE.Vector3(1.6e-9, 1.8e-9, 2.6e-9);
/**
 * How strongly exposure follows the light (1 would make midnight as bright as noon): weakly down to deep twilight
 * (light 1/1000 of the reference), then strongly.
 */
const TWILIGHT_ADAPTATION = 0.6;
const TWILIGHT_KNEE = 1e3;
const ADAPTATION = 1.03;
const MAX_PRE_EXPOSURE = 3e6;
/** Highest the sky dome is drawn from, km. */
const SKY_MAX_ALTITUDE = 6;

/** Cloud lighting at the reference sun, as tuned in src/weather/clouds.ts. */
const CLOUD_SUN = new THREE.Vector3(1, 0.95, 0.88).multiplyScalar(30);
const CLOUD_AMBIENT_TOP = new THREE.Vector3(0.48, 0.57, 0.72);
const CLOUD_AMBIENT_BOTTOM = new THREE.Vector3(0.2, 0.22, 0.25);

/** What the cloud layer exposes for the atmosphere to light it and haze it. */
export interface CloudHookTarget {
  invalidate(): void;
  readonly lighting: { sunRadiance: THREE.Color; ambientTop: THREE.Color; ambientBottom: THREE.Color };
  readonly overlay: { cloudScale: number };
}

function lut(width: number, height: number, count = 1): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    count,
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    generateMipmaps: false,
  });
  for (const t of target.textures) {
    t.minFilter = t.magFilter = THREE.LinearFilter;
  }
  return target;
}

/** JS twin of SKY_VIEW_UV, for reading the LUT back. */
function skyViewUv(r: number, d: THREE.Vector3, l: THREE.Vector3): [number, number] {
  const B = BOTTOM_RADIUS;
  const vHorizon = Math.sqrt(Math.max((r - B) * (r + B), 0));
  const beta = Math.acos(THREE.MathUtils.clamp(vHorizon / r, -1, 1));
  const zenithHorizon = Math.PI - beta;
  const vza = Math.acos(THREE.MathUtils.clamp(d.y, -1, 1));
  const v =
    vza < zenithHorizon
      ? (1 - Math.sqrt(Math.max(1 - vza / zenithHorizon, 0))) * 0.5
      : Math.sqrt(THREE.MathUtils.clamp((vza - zenithHorizon) / Math.max(beta, 1e-5), 0, 1)) * 0.5 + 0.5;
  const dl = Math.hypot(d.x, d.z);
  const ll = Math.hypot(l.x, l.z);
  const cosLV = dl < 1e-5 || ll < 1e-5 ? 1 : (d.x * l.x + d.z * l.z) / (dl * ll);
  return [Math.sqrt(THREE.MathUtils.clamp(0.5 - 0.5 * cosLV, 0, 1)), v];
}

function sampleLut(data: Float32Array, w: number, h: number, u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
  const x = THREE.MathUtils.clamp(u * w - 0.5, 0, w - 1);
  const y = THREE.MathUtils.clamp(v * h - 0.5, 0, h - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0;
  const fy = y - y0;
  out.set(0, 0, 0);
  const add = (xi: number, yi: number, wt: number) => {
    const i = (yi * w + xi) * 4;
    out.x += data[i] * wt;
    out.y += data[i + 1] * wt;
    out.z += data[i + 2] * wt;
  };
  add(x0, y0, (1 - fx) * (1 - fy));
  add(x1, y0, fx * (1 - fy));
  add(x0, y1, (1 - fx) * fy);
  add(x1, y1, fx * fy);
  return out;
}

/** Cosine-weighted directions over the upper hemisphere, for sky irradiance. */
const IRRADIANCE_DIRECTIONS = (() => {
  const dirs: THREE.Vector3[] = [];
  const n = 160;
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    const phi = i * 2.399963;
    const r = Math.sqrt(u);
    dirs.push(new THREE.Vector3(r * Math.cos(phi), Math.sqrt(1 - u), r * Math.sin(phi)));
  }
  return dirs;
})();

/**
 * The sky and the air: a physically based atmosphere lit by the sun and moon for the time being viewed, haze from
 * UKV visibility, the cloud deck overhead greying the air and the light beneath it, sky light on every
 * MeshStandardMaterial through scene.environment, and an eye that adapts from noon to a moonlit night.
 *
 * Call update() every frame before the clouds render. The clouds take cloudHook at creation so their composite can
 * apply the aerial perspective and pre-exposure.
 */
export class Atmosphere {
  /** Direction of the key light (the sun by day, the moon by night), shared with the clouds and shadows. */
  readonly keyDirection: THREE.Vector3;
  readonly sunDirection = new THREE.Vector3(0, 1, 0);
  readonly moonDirection = new THREE.Vector3(0, -1, 0);
  /** Uniforms and GLSL the cloud layer merges into its shaders. */
  readonly cloudHook: { glsl: string; uniforms: Record<string, THREE.IUniform> };
  /** Multiplies every light so that night keeps precision in half floats; the eye adaptation. */
  preExposure = 1;
  /** The moment the sun and moon are placed for. */
  time = new Date();
  /** When true, time follows the weather data's valid time. */
  followData = true;
  private dataTime = new Date();
  sky?: SkyState;
  weather: LocalWeather = { cover: 0, base: 1e3, top: 1e3, keyLight: 1, visibility: REFERENCE_VISIBILITY };
  /** Materials with their own envMap (the sea) that should show this sky. */
  readonly envMaterials: THREE.MeshStandardMaterial[] = [];
  /** Optional: called whenever the sun or moon moves. */
  onSkyChange?: () => void;

  private readonly common: Record<string, THREE.IUniform>;
  private readonly transmittance = lut(TRANSMITTANCE_SIZE.x, TRANSMITTANCE_SIZE.y);
  private readonly multiScattering = lut(32, 32);
  private readonly skyViewSun = lut(SKY_VIEW_SIZE.x, SKY_VIEW_SIZE.y);
  private readonly skyViewMoon = lut(SKY_VIEW_SIZE.x, SKY_VIEW_SIZE.y);
  private readonly aerial = lut(1024, 32, 2);
  private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly transmittanceMaterial: THREE.ShaderMaterial;
  private readonly multiScatteringMaterial: THREE.ShaderMaterial;
  private readonly skyViewSunMaterial: THREE.ShaderMaterial;
  private readonly skyViewMoonMaterial: THREE.ShaderMaterial;
  private readonly aerialMaterial: THREE.ShaderMaterial;
  private readonly skyMaterial: THREE.ShaderMaterial;
  private readonly envSkyMaterial: THREE.ShaderMaterial;
  private readonly skyMesh: THREE.Mesh;
  private readonly envScene = new THREE.Scene();
  private readonly pmrem: THREE.PMREMGenerator;
  private envTarget?: THREE.WebGLRenderTarget;
  private envState = { sun: new THREE.Vector3(), moon: new THREE.Vector3(), cover: -1, exposure: 0, at: -1e9 };
  private haze: Haze = hazeForVisibility(REFERENCE_VISIBILITY, 0);
  private bakedHaze: Haze | undefined;
  private readonly sunIlluminance: THREE.Vector3;
  private readonly moonIlluminance = new THREE.Vector3();
  private skyIrradiance = new THREE.Vector3(0.5, 0.6, 0.8);
  private readonly referenceSkyIrradiance = new THREE.Vector3(0.5, 0.6, 0.8);
  private readonly referenceIlluminance: number;
  private readonly referenceSunGround: number;
  private readbackPending = false;
  private lastReadback = -1e9;
  private sampledAt = new THREE.Vector3(1e9, 0, 0);
  private skyAt = new THREE.Vector3(1e9, 0, 0);
  private skyTime = 0;
  private cloudExposure = 1;
  private cloudLit = { key: new THREE.Vector3(), sun: new THREE.Vector3(), top: new THREE.Vector3() };
  private clouds?: CloudHookTarget;
  private sampler?: WeatherSampler;
  private snap = true;
  private clock = 0;
  private keyIsMoon = false;
  private readonly displayLights: THREE.Color[] = [];

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly projection: Projection,
    private readonly light: THREE.DirectionalLight,
    keyDirection: THREE.Vector3,
  ) {
    this.keyDirection = keyDirection;
    this.light.userData.direction = keyDirection;
    this.common = {
      uTransmittanceLut: { value: this.transmittance.texture },
      uMultiScatteringLut: { value: this.multiScattering.texture },
      uRayleighScattering: { value: RAYLEIGH_SCATTERING.clone() },
      uRayleighScale: { value: RAYLEIGH_SCALE },
      uMieScattering: { value: MIE_SCATTERING },
      uMieExtinction: { value: MIE_EXTINCTION },
      uMieScale: { value: MIE_SCALE },
      uMieG: { value: 0.8 },
      uOzoneAbsorption: { value: OZONE_ABSORPTION.clone() },
      uGroundAlbedo: { value: GROUND_ALBEDO.clone() },
      uHazeExtinction: { value: 0 },
      uHazeAlbedo: { value: 0.95 },
      uHazeScale: { value: 1 },
      uHazeBase: { value: 0 },
      uCloudBase: { value: 1e3 },
      uCloudTop: { value: 1e3 + 1 },
      uUnderCloudLight: { value: 1 },
      uCloudAmbient: { value: new THREE.Vector3() },
    };

    // Scale: the sun at the reference elevation through clean air lights the ground as the old fixed light did.
    const refT = transmittanceToSpace(0.05, Math.sin(REFERENCE_ELEVATION), hazeForVisibility(REFERENCE_VISIBILITY, 0));
    const sunE = REFERENCE_SUN_INTENSITY / luminance(refT);
    this.sunIlluminance = new THREE.Vector3(sunE, sunE, sunE);
    this.referenceSunGround = REFERENCE_SUN_INTENSITY;

    const pass = (fragmentShader: string, extra: Record<string, THREE.IUniform> = {}) =>
      new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: fullscreenVertex,
        fragmentShader,
        uniforms: { ...this.common, ...extra },
        depthTest: false,
        depthWrite: false,
      });
    const lights = (count: number, ambient: number) => ({
      uLightDir: { value: [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0)] },
      uLightIlluminance: { value: [new THREE.Vector3(), new THREE.Vector3()] },
      uLightCount: { value: count },
      uAmbient: { value: ambient },
    });
    this.transmittanceMaterial = pass(transmittanceFragment, { uSize: { value: TRANSMITTANCE_SIZE } });
    this.multiScatteringMaterial = pass(multiScatteringFragment);
    const camAlt = { value: 0.05 };
    this.skyViewSunMaterial = pass(skyViewFragment, { ...lights(1, 1), uSize: { value: SKY_VIEW_SIZE }, uCamAlt: camAlt });
    this.skyViewMoonMaterial = pass(skyViewFragment, { ...lights(1, 0), uSize: { value: SKY_VIEW_SIZE }, uCamAlt: camAlt });
    this.aerialMaterial = pass(aerialPerspectiveFragment, {
      ...lights(2, 1),
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamAlt: { value: 0.05 },
      uMaxDist: { value: 100 },
      uFlatness: { value: 0 },
    });
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    const skyUniforms = {
      ...this.common,
      uSkyViewSun: { value: this.skyViewSun.texture },
      uSkyViewMoon: { value: this.skyViewMoon.texture },
      uSunDir: { value: this.sunDirection },
      uMoonDir: { value: this.moonDirection },
      uSunIlluminance: { value: this.sunIlluminance },
      uMoonRadius: { value: 0.0045 },
      uCamAlt: camAlt,
      uPreExposure: { value: 1 },
      uDiscs: { value: 1 },
      uEnvCloudCover: { value: 0 },
      uEnvCloudRadiance: { value: new THREE.Vector3() },
      uEquatorialToWorld: { value: new THREE.Matrix3() },
      uTime: { value: 0 },
      uNightGlow: { value: NIGHT_GLOW.clone().multiplyScalar(sunE) },
    };
    const skyMaterial = (overrides: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: skyVertex,
        fragmentShader: skyFragment,
        uniforms: { ...skyUniforms, ...overrides },
        side: THREE.BackSide,
        depthTest: false,
        depthWrite: false,
      });
    this.skyMaterial = skyMaterial({});
    // The environment: no discs or stars (the lights cast those), cloud cover folded in, its own exposure.
    this.envSkyMaterial = skyMaterial({ uDiscs: { value: 0 }, uPreExposure: { value: 1 } });
    const sphere = new THREE.SphereGeometry(1, 64, 32);
    this.skyMesh = new THREE.Mesh(sphere, this.skyMaterial);
    this.skyMesh.frustumCulled = false;
    // Drawn first, behind everything (its depth is not tested or written).
    this.skyMesh.renderOrder = -1;
    scene.add(this.skyMesh);
    const envMesh = new THREE.Mesh(sphere, this.envSkyMaterial);
    envMesh.frustumCulled = false;
    this.envScene.add(envMesh);
    this.pmrem = new THREE.PMREMGenerator(renderer);

    this.cloudHook = {
      glsl: AERIAL_PERSPECTIVE,
      uniforms: {
        uApInScatter: { value: this.aerial.textures[0] },
        uApTransmittance: { value: this.aerial.textures[1] },
        uApMaxDist: this.aerialMaterial.uniforms.uMaxDist,
        uApEnabled: { value: 1 },
        uPreExposure: skyUniforms.uPreExposure,
        uCloudExposure: { value: 1 },
      },
    };
    scene.environment = null;
    scene.fog = null;

    // Reference sky irradiance: the reference sun through clean air, read back once.
    this.setHaze(hazeForVisibility(REFERENCE_VISIBILITY, 0));
    this.bakeMedium();
    const refSun = new THREE.Vector3(Math.cos(REFERENCE_ELEVATION), Math.sin(REFERENCE_ELEVATION), 0);
    this.renderSkyView(this.skyViewSunMaterial, this.skyViewSun, refSun, this.sunIlluminance, 0.05);
    const pixels = new Float32Array(SKY_VIEW_SIZE.x * SKY_VIEW_SIZE.y * 4);
    renderer.readRenderTargetPixels(this.skyViewSun, 0, 0, SKY_VIEW_SIZE.x, SKY_VIEW_SIZE.y, pixels);
    this.irradianceFrom(pixels, undefined, refSun, refSun, 0.05, this.referenceSkyIrradiance);
    this.skyIrradiance.copy(this.referenceSkyIrradiance);
    this.referenceIlluminance = REFERENCE_SUN_INTENSITY * Math.sin(REFERENCE_ELEVATION) + luminance(this.referenceSkyIrradiance);
  }

  /** The cloud layer to light (sun or moon colour, sky ambient) and to tell when its lighting changes. */
  attachClouds(clouds: CloudHookTarget): void {
    this.clouds = clouds;
    this.cloudLit.key.set(0, 0, 0);
  }

  /** A display-space colour (the animated rain's) to scale with the light, since it is drawn after tone mapping. */
  attachDisplayLight(color: THREE.Color): void {
    this.displayLights.push(color);
  }

  attachWeather(sampler: WeatherSampler): void {
    this.sampler = sampler;
    this.sampledAt.set(1e9, 0, 0);
  }

  /** The weather fields changed (a new time step): resample the local weather. */
  weatherChanged(): void {
    this.sampler?.dataChanged();
    this.sampledAt.set(1e9, 0, 0);
  }

  /** The data's valid time; the sun and moon follow it unless the time has been set by hand. */
  setDataTime(time: Date): void {
    this.dataTime = new Date(time.getTime());
    if (this.followData) this.setTime(time, true);
  }

  /** Go back to following the data's time. */
  followDataTime(): void {
    this.followData = true;
    this.setTime(this.dataTime, true);
  }

  setTime(time: Date, fromData = false): void {
    if (!fromData) this.followData = false;
    this.time = new Date(time.getTime());
    this.skyAt.set(1e9, 0, 0);
  }

  /** Jump exposure to its target next frame instead of adapting, e.g. before a screenshot. */
  snapExposure(): void {
    this.snap = true;
  }

  get environment(): THREE.Texture | null {
    return this.envTarget?.texture ?? null;
  }

  private setHaze(haze: Haze): void {
    this.haze = haze;
    const u = this.common;
    u.uHazeExtinction.value = haze.extinction;
    u.uHazeAlbedo.value = haze.albedo;
    u.uHazeScale.value = haze.scale;
    u.uHazeBase.value = haze.base;
  }

  private draw(material: THREE.Material, target: THREE.WebGLRenderTarget): void {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  /** Transmittance and multiple scattering depend only on the medium. */
  private bakeMedium(): void {
    const previous = this.renderer.getRenderTarget();
    this.draw(this.transmittanceMaterial, this.transmittance);
    this.draw(this.multiScatteringMaterial, this.multiScattering);
    this.renderer.setRenderTarget(previous);
    this.bakedHaze = { ...this.haze };
  }

  private renderSkyView(
    material: THREE.ShaderMaterial,
    target: THREE.WebGLRenderTarget,
    dir: THREE.Vector3,
    illuminance: THREE.Vector3,
    camAlt: number,
  ): void {
    const u = material.uniforms;
    (u.uLightDir.value as THREE.Vector3[])[0].copy(dir);
    (u.uLightIlluminance.value as THREE.Vector3[])[0].copy(illuminance);
    u.uCamAlt.value = camAlt;
    const previous = this.renderer.getRenderTarget();
    this.draw(material, target);
    this.renderer.setRenderTarget(previous);
  }

  /** Cosine-weighted sky irradiance at the camera from read-back sky-view LUTs (physical units). */
  private irradianceFrom(
    sunPixels: Float32Array,
    moonPixels: Float32Array | undefined,
    sun: THREE.Vector3,
    moon: THREE.Vector3,
    camAlt: number,
    out: THREE.Vector3,
  ): THREE.Vector3 {
    const r = BOTTOM_RADIUS + Math.max(camAlt, 0.002);
    const { x: w, y: h } = SKY_VIEW_SIZE;
    const s = new THREE.Vector3();
    out.set(0, 0, 0);
    for (const d of IRRADIANCE_DIRECTIONS) {
      const [u, v] = skyViewUv(r, d, sun);
      out.add(sampleLut(sunPixels, w, h, u, v, s));
      if (moonPixels) {
        const [mu, mv] = skyViewUv(r, d, moon);
        out.add(sampleLut(moonPixels, w, h, mu, mv, s));
      }
    }
    return out.multiplyScalar(Math.PI / IRRADIANCE_DIRECTIONS.length);
  }

  private readBackIrradiance(camAlt: number): void {
    if (this.readbackPending || this.clock - this.lastReadback < 0.4) return;
    this.readbackPending = true;
    this.lastReadback = this.clock;
    const { x: w, y: h } = SKY_VIEW_SIZE;
    const sunPixels = new Float32Array(w * h * 4);
    const moonPixels = new Float32Array(w * h * 4);
    const sun = this.sunDirection.clone();
    const moon = this.moonDirection.clone();
    Promise.all([
      this.renderer.readRenderTargetPixelsAsync(this.skyViewSun, 0, 0, w, h, sunPixels),
      this.renderer.readRenderTargetPixelsAsync(this.skyViewMoon, 0, 0, w, h, moonPixels),
    ])
      .then(() => {
        this.irradianceFrom(sunPixels, moonPixels, sun, moon, camAlt, this.skyIrradiance);
      })
      .catch((error) => console.warn('Sky irradiance read-back failed', error))
      .finally(() => (this.readbackPending = false));
  }

  private updateSky(camPos: THREE.Vector3): void {
    const moved = Math.hypot(camPos.x - this.skyAt.x, camPos.z - this.skyAt.z) > 20;
    if (!moved && this.skyTime === this.time.getTime()) return;
    this.skyAt.copy(camPos);
    this.skyTime = this.time.getTime();
    const { lon, lat } = this.projection.toLonLat(camPos.x, camPos.z);
    // True north and east here, in world space: the grid is rotated from them away from the projection's centre.
    const here = this.projection.toWorld(lon, lat);
    const up = this.projection.toWorld(lon, lat + 0.01);
    const north = new THREE.Vector3(up.x - here.x, 0, up.z - here.z).normalize();
    const east = new THREE.Vector3(-north.z, 0, north.x);
    this.sky = skyState(this.time, lon, lat, north, east);
    this.sunDirection.copy(this.sky.sun);
    this.moonDirection.copy(this.sky.moon);
    const u = this.skyMaterial.uniforms;
    u.uMoonRadius.value = this.sky.moonRadius;
    (u.uEquatorialToWorld.value as THREE.Matrix3).copy(this.sky.equatorialToWorld);
    // Moonlight: the full moon's share of sunlight, falling off with phase (Allen's magnitude law).
    const alpha = THREE.MathUtils.radToDeg(this.sky.moonPhaseAngle);
    const phase = Math.pow(10, -0.4 * (0.026 * alpha + 4e-9 * Math.pow(alpha, 4)));
    // Moonlight is a touch redder than sunlight, but the dark-adapted eye sees moonlit scenes blue (the Purkinje
    // shift); lean blue.
    this.moonIlluminance.set(0.8, 0.9, 1.0).multiplyScalar(this.sunIlluminance.x * FULL_MOON * phase);
    this.onSkyChange?.();
  }

  private updateWeather(camPos: THREE.Vector3, groundY: number, cloudScale: number, dt: number): void {
    if (this.sampler && camPos.distanceTo(this.sampledAt) > 0.3) {
      this.sampledAt.copy(camPos);
      const target = this.sampler.sample(camPos.x, camPos.z, camPos.y - groundY, this.keyDirection, cloudScale);
      if (this.snap) this.weather = target;
      else {
        // Ease towards the new spot so lighting does not pop as the camera crosses grid cells.
        const k = 1 - Math.exp(-dt / 0.4);
        const w = this.weather;
        w.cover += (target.cover - w.cover) * k;
        w.keyLight += (target.keyLight - w.keyLight) * k;
        w.base = target.base;
        w.top = target.top;
        w.visibility = Math.exp(Math.log(w.visibility) + (Math.log(target.visibility) - Math.log(w.visibility)) * k);
        // Keep easing while it settles.
        if (Math.abs(target.cover - w.cover) > 0.01 || Math.abs(target.keyLight - w.keyLight) > 0.01) this.sampledAt.set(1e9, 0, 0);
      }
    }
    const haze = hazeForVisibility(this.weather.visibility, groundY);
    this.setHaze(haze);
    const b = this.bakedHaze;
    if (
      !b ||
      Math.abs(haze.extinction - b.extinction) > 0.03 * b.extinction + 0.002 ||
      Math.abs(haze.base - b.base) > 0.05 ||
      Math.abs(haze.scale - b.scale) > 0.03
    ) {
      this.bakeMedium();
    }
  }

  /** Per frame: place the lights, sample the weather, render the LUTs, adapt the exposure, light the clouds. */
  update(dt: number, groundY: number): void {
    this.clock += dt;
    const camPos = this.camera.getWorldPosition(new THREE.Vector3());
    const camAlt = Math.max(camPos.y, 0.002);
    const cloudScale = this.clouds?.overlay.cloudScale ?? 3;
    this.updateSky(camPos);
    this.updateWeather(camPos, groundY, cloudScale, dt);

    // The key light: the sun until it is well down, then the moon.
    const sunUp = this.sunDirection.y > -0.07;
    this.keyIsMoon = !sunUp;
    this.keyDirection.copy(sunUp ? this.sunDirection : this.moonDirection);
    const keyTop = sunUp ? this.sunIlluminance : this.moonIlluminance;
    const keyGround = transmittanceToSpace(camAlt, this.keyDirection.y, this.haze).multiply(keyTop);
    // The disc sinking below the horizon.
    keyGround.multiplyScalar(THREE.MathUtils.smoothstep(this.keyDirection.y, -0.006, 0.006));

    const w = this.weather;
    const c = this.common;
    c.uCloudBase.value = groundY + w.base;
    c.uCloudTop.value = groundY + Math.max(w.top, w.base + 0.2);
    c.uUnderCloudLight.value = THREE.MathUtils.lerp(1, w.keyLight, Math.min(w.cover * 1.5, 1));
    // The cloud base's grey light: the sun's diffuse transmission through the deck plus the sky's, spread over the
    // hemisphere below it.
    const keyHoriz = luminance(keyGround) * Math.max(this.keyDirection.y, 0);
    const skyLum = luminance(this.skyIrradiance);
    const baseRadiance = ((keyHoriz * 0.35 + skyLum * 0.6) / Math.PI) * w.cover;
    const cloudRadiance = new THREE.Vector3(0.97, 0.99, 1.03).multiplyScalar(baseRadiance / Math.max(w.cover, 1e-3));
    (c.uCloudAmbient.value as THREE.Vector3).set(0.97, 0.99, 1.03).multiplyScalar(baseRadiance * 0.5);

    // Exposure: follow the light at the ground, part way, with an eye's few seconds to adapt.
    const direct = keyHoriz * THREE.MathUtils.lerp(1, w.keyLight * 0.6 + 0.15, w.cover);
    const skyLight = THREE.MathUtils.lerp(skyLum, baseRadiance * Math.PI * 1.2, w.cover);
    const glow = Math.PI * luminance(NIGHT_GLOW) * this.sunIlluminance.x;
    const ground = Math.max(direct + skyLight + glow, 1e-12);
    const ratio = this.referenceIlluminance / ground;
    // Through twilight the eye adapts only part way (dusk should look like dusk); deeper into the night it keeps
    // adapting almost fully, so moonlight is dark but readable.
    const lr = Math.log(ratio);
    const knee = Math.log(TWILIGHT_KNEE);
    const adapted = lr <= 0 ? 0.4 * lr : lr <= knee ? TWILIGHT_ADAPTATION * lr : TWILIGHT_ADAPTATION * knee + ADAPTATION * (lr - knee);
    const target = THREE.MathUtils.clamp(Math.exp(adapted), 0.3, MAX_PRE_EXPOSURE);
    if (this.snap) this.preExposure = target;
    else this.preExposure = Math.exp(Math.log(this.preExposure) + (Math.log(target) - Math.log(this.preExposure)) * (1 - Math.exp(-dt / 0.9)));
    this.snap = false;
    const p = this.preExposure;
    // How bright the scene looks after adaptation, for things drawn after tone mapping, tinted by the light.
    const shown = Math.min(Math.pow((ground * p) / this.referenceIlluminance, 0.7), 1.2);
    const tint = new THREE.Vector3().copy(keyGround).multiplyScalar(Math.max(this.keyDirection.y, 0)).add(this.skyIrradiance);
    tint.divideScalar(Math.max(tint.x, tint.y, tint.z, 1e-30));
    // Only a hint of the light's colour: fully tinted, the rain's blue-grey goes navy under a blue twilight sky.
    tint.lerp(new THREE.Vector3(1, 1, 1), 0.65);
    if (this.keyIsMoon) tint.lerp(new THREE.Vector3(0.8, 0.86, 1.0), 0.3);
    for (const c of this.displayLights) c.setRGB(tint.x * shown, tint.y * shown, tint.z * shown);
    this.skyMaterial.uniforms.uPreExposure.value = p;
    this.skyMaterial.uniforms.uTime.value = this.clock;

    // The light the scene's materials see.
    const keyLum = luminance(keyGround);
    this.light.intensity = keyLum * p;
    if (keyLum > 0) this.light.color.setRGB(keyGround.x / keyLum, keyGround.y / keyLum, keyGround.z / keyLum);
    if (this.keyIsMoon) this.light.color.lerp(new THREE.Color(0.75, 0.82, 1.0), 0.35);
    // Relative to the target, which the detailed terrain moves to the camera for its shadows.
    this.light.target.updateMatrixWorld();
    this.light.position.setFromMatrixPosition(this.light.target.matrixWorld).addScaledVector(this.keyDirection, 1000);

    // LUTs for this frame. The map camera sits hundreds of km up, which would put the sky dome in space above a
    // map that is only a few km thick; the dome is drawn as if from no higher than a light aircraft.
    const skyAlt = Math.min(camAlt, SKY_MAX_ALTITUDE);
    this.renderSkyView(this.skyViewSunMaterial, this.skyViewSun, this.sunDirection, this.sunIlluminance, skyAlt);
    this.renderSkyView(this.skyViewMoonMaterial, this.skyViewMoon, this.moonDirection, this.moonIlluminance, skyAlt);
    this.renderAerialPerspective(camAlt);
    this.readBackIrradiance(skyAlt);

    this.updateEnvironment(w.cover, cloudRadiance);
    this.lightClouds(keyGround);
  }

  private renderAerialPerspective(camAlt: number): void {
    this.camera.updateMatrixWorld();
    const u = this.aerialMaterial.uniforms;
    (u.uInvProj.value as THREE.Matrix4).copy(this.camera.projectionMatrixInverse);
    (u.uCamWorld.value as THREE.Matrix4).copy(this.camera.matrixWorld);
    u.uCamAlt.value = camAlt;
    // Far enough to reach full haze near the ground, or the far side of the map from high up.
    u.uMaxDist.value = THREE.MathUtils.clamp(Math.max(4 * this.weather.visibility, 20 + 8 * camAlt), 2, 4000);
    u.uFlatness.value = THREE.MathUtils.smoothstep(camAlt, 5, 50);
    const dirs = u.uLightDir.value as THREE.Vector3[];
    const ills = u.uLightIlluminance.value as THREE.Vector3[];
    dirs[0].copy(this.sunDirection);
    ills[0].copy(this.sunIlluminance);
    dirs[1].copy(this.moonDirection);
    ills[1].copy(this.moonIlluminance);
    const previous = this.renderer.getRenderTarget();
    this.draw(this.aerialMaterial, this.aerial);
    this.renderer.setRenderTarget(previous);
  }

  /** Re-bakes the prefiltered sky for scene.environment when the sky has changed enough to see. */
  private updateEnvironment(cover: number, cloudRadiance: THREE.Vector3): void {
    const s = this.envState;
    const p = this.preExposure;
    const stale =
      !this.envTarget ||
      s.sun.angleTo(this.sunDirection) > 0.01 ||
      s.moon.angleTo(this.moonDirection) > 0.02 ||
      Math.abs(s.cover - cover) > 0.04 ||
      p / s.exposure > 20 ||
      s.exposure / p > 20;
    if (!stale || (this.clock - s.at < 0.25 && this.envTarget)) {
      this.applyEnvironmentIntensity();
      return;
    }
    s.sun.copy(this.sunDirection);
    s.moon.copy(this.moonDirection);
    s.cover = cover;
    s.exposure = p;
    s.at = this.clock;
    const u = this.envSkyMaterial.uniforms;
    u.uPreExposure.value = p;
    u.uEnvCloudCover.value = Math.min(cover * 1.1, 1);
    (u.uEnvCloudRadiance.value as THREE.Vector3).copy(cloudRadiance);
    const previous = this.renderer.getRenderTarget();
    const target = this.pmrem.fromScene(this.envScene, 0, 0.1, 100);
    this.renderer.setRenderTarget(previous);
    this.envTarget?.dispose();
    this.envTarget = target;
    this.applyEnvironmentIntensity();
  }

  private applyEnvironmentIntensity(): void {
    const scene = this.skyMesh.parent as THREE.Scene | null;
    if (!scene || !this.envTarget) return;
    const intensity = this.preExposure / this.envState.exposure;
    scene.environment = this.envTarget.texture;
    scene.environmentIntensity = intensity;
    for (const m of this.envMaterials) {
      m.envMap = this.envTarget.texture;
      m.envMapIntensity = intensity;
    }
  }

  /** Sets the clouds' sun, sky and ground light, re-lighting (and re-converging) only when it really changes. */
  private lightClouds(keyGround: THREE.Vector3): void {
    const clouds = this.clouds;
    if (!clouds) return;
    const p = this.preExposure;
    const sunScale = new THREE.Vector3().copy(keyGround).divideScalar(this.referenceSunGround);
    const top = new THREE.Vector3()
      .copy(this.skyIrradiance)
      .divide(this.referenceSkyIrradiance)
      .addScaledVector(new THREE.Vector3(1, 1, 1), (luminance(NIGHT_GLOW) * this.sunIlluminance.x) / luminance(this.referenceSkyIrradiance));
    const lit = this.cloudLit;
    const ratio = p / this.cloudExposure;
    const changed =
      lit.key.angleTo(this.keyDirection) > 0.003 ||
      lit.key.lengthSq() === 0 ||
      Math.abs(luminance(sunScale) - luminance(lit.sun)) > 0.04 * luminance(lit.sun) + 1e-12 ||
      Math.abs(luminance(top) - luminance(lit.top)) > 0.06 * luminance(lit.top) + 1e-12 ||
      ratio > 3 ||
      ratio < 1 / 3;
    if (!changed) return;
    lit.key.copy(this.keyDirection);
    lit.sun.copy(sunScale);
    lit.top.copy(top);
    this.cloudExposure = p;
    this.cloudHook.uniforms.uCloudExposure.value = p;
    const { sunRadiance, ambientTop, ambientBottom } = clouds.lighting;
    const s = new THREE.Vector3().copy(CLOUD_SUN).multiply(sunScale).multiplyScalar(p);
    sunRadiance.setRGB(s.x, s.y, s.z);
    const t = new THREE.Vector3().copy(CLOUD_AMBIENT_TOP).multiply(top).multiplyScalar(p);
    ambientTop.setRGB(t.x, t.y, t.z);
    const groundLight = (luminance(sunScale) * Math.max(this.keyDirection.y, 0)) / Math.sin(REFERENCE_ELEVATION) * 0.5 + luminance(top) * 0.5;
    const b = new THREE.Vector3().copy(CLOUD_AMBIENT_BOTTOM).multiplyScalar(groundLight * p);
    ambientBottom.setRGB(b.x, b.y, b.z);
    clouds.invalidate();
  }
}

/** Adds the time-of-day control (sun and moon) to the HUD. */
export function mountAtmosphereControls(hud: HTMLElement, atmosphere: Atmosphere): void {
  const box = document.createElement('div');
  box.innerHTML = `
    <label>Time of day <input type="range" min="0" max="1439" step="1" /> <output></output></label>
    <label><input type="checkbox" checked /> Follow the weather's time</label>
    <p class="hint"></p>`;
  const [slider, follow] = Array.from(box.querySelectorAll('input'));
  const output = box.querySelector('output')!;
  const hint = box.querySelector('p')!;
  const day = () => {
    const t = atmosphere.time;
    return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  };
  const describe = () => {
    const t = atmosphere.time;
    slider.value = String(t.getUTCHours() * 60 + t.getUTCMinutes());
    output.textContent = `${t.toISOString().slice(11, 16)} UTC`;
    follow.checked = atmosphere.followData;
    const sky = atmosphere.sky;
    if (!sky) return;
    const deg = (v: THREE.Vector3) => Math.round(THREE.MathUtils.radToDeg(Math.asin(v.y)));
    const lit = Math.round(sky.moonIllumination * 100);
    hint.textContent = `${t.toISOString().slice(0, 10)}: sun ${deg(sky.sun)}°, moon ${deg(sky.moon)}° (${lit}% lit).`;
  };
  slider.addEventListener('input', () => {
    atmosphere.setTime(new Date(day() + Number(slider.value) * 60e3));
    describe();
  });
  follow.addEventListener('change', () => {
    if (follow.checked) atmosphere.followDataTime();
    else atmosphere.followData = false;
    describe();
  });
  atmosphere.onSkyChange = describe;
  hud.appendChild(box);
  describe();
}

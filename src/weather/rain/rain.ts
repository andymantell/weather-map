import * as THREE from 'three';
import type { Heightmap } from '../../heightmap';
import { terrainTexture, type CloudLayer, type UkvCloudData } from '../clouds';
import { streakFragmentShader, streakVertexShader, veilFragmentShader, veilVertexShader } from './rainShaders';

/** One LOD tier: particles wrapped in a box of `tile` km around the camera, meant for views about `dist` km away. */
interface Tier {
  dist: number;
  count: number;
}

// Tiers are spaced by 3x in distance, matching the hat weights in the shaders.
const STREAK_TIERS: Tier[] = [0.02, 0.06, 0.2, 0.6, 2, 6, 18, 54, 162].map((dist) => ({ dist, count: 60000 }));
const VEIL_TIERS: Tier[] = [30, 90, 270, 810].map((dist) => ({ dist, count: 40000 }));
// A wrap box never needs to be bigger than the data (about 1100 x 1400 km) seen from anywhere over it.
const MAX_TILE = 2200;

function tierGeometry(count: number, seed: number): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('corner', new THREE.Float32BufferAttribute([-1, 0, 1, 0, 1, 1, -1, 1], 2));
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  // SplitMix32, so each tier has its own scatter and screenshots repeat.
  let s = Math.imul(seed, 0x9e3779b9) | 0;
  const random = () => {
    s = (s + 0x9e3779b9) | 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return ((z ^ (z >>> 16)) >>> 0) / 4294967296;
  };
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = random();
  geometry.setAttribute('seed', new THREE.InstancedBufferAttribute(seeds, 4));
  geometry.instanceCount = count;
  return geometry;
}

export interface RainLayer {
  enabled: boolean;
  /** Draws the rain over what is already on screen; call after the clouds have rendered. */
  render(): void;
  setStrength(value: number): void;
  /** How much of the rain behind cloud still shows, 0 to 1. */
  setThroughCloud(value: number): void;
  /** Shows or hides the curtains and the drops, for comparing them. */
  setParts(veils: boolean, streaks: boolean): void;
  /** Multiplies the rain's colour (display space), for the time of day; src/atmosphere sets it. */
  readonly light: THREE.Color;
}

/**
 * Animated rain from the UKV precipitation rate: falling streaks for close and middle views, and scrolling rain
 * curtains for the overview. Drawn after the cloud composite, tested against the scene depth by hand, and dimmed
 * where cloud lies over it. See docs/animated-rain.md.
 */
export function createRainLayer(
  renderer: THREE.WebGLRenderer,
  camera: THREE.PerspectiveCamera,
  clouds: CloudLayer,
  data: UkvCloudData,
  heightmap: Heightmap,
  /** Ground height (world y, km) under a point, for how fast to run the rain; defaults to the coarse heightmap. */
  groundAt?: (x: number, z: number) => number,
): RainLayer {
  const { grid } = data.meta;
  const hm = heightmap.meta;
  const size = new THREE.Vector2();
  const shared = {
    uFields: { value: data.fields },
    uTerrain: { value: terrainTexture(heightmap) },
    uGridWest: { value: new THREE.Vector2(grid.x_west, grid.y_north) },
    uGridSize: { value: new THREE.Vector2(grid.width, grid.height) },
    uGridDx: { value: grid.dx },
    uTerrainBox: { value: new THREE.Vector4(hm.xMin, hm.xMax, hm.yMin, hm.yMax) },
    uTerrainSize: { value: new THREE.Vector2(hm.width, hm.height) },
    uExaggeration: { value: 1 },
    uCloudScale: { value: 3 },
    uRainClock: { value: 0 },
    uLapse: { value: 1 },
    // Drift with a south-westerly wind, as fronts usually come in over the UK.
    uWind: { value: new THREE.Vector2(0.18, -0.12) },
    uStrength: { value: 1 },
    uDepth: { value: null as THREE.Texture | null },
    uCloud: { value: null as THREE.Texture | null },
    uViewport: { value: new THREE.Vector2(1, 1) },
    uFar: { value: camera.far },
    uCloudOpacity: { value: 0.75 },
    uThroughCloud: { value: 0.6 },
    uPixel: { value: 1e-3 },
    uLight: { value: new THREE.Color(1, 1, 1) },
  };

  const scene = new THREE.Scene();
  const addTier = (tier: Tier, index: number, kind: 'veil' | 'streak') => {
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: kind === 'veil' ? veilVertexShader : streakVertexShader,
      fragmentShader: kind === 'veil' ? veilFragmentShader : streakFragmentShader,
      uniforms: {
        ...shared,
        uTile: { value: Math.min(tier.dist * 6, MAX_TILE) },
        uDist: { value: tier.dist },
        uWidth: { value: tier.dist * 0.04 },
        uStreakScale: { value: 14 / (tier.dist * 0.04) },
        uFirst: { value: index === 0 ? 1 : 0 },
      },
      transparent: true,
      // Sprites are built facing the camera either way round.
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });
    const mesh = new THREE.Mesh(tierGeometry(tier.count, (kind === 'veil' ? 1000 : 0) + index + 1), material);
    mesh.frustumCulled = false;
    // Curtains first, so drops draw over them.
    mesh.renderOrder = kind === 'veil' ? 0 : 1;
    scene.add(mesh);
  };
  VEIL_TIERS.forEach((t, i) => addTier(t, i, 'veil'));
  STREAK_TIERS.forEach((t, i) => addTier(t, i, 'streak'));

  const coarseGround = (x: number, z: number) => {
    const c = Math.round(((x * 1000 - hm.xMin) / (hm.xMax - hm.xMin)) * (hm.width - 1));
    const r = Math.round(((hm.yMax + z * 1000) / (hm.yMax - hm.yMin)) * (hm.height - 1));
    if (c < 0 || r < 0 || c >= hm.width || r >= hm.height) return 0;
    return (Math.max(heightmap.heights[r * hm.width + c], 0) / 1000) * shared.uExaggeration.value;
  };
  const ground = groundAt ?? coarseGround;
  let last = performance.now();

  const layer: RainLayer = {
    enabled: true,
    light: shared.uLight.value,
    setStrength(value) {
      shared.uStrength.value = value;
    },
    setThroughCloud(value) {
      shared.uThroughCloud.value = value;
    },
    setParts(veils, streaks) {
      for (const mesh of scene.children) mesh.visible = mesh.renderOrder === 0 ? veils : streaks;
    },
    render() {
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      // The scene depth and the rain's column heights come from the cloud layer, so rain goes with it.
      if (!layer.enabled || !clouds.enabled) return;
      const overlay = clouds.overlay;
      shared.uDepth.value = overlay.depth;
      shared.uCloud.value = overlay.cloud;
      shared.uCloudOpacity.value = overlay.opacity;
      shared.uCloudScale.value = overlay.cloudScale;
      shared.uExaggeration.value = overlay.exaggeration;
      // Near real time on the ground; sped up from higher views, where real drops would barely move.
      const above = Math.max(camera.position.y - ground(camera.position.x, camera.position.z), 0.01);
      shared.uLapse.value = THREE.MathUtils.clamp(80 * above, 2, 250);
      shared.uRainClock.value += dt * shared.uLapse.value;
      shared.uFar.value = camera.far;
      renderer.getDrawingBufferSize(size);
      shared.uViewport.value.copy(size);
      shared.uPixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / size.y;

      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      renderer.autoClear = autoClear;
    },
  };
  return layer;
}

/** Adds the rain switch, strength and through-cloud sliders to the HUD. */
export function mountRainControls(hud: HTMLElement, layer: RainLayer): void {
  const box = document.createElement('div');
  box.innerHTML = `
    <label><input type="checkbox" checked /> Animated rain</label>
    <label>Rain strength <input type="range" min="0.25" max="2" step="0.05" value="1" /> <output>1</output></label>
    <label>Rain through cloud <input type="range" min="0" max="1" step="0.05" value="0.6" /> <output>0.6</output></label>`;
  const [toggle, strength, through] = Array.from(box.querySelectorAll('input'));
  const [strengthOutput, throughOutput] = Array.from(box.querySelectorAll('output'));
  toggle.addEventListener('change', () => (layer.enabled = toggle.checked));
  strength.addEventListener('input', () => {
    layer.setStrength(Number(strength.value));
    strengthOutput.textContent = strength.value;
  });
  through.addEventListener('input', () => {
    layer.setThroughCloud(Number(through.value));
    throughOutput.textContent = through.value;
  });
  hud.appendChild(box);
}

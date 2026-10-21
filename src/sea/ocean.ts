import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import type { Heightmap } from '../heightmap';
import {
  TILE,
  fragmentMain,
  fragmentPars,
  opaqueFragment,
  vertexMain,
  vertexPars,
} from './oceanShader';
import { loadWaveField, type WaveField } from './waveField';

/** cos^2s(Δθ/2) spreading exponents: broad wind sea, narrow swell. */
const SPREAD_WIND_SEA = 4;
const SPREAD_SWELL = 16;

/** Normalises cos^2s(θ/2) so it integrates to 1 over a full circle. */
function spreadNorm(s: number): number {
  const n = 2048;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const th = -Math.PI + ((i + 0.5) / n) * 2 * Math.PI;
    sum += Math.pow(Math.cos(th / 2), 2 * s);
  }
  return 1 / (sum * ((2 * Math.PI) / n));
}

// Must match src/terrain.ts, so the surf follows the coastline the terrain mesh draws.
const TERRAIN_STRIDE = 2;
const TERRAIN_LAND_LIFT = 5;
const TERRAIN_SEABED_DROP = 20;

/**
 * Half-float RG texture on the terrain mesh's vertex grid: R = real height (m),
 * G = the mesh's height (m), whose zero crossing is the drawn coastline.
 */
function createDepthTexture({ meta, heights }: Heightmap): THREE.DataTexture {
  const cols = Math.floor((meta.width - 1) / TERRAIN_STRIDE) + 1;
  const rows = Math.floor((meta.height - 1) / TERRAIN_STRIDE) + 1;
  const data = new Uint16Array(cols * rows * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const h = heights[r * TERRAIN_STRIDE * meta.width + c * TERRAIN_STRIDE];
      const i = (r * cols + c) * 2;
      data[i] = THREE.DataUtils.toHalfFloat(h);
      data[i + 1] = THREE.DataUtils.toHalfFloat(h > 0 ? h + TERRAIN_LAND_LIFT : h - TERRAIN_SEABED_DROP);
    }
  }
  const texture = new THREE.DataTexture(data, cols, rows, THREE.RGFormat, THREE.HalfFloatType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** A prefiltered copy of the sky, without the sun disc (the sun light draws the glint). */
function createSkyEnvironment(renderer: THREE.WebGLRenderer, sky: Sky): THREE.Texture {
  const envSky = new Sky();
  envSky.scale.setScalar(1000);
  for (const [name, uniform] of Object.entries(sky.material.uniforms)) {
    const value = uniform.value as unknown;
    envSky.material.uniforms[name].value =
      value && typeof (value as THREE.Vector3).clone === 'function' ? (value as THREE.Vector3).clone() : value;
  }
  envSky.material.uniforms.showSunDisc.value = 0;
  const envScene = new THREE.Scene();
  envScene.add(envSky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(envScene, 0, 0.1, 2000);
  pmrem.dispose();
  envSky.geometry.dispose();
  envSky.material.dispose();
  return target.texture;
}

export interface Ocean {
  mesh: THREE.Mesh;
  field: WaveField;
  material: THREE.MeshPhysicalMaterial;
  uniforms: Record<string, THREE.IUniform>;
}

/**
 * The live sea surface: Met Office UK wave model sea state driving a spectral
 * wave shader with sky reflections, sun glint, whitecaps and surf.
 */
export async function createOcean(
  renderer: THREE.WebGLRenderer,
  heightmap: Heightmap,
  sky: Sky,
  baseUrl: string,
): Promise<Ocean> {
  const field = await loadWaveField(baseUrl);
  const { meta } = heightmap;
  const { grid, scale } = field.meta;

  const uniformsDepth = createDepthTexture(heightmap);
  const uniforms: Record<string, THREE.IUniform> = {
    uWindSea: { value: field.windSea },
    uSwell: { value: field.swell },
    uPeriod: { value: field.period },
    uDepth: { value: uniformsDepth },
    uWaveGrid: {
      value: new THREE.Vector4(grid.x_west_edge, grid.y_north_edge, grid.width * grid.spacing, grid.height * grid.spacing),
    },
    uDepthGrid: { value: new THREE.Vector4(meta.xMin, meta.yMax, meta.spacing * TERRAIN_STRIDE, 0) },
    uDepthSize: { value: new THREE.Vector2(uniformsDepth.image.width, uniformsDepth.image.height) },
    uWaveScaleBytes: { value: new THREE.Vector3(scale.hs, scale.tp, scale.wind) },
    uOrigin: { value: new THREE.Vector2() },
    uTime: { value: 0 },
    uWaveScale: { value: 1 },
    uSpread: { value: new THREE.Vector2(SPREAD_WIND_SEA, SPREAD_SWELL) },
    uSpreadNorm: { value: new THREE.Vector2(spreadNorm(SPREAD_WIND_SEA), spreadNorm(SPREAD_SWELL)) },
    uFoam: { value: 1 },
    uSurf: { value: 1 },
    uGlint: { value: 6 },
    uShallowColour: { value: new THREE.Color('#2f7f86') },
    uDeepColour: { value: new THREE.Color('#0a2a3d') },
  };

  const material = new THREE.MeshPhysicalMaterial({
    color: '#0a2a3d',
    metalness: 0,
    roughness: 0.3,
    ior: 1.333,
    envMap: createSkyEnvironment(renderer, sky),
    // The Sky shader is much brighter than the sunlit land; tone its reflection down to match.
    envMapIntensity: 0.3,
    transparent: true,
    // Premultiplied output (see opaqueFragment).
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexPars}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${vertexMain}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentPars}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${fragmentMain}`)
      .replace('#include <opaque_fragment>', opaqueFragment)
      // Fog towards a premultiplied fog colour.
      .replace(
        '#include <fog_fragment>',
        THREE.ShaderChunk.fog_fragment.replace('fogColor, fogFactor', 'fogColor * gl_FragColor.a, fogFactor'),
      );
  };

  const geometry = new THREE.PlaneGeometry((meta.xMax - meta.xMin) / 1000, (meta.yMax - meta.yMin) / 1000);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate((meta.xMin + meta.xMax) / 2000, 0, -(meta.yMin + meta.yMax) / 2000);
  const mesh = new THREE.Mesh(geometry, material);
  // Draw before other see-through layers (rain, cloud) so they composite over the sea.
  mesh.renderOrder = -0.5;

  const start = performance.now();
  mesh.onBeforeRender = (_renderer, _scene, camera) => {
    uniforms.uTime.value = (performance.now() - start) / 1000;
    // Keep the shader's origin near the camera, on the wave lattice.
    const period = TILE * uniforms.uWaveScale.value;
    uniforms.uOrigin.value.set(
      Math.floor((camera.position.x * 1000) / period) * period,
      Math.floor((-camera.position.z * 1000) / period) * period,
    );
  };

  return { mesh, field, material, uniforms };
}

/** Adds the sea controls to the HUD, after the rain controls. */
export function mountSeaControls(hud: HTMLElement, ocean: Ocean, flatSea: THREE.Object3D) {
  const box = document.createElement('div');
  box.className = 'sea-controls';
  const valid = new Date(ocean.field.meta.valid_time).toISOString().slice(0, 16).replace('T', ' ');
  box.innerHTML = `
    <label><input type="checkbox" data-sea="live" checked /> Live sea state</label>
    <label>Wave size <input type="range" data-sea="scale" min="1" max="60" step="1" value="1" />
      <output data-sea="scale-value">1×</output></label>
    <p class="hint">Met Office UK wave model, valid ${valid} UTC. ${ocean.field.meta.attribution}.</p>
  `;
  const hint = hud.querySelector('.hint:last-of-type');
  hud.insertBefore(box, hint);

  const live = box.querySelector<HTMLInputElement>('[data-sea="live"]')!;
  const scale = box.querySelector<HTMLInputElement>('[data-sea="scale"]')!;
  const scaleValue = box.querySelector<HTMLOutputElement>('[data-sea="scale-value"]')!;
  const apply = () => {
    ocean.mesh.visible = live.checked;
    flatSea.visible = !live.checked;
    ocean.uniforms.uWaveScale.value = Number(scale.value);
    scaleValue.textContent = `${scale.value}×`;
  };
  live.addEventListener('change', apply);
  scale.addEventListener('input', apply);
  apply();
}

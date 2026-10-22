import * as THREE from 'three';
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

/** cos^2s(Δθ/2) spreading exponents [wind sea, swell]: broad wind sea, narrow swell. */
const SPREAD_REALISTIC: [number, number] = [4, 16];
/** Stylised waves are more long-crested, so their direction reads at a glance. */
const SPREAD_STYLISED: [number, number] = [10, 40];

/** Stylised defaults: waves ~150x real size and 5x steeper. */
export const STYLISED_SIZE = 150;
export const STYLISED_STEEPNESS = 5;

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

export interface Ocean {
  mesh: THREE.Mesh;
  field: WaveField;
  material: THREE.MeshPhysicalMaterial;
  uniforms: Record<string, THREE.IUniform>;
  /** Stylised (exaggerated, readable from the overview) or realistic (true scale) waves. */
  setStyle(stylised: boolean, size?: number, steepness?: number): void;
  /**
   * Gives the surf a detailed tile's drawn ground (src/detail/), slot 0 or 1: per sample its
   * height in metres then estuary shelter (0-1, no surf), row-major from the north-west sample
   * at (x0, yMax) in LAEA metres.
   */
  setDetailGround(slot: number, heights: Float32Array, width: number, height: number, x0: number, yMax: number, spacing: number): void;
}

/**
 * The live sea surface: Met Office UK wave model sea state driving a spectral
 * wave shader with sky reflections, sun glint, whitecaps and surf.
 */
export async function createOcean(
  heightmap: Heightmap,
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
    uDetailDepth0: { value: new THREE.DataTexture(new Uint16Array(2), 1, 1, THREE.RGFormat, THREE.HalfFloatType) },
    uDetailDepth1: { value: new THREE.DataTexture(new Uint16Array(2), 1, 1, THREE.RGFormat, THREE.HalfFloatType) },
    uDetailGrid: { value: [new THREE.Vector4(), new THREE.Vector4()] },
    uDetailSize: { value: [new THREE.Vector2(1, 1), new THREE.Vector2(1, 1)] },
    uWaveScaleBytes: { value: new THREE.Vector3(scale.hs, scale.tp, scale.wind) },
    uOrigin: { value: new THREE.Vector2() },
    uTime: { value: 0 },
    uWaveScale: { value: 1 },
    uStyle: { value: 0 },
    uSteep: { value: 1 },
    uStyleSpeed: { value: 1.5 },
    uSurfScale: { value: 1 },
    uCrestColour: { value: new THREE.Color('#5fa3b0') },
    uSpread: { value: new THREE.Vector2() },
    uSpreadNorm: { value: new THREE.Vector2() },
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
    // The sky's reflection: src/atmosphere sets envMap (the sky without the sun disc; the sun light draws the
    // glint) and its intensity as the sky changes.
    envMap: null,
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

  const ocean: Ocean = {
    mesh,
    field,
    material,
    uniforms,
    setStyle(stylised, size = STYLISED_SIZE, steepness = STYLISED_STEEPNESS) {
      const spread = stylised ? SPREAD_STYLISED : SPREAD_REALISTIC;
      uniforms.uStyle.value = stylised ? 1 : 0;
      uniforms.uWaveScale.value = stylised ? size : 1;
      uniforms.uSteep.value = steepness;
      // A real-width surf zone vanishes at map scale; widen it, but far less than the waves.
      uniforms.uSurfScale.value = stylised ? 8 : 1;
      uniforms.uFoam.value = stylised ? 0.7 : 1;
      uniforms.uSpread.value.set(...spread);
      uniforms.uSpreadNorm.value.set(spreadNorm(spread[0]), spreadNorm(spread[1]));
    },
    setDetailGround(slot, heights, width, height, x0, yMax, spacing) {
      const data = new Uint16Array(heights.length);
      for (let i = 0; i < heights.length; i++) data[i] = THREE.DataUtils.toHalfFloat(heights[i]);
      const texture = new THREE.DataTexture(data, width, height, THREE.RGFormat, THREE.HalfFloatType);
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      (uniforms[`uDetailDepth${slot}`].value as THREE.Texture).dispose();
      uniforms[`uDetailDepth${slot}`].value = texture;
      (uniforms.uDetailGrid.value as THREE.Vector4[])[slot].set(x0, yMax, spacing, 1);
      (uniforms.uDetailSize.value as THREE.Vector2[])[slot].set(width, height);
    },
  };
  ocean.setStyle(true);
  return ocean;
}

/** Wave size slider position (0-100) to scale factor, logarithmic from 10x to 1000x. */
const sliderToSize = (v: number) => {
  const size = 10 ** (1 + (2 * v) / 100);
  const step = 10 ** Math.floor(Math.log10(size) - 1); // two significant figures
  return Math.round(size / step) * step;
};
const sizeToSlider = (size: number) => ((Math.log10(size) - 1) / 2) * 100;

/** Adds the sea controls to the HUD, after the rain controls. */
export function mountSeaControls(hud: HTMLElement, ocean: Ocean, flatSea: THREE.Object3D) {
  const box = document.createElement('div');
  box.className = 'sea-controls';
  const valid = new Date(ocean.field.meta.valid_time).toISOString().slice(0, 16).replace('T', ' ');
  box.innerHTML = `
    <label>Sea
      <select data-sea="mode">
        <option value="stylised" selected>Stylised waves</option>
        <option value="realistic">Realistic (true scale)</option>
        <option value="flat">Flat</option>
      </select></label>
    <label data-sea="stylised">Wave size <input type="range" data-sea="size" min="0" max="100" step="1"
      value="${sizeToSlider(STYLISED_SIZE)}" /> <output data-sea="size-value"></output></label>
    <label data-sea="stylised">Wave steepness <input type="range" data-sea="steep" min="1" max="12" step="0.5"
      value="${STYLISED_STEEPNESS}" /> <output data-sea="steep-value"></output></label>
    <p class="hint">Met Office UK wave model, valid ${valid} UTC. ${ocean.field.meta.attribution}.</p>
  `;
  const hint = hud.querySelector('.hint:last-of-type');
  hud.insertBefore(box, hint);

  const mode = box.querySelector<HTMLSelectElement>('[data-sea="mode"]')!;
  const size = box.querySelector<HTMLInputElement>('[data-sea="size"]')!;
  const steep = box.querySelector<HTMLInputElement>('[data-sea="steep"]')!;
  const sizeValue = box.querySelector<HTMLOutputElement>('[data-sea="size-value"]')!;
  const steepValue = box.querySelector<HTMLOutputElement>('[data-sea="steep-value"]')!;
  const apply = () => {
    const stylised = mode.value === 'stylised';
    ocean.mesh.visible = mode.value !== 'flat';
    flatSea.visible = mode.value === 'flat';
    const sizeFactor = sliderToSize(Number(size.value));
    ocean.setStyle(stylised, sizeFactor, Number(steep.value));
    sizeValue.textContent = `${sizeFactor}×`;
    steepValue.textContent = `${steep.value}×`;
    for (const el of box.querySelectorAll<HTMLElement>('[data-sea="stylised"]')) el.style.display = stylised ? '' : 'none';
  };
  mode.addEventListener('change', apply);
  size.addEventListener('input', apply);
  steep.addEventListener('input', apply);
  apply();
}

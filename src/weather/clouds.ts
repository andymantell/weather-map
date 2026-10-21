import * as THREE from 'three';
import { createDetailTexture, createShapeTexture } from '../clouds/noise';
import type { Heightmap } from '../heightmap';
import {
  accumulateFragmentShader,
  compositeFragmentShader,
  compositeVertexShader,
  fullscreenVertexShader,
  ukvCloudFragmentShader,
} from './cloudShaders';

/** Sidecar written by pipeline/ukv_clouds.py (only the fields used here). */
export interface UkvCloudMeta {
  valid_time: string;
  forecast_reference_time: string;
  grid: { width: number; height: number; x_west: number; y_north: number; dx: number; dy: number };
  volume: { slices: number; slice_height_m: number; atlas_columns: number; atlas_rows: number };
  max_precip_mm_h: number;
  attribution: string;
}

export interface UkvCloudData {
  meta: UkvCloudMeta;
  volume: THREE.Data3DTexture;
  fields: THREE.DataTexture;
}

async function loadPixels(url: string): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const blob = await fetch(url).then((r) => r.blob());
  // No colour management or premultiplication: the bytes are data.
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return { data, width: bitmap.width, height: bitmap.height };
}

/** Loads the cloud volume atlas and 2D fields baked by pipeline/ukv_clouds.py. */
export async function loadUkvClouds(baseUrl: string): Promise<UkvCloudData> {
  const meta = (await fetch(`${baseUrl}data/ukv-clouds.json`).then((r) => r.json())) as UkvCloudMeta;
  const [atlas, fields2d] = await Promise.all([
    loadPixels(`${baseUrl}data/ukv-clouds-volume.png`),
    loadPixels(`${baseUrl}data/ukv-clouds-2d.png`),
  ]);
  const { width: nx, height: ny } = meta.grid;
  const { slices, atlas_columns: cols } = meta.volume;

  // Unpack the atlas tiles into a W x H x slices volume (slice 0 lowest).
  const voxels = new Uint8Array(nx * ny * slices);
  for (let k = 0; k < slices; k++) {
    const x0 = (k % cols) * nx;
    const y0 = Math.floor(k / cols) * ny;
    for (let r = 0; r < ny; r++) {
      const src = ((y0 + r) * atlas.width + x0) * 4;
      const dst = (k * ny + r) * nx;
      for (let c = 0; c < nx; c++) voxels[dst + c] = atlas.data[src + c * 4];
    }
  }
  const volume = new THREE.Data3DTexture(voxels, nx, ny, slices);
  volume.format = THREE.RedFormat;
  volume.type = THREE.UnsignedByteType;
  volume.minFilter = volume.magFilter = THREE.LinearFilter;
  volume.wrapS = volume.wrapT = volume.wrapR = THREE.ClampToEdgeWrapping;
  volume.unpackAlignment = 1;
  volume.needsUpdate = true;

  const fields = new THREE.DataTexture(new Uint8Array(fields2d.data), nx, ny, THREE.RGBAFormat);
  fields.minFilter = fields.magFilter = THREE.LinearFilter;
  fields.needsUpdate = true;
  return { meta, volume, fields };
}

/** Frames averaged before a still view counts as converged and the clouds stop being marched. */
const MAX_FRAMES = 32;

function nearlyEqual(a: THREE.Matrix4, b: THREE.Matrix4): boolean {
  for (let i = 0; i < 16; i++) {
    if (Math.abs(a.elements[i] - b.elements[i]) > 1e-6 * Math.max(1, Math.abs(b.elements[i]))) return false;
  }
  return true;
}

function terrainTexture(heightmap: Heightmap): THREE.DataTexture {
  const { width, height } = heightmap.meta;
  const half = new Uint16Array(width * height);
  for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(heightmap.heights[i] / 1000);
  const texture = new THREE.DataTexture(half, width, height, THREE.RedFormat, THREE.HalfFloatType);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export interface CloudLayer {
  enabled: boolean;
  /** Renders the scene with clouds to the screen; call instead of renderer.render(scene, camera). */
  render(): void;
  setExaggeration(value: number): void;
  setCloudScale(value: number): void;
  resize(): void;
  /** Frames accumulated since the view last changed. */
  readonly frames: number;
}

/**
 * Draws UKV clouds and rain as a raymarched volume over the scene. The scene is rendered into an HDR target with
 * depth, the clouds are marched at reduced resolution (and averaged over frames while the view is still), and the
 * composite darkens the scene under cloud shadow before tone mapping.
 */
export function createCloudLayer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  data: UkvCloudData,
  heightmap: Heightmap,
  sunDirection: THREE.Vector3,
  options: { resolution?: number; steps?: number } = {},
): CloudLayer {
  const resolution = options.resolution ?? 0.5;
  const size = new THREE.Vector2();

  const sceneTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  sceneTarget.depthTexture = new THREE.DepthTexture(1, 1);
  const mrt = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, count: 2, depthBuffer: false });
  const cloudTarget = mrt();
  let history = mrt();
  let accumulated = mrt();

  const { grid, volume } = data.meta;
  const hm = heightmap.meta;
  const fogColor = new THREE.Color();
  const fogRange = new THREE.Vector2(1e5, 2e5);

  const cloudMaterial = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: fullscreenVertexShader,
    fragmentShader: ukvCloudFragmentShader,
    uniforms: {
      uVolume: { value: data.volume },
      uFields: { value: data.fields },
      uTerrain: { value: terrainTexture(heightmap) },
      uDepth: { value: sceneTarget.depthTexture },
      uShape: { value: createShapeTexture(128) },
      uDetail: { value: createDetailTexture(32) },
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uCamForward: { value: new THREE.Vector3() },
      uFar: { value: camera.far },
      uFrame: { value: 0 },
      uTexel: { value: new THREE.Vector2() },
      uSteps: { value: options.steps ?? 160 },
      uGridWest: { value: new THREE.Vector2(grid.x_west, grid.y_north) },
      uGridSize: { value: new THREE.Vector2(grid.width, grid.height) },
      uGridDx: { value: grid.dx },
      uVolumeTop: { value: (volume.slices * volume.slice_height_m) / 1000 },
      uTerrainBox: { value: new THREE.Vector4(hm.xMin, hm.xMax, hm.yMin, hm.yMax) },
      uTerrainSize: { value: new THREE.Vector2(hm.width, hm.height) },
      uExaggeration: { value: 1 },
      uCloudScale: { value: 2 },
      uDensity: { value: 20 },
      uYTop: { value: 0 },
      uSunDir: { value: sunDirection },
      uSunRadiance: { value: new THREE.Color(1, 0.95, 0.88).multiplyScalar(30) },
      uAmbientTop: { value: new THREE.Color(0.48, 0.57, 0.72) },
      uAmbientBottom: { value: new THREE.Color(0.2, 0.22, 0.25) },
      uFogColor: { value: fogColor },
      uFogRange: { value: fogRange },
    },
    depthTest: false,
    depthWrite: false,
  });
  const accumulateMaterial = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: fullscreenVertexShader,
    fragmentShader: accumulateFragmentShader,
    uniforms: {
      uCloud: { value: null },
      uShadow: { value: null },
      uHistoryCloud: { value: null },
      uHistoryShadow: { value: null },
      uBlend: { value: 1 },
    },
    depthTest: false,
    depthWrite: false,
  });
  const compositeMaterial = new THREE.ShaderMaterial({
    vertexShader: compositeVertexShader,
    fragmentShader: compositeFragmentShader,
    uniforms: {
      uScene: { value: sceneTarget.texture },
      uCloud: { value: null },
      uShadow: { value: null },
      uShadowStrength: { value: 0.75 },
    },
    depthTest: false,
    depthWrite: false,
  });

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  let frames = 0;
  let exaggeration = 1;
  let cloudScale = 2;
  const lastView = new THREE.Matrix4();
  const lastProjection = new THREE.Matrix4();

  const updateTop = () => {
    cloudMaterial.uniforms.uExaggeration.value = exaggeration;
    cloudMaterial.uniforms.uCloudScale.value = cloudScale;
    // Highest ground plus the top of the cirrus sheet.
    cloudMaterial.uniforms.uYTop.value = (hm.maxHeight / 1000) * exaggeration + 10.5 * cloudScale;
    frames = 0;
  };

  const layer: CloudLayer = {
    enabled: true,
    get frames() {
      return frames;
    },
    setExaggeration(value) {
      exaggeration = value;
      updateTop();
    },
    setCloudScale(value) {
      cloudScale = value;
      updateTop();
    },
    resize() {
      renderer.getDrawingBufferSize(size);
      sceneTarget.setSize(size.x, size.y);
      const w = Math.max(1, Math.round(size.x * resolution));
      const h = Math.max(1, Math.round(size.y * resolution));
      for (const target of [cloudTarget, history, accumulated]) target.setSize(w, h);
      cloudMaterial.uniforms.uTexel.value.set(1 / w, 1 / h);
      frames = 0;
    },
    render() {
      if (!layer.enabled) {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        return;
      }
      camera.updateMatrixWorld();
      // MapControls can jitter the camera by one float ULP every frame at its angle limit, so compare loosely.
      if (!nearlyEqual(camera.matrixWorld, lastView) || !nearlyEqual(camera.projectionMatrix, lastProjection)) {
        lastView.copy(camera.matrixWorld);
        lastProjection.copy(camera.projectionMatrix);
        frames = 0;
      }

      renderer.setRenderTarget(sceneTarget);
      renderer.render(scene, camera);
      if (frames >= MAX_FRAMES) {
        // Converged: keep compositing the scene (the sea animates) with the finished clouds.
        quad.material = compositeMaterial;
        renderer.setRenderTarget(null);
        renderer.render(quadScene, quadCamera);
        return;
      }

      const u = cloudMaterial.uniforms;
      u.uInvProj.value.copy(camera.projectionMatrixInverse);
      u.uCamWorld.value.copy(camera.matrixWorld);
      u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
      camera.getWorldDirection(u.uCamForward.value);
      u.uFar.value = camera.far;
      u.uFrame.value = frames;
      if (scene.fog instanceof THREE.Fog) {
        fogColor.copy(scene.fog.color);
        fogRange.set(scene.fog.near, scene.fog.far);
      }

      quad.material = cloudMaterial;
      renderer.setRenderTarget(cloudTarget);
      renderer.render(quadScene, quadCamera);

      const a = accumulateMaterial.uniforms;
      a.uCloud.value = cloudTarget.textures[0];
      a.uShadow.value = cloudTarget.textures[1];
      a.uHistoryCloud.value = history.textures[0];
      a.uHistoryShadow.value = history.textures[1];
      a.uBlend.value = 1 / (frames + 1);
      quad.material = accumulateMaterial;
      renderer.setRenderTarget(accumulated);
      renderer.render(quadScene, quadCamera);
      [history, accumulated] = [accumulated, history];

      compositeMaterial.uniforms.uCloud.value = history.textures[0];
      compositeMaterial.uniforms.uShadow.value = history.textures[1];
      quad.material = compositeMaterial;
      renderer.setRenderTarget(null);
      renderer.render(quadScene, quadCamera);
      frames = Math.min(frames + 1, MAX_FRAMES);
    },
  };
  layer.resize();
  updateTop();
  return layer;
}

/** Adds the cloud switch, cloud height slider and source line to the HUD. */
export function mountCloudControls(hud: HTMLElement, layer: CloudLayer, meta: UkvCloudMeta): void {
  const box = document.createElement('div');
  box.innerHTML = `
    <label><input type="checkbox" checked /> Clouds and rain</label>
    <label>Cloud height <input type="range" min="1" max="6" step="0.5" value="2" /> <output>2×</output></label>
    <p class="hint"></p>`;
  const [toggle, scale] = Array.from(box.querySelectorAll('input'));
  const output = box.querySelector('output')!;
  toggle.addEventListener('change', () => (layer.enabled = toggle.checked));
  scale.addEventListener('input', () => {
    layer.setCloudScale(Number(scale.value));
    output.textContent = `${scale.value}×`;
  });
  const valid = new Date(meta.valid_time).toISOString().slice(0, 16).replace('T', ' ');
  box.querySelector('p')!.textContent = `UKV cloud and rain, valid ${valid} UTC (fixed hour for now).`;
  hud.appendChild(box);
}

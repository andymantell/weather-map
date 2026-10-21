import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';
import { accumulateFragmentShader, cloudFragmentShader, cloudVertexShader, compositeFragmentShader } from './cloudShader';
import { createDetailTexture, createShapeTexture } from './noise';
import { PRESETS, type CloudPreset } from './presets';
import '../style.css';

// Cloud type lab: one cloud layer at a time over a flat ground, to tune how each type looks before the clouds are
// driven by UKV data. World units are kilometres, like the map. URL parameters (type, view, sun, scale, steps,
// frames, flash) make the screenshots in docs/ reproducible.

const params = new URLSearchParams(location.search);
const container = document.getElementById('app')!;
const loading = document.getElementById('loading')!;

const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;
container.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.01, 20000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const settings = {
  type: params.get('type') ?? 'cumulus',
  view: params.get('view') ?? 'aerial',
  sunElevation: Number(params.get('sun') ?? 30),
  sunAzimuth: Number(params.get('azimuth') ?? -40),
  resolution: Number(params.get('scale') ?? 0.5),
  steps: Number(params.get('steps') ?? 160),
  animate: params.get('animate') !== '0',
  powder: 1,
};
const layer: CloudPreset = { ...PRESETS[settings.type] };

// Sky backdrop, rendered into an HDR target so the composite tone-maps sky and cloud together.
const sky = new Sky();
sky.scale.setScalar(15000);
const skyUniforms = sky.material.uniforms;
skyUniforms.turbidity.value = 4;
skyUniforms.rayleigh.value = 1.2;
skyUniforms.mieCoefficient.value = 0.004;
skyUniforms.mieDirectionalG.value = 0.8;
// The Sky shader paints its own 2D clouds; the lab draws real ones.
skyUniforms.cloudCoverage.value = 0;
const skyScene = new THREE.Scene();
skyScene.add(sky);

const sunDirection = new THREE.Vector3();

const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
quad.frustumCulled = false;
const quadScene = new THREE.Scene();
quadScene.add(quad);
const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const hdr = { type: THREE.HalfFloatType, depthBuffer: false };
const skyTarget = new THREE.WebGLRenderTarget(1, 1, hdr);
const cloudTarget = new THREE.WebGLRenderTarget(1, 1, hdr);
let history = new THREE.WebGLRenderTarget(1, 1, hdr);
let accumulated = new THREE.WebGLRenderTarget(1, 1, hdr);

const cloudMaterial = new THREE.ShaderMaterial({
  vertexShader: cloudVertexShader,
  fragmentShader: cloudFragmentShader,
  uniforms: {
    uShape: { value: null },
    uDetail: { value: null },
    uInvProj: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
    uFrame: { value: 0 },
    uTime: { value: 0 },
    uSteps: { value: settings.steps },
    uSunDir: { value: sunDirection },
    uSunRadiance: { value: new THREE.Color(1, 0.95, 0.88).multiplyScalar(32) },
    uAmbientTop: { value: new THREE.Color(0.42, 0.56, 0.8) },
    uAmbientBottom: { value: new THREE.Color(0.2, 0.22, 0.25) },
    uHaze: { value: new THREE.Color(0.5, 0.62, 0.8) },
    uVisibility: { value: 220 },
    uGroundAlbedo: { value: new THREE.Color(0.07, 0.11, 0.045) },
    uDomain: { value: 45 },
    uWind: { value: new THREE.Vector3(0.01, 0, 0.003) },
    uBase: { value: 0 },
    uTop: { value: 0 },
    uCoverage: { value: 0 },
    uDensity: { value: 0 },
    uWeatherScale: { value: 0 },
    uShapeScale: { value: 0 },
    uVerticalScale: { value: 0 },
    uStreak: { value: 1 },
    uDetailScale: { value: 0 },
    uErosion: { value: 0 },
    uBottomRound: { value: 0 },
    uTopRound: { value: 0 },
    uAnvil: { value: 0 },
    uRain: { value: 0 },
    uRainDarkening: { value: 0 },
    uPowder: { value: 1 },
    uFlashPos: { value: new THREE.Vector3() },
    uFlash: { value: 0 },
  },
  depthTest: false,
  depthWrite: false,
});
const accumulateMaterial = new THREE.ShaderMaterial({
  vertexShader: cloudVertexShader,
  fragmentShader: accumulateFragmentShader,
  uniforms: { uCurrent: { value: null }, uHistory: { value: null }, uBlend: { value: 1 } },
  depthTest: false,
  depthWrite: false,
});
const compositeMaterial = new THREE.ShaderMaterial({
  vertexShader: cloudVertexShader,
  fragmentShader: compositeFragmentShader,
  uniforms: { uSky: { value: skyTarget.texture }, uClouds: { value: null } },
  depthTest: false,
  depthWrite: false,
});

// Accumulate jittered frames while nothing moves, so a still view converges to a clean image.
// Once a still view has converged the loop stops; any change starts it again.
let frameCount = 0;
let running = false;
const resetAccumulation = () => {
  frameCount = 0;
  delete document.body.dataset.converged;
  if (!running && cloudMaterial.uniforms.uShape.value) {
    running = true;
    renderer.setAnimationLoop(frame);
  }
};

function applyLayer() {
  const u = cloudMaterial.uniforms;
  u.uBase.value = layer.base;
  u.uTop.value = layer.top;
  u.uCoverage.value = layer.coverage;
  u.uDensity.value = layer.density;
  u.uWeatherScale.value = layer.weatherScale;
  u.uShapeScale.value = layer.shapeScale;
  u.uVerticalScale.value = layer.verticalScale;
  u.uStreak.value = layer.streak;
  u.uDetailScale.value = layer.detailScale;
  u.uErosion.value = layer.erosion;
  u.uBottomRound.value = layer.bottomRound;
  u.uTopRound.value = layer.topRound;
  u.uAnvil.value = layer.anvil;
  u.uRain.value = layer.rain;
  u.uRainDarkening.value = layer.rainDarkening;
  u.uPowder.value = settings.powder;
  u.uSteps.value = settings.steps;
  resetAccumulation();
}

function applySun() {
  sunDirection.setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - settings.sunElevation),
    THREE.MathUtils.degToRad(settings.sunAzimuth),
  );
  skyUniforms.sunPosition.value.copy(sunDirection);
  resetAccumulation();
}

function applyView() {
  const mid = (layer.base + layer.top) / 2;
  switch (settings.view) {
    case 'ground':
      if (layer.top < 0.6) {
        // Fog: look across it from a hilltop just above its top.
        camera.position.set(-2, layer.top + 0.35, 14);
        controls.target.set(0, 0, 0);
      } else {
        camera.position.set(-4, 0.02, 24);
        controls.target.set(0, Math.max(mid * 0.7, 0.4), 0);
      }
      break;
    case 'side':
      camera.position.set(0, Math.max(mid, 0.6), 58);
      controls.target.set(0, Math.max(mid * 0.8, 0.3), 0);
      break;
    default:
      // Oblique, map-like view from well above the layer.
      camera.position.set(-24, 17, 32);
      controls.target.set(0, 0, 0);
  }
  controls.update();
  resetAccumulation();
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  const w = Math.max(1, Math.round(width * settings.resolution));
  const h = Math.max(1, Math.round(height * settings.resolution));
  skyTarget.setSize(width, height);
  for (const target of [cloudTarget, history, accumulated]) target.setSize(w, h);
  resetAccumulation();
}

function buildGui() {
  const gui = new GUI({ title: 'Cloud lab' });
  const types = Object.fromEntries(Object.entries(PRESETS).map(([key, p]) => [p.label, key]));
  gui.add(settings, 'type', types).name('Cloud type').onChange((key: string) => {
    Object.assign(layer, PRESETS[key]);
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    applyLayer();
    applyView();
  });
  gui.add(settings, 'view', { 'From above': 'aerial', 'From the ground': 'ground', 'From the side': 'side' })
    .name('View')
    .onChange(applyView);
  gui.add(settings, 'sunElevation', 2, 80, 1).name('Sun elevation °').onChange(applySun);
  gui.add(settings, 'sunAzimuth', -180, 180, 1).name('Sun azimuth °').onChange(applySun);
  gui.add(settings, 'animate').name('Wind drift').onChange(resetAccumulation);
  const shape = gui.addFolder('Layer');
  shape.add(layer, 'base', 0, 12, 0.05).name('Base (km)').onChange(applyLayer);
  shape.add(layer, 'top', 0.1, 14, 0.05).name('Top (km)').onChange(applyLayer);
  shape.add(layer, 'coverage', 0, 1, 0.01).name('Coverage').onChange(applyLayer);
  shape.add(layer, 'density', 0.5, 120, 0.5).name('Extinction (/km)').onChange(applyLayer);
  shape.add(layer, 'rain', 0, 60, 0.5).name('Rain (mm/h)').onChange(applyLayer);
  shape.add(layer, 'rainDarkening', 0, 3, 0.05).name('Rain darkening').onChange(applyLayer);
  shape.add(layer, 'anvil', 0, 1, 0.05).name('Anvil').onChange(applyLayer);
  shape.add(layer, 'lightning', 0, 60, 1).name('Flashes / min');
  const detail = gui.addFolder('Shape noise').close();
  detail.add(layer, 'weatherScale', 2, 80, 0.5).name('Cell size (km)').onChange(applyLayer);
  detail.add(layer, 'shapeScale', 1, 40, 0.5).name('Shape scale (km)').onChange(applyLayer);
  detail.add(layer, 'verticalScale', 0.05, 2, 0.01).name('Vertical scale').onChange(applyLayer);
  detail.add(layer, 'streak', 1, 10, 0.1).name('Streak').onChange(applyLayer);
  detail.add(layer, 'detailScale', 0.2, 4, 0.05).name('Detail scale (km)').onChange(applyLayer);
  detail.add(layer, 'erosion', 0, 1, 0.01).name('Erosion').onChange(applyLayer);
  detail.add(layer, 'bottomRound', 0.01, 1, 0.01).name('Base rounding').onChange(applyLayer);
  detail.add(layer, 'topRound', 0.01, 1, 0.01).name('Top rounding').onChange(applyLayer);
  detail.add(settings, 'powder', 0, 1, 0.05).name('Powder').onChange(applyLayer);
  const quality = gui.addFolder('Quality').close();
  quality.add(settings, 'resolution', 0.25, 1, 0.05).name('Resolution').onChange(resize);
  quality.add(settings, 'steps', 32, 512, 8).name('Ray steps').onChange(applyLayer);
}

const lastView = new THREE.Matrix4();
const timer = new THREE.Timer();
let simTime = 0;
let flash = params.get('flash') === '1' ? 1 : 0;
const flashPosition = cloudMaterial.uniforms.uFlashPos.value as THREE.Vector3;
flashPosition.set(-2, layer.base + (layer.top - layer.base) * 0.3, 1);
const targetFrames = Number(params.get('frames') ?? 48);

function frame() {
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.1);
  controls.update();
  camera.updateMatrixWorld();
  if (!camera.matrixWorld.equals(lastView)) {
    lastView.copy(camera.matrixWorld);
    resetAccumulation();
  }

  // Wind drift: one simulated minute per second.
  if (settings.animate) {
    simTime += dt * 60;
    if (frameCount > 4) frameCount = 4;
  }
  // Lightning: random flashes inside the storm cell that fade over a few tenths of a second.
  if (layer.lightning > 0 && settings.animate && Math.random() < (layer.lightning / 60) * dt) {
    flash = 1;
    flashPosition.set(
      (Math.random() - 0.5) * 12,
      layer.base + (layer.top - layer.base) * (0.15 + Math.random() * 0.4),
      (Math.random() - 0.5) * 12,
    );
  }
  if (settings.animate) flash *= Math.exp(-dt * 12);

  const u = cloudMaterial.uniforms;
  u.uInvProj.value.copy(camera.projectionMatrixInverse);
  u.uCamWorld.value.copy(camera.matrixWorld);
  u.uCamPos.value.copy(camera.position);
  u.uFrame.value = frameCount;
  u.uTime.value = simTime;
  u.uFlash.value = flash * 40;

  renderer.setRenderTarget(skyTarget);
  renderer.render(skyScene, camera);

  quad.material = cloudMaterial;
  renderer.setRenderTarget(cloudTarget);
  renderer.render(quadScene, quadCamera);

  accumulateMaterial.uniforms.uCurrent.value = cloudTarget.texture;
  accumulateMaterial.uniforms.uHistory.value = history.texture;
  accumulateMaterial.uniforms.uBlend.value = 1 / (frameCount + 1);
  quad.material = accumulateMaterial;
  renderer.setRenderTarget(accumulated);
  renderer.render(quadScene, quadCamera);
  [history, accumulated] = [accumulated, history];

  compositeMaterial.uniforms.uClouds.value = history.texture;
  quad.material = compositeMaterial;
  renderer.setRenderTarget(null);
  renderer.render(quadScene, quadCamera);

  frameCount = Math.min(frameCount + 1, 64);
  // Lets the screenshot script know when a still view has converged.
  (window as unknown as { cloudFrames: number }).cloudFrames = frameCount;
  if (frameCount >= targetFrames && !settings.animate) {
    document.body.dataset.converged = 'true';
    renderer.setAnimationLoop(null);
    running = false;
  }
}

async function init() {
  // Let the loading message paint before the noise generation blocks the main thread.
  await new Promise((resolve) => setTimeout(resolve, 30));
  cloudMaterial.uniforms.uShape.value = createShapeTexture(128);
  cloudMaterial.uniforms.uDetail.value = createDetailTexture(32);
  applyLayer();
  applySun();
  applyView();
  resize();
  if (params.get('gui') !== '0') buildGui();
  window.addEventListener('resize', resize);
  controls.addEventListener('change', resetAccumulation);
  loading.remove();
  resetAccumulation();
}

init().catch((error) => {
  console.error(error);
  loading.textContent = 'Failed to start the cloud lab.';
});

import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { Water } from 'three/addons/objects/Water.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { N8AOPass } from 'n8ao';
import { loadHeightmap } from '../heightmap';
import { Projection } from '../projection';
import { type Area, heightAt, loadArea } from './area';
import { type Building, createBlocks, createFootprints, parseBuildings } from './buildings';
import { createGround } from './ground';
import { createSurroundings } from './surroundings';
import { createTrees } from './trees';
import '../style.css';
import './poc.css';

/**
 * Terrain proof of concept: one small area at a time (Plymouth, Kielder Forest),
 * with switchable building and tree representations at realistic or exaggerated
 * scales. Every control is mirrored in the URL so views can be shared or screenshotted.
 */

interface View {
  lon: number;
  lat: number;
  /** Camera distance from target (m), compass bearing the camera looks towards, elevation (deg). */
  distance: number;
  bearing: number;
  elevation: number;
}

const VIEWS: Record<string, Record<string, View>> = {
  plymouth: {
    hoe: { lon: -4.142, lat: 50.368, distance: 1800, bearing: 10, elevation: 32 },
    city: { lon: -4.14, lat: 50.378, distance: 5000, bearing: 0, elevation: 30 },
    sound: { lon: -4.14, lat: 50.39, distance: 13000, bearing: 5, elevation: 28 },
    far: { lon: -4.13, lat: 50.39, distance: 26000, bearing: 20, elevation: 40 },
  },
  kielder: {
    close: { lon: -2.56, lat: 55.205, distance: 2500, bearing: 300, elevation: 22 },
    water: { lon: -2.53, lat: 55.19, distance: 9000, bearing: 300, elevation: 28 },
    far: { lon: -2.55, lat: 55.215, distance: 26000, bearing: 330, elevation: 38 },
  },
};

const params = new URLSearchParams(location.search);
const state = {
  area: params.get('area') ?? 'plymouth',
  view: params.get('view') ?? '',
  buildings: params.get('buildings') ?? 'footprints',
  bscale: Number(params.get('bscale') ?? 1),
  cell: Number(params.get('cell') ?? 150),
  trees: params.get('trees') ?? 'on',
  tscale: Number(params.get('tscale') ?? 1),
  terrain: Number(params.get('terrain') ?? 1.5),
  ao: params.get('ao') !== '0',
  hud: params.get('hud') !== '0',
};
/** Screenshot mode: render a fixed number of frames on demand instead of continuously. */
const shotMode = params.has('shot');

const container = document.getElementById('app')!;
const loading = document.getElementById('loading')!;
const hud = document.getElementById('hud')!;
if (!state.hud) hud.style.display = 'none';

const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 2, 200000);
const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.48;

// Late-morning sun from the south-east, so south-facing slopes and walls light up.
const sunDirection = new THREE.Vector3().setFromSphericalCoords(
  1,
  THREE.MathUtils.degToRad(90 - 30),
  THREE.MathUtils.degToRad(35),
);
const sky = new Sky();
sky.scale.setScalar(150000);
const skyU = sky.material.uniforms;
skyU.turbidity.value = 5;
skyU.rayleigh.value = 1.4;
skyU.mieCoefficient.value = 0.004;
skyU.mieDirectionalG.value = 0.8;
skyU.sunPosition.value.copy(sunDirection);
scene.add(sky);

// Image-based lighting from the same sky for soft ambient and reflections.
const pmrem = new THREE.PMREMGenerator(renderer);
const skyScene = new THREE.Scene();
skyScene.add(sky.clone());
scene.environment = pmrem.fromScene(skyScene, 0, 1, 300000).texture;
scene.environmentIntensity = 0.55;

const sun = new THREE.DirectionalLight('#fff1dc', 3.4);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.6;
scene.add(sun, sun.target);

scene.fog = new THREE.FogExp2('#c4d4e6', 0.000013);

const composer = new EffectComposer(renderer);
const aoPass = new N8AOPass(scene, camera, window.innerWidth, window.innerHeight);
aoPass.configuration.aoRadius = 12;
aoPass.configuration.distanceFalloff = 1;
aoPass.configuration.intensity = 2.5;
aoPass.configuration.gammaCorrection = false;
aoPass.setQualityMode('High');
composer.addPass(aoPass);
composer.addPass(new OutputPass());

/** A tileable ripple normal map for the sea, generated so no texture file is needed. */
function rippleNormals(size = 256): THREE.Texture {
  const h = new Float32Array(size * size);
  const waves = Array.from({ length: 24 }, (_, i) => ({
    kx: Math.round(Math.cos(i * 2.4) * (2 + (i % 7))),
    ky: Math.round(Math.sin(i * 2.4) * (2 + (i % 5))),
    a: 1 / (1 + i * 0.4),
    p: i * 1.7,
  }));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const w of waves) v += w.a * Math.sin(((w.kx * x + w.ky * y) / size) * Math.PI * 2 + w.p);
      h[y * size + x] = v;
    }
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = h[y * size + ((x + 1) % size)] - h[y * size + ((x - 1 + size) % size)];
      const dy = h[((y + 1) % size) * size + x] - h[((y - 1 + size) % size) * size + x];
      const n = new THREE.Vector3(-dx * 0.6, -dy * 0.6, 1).normalize();
      const i = (y * size + x) * 4;
      data[i] = (n.x * 0.5 + 0.5) * 255;
      data[i + 1] = (n.y * 0.5 + 0.5) * 255;
      data[i + 2] = (n.z * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  const tex = new THREE.DataTexture(data, size, size);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

const uniforms = { terrainScale: { value: state.terrain }, buildingScale: { value: state.bscale } };
let area: Area;
let buildings: Building[] = [];
let ground: THREE.Mesh;
let surroundings: THREE.Mesh;
let buildingLayer: THREE.Object3D | null = null;
let treeLayer: THREE.Object3D | null = null;
let water: Water | null = null;

function syncUrl() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(state)) p.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  history.replaceState(null, '', `?${p}`);
}

function disposeLayer(o: THREE.Object3D | null) {
  if (!o) return;
  scene.remove(o);
  o.traverse((c) => {
    if (c instanceof THREE.Mesh) c.geometry.dispose();
  });
}

function rebuildBuildings() {
  disposeLayer(buildingLayer);
  buildingLayer = null;
  if (state.buildings === 'footprints') buildingLayer = createFootprints(buildings, uniforms);
  else if (state.buildings === 'blocks') buildingLayer = createBlocks(buildings, area, state.cell, uniforms);
  if (buildingLayer) scene.add(buildingLayer);
}

function rebuildTrees() {
  disposeLayer(treeLayer);
  treeLayer = null;
  if (state.trees === 'on') {
    treeLayer = createTrees(area, { scale: state.tscale }, uniforms);
    scene.add(treeLayer);
  }
}

function applyTerrainScale() {
  uniforms.terrainScale.value = state.terrain;
  ground.scale.y = state.terrain;
  surroundings.scale.y = state.terrain;
}

function setView(name: string, projection: Projection) {
  const v = VIEWS[state.area][name];
  if (!v) return;
  const w = projection.toWorld(v.lon, v.lat);
  const tx = w.x * 1000 - area.meta.xMin;
  const tz = area.meta.yMax + w.z * 1000;
  const ty = heightAt(area, tx, tz) * state.terrain;
  const b = THREE.MathUtils.degToRad(v.bearing);
  const e = THREE.MathUtils.degToRad(v.elevation);
  // Bearing is where the camera looks, so the camera sits on the opposite side.
  const horiz = v.distance * Math.cos(e);
  controls.target.set(tx, ty, tz);
  camera.position.set(tx - Math.sin(b) * horiz, ty + v.distance * Math.sin(e), tz + Math.cos(b) * horiz);
  controls.update();
}

function updateSun() {
  const d = camera.position.distanceTo(controls.target);
  const extent = THREE.MathUtils.clamp(d * 0.9, 400, 20000);
  const cam = sun.shadow.camera;
  cam.left = -extent;
  cam.right = extent;
  cam.top = extent;
  cam.bottom = -extent;
  cam.near = 1;
  cam.far = 60000;
  cam.updateProjectionMatrix();
  sun.target.position.copy(controls.target);
  sun.position.copy(controls.target).addScaledVector(sunDirection, 30000);
  camera.near = THREE.MathUtils.clamp(d * 0.002, 1, 50);
  camera.updateProjectionMatrix();
  aoPass.configuration.aoRadius = THREE.MathUtils.clamp(d * 0.006, 4, 200);
}

function bindHud(projection: Projection) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const viewSel = el<HTMLSelectElement>('view');
  const fillViews = () => {
    viewSel.innerHTML = Object.keys(VIEWS[state.area])
      .map((k) => `<option value="${k}">${k}</option>`)
      .join('');
    viewSel.value = state.view;
  };
  fillViews();
  viewSel.onchange = () => {
    state.view = viewSel.value;
    setView(state.view, projection);
    syncUrl();
  };
  const areaSel = el<HTMLSelectElement>('area');
  areaSel.value = state.area;
  areaSel.onchange = () => {
    state.area = areaSel.value;
    state.view = '';
    syncUrl();
    location.reload();
  };
  const bindSelect = (id: string, key: 'buildings' | 'trees', after: () => void) => {
    const s = el<HTMLSelectElement>(id);
    s.value = state[key];
    s.onchange = () => {
      state[key] = s.value;
      after();
      syncUrl();
    };
  };
  bindSelect('buildings', 'buildings', rebuildBuildings);
  bindSelect('trees', 'trees', rebuildTrees);
  const bindRange = (id: string, key: 'bscale' | 'tscale' | 'terrain' | 'cell', live: () => void, done?: () => void) => {
    const r = el<HTMLInputElement>(id);
    const out = el<HTMLOutputElement>(`${id}-value`);
    r.value = String(state[key]);
    out.textContent = r.value;
    r.oninput = () => {
      state[key] = Number(r.value);
      out.textContent = r.value;
      live();
    };
    r.onchange = () => {
      done?.();
      syncUrl();
    };
  };
  bindRange('bscale', 'bscale', () => (uniforms.buildingScale.value = state.bscale));
  bindRange('tscale', 'tscale', () => {}, rebuildTrees);
  bindRange('terrain', 'terrain', applyTerrainScale);
  bindRange('cell', 'cell', () => {}, () => state.buildings === 'blocks' && rebuildBuildings());
  const ao = el<HTMLInputElement>('ao');
  ao.checked = state.ao;
  ao.onchange = () => {
    state.ao = ao.checked;
    aoPass.enabled = state.ao;
    syncUrl();
  };
}

async function init() {
  const [loaded, uk] = await Promise.all([
    loadArea(import.meta.env.BASE_URL, state.area),
    loadHeightmap(import.meta.env.BASE_URL),
  ]);
  area = loaded;
  const projection = new Projection(area.meta.proj);
  if (!state.view) state.view = Object.keys(VIEWS[state.area])[0];
  buildings = parseBuildings(area);

  const g = createGround(area);
  ground = g.mesh;
  surroundings = createSurroundings(area, uk, g.material);
  scene.add(ground, surroundings);
  applyTerrainScale();

  {
    water = new Water(new THREE.PlaneGeometry(area.sizeX + 160000, area.sizeZ + 160000), {
      textureWidth: 1024,
      textureHeight: 1024,
      waterNormals: rippleNormals(),
      sunDirection: sunDirection.clone(),
      sunColor: '#fff1dc',
      waterColor: '#1f5566',
      distortionScale: 2.2,
      fog: true,
    });
    water.rotation.x = -Math.PI / 2;
    water.position.set(area.sizeX / 2, 0, area.sizeZ / 2);
    water.material.uniforms.size.value = 0.08;
    scene.add(water);
  }

  rebuildBuildings();
  rebuildTrees();
  aoPass.enabled = state.ao;
  bindHud(projection);
  setView(state.view, projection);
  if (!shotMode) syncUrl();
  document.getElementById('attribution')!.textContent = area.meta.attribution;
  loading.remove();
  if (shotMode) {
    renderer.setAnimationLoop(null);
    const t0 = performance.now();
    for (let i = 0; i < 2; i++) renderFrame();
    console.info(`shot rendered in ${Math.round(performance.now() - t0)} ms`);
  }
  // Let screenshot tooling know the scene is complete.
  document.body.setAttribute('data-ready', '1');
}

function renderFrame() {
  controls.update();
  updateSun();
  if (water) water.material.uniforms.time.value = performance.now() / 3000;
  composer.render();
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
  if (ground) renderFrame();
});

init().catch((error) => {
  console.error(error);
  loading.textContent = 'Failed to load area.';
});

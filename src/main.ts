import * as THREE from 'three';
import { Atmosphere, mountAtmosphereControls } from './atmosphere/atmosphere';
import { loadUkvSurface, WeatherSampler } from './atmosphere/localWeather';
import { CameraRig, mountCameraControls } from './camera/cameraRig';
import { loadHeightmap } from './heightmap';
import { Projection } from './projection';
import { createRainPlane, loadRainField } from './rain';
import { createOcean, mountSeaControls, type Ocean } from './sea/ocean';
import { bakePreviewCentre, createDetailTerrain, type DetailTerrain } from './detail/detailTerrain';
import { createSea, createTerrain, setDetailRects } from './terrain';
import { createCloudLayer, loadUkvClouds, mountCloudControls, type CloudLayer } from './weather/clouds';
import { createRainLayer, mountRainControls, type RainLayer } from './weather/rain/rain';
import { loadUkvLive, mountTimeControls, type UkvLive } from './weather/ukvLive';
import './style.css';

const container = document.getElementById('app')!;
const loading = document.getElementById('loading')!;
const exaggerationInput = document.getElementById('exaggeration') as HTMLInputElement;
const exaggerationValue = document.getElementById('exaggeration-value')!;
const reliefEasingInput = document.getElementById('relief-easing') as HTMLInputElement;
const rainInput = document.getElementById('rain') as HTMLInputElement;
const rainInfo = document.getElementById('rain-info')!;

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.6;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();

// World units are kilometres. The camera rig moves the near plane with the camera's height above ground.
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 20000);

// The key light: the sun by day and the moon by night, placed by the atmosphere for the time being viewed. Its
// direction vector is shared with the clouds (lighting and shadows) and the detailed terrain's shadows.
const keyDirection = new THREE.Vector3(0, 1, 0);
const sun = new THREE.DirectionalLight('#ffffff', 3.2);
scene.add(sun);
scene.add(sun.target);

let atmosphere: Atmosphere | undefined;
let clouds: CloudLayer | undefined;
let rig: CameraRig | undefined;
let detail: DetailTerrain | undefined;
let setExaggeration: ((value: number) => void) | undefined;
/** The exaggeration in use, which can differ from the slider (see easeRelief). */
let exaggeration = 1;
let animatedRain: RainLayer | undefined;
let ocean: Ocean | undefined;
/** The detailed tiles feeding the sea's two depth slots, so they change only when needed. */
let seaGroundKey = '';

/** The sea has two depth slots for surf and shoaling: fill them with the coastal tiles nearest the camera. */
function feedSeaGrounds(d: DetailTerrain, sea: Ocean, p: THREE.Vector3) {
  const centre = (g: DetailTerrain['grounds'][number]) =>
    Math.hypot((g.x0 + (g.width * g.spacing) / 2) / 1000 - p.x, -(g.yMax - (g.height * g.spacing) / 2) / 1000 - p.z);
  const nearest = d.grounds
    .filter((g) => g.hasCoast)
    .sort((a, b) => centre(a) - centre(b))
    .slice(0, 2);
  const key = nearest.map((g) => `${g.x0},${g.yMax}`).join(';');
  if (key === seaGroundKey) return;
  seaGroundKey = key;
  nearest.forEach((g, i) => sea.setDetailGround(i, g.heights, g.width, g.height, g.x0, g.yMax, g.spacing));
}

async function init() {
  // ?live reads the next hour of UKV straight from the Met Office bucket; ?live=2026-10-21T18:00Z picks the hour.
  const liveParam = new URLSearchParams(location.search).get('live');
  let live: UkvLive | undefined;
  let heightmap, rainField, cloudData, surface;
  if (liveParam === null) {
    [heightmap, rainField, cloudData, surface] = await Promise.all([
      loadHeightmap(import.meta.env.BASE_URL),
      loadRainField(import.meta.env.BASE_URL),
      loadUkvClouds(import.meta.env.BASE_URL),
      loadUkvSurface(import.meta.env.BASE_URL),
    ]);
  } else {
    heightmap = await loadHeightmap(import.meta.env.BASE_URL);
    loading.textContent = 'Reading UKV from the Met Office bucket…';
    live = await loadUkvLive(heightmap.meta, liveParam ? new Date(liveParam) : new Date());
    ({ rainField, data: cloudData, surface } = live);
  }
  const projection = new Projection(heightmap.meta.proj);
  atmosphere = new Atmosphere(renderer, scene, camera, projection, sun, keyDirection);
  const stargazing = document.getElementById('stargazing') as HTMLInputElement;
  stargazing.addEventListener('change', () => atmosphere?.setStargazing(stargazing.checked));

  const terrain = createTerrain(heightmap);
  scene.add(terrain);
  rig = new CameraRig(camera, renderer.domElement, terrain);
  mountCameraControls(document.getElementById('hud')!, rig, document.getElementById('camera-hint')!);
  const flatSea = createSea(heightmap);
  scene.add(flatSea);
  const sea = await createOcean(heightmap, import.meta.env.BASE_URL);
  ocean = sea;
  scene.add(sea.mesh);
  atmosphere.envMaterials.push(sea.material);
  mountSeaControls(document.getElementById('hud')!, sea, flatSea);

  const rain = createRainPlane(rainField, heightmap.meta);
  scene.add(rain);
  rainInput.addEventListener('change', () => (rain.visible = rainInput.checked));
  // The volumetric clouds show the rain, so the flat rain overlay starts hidden.
  rainInput.checked = rain.visible = false;
  clouds = createCloudLayer(renderer, scene, camera, cloudData, heightmap, keyDirection, {
    atmosphere: atmosphere.cloudHook,
  });
  mountCloudControls(document.getElementById('hud')!, clouds, cloudData.meta, !!live);
  atmosphere.attachClouds(clouds);
  atmosphere.attachWeather(new WeatherSampler(cloudData, surface));
  atmosphere.setDataTime(new Date(cloudData.meta.valid_time));
  mountAtmosphereControls(document.getElementById('hud')!, atmosphere);
  animatedRain = createRainLayer(renderer, camera, clouds, cloudData, heightmap, (x, z) => rig!.sampler.heightAt(x, z));
  mountRainControls(document.getElementById('hud')!, animatedRain);
  atmosphere.attachDisplayLight(animatedRain.light);
  const showValidTime = () => {
    const validTime = new Date(rainField.meta.valid_time).toISOString().slice(0, 16).replace('T', ' ');
    rainInfo.textContent = `UKV precipitation rate, valid ${validTime} UTC. ${rainField.meta.attribution}.`;
  };
  showValidTime();
  if (live) {
    mountTimeControls(document.getElementById('hud')!, live, () => {
      clouds!.invalidate();
      atmosphere!.setDataTime(new Date(live!.data.meta.valid_time));
      atmosphere!.weatherChanged();
      showValidTime();
    });
  }

  setExaggeration = (value: number) => {
    exaggeration = value;
    terrain.scale.y = value;
    // Float the rain just above the highest (exaggerated) peak.
    rain.position.y = (heightmap.meta.maxHeight / 1000) * value + 1;
    clouds?.setExaggeration(value);
    detail?.setExaggeration(value);
  };
  exaggerationInput.addEventListener('input', () => {
    exaggerationValue.textContent = `${exaggerationInput.value}×`;
    setExaggeration!(Number(exaggerationInput.value));
  });
  setExaggeration(Number(exaggerationInput.value));

  // Start looking north over England and Wales, or (dev, ?tiles=) close over the UK bake tiles being previewed.
  const target = projection.toWorld(-2.5, 53.5);
  const preview = bakePreviewCentre();
  if (preview) {
    rig.map.target.set(preview.x, 0, preview.z);
    camera.position.set(preview.x - 4, 14, preview.z + 20);
  } else {
    rig.map.target.set(target.x, 0, target.z);
    camera.position.set(target.x - 60, 420, target.z + 620);
  }
  rig.map.update();

  loading.remove();

  // Detailed tiles (towns, woods, fine terrain) load after the map is up; ?detail=off skips them (software GL tests).
  const skipDetail = new URLSearchParams(location.search).get('detail') === 'off';
  if (!skipDetail) createDetailTerrain(import.meta.env.BASE_URL, terrain, sun, renderer)
    .then((d) => {
      detail = d;
      d.setExaggeration(terrain.scale.y);
      scene.add(d.group);
      setDetailRects(d.rects);
      rig!.sampler.detail = d.terrainAt;
      if (import.meta.env.DEV) Object.assign(window, { detail: d });
    })
    .catch((error) => console.error('Detailed terrain failed to load', error));
  // Handles for driving the view from the console or screenshot scripts.
  if (import.meta.env.DEV) Object.assign(window, { camera, rig, projection, scene, clouds, rain: animatedRain, renderer, live, atmosphere });
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  clouds?.resize();
});

/**
 * The slider's exaggeration suits the map, but from the ground it turns hills into cliffs. Below
 * 20 km the relief eases (on a log scale of height) towards 1.5x at 200 m and under.
 */
const NEAR_GROUND_RELIEF = 1.5;
function easeRelief(aboveGround: number) {
  if (!setExaggeration || !rig) return;
  const slider = Number(exaggerationInput.value);
  let target = slider;
  if (reliefEasingInput.checked && slider > NEAR_GROUND_RELIEF) {
    const t = THREE.MathUtils.clamp(Math.log(aboveGround / 0.2) / Math.log(20 / 0.2), 0, 1);
    target = NEAR_GROUND_RELIEF + (slider - NEAR_GROUND_RELIEF) * THREE.MathUtils.smoothstep(t, 0, 1);
  }
  if (Math.abs(target - exaggeration) < 0.002 * exaggeration) return;
  setExaggeration(target);
}

const timer = new THREE.Timer();
timer.connect(document);
renderer.setAnimationLoop((time) => {
  timer.update(time);
  // Clamp the step so a stalled tab does not teleport the camera.
  const dt = Math.min(timer.getDelta(), 0.1);
  rig?.update(dt);
  if (rig) {
    const p = camera.position;
    const groundY = rig.sampler.heightAt(p.x, p.z);
    const aboveGround = Math.max(p.y - groundY, 0.001);
    easeRelief(aboveGround);
    // Before the detailed terrain, which aims the key light's shadow camera.
    atmosphere?.update(dt, groundY);
    detail?.update(camera, aboveGround);
    if (detail && ocean) feedSeaGrounds(detail, ocean, p);
  }
  if (clouds) clouds.render();
  else renderer.render(scene, camera);
  animatedRain?.render();
});

init().catch((error) => {
  console.error(error);
  loading.textContent = 'Failed to load terrain.';
});

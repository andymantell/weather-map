import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { CameraRig, mountCameraControls } from './camera/cameraRig';
import { loadHeightmap } from './heightmap';
import { Projection } from './projection';
import { createRainPlane, loadRainField } from './rain';
import { createOcean, mountSeaControls } from './sea/ocean';
import { createDetailTerrain, type DetailTerrain } from './detail/detailTerrain';
import { createSea, createTerrain, setDetailRects } from './terrain';
import { createCloudLayer, loadUkvClouds, mountCloudControls, type CloudLayer } from './weather/clouds';
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
scene.fog = new THREE.Fog('#b9cfe0', 600, 2600);

// World units are kilometres. The camera rig moves the near plane with the camera's height above ground.
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 20000);

// Low afternoon sun from the south-west (azimuth is measured from +Z, which is south).
const sunElevation = THREE.MathUtils.degToRad(28);
const sunAzimuth = THREE.MathUtils.degToRad(-45);
const sunDirection = new THREE.Vector3().setFromSphericalCoords(
  1,
  Math.PI / 2 - sunElevation,
  sunAzimuth,
);

const sky = new Sky();
sky.scale.setScalar(15000);
// The sky shader ignores the logarithmic depth buffer, so draw it first as a backdrop.
sky.material.depthTest = false;
sky.renderOrder = -1;
const skyUniforms = sky.material.uniforms;
skyUniforms.turbidity.value = 6;
skyUniforms.rayleigh.value = 1.5;
skyUniforms.mieCoefficient.value = 0.005;
skyUniforms.mieDirectionalG.value = 0.8;
skyUniforms.sunPosition.value.copy(sunDirection);
scene.add(sky);

const sun = new THREE.DirectionalLight('#fff3e0', 3.2);
sun.position.copy(sunDirection).multiplyScalar(1000);
scene.add(sun);
scene.add(new THREE.HemisphereLight('#cfe3f5', '#4a4636', 0.9));

let clouds: CloudLayer | undefined;
let rig: CameraRig | undefined;
let detail: DetailTerrain | undefined;
let setExaggeration: ((value: number) => void) | undefined;
/** The exaggeration in use, which can differ from the slider (see easeRelief). */
let exaggeration = 1;

async function init() {
  const [heightmap, rainField, cloudData] = await Promise.all([
    loadHeightmap(import.meta.env.BASE_URL),
    loadRainField(import.meta.env.BASE_URL),
    loadUkvClouds(import.meta.env.BASE_URL),
  ]);
  const projection = new Projection(heightmap.meta.proj);

  const terrain = createTerrain(heightmap);
  scene.add(terrain);
  rig = new CameraRig(camera, renderer.domElement, terrain, scene);
  mountCameraControls(document.getElementById('hud')!, rig, document.getElementById('camera-hint')!);
  const flatSea = createSea(heightmap);
  scene.add(flatSea);
  const ocean = await createOcean(renderer, heightmap, sky, import.meta.env.BASE_URL);
  scene.add(ocean.mesh);
  mountSeaControls(document.getElementById('hud')!, ocean, flatSea);

  const rain = createRainPlane(rainField, heightmap.meta);
  scene.add(rain);
  rainInput.addEventListener('change', () => (rain.visible = rainInput.checked));
  // The volumetric clouds show the rain, so the flat rain overlay starts hidden.
  rainInput.checked = rain.visible = false;
  clouds = createCloudLayer(renderer, scene, camera, cloudData, heightmap, sunDirection);
  mountCloudControls(document.getElementById('hud')!, clouds, cloudData.meta);
  const validTime = new Date(rainField.meta.valid_time).toISOString().slice(0, 16).replace('T', ' ');
  rainInfo.textContent = `UKV precipitation rate, valid ${validTime} UTC. ${rainField.meta.attribution}.`;

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

  // Start looking north over England and Wales.
  const target = projection.toWorld(-2.5, 53.5);
  rig.map.target.set(target.x, 0, target.z);
  camera.position.set(target.x - 60, 420, target.z + 620);
  rig.map.update();

  loading.remove();

  // Detailed tiles (towns, woods, fine terrain) load after the map is up.
  createDetailTerrain(import.meta.env.BASE_URL, terrain, sun, renderer)
    .then((d) => {
      detail = d;
      d.setExaggeration(terrain.scale.y);
      scene.add(d.group);
      setDetailRects(d.rects);
      rig!.sampler.detail = d.terrainAt;
      d.grounds.slice(0, 2).forEach((g, i) => ocean.setDetailGround(i, g.heights, g.width, g.height, g.x0, g.yMax, g.spacing));
      if (import.meta.env.DEV) Object.assign(window, { detail: d });
    })
    .catch((error) => console.error('Detailed terrain failed to load', error));
  // Handles for driving the view from the console or screenshot scripts.
  if (import.meta.env.DEV) Object.assign(window, { camera, rig, projection, scene, clouds });
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
  rig?.update(Math.min(timer.getDelta(), 0.1));
  if (rig) {
    const p = camera.position;
    const aboveGround = Math.max(p.y - rig.sampler.heightAt(p.x, p.z), 0.001);
    easeRelief(aboveGround);
    detail?.update(camera, aboveGround);
  }
  if (clouds) clouds.render();
  else renderer.render(scene, camera);
});

init().catch((error) => {
  console.error(error);
  loading.textContent = 'Failed to load terrain.';
});

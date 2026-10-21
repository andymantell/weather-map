import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { CameraRig, mountCameraControls } from './camera/cameraRig';
import { loadHeightmap } from './heightmap';
import { Projection } from './projection';
import { createRainPlane, loadRainField } from './rain';
import { createOcean, mountSeaControls } from './sea/ocean';
import { createSea, createTerrain } from './terrain';
import { createCloudLayer, loadUkvClouds, mountCloudControls, type CloudLayer } from './weather/clouds';
import './style.css';

const container = document.getElementById('app')!;
const loading = document.getElementById('loading')!;
const exaggerationInput = document.getElementById('exaggeration') as HTMLInputElement;
const exaggerationValue = document.getElementById('exaggeration-value')!;
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

  const setExaggeration = (value: number) => {
    terrain.scale.y = value;
    // Float the rain just above the highest (exaggerated) peak.
    rain.position.y = (heightmap.meta.maxHeight / 1000) * value + 1;
    clouds?.setExaggeration(value);
    exaggerationValue.textContent = `${value}×`;
  };
  exaggerationInput.addEventListener('input', () => setExaggeration(Number(exaggerationInput.value)));
  setExaggeration(Number(exaggerationInput.value));

  // Start looking north over England and Wales.
  const target = projection.toWorld(-2.5, 53.5);
  rig.map.target.set(target.x, 0, target.z);
  camera.position.set(target.x - 60, 420, target.z + 620);
  rig.map.update();

  loading.remove();
  // Handles for driving the view from the console or screenshot scripts.
  if (import.meta.env.DEV) Object.assign(window, { camera, rig, projection, scene, clouds });
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  clouds?.resize();
});

const timer = new THREE.Timer();
timer.connect(document);
renderer.setAnimationLoop((time) => {
  timer.update(time);
  // Clamp the step so a stalled tab does not teleport the camera.
  rig?.update(Math.min(timer.getDelta(), 0.1));
  if (clouds) clouds.render();
  else renderer.render(scene, camera);
});

init().catch((error) => {
  console.error(error);
  loading.textContent = 'Failed to load terrain.';
});

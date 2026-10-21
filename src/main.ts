import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { loadHeightmap } from './heightmap';
import { Projection } from './projection';
import { createSea, createTerrain } from './terrain';
import './style.css';

const container = document.getElementById('app')!;
const loading = document.getElementById('loading')!;
const exaggerationInput = document.getElementById('exaggeration') as HTMLInputElement;
const exaggerationValue = document.getElementById('exaggeration-value')!;

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.6;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog('#b9cfe0', 600, 2600);

// World units are kilometres.
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 20000);

const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.47;
controls.minDistance = 5;
controls.maxDistance = 3000;

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

async function init() {
  const heightmap = await loadHeightmap(import.meta.env.BASE_URL);
  const projection = new Projection(heightmap.meta.proj);

  const terrain = createTerrain(heightmap);
  scene.add(terrain);
  scene.add(createSea(heightmap));

  const setExaggeration = (value: number) => {
    terrain.scale.y = value;
    exaggerationValue.textContent = `${value}×`;
  };
  exaggerationInput.addEventListener('input', () => setExaggeration(Number(exaggerationInput.value)));
  setExaggeration(Number(exaggerationInput.value));

  // Start looking north over England and Wales.
  const target = projection.toWorld(-2.5, 53.5);
  controls.target.set(target.x, 0, target.z);
  camera.position.set(target.x - 60, 420, target.z + 620);
  controls.update();

  loading.remove();
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

init().catch((error) => {
  console.error(error);
  loading.textContent = 'Failed to load terrain.';
});

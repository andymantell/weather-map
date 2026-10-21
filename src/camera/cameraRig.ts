import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { Flight, type CameraPose } from './flight';
import { EYE_HEIGHT, GroundControls } from './groundControls';
import { GroundSampler } from './groundSampler';

export type CameraMode = 'map' | 'flying' | 'ground';

const MAP_FOV = 45;
const GROUND_FOV = 60;
/** Lowest the map camera may sit above the ground (km). */
const MAP_CLEARANCE = 0.3;

/** Linear fog distances (km) at ground level; high up the scene's own fog applies, giving the map its long view. */
const GROUND_FOG = { near: 4, far: 140 };

const HINTS: Record<CameraMode, string> = {
  map: 'Drag to pan, right-drag to rotate, scroll to zoom. Double-click anywhere to fly down to it.',
  flying: 'Flying…',
  ground:
    'Drag to look, WASD or arrows to move, Shift to go faster. Scroll or Q/E to rise and sink. ' +
    'Double-click to hop somewhere, Esc for the map.',
};

/**
 * Owns the camera: an orbiting map view, a first person ground view, and the flights between them. Double-clicking
 * the map dives the camera down through the clouds to stand at that spot; Esc climbs back out. Each frame it also
 * fits the near plane and fog to the camera's height so close-up ground and the whole-UK view both render well.
 */
export class CameraRig {
  mode: CameraMode = 'map';
  readonly map: MapControls;
  readonly ground: GroundControls;
  readonly sampler: GroundSampler;
  private flight?: Flight;
  private afterFlight: CameraMode = 'map';
  private readonly listeners = new Set<(mode: CameraMode) => void>();
  private readonly baseFog?: { near: number; far: number };

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly element: HTMLElement,
    terrain: THREE.Mesh,
    private readonly scene: THREE.Scene,
  ) {
    this.sampler = new GroundSampler(terrain);
    this.map = new MapControls(camera, element);
    this.map.enableDamping = true;
    this.map.maxPolarAngle = Math.PI * 0.47;
    this.map.minDistance = 1;
    this.map.maxDistance = 3000;
    this.map.zoomToCursor = true;
    this.ground = new GroundControls(camera, element, this.sampler);
    if (scene.fog instanceof THREE.Fog) this.baseFog = { near: scene.fog.near, far: scene.fog.far };

    element.addEventListener('dblclick', this.onDoubleClick);
    window.addEventListener('keydown', (event) => {
      if (event.code === 'Escape' && this.mode === 'ground') this.toMap();
    });
  }

  onModeChange(listener: (mode: CameraMode) => void): void {
    this.listeners.add(listener);
    listener(this.mode);
  }

  update(dt: number): void {
    if (this.mode === 'map') {
      this.map.update(dt);
      const p = this.camera.position;
      const floor = this.sampler.heightAt(p.x, p.z) + MAP_CLEARANCE;
      if (p.y < floor) p.y = floor;
    } else if (this.mode === 'flying' && this.flight) {
      this.flight.update(this.camera, dt);
      if (this.flight.done) this.finishFlight();
    } else if (this.mode === 'ground') {
      this.ground.update(dt);
    }
    this.fitToHeight();
  }

  /** Dives from the current view to stand on the ground at a point. */
  toGround(point: THREE.Vector3, options: { heading?: number; height?: number; instant?: boolean } = {}): void {
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    const heading = options.heading ?? Math.atan2(-forward.x, -forward.z);
    const height = options.height ?? EYE_HEIGHT;
    const eye = new THREE.Vector3(point.x, this.sampler.heightAt(point.x, point.z) + height, point.z);
    const end: CameraPose = {
      position: eye,
      // A touch below the horizon, as you'd look on arriving somewhere.
      quaternion: GroundControls.orientation(heading, -0.04),
      fov: GROUND_FOV,
    };
    const horizontal = new THREE.Vector3(-Math.sin(heading), 0, -Math.cos(heading));
    const distance = this.camera.position.distanceTo(eye);
    const approach = THREE.MathUtils.clamp(distance * 0.08, 1, 25);
    this.fly(end, 'ground', options.instant, {
      departure: forward,
      departureLength: distance * 0.3,
      // Come in down a 30 degree slope, levelling out as the view settles.
      arrival: horizontal.clone().add(new THREE.Vector3(0, -0.6, 0)),
      arrivalLength: approach,
      clearance: Math.min(height, 0.05),
    });
  }

  /** Climbs from the ground back to a map view over where the camera is. */
  toMap(options: { instant?: boolean } = {}): void {
    const p = this.camera.position;
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    const horizontal = new THREE.Vector3(forward.x, 0, forward.z);
    if (horizontal.lengthSq() < 1e-6) horizontal.set(0, 0, -1);
    horizontal.normalize();
    const target = new THREE.Vector3(p.x, 0, p.z).addScaledVector(horizontal, 25);
    target.y = this.sampler.heightAt(target.x, target.z);
    const position = target.clone().addScaledVector(horizontal, -75).setY(target.y + 60);
    const quaternion = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(position, target, new THREE.Vector3(0, 1, 0)),
    );
    const end: CameraPose = { position, quaternion, fov: MAP_FOV };
    const view = target.clone().sub(position).normalize();
    this.fly(end, 'map', options.instant, {
      departure: horizontal.clone().add(new THREE.Vector3(0, 0.8, 0)),
      departureLength: 8,
      arrival: view,
      arrivalLength: position.distanceTo(p) * 0.3,
      clearance: 0.05,
    });
    this.map.target.copy(target);
  }

  /** Hops along the ground to a nearby point in an arc, keeping the current height. */
  private hop(point: THREE.Vector3): void {
    const p = this.camera.position;
    const height = this.ground.height;
    const eye = new THREE.Vector3(point.x, this.sampler.heightAt(point.x, point.z) + height, point.z);
    const along = new THREE.Vector3(eye.x - p.x, 0, eye.z - p.z);
    const distance = along.length();
    if (distance < 1e-3) return;
    along.normalize();
    const heading = Math.atan2(-along.x, -along.z);
    const end: CameraPose = {
      position: eye,
      quaternion: GroundControls.orientation(heading, this.ground.pitch),
      fov: GROUND_FOV,
    };
    const up = new THREE.Vector3(0, 1, 0);
    this.fly(end, 'ground', false, {
      departure: along.clone().add(up.clone().multiplyScalar(0.5)),
      departureLength: distance * 0.4,
      arrival: along.clone().sub(up.clone().multiplyScalar(0.5)),
      arrivalLength: distance * 0.4,
      clearance: Math.min(height, 0.05),
    });
  }

  private fly(end: CameraPose, then: CameraMode, instant: boolean | undefined, options: ConstructorParameters<typeof Flight>[3]): void {
    const start: CameraPose = {
      position: this.camera.position.clone(),
      quaternion: this.camera.quaternion.clone(),
      fov: this.camera.fov,
    };
    this.map.enabled = false;
    this.ground.enabled = false;
    this.afterFlight = then;
    this.flight = new Flight(start, end, this.sampler, options);
    this.setMode('flying');
    if (instant) {
      this.flight.update(this.camera, this.flight.duration);
      this.finishFlight();
    }
  }

  private finishFlight(): void {
    this.flight = undefined;
    if (this.afterFlight === 'ground') {
      this.ground.begin();
    } else {
      this.map.enabled = true;
      this.map.update();
    }
    this.setMode(this.afterFlight);
  }

  private setMode(mode: CameraMode): void {
    this.mode = mode;
    this.element.style.cursor = mode === 'ground' ? 'grab' : '';
    for (const listener of this.listeners) listener(mode);
  }

  private fitToHeight(): void {
    const p = this.camera.position;
    const above = Math.max(p.y - this.sampler.heightAt(p.x, p.z), 1e-4);
    // The logarithmic depth buffer keeps precision over a huge range, so the near plane only needs to stay in front
    // of the ground under the camera: half a metre when standing, 100 m when looking at the whole UK.
    const near = THREE.MathUtils.clamp(above * 0.25, 0.0003, 0.1);
    if (Math.abs(near - this.camera.near) > this.camera.near * 0.05) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }

    if (this.baseFog && this.scene.fog instanceof THREE.Fog) {
      // Haze closes in below ~300 km and reaches ground level visibility at ~200 m.
      const t = THREE.MathUtils.smoothstep(Math.log10(above), Math.log10(0.2), Math.log10(300));
      this.scene.fog.near = GROUND_FOG.near * Math.pow(this.baseFog.near / GROUND_FOG.near, t);
      this.scene.fog.far = GROUND_FOG.far * Math.pow(this.baseFog.far / GROUND_FOG.far, t);
    }
  }

  private onDoubleClick = (event: MouseEvent) => {
    if (this.mode === 'flying') return;
    const rect = this.element.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = this.sampler.raycast(ray.ray.origin, ray.ray.direction);
    if (!hit) return;
    if (this.mode === 'map') this.toGround(hit);
    else this.hop(hit);
  };

  /** Text describing the controls for the current mode. */
  static hint(mode: CameraMode): string {
    return HINTS[mode];
  }
}

/** Adds the map/ground switch and the controls hint to the HUD. */
export function mountCameraControls(hud: HTMLElement, rig: CameraRig, hint: HTMLElement): void {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'camera-mode';
  button.addEventListener('click', () => {
    if (rig.mode === 'map') {
      // Drop to whatever is in the middle of the screen.
      const camera = rig.map.object as THREE.PerspectiveCamera;
      const direction = camera.getWorldDirection(new THREE.Vector3());
      const hit = rig.sampler.raycast(camera.position, direction) ?? rig.map.target.clone();
      rig.toGround(hit);
    } else if (rig.mode === 'ground') {
      rig.toMap();
    }
    button.blur();
  });
  hud.querySelector('h1')!.after(button);
  rig.onModeChange((mode) => {
    button.textContent = mode === 'ground' ? 'Back to map' : 'Drop to ground';
    button.disabled = mode === 'flying';
    hint.textContent = CameraRig.hint(mode);
  });
}

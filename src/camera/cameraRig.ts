import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { Flight, type CameraPose, type FlightOptions } from './flight';
import { MIN_HEIGHT, GroundControls } from './groundControls';
import { GroundSampler } from './groundSampler';

export type CameraMode = 'map' | 'flying' | 'ground';

const MAP_FOV = 45;
const GROUND_FOV = 60;
/** Lowest the map camera may sit above the ground (km). */
const MAP_CLEARANCE = 0.3;

const HINTS: Record<CameraMode, string> = {
  map: 'Drag to pan, right-drag to rotate, scroll to zoom. Double-click anywhere to fly down to it. H hides this panel.',
  flying: 'Flying…',
  ground:
    'Drag to look, WASD or arrows to move, Shift to go faster. Scroll or Q/E to rise and sink. ' +
    'Double-click to hop somewhere, Esc for the map, H to hide this panel.',
};

/**
 * Owns the camera: an orbiting map view, a first person ground view, and the flights between them. Double-clicking
 * the map dives the camera down through the clouds to stand at that spot; Esc climbs back out. Each frame it also
 * fits the near plane to the camera's height so close-up ground and the whole-UK view both render well.
 */
export class CameraRig {
  mode: CameraMode = 'map';
  readonly map: MapControls;
  readonly ground: GroundControls;
  readonly sampler: GroundSampler;
  private flight?: Flight;
  private afterFlight: CameraMode = 'map';
  /** Where the last dive left the map from and where it landed, so the climb back can retrace it. */
  private lastDive?: { from: CameraPose; target: THREE.Vector3; landing: THREE.Vector3 };
  private readonly listeners = new Set<(mode: CameraMode) => void>();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly element: HTMLElement,
    terrain: THREE.Mesh,
  ) {
    this.sampler = new GroundSampler(terrain);
    this.map = new MapControls(camera, element);
    this.map.enableDamping = true;
    this.map.maxPolarAngle = Math.PI * 0.47;
    this.map.minDistance = 1;
    this.map.maxDistance = 3000;
    this.map.zoomToCursor = true;
    this.ground = new GroundControls(camera, element, this.sampler);

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

  /**
   * Dives from the current view to stand on the ground at a point. heading is a compass bearing in radians
   * (0 north, PI/2 east) and defaults to the current view direction; height is km above the ground.
   */
  toGround(point: THREE.Vector3, options: { heading?: number; height?: number; instant?: boolean } = {}): void {
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    // Yaw turns anticlockwise seen from above, so it is minus the bearing.
    const heading = options.heading !== undefined ? -options.heading : Math.atan2(-forward.x, -forward.z);
    const height = options.height ?? MIN_HEIGHT;
    const eye = new THREE.Vector3(point.x, this.sampler.heightAt(point.x, point.z) + height, point.z);
    const end: CameraPose = {
      position: eye,
      // A touch below the horizon, as you'd look on arriving somewhere.
      quaternion: GroundControls.orientation(heading, -0.04),
      fov: GROUND_FOV,
    };
    const flightOptions = this.diveOptions(this.camera.position, forward, eye, heading, height);
    if (this.mode === 'map') {
      this.lastDive = {
        from: { position: this.camera.position.clone(), quaternion: this.camera.quaternion.clone(), fov: this.camera.fov },
        target: this.map.target.clone(),
        landing: eye.clone(),
      };
    }
    this.fly(end, 'ground', options.instant, flightOptions);
  }

  /** The path of a dive from a map view to an eye position on the ground. */
  private diveOptions(from: THREE.Vector3, forward: THREE.Vector3, eye: THREE.Vector3, heading: number, height: number): FlightOptions {
    const horizontal = new THREE.Vector3(-Math.sin(heading), 0, -Math.cos(heading));
    const distance = from.distanceTo(eye);
    return {
      departure: forward.clone(),
      departureLength: distance * 0.3,
      // Come in down a 30 degree slope, levelling out as the view settles.
      arrival: horizontal.add(new THREE.Vector3(0, -0.6, 0)),
      arrivalLength: THREE.MathUtils.clamp(distance * 0.08, 1, 25),
      clearance: Math.min(height, 0.05),
    };
  }

  /**
   * Climbs from the ground back to the map: a dive from the map view to here, played backwards, so the camera looks
   * at the ground the whole way up. The map view is the one the last dive left from, shifted by however far the
   * camera has moved since landing, or a view over the camera if there was no dive.
   */
  toMap(options: { instant?: boolean } = {}): void {
    const p = this.camera.position;
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    const heading = Math.atan2(-forward.x, -forward.z);
    let end: CameraPose;
    let target: THREE.Vector3;
    if (this.lastDive) {
      const { from, landing } = this.lastDive;
      const offset = new THREE.Vector3(p.x - landing.x, 0, p.z - landing.z);
      end = { position: from.position.clone().add(offset), quaternion: from.quaternion.clone(), fov: from.fov };
      target = this.lastDive.target.clone().add(offset);
    } else {
      const horizontal = new THREE.Vector3(-Math.sin(heading), 0, -Math.cos(heading));
      target = new THREE.Vector3(p.x, 0, p.z).addScaledVector(horizontal, 25);
      target.y = this.sampler.heightAt(target.x, target.z);
      const position = target.clone().addScaledVector(horizontal, -75).setY(target.y + 60);
      const quaternion = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().lookAt(position, target, new THREE.Vector3(0, 1, 0)),
      );
      end = { position, quaternion, fov: MAP_FOV };
    }
    const mapForward = new THREE.Vector3(0, 0, -1).applyQuaternion(end.quaternion);
    this.fly(end, 'map', options.instant, this.diveOptions(end.position, mapForward, p, heading, this.ground.height), true);
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

  /** Flies from the current view to `end`; reversed builds the path from `end` to here and plays it backwards. */
  private fly(end: CameraPose, then: CameraMode, instant: boolean | undefined, options: FlightOptions, reversed = false): void {
    const start: CameraPose = {
      position: this.camera.position.clone(),
      quaternion: this.camera.quaternion.clone(),
      fov: this.camera.fov,
    };
    this.map.enabled = false;
    this.ground.enabled = false;
    this.afterFlight = then;
    this.flight = reversed
      ? new Flight(end, start, this.sampler, options, true)
      : new Flight(start, end, this.sampler, options);
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
    // of the ground under the camera: about 12 m at the lowest ground view, 100 m when looking at the whole UK.
    const near = THREE.MathUtils.clamp(above * 0.25, 0.0003, 0.1);
    if (Math.abs(near - this.camera.near) > this.camera.near * 0.05) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
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
  window.addEventListener('keydown', (event) => {
    if (event.code !== 'KeyH' || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    hud.style.visibility = hud.style.visibility === 'hidden' ? '' : 'hidden';
  });
  rig.onModeChange((mode) => {
    button.textContent = mode === 'ground' ? 'Back to map' : 'Drop to ground';
    button.disabled = mode === 'flying';
    hint.textContent = CameraRig.hint(mode);
  });
}

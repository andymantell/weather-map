import * as THREE from 'three';
import type { GroundSampler } from './groundSampler';

export interface CameraPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  fov: number;
}

export interface FlightOptions {
  /** Direction the camera sets off in, and how far its first control point lies along it (km). */
  departure: THREE.Vector3;
  departureLength: number;
  /** Direction the camera arrives travelling in, and how far back along it the last control point lies (km). */
  arrival: THREE.Vector3;
  arrivalLength: number;
  /** Lowest the camera may go above the ground on the way (km). */
  clearance: number;
}

const SAMPLES = 256;
/** Height (km) added to the altitude when pacing the flight, so the last few metres are not crawled through. */
const PACE_FLOOR = 1.5;

const forwardOf = (q: THREE.Quaternion) => new THREE.Vector3(0, 0, -1).applyQuaternion(q);

/**
 * A camera flight along a cubic Bezier curve, paced so the scenery seems to stream past at a steady rate: speed is
 * proportional to height above ground, so the camera covers hundreds of km in the first second, slows as it drops
 * through the clouds and glides in over the last few hundred metres. The view looks along the direction of travel
 * mid-flight and blends to the start and end orientations at either end.
 */
export class Flight {
  readonly duration: number;
  private elapsed = 0;
  private readonly curve: THREE.CubicBezierCurve3;
  /** Normalised pace (cumulative time) at each curve sample. */
  private readonly pace: Float32Array;
  private readonly from: CameraPose;
  private readonly to: CameraPose;

  constructor(
    from: CameraPose,
    to: CameraPose,
    private readonly ground: GroundSampler,
    private readonly options: FlightOptions,
  ) {
    this.from = { position: from.position.clone(), quaternion: from.quaternion.clone(), fov: from.fov };
    this.to = { position: to.position.clone(), quaternion: to.quaternion.clone(), fov: to.fov };
    this.curve = new THREE.CubicBezierCurve3(
      this.from.position,
      this.from.position.clone().addScaledVector(options.departure.clone().normalize(), options.departureLength),
      this.to.position.clone().addScaledVector(options.arrival.clone().normalize(), -options.arrivalLength),
      this.to.position,
    );

    this.pace = new Float32Array(SAMPLES + 1);
    const prev = this.curve.getPoint(0);
    const p = new THREE.Vector3();
    let total = 0;
    for (let i = 1; i <= SAMPLES; i++) {
      this.curve.getPoint(i / SAMPLES, p);
      const mid = prev.clone().add(p).multiplyScalar(0.5);
      const altitude = Math.max(mid.y - ground.heightAt(mid.x, mid.z), 0);
      total += prev.distanceTo(p) / (altitude + PACE_FLOOR);
      this.pace[i] = total;
      prev.copy(p);
    }
    for (let i = 1; i <= SAMPLES; i++) this.pace[i] /= total;
    // About 1.2 s per e-fold of height above ground, within limits.
    this.duration = THREE.MathUtils.clamp(total * 1.2, 1.5, 9);
  }

  get done(): boolean {
    return this.elapsed >= this.duration;
  }

  /** Advances the flight and poses the camera. */
  update(camera: THREE.PerspectiveCamera, dt: number): void {
    this.elapsed = Math.min(this.elapsed + dt, this.duration);
    const u = this.elapsed / this.duration;
    // Ease in and out in time, then spend that time according to the pace table.
    const eased = u * u * (3 - 2 * u);
    const s = this.curveParameter(eased);

    const p = this.curve.getPoint(s);
    const floor = this.ground.heightAt(p.x, p.z) + this.options.clearance;
    if (s < 1) p.y = Math.max(p.y, floor);
    camera.position.copy(p);

    // Look where we're going, blending from the start view and into the end view.
    const tangent = this.curve.getTangent(s);
    const look = tangent.clone();
    look.lerp(forwardOf(this.from.quaternion), 1 - THREE.MathUtils.smoothstep(s, 0, 0.25));
    look.lerp(forwardOf(this.to.quaternion), THREE.MathUtils.smoothstep(s, 0.55, 0.97));
    look.y = THREE.MathUtils.clamp(look.normalize().y, -0.97, 0.97);
    const travelling = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(new THREE.Vector3(), look, new THREE.Vector3(0, 1, 0)),
    );
    // Snap exactly onto the end orientations at the ends.
    if (s < 0.1) travelling.slerp(this.from.quaternion, 1 - s / 0.1);
    if (s > 0.97) travelling.slerp(this.to.quaternion, (s - 0.97) / 0.03);
    camera.quaternion.copy(travelling);

    camera.fov = THREE.MathUtils.lerp(this.from.fov, this.to.fov, THREE.MathUtils.smoothstep(s, 0.3, 1));
    camera.updateProjectionMatrix();
  }

  private curveParameter(pace: number): number {
    let lo = 0;
    let hi = SAMPLES;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.pace[mid] < pace) lo = mid;
      else hi = mid;
    }
    const span = this.pace[hi] - this.pace[lo];
    const f = span > 0 ? (pace - this.pace[lo]) / span : 0;
    return (lo + f) / SAMPLES;
  }
}

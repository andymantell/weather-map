import * as THREE from 'three';
import type { GroundSampler } from './groundSampler';

/** Lowest the ground view goes, and where a dive ends (km). Lower than this the coarse terrain looks bare. */
export const MIN_HEIGHT = 0.05;
const MAX_HEIGHT = 8;

/**
 * First person controls that hold a height above the ground, like a drone: drag to look, WASD or the
 * arrow keys to move, the wheel or Q/E to rise and sink, Shift to go faster. Speed scales with height so cruising
 * over a town and skimming over the Pennines both feel right.
 */
export class GroundControls {
  enabled = false;
  /** Height of the camera above the ground or sea (km). */
  height = MIN_HEIGHT;
  yaw = 0;
  pitch = 0;

  private readonly keys = new Set<string>();
  private readonly velocity = new THREE.Vector2();
  private dragging = false;
  private lastPointer = new THREE.Vector2();
  private targetHeight = MIN_HEIGHT;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly element: HTMLElement,
    private readonly ground: GroundSampler,
  ) {
    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('pointercancel', this.onPointerUp);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Takes over from wherever the camera is now, keeping its heading and pitch. */
  begin(): void {
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    this.yaw = Math.atan2(-forward.x, -forward.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1));
    const p = this.camera.position;
    this.height = this.targetHeight = Math.max(p.y - this.ground.heightAt(p.x, p.z), MIN_HEIGHT);
    this.velocity.set(0, 0);
    this.enabled = true;
  }

  /** The camera orientation for a heading and pitch, as used by these controls. */
  static orientation(yaw: number, pitch: number): THREE.Quaternion {
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  }

  update(dt: number): void {
    if (!this.enabled) return;
    const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 5 : 1;

    // Climb and sink proportionally, so one key press means the same at 50 m and at 5 km.
    const climb = (this.keys.has('KeyE') || this.keys.has('PageUp') ? 1 : 0) -
      (this.keys.has('KeyQ') || this.keys.has('PageDown') ? 1 : 0);
    if (climb) this.targetHeight *= Math.exp(climb * 1.2 * fast * dt);
    this.targetHeight = THREE.MathUtils.clamp(this.targetHeight, MIN_HEIGHT, MAX_HEIGHT);
    this.height = THREE.MathUtils.damp(this.height, this.targetHeight, 6, dt);

    const forward = (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) -
      (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
    const strafe = (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) -
      (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);
    // km/s, rising with height: 75 m/s at the lowest height (the terrain is coarse).
    const speed = this.height * 1.5 * fast;
    const wish = new THREE.Vector2(strafe, -forward);
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
    wish.rotateAround(new THREE.Vector2(), -this.yaw);
    this.velocity.x = THREE.MathUtils.damp(this.velocity.x, wish.x, 8, dt);
    this.velocity.y = THREE.MathUtils.damp(this.velocity.y, wish.y, 8, dt);

    const p = this.camera.position;
    p.x += this.velocity.x * dt;
    p.z += this.velocity.y * dt;
    p.y = this.ground.heightAt(p.x, p.z) + this.height;
    this.camera.quaternion.copy(GroundControls.orientation(this.yaw, this.pitch));
  }

  private onPointerDown = (event: PointerEvent) => {
    if (!this.enabled) return;
    this.dragging = true;
    this.lastPointer.set(event.clientX, event.clientY);
    this.element.setPointerCapture(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent) => {
    if (!this.enabled || !this.dragging) return;
    // Drag the view like grabbing the scene: a fixed angle per pixel scaled by the field of view.
    const perPixel = THREE.MathUtils.degToRad(this.camera.fov) / this.element.clientHeight;
    this.yaw += (event.clientX - this.lastPointer.x) * perPixel;
    this.pitch += (event.clientY - this.lastPointer.y) * perPixel;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.5, 1.5);
    this.lastPointer.set(event.clientX, event.clientY);
  };

  private onPointerUp = (event: PointerEvent) => {
    this.dragging = false;
    if (this.element.hasPointerCapture(event.pointerId)) this.element.releasePointerCapture(event.pointerId);
  };

  private onWheel = (event: WheelEvent) => {
    if (!this.enabled) return;
    event.preventDefault();
    this.targetHeight = THREE.MathUtils.clamp(this.targetHeight * Math.exp(event.deltaY * 0.0015), MIN_HEIGHT, MAX_HEIGHT);
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    this.keys.add(event.code);
    if (this.enabled && event.code.startsWith('Arrow')) event.preventDefault();
  };

  private onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
  };
}

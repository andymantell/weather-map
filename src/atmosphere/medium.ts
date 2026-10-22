import * as THREE from 'three';

/**
 * The air, in km and km^-1: Earth's standard atmosphere as in Hillaire (2020) and Bruneton's model (Rayleigh, Mie
 * and ozone), plus a boundary-layer haze whose density comes from UKV's screen-level visibility.
 */
export const BOTTOM_RADIUS = 6360;
export const TOP_RADIUS = 6460;
export const RAYLEIGH_SCATTERING = new THREE.Vector3(5.802e-3, 13.558e-3, 33.1e-3);
export const RAYLEIGH_SCALE = 8;
export const MIE_SCATTERING = 3.996e-3;
export const MIE_EXTINCTION = 4.44e-3;
export const MIE_SCALE = 1.2;
export const OZONE_ABSORPTION = new THREE.Vector3(0.65e-3, 1.881e-3, 0.085e-3);
export const GROUND_ALBEDO = new THREE.Vector3(0.12, 0.13, 0.1);

/** Clean-air extinction at sea level, km^-1, green: what visibility the standard atmosphere alone gives. */
const CLEAN_EXTINCTION = RAYLEIGH_SCATTERING.y + MIE_EXTINCTION;

export interface Haze {
  /** Extra aerosol or droplet extinction at the ground, km^-1. */
  extinction: number;
  /** Fraction of that extinction that scatters (the rest absorbs). */
  albedo: number;
  /** e-folding height of the haze above the ground, km. */
  scale: number;
  /** Height of the ground it sits on, world km. */
  base: number;
}

/**
 * Haze for a meteorological visibility in km. Koschmieder: visibility = 3.912 / extinction at a 2% contrast
 * threshold. Fog (under 1 km) is a thin, bright, white droplet layer; ordinary haze is a deeper, slightly absorbing
 * aerosol filling the boundary layer.
 */
export function hazeForVisibility(visibilityKm: number, groundY: number): Haze {
  const v = THREE.MathUtils.clamp(visibilityKm, 0.03, 200);
  const extinction = Math.max(3.912 / v - CLEAN_EXTINCTION, 0);
  const t = THREE.MathUtils.smoothstep(Math.log(v), Math.log(0.5), Math.log(8));
  return { extinction, albedo: THREE.MathUtils.lerp(0.99, 0.92, t), scale: THREE.MathUtils.lerp(0.12, 1.1, t), base: groundY };
}

function extinctionAt(h: number, haze: Haze, out: THREE.Vector3): THREE.Vector3 {
  const hr = Math.max(h, 0);
  const r = Math.exp(-hr / RAYLEIGH_SCALE);
  const m = Math.exp(-hr / MIE_SCALE);
  const z = Math.exp(-Math.max(h - haze.base, 0) / haze.scale);
  const oz = Math.max(0, 1 - Math.abs(hr - 25) / 15);
  const mie = MIE_EXTINCTION * m + haze.extinction * z;
  return out.copy(RAYLEIGH_SCATTERING).multiplyScalar(r).addScalar(mie).addScaledVector(OZONE_ABSORPTION, oz);
}

/**
 * Transmittance from a point at altitude h (km) to space towards a direction with zenith cosine mu, on the CPU, for
 * the colour of sunlight and moonlight at the ground. Zero if the ray hits the planet.
 */
export function transmittanceToSpace(h: number, mu: number, haze: Haze, out = new THREE.Vector3()): THREE.Vector3 {
  const r = BOTTOM_RADIUS + Math.max(h, 0);
  const disc = r * r * (mu * mu - 1) + BOTTOM_RADIUS * BOTTOM_RADIUS;
  if (mu < 0 && disc >= 0 && -r * mu - Math.sqrt(disc) > 0) return out.set(0, 0, 0);
  const length = -r * mu + Math.sqrt(Math.max(r * r * (mu * mu - 1) + TOP_RADIUS * TOP_RADIUS, 0));
  const steps = 64;
  const depth = new THREE.Vector3();
  const e = new THREE.Vector3();
  for (let i = 0; i < steps; i++) {
    // Steps bunch up near the start, where the air is densest.
    const t0 = length * (i / steps) ** 2;
    const t1 = length * ((i + 1) / steps) ** 2;
    const t = (t0 + t1) / 2;
    const alt = Math.sqrt(r * r + t * t + 2 * r * t * mu) - BOTTOM_RADIUS;
    depth.addScaledVector(extinctionAt(alt, haze, e), t1 - t0);
  }
  return out.set(Math.exp(-depth.x), Math.exp(-depth.y), Math.exp(-depth.z));
}

/** Rec. 709 luminance. */
export function luminance(c: THREE.Vector3 | THREE.Color): number {
  const [r, g, b] = c instanceof THREE.Color ? [c.r, c.g, c.b] : [c.x, c.y, c.z];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

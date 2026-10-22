import * as THREE from 'three';

/**
 * Where the sun, moon and stars are in the sky for a moment and a place. Low-precision ephemerides that are good to
 * a few arcminutes over this century: the sun from the Astronomical Almanac's short series, the moon from Paul
 * Schlyter's "How to compute planetary positions" with its largest perturbation terms. The moon is corrected for
 * parallax (about a degree), which matters for where it rises; refraction is left out.
 */

const DEG = Math.PI / 180;

/** Days since J2000.0 (2000-01-01 12:00 TT, taken as UT here). */
function daysSinceJ2000(date: Date): number {
  return date.getTime() / 86400e3 + 2440587.5 - 2451545.0;
}

/** Greenwich mean sidereal time, radians. */
function gmst(date: Date): number {
  const d = daysSinceJ2000(date);
  return THREE.MathUtils.euclideanModulo(280.46061837 + 360.98564736629 * d, 360) * DEG;
}

/** Mean obliquity of the ecliptic, radians. */
function obliquity(d: number): number {
  return (23.439291 - 3.563e-7 * d) * DEG;
}

/** Unit vector in equatorial coordinates (x to the March equinox, z to the north celestial pole). */
function eclipticToEquatorial(lon: number, lat: number, d: number): THREE.Vector3 {
  const e = obliquity(d);
  const x = Math.cos(lon) * Math.cos(lat);
  const y = Math.sin(lon) * Math.cos(lat);
  const z = Math.sin(lat);
  return new THREE.Vector3(x, y * Math.cos(e) - z * Math.sin(e), y * Math.sin(e) + z * Math.cos(e));
}

/** Direction to the sun, equatorial. */
function sunEquatorial(d: number): THREE.Vector3 {
  const L = (280.46 + 0.9856474 * d) * DEG;
  const g = (357.528 + 0.9856003 * d) * DEG;
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  return eclipticToEquatorial(lambda, 0, d);
}

/** Geocentric position of the moon, equatorial, in Earth radii. */
function moonEquatorial(d0: number): THREE.Vector3 {
  // Schlyter's day number starts at 2000 Jan 0.0.
  const d = d0 + 1.5;
  const N = (125.1228 - 0.0529538083 * d) * DEG;
  const i = 5.1454 * DEG;
  const w = (318.0634 + 0.1643573223 * d) * DEG;
  const a = 60.2666;
  const e = 0.0549;
  const M = (115.3654 + 13.0649929509 * d) * DEG;
  let E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
  for (let k = 0; k < 5; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xv = a * (Math.cos(E) - e);
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const v = Math.atan2(yv, xv);
  let r = Math.hypot(xv, yv);
  const xh = r * (Math.cos(N) * Math.cos(v + w) - Math.sin(N) * Math.sin(v + w) * Math.cos(i));
  const yh = r * (Math.sin(N) * Math.cos(v + w) + Math.cos(N) * Math.sin(v + w) * Math.cos(i));
  const zh = r * Math.sin(v + w) * Math.sin(i);
  let lon = Math.atan2(yh, xh);
  let lat = Math.atan2(zh, Math.hypot(xh, yh));

  // Perturbations, in degrees and Earth radii.
  const Ms = (356.047 + 0.9856002585 * d) * DEG;
  const ws = (282.9404 + 4.70935e-5 * d) * DEG;
  const Ls = Ms + ws;
  const Lm = M + w + N;
  const D = Lm - Ls;
  const F = Lm - N;
  const s = Math.sin;
  lon +=
    (-1.274 * s(M - 2 * D) +
      0.658 * s(2 * D) -
      0.186 * s(Ms) -
      0.059 * s(2 * M - 2 * D) -
      0.057 * s(M - 2 * D + Ms) +
      0.053 * s(M + 2 * D) +
      0.046 * s(2 * D - Ms) +
      0.041 * s(M - Ms) -
      0.035 * s(D) -
      0.031 * s(M + Ms) -
      0.015 * s(2 * F - 2 * D) +
      0.011 * s(M - 4 * D)) *
    DEG;
  lat +=
    (-0.173 * s(F - 2 * D) -
      0.055 * s(M - F - 2 * D) -
      0.046 * s(M + F - 2 * D) +
      0.033 * s(F + 2 * D) +
      0.017 * s(2 * M + F)) *
    DEG;
  r += -0.58 * Math.cos(M - 2 * D) - 0.46 * Math.cos(2 * D);
  return eclipticToEquatorial(lon, lat, d0).multiplyScalar(r);
}

export interface SkyState {
  /** Unit vectors in world space (x east, y up, z south on the map's grid). */
  sun: THREE.Vector3;
  moon: THREE.Vector3;
  /** Fraction of the moon's disc that is lit, 0 (new) to 1 (full). */
  moonIllumination: number;
  /** Angle sun-earth as seen from the moon, radians: 0 at full moon. */
  moonPhaseAngle: number;
  /** Apparent angular radius of the moon, radians. */
  moonRadius: number;
  /** Rotates equatorial unit vectors into world space, for the stars. */
  equatorialToWorld: THREE.Matrix3;
}

/**
 * Sun, moon and star directions for an observer at (lon, lat) in degrees. north and east are the world-space
 * directions of true north and east there, which differ from the grid's by the projection's convergence.
 */
export function skyState(date: Date, lon: number, lat: number, north: THREE.Vector3, east: THREE.Vector3): SkyState {
  const d = daysSinceJ2000(date);
  const lst = gmst(date) + lon * DEG;
  const phi = lat * DEG;
  const up = new THREE.Vector3(0, 1, 0);

  // Equatorial -> local east/north/up, then into world space.
  const cl = Math.cos(lst);
  const sl = Math.sin(lst);
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  // Rows: east, north, up components of the equatorial x, y, z axes.
  // With hour angle H = lst - ra: east = -cosδ sinH, north = sinδ cosφ - cosδ cosH sinφ, up = sinδ sinφ + cosδ cosH cosφ.
  const eastRow = [-sl, cl, 0];
  const northRow = [-sp * cl, -sp * sl, cp];
  const upRow = [cp * cl, cp * sl, sp];
  const toWorld = new THREE.Matrix3();
  const col = (k: number) =>
    new THREE.Vector3()
      .addScaledVector(east, eastRow[k])
      .addScaledVector(north, northRow[k])
      .addScaledVector(up, upRow[k]);
  const cx = col(0);
  const cy = col(1);
  const cz = col(2);
  toWorld.set(cx.x, cy.x, cz.x, cx.y, cy.y, cz.y, cx.z, cy.z, cz.z);

  const sunEq = sunEquatorial(d);
  const sun = sunEq.clone().applyMatrix3(toWorld).normalize();

  // Topocentric moon: subtract the observer's position (in Earth radii) from the geocentric moon.
  const moonGeo = moonEquatorial(d);
  const observer = new THREE.Vector3(cp * cl, cp * sl, sp);
  const moonTopo = moonGeo.clone().sub(observer);
  const moonDistance = moonTopo.length();
  const moon = moonTopo.clone().normalize().applyMatrix3(toWorld).normalize();

  // Phase angle at the moon between the sun and the earth; the sun is far enough to treat as parallel light.
  const elongation = Math.acos(THREE.MathUtils.clamp(sunEq.dot(moonGeo.clone().normalize()), -1, 1));
  const moonPhaseAngle = Math.PI - elongation;
  const moonIllumination = (1 + Math.cos(moonPhaseAngle)) / 2;
  const moonRadius = Math.asin(0.2725 / moonDistance);
  return { sun, moon, moonIllumination, moonPhaseAngle, moonRadius, equatorialToWorld: toWorld };
}

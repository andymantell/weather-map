import * as THREE from 'three';

/**
 * Where the sun, moon and stars are in the sky for a moment and a place. Low-precision ephemerides that are good to
 * a few arcminutes over this century: the sun from the Astronomical Almanac's short series, the moon from Paul
 * Schlyter's "How to compute planetary positions" with its largest perturbation terms. The moon is corrected for
 * parallax (about a degree), which matters for where it rises; refraction is left out here (the sky shader applies
 * it to the stars and planets). The planets come from JPL's approximate elements, and the catalogue stars (stars.ts)
 * are precessed from J2000 to the date.
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
  /** Rotates equatorial unit vectors (equator and equinox of date) into world space. */
  equatorialToWorld: THREE.Matrix3;
  /** Rotates J2000 equatorial unit vectors into world space: precession, then the above. For catalogue stars. */
  j2000ToWorld: THREE.Matrix3;
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
  const j2000ToWorld = toWorld.clone().multiply(precessionFromJ2000(date));
  return { sun, moon, moonIllumination, moonPhaseAngle, moonRadius, equatorialToWorld: toWorld, j2000ToWorld };
}

/**
 * Precession of the equator and equinox from J2000 to the date (IAU 1976, Lieske 1977): about 50 arcseconds a
 * year, so a third of a degree by the 2020s, which is the difference between a star sitting on a ridge line or
 * above it. Nutation (under 20 arcseconds) is left out.
 */
export function precessionFromJ2000(date: Date): THREE.Matrix3 {
  const T = daysSinceJ2000(date) / 36525;
  const as = DEG / 3600;
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * as;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * as;
  const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * as;
  const [cZ, sZ, cz, sz, cT, sT] = [Math.cos(zeta), Math.sin(zeta), Math.cos(z), Math.sin(z), Math.cos(theta), Math.sin(theta)];
  return new THREE.Matrix3().set(
    cZ * cz * cT - sZ * sz, -sZ * cz * cT - cZ * sz, -cz * sT,
    cZ * sz * cT + sZ * cz, -sZ * sz * cT + cZ * cz, -sz * sT,
    cZ * sT, -sZ * sT, cT,
  );
}

/**
 * Keplerian elements and their rates per Julian century, J2000 ecliptic and equinox, from JPL's "Approximate
 * Positions of the Planets" (Standish), table 1 for 1800-2050: a (au), e, I, L, long. perihelion, long. node (deg).
 */
const ELEMENTS: Record<string, number[]> = {
  mercury: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593, 3.7e-7, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  venus: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255, 0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418],
  earth: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0, 0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0],
  mars: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891, 0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  jupiter: [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909, -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  saturn: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448, -0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
  uranus: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503, -0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
  neptune: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574, 0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
};

/** Heliocentric position, J2000 ecliptic, au. */
function heliocentric(name: string, d: number): THREE.Vector3 {
  const el = ELEMENTS[name];
  const T = d / 36525;
  const [a, e, I, L, wbar, node] = el.slice(0, 6).map((v, k) => v + el[k + 6] * T);
  const w = (wbar - node) * DEG;
  const M = THREE.MathUtils.euclideanModulo(L - wbar + 180, 360) * DEG - Math.PI;
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 6; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const x = a * (Math.cos(E) - e);
  const y = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const [cw, sw, cO, sO, cI, sI] = [Math.cos(w), Math.sin(w), Math.cos(node * DEG), Math.sin(node * DEG), Math.cos(I * DEG), Math.sin(I * DEG)];
  return new THREE.Vector3(
    (cw * cO - sw * sO * cI) * x + (-sw * cO - cw * sO * cI) * y,
    (cw * sO + sw * cO * cI) * x + (-sw * sO + cw * cO * cI) * y,
    sw * sI * x + cw * sI * y,
  );
}

const J2000_OBLIQUITY = 23.43928 * DEG;
/** Saturn's north pole, J2000 equatorial (IAU: RA 40.589, Dec 83.537). */
const SATURN_POLE = new THREE.Vector3(
  Math.cos(83.537 * DEG) * Math.cos(40.589 * DEG),
  Math.cos(83.537 * DEG) * Math.sin(40.589 * DEG),
  Math.sin(83.537 * DEG),
);

function eclipticJ2000ToEquatorial(v: THREE.Vector3): THREE.Vector3 {
  const c = Math.cos(J2000_OBLIQUITY);
  const s = Math.sin(J2000_OBLIQUITY);
  return new THREE.Vector3(v.x, v.y * c - v.z * s, v.y * s + v.z * c);
}

export interface Planet {
  name: string;
  /** Geocentric direction, J2000 equatorial unit vector. */
  direction: THREE.Vector3;
  /** Apparent V magnitude. */
  magnitude: number;
  /** B-V colour index. */
  bv: number;
}

/** B-V of each planet's reflected light (Wikipedia, "Color index"). */
const PLANET_BV: Record<string, number> = { mercury: 0.97, venus: 0.81, mars: 1.43, jupiter: 0.87, saturn: 1.09, uranus: 0.56, neptune: 0.41 };

/** Light days per au. */
const LIGHT_TIME = 1 / 173.1446;

/**
 * Where the planets are and how bright, as seen from the earth's centre: positions from JPL's approximate elements
 * (good to an arcminute or so for the inner planets, a few for the outer), corrected for light time; magnitudes
 * from Mallama & Hilton (2018), the Astronomical Almanac's formulas, with Mars's rotation and season terms and
 * Uranus's latitude term left out (a tenth of a magnitude or less).
 */
export function planets(date: Date): Planet[] {
  const d = daysSinceJ2000(date);
  const earth = heliocentric('earth', d);
  const out: Planet[] = [];
  for (const name of Object.keys(PLANET_BV)) {
    let helio = heliocentric(name, d);
    const delta = helio.distanceTo(earth);
    helio = heliocentric(name, d - delta * LIGHT_TIME);
    const geo = helio.clone().sub(earth);
    const D = geo.length();
    const r = helio.length();
    // Phase angle: sun-planet-earth.
    const alpha = Math.acos(THREE.MathUtils.clamp(helio.dot(geo) / (r * D), -1, 1)) / DEG;
    const a = alpha;
    let v1: number;
    switch (name) {
      case 'mercury':
        v1 = -0.613 + 6.328e-2 * a - 1.6336e-3 * a ** 2 + 3.3644e-5 * a ** 3 - 3.4265e-7 * a ** 4 + 1.6893e-9 * a ** 5 - 3.0334e-12 * a ** 6;
        break;
      case 'venus':
        v1 = a <= 163.7
          ? -4.384 - 1.044e-3 * a + 3.687e-4 * a ** 2 - 2.814e-6 * a ** 3 + 8.938e-9 * a ** 4
          : 236.05828 - 2.81914 * a + 8.39034e-3 * a ** 2;
        break;
      case 'mars':
        v1 = a <= 50 ? -1.601 + 0.02267 * a - 0.0001302 * a ** 2 : -0.367 - 0.02573 * a + 0.0003445 * a ** 2;
        break;
      case 'jupiter': {
        const x = a / 180;
        v1 = a <= 12
          ? -9.395 - 3.7e-4 * a + 6.16e-4 * a ** 2
          : -9.428 - 2.5 * Math.log10(1 - 1.507 * x - 0.363 * x ** 2 - 0.062 * x ** 3 + 2.809 * x ** 4 - 1.876 * x ** 5);
        break;
      }
      case 'saturn': {
        // The rings: their tilt seen from the earth and from the sun; edge-on to either, they add nothing.
        const pole = SATURN_POLE;
        const fromEarth = Math.asin(-eclipticJ2000ToEquatorial(geo).normalize().dot(pole));
        const fromSun = Math.asin(-eclipticJ2000ToEquatorial(helio).normalize().dot(pole));
        const beta = fromEarth * fromSun > 0 ? Math.sqrt(fromEarth * fromSun) : 0;
        v1 = -8.914 - 1.825 * Math.sin(beta) + 0.026 * a - 0.378 * Math.sin(beta) * Math.exp(-2.25 * a);
        break;
      }
      case 'uranus':
        v1 = -7.11 + 6.587e-3 * a + 1.045e-4 * a ** 2;
        break;
      default:
        v1 = -7.0 + 7.944e-3 * a + 9.617e-5 * a ** 2;
    }
    out.push({
      name,
      direction: eclipticJ2000ToEquatorial(geo).normalize(),
      magnitude: 5 * Math.log10(r * D) + v1,
      bv: PLANET_BV[name],
    });
  }
  return out;
}

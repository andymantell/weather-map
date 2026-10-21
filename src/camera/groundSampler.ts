import * as THREE from 'three';

/**
 * Height of the drawn ground (km, world Y) under any point, read straight from the terrain mesh so it matches the
 * triangles on screen exactly, including the vertical exaggeration in mesh.scale.y. The sea surface (Y = 0) counts
 * as ground, so the camera can skim the water.
 */
export class GroundSampler {
  private readonly positions: ArrayLike<number>;
  private readonly cols: number;
  private readonly rows: number;
  private readonly x0: number;
  private readonly z0: number;
  private readonly dx: number;
  private readonly dz: number;
  /**
   * Detailed terrain tiles (src/detail/) drawn over the coarse mesh: returns their ground height (km,
   * exaggerated) at a point, or null where there is no tile.
   */
  detail: ((x: number, z: number) => number | null) | null = null;

  constructor(private readonly terrain: THREE.Mesh) {
    const positions = terrain.geometry.getAttribute('position').array;
    // The terrain is a regular row-major grid: a row ends where X stops increasing.
    let cols = 1;
    while (cols * 3 < positions.length && positions[cols * 3] > positions[(cols - 1) * 3]) cols++;
    this.positions = positions;
    this.cols = cols;
    this.rows = positions.length / 3 / cols;
    this.x0 = positions[0];
    this.z0 = positions[2];
    this.dx = positions[3] - positions[0];
    this.dz = positions[cols * 3 + 2] - positions[2];
  }

  /** Terrain surface height, without the sea. */
  terrainAt(x: number, z: number): number {
    const detail = this.detail?.(x, z);
    if (detail != null) return detail;
    const u = THREE.MathUtils.clamp((x - this.x0) / this.dx, 0, this.cols - 1.0001);
    const v = THREE.MathUtils.clamp((z - this.z0) / this.dz, 0, this.rows - 1.0001);
    const c = Math.floor(u);
    const r = Math.floor(v);
    const fu = u - c;
    const fv = v - r;
    const y = (row: number, col: number) => this.positions[(row * this.cols + col) * 3 + 1];
    const a = y(r, c);
    const b = y(r, c + 1);
    const d = y(r + 1, c);
    const e = y(r + 1, c + 1);
    // Same split as the mesh: triangles (a, d, b) and (b, d, e).
    const h = fu + fv <= 1 ? a + fu * (b - a) + fv * (d - a) : e + (1 - fu) * (d - e) + (1 - fv) * (b - e);
    return h * this.terrain.scale.y;
  }

  /** Ground or sea surface, whichever is higher. */
  heightAt(x: number, z: number): number {
    return Math.max(this.terrainAt(x, z), 0);
  }

  /** First point where a ray meets the ground, or null if it misses within maxDistance (km). */
  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance = 6000): THREE.Vector3 | null {
    const p = new THREE.Vector3();
    const above = (t: number) => {
      p.copy(origin).addScaledVector(direction, t);
      return p.y - this.heightAt(p.x, p.z);
    };
    let t0 = 0;
    let h0 = above(0);
    if (h0 < 0) return null;
    while (t0 < maxDistance) {
      // Steps shrink near the ground so ridges are not stepped over, and grow with distance.
      const step = THREE.MathUtils.clamp(h0 * 0.5, 0.05, Math.max(0.5, t0 * 0.01));
      const t1 = t0 + step;
      const h1 = above(t1);
      if (h1 <= 0) {
        let lo = t0;
        let hi = t1;
        for (let i = 0; i < 24; i++) {
          const mid = (lo + hi) / 2;
          if (above(mid) > 0) lo = mid;
          else hi = mid;
        }
        above(hi);
        return p.clone();
      }
      t0 = t1;
      h0 = h1;
    }
    return null;
  }
}

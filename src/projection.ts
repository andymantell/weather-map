import proj4 from 'proj4';

/**
 * World coordinates are the UKV grid's Lambert Azimuthal Equal Area projection
 * in kilometres, so Met Office grids line up with the terrain without resampling.
 * World X points east, Z points south (-northing), Y is up.
 */
export class Projection {
  private readonly converter: proj4.Converter;

  constructor(proj: string) {
    this.converter = proj4('EPSG:4326', proj);
  }

  toWorld(lon: number, lat: number): { x: number; z: number } {
    const [x, y] = this.converter.forward([lon, lat]);
    return { x: x / 1000, z: -y / 1000 };
  }

  toLonLat(x: number, z: number): { lon: number; lat: number } {
    const [lon, lat] = this.converter.inverse([x * 1000, -z * 1000]);
    return { lon, lat };
  }
}

#!/usr/bin/env python3
"""Bake one UKV hour of cloud and rain into textures for the 3D map's volumetric clouds.

Reads, for one run and forecast step:
    cloud_amount_on_height_levels                         3D cloud fraction, 33 levels 5 m to 6 km AGL
    precipitation_rate                                    m/s at the surface
    height_AGL_at_cloud_base_where_cloud_cover_2p5_oktas  m AGL
    cloud_amount_of_high_cloud                            fraction, about 5.6 to 13.6 km
    CAPE_surface                                          J/kg, used to tell convective from layered cloud

Writes to --out-dir:
    ukv-clouds-volume.png  8-bit greyscale atlas of cloud fraction (0..255 = 0..1), one tile per uniform height
                           slice; tiles run left to right, then top to bottom, lowest slice first
    ukv-clouds-2d.png      RGBA: R = sqrt(precip / 64 mm/h), G = cloud base / 8 km (255 = no base),
                           B = high cloud fraction, A = sqrt(CAPE / 2000 J/kg)
    ukv-clouds.json        grid, slice heights, encodings, times and attribution

Both images are cropped to the extent given by --bbox (LAEA metres, cell centres), which defaults to the terrain
heightmap's extent. Row 0 is north. Heights are above ground level, as UKV gives them.

Example:
    python ukv_clouds.py --run 20261021T0900Z --step 3 --out-dir ../public/data
"""

import argparse
import json
import math
import sys
import tempfile
from pathlib import Path

import netCDF4
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from ukv_to_grid import MODEL_PREFIX, download, read_field  # noqa: E402

VOLUME_PARAM = "cloud_amount_on_height_levels"
FIELDS = {
    "precip": "precipitation_rate",
    "base": "height_AGL_at_cloud_base_where_cloud_cover_2p5_oktas",
    "high": "cloud_amount_of_high_cloud",
    "cape": "CAPE_surface",
}
RAIN_MAX_MM_H = 64.0
BASE_MAX_KM = 8.0
CAPE_MAX = 2000.0
ATTRIBUTION = "Contains Met Office data © Crown copyright, licensed under CC BY-SA 4.0"


def file_key(run, step, param):
    from datetime import datetime, timedelta

    valid = datetime.strptime(run, "%Y%m%dT%H%MZ") + timedelta(hours=step)
    return f"{MODEL_PREFIX}{run}/{valid:%Y%m%dT%H%MZ}-PT{step:04d}H00M-{param}.nc"


def read_volume(path):
    """Return (fraction[z, y, x] north-up, heights_m, x, y)."""
    ds = netCDF4.Dataset(path)
    var = ds.variables["cloud_volume_fraction_in_atmosphere_layer"]
    data = np.ma.filled(var[:].astype("float32"), 0.0)
    heights = ds.variables["height"][:].astype("float64")
    x = ds.variables["projection_x_coordinate"][:].astype("float64")
    y = ds.variables["projection_y_coordinate"][:].astype("float64")
    ds.close()
    if y[0] < y[-1]:
        data, y = data[:, ::-1], y[::-1]
    return data, heights, x, y


def crop_index(coords, lo, hi):
    idx = np.where((coords >= lo - 1) & (coords <= hi + 1))[0]
    return slice(idx.min(), idx.max() + 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run", required=True, help="model run, e.g. 20261021T0900Z")
    parser.add_argument("--step", type=int, required=True, help="forecast step in hours")
    parser.add_argument("--out-dir", default=".")
    parser.add_argument("--bbox", type=float, nargs=4, metavar=("XMIN", "XMAX", "YMIN", "YMAX"),
                        default=(-640000, 440000, -640000, 720000), help="crop, LAEA metres")
    parser.add_argument("--slices", type=int, default=30, help="uniform height slices from 0 to --top")
    parser.add_argument("--top", type=float, default=6000.0, help="top of the volume in metres AGL")
    parser.add_argument("--cache", help="directory to keep downloaded NetCDF files in")
    args = parser.parse_args()

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    cache = Path(args.cache) if args.cache else Path(tempfile.mkdtemp())
    cache.mkdir(parents=True, exist_ok=True)

    def fetch(param):
        key = file_key(args.run, args.step, param)
        local = cache / key.rsplit("/", 1)[-1]
        return local if local.exists() else download(key, cache)

    volume, heights, x, y = read_volume(fetch(VOLUME_PARAM))
    xmin, xmax, ymin, ymax = args.bbox
    xs, ys = crop_index(x, xmin, xmax), crop_index(y, ymin, ymax)
    volume = volume[:, ys, xs]
    x, y = x[xs], y[ys]
    nz, ny, nx = args.slices, len(y), len(x)

    # Resample the stretched native levels onto uniform slices, sampled at slice centres.
    dz = args.top / nz
    centres = (np.arange(nz) + 0.5) * dz
    slices = np.empty((nz, ny, nx), dtype=np.float32)
    for k, h in enumerate(centres):
        i = int(np.clip(np.searchsorted(heights, h) - 1, 0, len(heights) - 2))
        t = float(np.clip((h - heights[i]) / (heights[i + 1] - heights[i]), 0, 1))
        slices[k] = volume[i] * (1 - t) + volume[i + 1] * t

    cols = math.ceil(math.sqrt(nz * ny / nx))
    rows = math.ceil(nz / cols)
    atlas = np.zeros((rows * ny, cols * nx), dtype=np.uint8)
    for k in range(nz):
        r, c = divmod(k, cols)
        atlas[r * ny:(r + 1) * ny, c * nx:(c + 1) * nx] = np.round(np.clip(slices[k], 0, 1) * 255)
    Image.fromarray(atlas, "L").save(out / "ukv-clouds-volume.png", optimize=True)

    fields = {}
    meta = None
    for name, param in FIELDS.items():
        data, fx, fy, _, m = read_field(fetch(param))
        if not (np.array_equal(fx[xs], x) and np.array_equal(fy[ys], y)):
            sys.exit(f"{param} is not on the same grid as the cloud volume")
        fields[name] = data[ys, xs]
        meta = meta or m

    precip = np.nan_to_num(fields["precip"]) * 3.6e6
    base_km = fields["base"] / 1000.0
    rgba = np.stack([
        np.round(np.sqrt(np.clip(precip / RAIN_MAX_MM_H, 0, 1)) * 255),
        np.where(np.isnan(base_km), 255, np.round(np.clip(base_km / BASE_MAX_KM, 0, 254 / 255) * 255)),
        np.round(np.clip(np.nan_to_num(fields["high"]), 0, 1) * 255),
        np.round(np.sqrt(np.clip(np.nan_to_num(fields["cape"]) / CAPE_MAX, 0, 1)) * 255),
    ], axis=-1).astype(np.uint8)
    Image.fromarray(rgba, "RGBA").save(out / "ukv-clouds-2d.png", optimize=True)

    sidecar = {
        "forecast_reference_time": meta["forecast_reference_time"],
        "valid_time": meta["valid_time"],
        "run": args.run,
        "step_hours": args.step,
        "grid": {
            "width": nx,
            "height": ny,
            "x_west": float(x[0]),
            "y_north": float(y[0]),
            "dx": float(x[1] - x[0]),
            "dy": float(y[1] - y[0]),
            "note": "cell centres in LAEA metres; row 0 at y_north",
        },
        "volume": {
            "slices": nz,
            "slice_height_m": dz,
            "atlas_columns": cols,
            "atlas_rows": rows,
            "encoding": "cloud fraction = value / 255; heights above ground level",
        },
        "fields_2d": {
            "r": f"precipitation rate mm/h = {RAIN_MAX_MM_H} * (value / 255)^2",
            "g": f"cloud base km AGL = {BASE_MAX_KM} * value / 255; 255 = no cloud base (under 2.5 oktas)",
            "b": "high cloud fraction = value / 255",
            "a": f"surface CAPE J/kg = {CAPE_MAX} * (value / 255)^2",
        },
        "max_precip_mm_h": float(precip.max()),
        "sources": [file_key(args.run, args.step, p).rsplit("/", 1)[-1] for p in [VOLUME_PARAM, *FIELDS.values()]],
        "attribution": ATTRIBUTION,
    }
    (out / "ukv-clouds.json").write_text(json.dumps(sidecar, indent=2))
    print(f"Wrote {nx}x{ny}x{nz} volume, valid {meta['valid_time']}, max precip {precip.max():.1f} mm/h")


if __name__ == "__main__":
    main()

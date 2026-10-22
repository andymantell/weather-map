#!/usr/bin/env python3
"""Bake one UKV hour of near-surface air for the 3D map's atmosphere: how far you can see and how damp it is.

Reads, for one run and forecast step:
    visibility_at_screen_level         m, at 1.5 m
    fog_fraction_at_screen_level       0..1, chance of visibility under 1 km in the grid box
    relative_humidity_at_screen_level  %, at 1.5 m

Writes to --out-dir:
    ukv-surface.png   RGB: R = visibility on a log scale (0 = 10 m, 255 = 100 km), G = fog fraction,
                      B = relative humidity (0..255 = 0..100 %)
    ukv-surface.json  grid, encodings, times and attribution

Cropped like ukv_clouds.py, so both share a grid. Row 0 is north.

Example:
    python ukv_surface.py --run 20261021T0900Z --step 3 --out-dir ../public/data
"""

import argparse
import json
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from ukv_clouds import ATTRIBUTION, crop_index, file_key  # noqa: E402
from ukv_to_grid import download, read_field  # noqa: E402

FIELDS = {
    "visibility": "visibility_at_screen_level",
    "fog": "fog_fraction_at_screen_level",
    "humidity": "relative_humidity_at_screen_level",
}
VIS_MIN_M = 10.0
VIS_MAX_M = 100000.0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run", required=True, help="model run, e.g. 20261021T0900Z")
    parser.add_argument("--step", type=int, required=True, help="forecast step in hours")
    parser.add_argument("--out-dir", default=".")
    parser.add_argument("--bbox", type=float, nargs=4, metavar=("XMIN", "XMAX", "YMIN", "YMAX"),
                        default=(-640000, 440000, -640000, 720000), help="crop, LAEA metres")
    parser.add_argument("--cache", help="directory to keep downloaded NetCDF files in")
    args = parser.parse_args()

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    cache = Path(args.cache) if args.cache else Path(tempfile.mkdtemp())
    cache.mkdir(parents=True, exist_ok=True)

    fields, meta, grid = {}, None, None
    for name, param in FIELDS.items():
        key = file_key(args.run, args.step, param)
        local = cache / key.rsplit("/", 1)[-1]
        data, x, y, _, m = read_field(local if local.exists() else download(key, cache))
        xmin, xmax, ymin, ymax = args.bbox
        xs, ys = crop_index(x, xmin, xmax), crop_index(y, ymin, ymax)
        fields[name] = data[ys, xs]
        grid = grid or (x[xs], y[ys])
        meta = meta or m

    x, y = grid
    vis = np.clip(np.nan_to_num(fields["visibility"], nan=VIS_MAX_M), VIS_MIN_M, VIS_MAX_M)
    rgb = np.stack([
        np.round(np.log10(vis / VIS_MIN_M) / np.log10(VIS_MAX_M / VIS_MIN_M) * 255),
        np.round(np.clip(np.nan_to_num(fields["fog"]), 0, 1) * 255),
        np.round(np.clip(np.nan_to_num(fields["humidity"], nan=80) / 100, 0, 1) * 255),
    ], axis=-1).astype(np.uint8)
    Image.fromarray(rgb, "RGB").save(out / "ukv-surface.png", optimize=True)

    sidecar = {
        "forecast_reference_time": meta["forecast_reference_time"],
        "valid_time": meta["valid_time"],
        "run": args.run,
        "step_hours": args.step,
        "grid": {
            "width": len(x),
            "height": len(y),
            "x_west": float(x[0]),
            "y_north": float(y[0]),
            "dx": float(x[1] - x[0]),
            "dy": float(y[1] - y[0]),
            "note": "cell centres in LAEA metres; row 0 at y_north",
        },
        "encoding": {
            "r": f"visibility m = {VIS_MIN_M:g} * {VIS_MAX_M / VIS_MIN_M:g}^(value / 255)",
            "g": "fog fraction = value / 255",
            "b": "relative humidity % = 100 * value / 255",
        },
        "sources": [file_key(args.run, args.step, p).rsplit("/", 1)[-1] for p in FIELDS.values()],
        "attribution": ATTRIBUTION,
    }
    (out / "ukv-surface.json").write_text(json.dumps(sidecar, indent=2))
    print(f"Wrote {len(x)}x{len(y)} surface fields, valid {meta['valid_time']}, "
          f"visibility {vis.min():.0f} to {vis.max():.0f} m, median {np.median(vis):.0f} m")


if __name__ == "__main__":
    main()

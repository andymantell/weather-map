#!/usr/bin/env python3
"""Convert one Met Office UKV field into browser-friendly grid files.

Source: the free, keyless AWS Open Data bucket
    s3://met-office-atmospheric-model-data/uk-deterministic-2km/
which holds UKV 2 km forecasts as NetCDF on the Lambert Azimuthal Equal Area
"standard" grid (1042 x 970 cells, 2 km spacing).

Outputs, written to --out-dir as <name>.*:
    <name>.json   metadata: projection, extent, corner lat/lons, encoding, times
    <name>.png    lossless RGBA PNG; the quantised 16-bit value is packed as
                  R = high byte, G = low byte, B = 0, A = 255
    <name>.bin    the same Uint16 values as raw little-endian bytes (optional)
    <name>.preview.png  8-bit greyscale picture for eyeballing (optional)

Decoding in the browser:
    value = offset + scale * (R * 256 + G), and the code 0 means "no data".
Row 0 is the northernmost row, column 0 the westernmost, as in an image.

Examples:
    # newest run, T+6h, 2 m temperature
    python ukv_to_grid.py --param temperature_at_screen_level --step 6

    # a file you already have
    python ukv_to_grid.py --file 20261021T0900Z-PT0006H00M-cloud_amount_of_total_cloud.nc

    # also resample to a regular lat/lon grid (EPSG:4326)
    python ukv_to_grid.py --param cloud_amount_of_total_cloud --step 3 --latlon 0.02
"""

import argparse
import datetime as dt
import json
import re
import sys
import tempfile
import warnings
import urllib.parse
import urllib.request
from pathlib import Path

import netCDF4
import numpy as np
from PIL import Image
from pyproj import CRS, Transformer

BUCKET_URL = "https://met-office-atmospheric-model-data.s3.eu-west-2.amazonaws.com"
MODEL_PREFIX = "uk-deterministic-2km/"
NODATA = 0
MAX_CODE = 65535


def list_bucket(prefix, delimiter=None, start_after=None):
    """Yield (keys, common_prefixes) pages from an anonymous S3 ListObjectsV2."""
    token = None
    while True:
        query = {"list-type": "2", "prefix": prefix}
        if delimiter:
            query["delimiter"] = delimiter
        if start_after:
            query["start-after"] = start_after
        if token:
            query["continuation-token"] = token
        url = f"{BUCKET_URL}/?{urllib.parse.urlencode(query)}"
        with urllib.request.urlopen(url, timeout=60) as resp:
            xml = resp.read().decode()
        keys = re.findall(r"<Key>([^<]+)</Key>", xml)
        prefixes = re.findall(r"<CommonPrefixes><Prefix>([^<]+)</Prefix>", xml)
        yield keys, prefixes
        match = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", xml)
        if not match:
            return
        token = match.group(1)


def run_keys(run):
    return [k for keys, _ in list_bucket(f"{MODEL_PREFIX}{run}/") for k in keys]


def find_run(param, step_hours):
    """Newest run (within the last two days) that already has this param and step."""
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=2)).strftime("%Y%m%d")
    runs = []
    for _, prefixes in list_bucket(MODEL_PREFIX, delimiter="/",
                                   start_after=f"{MODEL_PREFIX}{since}"):
        runs += [p[len(MODEL_PREFIX):].rstrip("/") for p in prefixes]
    step = f"PT{step_hours:04d}H00M"
    for run in sorted(runs, reverse=True):
        for key in run_keys(run):
            if key.endswith(f"-{step}-{param}.nc"):
                return key
    sys.exit(f"No run in the last two days has {param} at {step}")


def download(key, dest_dir):
    dest = Path(dest_dir) / key.rsplit("/", 1)[-1]
    print(f"Downloading {BUCKET_URL}/{key}", file=sys.stderr)
    urllib.request.urlretrieve(f"{BUCKET_URL}/{urllib.parse.quote(key)}", dest)
    return dest


def read_field(path):
    """Return (data[y, x] north-up float array with NaN gaps, x, y, crs, meta)."""
    ds = netCDF4.Dataset(path)
    ds.set_auto_mask(True)
    yx = ("projection_y_coordinate", "projection_x_coordinate")
    names = [n for n, v in ds.variables.items() if v.dimensions == yx]
    if len(names) != 1:
        sys.exit(f"Expected one 2D field in {path}, found {names}. "
                 "Multi-level files (on_height_levels, on_pressure_levels) are not handled yet.")
    var = ds.variables[names[0]]
    data = np.ma.filled(var[:].astype("float32"), np.nan)
    x = ds.variables["projection_x_coordinate"][:].astype("float64")
    y = ds.variables["projection_y_coordinate"][:].astype("float64")
    crs = CRS.from_cf({a: ds.variables[var.grid_mapping].getncattr(a)
                       for a in ds.variables[var.grid_mapping].ncattrs()})

    def time_attr(name):
        if name not in ds.variables:
            return None
        v = ds.variables[name]
        return netCDF4.num2date(v[:], v.units, only_use_cftime_datetimes=False).isoformat() + "Z"

    meta = {
        "variable": names[0],
        "standard_name": getattr(var, "standard_name", None),
        "units": getattr(var, "units", None),
        "source_file": Path(path).name,
        "title": getattr(ds, "title", None),
        "forecast_reference_time": time_attr("forecast_reference_time"),
        "valid_time": time_attr("time"),
        "forecast_period_seconds": int(ds.variables["forecast_period"][:])
        if "forecast_period" in ds.variables else None,
    }
    ds.close()

    # The file stores rows south to north; images want north at the top.
    if y[0] < y[-1]:
        data, y = data[::-1], y[::-1]
    return data, x, y, crs, meta


def to_latlon(data, x, y, crs, res_deg):
    """Bilinear resample from the LAEA grid onto a regular lat/lon grid."""
    to_geo = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    edge_x = np.concatenate([np.linspace(x[0], x[-1], 200)] * 2 + [np.full(200, x[0]), np.full(200, x[-1])])
    edge_y = np.concatenate([np.full(200, y[0]), np.full(200, y[-1])] + [np.linspace(y[0], y[-1], 200)] * 2)
    lon_e, lat_e = to_geo.transform(edge_x, edge_y)
    lons = np.arange(np.floor(lon_e.min() / res_deg) * res_deg, lon_e.max() + res_deg / 2, res_deg)
    lats = np.arange(np.ceil(lat_e.max() / res_deg) * res_deg, lat_e.min() - res_deg / 2, -res_deg)
    glon, glat = np.meshgrid(lons, lats)
    to_laea = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    px, py = to_laea.transform(glon, glat)

    # Fractional indices into the source grid (x ascending, y descending).
    fi = (px - x[0]) / (x[1] - x[0])
    fj = (py - y[0]) / (y[1] - y[0])
    inside = (fi >= 0) & (fi <= len(x) - 1) & (fj >= 0) & (fj <= len(y) - 1)
    i0 = np.clip(np.floor(fi).astype(int), 0, len(x) - 2)
    j0 = np.clip(np.floor(fj).astype(int), 0, len(y) - 2)
    di, dj = fi - i0, fj - j0
    out = ((1 - di) * (1 - dj) * data[j0, i0] + di * (1 - dj) * data[j0, i0 + 1]
           + (1 - di) * dj * data[j0 + 1, i0] + di * dj * data[j0 + 1, i0 + 1])
    out[~inside] = np.nan
    return out.astype("float32"), lons, lats


def quantise(data, vmin, vmax):
    """Map floats to 1..65535 (0 = no data). Returns codes, offset, scale."""
    scale = (vmax - vmin) / (MAX_CODE - 1) if vmax > vmin else 1.0
    offset = vmin - scale  # so that code 1 == vmin
    codes = np.zeros(data.shape, dtype="<u2")
    ok = np.isfinite(data)
    codes[ok] = np.clip(np.rint((data[ok] - offset) / scale), 1, MAX_CODE)
    return codes, float(offset), float(scale)


def proj4_string(crs):
    # PROJ warns that PROJ strings are lossy; for this simple LAEA grid it is exact
    # enough, and it is the form proj4js takes in the browser.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        return crs.to_proj4()


def corners(crs, x, y):
    to_geo = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    pts = {"north_west": (x[0], y[0]), "north_east": (x[-1], y[0]),
           "south_west": (x[0], y[-1]), "south_east": (x[-1], y[-1])}
    return {k: [round(v, 5) for v in to_geo.transform(*p)] for k, p in pts.items()}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--file", help="local UKV NetCDF file")
    src.add_argument("--param", help="parameter name, e.g. temperature_at_screen_level")
    ap.add_argument("--step", type=int, default=0, help="forecast hour for --param (default 0)")
    ap.add_argument("--run", help="run folder for --param, e.g. 20261021T0300Z (default: newest)")
    ap.add_argument("--out-dir", default="out", help="output folder (default: out)")
    ap.add_argument("--name", help="output base name (default: the parameter name)")
    ap.add_argument("--stride", type=int, default=1, help="keep every Nth cell, e.g. 2 for 4 km")
    ap.add_argument("--latlon", type=float, metavar="DEG",
                    help="resample to a regular lat/lon grid with this spacing in degrees")
    ap.add_argument("--range", type=float, nargs=2, metavar=("MIN", "MAX"),
                    help="fixed value range for encoding (default: the field's own min/max)")
    ap.add_argument("--bin", action="store_true", help="also write raw Uint16 .bin")
    ap.add_argument("--preview", action="store_true", help="also write an 8-bit preview PNG")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        if args.file:
            path = Path(args.file)
        else:
            if args.run:
                step = f"PT{args.step:04d}H00M"
                key = next((k for k in run_keys(args.run) if k.endswith(f"-{step}-{args.param}.nc")), None)
                if not key:
                    sys.exit(f"{args.run} has no {args.param} at {step}")
            else:
                key = find_run(args.param, args.step)
            path = download(key, tmp)
        data, x, y, crs, meta = read_field(path)

    if args.stride > 1:
        data, x, y = data[::args.stride, ::args.stride], x[::args.stride], y[::args.stride]

    if args.latlon:
        data, lons, lats = to_latlon(data, x, y, crs, args.latlon)
        grid = {
            "crs": "EPSG:4326",
            "width": len(lons), "height": len(lats),
            "lon_west": round(float(lons[0]), 6), "lat_north": round(float(lats[0]), 6),
            "lon_step": args.latlon, "lat_step": -args.latlon,
            "note": "cell centres; row 0 at lat_north, column 0 at lon_west",
        }
    else:
        grid = {
            "crs": "Lambert Azimuthal Equal Area",
            "proj4": proj4_string(crs),
            "width": len(x), "height": len(y),
            "x_west": float(x[0]), "y_north": float(y[0]),
            "dx": float(x[1] - x[0]), "dy": float(y[1] - y[0]),
            "units": "m",
            "note": "cell centres in projected metres; row 0 at y_north, column 0 at x_west",
            "corners_lon_lat": corners(crs, x, y),
        }

    finite = data[np.isfinite(data)]
    vmin, vmax = args.range if args.range else (float(finite.min()), float(finite.max()))
    codes, offset, scale = quantise(data, vmin, vmax)

    name = args.name or args.param or meta["variable"]
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    rgba = np.zeros(codes.shape + (4,), dtype="uint8")
    rgba[..., 0] = codes >> 8
    rgba[..., 1] = codes & 0xFF
    rgba[..., 3] = 255
    Image.fromarray(rgba, "RGBA").save(out / f"{name}.png", optimize=True)
    files = [f"{name}.png"]
    if args.bin:
        codes.tofile(out / f"{name}.bin")
        files.append(f"{name}.bin")
    if args.preview:
        grey = np.where(codes > 0, ((codes.astype("float32") - 1) / (MAX_CODE - 1) * 254 + 1), 0)
        Image.fromarray(grey.astype("uint8"), "L").save(out / f"{name}.preview.png")
        files.append(f"{name}.preview.png")

    doc = {
        **meta,
        "grid": grid,
        "encoding": {
            "type": "uint16",
            "formula": "value = offset + scale * code",
            "png_packing": "code = R * 256 + G",
            "bin_byte_order": "little-endian",
            "nodata_code": NODATA,
            "offset": offset, "scale": scale,
            "min": vmin, "max": vmax,
        },
        "files": files,
        "attribution": "Contains Met Office data, Crown copyright, licensed under CC BY-SA 4.0",
    }
    (out / f"{name}.json").write_text(json.dumps(doc, indent=2))
    print(json.dumps({"written": [str(out / f) for f in files + [f"{name}.json"]],
                      "shape": list(codes.shape), "min": vmin, "max": vmax}, indent=2))


if __name__ == "__main__":
    main()

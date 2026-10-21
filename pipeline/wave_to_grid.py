#!/usr/bin/env python3
"""Convert Met Office UK wave model fields into textures for the sea shader.

Source: the free, keyless AWS Open Data bucket
    s3://met-office-nws-wave-model-data/nws-wave/
which holds the Met Office UK 1.5 km wave model (WAVEWATCH III, "uk_wave"
standard grid) as NetCDF on a regular lat/lon grid. Each file holds one
parameter for 24 hourly steps. Docs: docs/sea-state-research.md.

The fields are resampled onto the terrain heightmap's LAEA extent (same
projection as UKV) at --spacing metres, cell centres, row 0 north. Land and
other gaps are filled outwards from the nearest sea so the shader can sample
anywhere without seams at the coast.

Outputs, written to --out-dir:
    nws-waves.json          metadata, encodings, valid time, attribution
    nws-waves-windsea.png   R = wind-sea Hs, G/B = propagation direction
    nws-waves-swell.png     R = primary swell Hs, G/B = propagation direction
    nws-waves-period.png    R = wind-sea Tp, G = swell Tp, B = 10 m wind speed

Directions are unit vectors in the scene's map frame (x east, y grid north),
the way the waves travel (the files store "from" directions), stored as
byte = (v + 1) * 127.5. Scalars are byte = value / step; see the JSON.

Example:
    python wave_to_grid.py --run 20261021T0600Z --valid 20261021T1200Z \\
        --out-dir ../public/data/waves
"""

import argparse
import datetime as dt
import json
import re
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

import netCDF4
import numpy as np
from PIL import Image
from pyproj import Transformer

BUCKET_URL = "https://met-office-nws-wave-model-data.s3.eu-west-2.amazonaws.com"
PREFIX = "nws-wave/"
FILE_STEM = "wave_uk_standard_v1-level_1-"
HEIGHTMAP_JSON = Path(__file__).resolve().parent.parent / "public/data/uk-heightmap.json"

# Parameter file -> variable name inside it.
FIELDS = {
    "wind_wave_significant_height": "VHM0_WW",
    "wind_wave_mean_direction": "VMDR_WW",
    "wind_wave_peak_period": "VTPK_WW",
    "primary_swell_wave_significant_height": "VHM0_SW1",
    "primary_swell_wave_mean_direction": "VMDR_SW1",
    "primary_swell_wave_peak_period": "VTPK_SW1",
    "wave_grid_10m_wind": "WSPD",
}

# Byte encodings: value = byte * step. Ranges cover a severe North Atlantic storm.
HS_STEP = 0.05     # m, up to 12.75 m
TP_STEP = 0.1      # s, up to 25.5 s
WIND_STEP = 0.2    # m/s, up to 51 m/s


def list_keys(prefix):
    keys, token = [], None
    while True:
        query = {"list-type": "2", "prefix": prefix}
        if token:
            query["continuation-token"] = token
        with urllib.request.urlopen(f"{BUCKET_URL}/?{urllib.parse.urlencode(query)}", timeout=60) as resp:
            xml = resp.read().decode()
        keys += re.findall(r"<Key>([^<]+)</Key>", xml)
        match = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", xml)
        if not match:
            return keys
        token = match.group(1)


def parse_time(text):
    return dt.datetime.strptime(text, "%Y%m%dT%H%MZ").replace(tzinfo=dt.timezone.utc)


def newest_run():
    """Newest run (today or yesterday) whose files include every field we need."""
    now = dt.datetime.now(dt.timezone.utc)
    for day in (now, now - dt.timedelta(days=1)):
        prefix = f"{PREFIX}{day:%Y/%m/%d}/"
        runs = sorted(set(re.findall(r"/(T\d{4}Z)/", " ".join(list_keys(prefix)))), reverse=True)
        for run in runs:
            keys = list_keys(f"{prefix}{run}/")
            if all(any(k.endswith(f"-{name}.nc") for k in keys) for name in FIELDS):
                return parse_time(f"{day:%Y%m%d}{run}")
    sys.exit("No complete wave run found for today or yesterday")


def file_key(run, valid, name):
    """Each file holds 24 hourly steps starting at its 'hi' time, which is a whole day after the run."""
    days = int((valid - run).total_seconds() // 86400)
    if days < 0:
        sys.exit("--valid is before the run time")
    start = run + dt.timedelta(days=days)
    key = (f"{PREFIX}{run:%Y/%m/%d}/T{run:%H%M}Z/"
           f"b{run:%Y%m%dT%H%M}Z_hi{start:%Y%m%dT%H%M}Z-{FILE_STEM}{name}.nc")
    return key, int((valid - start).total_seconds() // 3600)


def read_step(path, var_name, step):
    ds = netCDF4.Dataset(path)
    var = ds.variables[var_name]
    times = netCDF4.num2date(ds.variables["time"][:], ds.variables["time"].units,
                             only_use_cftime_datetimes=False)
    data = np.ma.filled(var[step].astype("float32"), np.nan)
    lon = ds.variables["longitude"][:].astype("float64")
    lat = ds.variables["latitude"][:].astype("float64")
    valid = times[step].replace(tzinfo=dt.timezone.utc)
    meta = {
        "title": getattr(ds, "title", None),
        "source": getattr(ds, "source", None),
        "units": getattr(var, "units", None),
    }
    ds.close()
    return data, lon, lat, valid, meta


def bilinear(data, lon, lat, qlon, qlat):
    """Sample a regular lat/lon grid (ascending axes) at query points; NaN outside or near gaps."""
    fi = (qlon - lon[0]) / (lon[1] - lon[0])
    fj = (qlat - lat[0]) / (lat[1] - lat[0])
    inside = (fi >= 0) & (fi <= len(lon) - 1) & (fj >= 0) & (fj <= len(lat) - 1)
    i0 = np.clip(np.floor(fi).astype(int), 0, len(lon) - 2)
    j0 = np.clip(np.floor(fj).astype(int), 0, len(lat) - 2)
    di, dj = fi - i0, fj - j0
    out = ((1 - di) * (1 - dj) * data[j0, i0] + di * (1 - dj) * data[j0, i0 + 1]
           + (1 - di) * dj * data[j0 + 1, i0] + di * dj * data[j0 + 1, i0 + 1])
    out[~inside] = np.nan
    return out


def fill_gaps(fields):
    """Grow valid values into NaN cells, one ring per pass, averaging valid neighbours.

    All fields share one mask (the sea), so they are filled together.
    """
    fields = [f.copy() for f in fields]
    missing = ~np.isfinite(fields[0])
    while missing.any():
        valid = ~missing
        count = np.zeros(missing.shape, "float32")
        sums = [np.zeros(missing.shape, "float32") for _ in fields]
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)):
            shifted = np.roll(np.roll(valid, dy, 0), dx, 1)
            count += shifted
            for s, f in zip(sums, fields):
                s += np.where(shifted, np.roll(np.roll(np.nan_to_num(f), dy, 0), dx, 1), 0)
        grow = missing & (count > 0)
        if not grow.any():
            break
        for s, f in zip(sums, fields):
            f[grow] = s[grow] / count[grow]
        missing &= ~grow
    return fields


def to_bytes(values, step):
    return np.clip(np.rint(values / step), 0, 255).astype("uint8")


def dir_bytes(v):
    return np.clip(np.rint((v + 1) * 127.5), 0, 255).astype("uint8")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", help="run time, e.g. 20261021T0600Z (default: newest complete run)")
    ap.add_argument("--valid", help="valid time, e.g. 20261021T1200Z (default: run + 6 h)")
    ap.add_argument("--spacing", type=float, default=2000, help="output cell size in metres (default 2000)")
    ap.add_argument("--out-dir", default="out", help="output folder (default: out)")
    args = ap.parse_args()

    run = parse_time(args.run) if args.run else newest_run()
    valid = parse_time(args.valid) if args.valid else run + dt.timedelta(hours=6)

    # Target grid: cell centres covering the terrain heightmap's extent.
    hm = json.loads(HEIGHTMAP_JSON.read_text())
    width = int(round((hm["xMax"] - hm["xMin"]) / args.spacing))
    height = int(round((hm["yMax"] - hm["yMin"]) / args.spacing))
    x = hm["xMin"] + (np.arange(width) + 0.5) * args.spacing
    y = hm["yMax"] - (np.arange(height) + 0.5) * args.spacing
    gx, gy = np.meshgrid(x, y)
    to_geo = Transformer.from_crs(hm["proj"], "EPSG:4326", always_xy=True)
    to_map = Transformer.from_crs("EPSG:4326", hm["proj"], always_xy=True)
    qlon, qlat = to_geo.transform(gx, gy)

    # Local map-frame unit vectors of true east and true north, so compass
    # directions turn into map directions (LAEA grid north drifts from true north
    # away from the central meridian).
    d = 0.01
    ex, ey = to_map.transform(qlon + d, qlat)
    nx, ny = to_map.transform(qlon, qlat + d)
    ex, ey = ex - gx, ey - gy
    nx, ny = nx - gx, ny - gy
    ex, ey = ex / np.hypot(ex, ey), ey / np.hypot(ex, ey)
    nx, ny = nx / np.hypot(nx, ny), ny / np.hypot(nx, ny)

    sampled, info = {}, None
    with tempfile.TemporaryDirectory() as tmp:
        for name, var_name in FIELDS.items():
            key, step = file_key(run, valid, name)
            path = Path(tmp) / f"{name}.nc"
            print(f"Downloading {BUCKET_URL}/{key} (step {step})", file=sys.stderr)
            urllib.request.urlretrieve(f"{BUCKET_URL}/{key}", path)
            data, lon, lat, file_valid, meta = read_step(path, var_name, step)
            if file_valid != valid:
                sys.exit(f"{key} step {step} is valid at {file_valid}, expected {valid}")
            info = info or meta
            if var_name.startswith("VMDR"):
                # Compass "from" direction -> propagation vector in east/north components,
                # resampled as vectors so interpolation never wraps through 0/360.
                rad = np.deg2rad(data)
                sampled[var_name + "_e"] = bilinear(-np.sin(rad), lon, lat, qlon, qlat)
                sampled[var_name + "_n"] = bilinear(-np.cos(rad), lon, lat, qlon, qlat)
            else:
                sampled[var_name] = bilinear(data, lon, lat, qlon, qlat)
            path.unlink()

    names = list(sampled)
    # Directions are undefined where a wave system is absent; give them zero
    # vectors so they don't count as sea in the shared mask below.
    sea = np.isfinite(sampled["VHM0_WW"])
    for n in names:
        sampled[n] = np.where(sea, np.nan_to_num(sampled[n]), np.nan)
    filled = dict(zip(names, fill_gaps([sampled[n] for n in names])))

    def map_dir(prefix):
        e, n = filled[prefix + "_e"], filled[prefix + "_n"]
        mx, my = e * ex + n * nx, e * ey + n * ny
        length = np.maximum(np.hypot(mx, my), 1e-6)
        return mx / length, my / length

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    images = {
        "nws-waves-windsea.png": (filled["VHM0_WW"], HS_STEP, map_dir("VMDR_WW")),
        "nws-waves-swell.png": (filled["VHM0_SW1"], HS_STEP, map_dir("VMDR_SW1")),
    }
    for fname, (hs, step, (dx, dy)) in images.items():
        rgb = np.dstack([to_bytes(hs, step), dir_bytes(dx), dir_bytes(dy)])
        Image.fromarray(rgb, "RGB").save(out / fname, optimize=True)
    period = np.dstack([to_bytes(filled["VTPK_WW"], TP_STEP), to_bytes(filled["VTPK_SW1"], TP_STEP),
                        to_bytes(filled["WSPD"], WIND_STEP)])
    Image.fromarray(period, "RGB").save(out / "nws-waves-period.png", optimize=True)

    doc = {
        "title": info["title"],
        "source": info["source"],
        "forecast_reference_time": run.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "valid_time": valid.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "grid": {
            "proj4": hm["proj"],
            "width": width, "height": height,
            "x_west_edge": hm["xMin"], "y_north_edge": hm["yMax"],
            "spacing": args.spacing,
            "note": "cell centres half a cell in from the edges; row 0 north, column 0 west",
        },
        "textures": {
            "windsea": {"file": "nws-waves-windsea.png",
                        "r": f"wind-sea significant height, m = byte * {HS_STEP}",
                        "gb": "propagation direction (x east, y north) = byte / 127.5 - 1"},
            "swell": {"file": "nws-waves-swell.png",
                      "r": f"primary swell significant height, m = byte * {HS_STEP}",
                      "gb": "propagation direction (x east, y north) = byte / 127.5 - 1"},
            "period": {"file": "nws-waves-period.png",
                       "r": f"wind-sea peak period, s = byte * {TP_STEP}",
                       "g": f"primary swell peak period, s = byte * {TP_STEP}",
                       "b": f"10 m wind speed, m/s = byte * {WIND_STEP}"},
        },
        "scale": {"hs": HS_STEP, "tp": TP_STEP, "wind": WIND_STEP},
        "stats": {n: [round(float(np.nanmin(sampled[n])), 2), round(float(np.nanmax(sampled[n])), 2)]
                  for n in ("VHM0_WW", "VHM0_SW1", "VTPK_WW", "VTPK_SW1", "WSPD")},
        "attribution": "Contains Met Office data, Crown copyright, licensed under CC BY-SA 4.0",
    }
    (out / "nws-waves.json").write_text(json.dumps(doc, indent=2))
    print(json.dumps({"written": str(out), "shape": [height, width], "valid": doc["valid_time"],
                      "stats": doc["stats"]}, indent=2))


if __name__ == "__main__":
    main()

"""Build the British Isles terrain heightmap used by the app.

The heightmap is on the same Lambert Azimuthal Equal Area projection as the
Met Office UKV 2 km grid (see pipeline/README.md), at 1 km spacing with sample
positions on whole 2 km multiples, so every second terrain sample sits exactly
on a UKV cell centre.

Elevation comes from AWS Terrain Tiles (Terrarium encoding, Web Mercator). A
Natural Earth coastline sets the land/sea split, so low-lying land such as the
Fens stays above sea level and the sea stays below it. The result is written as
a Terrarium-encoded PNG so the browser can decode it:

    height_m = R * 256 + G + B / 256 - 32768

Usage: pip install -r scripts/requirements.txt && python3 scripts/build_heightmap.py
"""

import json
import math
import pathlib
import urllib.request

import numpy as np
from PIL import Image, ImageDraw
from pyproj import Transformer

PROJ = "+proj=laea +lat_0=54.9 +lon_0=-2.5 +x_0=0 +y_0=0 +ellps=GRS80 +units=m"

# Grid extent in LAEA metres (inclusive sample positions), covering the British Isles.
X_MIN, X_MAX = -640_000, 440_000
Y_MIN, Y_MAX = -640_000, 720_000
SPACING = 1_000

ZOOM = 8
TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
LAND_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/"
    "geojson/ne_10m_land.geojson"
)
ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache"
OUT_DIR = ROOT / "public" / "data"

to_lonlat = Transformer.from_crs(PROJ, "EPSG:4326", always_xy=True)
from_lonlat = Transformer.from_crs("EPSG:4326", PROJ, always_xy=True)


def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    lat_r = np.radians(lat)
    y = (1.0 - np.log(np.tan(lat_r) + 1.0 / np.cos(lat_r)) / math.pi) / 2.0 * n
    return x, y


def fetch_cached(url, name):
    path = CACHE / name
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url) as r:
            path.write_bytes(r.read())
    return path


def fetch_tile(z, x, y):
    path = fetch_cached(TILE_URL.format(z=z, x=x, y=y), f"tiles/{z}_{x}_{y}.png")
    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.float64)
    return rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768


def sample_elevation(lon, lat):
    """Bilinearly samples Terrarium elevation (metres) at arrays of lon/lat."""
    px, py = lonlat_to_tile(lon, lat, ZOOM)
    tx0, ty0 = int(px.min()), int(py.min())
    tx1, ty1 = int(px.max()), int(py.max())
    mosaic = np.vstack([
        np.hstack([fetch_tile(ZOOM, tx, ty) for tx in range(tx0, tx1 + 1)])
        for ty in range(ty0, ty1 + 1)
    ])
    px = (px - tx0) * 256 - 0.5
    py = (py - ty0) * 256 - 0.5
    ix = np.clip(np.floor(px).astype(int), 0, mosaic.shape[1] - 2)
    iy = np.clip(np.floor(py).astype(int), 0, mosaic.shape[0] - 2)
    fx, fy = px - ix, py - iy
    return (
        mosaic[iy, ix] * (1 - fx) * (1 - fy)
        + mosaic[iy, ix + 1] * fx * (1 - fy)
        + mosaic[iy + 1, ix] * (1 - fx) * fy
        + mosaic[iy + 1, ix + 1] * fx * fy
    )


def land_mask(width, height, lon_range, lat_range):
    """Rasterises Natural Earth land polygons onto the output grid (True = land)."""
    land = json.loads(fetch_cached(LAND_URL, "ne_10m_land.geojson").read_text())
    img = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(img)

    def to_px(ring):
        x, y = from_lonlat.transform([p[0] for p in ring], [p[1] for p in ring])
        return list(zip((np.array(x) - X_MIN) / SPACING, (Y_MAX - np.array(y)) / SPACING))

    for feature in land["features"]:
        geom = feature["geometry"]
        polygons = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for polygon in polygons:
            lons = [p[0] for p in polygon[0]]
            lats = [p[1] for p in polygon[0]]
            if (max(lons) < lon_range[0] or min(lons) > lon_range[1]
                    or max(lats) < lat_range[0] or min(lats) > lat_range[1]):
                continue
            draw.polygon(to_px(polygon[0]), fill=1)
            for hole in polygon[1:]:
                draw.polygon(to_px(hole), fill=0)
    return np.asarray(img, dtype=bool)


def main():
    xs = np.arange(X_MIN, X_MAX + SPACING, SPACING)
    ys = np.arange(Y_MAX, Y_MIN - SPACING, -SPACING)  # row 0 is north
    x_g, y_g = np.meshgrid(xs, ys)
    lon, lat = (np.asarray(a) for a in to_lonlat.transform(x_g, y_g))

    h = sample_elevation(lon, lat)

    # Land is at least 1 m and sea at most -1 m, so the coastline follows the mask.
    mask = land_mask(len(xs), len(ys), (lon.min(), lon.max()), (lat.min(), lat.max()))
    h = np.where(mask, np.maximum(h, 1.0), np.minimum(h, -1.0))

    # Whole metres are plenty, and deep sea detail is not needed; both keep the PNG small.
    h = np.round(np.maximum(h, -200.0))
    v = h + 32768
    r = np.floor(v / 256)
    g = v - r * 256
    b = np.zeros_like(v)
    img = np.stack([r, g, b], axis=-1).astype(np.uint8)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    Image.fromarray(img, "RGB").save(OUT_DIR / "uk-heightmap.png", optimize=True)
    meta = {
        "proj": PROJ,
        "xMin": X_MIN, "xMax": X_MAX, "yMin": Y_MIN, "yMax": Y_MAX,
        "spacing": SPACING,
        "width": len(xs), "height": len(ys),
        "minHeight": float(h.min()), "maxHeight": float(h.max()),
        "source": "AWS Terrain Tiles (Terrarium) zoom %d; coastline from Natural Earth 10m land" % ZOOM,
    }
    (OUT_DIR / "uk-heightmap.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(json.dumps(meta))


if __name__ == "__main__":
    main()

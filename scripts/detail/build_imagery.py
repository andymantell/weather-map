"""Build a cloud-free Sentinel-2 colour image for one detailed area (see docs/terrain-detail.md).

Writes public/data/detail/<area>/imagery.jpg: true colour at 10 m on the area's LAEA grid
(north up, covering meta.json's xMin..xMax, yMin..yMax). The ground shader takes the real
field pattern, crops and moorland colours from it, and adds its own detail close up.

The image is a per-pixel median of clear summer looks. Each scene's scene classification (SCL)
marks the clear pixels, with cloud, cirrus and cloud shadow grown by 100 m to catch soft edges
the SCL misses. No cloudy pixel ever reaches the output: each pixel takes the first of these
that has data (see docs/satellite-cloud-free-imagery.md):

  1. recent summers (RECENT_YEARS) with at least MIN_LOOKS clear looks,
  2. clear looks from any summer in OLDER_YEARS or RECENT_YEARS,
  3. looser masking that also accepts SCL dark area and unclassified (topographic shadow,
     bright rock), still never cloud, cirrus or cloud shadow,
  4. a fill from the surrounding pixels.

meta.json's "imagery" records the share of pixels from each tier, so tiles that lean on tiers 3
and 4 can be checked by eye.

Scenes come from the public Sentinel-2 L2A Cloud-Optimised GeoTIFFs on AWS (s3://sentinel-cogs),
read anonymously, so no account is needed.

Contains modified Copernicus Sentinel data.

Usage: python3 scripts/detail/build_imagery.py plymouth
"""

import json
import os
import pathlib
import sys
import warnings
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pyarrow.fs as pafs
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT
from scipy import ndimage

import build_area as ba

ROOT = pathlib.Path(__file__).resolve().parents[2]
CACHE = ROOT / ".cache" / "detail" / "imagery"
BUCKET = "sentinel-cogs/sentinel-s2-l2a-cogs"

# Sentinel-2 (MGRS) tile holding each area. UK bake tiles find theirs with mgrs_tiles().
TILES = {"plymouth": "30/U/VA", "kielder": "30/U/WG", "tintagel": "30/U/UB"}
RECENT_YEARS = (2023, 2024, 2025)
OLDER_YEARS = (2019, 2020, 2021, 2022)  # only read where recent looks run short
SUMMER = (5, 6, 7, 8, 9)
MAX_CLOUD = 60  # % of the tile; the per-area clear share below does the real selection
MAX_SCENES = 20  # per year group
MIN_SHARE = 0.3  # least share of the area a scene must see clear
MIN_LOOKS = 3
PIXEL = 10  # metres
GROW = 100  # metres to grow cloud, cirrus and cloud shadow by
# SCL classes: ground (vegetation, bare soil, water), loose extras (dark area, unclassified),
# and the ones never used (cloud shadow, cloud medium/high, cirrus).
CLEAR = (4, 5, 6)
LOOSE = (2, 7)
CLOUDY = (3, 8, 9, 10)

os.environ.setdefault("AWS_NO_SIGN_REQUEST", "YES")
os.environ.setdefault("AWS_REGION", "us-west-2")
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
if os.environ.get("HTTPS_PROXY"):
    os.environ.setdefault("GDAL_HTTP_PROXY", os.environ["HTTPS_PROXY"])
if os.environ.get("SSL_CERT_FILE"):
    os.environ.setdefault("GDAL_CURL_CA_BUNDLE", os.environ["SSL_CERT_FILE"])


def mgrs_tiles(square):
    """Every Sentinel-2 tile ("30/U/VA") over a LAEA square, from a 5 x 5 grid of points on it.
    A 16 km bake tile can straddle two to four of them, or a UTM zone boundary."""
    import mgrs

    x0, y0, x1, y1 = square
    t = np.linspace(0, 1, 5)
    gx, gy = np.meshgrid(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)
    lon, lat = ba.to_lonlat.transform(gx.ravel(), gy.ravel())
    m = mgrs.MGRS()
    ids = {m.toMGRS(la, lo, MGRSPrecision=0) for lo, la in zip(lon, lat)}
    return sorted(f"{i[:-3]}/{i[-3]}/{i[-2:]}" for i in ids)


def area_tiles(area):
    cfg = ba.area(area)
    return mgrs_tiles(cfg["square"]) if "square" in cfg else [TILES[area]]


def s3():
    return pafs.S3FileSystem(
        anonymous=True, region="us-west-2",
        proxy_options=os.environ.get("HTTPS_PROXY") or None,
        tls_ca_file_path=os.environ.get("SSL_CERT_FILE") or None,
    )


def scenes(tile, years):
    """Summer scenes of the tile, least cloudy first, one per date (latest processing)."""
    cache = CACHE / f"scenes-{tile.replace('/', '')}-{years[0]}-{years[-1]}.json"
    if cache.exists():
        return [tuple(s) for s in json.loads(cache.read_text())]
    fs = s3()

    def month(ym):
        y, m = ym
        try:
            dirs = fs.get_file_info(pafs.FileSelector(f"{BUCKET}/{tile}/{y}/{m}"))
        except (FileNotFoundError, OSError):
            return []
        out = []
        for d in dirs:
            name = d.path.split("/")[-1]
            props = json.loads(fs.open_input_stream(f"{d.path}/{name}.json").read())["properties"]
            out.append((props.get("eo:cloud_cover", 100), props.get("s2:nodata_pixel_percentage", 100), d.path))
        return out

    with ThreadPoolExecutor(8) as ex:
        found = [s for part in ex.map(month, [(y, m) for y in years for m in SUMMER]) for s in part]
    # S2A_30UVA_20250701_0_L2A and _1_L2A are the same pass processed twice.
    latest = {}
    for s in sorted(found, key=lambda s: s[2]):
        latest[s[2].split("/")[-1].rsplit("_", 2)[0]] = s
    keep = sorted(s for s in latest.values() if s[0] <= MAX_CLOUD and s[1] <= 60)
    cache.parent.mkdir(parents=True, exist_ok=True)
    ba.write_atomic(cache, lambda p: p.write_text(json.dumps(keep)))
    return keep


def read(path, band, meta, resampling):
    """One band (or TCI's three) warped onto the area's grid."""
    width = round((meta["xMax"] - meta["xMin"]) / PIXEL)
    height = round((meta["yMax"] - meta["yMin"]) / PIXEL)
    transform = from_origin(meta["xMin"], meta["yMax"], PIXEL, PIXEL)
    with rasterio.open(f"/vsis3/{path}/{band}.tif") as src:
        with WarpedVRT(src, crs=meta["proj"], transform=transform, width=width, height=height,
                       resampling=resampling, nodata=0) as vrt:
            return vrt.read()


def scene_pixels(path, meta):
    """True colour plus clear and loose masks for one scene."""
    cache = CACHE / (path.split("/")[-1] + f"-{meta['xMin']}-{meta['yMax']}-scl.npz")
    if cache.exists():
        z = np.load(cache)
        rgb, scl = z["rgb"], z["scl"]
    else:
        rgb = read(path, "TCI", meta, Resampling.bilinear)
        scl = read(path, "SCL", meta, Resampling.nearest)[0]
        cache.parent.mkdir(parents=True, exist_ok=True)
        # np.savez adds ".npz" to names without it, so the temporary name keeps the suffix.
        tmp = cache.with_name(f"{cache.stem}.{os.getpid()}.tmp.npz")
        np.savez_compressed(tmp, rgb=rgb, scl=scl)
        os.replace(tmp, cache)
    valid = rgb.min(axis=0) > 0
    near_cloud = ndimage.distance_transform_edt(~np.isin(scl, CLOUDY)) * PIXEL <= GROW
    clear = np.isin(scl, CLEAR) & valid & ~near_cloud
    loose = np.isin(scl, CLEAR + LOOSE) & valid & ~near_cloud
    return rgb, clear, loose


def pick(found, meta, limit):
    """Read scenes, least cloudy first, keeping up to `limit` that see enough of the area."""
    kept = []
    with ThreadPoolExecutor(6) as ex:
        # Read in batches so we stop soon after enough scenes are found.
        for i in range(0, len(found), 6):
            batch = found[i:i + 6]
            for (cloud, nodata, path), (rgb, clear, loose) in zip(
                    batch, ex.map(lambda s: scene_pixels(s[2], meta), batch)):
                share = clear.mean()
                print(f"  {path.split('/')[-1]}: tile cloud {cloud:.0f}%, clear here {share:.0%}")
                if share >= MIN_SHARE and len(kept) < limit:
                    kept.append((rgb, clear, loose))
            if len(kept) >= limit:
                break
    return kept


def median(stack, masks):
    """Per-pixel median of the masked looks (NaN where none) and the number of looks."""
    height, width = masks[0].shape
    out = np.empty((3, height, width), np.float32)
    looks = np.zeros((height, width), np.int16)
    # In strips of rows, so 40 scenes of a 25 km tile fit in memory.
    for y0 in range(0, height, 256):
        rows = slice(y0, y0 + 256)
        rgb = np.stack([s[:, rows] for s in stack]).astype(np.float32)  # scene, band, y, x
        ok = np.stack([m[rows] for m in masks])
        rgb[~np.broadcast_to(ok[:, None], rgb.shape)] = np.nan
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN pixels
            out[:, rows] = np.nanmedian(rgb, axis=0)
        looks[rows] = ok.sum(axis=0)
    return out, looks


def inpaint(image):
    """Fill NaN pixels from their surroundings with ever wider blurs."""
    hole = np.isnan(image[0])
    weight = (~hole).astype(np.float32)
    data = np.nan_to_num(image)
    for sigma in (2, 4, 8, 16, 32, 64, 128):
        den = ndimage.gaussian_filter(weight, sigma)
        need = np.isnan(image[0]) & (den > 0.05)
        for c in range(3):
            image[c][need] = (ndimage.gaussian_filter(data[c] * weight, sigma) / np.maximum(den, 1e-6))[need]
        if not np.isnan(image[0]).any():
            break
    return image


def main(area):
    out = ba.area(area)["out"]
    meta = json.loads((out / "meta.json").read_text())
    tiles = area_tiles(area)

    def listed(years):
        # Pooled over the Sentinel-2 tiles, least cloudy first.
        return sorted(s for tile in tiles for s in scenes(tile, years))

    recent = listed(RECENT_YEARS)
    print(f"{len(recent)} recent summer scenes under {MAX_CLOUD}% cloud")
    kept = pick(recent, meta, MAX_SCENES)
    image, looks = median([k[0] for k in kept], [k[1] for k in kept])
    tier = np.where(looks >= MIN_LOOKS, 1, 0)
    used = len(kept)

    if (tier == 0).any():
        older = listed(OLDER_YEARS)
        print(f"{(tier == 0).sum()} pixels short of looks; adding from {len(older)} older scenes")
        kept += pick(older, meta, MAX_SCENES)
        used = len(kept)
        all_years, n = median([k[0] for k in kept], [k[1] for k in kept])
        fill = (tier == 0) & (n > 0)
        image[:, fill] = all_years[:, fill]
        tier[fill] = 2

    if (tier == 0).any():
        loose, n = median([k[0] for k in kept], [k[2] for k in kept])
        fill = (tier == 0) & (n > 0)
        image[:, fill] = loose[:, fill]
        tier[fill] = 3

    if (tier == 0).any():
        image[:, tier == 0] = np.nan
        image = inpaint(image)
        tier[tier == 0] = 4

    shares = {f"tier{t}": round(float((tier == t).mean()), 6) for t in (1, 2, 3, 4)}
    print("pixel shares:", shares)
    image = np.clip(image, 0, 255).astype(np.uint8).transpose(1, 2, 0)
    Image.fromarray(image).save(out / "imagery.jpg", quality=90)
    meta["imagery"] = dict(pixel=PIXEL, width=image.shape[1], height=image.shape[0], scenes=used, **shares)
    meta["attribution"] = meta["attribution"].split("; Contains modified Copernicus")[0] + \
        "; Contains modified Copernicus Sentinel data"
    (out / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"wrote imagery.jpg {image.shape[1]}x{image.shape[0]} from {used} scenes")


if __name__ == "__main__":
    main(sys.argv[1])

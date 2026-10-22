"""Build a cloud-free Sentinel-2 colour image for one detailed area (see docs/terrain-detail.md).

Writes public/data/detail/<area>/imagery.jpg: true colour at 10 m on the area's LAEA grid
(north up, covering meta.json's xMin..xMax, yMin..yMax). The ground shader takes the real
field pattern, crops and moorland colours from it, and adds its own detail close up.

The image is a per-pixel median of the clear pixels in the summer scenes with least cloud,
using each scene's scene classification (SCL) to drop cloud, cloud shadow and snow. Scenes
come from the public Sentinel-2 L2A Cloud-Optimised GeoTIFFs on AWS (s3://sentinel-cogs),
read anonymously, so no account is needed.

Contains modified Copernicus Sentinel data.

Usage: python3 scripts/detail/build_imagery.py plymouth
"""

import json
import os
import pathlib
import sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pyarrow.fs as pafs
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT

ROOT = pathlib.Path(__file__).resolve().parents[2]
CACHE = ROOT / ".cache" / "detail" / "imagery"
BUCKET = "sentinel-cogs/sentinel-s2-l2a-cogs"

# Sentinel-2 (MGRS) tile holding each area.
TILES = {"plymouth": "30/U/VA", "kielder": "30/U/WG"}
MONTHS = [(y, m) for y in (2023, 2024, 2025) for m in (5, 6, 7, 8, 9)]
MAX_CLOUD = 40  # % of the tile
MAX_SCENES = 14
PIXEL = 10  # metres
# SCL classes that are ground: vegetation, bare soil, water.
CLEAR = (4, 5, 6)

os.environ.setdefault("AWS_NO_SIGN_REQUEST", "YES")
os.environ.setdefault("AWS_REGION", "us-west-2")
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
if os.environ.get("HTTPS_PROXY"):
    os.environ.setdefault("GDAL_HTTP_PROXY", os.environ["HTTPS_PROXY"])
if os.environ.get("SSL_CERT_FILE"):
    os.environ.setdefault("GDAL_CURL_CA_BUNDLE", os.environ["SSL_CERT_FILE"])


def s3():
    return pafs.S3FileSystem(
        anonymous=True, region="us-west-2",
        proxy_options=os.environ.get("HTTPS_PROXY") or None,
        tls_ca_file_path=os.environ.get("SSL_CERT_FILE") or None,
    )


def scenes(tile):
    """Summer scenes of the tile with their cloud and no-data percentages."""
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
        found = [s for part in ex.map(month, MONTHS) for s in part]
    return sorted(s for s in found if s[0] <= MAX_CLOUD and s[1] <= 60)


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
    cache = CACHE / (path.split("/")[-1] + f"-{meta['xMin']}.npz")
    if cache.exists():
        z = np.load(cache)
        return z["rgb"], z["ok"]
    rgb = read(path, "TCI", meta, Resampling.bilinear)
    scl = read(path, "SCL", meta, Resampling.nearest)[0]
    ok = np.isin(scl, CLEAR) & (rgb.min(axis=0) > 0)
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache, rgb=rgb, ok=ok)
    return rgb, ok


def main(area):
    out = ROOT / "public" / "data" / "detail" / area
    meta = json.loads((out / "meta.json").read_text())
    found = scenes(TILES[area])
    print(f"{len(found)} summer scenes under {MAX_CLOUD}% cloud")
    stack, masks = [], []
    for cloud, nodata, path in found:
        rgb, ok = scene_pixels(path, meta)
        share = ok.mean()
        print(f"  {path.split('/')[-1]}: tile cloud {cloud:.0f}%, clear here {share:.0%}")
        if share < 0.3:
            continue
        stack.append(rgb)
        masks.append(ok)
        if len(stack) >= MAX_SCENES:
            break
    rgb = np.stack(stack).astype(np.float32)  # scene, band, y, x
    ok = np.stack(masks)[:, None]
    rgb[~np.broadcast_to(ok, rgb.shape)] = np.nan
    median = np.nanmedian(rgb, axis=0)
    # Pixels never seen clear: fall back to the median of every scene.
    fallback = np.median(np.stack(stack).astype(np.float32), axis=0)
    median = np.where(np.isnan(median), fallback, median)
    image = np.clip(median, 0, 255).astype(np.uint8).transpose(1, 2, 0)
    Image.fromarray(image).save(out / "imagery.jpg", quality=90)
    meta["imagery"] = dict(pixel=PIXEL, width=image.shape[1], height=image.shape[0], scenes=len(stack))
    meta["attribution"] = meta["attribution"].split("; Contains modified Copernicus")[0] + \
        "; Contains modified Copernicus Sentinel data"
    (out / "meta.json").write_text(json.dumps(meta, indent=2))
    print(f"wrote imagery.jpg {image.shape[1]}x{image.shape[0]} from {len(stack)} scenes")


if __name__ == "__main__":
    main(sys.argv[1])

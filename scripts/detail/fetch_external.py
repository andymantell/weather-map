"""Download the UK government datasets that refine a detailed area (see docs/terrain-data-sources.md).

Writes into .cache/detail/external/:

- <area>_ndsm.tif   Height above ground (first-return DSM minus DTM) at 1 m, in decimetres
                    (int16, deflate), EPSG:27700. Environment Agency LIDAR Composite 2022,
                    England only. Used by build_area.py for measured building heights.
- <area>_dtm.tif   Bare-ground height at 1 m, in decimetres (int16, deflate, nodata -32768),
                    EPSG:27700. Environment Agency LIDAR Composite DTM 2022, England only.
                    Used by build_area.py for the ground heights (docs/coastal-cliffs.md).
- <area>_nfi.geojson    National Forest Inventory woodland polygons (Forestry Commission), GB.
- <area>_phi.geojson    Priority Habitats Inventory polygons (Natural England), England.

All three are Open Government Licence v3. The services are queried by the area's bounding box,
so nothing UK-wide is downloaded. The hosts (environment.data.gov.uk, *.arcgis.com) are not
reachable from the cloud container this was written in, so run it on a normal connection.

Usage: python scripts/detail/fetch_external.py plymouth [--skip-lidar]
"""

import json
import os
import pathlib
import re
import sys
import time
import urllib.parse
import urllib.request

import numpy as np
import rasterio
import shapely.geometry
from pyproj import Transformer
from rasterio.io import MemoryFile
from rasterio.transform import from_origin

import build_area as ba

OUT = ba.CACHE / "external"

# OGC WCS 2.0.1 services from the data.gov.uk records for the LIDAR Composite. Each also
# serves a hillshade coverage, so the elevation one is picked by name.
DSM_WCS = "https://environment.data.gov.uk/spatialdata/lidar-composite-digital-surface-model-first-return-dsm-1m/wcs"
DTM_WCS = "https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wcs"
# Forestry Commission ArcGIS feature layer (latest year listed on data-forestry.opendata.arcgis.com).
NFI_URL = "https://services2.arcgis.com/mHXjwgl3OARRqqD4/arcgis/rest/services/National_Forest_Inventory_GB_2025/FeatureServer/0"
# Natural England's ArcGIS service for the PHI now needs a token; Defra's GeoServer WFS is open.
PHI_WFS = "https://environment.data.gov.uk/spatialdata/priority-habitat-inventory-england/wfs"
PHI_TYPE = "dataset-92b43165-0dd0-4e69-a712-1e49bb5aa0d0:Priority_Habitat_Inventory_England"

CHUNK = 2000  # metres per WCS request


# The data.gov.uk hosts answer 403 or 429 for a while when asked too fast (the UK bake runs
# many areas at once), so back off for minutes, not seconds, before trying again.
THROTTLED = (403, 429, 502, 503, 504)


def get(url, params=None, tries=8):
    if params:
        url = f"{url}?{urllib.parse.urlencode(params, safe=':,()')}"
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return r.read()
        except Exception as error:  # noqa: BLE001 - retry any network failure
            code = getattr(error, "code", 0)
            # A 4xx/5xx from the WCS outside its coverage won't change on retry.
            if attempt == tries - 1 or code in (400, 404, 500):
                raise RuntimeError(f"{url}: {error}") from error
            wait = min(30 * 2 ** attempt, 300) if code in THROTTLED else 2 ** (attempt + 1)
            print(f"  {code or type(error).__name__} from {url.split('?')[0][-60:]}, retrying in {wait} s")
            time.sleep(wait)


def bng_bbox(bbox):
    """The area's lon/lat box as a British National Grid box, rounded out to whole km."""
    t = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
    xs, ys = zip(*[t.transform(lon, lat) for lon in bbox[0::2] for lat in bbox[1::2]])
    return (int(min(xs)) // 1000 * 1000, int(min(ys)) // 1000 * 1000,
            (int(max(xs)) // 1000 + 1) * 1000, (int(max(ys)) // 1000 + 1) * 1000)


def coverage_id(wcs):
    """The elevation coverage of a WCS, looked up once and kept with the lidar cache."""
    path = LIDAR_CACHE / "coverages.json"
    known = json.loads(path.read_text()) if path.exists() else {}
    if wcs not in known:
        known[wcs] = find_coverage(wcs)
        path.parent.mkdir(parents=True, exist_ok=True)
        ba.write_atomic(path, lambda p: p.write_text(json.dumps(known, indent=1)))
    return known[wcs]


def find_coverage(wcs):
    caps = get(wcs, {"service": "WCS", "version": "2.0.1", "request": "GetCapabilities"}).decode()
    ids = re.findall(r"<wcs:CoverageId>([^<]+)</wcs:CoverageId>", caps)
    return next(i for i in ids if "Elevation" in i)


def wcs_chunk(wcs, cov, x0, y0, x1, y1):
    # The query repeats "subset", which urlencode can't do, so it's built by hand.
    query = (f"service=WCS&version=2.0.1&request=GetCoverage&coverageId={urllib.parse.quote(cov)}"
             f"&format=image/tiff&subset=E({x0},{x1})&subset=N({y0},{y1})")
    for attempt in range(4):
        data = get(f"{wcs}?{query}")
        try:
            with MemoryFile(data) as mem, mem.open() as src:
                a = src.read(1).astype(np.float32)
                nodata = src.nodata
            break
        except rasterio.errors.RasterioError:
            # The odd response arrives cut short; fetch it again.
            if attempt == 3:
                raise
            print(f"  bad TIFF for E({x0}) N({y0}), fetching again")
            time.sleep(5)
    if nodata is not None:
        a[a == nodata] = np.nan
    a[a < -1000] = np.nan
    return a


def write_tif(out, data, x0, y1, nodata):
    def write(path):
        with rasterio.open(path, "w", driver="GTiff", width=data.shape[1], height=data.shape[0], count=1,
                           dtype="int16", crs="EPSG:27700", transform=from_origin(x0, y1, 1, 1), nodata=nodata,
                           compress="deflate", predictor=2, tiled=True) as dst:
            dst.write(data, 1)
    OUT.mkdir(parents=True, exist_ok=True)
    ba.write_atomic(out, write)


# Lidar chunks are cached on the 2 km BNG grid and shared between areas, so the margins that
# neighbouring UK bake tiles overlap by are downloaded once. About 10 MB a chunk, so England
# needs a few hundred GB: kept on E: when there is one.
LIDAR_CACHE = pathlib.Path(os.environ.get("LIDAR_CACHE") or
                           ("E:/weather-map-cache/lidar" if os.path.isdir("E:/") else ba.CACHE / "lidar"))


def lidar_chunk(cx, cy, covs):
    """DTM and nDSM (int16 decimetres, CHUNK square, rows north to south) of the chunk whose
    south-west corner is cx, cy, or None where the service has no data (outside England)."""
    path = LIDAR_CACHE / f"{cx}_{cy}.npz"
    if path.exists():
        z = np.load(path)
        return (z["dtm"], z["ndsm"]) if "dtm" in z else None
    ex, ey = cx + CHUNK, cy + CHUNK
    dtm = np.full((CHUNK, CHUNK), -32768, np.int16)
    ndsm = np.full((CHUNK, CHUNK), -1, np.int16)
    try:
        t = wcs_chunk(DTM_WCS, covs[0], cx, cy, ex, ey)
    except RuntimeError as error:
        # Outside England (e.g. Kielder's Scottish edge), or open sea: the service answers
        # with an error that won't change, so remember the gap. Anything else is retried.
        if getattr(error.__cause__, "code", 0) not in (400, 404, 500):
            raise
        print(f"  lidar chunk {cx},{cy} has no data: {str(error)[-80:]}")
        save_chunk(path, {})
        return None
    hh, ww = min(t.shape[0], CHUNK), min(t.shape[1], CHUNK)
    t = t[:hh, :ww]
    dtm[:hh, :ww] = np.where(np.isnan(t), -32768, np.clip(np.round(t * 10), -32000, 32000)).astype(np.int16)
    try:
        dsm = wcs_chunk(DSM_WCS, covs[1], cx, cy, ex, ey)
    except RuntimeError as error:
        # Some coastal chunks have a DTM but no DSM: keep the ground, and building
        # heights there fall back to estimates.
        if getattr(error.__cause__, "code", 0) not in (400, 404, 500):
            raise
        print(f"  dsm chunk {cx},{cy} has no data: {str(error)[-80:]}")
        dsm = None
    if dsm is not None:
        hh, ww = min(dsm.shape[0], hh), min(dsm.shape[1], ww)
        d = np.clip((dsm[:hh, :ww] - t[:hh, :ww]) * 10, -1, 32000)
        ndsm[:hh, :ww] = np.where(np.isnan(d), -1, d).astype(np.int16)
    save_chunk(path, {"dtm": dtm, "ndsm": ndsm})
    return dtm, ndsm


def save_chunk(path, arrays):
    path.parent.mkdir(parents=True, exist_ok=True)
    # np.savez adds ".npz" to names without it, so the temporary name keeps the suffix.
    tmp = path.with_name(f"{path.stem}.{os.getpid()}.tmp.npz")
    np.savez_compressed(tmp, **arrays)
    try:
        os.replace(tmp, path)
    except PermissionError:
        tmp.unlink(missing_ok=True)  # another worker wrote the same chunk first


# Welsh Government LiDAR 2020-23 (DataMapWales): a WFS catalogue of 1 km tiles, each with a 1 m
# DTM and DSM GeoTIFF (float32 metres, BNG) on Azure. Fills what the EA's England-only data lacks.
WALES_WFS = "https://datamap.gov.wales/geoserver/ows"
WALES_TYPE = "geonode:welsh_government_lidar_tile_catalogue_2020_2023"
WALES_CACHE = LIDAR_CACHE.parent / "wales"
SOURCES = {
    "ea": "Environment Agency LIDAR Composite 2022 (© Environment Agency copyright and/or database right 2022)",
    "wales": "Welsh Government LiDAR 2020-2023 (DataMapWales)",
}


def wales_tiles(x0, y0, x1, y1):
    """The Welsh surveys of each 1 km square in a BNG box, latest first: {(east, north): [(dtm, dsm) URLs]}."""
    page = json.loads(get(WALES_WFS, {
        "service": "WFS", "version": "1.0.0", "request": "GetFeature", "typeName": WALES_TYPE,
        "outputFormat": "application/json", "srsName": "EPSG:27700", "bbox": f"{x0},{y0},{x1},{y1}",
    }))
    best = {}
    for f in page["features"]:
        pr = f["properties"]
        bx0, by0, _, _ = shapely.geometry.shape(f["geometry"]).bounds
        key = (round(bx0 / 1000) * 1000, round(by0 / 1000) * 1000)
        day, month, year = pr["date"].split("-")
        when = f"{year}{month}{day}"
        best.setdefault(key, []).append((when, "https://" + pr["dtm_link"], "https://" + pr["dsm_link"]))
    return {k: [u[1:] for u in sorted(v, reverse=True)] for k, v in best.items()}


def wales_tile(url):
    """A Welsh lidar tile (cached on disk) as a float32 array in metres, NaN where empty; None
    where the catalogue links to a file that isn't there (a few do)."""
    path = WALES_CACHE / url.split("/")[-1]
    if not path.exists():
        try:
            data = get(url)
        except RuntimeError as error:
            if getattr(error.__cause__, "code", 0) != 404:
                raise
            print(f"  wales tile missing: {url.split('/')[-1]}")
            return None
        path.parent.mkdir(parents=True, exist_ok=True)
        ba.write_atomic(path, lambda p: p.write_bytes(data))
    for attempt in range(10):
        try:
            with rasterio.open(path) as src:
                a = src.read(1).astype(np.float32)
                nodata = src.nodata
            break
        except rasterio.errors.RasterioIOError:
            # Windows won't open a file while another worker is moving its copy of it into place.
            if attempt == 9:
                raise
            time.sleep(1)
    if nodata is not None:
        a[a == nodata] = np.nan
    a[a < -1000] = np.nan
    return a


def fetch_lidar(area, bbox, ea=True, wales=False):
    """Both lidar rasters (nDSM and DTM) for the area: the Environment Agency's (England) from the
    shared chunk cache, with gaps filled from the Welsh Government's tiles when wales is set."""
    ndsm_out, dtm_out = OUT / f"{area}_ndsm.tif", OUT / f"{area}_dtm.tif"
    if ndsm_out.exists() and dtm_out.exists():
        print("have", ndsm_out, dtm_out)
        return
    x0, y0, x1, y1 = bng_bbox(bbox)
    # Snapped out to the chunk grid, so every area asks for the same chunks.
    x0, y0 = x0 // CHUNK * CHUNK, y0 // CHUNK * CHUNK
    x1, y1 = -(-x1 // CHUNK) * CHUNK, -(-y1 // CHUNK) * CHUNK
    covs = []
    w, h = x1 - x0, y1 - y0
    ndsm = np.full((h, w), -1, np.int16)
    dtm = np.full((h, w), -32768, np.int16)
    missing = cached = 0
    for cy in range(y0, y1, CHUNK) if ea else []:
        for cx in range(x0, x1, CHUNK):
            if not covs and not (LIDAR_CACHE / f"{cx}_{cy}.npz").exists():
                covs = [coverage_id(DTM_WCS), coverage_id(DSM_WCS)]
            cached += (LIDAR_CACHE / f"{cx}_{cy}.npz").exists()
            got = lidar_chunk(cx, cy, covs)
            if got is None:
                missing += 1
                continue
            r0, c0 = y1 - cy - CHUNK, cx - x0  # rows run north to south
            dtm[r0:r0 + CHUNK, c0:c0 + CHUNK], ndsm[r0:r0 + CHUNK, c0:c0 + CHUNK] = got
    used = ["ea"] if ea and missing < (w // CHUNK) * (h // CHUNK) else []
    if wales:
        tiles = wales_tiles(x0, y0, x1, y1)
        filled = 0
        for (tx, ty), surveys in sorted(tiles.items()):
            if not (x0 <= tx and tx + 1000 <= x1 and y0 <= ty and ty + 1000 <= y1):
                continue
            r0, c0 = y1 - ty - 1000, tx - x0
            gap = dtm[r0:r0 + 1000, c0:c0 + 1000] == -32768
            if not gap.any():
                continue
            for dtm_url, dsm_url in surveys:
                t, s = wales_tile(dtm_url), wales_tile(dsm_url)
                if t is not None and s is not None and t.shape == s.shape == (1000, 1000):
                    break
            else:
                print(f"  wales square {tx},{ty}: no usable survey")
                continue
            d = np.where(np.isnan(t), -32768, np.clip(np.round(t * 10), -32000, 32000)).astype(np.int16)
            n_ = np.clip((s - t) * 10, -1, 32000)
            n_ = np.where(np.isnan(n_), -1, n_).astype(np.int16)
            dtm[r0:r0 + 1000, c0:c0 + 1000][gap] = d[gap]
            ndsm[r0:r0 + 1000, c0:c0 + 1000][gap] = n_[gap]
            filled += 1
        print(f"  wales: {len(tiles)} tiles listed, {filled} used")
        if filled:
            used.append("wales")
    write_tif(dtm_out, dtm, x0, y1, -32768)
    write_tif(ndsm_out, ndsm, x0, y1, -1)
    # Which surveys the rasters came from, for build_area.py's attribution.
    (OUT / f"{area}_lidar.json").write_text(json.dumps({"sources": [SOURCES[k] for k in used]}))
    n = (w // CHUNK) * (h // CHUNK)
    print("wrote", ndsm_out, dtm_out, f"({n} chunks: {cached} cached, {missing} without data; sources {used})")


def fetch_features(url, bbox, out):
    if out.exists():
        print("have", out)
        return
    features, offset = [], 0
    while True:
        page = json.loads(get(f"{url}/query", {
            "where": "1=1", "outFields": "*", "f": "geojson", "outSR": "4326",
            "geometry": ",".join(map(str, bbox)), "geometryType": "esriGeometryEnvelope",
            "inSR": "4326", "spatialRel": "esriSpatialRelIntersects",
            "resultOffset": offset, "resultRecordCount": 1000,
        }))
        got = page.get("features", [])
        features += got
        print(f"  {out.name}: {len(features)} features")
        if len(got) < 1000 and not page.get("exceededTransferLimit"):
            break
        offset += len(got)
    OUT.mkdir(parents=True, exist_ok=True)
    ba.write_atomic(out, lambda p: p.write_text(json.dumps({"type": "FeatureCollection", "features": features})))
    print("wrote", out)


def fetch_wfs(url, type_name, bbox, out):
    if out.exists():
        print("have", out)
        return
    # WFS 1.0.0 keeps EPSG:4326 in lon/lat order; the server's default count (300000) means
    # one request covers an area.
    page = json.loads(get(url, {
        "service": "WFS", "version": "1.0.0", "request": "GetFeature", "typeName": type_name,
        "outputFormat": "application/json", "srsName": "EPSG:4326",
        "bbox": ",".join(map(str, bbox)) + ",EPSG:4326",
    }))
    features = page["features"]
    for f in features:
        f.pop("id", None)
    OUT.mkdir(parents=True, exist_ok=True)
    ba.write_atomic(out, lambda p: p.write_text(json.dumps({"type": "FeatureCollection", "features": features})))
    print(f"wrote {out} ({len(features)} features)")


def main(area, england=True, wales=False):
    bbox = ba.area(area)["bbox"]
    if england or wales:
        fetch_lidar(area, bbox, ea=england, wales=wales)
    fetch_features(NFI_URL, bbox, OUT / f"{area}_nfi.geojson")
    if england:  # the habitat inventory is England-only, like the EA's lidar
        fetch_wfs(PHI_WFS, PHI_TYPE, bbox, OUT / f"{area}_phi.geojson")


if __name__ == "__main__":
    # --skip-lidar: not England (no EA lidar or habitat inventory); --wales: add the Welsh lidar.
    main(sys.argv[1], england="--skip-lidar" not in sys.argv, wales="--wales" in sys.argv)

"""Download the UK government datasets that refine a detailed area (see docs/terrain-data-sources.md).

Writes into .cache/detail/external/:

- <area>_ndsm.tif   Height above ground (first-return DSM minus DTM) at 1 m, in decimetres
                    (int16, deflate), EPSG:27700. Environment Agency LIDAR Composite 2022,
                    England only. Used by build_area.py for measured building heights.
- <area>_nfi.geojson    National Forest Inventory woodland polygons (Forestry Commission), GB.
- <area>_phi.geojson    Priority Habitats Inventory polygons (Natural England), England.

All three are Open Government Licence v3. The services are queried by the area's bounding box,
so nothing UK-wide is downloaded. The hosts (environment.data.gov.uk, *.arcgis.com) are not
reachable from the cloud container this was written in, so run it on a normal connection.

Usage: python scripts/detail/fetch_external.py plymouth [--skip-lidar]
"""

import json
import re
import sys
import time
import urllib.parse
import urllib.request

import numpy as np
import rasterio
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


def get(url, params=None, tries=4):
    if params:
        url = f"{url}?{urllib.parse.urlencode(params, safe=':,()')}"
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return r.read()
        except Exception as error:  # noqa: BLE001 - retry any network failure
            if attempt == tries - 1:
                raise RuntimeError(f"{url}: {error}") from error
            time.sleep(2 ** (attempt + 1))


def bng_bbox(bbox):
    """The area's lon/lat box as a British National Grid box, rounded out to whole km."""
    t = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
    xs, ys = zip(*[t.transform(lon, lat) for lon in bbox[0::2] for lat in bbox[1::2]])
    return (int(min(xs)) // 1000 * 1000, int(min(ys)) // 1000 * 1000,
            (int(max(xs)) // 1000 + 1) * 1000, (int(max(ys)) // 1000 + 1) * 1000)


def coverage_id(wcs):
    caps = get(wcs, {"service": "WCS", "version": "2.0.1", "request": "GetCapabilities"}).decode()
    ids = re.findall(r"<wcs:CoverageId>([^<]+)</wcs:CoverageId>", caps)
    return next(i for i in ids if "Elevation" in i)


def wcs_chunk(wcs, cov, x0, y0, x1, y1):
    # The query repeats "subset", which urlencode can't do, so it's built by hand.
    query = (f"service=WCS&version=2.0.1&request=GetCoverage&coverageId={urllib.parse.quote(cov)}"
             f"&format=image/tiff&subset=E({x0},{x1})&subset=N({y0},{y1})")
    data = get(f"{wcs}?{query}")
    with MemoryFile(data) as mem, mem.open() as src:
        a = src.read(1).astype(np.float32)
        nodata = src.nodata
        if nodata is not None:
            a[a == nodata] = np.nan
        a[a < -1000] = np.nan
        return a


def fetch_lidar(area, bbox):
    out = OUT / f"{area}_ndsm.tif"
    if out.exists():
        print("have", out)
        return
    x0, y0, x1, y1 = bng_bbox(bbox)
    dsm_cov, dtm_cov = coverage_id(DSM_WCS), coverage_id(DTM_WCS)
    w, h = x1 - x0, y1 - y0
    ndsm = np.full((h, w), -1, np.int16)
    for cy in range(y0, y1, CHUNK):
        for cx in range(x0, x1, CHUNK):
            ex, ey = min(cx + CHUNK, x1), min(cy + CHUNK, y1)
            dsm = wcs_chunk(DSM_WCS, dsm_cov, cx, cy, ex, ey)
            dtm = wcs_chunk(DTM_WCS, dtm_cov, cx, cy, ex, ey)
            hh, ww = min(dsm.shape[0], dtm.shape[0], ey - cy), min(dsm.shape[1], dtm.shape[1], ex - cx)
            d = np.clip((dsm[:hh, :ww] - dtm[:hh, :ww]) * 10, -1, 32000)
            d = np.where(np.isnan(d), -1, d).astype(np.int16)
            # Rows run north to south.
            r0 = y1 - ey
            ndsm[r0:r0 + hh, cx - x0:cx - x0 + ww] = d
            print(f"  lidar chunk {cx},{cy}")
    OUT.mkdir(parents=True, exist_ok=True)
    with rasterio.open(out, "w", driver="GTiff", width=w, height=h, count=1, dtype="int16",
                       crs="EPSG:27700", transform=from_origin(x0, y1, 1, 1), nodata=-1,
                       compress="deflate", predictor=2, tiled=True) as dst:
        dst.write(ndsm, 1)
    print("wrote", out)


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
    out.write_text(json.dumps({"type": "FeatureCollection", "features": features}))
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
    out.write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    print(f"wrote {out} ({len(features)} features)")


def main(area, skip_lidar=False):
    bbox = ba.AREAS[area]["bbox"]
    if not skip_lidar:
        fetch_lidar(area, bbox)
    fetch_features(NFI_URL, bbox, OUT / f"{area}_nfi.geojson")
    fetch_wfs(PHI_WFS, PHI_TYPE, bbox, OUT / f"{area}_phi.geojson")


if __name__ == "__main__":
    main(sys.argv[1], "--skip-lidar" in sys.argv)

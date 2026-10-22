"""Build the data for one terrain proof-of-concept area (see docs/terrain-poc.md).

For a small lon/lat box this writes, into public/data/detail/<area>/:

- height.png    Terrarium-encoded heights on a fine LAEA grid (AWS Terrain Tiles).
- cover.png     One byte per texel land-cover class (see CLASSES), rasterised from
                Overture Maps base layers (OpenStreetMap land/land_use/water plus
                ESA WorldCover land_cover) and Overture roads.
- buildings.bin Overture building footprints with a height for each.
- trees.bin     Individually mapped trees (OpenStreetMap natural=tree via Overture).
- meta.json     Grid extents and sources.

Overture Maps is read straight from its public S3 bucket, so no API key is needed.
Coordinates are the app's UKV LAEA projection in metres.

Usage: python3 scripts/detail/build_area.py plymouth
"""

import json
import math
import os
import pathlib
import struct
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pyarrow as pa
import pyarrow.dataset as ds
import pyarrow.fs as pafs
import pyarrow.parquet as pq
import shapely
import shapely.geometry
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt, gaussian_filter, maximum_filter
from pyproj import Transformer

PROJ = "+proj=laea +lat_0=54.9 +lon_0=-2.5 +x_0=0 +y_0=0 +ellps=GRS80 +units=m"
OVERTURE = "overturemaps-us-west-2/release/2026-09-23.0"
TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

AREAS = {
    # Lon/lat box, height grid spacing (m), cover texel size (m), and the step (m) of the fine
    # height raster the ground mesh is triangulated from (a divisor of the spacing).
    "plymouth": dict(bbox=(-4.25, 50.33, -4.0, 50.45), spacing=20, texel=4, fine=4),
    "kielder": dict(bbox=(-2.75, 55.1, -2.35, 55.33), spacing=25, texel=8, fine=5),
    # North Cornwall, Tintagel to Boscastle: a cliffed coast to test the shoreline against.
    "tintagel": dict(bbox=(-4.80, 50.63, -4.62, 50.72), spacing=10, texel=4, fine=5),
}

# Land-cover classes written to cover.png; src/detail/ground.ts mirrors these.
CLASSES = dict(
    sea=0, fields=1, park=2, broadleaf=3, conifer=4, heath=5, rock=6, sand=7,
    wetland=8, water=9, urban=10, industrial=11, minor_road=12, major_road=13,
    farmyard=14, rail=15, path=16, young=17, felled=18, mixed=19,
)


# National Forest Inventory interpreted forest types (IFT) to cover classes.
NFI_TYPES = {
    "conifer": "conifer", "broadleaved": "broadleaf", "mixed mainly conifer": "mixed",
    "mixed mainly broadleaved": "mixed", "coppice": "broadleaf", "coppice with standards": "broadleaf",
    "young trees": "young", "felled": "felled", "ground prep": "felled", "windblow": "felled",
    "failed": "young", "shrub": "heath", "low density": "young",
}
# Priority Habitats Inventory main habitats (lower case, prefix match) to cover classes.
PHI_TYPES = {
    "upland heathland": "heath", "lowland heathland": "heath", "mountain heaths": "heath",
    "grass moorland": "heath", "fragmented heath": "heath", "blanket bog": "wetland",
    "lowland raised bog": "wetland", "upland flushes": "wetland", "lowland fens": "wetland",
    "reedbeds": "wetland", "purple moor grass": "wetland", "coastal and floodplain grazing marsh": "wetland",
    "coastal sand dunes": "sand", "maritime cliff": "heath", "limestone pavement": "rock",
    "inland rock": "rock",
}


def external_features(area_name, kind, table):
    """Polygons from fetch_external.py's GeoJSON, projected, with a cover class each."""
    path = EXTERNAL / f"{area_name}_{kind}.geojson"
    if not path.exists():
        return []
    out = []
    for f in json.loads(path.read_text())["features"]:
        values = [str(v).strip().lower() for v in (f.get("properties") or {}).values() if isinstance(v, str)]
        cls = next((table[v] for v in values if v in table), None)
        if cls is None:
            cls = next((c for v in values for name, c in table.items() if v.startswith(name)), None)
        if cls is None or not f.get("geometry"):
            continue
        g = shapely.geometry.shape(f["geometry"])
        out.append((shapely.transform(g, lambda c: np.column_stack(from_lonlat.transform(c[:, 0], c[:, 1]))), cls))
    return out

UPLAND_SHRUB = 200  # temporary class while rasterising
UPLAND_M = 250

# The shoreline only pulls land down to the waterline where the land behind the coast is low.
# Backshore height (highest ground within BACKSHORE_M inland) from CLIFF_LOW_M to CLIFF_HIGH_M
# fades from that smooth shore to a cliff, where the heights are kept as measured.
BACKSHORE_M = 40
CLIFF_LOW_M, CLIFF_HIGH_M = 4.0, 12.0

ROOT = pathlib.Path(__file__).resolve().parents[2]
CACHE = ROOT / ".cache" / "detail"
EXTERNAL = CACHE / "external"

to_lonlat = Transformer.from_crs(PROJ, "EPSG:4326", always_xy=True)
from_lonlat = Transformer.from_crs("EPSG:4326", PROJ, always_xy=True)


def overture(theme, kind, bbox, columns, area):
    """Reads one Overture layer clipped to bbox (by feature bbox), cached as parquet."""
    path = CACHE / f"{area}_{kind}.parquet"
    if path.exists():
        return pq.read_table(path)
    fs = pafs.S3FileSystem(
        anonymous=True, region="us-west-2",
        proxy_options=os.environ.get("HTTPS_PROXY") or None,
        tls_ca_file_path=os.environ.get("SSL_CERT_FILE") or None,
    )
    dataset = ds.dataset(f"{OVERTURE}/theme={theme}/type={kind}/", filesystem=fs, format="parquet")
    xmin, ymin, xmax, ymax = bbox
    f = ((ds.field("bbox", "xmax") > xmin) & (ds.field("bbox", "xmin") < xmax)
         & (ds.field("bbox", "ymax") > ymin) & (ds.field("bbox", "ymin") < ymax))
    with ThreadPoolExecutor(32) as ex:
        parts = [t for t in ex.map(lambda fr: fr.to_table(filter=f, columns=columns),
                                   dataset.get_fragments()) if t.num_rows]
    table = pa.concat_tables(parts)
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, path)
    return table


def project(wkb):
    geoms = shapely.from_wkb(wkb)
    return shapely.transform(geoms, lambda c: np.column_stack(from_lonlat.transform(c[:, 0], c[:, 1])))


def fetch_tile(z, x, y):
    path = CACHE / "tiles" / f"{z}_{x}_{y}.png"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(4):
            try:
                with urllib.request.urlopen(TILE_URL.format(z=z, x=x, y=y), timeout=60) as r:
                    path.write_bytes(r.read())
                break
            except OSError:
                # Zoom 15 means hundreds of tiles per area, so ride out the odd dropped connection.
                if attempt == 3:
                    raise
                time.sleep(2 ** attempt)
    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.float64)
    return rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768


def sample_elevation(lon, lat, z=15):
    n = 2 ** z
    px = (lon + 180.0) / 360.0 * n
    lat_r = np.radians(lat)
    py = (1.0 - np.log(np.tan(lat_r) + 1.0 / np.cos(lat_r)) / math.pi) / 2.0 * n
    tx0, ty0, tx1, ty1 = int(px.min()), int(py.min()), int(px.max()), int(py.max())
    mosaic = np.vstack([np.hstack([fetch_tile(z, tx, ty) for tx in range(tx0, tx1 + 1)])
                        for ty in range(ty0, ty1 + 1)])
    px = (px - tx0) * 256 - 0.5
    py = (py - ty0) * 256 - 0.5
    ix = np.clip(np.floor(px).astype(int), 0, mosaic.shape[1] - 2)
    iy = np.clip(np.floor(py).astype(int), 0, mosaic.shape[0] - 2)
    fx, fy = px - ix, py - iy
    return (mosaic[iy, ix] * (1 - fx) * (1 - fy) + mosaic[iy, ix + 1] * fx * (1 - fy)
            + mosaic[iy + 1, ix] * (1 - fx) * fy + mosaic[iy + 1, ix + 1] * fx * fy)


def sea_bed(heights, d, spacing):
    """Sea floor depths (m, negative) that shelve smoothly away from the coast.

    The terrain tiles' bathymetry is blocky (hundreds of metres a step) with a flat -2 m strip
    along the shore, which the sea's depth tint and surf show as stair steps and seams. Use the
    deeper of a blurred version of it and a shelf falling to about 20 m within a kilometre.
    """
    blurred = gaussian_filter(np.clip(np.minimum(heights, -2.0), -200, -2), 400 / spacing, mode="nearest")
    shelf = -(2 + 18 * (1 - np.exp(np.minimum(d, 0) / 300)))
    return np.minimum(blurred, shelf)


# Largest height error (m) the ground mesh may make against the fine raster.
MESH_ERROR = 0.5


def write_mesh(heights, k, step, path, max_error=MESH_ERROR):
    """Writes the ground as an adaptive triangle mesh (see docs/coastal-cliffs.md).

    Greedy Delaunay refinement (Delatin) adds points until every fine sample is within
    max_error, so flat fields get big triangles and cliffs dense strips. Every k-th sample
    along the tile edge is forced in so the edge matches height.png and the skirt.

    ground.bin: uint32 vertex count n, uint32 triangle count t, float32 0; then uint16 column[n],
    uint16 row[n], int16 height[n] in quarter metres (fine raster samples, north-west origin);
    padding to 4 bytes; uint32 indices[3t], counter-clockwise seen from above.
    """
    import pydelatin

    rows, cols = heights.shape
    q = np.round(heights * 4) / 4
    tin = pydelatin.Delatin(q.astype(np.float32), width=cols, height=rows, max_error=max_error)
    verts = np.round(tin.vertices[:, :2]).astype(np.int64).tolist()
    index = {tuple(v): n for n, v in enumerate(verts)}

    def vertex(x, y):
        if (x, y) not in index:
            index[(x, y)] = len(verts)
            verts.append([x, y])
        return index[(x, y)]

    def split_point(a, b):
        """A k-th sample strictly inside a tile-edge segment a-b, or None."""
        (ax, ay), (bx, by) = verts[a], verts[b]
        if ax == bx and ax in (0, cols - 1):
            lo, hi, fixed, vertical = min(ay, by), max(ay, by), ax, True
        elif ay == by and ay in (0, rows - 1):
            lo, hi, fixed, vertical = min(ax, bx), max(ax, bx), ay, False
        else:
            return None
        m = round((lo + hi) / 2 / k) * k
        if m <= lo:
            m += k
        elif m >= hi:
            m -= k
        if not lo < m < hi:
            return None
        return vertex(fixed, m) if vertical else vertex(m, fixed)

    done, stack = [], tin.triangles.astype(np.int64).tolist()
    while stack:
        tri = stack.pop()
        for e in range(3):
            a, b, c = tri[e], tri[(e + 1) % 3], tri[(e + 2) % 3]
            m = split_point(a, b)
            if m is not None:
                stack += [[a, m, c], [m, b, c]]
                break
        else:
            done.append(tri)
    v = np.asarray(verts)
    t = np.asarray(done, dtype=np.uint32)
    # Wind counter-clockwise seen from above with x east and z (rows) south, as ground.ts does.
    p0, p1, p2 = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    up = (p1[:, 1] - p0[:, 1]) * (p2[:, 0] - p0[:, 0]) - (p1[:, 0] - p0[:, 0]) * (p2[:, 1] - p0[:, 1])
    t[up < 0] = t[up < 0][:, [0, 2, 1]]
    h = np.round(q[v[:, 1], v[:, 0]] * 4).astype("<i2")
    body = (struct.pack("<IIf", len(v), len(t), 0.0) + v[:, 0].astype("<u2").tobytes()
            + v[:, 1].astype("<u2").tobytes() + h.tobytes())
    body += b"\0" * (-len(body) % 4) + t.astype("<u4").tobytes()
    path.write_bytes(body)
    stats = {"step": float(step), "vertices": len(v), "triangles": len(t), "maxError": max_error}
    print(f"mesh: {len(v)} vertices, {len(t)} triangles (grid has {((rows - 1) // k + 1) * ((cols - 1) // k + 1)}),"
          f" {len(body) / 1e6:.1f} MB")
    return stats


def cliffness(heights, d, spacing, cliff_lines, raster, grid_index):
    """0 on low shores, 1 on cliffs, from the backshore height and OSM cliff lines."""
    r = BACKSHORE_M / spacing
    k = math.ceil(r)
    yy, xx = np.mgrid[-k:k + 1, -k:k + 1]
    back = maximum_filter(np.where(d > 0, heights, -1e6), footprint=xx ** 2 + yy ** 2 <= r * r, mode="nearest")
    c = np.clip((back - CLIFF_LOW_M) / (CLIFF_HIGH_M - CLIFF_LOW_M), 0, 1)
    c = c * c * (3 - 2 * c)
    if cliff_lines:
        # Mapped cliffs near the sea count as cliffs whatever the heights say.
        x0, y1, texel, cw, ch = raster
        mask = Raster(x0, y1, texel, cw, ch, 0)
        mask.hole_fill = 0
        for g in cliff_lines:
            mask.line(g, 1, texel)
        near = distance_transform_edt(np.asarray(mask.img) == 0)[grid_index] * texel
        c = np.maximum(c, ((near < 30) & (np.abs(d) < 80)).astype(float))
    # Smooth along the coast so the shore type never flips between neighbouring points.
    return np.clip(gaussian_filter(c, 25 / spacing), 0, 1)


class Raster:
    """Draws projected geometries onto the cover grid with PIL."""

    def __init__(self, x0, y1, texel, width, height, fill):
        self.x0, self.y1, self.texel = x0, y1, texel
        self.img = Image.new("L", (width, height), fill)
        self.draw = ImageDraw.Draw(self.img)

    def px(self, coords):
        c = np.asarray(coords)
        return list(zip((c[:, 0] - self.x0) / self.texel, (self.y1 - c[:, 1]) / self.texel))

    def polygon(self, geom, value):
        for poly in getattr(geom, "geoms", [geom]):
            if poly.geom_type != "Polygon" or poly.is_empty:
                continue
            self.draw.polygon(self.px(poly.exterior.coords), fill=value)
            # Holes go back to whatever was underneath only approximately: fill them with
            # a neutral class so courtyards in woods and lakes in fields stay open.
            for hole in poly.interiors:
                self.draw.polygon(self.px(hole.coords), fill=self.hole_fill)

    def line(self, geom, value, width_m):
        w = max(1, round(width_m / self.texel))
        for line in getattr(geom, "geoms", [geom]):
            if line.geom_type == "LineString":
                self.draw.line(self.px(line.coords), fill=value, width=w, joint="curve")
            elif line.geom_type == "Polygon":
                self.polygon(line, value)


ROAD_WIDTHS = {
    "motorway": (13, 18), "trunk": (13, 14), "primary": (13, 11), "secondary": (13, 9),
    "tertiary": (12, 8), "residential": (12, 6), "unclassified": (12, 5), "living_street": (12, 5),
    "service": (12, 4), "track": (16, 3), "footway": (16, 2), "path": (16, 2), "cycleway": (16, 2),
    "bridleway": (16, 2),
}

# Heights in metres when Overture has neither height nor num_floors.
CLASS_HEIGHTS = {
    "house": 6.5, "detached": 7, "semidetached_house": 7, "terrace": 7.5, "residential": 7,
    "bungalow": 4, "apartments": 13, "garage": 2.8, "garages": 2.8, "shed": 2.5, "hut": 2.5,
    "retail": 8, "commercial": 10, "office": 14, "industrial": 9, "warehouse": 9,
    "church": 14, "cathedral": 25, "school": 8, "university": 14, "hospital": 16,
    "hotel": 15, "farm_auxiliary": 6, "barn": 7, "greenhouse": 3, "civic": 10, "public": 10,
}
RESIDENTIAL = {"house", "detached", "semidetached_house", "terrace", "residential", "bungalow", None}


def building_height(row, area):
    if row["height"] is not None and row["height"] > 1:
        return float(row["height"])
    if row["num_floors"] is not None and row["num_floors"] > 0:
        return row["num_floors"] * 3.0 + 1.0
    if row["class"] in CLASS_HEIGHTS:
        return CLASS_HEIGHTS[row["class"]]
    return 3.0 if area < 40 else 6.5 if area < 250 else 9.0


class LidarHeights:
    """Building heights measured from the Environment Agency lidar (fetch_external.py), England.

    The 90th percentile of height above ground (first-return DSM minus DTM) inside the
    footprint shrunk by 1 m, so walls, eaves and overhanging trees at the edge don't count.
    """

    def __init__(self, area_name):
        self.src = None
        path = EXTERNAL / f"{area_name}_ndsm.tif"
        if path.exists():
            import rasterio
            self.src = rasterio.open(path)
            self.data = self.src.read(1)
            self.to_bng = Transformer.from_crs(PROJ, "EPSG:27700", always_xy=True)

    def height(self, footprint):
        if self.src is None:
            return None
        g = shapely.transform(footprint, lambda c: np.column_stack(self.to_bng.transform(c[:, 0], c[:, 1])))
        inner = g.buffer(-1.0)
        if inner.is_empty:
            inner = g
        x0, y0, x1, y1 = inner.bounds
        r0, c0 = self.src.index(x0, y1)
        r1, c1 = self.src.index(x1, y0)
        r0, c0 = max(r0, 0), max(c0, 0)
        r1, c1 = min(r1 + 1, self.data.shape[0]), min(c1 + 1, self.data.shape[1])
        if r1 <= r0 or c1 <= c0:
            return None
        win = self.data[r0:r1, c0:c1]
        res = self.src.res[0]
        ys = self.src.bounds.top - (np.arange(r0, r1) + 0.5) * res
        xs = self.src.bounds.left + (np.arange(c0, c1) + 0.5) * res
        px, py = np.meshgrid(xs, ys)
        inside = shapely.contains_xy(inner, px, py) & (win >= 0)
        if inside.sum() < 3:
            return None
        h = float(np.percentile(win[inside], 90)) / 10
        return h if 2.0 <= h <= 250 else None


def main(area_name):
    cfg = AREAS[area_name]
    bbox, spacing, texel = cfg["bbox"], cfg["spacing"], cfg["texel"]
    out = ROOT / "public" / "data" / "detail" / area_name
    out.mkdir(parents=True, exist_ok=True)

    # Grid in LAEA covering the lon/lat box, snapped to the spacing.
    cx, cy = from_lonlat.transform([bbox[0], bbox[2], bbox[0], bbox[2]], [bbox[1], bbox[1], bbox[3], bbox[3]])
    x0 = math.ceil(max(cx[0], cx[2]) / spacing) * spacing
    x1 = math.floor(min(cx[1], cx[3]) / spacing) * spacing
    y0 = math.ceil(max(cy[0], cy[1]) / spacing) * spacing
    y1 = math.floor(min(cy[2], cy[3]) / spacing) * spacing
    xs = np.arange(x0, x1 + spacing, spacing)
    ys = np.arange(y1, y0 - spacing, -spacing)
    # Heights are worked out on a fine raster, which the ground mesh is built from; the grid
    # (height.png) is every k-th sample of it.
    step = cfg["fine"]
    k = spacing // step
    fxs = np.arange(x0, x1 + step, step)
    fys = np.arange(y1, y0 - step, -step)
    gx, gy = np.meshgrid(fxs, fys)
    lon, lat = (np.asarray(a) for a in to_lonlat.transform(gx, gy))
    heights = sample_elevation(lon, lat)
    del lon, lat
    print("heights", heights.shape, heights.min(), heights.max())

    # --- Land cover ---------------------------------------------------------
    cw, ch = round((x1 - x0) / texel), round((y1 - y0) / texel)
    land = overture("base", "land", bbox, ["subtype", "class", "geometry"], area_name)
    land_geoms = project(land["geometry"].to_numpy(zero_copy_only=False))
    land_sub = land["subtype"].to_pylist()
    land_cls = land["class"].to_pylist()
    has_coast = any(s == "land" for s in land_sub)
    C = CLASSES
    r = Raster(x0, y1, texel, cw, ch, C["sea"] if has_coast else C["fields"])
    r.hole_fill = C["fields"]
    for g, s in zip(land_geoms, land_sub):
        if s == "land":
            r.polygon(g, C["fields"])
    if has_coast:
        sea_mask = np.asarray(r.img) == C["sea"]

    cover = overture("base", "land_cover", bbox, ["subtype", "cartography", "geometry"], area_name)
    fine = [c["min_zoom"] >= 8 for c in cover["cartography"].to_pylist()]
    cover_map = {"urban": C["urban"], "forest": C["broadleaf"], "shrub": UPLAND_SHRUB, "barren": C["rock"],
                 "wetland": C["wetland"], "grass": C["fields"], "crop": C["fields"], "moss": C["heath"]}
    for g, s, f in zip(project(cover["geometry"].to_numpy(zero_copy_only=False)), cover["subtype"].to_pylist(), fine):
        if f and s in cover_map:
            r.polygon(g, cover_map[s])

    use = overture("base", "land_use", bbox, ["subtype", "class", "geometry"], area_name)
    use_map = {"residential": C["urban"], "developed": C["industrial"], "park": C["park"],
               "recreation": C["park"], "golf": C["park"], "cemetery": C["park"], "managed": C["park"],
               "horticulture": C["park"], "agriculture": C["fields"], "resource_extraction": C["rock"],
               "education": C["urban"], "medical": C["urban"], "military": C["fields"],
               "transportation": C["industrial"]}
    for g, s, c in zip(project(use["geometry"].to_numpy(zero_copy_only=False)), use["subtype"].to_pylist(), use["class"].to_pylist()):
        if c == "farmyard":
            r.polygon(g, C["farmyard"])
        elif s in use_map:
            r.polygon(g, use_map[s])

    land_map = {("forest", "forest"): C["conifer"], ("forest", "wood"): C["broadleaf"],
                ("shrub", "heath"): C["heath"], ("shrub", "scrub"): C["heath"], ("rock", "bare_rock"): C["rock"],
                ("rock", "scree"): C["rock"], ("sand", "sand"): C["sand"], ("sand", "beach"): C["sand"],
                ("wetland", "wetland"): C["wetland"], ("grass", "grassland"): C["fields"]}
    for g, s, c in zip(land_geoms, land_sub, land_cls):
        if (s, c) in land_map:
            r.polygon(g, land_map[(s, c)])

    water = overture("base", "water", bbox, ["subtype", "class", "geometry"], area_name)
    for g, s, c in zip(project(water["geometry"].to_numpy(zero_copy_only=False)), water["subtype"].to_pylist(), water["class"].to_pylist()):
        if c == "swimming_pool":
            continue
        value = C["sea"] if s in ("ocean", "physical") and has_coast else C["water"]
        if g.geom_type in ("Polygon", "MultiPolygon"):
            r.polygon(g, value)
        else:
            r.line(g, C["water"], 12 if s == "river" else 3)

    roads = overture("transportation", "segment", bbox, ["subtype", "class", "geometry"], area_name)
    order = sorted(zip(project(roads["geometry"].to_numpy(zero_copy_only=False)), roads["subtype"].to_pylist(), roads["class"].to_pylist()),
                   key=lambda t: ROAD_WIDTHS.get(t[2], (0, 0))[1])
    # Narrow roads first so wider ones draw over them at junctions.
    for g, s, c in order:
        if s == "rail":
            r.line(g, C["rail"], 5)
        elif c in ROAD_WIDTHS and s == "road":
            value, width = ROAD_WIDTHS[c]
            r.line(g, value, width)

    cover_arr = np.asarray(r.img).copy()
    # ESA WorldCover calls a lot of hedged lowland pasture "shrub"; only treat it as
    # heath or moorland on high ground. Woods on high ground are mostly conifer plantations.
    cj, ci = np.mgrid[0:ch, 0:cw]
    hj = np.clip((cj * texel / step).astype(int), 0, len(fys) - 1)
    hi = np.clip((ci * texel / step).astype(int), 0, len(fxs) - 1)
    high = heights[hj, hi] > UPLAND_M
    shrub = cover_arr == UPLAND_SHRUB
    cover_arr[shrub] = np.where(high[shrub], C["heath"], C["fields"])
    esa_wood = cover_arr == C["broadleaf"]
    cover_arr[esa_wood & high] = C["conifer"]
    # Official woodland and habitat maps, where fetched, override the generic land cover on
    # natural ground: real forest types (incl. clear-fell and young plantations) from the
    # National Forest Inventory, then heath and bog from Natural England's habitat inventory.
    natural = [C[k] for k in ("fields", "park", "broadleaf", "conifer", "heath", "rock", "wetland")]
    for kind, table in (("phi", PHI_TYPES), ("nfi", NFI_TYPES)):
        feats = external_features(area_name, kind, table)
        if not feats:
            continue
        overlay = Raster(x0, y1, texel, cw, ch, 255)
        overlay.hole_fill = 255
        for g, cls in feats:
            overlay.polygon(g, C[cls])
        ov = np.asarray(overlay.img)
        put = (ov != 255) & np.isin(cover_arr, natural)
        cover_arr[put] = ov[put]
        print(f"{kind}: {len(feats)} polygons, {put.mean():.1%} of the area")
    if has_coast:
        # Keep the coastline authoritative over land-use and harbour polygons that spill into the sea.
        spill = sea_mask & ~np.isin(cover_arr, [C["sand"], C["major_road"], C["minor_road"], C["rail"]])
        cover_arr[spill] = C["sea"]
    Image.fromarray(cover_arr, "L").save(out / "cover.png", optimize=True)

    # Force the heightmap to agree with the coastline, sampled at grid points.
    gi = np.clip(((gx - x0) / texel).astype(int), 0, cw - 1)
    gj = np.clip(((y1 - gy) / texel).astype(int), 0, ch - 1)
    grid_cover = cover_arr[gj, gi]
    if has_coast:
        # Signed distance to the coast (m, positive on land) from the fine cover raster,
        # so the 0 m contour, and with it the waterline, follows the coast smoothly
        # between grid points instead of stepping from vertex to vertex.
        sea = cover_arr == C["sea"]
        signed = (distance_transform_edt(~sea) - distance_transform_edt(sea)) * texel
        d = signed[gj, gi]
        heights = np.where(d > 0, heights, sea_bed(heights, d, step))
        far = np.where(d > 0, np.maximum(heights, 0.5), np.minimum(heights, -2.0))
        t = np.clip((np.abs(d) - 20) / 20, 0, 1)
        shore = d * 0.08 * (1 - t) + far * t
        # On cliffs keep the measured heights, only pushing the sea side under water so the
        # face drops straight in at the mapped coastline (see docs/coastal-cliffs.md).
        cliff_lines = [g for g, s, c in zip(land_geoms, land_sub, land_cls) if s == "physical" and c == "cliff"]
        c = cliffness(heights, d, step, cliff_lines, (x0, y1, texel, cw, ch), (gj, gi))
        heights = shore * (1 - c) + far * c
        coast_cells = np.abs(d) < 2 * spacing
        coast_stats = {"cliffShare": round(float((c[coast_cells] > 0.5).mean()), 3) if coast_cells.any() else 0}
        print("coast", coast_stats)
    mesh = write_mesh(heights, k, step, out / "ground.bin")
    grid = heights[::k, ::k]
    assert grid.shape == (len(ys), len(xs))
    v = np.round(grid * 4) / 4 + 32768
    rr = np.floor(v / 256)
    gg = np.floor(v - rr * 256)
    bb = np.round((v - rr * 256 - gg) * 256)
    Image.fromarray(np.stack([rr, gg, bb], -1).astype(np.uint8), "RGB").save(out / "height.png", optimize=True)

    def height_at(x, y):
        fx = np.clip((x - x0) / step, 0, len(fxs) - 1.001)
        fy = np.clip((y1 - y) / step, 0, len(fys) - 1.001)
        i, j = int(fx), int(fy)
        a, b = fx - i, fy - j
        return float(heights[j, i] * (1 - a) * (1 - b) + heights[j, i + 1] * a * (1 - b)
                     + heights[j + 1, i] * (1 - a) * b + heights[j + 1, i + 1] * a * b)

    # --- Buildings ----------------------------------------------------------
    bt = overture("buildings", "building", bbox,
                  ["height", "num_floors", "class", "sources", "geometry"], area_name)
    rows = bt.select(["height", "num_floors", "class"]).to_pylist()
    geoms = project(bt["geometry"].to_numpy(zero_copy_only=False))
    stats = {"total": len(rows), "osm": 0, "osm_levels": 0, "osm_height": 0, "ml": 0}
    for s, row in zip(bt["sources"].to_pylist(), rows):
        if s[0]["dataset"] == "OpenStreetMap":
            stats["osm"] += 1
            stats["osm_levels"] += row["num_floors"] is not None
            stats["osm_height"] += row["height"] is not None
        else:
            stats["ml"] += 1
    lidar = LidarHeights(area_name)
    stats["lidar"] = 0
    buf = bytearray()
    count = 0
    osm = [src[0]["dataset"] == "OpenStreetMap" for src in bt["sources"].to_pylist()]
    for g, row, from_osm in zip(geoms, rows, osm):
        if g.geom_type == "MultiPolygon":
            g = max(g.geoms, key=lambda p: p.area)
        if g.geom_type != "Polygon" or g.area < 8:
            continue
        c = g.centroid
        if not (x0 <= c.x <= x1 and y0 <= c.y <= y1):
            continue
        measured = None if from_osm and row["height"] is not None and row["height"] > 1 else lidar.height(g)
        estimate = building_height(row, g.area)
        # Garden trees over small houses, or footprints off the lidar by a metre or two, read as
        # 15-25 m "houses": keep the estimate when a small building measures far above it.
        if measured is not None and g.area < 300 and measured > 2 * estimate:
            measured = None
            stats["lidar_rejected"] = stats.get("lidar_rejected", 0) + 1
        h = measured if measured is not None else estimate
        stats["lidar"] += measured is not None
        roof = 0
        ring = g.simplify(0.4)
        rect = g.minimum_rotated_rectangle
        house = row["class"] in RESIDENTIAL and 25 < g.area < 300 and g.area / max(rect.area, 1e-6) > 0.82
        if house and measured is not None:
            # Lidar's 90th percentile is near the ridge, but the renderer takes h as the eave and
            # adds the gable (min(0.45 × short side, 4.5 m), src/detail/buildings.ts) on top.
            edges = np.diff(np.asarray(rect.exterior.coords)[:3], axis=0)
            gable = min(0.45 * float(np.linalg.norm(edges, axis=1).min()), 4.5)
            if measured - gable < 12:
                h = max(measured - gable, 2.5)
        if house and h < 12:
            ring, roof = rect, 1  # simple house: gable roof on its oriented rectangle
        coords = np.asarray(ring.exterior.coords)[:-1]
        if not ring.exterior.is_ccw:
            coords = coords[::-1]
        if len(coords) < 3:
            continue
        base = min(height_at(x, y) for x, y in coords)
        buf += struct.pack("<HBBff", len(coords), roof, 0, h, base)
        buf += (coords - [x0, y1]).astype("<f4").tobytes()
        count += 1
    (out / "buildings.bin").write_bytes(bytes(buf))

    # --- Individually mapped trees -----------------------------------------
    tree_xy = [g for g, s, c in zip(land_geoms, land_sub, land_cls) if s == "tree" and c == "tree" and g.geom_type == "Point"]
    tbuf = bytearray()
    for p in tree_xy:
        if x0 <= p.x <= x1 and y0 <= p.y <= y1:
            tbuf += struct.pack("<fff", p.x - x0, p.y - y1, height_at(p.x, p.y))
    (out / "trees.bin").write_bytes(bytes(tbuf))

    # Keys written by the other build scripts (imagery, masses, boundaries, roads) survive a rebuild.
    old = json.loads((out / "meta.json").read_text()) if (out / "meta.json").exists() else {}
    meta = {
        "proj": PROJ, "xMin": x0, "xMax": x1, "yMin": y0, "yMax": y1,
        "spacing": spacing, "width": len(xs), "height": len(ys),
        "coverTexel": texel, "coverWidth": cw, "coverHeight": ch,
        "minHeight": float(heights.min()), "maxHeight": float(heights.max()),
        "buildings": count, "buildingStats": stats, "trees": len(tbuf) // 12,
        "mesh": mesh, "hasCoast": has_coast, **({"coast": coast_stats} if has_coast else {}), "classes": CLASSES,
        "attribution": "Overture Maps Foundation (incl. © OpenStreetMap contributors, ESA WorldCover, Microsoft); AWS Terrain Tiles",
    }
    extra = []
    if lidar.src is not None:
        extra.append("Environment Agency LIDAR Composite 2022 (© Environment Agency copyright and/or database right 2022)")
    if (EXTERNAL / f"{area_name}_nfi.geojson").exists():
        extra.append("National Forest Inventory © Forestry Commission")
    if (EXTERNAL / f"{area_name}_phi.geojson").exists():
        extra.append("Priority Habitats Inventory © Natural England")
    if extra:
        meta["attribution"] += "; " + "; ".join(extra) + " (Open Government Licence v3.0)"
    if "imagery" in old:
        meta["attribution"] += "; Contains modified Copernicus Sentinel data"
    meta.update({k: v for k, v in old.items() if k not in meta})
    (out / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(json.dumps(meta))


if __name__ == "__main__":
    main(sys.argv[1])

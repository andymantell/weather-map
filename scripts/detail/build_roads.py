"""Build the road network for one detailed area as centrelines (OpenStreetMap via Overture).

Writes public/data/detail/<area>/roads.bin, which src/detail/roads.ts draws as ribbons on
the terrain with markings, so close up roads are crisp instead of the ragged edges of the
4 m cover raster. Tunnels are left out; bridges are flagged so their deck runs straight
between its ends instead of dipping into the valley.

Format, little-endian: per piece `<HBBf` (point count, class, flags, width m) then float32
x, z pairs every ~4 m in local scene metres (x east from xMin, z south from yMax).
Flags: 1 bridge, 2 unpaved. Classes are CLASSES below.

Run build_area.py for the area first. Usage: python3 scripts/detail/build_roads.py plymouth
"""

import json
import os
import struct
import sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pyarrow as pa
import pyarrow.dataset as ds
import pyarrow.fs as pafs
import pyarrow.parquet as pq
import shapely

import build_area as ba

CLASSES = {
    "motorway": 0, "trunk": 1, "primary": 2, "secondary": 3, "tertiary": 4,
    "residential": 5, "unclassified": 5, "living_street": 5, "service": 6,
    "track": 7, "footway": 8, "path": 8, "cycleway": 8, "bridleway": 8, "steps": 8, "pedestrian": 8,
}
# Default carriageway widths (m) per class when OSM has none.
# Default width (m) of each OSM class when the way has no width tag. UK OSM maps motorways and
# most dual carriageways as one line per carriageway, so these are per line: a motorway line is
# three 3.65 m lanes plus a 3.3 m hard shoulder (DMRB CD 127), a single carriageway A road two
# 3.65 m lanes, residential streets about 5.5 m (local design guides give 4.1 to 5.5 m), and
# unclassified roads are mostly narrow rural lanes.
WIDTHS = {
    "motorway": 14, "trunk": 8.5, "primary": 7.3, "secondary": 6.5, "tertiary": 6,
    "residential": 5.5, "living_street": 4.8, "unclassified": 4.5, "service": 3.5,
    "track": 2.8, "footway": 1.8, "path": 1.5, "cycleway": 2, "bridleway": 2,
    "steps": 1.5, "pedestrian": 4,
}
STEP = 4.0
COLUMNS = ["subtype", "class", "road_flags", "road_surface", "width_rules", "geometry"]


def segments(area, bbox):
    path = ba.CACHE / f"{area}_roads.parquet"
    if path.exists():
        return pq.read_table(path)
    fs = pafs.S3FileSystem(
        anonymous=True, region="us-west-2",
        proxy_options=os.environ.get("HTTPS_PROXY") or None,
        tls_ca_file_path=os.environ.get("SSL_CERT_FILE") or None,
    )
    dataset = ds.dataset(f"{ba.OVERTURE}/theme=transportation/type=segment/", filesystem=fs, format="parquet")
    xmin, ymin, xmax, ymax = bbox
    f = ((ds.field("bbox", "xmax") > xmin) & (ds.field("bbox", "xmin") < xmax)
         & (ds.field("bbox", "ymax") > ymin) & (ds.field("bbox", "ymin") < ymax)
         & (ds.field("subtype") == "road"))
    with ThreadPoolExecutor(32) as ex:
        parts = [t for t in ex.map(lambda fr: fr.to_table(filter=f, columns=COLUMNS), dataset.get_fragments()) if t.num_rows]
    table = pa.concat_tables(parts)
    pq.write_table(table, path)
    return table


def ranges(rules, wanted):
    """Fractions [a, b] of the segment where any rule value is in `wanted`."""
    out = []
    for r in rules or []:
        values = r.get("values") or [r.get("value")]
        if any(v in wanted for v in values):
            between = r.get("between") or [0.0, 1.0]
            out.append((between[0], between[1]))
    return out


def main(area):
    cfg = ba.AREAS[area]
    out = ba.ROOT / "public" / "data" / "detail" / area
    meta = json.loads((out / "meta.json").read_text())
    table = segments(area, cfg["bbox"]).to_pylist()
    geoms = ba.project(np.array([r["geometry"] for r in table], dtype=object))
    size = (meta["xMax"] - meta["xMin"], meta["yMax"] - meta["yMin"])
    pieces = []
    for row, line in zip(table, geoms):
        cls = CLASSES.get(row["class"])
        if cls is None or line.geom_type != "LineString":
            continue
        tunnels = ranges(row["road_flags"], {"is_tunnel"})
        bridges = ranges(row["road_flags"], {"is_bridge"})
        unpaved = bool(ranges(row["road_surface"], {"unpaved", "gravel", "dirt"})) or cls == 7
        width = WIDTHS[row["class"]]
        for w in row["width_rules"] or []:
            if w.get("value") and 1 < w["value"] < 40:
                width = w["value"]
        # Cut at every flag boundary so each piece is all bridge or all ground.
        cuts = sorted({0.0, 1.0, *[t for r in tunnels + bridges for t in r]})
        for a, b in zip(cuts, cuts[1:]):
            mid = (a + b) / 2
            if b - a < 1e-6 or any(s <= mid <= e for s, e in tunnels):
                continue
            bridge = any(s <= mid <= e for s, e in bridges)
            part = shapely.ops.substring(line, a, b, normalized=True) if (a, b) != (0.0, 1.0) else line
            if part.length < 1:
                continue
            d = np.linspace(0, part.length, max(int(np.ceil(part.length / STEP)), 1) + 1)
            pts = shapely.get_coordinates(shapely.line_interpolate_point(part, d))
            x = pts[:, 0] - meta["xMin"]
            z = meta["yMax"] - pts[:, 1]
            inside = (x > -50) & (z > -50) & (x < size[0] + 50) & (z < size[1] + 50)
            if not inside.any():
                continue
            pieces.append((cls, (1 if bridge else 0) | (2 if unpaved else 0), width,
                           np.column_stack([x, z]).astype(np.float32)))
    # Narrow first, so wider roads draw over them where they meet.
    pieces.sort(key=lambda p: p[2])
    with open(out / "roads.bin", "wb") as f:
        for cls, flags, width, pts in pieces:
            for i in range(0, len(pts) - 1, 65000):
                chunk = pts[i:i + 65001]
                f.write(struct.pack("<HBBf", len(chunk), cls, flags, width))
                f.write(chunk.tobytes())
    km = sum(float(np.linalg.norm(np.diff(p[3], axis=0), axis=1).sum()) for p in pieces) / 1000
    meta["roads"] = {"pieces": len(pieces), "km": round(km, 1)}
    (out / "meta.json").write_text(json.dumps(meta, indent=2))
    print(area, meta["roads"])


if __name__ == "__main__":
    import shapely.ops  # noqa: F401
    main(sys.argv[1])

"""Bake simplified building masses that follow a town's real shape.

Footprints are merged with a morphological closing (grow by r, union, shrink by r),
so terraces and neighbouring houses fuse into street-long blocks, then the street
network is cut back out so roads stay open. Each mass gets the area-weighted mean
height of the buildings inside it. A larger r gives coarser masses for farther views.

Reads the Overture data cached by build_area.py and writes
public/data/detail/<area>/masses-<r>.bin:

    per mass: uint16 ring count, uint8 0, uint8 0, float32 height
    per ring: uint16 vertex count, uint16 0, then float32 x, y pairs (metres from the
              area's xMin, yMax), outer ring first and counter-clockwise, holes after.

Usage: python3 scripts/detail/build_masses.py plymouth
"""

import json
import struct
import sys

import numpy as np
import shapely
from shapely.strtree import STRtree

from build_area import LidarHeights, area, building_height, overture, project

# Closing radius (m) for each level of detail.
LEVELS = (10, 18)

# Half-widths (m) of the street cut per road class at the finest level; coarser levels
# cut wider so streets still read from farther away.
ROAD_CUT = {
    "motorway": 12, "trunk": 10, "primary": 8, "secondary": 7, "tertiary": 6,
    "residential": 4, "unclassified": 4, "living_street": 3.5,
}


def main(area_name):
    cfg = area(area_name)
    bbox, out = cfg["bbox"], cfg["out"]
    meta = json.loads((out / "meta.json").read_text())
    x0, y1 = meta["xMin"], meta["yMax"]
    clip = shapely.box(meta["xMin"], meta["yMin"], meta["xMax"], meta["yMax"])

    bt = overture("buildings", "building", bbox, ["height", "num_floors", "class", "sources", "geometry"], area_name)
    rows = bt.select(["height", "num_floors", "class"]).to_pylist()
    geoms = project(bt["geometry"].to_numpy(zero_copy_only=False))
    keep = [i for i, g in enumerate(geoms) if g.geom_type in ("Polygon", "MultiPolygon") and g.area >= 8]
    foot = shapely.make_valid(geoms[keep])
    # Same precedence as build_area.py: OSM height tag, then lidar, then the estimate.
    lidar = LidarHeights(area_name)
    osm = [s[0]["dataset"] == "OpenStreetMap" for s in bt["sources"].to_pylist()]

    def height(i):
        row = rows[i]
        if not (osm[i] and row["height"] is not None and row["height"] > 1):
            measured = lidar.height(geoms[i])
            estimate = building_height(row, geoms[i].area)
            # As in build_area.py: small buildings measured far above the estimate are trees.
            if measured is not None and not (geoms[i].area < 300 and measured > 2 * estimate):
                return measured
            return estimate
        return building_height(row, geoms[i].area)

    heights = np.array([height(i) for i in keep])
    areas = shapely.area(foot)
    centroids = shapely.centroid(foot)
    tree = STRtree(centroids)

    roads = overture("transportation", "segment", bbox, ["subtype", "class", "geometry"], area_name)
    road_geoms = project(roads["geometry"].to_numpy(zero_copy_only=False))
    road_cls = roads["class"].to_pylist()
    road_sub = roads["subtype"].to_pylist()

    for r in LEVELS:
        widen = r / LEVELS[0]
        cuts = [shapely.buffer(g, ROAD_CUT[c] * widen, cap_style="flat")
                for g, c, s in zip(road_geoms, road_cls, road_sub)
                if s == "road" and c in ROAD_CUT]
        streets = shapely.union_all(cuts)
        merged = shapely.union_all(shapely.buffer(foot, r, quad_segs=2))
        merged = shapely.buffer(merged, -r, quad_segs=2)
        merged = shapely.difference(merged, streets)
        merged = shapely.intersection(merged, clip)
        parts = shapely.get_parts(merged)
        parts = shapely.simplify(parts, r * 0.25)
        buf = bytearray()
        count = 0
        for p in parts:
            if p.geom_type != "Polygon" or p.area < 60:
                continue
            p = shapely.orient_polygons(p)
            idx = tree.query(p, predicate="contains")
            if len(idx):
                h = float(np.average(heights[idx], weights=areas[idx]))
            else:
                h = 6.0
            rings = [p.exterior] + [i for i in p.interiors if shapely.Polygon(i).area > 40]
            buf += struct.pack("<HBBf", len(rings), 0, 0, h)
            for ring in rings:
                c = np.asarray(ring.coords)[:-1]
                buf += struct.pack("<HH", len(c), 0)
                buf += (c - [x0, y1]).astype("<f4").tobytes()
            count += 1
        (out / f"masses-{r}.bin").write_bytes(bytes(buf))
        print(f"r={r} m: {count} masses from {len(keep)} footprints, {len(buf) / 1e6:.2f} MB")


if __name__ == "__main__":
    main(sys.argv[1])

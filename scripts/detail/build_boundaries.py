"""Build the field boundaries (hedges and dry-stone walls) for one detailed area.

Writes public/data/detail/<area>/boundaries.bin from OpenStreetMap via Overture Maps:
mapped hedges (barrier=hedge) and walls (barrier=wall), plus the outlines of mapped
farmland and meadow where no hedge or wall is mapped along them, since in Devon nearly
every field edge is a hedge bank and in the Cheviots a wall. Lines are cut where they
cross roads, buildings' land, water or the sea (from the area's cover.png), so none run
down a street.

Format, little-endian: per line `<HBB` (point count, kind 0 hedge / 1 wall, 0) then
float32 x, z pairs in local scene metres (x east from xMin, z south from yMax).

Run build_area.py for the area first. Usage: python3 scripts/detail/build_boundaries.py plymouth
"""

import json
import struct
import sys

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import shapely
from PIL import Image

import build_area as ba

# Kind given to mapped field outlines with no hedge or wall along them.
FIELD_EDGE = {"plymouth": 0, "kielder": 1}
STEP = 4.0  # metres between points
# Cover classes a boundary may not run through.
BLOCKED = {ba.CLASSES[c] for c in ("sea", "water", "urban", "industrial", "minor_road", "major_road", "rail")}


def lines_of(geoms):
    out = []
    for g in geoms:
        for part in getattr(g, "geoms", [g]):
            if part.geom_type == "Polygon":
                out.append(part.exterior)
                out.extend(part.interiors)
            elif part.geom_type in ("LineString", "LinearRing"):
                out.append(part)
    return out


def main(area):
    cfg = ba.AREAS[area]
    out = ba.ROOT / "public" / "data" / "detail" / area
    meta = json.loads((out / "meta.json").read_text())
    bbox = cfg["bbox"]
    infra = ba.overture("base", "infrastructure", bbox, ["subtype", "class", "geometry"], area)
    use = ba.overture("base", "land_use", bbox, ["subtype", "class", "geometry"], area)

    def project(table):
        return ba.project(table.column("geometry").to_numpy(zero_copy_only=False))

    hedges = lines_of(project(infra.filter(pc.equal(infra.column("class"), "hedge"))))
    walls = lines_of(project(infra.filter(pc.equal(infra.column("class"), "wall"))))
    fields = use.filter(pc.is_in(use.column("class"), value_set=pa.array(["farmland", "meadow"])))
    edges = lines_of(project(fields))
    mapped = shapely.union_all(hedges + walls).buffer(6.0) if hedges or walls else None
    edge_lines = [e if mapped is None else shapely.difference(shapely.LineString(e.coords), mapped) for e in edges]
    # Shared edges between neighbouring fields appear twice: merge them.
    edge_union = shapely.line_merge(shapely.union_all([g for g in edge_lines if not g.is_empty])) if edge_lines else None

    cover = np.asarray(Image.open(out / "cover.png"))
    texel = meta["coverTexel"]
    blocked = np.isin(cover, list(BLOCKED))

    def runs(line, kind):
        """Points every STEP m in local coordinates, split where the line is blocked."""
        length = line.length
        if length < STEP:
            return []
        d = np.linspace(0, length, max(int(length / STEP), 1) + 1)
        pts = shapely.get_coordinates(shapely.line_interpolate_point(line, d))
        x = pts[:, 0] - meta["xMin"]
        z = meta["yMax"] - pts[:, 1]
        i = np.clip((x / texel).astype(int), 0, cover.shape[1] - 1)
        j = np.clip((z / texel).astype(int), 0, cover.shape[0] - 1)
        inside = (x >= 0) & (z >= 0) & (x <= meta["xMax"] - meta["xMin"]) & (z <= meta["yMax"] - meta["yMin"])
        ok = inside & ~blocked[j, i]
        out, start = [], None
        for k in range(len(ok) + 1):
            if k < len(ok) and ok[k]:
                start = k if start is None else start
            elif start is not None:
                if k - start >= 3:
                    out.append((kind, np.column_stack([x[start:k], z[start:k]]).astype(np.float32)))
                start = None
        return out

    result = []
    for line in hedges:
        result += runs(line, 0)
    for line in walls:
        result += runs(line, 1)
    if edge_union is not None:
        for line in getattr(edge_union, "geoms", [edge_union]):
            result += runs(line, FIELD_EDGE[area])
    with open(out / "boundaries.bin", "wb") as f:
        for kind, pts in result:
            f.write(struct.pack("<HBB", len(pts), kind, 0))
            f.write(pts.tobytes())
    total = {0: 0.0, 1: 0.0}
    for kind, pts in result:
        total[kind] += float(np.linalg.norm(np.diff(pts, axis=0), axis=1).sum())
    meta["boundaries"] = {"hedgeKm": round(total[0] / 1000, 1), "wallKm": round(total[1] / 1000, 1)}
    (out / "meta.json").write_text(json.dumps(meta, indent=2))
    print(area, len(result), "lines", meta["boundaries"])


if __name__ == "__main__":
    main(sys.argv[1])

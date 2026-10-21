# Coastal cliffs and estuaries in the detailed terrain

Research for terrain bake question 6 (`docs/terrain-bake-handoff.md`): heights near the coast
use a signed-distance shoreline in `scripts/detail/build_area.py`. Does it flatten real cliffs,
and how should cliffs (and large estuaries) be handled in the UK-wide bake?

Nothing in the build or the app has been changed. Measurements below come from scratch scripts
run in the cloud container on 2026-10-21.

## Summary

- **Yes, the current shoreline flattens cliffs, badly.** Within 20 m of the mapped coastline the
  build sets height to `0.08 × distance`, so land there is at most 1.6 m high, and it ramps to the
  real height only by 40 m inland. On the north Cornwall coast, points along OSM cliff lines that
  are within 60 m of the coastline have a median height of about 25 m in the source data and
  **2.4 m after the blend**; 59% end up under 5 m.
- **The height source is also too coarse.** The build samples AWS Terrain Tiles at zoom 13
  (about 12 m pixels at 50°N). In England the same tiles at zoom 15 already carry the
  Environment Agency 2 m LIDAR composite that Mapzen built them from, and cliffs come out roughly
  twice as steep.
- **A 20 m regular grid cannot hold a cliff anyway.** At Tintagel the 20 m grid is off by 5 m on
  average on cliff faces (15 m at the 95th percentile). An adaptive triangle mesh built from the
  fine data gets every point within 1 m using only 1.45× the vertices of the 20 m grid.
- **Recommendation:** (1) make the shoreline cliff-aware, (2) read heights from national LIDAR
  where it exists, Copernicus GLO-30 elsewhere, (3) build each tile's ground as an adaptive
  triangle mesh instead of a regular grid, and (4) shade steep faces as rock with triplanar
  texturing. Estuaries use the same rules, plus a proper intertidal class for mud and sand flats.
  Details and a staged plan are below.

## 1. What the build does today

`build_area.py`, after rasterising land cover at 4 m (Plymouth) or 8 m (Kielder):

```python
signed = (distance_transform_edt(~sea) - distance_transform_edt(sea)) * texel  # + on land
far = np.where(d > 0, np.maximum(heights, 0.5), np.minimum(heights, -2.0))
t = np.clip((np.abs(d) - 20) / 20, 0, 1)
heights = d * 0.08 * (1 - t) + far * t
```

This is right for beaches, marsh and harbour walls: the 0 m contour, and so the waterline,
follows the mapped coast smoothly between 20 m grid points. On a cliff it is wrong. OSM's
`natural=coastline` is mean high water, which on a cliffed coast is the foot of the cliff, so the
cliff top is often 0 to 20 m from the line. The blend pulls the top down to a metre or two and
rebuilds the cliff as a 20 m-wide ramp further inland.

Measured with OSM `natural=cliff` lines from Overture (`base/land`, subtype `physical`, class
`cliff`), sampled every 20 m, for points within 60 m of the coastline:

| Box | Cliff points near coast | Median distance to coastline | Median height, tiles z15 | z13 (today) | After the blend |
| --- | --- | --- | --- | --- | --- |
| North Cornwall (lon -4.8..-4.5, lat 50.6..50.75) | 741 | 19 m | 23.4 m | 26.2 m | **2.4 m** (59% under 5 m) |
| Plymouth tile | 22 | 32 m | 17.5 m | 15.2 m | **6.5 m** (45% under 5 m) |

(OSM cliff lines are drawn along the cliff top by convention, but bilinear sampling of a top
edge picks up some of the face, so the "real" medians are underestimates. Most of the Plymouth
tile's 10 km of cliff lines are inland quarries and river bluffs.)

## 2. Height sources

### What the current tiles really contain

AWS Terrain Tiles (Mapzen/Tilezen "Joerd") list the **Environment Agency LIDAR composite DTM
(2015, OGL)** as the source for the UK, alongside SRTM, GMTED, ETOPO1 and EU-DEM
([attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)). In practice
that means England has LIDAR-derived heights and Scotland, Wales and Northern Ireland fall back to
30 m-class global data.

Profiles across four cliffs, steepest drop over any 30 m:

| Cliff | Tiles z13 (today) | Tiles z15 | Copernicus GLO-30 |
| --- | --- | --- | --- |
| Beachy Head | 37 m (51°) | 47 m (58°) | 38 m (52°) |
| Rame Head (Plymouth tile) | 13 m (23°) | 37 m (51°) | 17 m (30°) |
| White Cliffs, Dover | 36 m (50°) | 77 m (69°) | 43 m (55°) |
| St John's Head, Hoy | 57 m (62°) | 117 m (76°) | 83 m (70°) |

Zoom 15 is clearly better in England. At Hoy, z15 is sharp on land but has flat plateaus and
steps out at sea (69 m, then -10 m), so the tiles are not trustworthy outside England.

### Better sources, by nation

| Nation | Source | Resolution | Licence | Access | Notes |
| --- | --- | --- | --- | --- | --- |
| England | EA LIDAR Composite DTM 2022 | 1 m and 2 m | OGL v3 | environment.data.gov.uk download (5 km tiles) and WMS | Over 95% coverage ([OSM wiki](https://wiki.openstreetmap.org/wiki/UK_Environment_Agency_LIDAR)). The host is blocked from the cloud container, so fetch on Andy's machine. |
| Scotland | [Scottish Public Sector LiDAR](https://registry.opendata.aws/scottish-lidar), `s3://srsp-open-data` (eu-west-2) | 50 cm (also 1 m/2 m in older phases) | OGL v3 (except phase 2 LAZ) | Anonymous S3, COG GeoTIFF in 1 km OSGB tiles | Reachable from the container. Prefixes include `lidar/national-lidar-programme/dtm/` (5,933 tiles, 89 GB) and `lidar/coastal/coastal-2025-2026/dtm/` (1,169 tiles, 12 GB), plus phases 1 to 6, Outer Hebrides and Orkney. Coverage is partial; not mapped here. |
| Wales | Welsh Government / NRW LiDAR on [DataMapWales](https://datamap.gov.wales/maps/lidar-viewer) | 1 m class | Not verified | Bulk download from the viewer; WMS | datamap.gov.wales is blocked from the container, so coverage and licence were not checked. The OSM wiki says about 70% coverage, but that page may be dated. |
| Northern Ireland | OpenDataNI LIDAR | Varies | OGL (one Belfast exception) | opendatani.gov.uk | Partial coverage, not checked. |
| Fallback everywhere | [Copernicus DEM GLO-30](https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_DEM_GLO30_2024_1?hl=en), `copernicus-dem-30m.s3.amazonaws.com` | 30 m | Free licence with attribution ([licence](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM/resources/license/License-COPDEM-30.pdf)) | Anonymous S3, COG, 1° tiles | A surface model (includes trees and buildings), not bare ground. Cleaner than the tiles at sea, and holds big cliffs reasonably (Hoy 70°). |

Not recommended:

- **OS Terrain 50** is open data but a 50 m grid with 10 m contours
  ([spec](https://docs.os.uk/os-downloads/height-and-imagery/os-terrain-50/os-terrain-50-technical-specification)),
  coarser than what we have.
- **OS Terrain 5** (5 m, 1.5 to 2.5 m RMSE) is not listed as OS OpenData; OS's
  [overview](https://docs.os.uk/os-downloads/products/land-and-terrain-portfolio/os-terrain-5/os-terrain-5-overview)
  presents only Terrain 50 as open. LIDAR beats it where LIDAR exists anyway.

**Recommendation:** a per-tile mosaic, in priority order: national LIDAR DTM (resampled to 2 m),
then Copernicus GLO-30, with a 50 to 100 m feathered blend where they meet so gaps don't show
as steps. All three nations' LIDAR are in OSGB (EPSG:27700), so reproject windows to the app's
LAEA grid with rasterio `reproject` (bilinear for LIDAR; cubic for GLO-30 so it doesn't look
faceted). Volume is large but fine for the big machine: a 16 km tile at 2 m is 64 million
samples (256 MB as float32) to read, then thrown away once the mesh is built. England's 2 m DTM
is probably in the order of 100 GB uncompressed (estimate, not measured).

## 3. Making the shoreline cliff-aware

Keep the signed-distance shoreline for low coasts, and switch it off where the land behind the
coast is high.

1. For each texel near the coast, compute the **backshore height** `B`: the highest DTM height
   within 40 m landward (a `maximum_filter` over land texels, then spread back to the sea edge
   with the distance transform's nearest-feature indices).
2. Make a smooth **cliffness** weight `c = smoothstep(4 m, 12 m, B)`, blurred along the coast
   over about 50 m so it never flips between neighbouring points.
3. Heights become `mix(today's blend, cliff rule, c)`, where the cliff rule is:
   - landward of the coastline: the DTM height as-is, never lowered (but at least 0.5 m so the
     sea plane can't poke through);
   - seaward: `min(DTM, -2 m)`, falling to the existing sea-bed depth, so the toe sits in water
     and the surf and shoaling in `ocean.setDetailGround()` still read deep water at the foot.
4. Where an OSM `natural=cliff` line lies within 60 m of the coast, force `c = 1` along it. OSM
   draws cliff ways with the low side on the right, which also tells the mesh builder (section
   4) which way the face drops.

This alone, with zoom 15 tiles, removes the flattening in England without any new data source.

## 4. Building steep faces in the mesh

`src/detail/ground.ts` builds the ground on the CPU as a regular grid from `height.png`, so the
mesh can be any triangle list without touching the shaders' height logic.

Tested on a 2.56 km square at Tintagel, using zoom 15 tiles resampled to a 2.5 m LAEA grid as
"truth" (3.3% of it steeper than 50°):

| Mesh | Vertices | Mean error on cliff faces | 95th percentile on cliffs | Mean error overall |
| --- | --- | --- | --- | --- |
| Regular 20 m (today) | 16,641 | 5.2 m | 14.7 m | 0.44 m |
| Regular 10 m | 66,049 | 3.5 m | 11.9 m | 0.21 m |
| Regular 5 m | 263,169 | 1.6 m | 6.7 m | 0.07 m |
| Adaptive TIN, 2 m max error | 17,544 | ≤ 2 m | ≤ 2 m | ≤ 2 m |
| **Adaptive TIN, 1 m max error** | **24,177** | **≤ 1 m** | **≤ 1 m** | **≤ 1 m** |
| Adaptive TIN, 0.5 m max error | 33,062 | ≤ 0.5 m | ≤ 0.5 m | ≤ 0.5 m |

The adaptive mesh is the greedy "Delatin" triangulation (`pydelatin`, the algorithm behind
Mapbox's Martini and Fogleman's `hmm`): it keeps inserting the worst-fitting point until every
sample is within the error. Flat fields get big triangles and cliffs get dense strips, so cliffs
come for free. Real LIDAR is sharper than the z15 tiles, so expect somewhat more vertices.

**Recommended mesh build, per tile:**

- Run Delatin on the 2 m height mosaic (after the section 3 shoreline) with a 0.5 to 1 m max
  error. Add the cliff top lines (OSM, plus a "steeper than 55°" edge traced from the DTM) and the
  coastline as **breaklines**, so faces have a crisp top edge rather than a rounded one.
- Write it as `ground.bin` (float32 x, y, z + uint32 indices). Keep a `height.png` raster
  as well, because buildings, trees, roads and the ocean's depth slots sample heights from it.
- **Tile edges:** Delatin won't put the same vertices on both sides of a shared edge. Either seed
  every tile edge with fixed vertices every 20 m (both neighbours then agree), or hang a short
  skirt below each edge. Seeding is cleaner; `blendEdges()` keeps working against the coarse
  terrain.
- **Normals:** compute per-vertex normals, but split vertices along cliff top breaklines so the
  lip stays sharp instead of averaging into a bevel.

Alternatives considered: a finer regular grid only in a coastal band (simple, but 5 m costs 16×
the vertices and still misses half the face), or extruding a separate "cliff wall" ribbon from
the cliff line like buildings (gives easy UVs, but needs the ground cut away under it and leaves
seams where OSM lines stop). The adaptive mesh handles both, plus inland crags, quarries and
gorges, without special cases.

## 5. Making cliffs look good

The ground shader textures by plan position (`p = position.xz`) and colours most land from the
Sentinel-2 summer composite. Both smear on a near-vertical face: the satellite sees a cliff as a
line of a few pixels. So:

- **Triplanar rock on steep slopes.** Blend from the current surface to a rock material by slope
  (say 40° to 60° on the world normal), and texture the rock triplanar so strata run horizontally
  across the face. Add procedural horizontal banding (fbm in height with a little warp) and a
  normal-perturbation for joints and ledges.
- **Rock colour by geology.** Chalk at Dover and Beachy Head, red sandstone in south Devon, grey
  slate and granite in Cornwall, black basalt in Antrim and Skye. The BGS 1:625,000 bedrock map
  could drive a small palette per tile (licence and access not checked yet). A cheaper first
  step: sample the Sentinel-2 colour at the cliff toe and top and tint the rock between them.
- **Grass lip.** Keep the top 1 to 2 m of the face grassy, with an overhanging fringe, from the
  cliff-top breakline.
- **Toe details.** A dark wet band from sea level to a couple of metres up; scree and boulder fans
  at the foot, as instanced rocks along the coastline where cliffness is high; white water against
  the toe from the sea thread's surf, which already reads the ground depth.
- **Light.** Cliffs live or die by shadow and ambient occlusion. Bake an AO term into the mesh
  (horizon-based, from the 2 m DTM) so overhangs and gullies stay dark even out of direct sun.

## 6. Large estuaries

The same cliffness rule applies: rias like the Tamar, Fal and Dart have steep wooded banks and
get them; the Severn, the Wash, Morecambe Bay and the Thames are low and keep the smooth ramp.
Estuaries add three problems of their own.

1. **Intertidal flats.** In the big estuaries the land between low and high water is kilometres
   wide. LIDAR is usually flown near low tide, so the DTM has real mudflats and braided channels,
   but the build marks everything inside the coastline as sea and carves it to -2 m or deeper.
   That loses one of the prettiest things on the UK coast. Overture keeps OSM's sub-tag: in a
   Morecambe Bay box, `source_tags.wetland` on `base/land` wetland features gave 22 `tidalflat`
   and 12 `saltmarsh` polygons. Recommendation: add an `intertidal` cover class from
   `wetland=tidalflat` (and beaches below the coastline), keep the DTM there instead of carving
   it, but compress its relief toward water level (e.g. `0.2 m + 0.3 × (DTM − 0.2 m)`), and shade
   it as wet, reflective sand or mud with the channels left below water. Saltmarsh stays land
   with its own green-brown wetland look. It reads as mid tide, which matches a sea fixed near
   0 m (mean sea level).
2. **Where the sea ends.** Overture splits estuary water between `ocean`/`physical` (treated as
   sea today) and `water`/`tidal_channel` or `river` (treated as inland water, drawn at its own
   level). Tidal water should use the sea level so there is no visible step at the boundary.
   Classify water as tidal from OSM `tidal=yes` in `source_tags` or from `tidal_channel`.
3. **Tide range.** Mean high water in the Severn is several metres above mean sea level, so the
   coastline line and the 0 m contour can be far apart. That is fine for a fixed mid-tide sea, as
   long as the build trusts the DTM in intertidal areas (point 1) rather than forcing everything
   seaward of the coastline under water. An animated tide would be a nice later toy, but it needs
   per-port tide data and isn't proposed here.

## 7. Suggested plan

Each stage is useful on its own. None of it touches the main bake until Andy agrees, and the
build script changes go through the terrain, towns and forests work.

1. **Quick fix, no new data:** switch heights to tiles zoom 15 and add the cliffness-weighted
   shoreline (section 3). Rebuild Plymouth, and add a north Cornwall test tile (Tintagel to
   Boscastle has 100 m+ cliffs) to judge it.
2. **Cliff shading:** triplanar rock by slope, grass lip, wet toe band (section 5). Shader only.
3. **Adaptive mesh:** Delatin `ground.bin` with breaklines and seeded tile edges (section 4).
4. **LIDAR mosaic in the bake:** EA, Scottish and Welsh LIDAR with GLO-30 fill (section 2),
   downloaded once on the big machine.
5. **Estuaries:** intertidal class and tidal water level (section 6), tested on a Morecambe Bay
   or Severn tile.

## Sources

- [Tilezen Joerd data attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)
- [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles)
- [OSM wiki: LiDAR sources for the United Kingdom](https://wiki.openstreetmap.org/wiki/UK_Environment_Agency_LIDAR)
- [EA LIDAR composite DSM (sister dataset), data.gov.uk](https://www.data.gov.uk/dataset/cf3f1137-c12b-44a1-a835-e80fe4a60b92/lidar-composite-digital-surface-model-dsm-1m)
- [Scottish Public Sector LiDAR on AWS](https://registry.opendata.aws/scottish-lidar)
- [DataMapWales LiDAR viewer](https://datamap.gov.wales/maps/lidar-viewer)
- [Copernicus DEM GLO-30](https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_DEM_GLO30_2024_1?hl=en) and its [licence](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM/resources/license/License-COPDEM-30.pdf)
- [OS Terrain 50 technical specification](https://docs.os.uk/os-downloads/height-and-imagery/os-terrain-50/os-terrain-50-technical-specification)
- [OS Terrain 5 overview](https://docs.os.uk/os-downloads/products/land-and-terrain-portfolio/os-terrain-5/os-terrain-5-overview)
- [pydelatin](https://github.com/kylebarron/pydelatin) (greedy adaptive triangulation)

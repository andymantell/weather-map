# Handoff: baking the detailed terrain for the whole UK

This is for a Claude Code session on Andy's big machine (AMD Ryzen 9 9950X3D, 16 cores / 32
threads, 96 GB RAM, Nvidia RTX 5090). It hands over the UK-wide bake of the detailed terrain,
which so far exists only for two test tiles, Plymouth and Kielder. Read
[terrain-detail.md](terrain-detail.md) first: it describes what each layer is, where it comes
from and how it is drawn. This file covers what that doc doesn't: how to scale it up.

Status on 2026-10-21: nothing UK-wide has been built yet. The per-tile scripts work, but each
one is still keyed to a hard-coded lon/lat box, and the app loads the two tiles by name.

## Project rules that apply

- Work on `main` only, with no branches or PRs. Run `git pull --rebase` before every push and
  never force-push. Other sessions (clouds, rain, sea, camera) also push to `main` and edit the
  app, so keep changes inside `src/detail/` and `scripts/detail/` where possible.
- Andy's guiding principle: a visually pleasing toy, not a forecasting tool. Aim for
  best-in-class rendering. Accuracy and performance come second.
- Research write-ups go in `docs/` as Markdown. Screenshots don't need committing.
- Don't deploy anything. Hosting is planned for AWS later.
- Say "don't know" rather than guess, and measure rather than assume.

## Step 1: time one tile before anything else

The only time estimates so far come from a 4-core cloud container behind an HTTPS proxy, where
a tile took roughly 5 to 10 minutes, mostly downloading. Nobody has measured it on this machine.
Rebuild Plymouth from scratch and time each step:

```sh
pip install -r scripts/detail/requirements.txt    # numpy pillow pyproj pyarrow shapely scipy rasterio
rm -rf .cache/detail                              # force fresh downloads
time python scripts/detail/build_area.py plymouth       # heights, cover, buildings, trees
time python scripts/detail/build_masses.py plymouth     # merged street blocks
time python scripts/detail/build_imagery.py plymouth    # Sentinel-2 colour
time python scripts/detail/build_boundaries.py plymouth # hedges and walls
time python scripts/detail/build_roads.py plymouth      # road centrelines
```

Then check that `git status` shows the rebuilt `public/data/detail/plymouth/` files as
unchanged or near-identical, and run the app (`npm install && npm run dev`) to confirm Plymouth
still looks right. Report the timings to Andy before starting the full run.

## Data sources and access gotchas

All sources are public and need no account or API key.

| Data | Where | Notes |
| --- | --- | --- |
| Buildings, land use, land cover, water, roads, barriers | Overture Maps, `s3://overturemaps-us-west-2/release/2026-09-23.0/` (region us-west-2), GeoParquet | Read with pyarrow `S3FileSystem(anonymous=True, region="us-west-2")` and a bbox filter on the `bbox` struct column. See `overture()` in `build_area.py`. |
| Heights | AWS Terrain Tiles, `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`, zoom 13 | Cached in `.cache/detail/tiles/`. Native UK resolution not verified. |
| Satellite colour | Sentinel-2 L2A COGs, `s3://sentinel-cogs/sentinel-s2-l2a-cogs/<zone>/<band>/<square>/<year>/<month>/<scene>/` | `TCI.tif` (true colour, 10 m), `SCL.tif` (classification, 20 m) and `<scene>.json` (cloud cover). Read with rasterio `/vsis3/` and `AWS_NO_SIGN_REQUEST=YES`. |

Gotchas:

- **The Overture bbox filter scans every fragment's footer worldwide**, so each per-tile query
  costs minutes even for a small box. For the UK bake, first download the UK extract of each
  layer once (UK bbox roughly lon -8.7..1.9, lat 49.8..60.9) to local GeoParquet, then clip
  tiles from that locally. Layers used: `base/land`, `base/land_use`, `base/land_cover`,
  `base/water`, `base/infrastructure` (barriers), `buildings/building`,
  `transportation/segment`. Buildings are about 30 million UK rows, under 6.7 GB uncompressed.
- **Sentinel-2 tile ids:** the UK spans UTM zones 29, 30 and 31. Plymouth is in 30UVA and
  Kielder in 30UWG. Each scene's JSON `bbox` is that pass's data footprint, not the 110 km tile
  square, so pick tiles by MGRS geometry (e.g. the `mgrs` Python package or the Sentinel-2 tiling
  KML), not by scene bbox. List each tile's summer scenes once and cache the list, because listing
  is slow.
- `build_imagery.py` reads only the window each tile needs from each scene (COG range reads), so
  it never downloads whole scenes. Per detailed tile it reads up to 14 scenes × (TCI + SCL).
- The scripts honour `HTTPS_PROXY` and `SSL_CERT_FILE` if set. On a normal home connection,
  leave them unset.
- DuckDB's httpfs extension and Overpass were blocked in the cloud container. They may work at
  home, but nothing depends on them.

## What to change for a UK-wide bake

### 1. A tile grid instead of named boxes

Every script takes an area name and looks up a lon/lat box in `AREAS` (`build_area.py`). Replace
that with a fixed grid in the app's projection (UKV LAEA:
`+proj=laea +lat_0=54.9 +lon_0=-2.5 +ellps=GRS80`, metres). For example, use 16 km square tiles
with ids `x_y` from the grid index, so tiles share edges exactly. Plymouth's box is about
17.5 × 12.9 km, so 16 km tiles keep per-tile sizes like today's. Skip tiles with no land: the
coarse heightmap or Overture `base/land` tells you.

Things to keep consistent across tiles:

- Each tile's height grid should include its edge samples, so neighbours match. Today's
  `blendEdges()` in `src/detail/detailTerrain.ts` blends 600 m into the coarse terrain at every
  edge. Between two detailed neighbours that blend should be skipped, so the tiles meet each
  other directly. It only belongs where a tile borders coarse terrain.
- Buildings, roads, hedges and street blocks crossing a tile edge: assign each feature to one
  tile (e.g. by centroid) so nothing is drawn twice. Roads and hedges can be clipped at the edge
  instead.
- Land-cover rasterisation reads features in a small margin beyond the tile so classes don't
  stop at the edge.

### 2. Run tiles in parallel

Wrap the five scripts in one driver (e.g. `scripts/detail/bake_uk.py`) that:

- builds the tile list,
- runs tiles in a process pool (start with 16 workers and watch CPU, RAM and bandwidth),
- skips tiles whose outputs already exist, so the run can be stopped and resumed,
- writes a manifest (`index.json`) of tile ids, extents, file sizes and whether each tile has
  coast, imagery, roads and so on,
- logs failures per tile instead of stopping the run.

The UK has about 245,000 km² of land, so at 16 km tiles that's roughly 1,000 to 1,100 land
tiles. Downloads will likely be the bottleneck, not the CPU.

### 3. Where the output goes

The output is too big for git: estimated at around 10 GB, not measured. Plymouth's tile is
about 17 MB (6.3 MB roads, 4.8 MB buildings, 1.2 MB hedges, 1.5 MB street blocks, 0.7 MB
imagery and smaller files), but rural tiles will be much smaller.

- Write tiles outside `public/` (e.g. `D:/weather-map-data/detail/<x_y>/`) and keep them out
  of git. `public/data/detail/plymouth` and `kielder` are the only tiles committed, and they stay
  as the small test fixtures.
- Point the app at the data with a Vite env variable, e.g. `VITE_DETAIL_URL`, falling back to
  `${BASE_URL}data/detail/`, and serve the folder in dev (a Vite `server.fs.allow` entry or a
  tiny static server).
- Later this goes to S3 behind CloudFront when the app is hosted on AWS. Design the URLs so a
  plain static host works: `<base>/index.json` and `<base>/<tile>/<file>`.

### 4. Streaming in the app

`src/detail/detailTerrain.ts` currently loads every tile in `DETAIL_AREAS` at start-up and keeps
it forever. For the UK it needs to:

- read `index.json` and load tiles by camera distance. Load only the tiles within about 15 km
  of the camera at full detail, and unload tiles beyond about 25 km. At map scale the coarse
  terrain is enough.
- load lazily within a tile. The street blocks (`masses-18.bin`) and far trees are needed
  first. Footprints, roads, hedges and near trees are already created only within 2.5 to 4 km.
  Fetch their files only then too.
- replace the coarse terrain's hole-punching. `src/terrain.ts` discards coarse fragments inside
  up to `MAX_DETAIL_RECTS = 4` rectangles. With many tiles, use a coverage mask texture over the
  UK grid instead, or raise the limit and pass only the loaded tiles.
- replace the sea's per-tile depth slots. `ocean.setDetailGround()` has two slots, for the
  surf and shoaling near detailed coasts. Feed it the nearest two coastal tiles as the camera
  moves.
- dispose of geometries and textures on unload. Check GPU memory with
  `renderer.info.memory`.

## Open data-level questions to settle on the test tiles first

These change baked data, so settle them before the full run. Shader-side tweaks (colour
grading, markings, hedge looks, water, view distances) can carry on afterwards without a rebake.

1. **Building heights:** only about 19% of OSM buildings in Plymouth have a level count. The
   rest are estimated from class or area (`building_height()` in `build_area.py`). Check that the
   estimates look right in other towns.
2. **Land-cover classes:** ESA WorldCover "shrub" is treated as heath only above 250 m, and
   forest above 250 m as conifer. Check this on Dartmoor, in the Lake District and in the
   Highlands.
3. **Roads:** which attributes to keep (lanes? speed? names?), and the default widths per class
   (`WIDTHS` in `build_roads.py`).
4. **Hedges and walls:** field outlines with no barrier mapped become hedges at Plymouth and
   walls at Kielder (`FIELD_EDGE`). The UK needs a rule, e.g. walls in the uplands and the north,
   hedges in the lowlands. Agree this with Andy.
5. **Satellite imagery:** the composite is a summer median of 2023 to 2025 scenes. Scotland and
   the north have fewer clear scenes, so check coverage. `build_imagery.py` falls back to the
   all-scene median for pixels never seen clear, which may leave cloud traces. The colour grade is
   in the shader, so the bake stores the raw image.
6. **Coast:** heights near the coast use a signed-distance shoreline (`build_area.py`). Check it
   on cliffs (e.g. Cornwall) and on large estuaries.

## Known issues today (not blockers for the bake)

- The D3D shader compiler warns "potentially uninitialized variable (f_proceduralColour_int)".
  Testing found it made no visible difference.
- Kielder is very dark under overcast. Some bright satellite patches stand out, such as the
  china clay works near Plymouth.
- The coarse terrain outside detailed tiles has procedural fields only.

## Useful tools in the repo

- `scripts/detail/gpu-shots.mjs`: drives headed Chrome through a set of views and saves
  screenshots plus frame times. With `npm run dev` running:
  `npm i --no-save playwright && node scripts/detail/gpu-shots.mjs http://localhost:5173/`.
  It needs `window.detail`, `window.rig` and `window.projection`, which are exposed in dev builds.
- `poc/terrain/` (open `/poc/terrain/` on the dev server) is the standalone prototype page for
  comparing building and tree options.

## Attribution to carry

Overture Maps Foundation (including © OpenStreetMap contributors (ODbL), ESA WorldCover
(CC BY 4.0) and Microsoft building footprints (ODbL)); AWS Terrain Tiles; contains modified
Copernicus Sentinel data (2023–2025).

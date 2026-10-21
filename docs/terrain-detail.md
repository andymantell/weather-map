# Detailed terrain: towns, fields, woods and roads

The main map now has two detailed tiles, **Plymouth** (17 × 13 km) and **Kielder** (25 × 26 km),
where the camera can come down to ground level and see real buildings, the real field pattern,
hedges, walls, roads and trees. Everywhere else still uses the coarse UK terrain with procedural
fields and moorland. Baking every tile for the whole UK is the next, separate step (see
[UK bake](#uk-bake)).

The approach follows the proof of concept in
[terrain-towns-forests-poc.md](terrain-towns-forests-poc.md), with Andy's two changes: no grid
blocks (street blocks follow the real shape of the town), and real fields instead of an
invented patchwork.

`scripts/detail/gpu-shots.mjs` drives a real GPU-backed Chrome through a set of views
(Plymouth streets, the Hoe, Sutton Harbour, Devon fields, Kielder forest and walls) and
records screenshots and frame times; run it locally to see the current state.


## What is real and what is made up

| Layer | Source | Real? |
| --- | --- | --- |
| Heights | AWS Terrain Tiles (terrarium z13), 20 m (Plymouth) / 25 m (Kielder) grid | Real |
| Land cover (farmland, wood, heath, water, town) | OpenStreetMap land use and water via Overture Maps, ESA WorldCover | Real, at 4 m / 8 m |
| Ground colour of farmland, parks, woods, moor | Sentinel-2 L2A, cloud-free summer median at 10 m | Real (photographed) |
| Fine ground texture close up | Shader noise | Made up |
| Hedges and dry-stone walls | OSM `barrier=hedge` / `barrier=wall`, plus mapped field outlines | Real lines; their shape is made up |
| Roads | OSM centrelines via Overture (class, width, surface, bridge, tunnel) | Real lines; markings are generic |
| Buildings | Overture footprints (OSM and Microsoft), height from OSM height or levels where tagged | Real footprints; heights partly estimated |
| Trees | OSM mapped trees; woodland filled with seeded trees | Positions in woods are made up |

### Fields

Sentinel-2 imagery is on the public `s3://sentinel-cogs` bucket, readable anonymously (the
STAC search API is not reachable from the cloud container, so the script lists the bucket
directly). `scripts/detail/build_imagery.py` takes the summer scenes (May to September,
2023–2025) under 40% cloud, drops cloud, shadow and snow pixels using each scene's
classification layer, and keeps the per-pixel median of up to 14 scenes. Plymouth uses
tile 30UVA and Kielder 30UWG.

At 10 m a typical Devon field is 10 to 30 pixels across, so the real layout, crops and
ploughed fields show. The shader grades the image, because haze leaves it flat and grey, and
adds its own texture close up where 10 m pixels would look blurry. The image fades out over
the last 600 m of each tile so the edge meets the coarse terrain.

OSM field data is patchy, which is why it is not the main source. In the Plymouth box there are
260 farmland and 163 meadow outlines and about 300 km of mapped hedges. East of Plymouth is
mapped field by field, but west of the Tamar is mostly blank. Around Kielder there are mostly
walls, along the valleys.

### Hedges and walls

`scripts/detail/build_boundaries.py` combines mapped hedges and walls with the outlines of
mapped farmland and meadow wherever no hedge or wall is mapped along them. In Devon almost every
field edge is a hedge bank, and in the Cheviots a wall. Lines are cut wherever they would cross
a road, housing or water. That gives 547 km of hedge at Plymouth and 319 km of wall at Kielder,
drawn within 4 km of the camera as terrain-following strips with leafy or stone shading.


### Roads

Roads used to be painted into the 4 m cover raster, which gave ragged, stepped edges close up.
`scripts/detail/build_roads.py` now writes the centrelines with class, OSM width where tagged,
surface and bridge flags, and leaves tunnels out. Within 4 km they are drawn as ribbons laid on
the tile mesh's own triangles, so they never cut into the ground. Main roads get edge lines and
a dashed centre line, farm tracks get gravel wheel ruts with grass between, and bridge decks run
straight between their ends. While the ribbons are drawn, the raster's roads are replaced by the
colour of whatever lies beside the road, so they don't poke out past the ribbon edges.


### Buildings and trees

Buildings show as real footprints within 2.5 km. Beyond that they become merged street blocks:
footprints joined by morphological closing and cut by the street network, so blocks follow the
town's real shape. Further out they grow taller, up to 5×, so a town still reads from a
distance. Trees are life-size in 1.5 km chunks near the camera, and larger, sparser stand-ins
beyond. The sun casts shadows when the camera is low.


### Relief

The map's vertical exaggeration (4× by default) turns hills into cliffs from the ground. With
**Real relief near the ground** ticked (the default), it eases on a log scale of height from the
slider's value at 20 km down to 1.5× at 200 m and below.

## Performance

Frame times on Andy's machine (Radeon RX 7700S, Chrome, ANGLE/D3D11, 1600 × 900), over
300 frames after the view settled:

| View | Mean | Median | 95th percentile |
| --- | --- | --- | --- |
| Plymouth Hoe, 60 m | 15.5 ms | 18.1 ms | 18.3 ms |
| Kielder Forest, 80 m | 19.9 ms | 18.2 ms | 24.4 ms |

## Bugs found on the real GPU

- **Black Sutton Harbour.** The harbour is inland water above sea level, so the sea plane lies
  under it. It was drawn as glossy, near-black ground, because the material has no environment
  map to reflect. Inland water now gets ripples and a Fresnel sky reflection in the ground shader.
  A `smoothstep` call with its edges reversed, which is undefined in GLSL, was fixed at the same
  time.
- **Tile seam.** Pixel cracks along each tile edge showed the sea plane through them. The coarse
  terrain now runs 40 m under the tile edge, and the skirt is double-sided.

## Known issues

- Only Plymouth and Kielder are detailed. Beyond them the coarse terrain has procedural fields
  only, so the tile edge still shows from a few kilometres up.
- Kielder is very dark under overcast, because conifer plantations are dark in the imagery too.
- Some bright satellite patches stand out, such as the china clay works north-east of Plymouth.
  They are real, but brighter than the lit terrain around them.
- Residential streets have no markings, and junctions have no special treatment.
- The D3D shader compiler warns about a potentially uninitialised variable in
  `proceduralColour`. It is harmless, since every path returns.

## Rebuilding a tile

```sh
pip install -r scripts/detail/requirements.txt
python3 scripts/detail/build_area.py plymouth      # heights, cover, buildings, trees
python3 scripts/detail/build_masses.py plymouth    # merged street blocks
python3 scripts/detail/build_imagery.py plymouth   # Sentinel-2 colour
python3 scripts/detail/build_boundaries.py plymouth
python3 scripts/detail/build_roads.py plymouth
```

## UK bake

The same scripts work for any box, so the UK bake is a matter of tiling the country and running
them per tile, then streaming tiles in by camera distance. The main costs are the following
(estimates, not yet measured):

- Sentinel-2 colour at 10 m for about 245,000 km² of land is roughly 2.5 billion pixels, which
  is about 1 to 2 GB as JPEG tiles.
- Buildings: about 30 million footprints UK-wide.
- Hedges, walls and roads: proportionate to Plymouth's 1.2 MB and 6.3 MB per 225 km² tile.

Attribution: Overture Maps Foundation (including © OpenStreetMap contributors, ESA WorldCover
and Microsoft building footprints); AWS Terrain Tiles; contains modified Copernicus Sentinel
data (2023–2025).

# Keeping satellite clouds off the ground

Terrain bake question 5 (see [terrain-bake-handoff.md](terrain-bake-handoff.md)). The ground colour in
detailed tiles comes from a Sentinel-2 summer composite built by `scripts/detail/build_imagery.py`.
Andy doesn't want satellite clouds or cloud shadows painted on the ground. This note looks at how
the current script can let them through, what was measured on real scenes, the options, and a
recommendation. Nothing in the bake has been changed yet.

## How the script works today

- Lists the tile's May to September scenes for 2023 to 2025 with tile cloud cover of 40% or less.
- Takes up to 14 scenes, least cloudy first, skipping any where under 30% of the area is clear.
- Per scene, keeps pixels whose scene classification (SCL, made by ESA's Sen2Cor) is vegetation,
  bare soil or water (classes 4, 5, 6). Cloud (8, 9), cirrus (10), cloud shadow (3), dark areas
  (2), unclassified (7) and snow (11) are dropped.
- Takes the per-band median of the kept pixels.
- **Where a pixel was never kept, it uses the median of every scene, clouds included.** This is
  the step that can paint cloud or shadow on the ground.

## What I measured

I read every May to September scene from 2019 to 2025 with tile cloud cover of 60% or less (about
110 to 125 scenes each, after dropping duplicate processings) for three 8 × 8 km boxes at 10 m, and
compared the current method with alternatives. Scratch scripts, not committed.

| Box | Never seen clear by the current 14 scenes | ...after widening to 2019 to 2025 | ...after also accepting SCL 2 and 7 |
| --- | --- | --- | --- |
| Kielder (30UWG) | 0.00% | 0.00% | 0.00% |
| Skye, Sligachan moors (29VPD) | 0.00% | 0.00% | 0.00% |
| Ben Nevis and Fort William (30VUH) | 0.59% | 0.16% | 0.00% |

What that shows:

- **The fallback is rare at these sites, and where it fires it is in the mountains, not under
  persistent cloud.** At Ben Nevis the never-clear pixels are the north-facing corries and cliffs.
  Sen2Cor marks them as dark area (29%) or cloud shadow (9%) in every scene because they really are
  in shadow, and marks bright rock and late snow patches as cloud (57% were classed 8 or 9). The
  fallback then fills them with an average that includes real clouds.
- **Even in the west Highlands there are plenty of clear summer looks.** The current selection
  finds 36 to 39 candidate scenes per Scottish tile against 72 for Plymouth's (Plymouth's tile is
  seen from two orbits). Each pixel in my boxes had a median of about 45 to 55 clear looks across
  2019 to 2025.
- **Widening the years has a cost.** At Kielder a 2019 to 2025 median blurs forestry clear-fells
  from different years into each other. Recent scenes should stay first, with older years only
  filling gaps.
- **Topographic shadow is baked into the colour.** The Ben Nevis corries are near black in every
  method because the satellite saw them in shadow at about 11:00. That is not cloud, but the app
  lights the terrain itself, so these areas get shaded twice. Worth knowing; not solved here.

Three boxes are not the UK. I haven't tested Shetland, Orkney, the Outer Hebrides or the highest
Cairngorms, which may be worse, so the bake should report coverage per tile (see below).

## Options

### Better cloud and shadow masks

| Mask | What it is | Use here |
| --- | --- | --- |
| SCL (Sen2Cor) | Comes with every L2A scene; already used. In a 2021 comparison of 20 scenes it scored 92% overall, the best of the three tested, but it misses thin cloud and cloud edges and confuses bright rock, snow and topographic shadow with cloud ([Zekoll et al. 2021](https://eolab.geographie.hu-berlin.de/publication/zekoll_2021/)). | Keep, but grow cloud and shadow areas by about 100 m to catch the soft edges. |
| s2cloudless | Sentinel Hub's per-pixel cloud probability. | No probability layer in `s3://sentinel-cogs` (checked: a scene folder holds the bands, AOT, WVP, SCL, TCI and previews only). Running the model needs B10, which L2A doesn't carry. Not worth it. |
| Cloud Score+ | Google's per-pixel "how clear is this" score at 10 m, CC BY 4.0, 2015 to now. Suggested threshold 0.5 to 0.65 of `cs_cdf` ([catalog](https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_CLOUD_SCORE_PLUS_V1_S2_HARMONIZED)). | Probably the best mask available, but only inside Google Earth Engine, which needs an account. The whole composite could be built in Earth Engine and exported, but that moves the bake off Andy's machine. Keep as a fallback plan. |
| OmniCloudMask | Open-source (MIT) deep-learning model for clear, thick cloud, thin cloud and shadow from red, green and NIR at 10 to 50 m. Reported balanced accuracy on Sentinel-2 of 92% clear, 91% cloud, 81% shadow ([paper](https://library.dpird.wa.gov.au/nrm_research/105), [docs](https://omnicloudmask.readthedocs.io/)). Runs on CUDA. | The best mask that can run locally on the RTX 5090. Needs B08 as an extra read per scene. Not tested here. |

### Wider date range

More scenes per tile, but land changes between years (clear-fells, new estates, quarries). Use
older years only for pixels with too few recent clear looks.

### Ready-made cloud-free mosaics

| Mosaic | Resolution and period | Licence | Fit |
| --- | --- | --- | --- |
| EOX Sentinel-2 cloudless | 10 m, yearly | 2018 onwards CC BY-NC-SA 4.0; 2016 CC BY 4.0. The licence page covers WMTS use and doesn't say whether baking is allowed ([licence](https://cloudless.eox.at/license-non-commercial)). | Looks good, but baking it needs EOX's OK. Not recommended. |
| Copernicus Data Space quarterly mosaics | 10 m B02, B03, B04, B08, per quarter, from 2022. SCL masking then the first quartile of each band ([algorithm](https://documentation.dataspace.copernicus.eu/Data/Others/Sentinel2_Mosaic_Algorithm.html)). | Not stated on the pages I read. Needs a free Copernicus account. | Same SCL masking as ours, so the same mountain gaps. The first quartile darkens the image. A possible gap filler only. |
| ESA WorldCover composites | 10 m RGB+NIR, yearly median, 2020 and 2021 only, anonymous `s3://esa-worldcover-s2` (eu-central-1), CC BY 4.0 ([registry](https://registry.opendata.aws/esa-worldcover-vito-composites)) | CC BY 4.0 | Whole-year median, so not summer colours and four years old. A last-resort gap filler at most. |

None of them is better than our own composite for the main image. Our own composite keeps the
summer look, the recent date, and the existing colour grade in the shader.

## Recommendation

Keep building our own composite, and make it impossible for a cloud to reach the output:

1. **Never fall back to the all-scene median.** Replace it with a tiered fill per pixel:
   1. median of SCL-clear looks from recent summers (2023 to 2025), needing at least 3 looks;
   2. else the same from 2019 to 2025;
   3. else also accept SCL dark area (2) and unclassified (7), still never cloud, cirrus or
      cloud shadow (3, 8, 9, 10). This fixed all of the Ben Nevis gaps;
   4. else fill from the surrounding pixels (a blur-based inpaint), which the shader's detail
      covers close up.
2. **Grow SCL cloud, cirrus and cloud shadow by about 100 m** in each scene before masking, to
   drop the soft edges SCL misses.
3. **Take up to about 20 scenes per tile instead of 14**, chosen by clear share inside the tile,
   recent first. That's roughly 40% more reads than today.
4. **Log coverage per tile in the bake manifest**: the share of pixels filled at each tier.
   Any tile with more than about 0.5% at tiers 3 or 4 gets eyeballed, or a second pass.
5. **Only if that QA still finds haze or cloud edges**, add OmniCloudMask on the RTX 5090 as an
   extra mask (drop a look if either SCL or OmniCloudMask flags it). Cloud Score+ through Earth
   Engine is the next step after that.

Steps 1 to 4 are small changes to `build_imagery.py` and need no new services or accounts. The
terrain build is owned by the "Terrain, towns and forests" work, so the change should be agreed
there before `build_imagery.py` is edited, and the two committed test tiles (Plymouth, Kielder)
rebuilt to check nothing else moves.

## Done (2026-10-22)

Andy agreed steps 1 to 4. `build_imagery.py` now does them, with a tile cloud limit of 60% (the
per-area clear share does the real selection) and up to 20 recent plus 20 older scenes. Older
scenes are only read when some pixel has fewer than 3 recent clear looks. Only the two test tiles
were rebuilt, not the UK bake.

| Tile | Tier 1 (recent) | Tier 2 (older years) | Tier 3 (loose SCL) | Tier 4 (inpaint) | Scenes | Time in the cloud container |
| --- | --- | --- | --- | --- | --- | --- |
| Plymouth | 99.94% | 0.06% | 0.0005% | 0% | 40 | 2.5 min |
| Kielder | 100% (under 0.0001% elsewhere) | 0% | 0% | 0% | 40 | 1.7 min |

Both images look almost the same as before: mean change 3 to 4 levels out of 255, and about 0.3%
of pixels change by more than 25, mostly fields at a different crop stage. Neither old image had
visible cloud, so the change is insurance for the north and the islands rather than a visible fix
here. The new images are very slightly duller, probably because hazier days now take part in the
median; the shader's colour grade can absorb that. The shares are in each tile's `meta.json`
under `imagery`.

The scripts' memory use went up with more scenes, so the median is now computed in strips of 256
rows (a 25 km tile with 40 scenes ran out of 15 GB before that).

## Sources

- [Sentinel-2 cloudless licence (EOX)](https://cloudless.eox.at/license-non-commercial)
- [Copernicus Data Space quarterly mosaic algorithm](https://documentation.dataspace.copernicus.eu/Data/Others/Sentinel2_Mosaic_Algorithm.html)
- [Copernicus quarterly cloudless mosaics announcement (Sinergise)](https://sinergise.com/en/news/copernicus-data-space-ecosystem-grows-new-data-collection-enter-sentinel-2-quarterly-cloudless)
- [ESA WorldCover composites on AWS](https://registry.opendata.aws/esa-worldcover-vito-composites)
- [Cloud Score+ in Earth Engine](https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_CLOUD_SCORE_PLUS_V1_S2_HARMONIZED)
- [OmniCloudMask documentation](https://omnicloudmask.readthedocs.io/) and [paper abstract](https://library.dpird.wa.gov.au/nrm_research/105); PyPI lists it as MIT, version 1.8.0
- [Zekoll et al. 2021, comparison of masking algorithms for Sentinel-2](https://eolab.geographie.hu-berlin.de/publication/zekoll_2021/)

# Better data for the UK bake: building heights and land cover

Research for the UK-wide terrain bake ([terrain-bake-handoff.md](terrain-bake-handoff.md)),
done on 2026-10-21. Andy's position is that the current building-height estimates and the
moorland/forest rules are fine for now. This doc records what better open sources exist, so
the bake can use them if they're worth it. Nothing here has been downloaded or tested yet;
licences and coverage are as stated by the publishers' pages linked below.

## Building heights

Today: Overture buildings carry a height for OSM buildings that are tagged with a height or a
number of levels (about 19% of OSM buildings in the Plymouth box), and for nearly all Microsoft
ML buildings (17,015 of 17,080 in the Plymouth box). Every other building gets an estimate from
its class or footprint area (`building_height()` in `scripts/detail/build_area.py`).

| Source | Coverage | Resolution / method | Licence | Verdict |
| --- | --- | --- | --- | --- |
| [Environment Agency LIDAR Composite, England](https://developers.google.com/earth-engine/datasets/catalog/UK_EA_ENGLAND_1M_TERRAIN_2022) | ~99% of England | 1 m DTM, 1 m first-return DSM and last-return DSM, surveys 2000–2022, ±15 cm RMSE per survey | Open Government Licence v3 | **Best option for England.** Height = DSM − DTM, sampled inside each footprint. |
| Wales LiDAR ([DataMapWales](https://datamap.gov.wales/layers/geonode:wg_lidar_2020_2022_delivery_index)) | Most of Wales (~70% per the [OSM wiki](https://wiki.openstreetmap.org/wiki/UK_Environment_Agency_LIDAR); a 2020–22 national survey has since been delivered) | DSM and DTM tiles | Licence not confirmed from the page | Likely usable, to be checked. |
| Scotland LiDAR (Scottish Remote Sensing Portal) | Patchwork of 11 surveys, not national | Includes 50 cm DSM/DTM | OGL per the OSM wiki | Partial: cities and some regions only. |
| Northern Ireland ([OpenDataNI](https://www.opendatani.gov.uk/dataset?tags=LIDAR)) | Not stated | Not stated | OGL | Not needed: the map covers Great Britain's UKV domain, but NI is in it, so worth a later look. |
| [OS MasterMap Building Height Attribute](https://ordnancesurvey.co.uk/products/os-mastermap-building-height-attribute) | Great Britain | Lidar-derived heights per building (ground, roof base, roof max) | Premium OS product. The pages read don't give a price or free tier; free to the public sector (PSGA) and via Digimap for education | Best quality, but not open. Only worth it if Andy has access. |
| [3D-GloBFP](https://essd.copernicus.org/articles/16/5357/2024/) (Che et al. 2024) | Global, incl. Europe ([Europe on Zenodo](https://doi.org/10.5281/zenodo.11391076)) | Machine-learned height per Microsoft footprint from Sentinel-1/2 and DEMs. Europe has the weakest model (R² 0.66); overall RMSE 6–11 m against reference heights | Paper CC BY 4.0; check the Zenodo record for the data | No better than what Overture's Microsoft heights already give. |

### Recommendation

For England, which is most of the UK's buildings, derive heights from the EA lidar: for each
footprint, take a high percentile (e.g. 90th) of first-return DSM minus DTM inside the
footprint, shrunk by a metre to avoid edge pixels on walls and trees. That gives a measured
height for nearly every building instead of an estimate, and also a roof shape hint (flat vs
pitched from the spread of values). Use it in this order: OSM height tag → lidar → OSM levels ×
3 m → Microsoft height → current estimate. Wales next if its licence checks out; Scotland only
where surveyed.

Cost: the England 1 m composite is very large (tens of GB per layer even compressed); only the
tiles under buildings are needed. It's also on Google Earth Engine, which would avoid the
download but adds an account dependency. This is a bake-time job for the big machine.

## Land cover: moorland, heath and forest types

Today: OSM land use and natural areas via Overture, plus ESA WorldCover (10 m, 11 classes)
for gaps. WorldCover's "shrub" counts as heath only above 250 m, and its "tree cover" above
250 m is assumed conifer, because WorldCover doesn't separate conifer from broadleaf.

| Source | Coverage | What it adds | Licence | Verdict |
| --- | --- | --- | --- | --- |
| [National Forest Inventory 2024](https://www.data.gov.uk/dataset/64379a2a-d877-415e-9e8d-8553bf09faea/national-forest-inventory-gb-2024) (Forest Research) | Great Britain, woods ≥ 0.5 ha | Every wood typed: conifer, broadleaved, mixed, young trees, **felled**, coppice, windblow, plus open areas inside forests | Open Government Licence v3 | **Best for forests.** Replaces the 250 m conifer rule with real types and shows clear-fell patches, which matter a lot in Kielder. |
| [UKCEH Land Cover Map 2023, 10 m](https://ckan.publishing.service.gov.uk/dataset/land-cover-map-2023-10m-classified-pixels-gb) | Great Britain (NI separate) | 21 classes based on broad habitats: separates heather, heather grassland, bog, acid/calcareous grassland, improved grassland, arable, coniferous vs broadleaved woodland | Not stated on the data.gov.uk page; historically UKCEH licences restricted some uses. Check the [DOI record](https://doi.org/10.5285/7727ce7d-531e-4d77-b756-5cc59ff016bd) | **Best single raster for moorland** if the licence allows it: real heather and bog instead of a height rule. |
| [Priority Habitat Inventory, England](https://www.data.gov.uk/dataset/priority-habitats-inventory-england) (Natural England) | England | Polygons for upland heathland, blanket bog, lowland heath, grass moorland, upland grassland and more | Open Government Licence v3 (part CC BY 4.0) | Open alternative to LCM for moorland in England. |
| [Copernicus Forest Type 2018, 10 m](https://sdi.eea.europa.eu/catalogue/copernicus/api/records/59b0620c-7bb4-4c82-b3ce-f16715573137) | EEA38 + UK | Broadleaved vs coniferous at 10 m | Free and open with attribution (Copernicus terms); marked superseded, so look for the newer release | Fallback for conifer/broadleaf outside GB, i.e. Northern Ireland. |

### Recommendation

1. **Forests:** use the National Forest Inventory for wood type across GB. It's open, the
   types map directly to our classes (conifer, broadleaf, mixed, young, felled), and felled
   areas can draw as brown brash with stumps rather than trees.
2. **Moorland:** use UKCEH LCM 2023 if its licence permits this use. Otherwise use the Priority
   Habitat Inventory in England and keep the height rule in Wales and Scotland.
3. Keep ESA WorldCover and the 250 m rule as the fallback where neither covers.

The Sentinel-2 colour already shows moorland and forest colours as they really are, so these
sources mostly improve which **3D** objects get placed (conifer vs broadleaf trees, none on
clear-fell) and the close-up ground texture, rather than the colour seen from the air.

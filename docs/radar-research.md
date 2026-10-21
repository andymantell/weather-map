# Rain radar for "now"

Research only, 21 October 2026. Andy asked what the radar source is, whether it's just rain, and asked for a
report before anything is built. Nothing in the app uses it yet.

**Status: parked (21 October 2026).** Andy said not to build the radar blend for now, but to keep the idea for
later. He may first try to get a fresher full UKV feed, which would make the radar less necessary.

## The short version

- It's the **Met Office's own UK rain radar composite**, published free on AWS in the bucket
  `met-office-radar-obs-data`. It merges 16 radars, from the UK, Ireland and Jersey.
- **It's just rain.** One field: surface rain rate in mm/h, on a 1 km grid, every 15 minutes. There's no
  precipitation type, hail, echo tops or reflectivity in that bucket.
- **It's fresh.** Each file lands about 5½ minutes after its nominal time, against about 3¼ hours for UKV.
- **Browsers can read it**: CORS is open and range reads work. Each file is about 1 MB.
- I found no other free observation feed (satellite cloud, lightning) that I could check from here. The
  best candidate, EUMETSAT satellite imagery, is free under CC BY 4.0, but the container's network blocked it.

## The bucket

| | |
|---|---|
| Registry | [Met Office UK Radar Observations](https://registry.opendata.aws/met-office-uk-radar-observations/), bucket `met-office-radar-obs-data`, eu-west-2 |
| Path | `radar/YYYY/MM/DD/YYYYMMDDHHMM_ODIM_ng_radar_rainrate_composite_1km_UK.h5` |
| Archive | from 21 November 2024 (the registry calls it a 2-year rolling archive) |
| Cadence | every 15 minutes, 96 files a day; that's the only product in the bucket |
| Delay | measured from S3 `LastModified` over 185 files on 20 and 21 October 2026: **5.4 to 7.7 minutes** after the time in the file name, median 5.6. The registry says "within 20 minutes" |
| Size | 0.6 to 1.6 MB per file (gzip-compressed HDF5) |
| Licence | CC BY-SA, "British Crown copyright 2024-2025, the Met Office" (registry) |
| Browser access | `Access-Control-Allow-Origin: *`, `GET` and `HEAD`, range requests return 206 (checked with curl). Same CORS rules as the UKV bucket, so no `Content-Range` for scripts |

The file name time is the end of the scan. The 18:45 file's metadata says the scan ran from 18:44:08 to 18:45:09.

## What's in a file

Checked on the 18:45 UTC file of 21 October 2026 with h5py:

- **Format:** ODIM HDF5 ("H5rad 2.2", the European radar standard), product `COMP`, quantity `RATE`.
- **Data:** `dataset1/data1/data`, float32, 2,175 rows × 1,725 columns, chunked 75 rows × the full width, gzip.
- **Values:** rain rate (mm/h assumed: the file says `RATE` and the maximum was 188), `0` = no rain detected,
  `-1` = no data (outside radar range). 69% of the grid is no-data, 23% dry and 7.5% raining in that file.
- **Grid:** 1 km on the **British National Grid** (`+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.999601 +x_0=400000
  +y_0=-100000 +ellps=airy`), corners from about 44°N to 63°N. The app's UKV grid is LAEA at 2 km, so the radar
  would be reprojected (proj4 is already a dependency) and has twice the resolution.
- **Radars:** 16, listed in the file, including Shannon in Ireland and Jersey. The rate comes from reflectivity with
  Z = 200 R^1.6 and a vertical-profile correction (`VPRCorr`).
- **HDF5 layout:** superblock version 0 with old-style groups, which the app's reader (`src/data/hdf5.ts`) doesn't
  handle yet. It handles the newer layout the UKV files use. Supporting it means adding symbol-table groups and
  version 1 object headers to the reader, or converting the files in the planned Lambda bake.

## Is it just rain? Other products

| What | Free and open? | Fresh? | Notes |
|---|---|---|---|
| Rain rate composite (above) | Yes, AWS | ~5½ min | The only radar product in the bucket |
| Precipitation type, hail, echo tops, reflectivity | **Not found** in any open bucket | | The radar bucket has only rain rate |
| UKV `rainfall_rate`, `snowfall_rate`, `hail_fall_rate` | Yes, the UKV bucket, every 15 min | ~3¼ h (forecast) | Can split radar's total rate into rain, snow and hail by the model's proportions |
| Met Office satellite imagery | Sold under Met Office terms; the [brochure](https://www.metoffice.gov.uk/binaries/content/assets/metofficegovuk/pdf/data/march-2025-data-satellite-brochure.pdf) lists none as free | within 20 min | Visible, infrared, water vapour, RGB composites, 10 to 15 minute steps |
| EUMETSAT satellite images via [MET Norway's geosatellite API](https://api.met.no/weatherapi/geosatellite/1.4/documentation) | Yes, CC BY 4.0 (EUMETSAT data policy) | at least hourly, sometimes every 10 min | PNG pictures of Europe in visible or infrared. **Not checked**: the container's network blocked api.met.no |
| EUMETSAT EUMETView | Not confirmed | near real time | WMS service; **not checked**: network blocked view.eumetsat.int, and the user guide refuses automated fetches |
| EUMETSAT Data Store (raw Meteosat Third Generation data) | Free, but needs registration and a key | | Raw satellite data, too heavy and awkward for a browser |
| RainViewer | Personal and educational use only | 10-min steps | Nowcast and satellite were dropped on 1 Jan 2026, zoom capped at 7 |

I didn't find any open lightning feed for the UK, but I didn't search hard for one.

## How it could blend with UKV in the app

The app's clouds and rain come from one 2D field texture (rain, cloud base, high cloud, CAPE) and the 3D cloud
volume, all from UKV. Ways to bring radar in, simplest first:

1. **Radar rain at "now", crossfading to UKV.** At the start of the timeline, the rain channel comes from the
   latest radar scan, reprojected to the LAEA grid. Over the first 30 to 60 minutes, blend to the UKV rain rate.
   Cheap, and the rain at "now" is then right. The weakness is the crossfade: rain cells fade out in one place and in
   somewhere else, rather than moving.
2. **Make the clouds agree with the radar.** Where radar shows rain but UKV has thin or no cloud, rain would fall
   from clear sky. So raise the cloud volume's cover above radar rain (from the UKV cloud base up to a height that
   scales with the rain rate), and thin UKV's rain-bearing cloud where radar is dry.
3. **Move the radar instead of fading it (a nowcast).** Estimate how the rain is moving from the last two or three
   scans (15 minutes apart), or from UKV's 15-minute 10 m wind, and advect the radar field forward for the first
   hour, blending to UKV as it goes. Extrapolating radar like this is the usual basis of first-hour rain nowcasts, and it would make rain
   visibly drift across the map. It's the most work, but it's also where it would look best.
4. **Precipitation type.** Split radar's rate into rain, snow and hail using UKV's 15-minute `rainfall_rate`,
   `snowfall_rate` and `hail_fall_rate`, if the rain shader ever draws snow or hail differently.
5. **Satellite cloud, if a source works out.** An infrared image could correct where UKV puts cloud "now", much as
   the radar corrects rain. Because it's a picture rather than heights, it would scale the UKV volume's cover rather
   than replace it.

Cost to a visitor: about 1 MB per scan for the whole file. Reading only the rows over the map would save a little,
because the chunks are full-width strips. With the Lambda bake it would be about 0.2 MB per scan, plus 2,880 more
small Lambda runs a month (well within the free allowance) and about $0.02 of S3 writes.

## If Andy wants to go ahead

1. Extend `src/data/hdf5.ts` to read the radar's older HDF5 layout, and add a radar layer behind a flag:
   option 1 plus the cloud fix in option 2.
2. Then try the nowcast (option 3).
3. Try fetching the MET Norway satellite images from a browser, to see if they're usable.

# Reading UKV NetCDF in the browser

Can the browser read Met Office UKV NetCDF straight from the public S3 bucket and make the cloud and rain textures
the app needs, for several timesteps across the next hour? Yes. This is now a working prototype: open the app with
`?live` and it reads the next hour from the bucket, bakes the same textures that `pipeline/ukv_clouds.py` makes,
and adds a time slider. Checked on 21 October 2026.

Short answers:

- **Each file holds one timestep of one field.** There is no multi-time UKV file. A timeline is a set of files.
- **Hourly and 15-minute steps.** 12 single-level fields come every 15 minutes, everything else (all the cloud
  fields) hourly.
- **The browser can read the files directly**, with a small custom HDF5 reader (about 650 lines of TypeScript, no
  WASM, no dependencies) that fetches only the chunks over the map. Output is bit-identical to h5py.
- **It costs 29 to 41 MB of downloads per visit for the hour**, more than the 12 to 25 MB guessed in
  [hosting-architecture.md](hosting-architecture.md). The 3D cloud volume is 85% of it.

## What is in the bucket

Listing runs 00Z to 14Z on 21 October 2026 (`uk-deterministic-2km/<run>/`):

| | |
|---|---|
| File name | `<valid time>-PT<hhhh>H<mm>M-<field>.nc`, e.g. `20261021T1315Z-PT0001H15M-precipitation_rate.nc` |
| Timesteps per file | **One.** The `time` and `forecast_period` variables are scalars; the data is `(y, x)` or `(level, y, x)`. |
| Runs | Every hour. Most runs go to T+12 (1,100 files). 00Z, 06Z, 09Z and 12Z went to T+54 (3,788 files) and 03Z to T+120 (5,020 files). |
| Every 15 minutes | `precipitation_rate`, `rainfall_rate`, `snowfall_rate`, `hail_fall_rate`, `CAPE_surface`, `temperature_at_screen_level`, `temperature_of_dew_point_at_screen_level`, `visibility_at_screen_level`, `pressure_at_mean_sea_level`, `wind_speed_at_10m`, `wind_direction_at_10m`, `wind_gust_at_10m` |
| Hourly only | The other 40 fields, including `cloud_amount_on_height_levels`, cloud base, low/medium/high/total cloud, and everything on height or pressure levels |
| Delay | A run's files appear about 3 h 15 min to 3 h 30 min after its nominal time (S3 `LastModified`). At 18:20 UTC the newest complete run was 14Z. |
| Grid | 1,042 × 970 on the LAEA 2 km grid, rows stored **south first** (y from -1,036,000 m to 902,000 m) |

So "the next hour" from 18:15 UTC means the 14Z run at T+4h15m to T+5h15m: five 15-minute files each for rain and
CAPE, and three hourly files each for the cloud volume, cloud base and high cloud (18Z, 19Z and 20Z bracket the
hour). Starting on the hour needs only two hourly files.

Listing a run's keys costs 0.4 to 1.9 MB of XML, so the browser never lists. It builds the file names from the run
and valid time and finds the newest run with a `HEAD` request for the last file it needs, stepping back an hour at
a time from two hours ago.

## The files

They are NetCDF-4, i.e. HDF5: superblock version 2, version 2 object headers, links stored densely in a fractal
heap, and each field chunked 128 × 128 (one level per chunk for the volume) with zlib (no shuffle), indexed by a
version 1 B-tree. Values are `float32`; the cloud volume is quantised to 0.01 before compression
(`least_significant_digit = 2`). The chunks sit in the file in row-major order with B-tree nodes in between.

The metadata is split: about 13 KB at the start of the file and 20 to 35 KB at the end (the headers were rewritten
when the file was closed). The rest is chunks.

## The reader: `src/data/hdf5.ts`

`h5wasm` and `jsfive` both want the whole file in memory, and h5wasm's lazy mode makes one synchronous request per
read, so I wrote a small reader that works over HTTP range requests:

1. Fetch the first 16 KB. The superblock gives the file size (the end-of-file address).
2. Fetch the last 40 KB. Between them these answer every metadata read for these files; anything else falls back
   to 16 KB pages.
3. Walk the root group's links (fractal heap plus B-tree v2 name index) to the field's object header, and read its
   shape, type, layout, filters and fill value.
4. Walk the chunk B-tree, keep the chunks that overlap the crop, merge neighbours less than 16 KB apart into one
   request, fetch them in parallel, inflate each with the browser's `DecompressionStream('deflate')`, and copy the
   overlap into the output.

It handles exactly what the Met Office writes (also the shuffle filter, for the wave files) and throws a clear
error on anything else, such as superblock version 0, B-tree v2 chunk indexes or other filters.

CORS details that matter:

- The bucket allows `GET`, `HEAD` and the `range` header, but exposes only `ETag` to scripts, not `Content-Range`.
  That is why the size comes from the superblock rather than a suffix range (`bytes=-N`).
- Single `bytes=a-b` ranges are CORS-safelisted, so no request needs a preflight. Loading an hour in headless
  Chromium made 606 `GET`s, 3 `HEAD`s (two of them 404s for runs not published yet) and no `OPTIONS`.

Checked against h5py on the 12Z run's T+1 files: the precipitation crop and the 33-level cloud volume crop came
back identical, value for value.

## Making what the app needs: `src/weather/ukvLive.ts`

It produces the same three things the app loads today, so the cloud and rain shaders are unchanged:

- the 3D cloud texture (541 × 681 × 30 slices of 200 m, north-first, 0 to 255),
- the 2D fields texture (R rain, G cloud base, B high cloud, A CAPE, same encodings as `ukv_clouds.py`),
- the flat rain overlay's 16-bit texture.

For 2026-10-21 18:00 UTC (14Z run, T+4) the browser bake matches `ukv_clouds.py` exactly in the 2D fields, and in
the volume to within 1/255 on 0.09% of voxels (float32 against float64 rounding).

Two savings on top of cropping: the uniform slices only interpolate between native levels 75 m to 6 km, so the
five lowest levels (5 to 50 m) are not fetched, and the crop's rows and columns are read only where chunks overlap
the terrain (30 of 72 chunks per level).

Timeline: the slider runs from the current quarter hour to an hour later in one-minute steps. The volume, cloud
base and high cloud are blended linearly between hours, rain and CAPE between quarter hours. A cloud base that
appears or vanishes between steps snaps at the midpoint. The first hour's volume and the first quarter load before
the map shows; the rest loads in time order behind it, and the slider holds at the last loaded time until then.

### How to try it

```
npm run dev
# then open
http://localhost:5173/?live                        # the hour from now
http://localhost:5173/?live=2026-10-21T18:00Z      # a chosen hour (the bucket keeps about two years)
```

The HUD shows the run, how many files and megabytes were read, and the time slider. Without `?live` the app uses
the baked PNGs as before.

## Measurements

Bytes read per file (14Z run, valid 18Z, cropped to the terrain):

| Field | Whole file | Read | Requests |
|---|---|---|---|
| `cloud_amount_on_height_levels` (levels 75 m to 6 km) | 20.7 MB | 11.5 MB | 222 |
| `height_AGL_at_cloud_base_where_cloud_cover_2p5_oktas` | 0.79 MB | 0.52 MB | 9 |
| `cloud_amount_of_high_cloud` | 0.42 MB | 0.31 MB | 6 |
| `precipitation_rate` | 0.92 MB | 0.50 MB | 9 |
| `CAPE_surface` | 0.65 MB | 0.39 MB | 9 |
| `temperature_at_screen_level` (not used yet) | 1.54 MB | 0.80 MB | 9 |
| `wind_speed_at_10m` / `wind_direction_at_10m` (not used yet) | 1.30 / 1.06 MB | 0.70 / 0.56 MB | 9 / 9 |

About 56 KB of each read is metadata, which is why small fields save less than the crop's 37% of the area.

Per visit, for the hour:

| Start time | Files | Read | Whole files would be |
|---|---|---|---|
| On the hour (2 hourly + 5 quarter-hourly steps) | 16 | 28.9 MB in 566 requests | 51.6 MB |
| Any other time (3 hourly + 5 quarter-hourly steps) | 19 | 41.0 MB in 798 requests | 73.2 MB |
| First view only (1 hour + 1 quarter) | 5 | 13.2 MB in 255 requests | 23.4 MB |

Merging chunks up to 32 KB apart instead of 16 KB halves the requests but reads about 10% more (45.8 MB for the
second row).

Time: from this cloud container (not in the UK, behind a proxy) Node read the first view in 4.5 to 5.0 s and the
whole hour in 9.4 to 9.7 s. A dropped connection on one of the ~800 requests killed a load once, so each range
request now retries twice. Headless Chromium with software WebGL took 80 s, but it was competing with the software renderer
for CPU, so that number says nothing about a real visit. Re-baking the textures for a new slider position takes
60 to 90 ms on the CPU. I have not measured on Andy's machine or a phone yet.

For comparison, the baked PNGs for one hour in `public/data` are about 6 MB (the volume atlas is 4.9 MB of it).

## What this means

- In-browser reading works and needs no server, so the app can stay static. The cost lands on the Met Office
  bucket: about 29 to 41 MB per visit, so 1,000 visits a month would be 29 to 41 GB. That strengthens the case for
  the Lambda mirror in [hosting-architecture.md](hosting-architecture.md) if the map gets real use: a mirror
  re-encoding the volume to 8 bits would serve about 5 MB per hour of data instead of 12 MB.
- The volume dominates. Ways to cut it without a server, roughly in order of payoff:
  - Start the timeline on the hour, so it needs two volumes rather than three (saves 12 MB).
  - Load the third hour only when the slider reaches it.
  - Load the hour around the camera first when the view is zoomed in (chunks are 256 km square, so this only helps
    close to the ground).
- The 15-minute fields come cheap (under 1 MB a step). The 10 m wind every 15 minutes (1.3 MB a step) could drive
  the rain's drift, which is hard-coded to a south-westerly today, and could advect the hourly cloud volume between
  hours instead of cross-fading it. That would look much better than the blend.

## Next steps

1. Run `?live` on Andy's laptop to measure real load time and look at the slider in motion.
2. Decide the timeline: from now (three volumes) or on the hour (two).
3. Move the time blend to the GPU (two textures and a mix uniform) so the slider is smooth instead of 60 to 90 ms a step.
4. Advect clouds and rain with the 15-minute 10 m wind (or the hourly `wind_speed_on_height_levels`).
5. Use the same reader for the wave model's one-chunk-per-hour files, replacing `pipeline/wave_to_grid.py`.

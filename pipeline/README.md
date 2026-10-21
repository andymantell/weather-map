# UKV data pipeline

How the app gets Met Office UKV forecast data into the browser. The approach was tested on 21 October 2026
against the live bucket (run `20261021T0300Z`, 2 m temperature at T+6h, and run `20261021T0400Z`, total
cloud at T+3h).

## Recommendation in one paragraph

Use the free **Met Office UKV 2 km archive on AWS Open Data**. It needs no account and no API key. A small
Python step (`ukv_to_grid.py`) downloads one NetCDF field per parameter and timestep. It quantises the values to
16 bits and writes a lossless PNG plus a JSON sidecar. The app loads those like any other static asset. The
processing step has to run server-side, because the browser can't read NetCDF. Hosting and deployment are on
hold for now, and AWS is the likely home. The browser never talks to the Met Office directly, so there is no key
to leak and no CORS problem.

## Data sources compared

| | AWS Open Data bucket (recommended) | Met Office Weather DataHub |
|---|---|---|
| Access | Anonymous HTTPS or `aws s3 --no-sign-request` | Account, API key, and an "order" configured in the web UI |
| Format | NetCDF4 (HDF5), one file per parameter per timestep | GRIB2 |
| Grid | LAEA "standard" 2 km grid | LAEA standard grid, or a lat/lon version interpolated from it |
| Cost | Free | Free plan is 1 GB/month (Trial: 60 GB over 30 days); paid plans start at £15/month for 10 GB |
| Licence | CC BY-SA 4.0, Crown copyright | DataHub terms |
| Support | "Free and unsupported", not for critical use | Supported service |

Sources: [AWS registry entry](https://registry.opendata.aws/met-office-uk-deterministic/),
[DataHub atmospheric overview](https://datahub.metoffice.gov.uk/docs/f/category/atmospheric/overview),
[DataHub pricing](https://datahub.metoffice.gov.uk/pricing/atmospheric),
[DataHub order guide](https://datahub.metoffice.gov.uk/docs/f/category/atmospheric/how-to-build-your-order).

DataHub is only worth it if we later need a supported feed or GRIB2 specifically. One field at one
timestep is about 0.5 to 2 MB, so the 1 GB free plan allows only a few hundred files a month. I have
not read DataHub's API reference, so its endpoints and header names are not documented here. Nothing in this
repo needs a key.

## The bucket

- Bucket `met-office-atmospheric-model-data`, region `eu-west-2`, base URL
  `https://met-office-atmospheric-model-data.s3.eu-west-2.amazonaws.com/`
- Model prefix `uk-deterministic-2km/`, then one folder per run, for example `20261021T0300Z/`. There is a new run
  every hour. The AWS page describes three types: nowcast runs that reach 12 h ahead, six runs a day that reach
  54 h (00, 06, 09, 12, 18, 21 UTC), and two that reach 120 h (03, 15 UTC). Files appear about 3 to 6 hours after
  the run time. The 03Z run's files were written at about 06:15Z.
- File name: `<valid time>-<forecast period>-<parameter>.nc`, for example
  `20261021T0900Z-PT0006H00M-temperature_at_screen_level.nc`. The first timestamp is the **valid** time, not the
  run time. Early steps come at 15-minute intervals (`PT0000H15M`), then hourly.
- The archive is a 2-year rolling one, so past events can be replayed.

Single-level parameters that are useful for the map, with T+0 sizes from the 03Z run:

| Parameter | Size |
|---|---|
| `temperature_at_screen_level` (K) | 1.5 MB |
| `cloud_amount_of_total_cloud`, `..._low_cloud`, `..._medium_cloud`, `..._high_cloud` (fraction 0 to 1) | 0.25 to 1.1 MB |
| `precipitation_rate`, `rainfall_rate`, `snowfall_rate` | about 0.9 MB |
| `wind_speed_at_10m`, `wind_direction_at_10m`, `wind_gust_at_10m` | 1.1 to 1.4 MB |
| `pressure_at_mean_sea_level`, `visibility_at_screen_level`, `fog_fraction_at_screen_level` | 0.2 to 2.2 MB |
| `height_of_orography` (m), `landsea_mask` | 0.6 MB, 0.1 MB |

The multi-level files (`cloud_amount_on_height_levels` at 20 MB, `temperature_on_height_levels` at 51 MB, and
so on) are what volumetric 3D clouds would need. The script rejects them for now.

## The grid

Each file is one 2D field, `[projection_y_coordinate, projection_x_coordinate]`, 970 rows by 1042 columns. The
spacing is 2000 m. The projection is Lambert Azimuthal Equal Area, read from the file's CF `grid_mapping`:

```
+proj=laea +lat_0=54.9 +lon_0=-2.5 +x_0=0 +y_0=0 +ellps=GRS80 +units=m
```

Cell centres run from x = -1 158 000 to 924 000 and y = -1 036 000 to 902 000. The domain is larger than the UK
(`uk_extended`). Its corners are roughly 24.5°W 61.3°N, 15.3°E 61.9°N, 17.1°W 44.5°N, and 9.2°E 44.9°N, so it
takes in Ireland, Norway, France, and the Alps. The grid is not a rotated pole. The file stores rows from south to
north, and the script flips them so that row 0 is north.

**Suggestion for the 3D scene:** build the scene in these LAEA metres (divided by some scale factor). The grid
is regular in x and y, so the PNG lines up with a flat plane at no cost and no resampling. The terrain mesh just
needs its vertices projected with the same `+proj` string, for example with proj4js. The other option is
`--latlon`, which resamples to a regular lat/lon grid if the terrain ends up in lon/lat or Web Mercator. That
uses bilinear interpolation, so it smooths the data slightly, and it pads the warped edges with no-data cells.

## Conversion: `ukv_to_grid.py`

```
pip install -r requirements.txt

# newest run that has T+6h, 2 m temperature
python ukv_to_grid.py --param temperature_at_screen_level --step 6 --out-dir out --preview

# a specific run, total cloud, fixed 0..1 range so frames share one encoding
python ukv_to_grid.py --param cloud_amount_of_total_cloud --step 3 --run 20261021T0400Z --range 0 1

# a file you already downloaded; or halve the resolution to 4 km with --stride 2
python ukv_to_grid.py --file 20261021T0900Z-PT0006H00M-height_of_orography.nc --stride 2
```

Outputs for `--name foo`:

- `foo.png` is an RGBA PNG holding a 16-bit code: `code = R * 256 + G`, B = 0, A = 255. It is lossless,
  compressed, and decoded natively by the browser.
- `foo.json` holds the grid definition, corner lon/lats, run and valid times, units, attribution, and the decoding
  values: `value = offset + scale * code`, where code 0 means no data.
- `foo.bin` (with `--bin`) holds the same codes as raw little-endian Uint16. It goes straight into a
  `THREE.DataTexture`, but static hosts often serve it uncompressed, so it is about 2 MB per field compared with
  about 1.4 MB for the PNG.
- `foo.preview.png` (with `--preview`) is an 8-bit greyscale picture for checking by eye.

Checked on the 2 m temperature field: decoding the PNG gives back the source NetCDF values to within 0.00017 K.
The `.bin` codes matched the PNG exactly. The previews are north-up with the UK in the right place.

16 bits instead of 8 is a deliberate choice. Temperature spans about 20 K here, and 8 bits would give 0.08 K
steps, which band visibly in smooth gradients. Cloud fraction would be fine at 8 bits. The 16-bit format keeps
one decoder for everything.

### Reading it in Three.js

Keep the browser from colour-managing or premultiplying the bytes, or the codes get corrupted:

```js
const meta = await (await fetch('data/t2m.json')).json();
const tex = await new THREE.TextureLoader().loadAsync('data/t2m.png');
tex.colorSpace = THREE.NoColorSpace;     // raw bytes, no sRGB conversion
tex.premultiplyAlpha = false;
tex.magFilter = tex.minFilter = THREE.NearestFilter; // decode first, then interpolate in the shader if needed
tex.generateMipmaps = false;
tex.flipY = true;                         // PNG row 0 is north; UV v=1 is the top
// In the fragment shader:
//   vec4 t = texture2D(field, uv);
//   float code = floor(t.r * 255.0 + 0.5) * 256.0 + floor(t.g * 255.0 + 0.5);
//   float value = uOffset + uScale * code;   // discard if code == 0.0
```

For CPU-side work, such as sampling a value under the cursor, draw the image to a canvas with
`createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })` and decode the same way.

## Running it on a schedule (later; hosting not decided)

Deployment is on hold. AWS is the likely host, for example a scheduled job that writes to S3 behind CloudFront.
Whatever runs it should:

1. Run `ukv_to_grid.py` for the chosen parameters and steps after each new run lands, which is about 3 to 6
   hours after the run time.
2. Use a fixed `--range` per parameter, so that all timesteps share one encoding and an animation can blend
   between frames in the shader.
3. Watch the size. Each field at each step is about 1.4 MB, so 3 parameters over 24 hourly steps comes to about
   100 MB per run. `--stride 2` (4 km) cuts each file to a quarter. Cropping to the British Isles would help more,
   and the script could add a `--bbox` option for it.

## Attribution

Show "Contains Met Office data © Crown copyright, licensed under CC BY-SA 4.0" in the app. The JSON sidecar
carries this string.

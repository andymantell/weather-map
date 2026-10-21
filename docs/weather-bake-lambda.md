# Baking many hours with Lambda, and fresher data

Two questions from Andy on 21 October 2026:

1. What would it cost to run a Lambda that processes several hours of UKV into a small format with just the data the
   app needs, and serve that from our own bucket?
2. Is there a data source with less lead time than the public UKV bucket, which lags its runs by over three hours?

Short answers:

1. **About $0.20 to $0.30 a month**, almost all of it S3 write requests. A Lambda that bakes every hour of each new
   run fits inside the always-free Lambda allowance with lots of room to spare. A baked hour is **2.7 MB**
   (or 6.4 MB at full 8-bit precision), against 12 MB read directly from the Met Office files, so a visitor gets
   12 hours of clouds for about what one hour costs today.
2. **For rain, yes**: the Met Office radar composite is in a public bucket within about 5 minutes of each
   15-minute scan. **For the model, only the paid route is fresher**: Weather DataHub delivers UKV about 1 h 20 min
   after the run time, about two hours sooner than the public bucket, but it needs a key and the free plan's
   1 GB a month is far too small.

## 1. A Lambda bake

### What the app needs per timestep

The same data `src/weather/ukvLive.ts` builds, already cropped to the terrain (541 × 681 cells at 2 km):

| Pack | Contents | Cadence |
|---|---|---|
| Hourly | 3D cloud fraction on 30 slices of 200 m, cloud base, high cloud | every hour |
| Quarter-hourly | precipitation rate, CAPE | every 15 minutes |

### Measured: size of one hour

From the 14Z run, valid 18Z, compressed with the browser's own decompressors in mind (`gzip` is decoded natively by
`fetch` when served with `Content-Encoding: gzip`, and `DecompressionStream` also does gzip):

| Data | Raw | gzip -6 | brotli -9 |
|---|---|---|---|
| Cloud volume, 8-bit (as baked today) | 11.1 MB | 6.20 MB | 5.70 MB |
| Cloud volume, 4-bit (16 levels of cover, one value per byte) | 11.1 MB | 2.47 MB | 2.34 MB |
| Cloud base + high cloud, 8-bit, one plane each | 0.74 MB | 0.22 MB | 0.21 MB |
| Rain + CAPE, 8-bit, one plane each | 0.74 MB | 0.24 MB | 0.23 MB |

For comparison, today's PNG atlas for the volume is 4.9 to 5.4 MB, and reading the same hour straight from the
Met Office files costs 12.3 MB (see [in-browser-netcdf.md](in-browser-netcdf.md)).

Two notes on the 4-bit volume. UKV stores cloud fraction to 0.01, so 16 levels throws real precision away, but the
shader adds its own noise detail on top and cloud edges are soft, so I expect it to be hard to see. That is a guess
until it's rendered side by side. Splitting the 2D fields into separate planes rather than interleaved RGBA saves
about a third, because each field compresses better on its own.

So one hour of data is about **2.7 MB** (4-bit) or **6.4 MB** (8-bit) for the hourly pack, plus **0.24 MB** per
quarter hour.

### Measured: compute for one hour

On this container (4 cores, one used), with the files already downloaded:

| Step | CPU time |
|---|---|
| Read and inflate the cropped volume (levels 75 m to 6 km) with netCDF4 | 0.49 s |
| Resample to 30 uniform slices and quantise | 0.26 s |
| gzip the volume | 0.56 s |
| Read the four 2D fields | 0.04 s |
| **Total** | **1.3 s**, peak memory 200 MB |

The existing `ukv_clouds.py` took 7.5 s of CPU and 12 s wall for the same hour, mostly because it writes optimised
PNGs. Downloading the whole files from inside eu-west-2 is about 25 MB per hour plus 1.6 MB per quarter. I haven't
measured Lambda's download speed, so the estimate below assumes a slow 10 MB/s.

The bake could also run on Node in Lambda reusing `src/data/hdf5.ts` and the bake code in `ukvLive.ts`: Node 22
has `fetch` and `DecompressionStream`, so it would need no dependencies and no container image.

### The design

```
Met Office bucket ──(new run lands)──▶ EventBridge Scheduler, every 15 min
                                          │
                                          ▼
                              Lambda (arm64, 2 GB): newest complete run?
                              if new: bake every hour and quarter hour it covers
                                          │
                                          ▼
              our S3 bucket  weather/<run>/hour-<valid>.bin.gz      (≈2.7 MB)
                             weather/<run>/quarter-<valid>.bin.gz   (≈0.24 MB)
                             weather/latest.json                    (run, steps; short cache time)
                                          │
                                          ▼
                              CloudFront (flat-rate Free plan) ──▶ browser
```

- Most runs go to T+12 and arrive about T+3h15, so each run gives about **10 hours ahead** of now: 10 hourly packs
  and 37 quarter packs. The 54- and 120-hour runs (00, 03, 06, 09, 12, 15, 18 and 21Z, per the
  [AWS registry](https://registry.opendata.aws/met-office-uk-deterministic/)) could go further, but each new
  hourly run replaces them anyway.
- The packs are immutable, so they can be cached forever. Only `latest.json` changes.
- A lifecycle rule deletes runs after a day, so storage stays at one or two runs.
- Instead of polling, the Lambda could subscribe to the bucket's SNS topic
  (`arn:aws:sns:eu-west-2:633885181284:met-office-atmospheric-model-data-object_created`). That would start the bake
  as soon as the last file lands rather than up to 15 minutes later. It sends one message per file, about 30,000 to
  60,000 a day, so it would need a filter for the last file of each run. Polling is simpler.

### The cost

Assumptions: 24 runs a day (720 a month), 10 hours and 37 quarters per run, 4-bit volume.

| Item | Working | Per month |
|---|---|---|
| Lambda compute | per run: 10 h × (1.3 s bake + 2.5 s download) + 37 × 0.3 s + 5 s start ≈ 55 s × 2 GB = 110 GB-s; × 720 = **79,000 GB-s**. Polling: 2,880 × 1 s × 0.5 GB = 1,440 GB-s. Free allowance is 400,000 GB-s and 1M requests a month | **$0** (would be $1.34 at $0.0000166667/GB-s with no allowance) |
| EventBridge Scheduler | 2,880 invocations; 14M a month are free | $0 |
| Reading the Met Office bucket | same region, no transfer charge | $0 |
| S3 PUTs | (10 + 37 + 1) × 720 = 34,600 × $0.0053 per 1,000 | **$0.18** |
| S3 storage | two runs ≈ 0.1 GB × $0.024 | under $0.01 |
| CloudFront | flat-rate Free plan, 100 GB and 1M requests included, no overage charges | $0 |
| CloudWatch logs | a few lines per run, inside the 5 GB free | $0 |
| **Total** | | **about $0.20** |

Packing the four quarters of each hour into the hourly file would cut the PUTs to about 8,000 ($0.04), at the cost
of downloading a whole hour of rain to see one quarter. With an 8-bit volume the storage and transfer double but the
bill doesn't move. Even if the bake took five times longer than measured, compute would stay inside the free
allowance.

Prices: [Lambda](https://aws.amazon.com/lambda/pricing/) (US East x86 rate; I couldn't find the London arm64 rate,
but it doesn't matter while we're inside the free allowance),
[EventBridge](https://aws.amazon.com/eventbridge/pricing/), and the S3 and CloudFront figures already in
[hosting-architecture.md](hosting-architecture.md).

### What a visitor downloads

| Visit | Direct from the Met Office (today's `?live`) | From our bucket (4-bit) | From our bucket (8-bit) |
|---|---|---|---|
| The next hour, starting on the hour | 28.9 MB | 2 × 2.7 + 5 × 0.24 = **6.6 MB** | 14 MB |
| The next hour, any other time | 41.0 MB | 3 × 2.7 + 5 × 0.24 = **9.3 MB** | 20 MB |
| All 10 hours ahead | about 155 MB | 10 × 2.7 + 37 × 0.24 = **36 MB** | 73 MB |

At 7 to 10 MB a visit, CloudFront's free 100 GB covers about 10,000 visits a month before it starts serving more
slowly (it never bills more). It also takes the load off the Met Office bucket, which was the open question in
[hosting-architecture.md](hosting-architecture.md).

The bake doesn't make the data any fresher. It can only start once the run is in the public bucket.

## 2. Fresher data

What "lead time" means here: at 19:00 UTC the newest UKV run in the public bucket is 15Z, so "the next hour" is that
run's T+4 to T+5 forecast. The weather shown is still for the right time, just from an older run. For a toy that's
mostly fine, but the rain in particular can be visibly off.

| Source | How fresh | Cost and access | What it gives |
|---|---|---|---|
| Public UKV bucket (today) | Files land 3 h 15 min to 3 h 30 min after the run time (measured, S3 `LastModified`, runs 00Z to 14Z on 21 Oct) | Free, no key, CORS open | Everything, incl. the 3D cloud volume |
| [Met Office Weather DataHub](https://datahub.metoffice.gov.uk/support/model-run-status/atmospheric), same UKV model | Expected 1 h 20 min to 2 h after the run time. The 17Z run was available at 18:18 on 21 Oct, so about **2 hours fresher** | API key. Free plan 1 GB a month; paid from £15 for 10 GB a month up to £128 for 100 GB ([pricing](https://datahub.metoffice.gov.uk/pricing/atmospheric)). GRIB2 | Same model fields. I haven't checked file sizes or whether the 3D cloud field is offered, but even a few GB of cloud volume a day would need a paid plan |
| [Met Office radar on AWS](https://registry.opendata.aws/met-office-uk-radar-observations/), `met-office-radar-obs-data` | Every 15 minutes, file in the bucket about **5 minutes** after its time (the 18:45 file landed at 18:50:32) | Free, no key, CORS `*` (checked), CC BY-SA | Observed surface rain rate, 1 km, 1,725 × 2,175 on the British National Grid, 1.1 MB per HDF5 file. Rain only, observed not forecast |
| [DataHub Map Images](https://datahub.metoffice.gov.uk/pricing/map-images) | Not stated | Free, 1,000 images a day, API key | PNG pictures of precipitation rate, total cloud, temperature and pressure. Pictures rather than data, so less useful for 3D |
| [RainViewer](https://www.rainviewer.com/api/transition-faq.html) | Past 2 hours of radar at 10-minute steps | Free for personal and educational use; nowcast and satellite removed on 1 Jan 2026, zoom capped at 7 | Global radar tiles at low zoom |

I couldn't check Open-Meteo or other European models (ICON, AROME, HARMONIE) from here, because the container's
network doesn't reach Open-Meteo. So I'm not claiming anything about them. Open-Meteo would in any case give point
and surface data, not a 3D cloud volume.

### What I'd do with this

- **Radar for "now", UKV for the hour ahead.** At the start of the timeline, draw the rain from the latest radar
  scan (5 minutes old), and blend into the UKV forecast over the first 30 to 60 minutes. Rain is what changes fastest
  and what people would notice being wrong, and radar costs nothing. Clouds stay on UKV, where a few hours' staleness
  is much less visible.
- The radar files are HDF5 too, but an older layout (superblock version 0) than `src/data/hdf5.ts` handles. Either
  extend the reader or let the Lambda bake convert them as well (1.1 MB in, roughly 0.2 MB out every 15 minutes:
  2,880 more runs and PUTs a month, about $0.02).
- DataHub is the only way to get the model two hours fresher. It isn't free at the volume the clouds need, and
  since Andy works at the Met Office, it's worth asking whether there's a sanctioned way to use it for a hobby
  project, alongside the question already planned about direct bucket reads.

## Next steps

1. Render a 4-bit volume next to the 8-bit one to see if the difference shows.
2. Build the bake as a Node Lambda reusing the browser code, write packs to a local folder first, and point `?live`
   at it.
3. Add the radar layer for the first part of the timeline.

# Hosting architecture and running costs

How the weather map could run in production for close to nothing, once the UK-wide terrain bake
(see [terrain-bake-handoff.md](terrain-bake-handoff.md)) exists. This is research and a
recommendation, not a deployment. Prices were read from the providers' pricing pages on
21 October 2026 and are in US dollars.

Andy's constraints for this, from the project thread on 21 October 2026:

- It's a toy for fun, so there must be no risk of a big bill.
- Anything that can run in the browser probably should.
- Web is preferred. A native Godot app was raised as an option to weigh (covered at the end).

## Recommendation in one paragraph

Make the whole thing static. The browser fetches Met Office NetCDF straight from the two public
AWS buckets and decodes it itself, so there is **no scheduled server job at all**. The app and
the ~10 GB of terrain tiles sit in one private S3 bucket in London behind one CloudFront
distribution on CloudFront's **flat-rate Free plan** ($0/month, no overage charges). The only
expected charge is a few cents a month of S3 storage above the plan's included 5 GB. The app
itself could equally go on GitHub Pages for free, with only the tiles on CloudFront (see
[GitHub Pages for the app](#github-pages-for-the-app)). If the map
ever gets popular, move to the flat-rate Pro plan at $15/month, which still can't run away. A
Lambda job that pre-bakes the weather textures is kept as a fallback, and it would also sit
inside the free tier.

## Finding: the browser can read the Met Office buckets directly

The scheduled job was the only reason the app needed a server. I checked both buckets from the
command line on 21 October 2026 with an `Origin` header and a CORS preflight:

```
met-office-atmospheric-model-data   Access-Control-Allow-Origin: *
met-office-nws-wave-model-data      Access-Control-Allow-Methods: HEAD, GET
                                    Access-Control-Allow-Headers: range
```

Both answer listing requests (`?list-type=2`) and object GETs with these headers, and the
preflight allows the `Range` header. So a page on any domain can list runs, find the newest one
that has the hour it needs, and download whole files or byte ranges of them.

What the browser would have to do, and what I measured about the files:

| Step | Notes |
| --- | --- |
| Find the latest run | `GET /?list-type=2&prefix=uk-deterministic-2km/&delimiter=/&start-after=uk-deterministic-2km/<today>`. Listing is oldest first and pages at 1,000 keys, so `start-after` is needed. Runs appear 3 to 6 hours late (see [ukv-data-access.md](ukv-data-access.md)), so check the run actually has the step. |
| Read NetCDF | The files are NetCDF4, i.e. HDF5. UKV fields use zlib level 1 in 128 × 128 chunks with no shuffle. Wave fields hold 24 hourly steps per file, one chunk per step, zlib with shuffle. zlib can be inflated with the browser's built-in `DecompressionStream("deflate")`. |
| 2D UKV fields | 0.4 to 0.9 MB each (precipitation, cloud base, high cloud, CAPE for the 09Z run, T+3). Small enough to download whole. |
| 3D cloud volume | `cloud_amount_on_height_levels` is 20.9 MB, shape 33 × 970 × 1042. The terrain's extent covers 30 of the 72 chunk columns, so reading only those chunks by range would fetch roughly 40% of it. |
| Waves | The seven fields `wave_to_grid.py` uses are 11 to 25 MB per file (a whole day each). Downloading whole files would be about 100 MB per visit, so here range-reading the one hourly chunk per field (about 0.5 MB each) is essential. |
| Reproject and pack | The Python crops UKV (already on the app's LAEA grid) and resamples the waves from lat/lon to LAEA. In the browser this can be done in JS or in a shader, and the float data can go straight into textures without the 8/16-bit PNG packing. |

Open points, not yet prototyped:

- Reading HDF5 needs a library or a small custom reader. `h5wasm` (HDF5 compiled to
  WebAssembly) and `jsfive` (pure JS) both read from a whole file in memory according to their
  READMEs. That's fine for the 2D fields. Range-reading the cloud volume and the wave chunks needs
  the chunk index from the HDF5 B-tree, which means either a small custom reader or a library I
  haven't verified. This is the first thing to prototype.
- Visitor download size goes up. The pre-baked weather textures in `public/data` total about
  7 MB. Direct reads would be roughly 12 to 25 MB per visit, depending on how much range reading
  works. That traffic comes out of the Met Office's open-data bucket, which AWS's Open Data
  programme pays for, not us.
- The data is "free and unsupported" (the AWS registry entry). If the bucket layout changes,
  the app breaks until it's fixed. For a toy that's acceptable.

Sources: [AWS registry entry for UKV](https://registry.opendata.aws/met-office-uk-deterministic/),
[sea-state-research.md](sea-state-research.md), [ukv-data-access.md](ukv-data-access.md).

## Architecture

```
                 visitor's browser
       ┌───────────────┴────────────────┐
       │                                │
       ▼                                ▼
 CloudFront (flat-rate Free plan)   Met Office open-data buckets (eu-west-2)
       │  origin access control       met-office-atmospheric-model-data
       ▼                              met-office-nws-wave-model-data
 private S3 bucket, eu-west-2         (listed and range-read directly, CORS *)
   /index.html, /assets/*  app
   /data/*                 heightmap etc.
   /detail/index.json      tile manifest
   /detail/<x_y>/<file>    ~1,100 terrain tiles, ~10 GB
```

- **One bucket, one distribution.** Keep the bucket private and let CloudFront read it through
  origin access control, so nobody can bypass the CDN and run up S3 GET or egress charges.
- **Caching.** Vite already hashes asset names, so `assets/*` and tiles can be cached for a year.
  Only `index.html` and `detail/index.json` need short cache times. Give the tile files a version
  in their path (e.g. `/detail/v1/`) so a rebake doesn't need an invalidation.
- **Compression.** I gzipped Plymouth's tile: 15.8 MB became 12.9 MB, an 18% saving, mostly
  on the `.bin` files (the PNG and JPEG don't shrink). CloudFront only auto-compresses listed
  content types, so if it's worth it, store the `.bin` files pre-gzipped with
  `Content-Encoding: gzip` at upload time. It's a small win, not a priority.
- **Upload.** `aws s3 sync` from the big machine after the bake. About 11,000 PUTs
  (1,100 tiles × ~10 files) at $0.0053 per 1,000 is about $0.06, and inbound transfer is free.
- **Domain.** Optional. The `*.cloudfront.net` address works with HTTPS for free. The flat-rate
  plans include Route 53 DNS and a TLS certificate. A domain name itself would be extra.
- **Guard rails.** Turn on an AWS Budgets alert at a few dollars anyway.

### Why not the other compute options

With browser-side processing there is no compute to choose. If the fallback below is ever
needed, Lambda is the right fit: the job is small, hourly and short. Fargate and Batch exist for
longer or heavier jobs, and they'd add cost and setup for no benefit here, so I haven't priced
them.

## Costs

### Prices used

| Item | Price | Source |
| --- | --- | --- |
| CloudFront flat-rate **Free** plan | $0/month: 1M requests, 100 GB transfer, 5 GB S3 storage included, no overage charges | [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/) |
| CloudFront flat-rate **Pro** plan | $15/month: 10M requests, 50 TB transfer, 50 GB S3 storage included | same |
| Past a flat-rate allowance | No charge. AWS says you "may experience reduced performance", e.g. serving from fewer or more distant edge locations. Up to three Free plans per account. | [AWS blog, 18 Nov 2025](https://aws.amazon.com/blogs/networking-and-content-delivery/introducing-flat-rate-pricing-plans-with-no-overages) |
| CloudFront pay-as-you-go | Always free each month: 1 TB out, 10M requests. Then $0.085/GB (US and Europe, up to 10 TB) and $0.0120 per 10,000 HTTPS requests in Europe | [CloudFront pay-as-you-go](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/) |
| S3 Standard, London | $0.024/GB-month, PUT $0.0053 per 1,000, GET $0.0042 per 10,000 | AWS Price List API, `AmazonS3/current/eu-west-2`, published 15 Oct 2026 |
| S3 transfer | Free to CloudFront, and free to any AWS service in the same region | [S3 pricing](https://aws.amazon.com/s3/pricing/) |
| Lambda | 1M requests and 400,000 GB-s free per month. Then $0.20 per 1M requests and $0.0000166667 per GB-s (x86, US East example) | [Lambda pricing](https://aws.amazon.com/lambda/pricing/) |
| EventBridge Scheduler | 14M invocations free per month | [EventBridge pricing](https://aws.amazon.com/eventbridge/pricing/) |
| New AWS accounts | Up to $200 credits; the Free account plan lasts up to 6 months | [AWS Free Tier](https://aws.amazon.com/free/) |

### What a visit costs us

These are assumptions, not measurements. The bake hasn't run, and the app doesn't stream tiles
yet.

- The app shell (JS gzipped about 0.25 MB per `vite build` today) plus the coarse heightmap and
  other base data: about 2 MB.
- A tile averages about 9 MB if the bake lands at ~10 GB over ~1,100 tiles. Plymouth (a city)
  is 16 MB and Kielder (rural) is 5.6 MB.
- A **typical visit** is taken as 25 MB and about 50 requests: the base data plus two or three
  places explored at ground level. A map-only visit would be about 2 MB, and a long explore
  could be 150 MB or more.
- Weather data costs us nothing in the recommended setup, because it comes from the Met Office
  buckets.

### Monthly cost by traffic

At 25 MB and 50 requests per visit, with 10 GB of tiles stored:

| Visits a month | Transfer | Requests | Flat-rate Free | Flat-rate Pro | Pay-as-you-go |
| --- | --- | --- | --- | --- | --- |
| 100 | 2.5 GB | 5k | about $0.12 | $15 | about $0.24 |
| 1,000 | 25 GB | 50k | about $0.12 | $15 | about $0.24 |
| 10,000 | 250 GB | 0.5M | about $0.12, but past the 100 GB allowance, so slower | $15 | about $0.24 |
| 100,000 | 2.5 TB | 5M | about $0.12, slower | $15 | about $128 |
| 1,000,000 | 25 TB | 50M | about $0.12, slower | $15, past 10M requests, so slower | about $2,090 |

How these are worked out:

- Flat-rate Free: 10 GB stored minus 5 GB included is 5 GB × $0.024 = $0.12. S3 GETs on cache
  misses add at most $0.42 even if all 1M allowed requests missed the cache.
- Pay-as-you-go: storage is 10 GB × $0.024 = $0.24. 100,000 visits is 1,500 GB past the free
  1 TB, × $0.085 ≈ $128. 1,000,000 visits is 24,000 GB × $0.085 = $2,040 plus 40M extra requests
  × $0.012 per 10k = $48.

The table shows why flat-rate is the right choice for a toy. Pay-as-you-go is cheaper than Pro
until roughly 175 GB past the free terabyte, but it is uncapped. A single viral week could cost
hundreds of dollars. Flat-rate Free can't charge more than the few cents of storage, and the
worst case is a slower CDN.

### Fallback: pre-bake the weather with Lambda

If direct browser reads turn out too slow, too heavy for phones, or the Met Office bucket stops
allowing them, run the existing `pipeline/` scripts hourly in Lambda (a container image, since
`netCDF4` and `pyproj` are large) in eu-west-2, triggered by EventBridge Scheduler, writing the
PNG+JSON into the same bucket under `/weather/latest/`.

- Assume one 60-second run a hour at 2 GB memory. That's not measured. 720 runs × 60 s × 2 GB
  = 86,400 GB-s a month, inside the 400,000 GB-s free tier. Without the free tier it would be
  $1.44.
- Reading the Met Office bucket from Lambda in the same region has no transfer charge.
- About 4,000 PUTs a month comes to about $0.02.
- The textures add about 7 MB a visit to our CloudFront transfer, which uses up the Free plan's
  100 GB sooner (about 3,000 visits instead of 4,000).

## Cheaper or different: outside AWS

Andy said he's open to other ideas. The one worth knowing about:

- **Cloudflare R2** charges nothing for egress, and its free tier includes 10 GB-month of
  storage, 1M Class A (write) and 10M Class B (read) operations a month. Beyond that it's
  $0.015/GB-month and $0.36 per million reads. Production use needs a custom domain added to
  Cloudflare, because the `r2.dev` address is rate-limited and meant for development.
  ([R2 pricing](https://developers.cloudflare.com/r2/pricing/),
  [R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/))

  With the bake at about 10 GB, this sits right on the free storage limit, and egress is never
  charged. Compared with CloudFront's Free plan, it doesn't slow down at 100 GB. The costs are a
  domain and a second provider to manage. If traffic ever passes what the AWS Free plan handles
  well and $15/month feels like too much, this is the move. Otherwise AWS flat-rate Free is
  simpler and also $0.

## GitHub Pages for the app

Now that no server job is needed, GitHub Pages can host the app itself for free. It can't hold
the terrain tiles, though
([GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits),
[large files on GitHub](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)):

- Published sites may be no larger than 1 GB, and source repositories have a recommended limit
  of 1 GB. GitHub "strongly recommends" repositories stay under 5 GB, and blocks single files
  over 100 MiB. The bake is estimated at about 10 GB.
- Bandwidth has a soft limit of 100 GB a month, the same as CloudFront's Free plan, and
  "rate limits may apply" (HTTP 429).

Splitting the tiles across ten or more repositories would get round the size limit, but it's a
hack against the spirit of the limits, and every rebake would mean huge git pushes.

So the cheapest split is:

- **App on GitHub Pages** (free, deploys from `main` with a GitHub Actions workflow).
- **Tiles on object storage** with CORS allowing the Pages origin: S3 behind CloudFront's
  flat-rate Free plan (about $0.12 a month), or Cloudflare R2 (free up to 10 GB, no egress
  charges, but needs a domain on Cloudflare).

Keeping the app on CloudFront too is only worth it for a single domain and a single place to
deploy. Pages is the simpler free option for the app.

## A Godot desktop app instead?

Andy asked what a full rewrite as a Godot executable would gain, especially for live data.

**What it would gain**

- **Rendering headroom.** Desktop Godot 4 renders with Vulkan, Direct3D 12 or Metal and has
  compute shaders, volumetric fog and global illumination built in. WebGL 2, which the app uses
  today, has no compute shaders.
- **Local caching.** The tiles could be downloaded once and kept on disk, or even baked on the
  player's own machine from the same public sources, which would remove tile hosting entirely.
  That would be slow (the bake handoff measured minutes per tile in the cloud), so it isn't
  realistic for a first run.
- **Live data: nothing over the web version.** The thing a native app is usually needed for,
  getting around CORS, isn't a problem here, because both Met Office buckets already allow
  browser reads. A desktop app would still need an HDF5/NetCDF reader, as a GDExtension wrapping
  the C libraries or a .NET library from C#, which is more work than the browser route.

**What it would cost**

- **A full rewrite** of everything built so far: the cloud raymarcher, sea, rain, terrain
  streaming and camera rig, all in Godot's shading language and scenes.
- **No link to share.** People would have to download, install and trust an unsigned executable
  (or Andy pays for code-signing), and there'd be builds per platform and an update story.
- **Godot's web export doesn't help.** Godot 4 web builds can only use the Compatibility
  renderer on WebGL 2, Godot 4 doesn't support WebGPU yet, and C# projects can't export to the
  web at all ([Godot docs: Exporting for the Web](https://github.com/godotengine/godot-docs/blob/master/tutorials/export/exporting_for_web.rst)).
  A Godot web build would look worse than the current Three.js app.
- **Hosting doesn't disappear.** The 10 GB of tiles still has to be served from somewhere
  unless it's baked on each player's machine.

**The middle way** for the rendering gains is Three.js's WebGPU renderer, which ships in the
version the app already uses (`three/webgpu` in three 0.186) and brings compute shaders to the
browser. WebGPU is available in Chrome and Edge (Windows, macOS, ChromeOS, some Android),
Safari 26, and Firefox 141+ on Windows, but not yet on Linux in any of them
([web.dev, 25 Nov 2025](https://web.dev/blog/webgpu-supported-major-browsers)).

Verdict: stay on the web. Godot would trade a free, shareable link for a rewrite and gain
nothing on live data. If a rendering technique ever needs compute, try the WebGPU renderer first.

## Next steps

1. Prototype the in-browser reader on the 2D UKV fields first (whole-file reads), then range
   reads for the cloud volume and wave chunks. Measure download size and decode time on a
   phone and on the laptop.
2. Point the app at a configurable data base URL (the bake handoff already proposes
   `VITE_DETAIL_URL`) so the same build works locally and on CloudFront.
3. When the bake is done and Andy says go: create the bucket and distribution, choose the Free
   flat-rate plan, upload, and add a budget alert.

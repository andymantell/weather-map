"""Bake the detailed terrain for the whole of Great Britain (see docs/terrain-bake-handoff.md).

Splits GB into 16 km tiles on the app's LAEA grid (build_area.TILE_M, ids "<i>_<j>") and runs
the per-area scripts on each, in a pool of worker processes:

    fetch_external.py   lidar (England only), woodland and habitat maps
    build_area.py       heights, ground mesh, cover, buildings, trees
    build_masses.py     merged street blocks
    build_imagery.py    Sentinel-2 colour
    build_boundaries.py hedges and walls
    build_roads.py      road centrelines

Tiles are written to .cache/bake/<id>/ (outside git), and .cache/bake/index.json lists the
finished ones. Before the pool starts, a one-off preparation step downloads the UK extract of
every Overture layer the scripts read into .cache/detail/uk/ (an Overture bbox query scans the
footer of every file worldwide, which would cost minutes per tile), lists the tiles that touch
GB's land and lists the Sentinel-2 scenes of every tile.

Stop it at any time (Ctrl+C or close the window) and run it again to carry on: each step of
each tile is recorded when it finishes, and only unfinished steps run again. Every cache file is
written via a temporary file, so a stop never leaves a half-written one. Tiles that fail are
logged to .cache/bake/failed.json (per-tile logs in .cache/bake/logs/) and retried next run.

Usage:
    python scripts/detail/bake_uk.py                    # everything, one worker per core but one
    python scripts/detail/bake_uk.py --prep-only        # just the UK extracts, tile and scene lists
    python scripts/detail/bake_uk.py --tiles=-8_-32     # only these tiles (comma separated)
    python scripts/detail/bake_uk.py --tile-at=-4.14,50.37   # print the tile id at a lon,lat
"""

import argparse
import ctypes
import datetime
import json
import os
import pathlib
import random
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import psutil
import pyarrow as pa
import pyarrow.dataset as ds
import pyarrow.fs as pafs
import pyarrow.parquet as pq
import shapely

import build_area as ba

HERE = pathlib.Path(__file__).resolve().parent
LOGS = ba.BAKE / "logs"
UK_BBOX = (-8.7, 49.8, 1.9, 60.9)

# Every Overture layer the scripts read, with the union of the columns they use.
LAYERS = {
    "land": ("base", ["subtype", "class", "source_tags", "geometry"]),
    "land_cover": ("base", ["subtype", "cartography", "geometry"]),
    "land_use": ("base", ["subtype", "class", "geometry"]),
    "water": ("base", ["subtype", "class", "geometry"]),
    "infrastructure": ("base", ["subtype", "class", "geometry"]),
    "building": ("buildings", ["height", "num_floors", "class", "sources", "geometry"]),
    "segment": ("transportation", ["subtype", "class", "road_flags", "road_surface", "width_rules", "geometry"]),
    "division_area": ("divisions", ["subtype", "class", "country", "region", "geometry"]),
}
STEPS = [
    ("external", "fetch_external.py"),
    ("area", "build_area.py"),
    ("masses", "build_masses.py"),
    ("imagery", "build_imagery.py"),
    ("boundaries", "build_boundaries.py"),
    ("roads", "build_roads.py"),
]
# Don't start another step while less memory than this is free.
MIN_FREE_GB = 3
# Peak memory of each step (GB, measured over the first hundred tiles; build_area works on a fixed
# 20 km raster, so even rural tiles take most of it). Steps start only while the peaks of those
# running add up to no more than MEMORY_BUDGET_GB, since a step's memory grows for minutes
# after it starts and free memory alone lets a burst of starts overshoot.
PEAK_GB = {"external": 3.3, "area": 5.7, "masses": 2.5, "imagery": 2.0, "boundaries": 0.4, "roads": 0.4}
MEMORY_BUDGET_GB = 86
# .cache/bake/tuning.json, if present, overrides the budget while the bake runs,
# e.g. {"memoryGb": 80}, so it can be tuned without a restart.
TUNING = ba.BAKE / "tuning.json"


def budget():
    return read_json(TUNING, {}).get("memoryGb", MEMORY_BUDGET_GB)
# Steps that peak at several GB (build_area reaches 5.5 GB on a town), and how many of them
# may run at once, so 31 workers can't all be in one at the same moment.
# External's lidar and habitat hosts throttle (403) when asked by many workers at once.
# Imagery mostly waits on Sentinel-2 reads from us-west-2, so it runs in its own slots beside
# the CPU ones, like the lidar.
HEAVY = {"area": 31, "masses": 31, "external": 8, "imagery": 24}
DOWNLOADS = ("external", "imagery")
# Workers run single-threaded maths at below-normal priority, so the desktop stays responsive.
WORKER_ENV = dict(os.environ, OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1", MKL_NUM_THREADS="1",
                  GDAL_CACHEMAX="256", PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
# Own process group, so Ctrl+C reaches only this driver, which then ends the workers itself
# (closing the window still ends them all).
PRIORITY = getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
TILE_ID = re.compile(r"^-?\d+_-?\d+$")


def say(*parts):
    print(f"[{datetime.datetime.now():%H:%M:%S}]", *parts, flush=True)


def read_json(path, default):
    try:
        return json.loads(pathlib.Path(path).read_text())
    except (FileNotFoundError, ValueError):
        return default


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    ba.write_atomic(path, lambda p: p.write_text(json.dumps(data, indent=1)))


# --- Preparation -------------------------------------------------------------


def s3():
    return pafs.S3FileSystem(
        anonymous=True, region="us-west-2",
        proxy_options=os.environ.get("HTTPS_PROXY") or None,
        tls_ca_file_path=os.environ.get("SSL_CERT_FILE") or None,
    )


def morton(x, y):
    """Z-order key of two uint16 arrays, so sorting by it keeps nearby cells together."""
    def spread(v):
        v = v.astype(np.uint64) & 0xFFFF
        v = (v | (v << 8)) & 0x00FF00FF
        v = (v | (v << 4)) & 0x0F0F0F0F
        v = (v | (v << 2)) & 0x33333333
        return (v | (v << 1)) & 0x55555555
    return spread(x) | (spread(y) << 1)


def large(t):
    """The same Arrow type with 64-bit offsets throughout."""
    if pa.types.is_binary(t):
        return pa.large_binary()
    if pa.types.is_string(t):
        return pa.large_string()
    if pa.types.is_list(t):
        return pa.large_list(pa.field(t.value_field.name, large(t.value_type)))
    if pa.types.is_struct(t):
        return pa.struct([pa.field(f.name, large(f.type)) for f in t])
    return t


def extract(kind):
    """Downloads the UK part of one Overture layer to .cache/detail/uk/<kind>.parquet.

    One file per Overture fragment goes to <kind>.parts/ first, so a stopped download carries
    on where it was. The result gets flat xmin/xmax/ymin/ymax columns and is sorted in
    Z-order of 0.02 degree cells into small row groups, which build_area.uk_extract() reads.
    """
    path = ba.UK / f"{kind}.parquet"
    if path.exists():
        return
    theme, columns = LAYERS[kind]
    parts = ba.UK / f"{kind}.parts"
    parts.mkdir(parents=True, exist_ok=True)
    dataset = ds.dataset(f"{ba.OVERTURE}/theme={theme}/type={kind}/", filesystem=s3(), format="parquet")
    xmin, ymin, xmax, ymax = UK_BBOX
    f = ((ds.field("bbox", "xmax") > xmin) & (ds.field("bbox", "xmin") < xmax)
         & (ds.field("bbox", "ymax") > ymin) & (ds.field("bbox", "ymin") < ymax))
    if kind == "division_area":
        f = f & (ds.field("country") == "GB")
    fragments = list(dataset.get_fragments())
    done = [0]
    t0 = time.time()

    def fetch(n_fragment):
        n, fragment = n_fragment
        out = parts / f"{n:05d}.parquet"
        if not out.exists():
            table = fragment.to_table(filter=f, columns=columns + ["bbox"])
            ba.write_atomic(out, lambda p: pq.write_table(table, p))
        done[0] += 1
        if done[0] % 10 == 0 or done[0] == len(fragments):
            say(f"  {kind}: {done[0]}/{len(fragments)} files scanned ({time.time() - t0:.0f} s)")

    with ThreadPoolExecutor(32) as ex:
        list(ex.map(fetch, enumerate(fragments)))
    tables = [t for t in (pq.read_table(p) for p in sorted(parts.glob("*.parquet"))) if t.num_rows]
    table = pa.concat_tables(tables, promote_options="permissive")
    del tables
    bbox = table.column("bbox").combine_chunks()
    flat = {k: bbox.field(k).to_numpy(zero_copy_only=False) for k in ("xmin", "xmax", "ymin", "ymax")}
    table = table.drop_columns(["bbox"])
    for k, v in flat.items():
        table = table.append_column(k, pa.array(v))
    cx = np.clip((flat["xmin"] - xmin) / 0.02, 0, 65535).astype(np.uint16)
    cy = np.clip((flat["ymin"] - ymin) / 0.02, 0, 65535).astype(np.uint16)
    order = np.argsort(morton(cx, cy), kind="stable")
    # take() joins the chunks first, and all the UK's buildings overflow Arrow's 32-bit
    # offsets, so sort with 64-bit ones and cast each written slice back.
    schema = table.schema
    big = table.cast(pa.schema([pa.field(f.name, large(f.type)) for f in schema]))
    del table

    def write(p):
        with pq.ParquetWriter(p, schema, compression="zstd") as w:
            for i in range(0, len(order), 500_000):
                w.write_table(big.take(pa.array(order[i:i + 500_000])).cast(schema), row_group_size=8192)

    ba.write_atomic(path, write)
    say(f"  {kind}: {len(order):,} rows, {path.stat().st_size / 1e9:.2f} GB")
    for p in parts.glob("*"):
        p.unlink()
    parts.rmdir()


def tile_list():
    """Tiles touching GB's land, each with whether it touches England (for the lidar)."""
    path = ba.BAKE / "tiles.json"
    if path.exists():
        return read_json(path, None)
    div = pq.read_table(ba.UK / "division_area.parquet")
    rows = div.select(["subtype", "class", "region"]).to_pylist()
    geoms = ba.project(div["geometry"].to_numpy(zero_copy_only=False))
    land = [g for g, r in zip(geoms, rows) if r["subtype"] == "country" and r["class"] == "land"]
    england = [g for g, r in zip(geoms, rows) if r["subtype"] == "region" and r["region"] == "GB-ENG"
               and r["class"] == "land"]
    if not land or not england:
        kinds = sorted({(r["subtype"], r["class"], r["region"]) for r in rows if r["subtype"] in ("country", "region")})
        raise SystemExit(f"GB or England outline not found in division_area; have {kinds}")
    gb, eng = shapely.union_all(land), shapely.union_all(england)
    shapely.prepare(gb)
    shapely.prepare(eng)
    x0, y0, x1, y1 = gb.bounds
    t = ba.TILE_M
    tiles = []
    for j in range(int(np.floor(y0 / t)), int(np.ceil(y1 / t))):
        for i in range(int(np.floor(x0 / t)), int(np.ceil(x1 / t))):
            box = shapely.box(i * t, j * t, (i + 1) * t, (j + 1) * t)
            if gb.intersects(box):
                tiles.append({"id": f"{i}_{j}", "england": bool(eng.intersects(box))})
    write_json(path, tiles)
    say(f"{len(tiles)} tiles touch GB's land, {sum(t['england'] for t in tiles)} of them England")
    return tiles


def list_scenes(tiles):
    """Lists the summer Sentinel-2 scenes of every tile's MGRS tiles once, up front, so the
    workers don't all list the same ones at the start."""
    import build_imagery as bi

    mgrs = sorted({m for t in tiles for m in bi.mgrs_tiles(ba.tile_square(t["id"]))})
    todo = [(m, y) for m in mgrs for y in (bi.RECENT_YEARS, bi.OLDER_YEARS)]
    say(f"listing Sentinel-2 scenes of {len(mgrs)} MGRS tiles")
    with ThreadPoolExecutor(4) as ex:
        for n, _ in enumerate(ex.map(lambda a: bi.scenes(*a), todo), 1):
            if n % 10 == 0:
                say(f"  {n}/{len(todo)} scene lists")


def prepare():
    for kind in LAYERS:
        if not (ba.UK / f"{kind}.parquet").exists():
            say(f"downloading the UK extract of Overture {kind}")
            extract(kind)
    tiles = tile_list()
    list_scenes(tiles)
    return tiles


# --- Running tiles -------------------------------------------------------------


def kill_stale():
    """Ends build-script processes left running by a bake that was killed, which Windows
    doesn't stop along with their parent."""
    me = os.getpid()
    for p in psutil.process_iter(["pid", "cmdline"]):
        cmd = p.info["cmdline"] or []
        if p.info["pid"] == me or len(cmd) < 3:
            continue
        if any(pathlib.Path(c).name in dict(STEPS).values() for c in cmd) and any(TILE_ID.match(c) for c in cmd):
            say(f"stopping leftover worker {p.info['pid']}: {' '.join(cmd[-2:])}")
            try:
                p.kill()
            except psutil.Error:
                pass


class Bake:
    def __init__(self, tiles, workers, keep_cache):
        self.tiles = tiles
        self.workers = workers
        self.keep_cache = keep_cache
        self.lock = threading.Lock()
        self.procs = set()
        self.stopping = False
        self.running = {}
        self.failed = read_json(ba.BAKE / "failed.json", {})
        self.finished_now = 0
        self.failed_now = 0
        self.start = time.time()
        self.slots = {name: threading.Semaphore(n) for name, n in HEAVY.items()}
        # One slot per worker for the steps that use the CPU. England's lidar downloads wait
        # on the EA's servers, not the CPU, so they run beside these in their own slots.
        self.cpu = threading.Semaphore(workers)
        self.memory = threading.Condition()
        self.reserved = 0.0

    def done(self, tile_id):
        return (ba.BAKE / tile_id / "done.json").exists()

    def step(self, tile_id, name, script, england, log):
        if name == "external":
            # Outside England this only asks the Forestry Commission for woodland: no slot.
            slots = [self.slots["external"]] if england else []
        elif name in DOWNLOADS:
            slots = [self.slots[name]]
        else:
            # The step's own slot first: a tile queued for one mustn't sit on a CPU slot meanwhile.
            slots = ([self.slots[name]] if name in self.slots else []) + [self.cpu]
        with self.lock:
            self.running[tile_id] = f"wait-{name}"
        taken = []
        try:
            for slot in slots:
                while not slot.acquire(timeout=1):
                    if self.stopping:
                        raise KeyboardInterrupt
                taken.append(slot)
            with self.lock:
                self.running[tile_id] = name
            return self.launch(tile_id, name, script, england, log)
        finally:
            for slot in taken:
                slot.release()

    def launch(self, tile_id, name, script, england, log):
        need = PEAK_GB.get(name, 1.0)
        with self.memory:
            while (self.reserved + need > budget()
                   or psutil.virtual_memory().available < MIN_FREE_GB * 1e9):
                if self.stopping:
                    raise KeyboardInterrupt
                self.memory.wait(timeout=5)
            self.reserved += need
        try:
            return self.run_step(tile_id, name, script, england, log)
        finally:
            with self.memory:
                self.reserved -= need
                self.memory.notify_all()

    def run_step(self, tile_id, name, script, england, log):
        args = [sys.executable, "-u", script, tile_id]
        if name == "external" and not england:
            args.append("--skip-lidar")
        log.write(f"\n=== {name} {datetime.datetime.now():%Y-%m-%d %H:%M:%S}\n")
        log.flush()
        t0 = time.time()
        proc = subprocess.Popen(args, cwd=HERE, stdout=log, stderr=subprocess.STDOUT, env=WORKER_ENV,
                                creationflags=PRIORITY)
        with self.lock:
            self.procs.add(proc)
        peak = 0
        try:
            ps = psutil.Process(proc.pid)
            while proc.poll() is None:
                try:
                    peak = max(peak, ps.memory_info().rss)
                except psutil.Error:
                    pass
                time.sleep(1)
        finally:
            with self.lock:
                self.procs.discard(proc)
        if proc.returncode != 0:
            raise RuntimeError(f"{name} exited with {proc.returncode}")
        return {"s": round(time.time() - t0, 1), "peakMB": round(peak / 1e6)}

    def run_tile(self, tile):
        tile_id = tile["id"]
        tdir = ba.BAKE / tile_id
        tdir.mkdir(parents=True, exist_ok=True)
        steps = read_json(tdir / "steps.json", {})
        with self.lock:
            self.running[tile_id] = "starting"
        LOGS.mkdir(parents=True, exist_ok=True)
        try:
            with open(LOGS / f"{tile_id}.log", "a", encoding="utf-8") as log:
                for name, script in STEPS:
                    if name in steps:
                        continue
                    with self.lock:
                        self.running[tile_id] = name
                    steps[name] = self.step(tile_id, name, script, tile["england"], log)
                    write_json(tdir / "steps.json", steps)
            write_json(tdir / "done.json", {"steps": steps, "at": time.time()})
            if not self.keep_cache:
                self.clean(tile_id)
            with self.lock:
                self.finished_now += 1
                self.failed.pop(tile_id, None)
                write_json(ba.BAKE / "failed.json", self.failed)
                self.write_index()
            total = sum(s["s"] for s in steps.values())
            say(f"done {tile_id} in {total / 60:.1f} min ({', '.join(f'{k} {v['s']:.0f}s' for k, v in steps.items())})")
        except KeyboardInterrupt:
            pass
        except Exception as error:  # noqa: BLE001 - log the tile and carry on with the rest
            if self.stopping:
                return
            tail = (LOGS / f"{tile_id}.log").read_text(encoding="utf-8", errors="replace").splitlines()[-15:]
            with self.lock:
                self.failed_now += 1
                self.failed[tile_id] = {"error": str(error), "at": time.time(), "tail": tail}
                write_json(ba.BAKE / "failed.json", self.failed)
            say(f"FAILED {tile_id}: {error} (see .cache/bake/logs/{tile_id}.log)")
        finally:
            with self.lock:
                self.running.pop(tile_id, None)

    def clean(self, tile_id):
        """Drops the tile's big intermediate files (lidar, woodland and habitat maps, scenes), which
        nothing reads once it's done. Overture extracts and terrain tiles are shared, so stay."""
        for name in ("ndsm.tif", "dtm.tif", "nfi.geojson", "phi.geojson"):
            (ba.EXTERNAL / f"{tile_id}_{name}").unlink(missing_ok=True)
        x0, _, _, y1 = ba.tile_square(tile_id)
        for p in (ba.CACHE / "imagery").glob(f"*-{x0}-{y1}-scl.npz"):
            p.unlink(missing_ok=True)

    def write_index(self):
        """index.json: every finished tile's extent, files and what it holds."""
        tiles = []
        for tile in self.tiles:
            tdir = ba.BAKE / tile["id"]
            if not (tdir / "done.json").exists():
                continue
            meta = read_json(tdir / "meta.json", {})
            tiles.append({
                "id": tile["id"],
                **{k: meta.get(k) for k in ("xMin", "xMax", "yMin", "yMax", "hasCoast", "buildings", "trees")},
                "roadsKm": (meta.get("roads") or {}).get("km"),
                "imagery": "imagery" in meta,
                "lidar": "Environment Agency" in meta.get("attribution", ""),
                "files": {p.name: p.stat().st_size for p in sorted(tdir.iterdir())
                          if p.is_file() and p.name not in ("done.json", "steps.json")},
            })
        write_json(ba.BAKE / "index.json", {"tileSize": ba.TILE_M, "proj": ba.PROJ, "tiles": tiles})

    def status(self, todo):
        with self.lock:
            running = dict(self.running)
            finished, failed_now = self.finished_now, self.failed_now
        complete = sum(self.done(t["id"]) for t in self.tiles)
        left = len(self.tiles) - complete
        elapsed = time.time() - self.start
        if finished:
            rate = finished / elapsed * 3600
            eta_s = left / (finished / elapsed)
            eta = (f"{rate:.1f} tiles/h, ETA {fmt_duration(eta_s)}"
                   f" (~{datetime.datetime.now() + datetime.timedelta(seconds=eta_s):%a %d %b %H:%M})")
        else:
            eta = "ETA once the first tiles finish"
        steps = {}
        for s in running.values():
            steps[s] = steps.get(s, 0) + 1
        mem = psutil.virtual_memory()
        line = (f"{complete}/{len(self.tiles)} tiles ({complete / len(self.tiles):.1%}) | "
                f"{len(running)} running [{' '.join(f'{k}:{v}' for k, v in sorted(steps.items()))}] | "
                f"{failed_now} failed this run | {eta} | RAM free {mem.available / 1e9:.0f} GB, "
                f"budget {self.reserved:.0f}/{budget()} GB | "
                f"up {fmt_duration(elapsed)}")
        write_json(ba.BAKE / "status.json", {"line": line, "complete": complete, "total": len(self.tiles),
                                             "running": running, "failedThisRun": failed_now, "at": time.time()})
        return line, complete, len(self.tiles)

    def run(self, todo):
        say(f"{len(todo)} tiles to bake with {self.workers} workers"
            f" ({len(self.tiles) - len(todo)} of {len(self.tiles)} already done)")
        # More tiles in hand than workers, so tiles queued for a lidar slot never leave the CPU
        # idle; the slots above keep the real load at `workers` CPU steps and 8 downloads.
        pool = ThreadPoolExecutor(self.workers * 5)
        futures = [pool.submit(self.run_tile, t) for t in todo]
        progress = open(ba.BAKE / "progress.log", "a", encoding="utf-8")
        try:
            last_log = 0
            while not all(f.done() for f in futures):
                line, complete, total = self.status(todo)
                print(f"\r{line}\x1b[K", end="", flush=True)
                set_title(f"terrain bake {complete}/{total} - {line.split(' | ')[3]}")
                if time.time() - last_log > 60:
                    progress.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {line}\n")
                    progress.flush()
                    last_log = time.time()
                time.sleep(2)
            print()
            line, _, _ = self.status(todo)
            say(line)
            progress.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {line}\n")
        except KeyboardInterrupt:
            print()
            say("stopping: ending the running steps. Run again to carry on where this left off.")
            self.stopping = True
            for f in futures:
                f.cancel()
            with self.lock:
                for p in list(self.procs):
                    try:
                        psutil.Process(p.pid).kill()
                    except psutil.Error:
                        pass
            pool.shutdown(wait=True, cancel_futures=True)
            raise SystemExit(1)
        finally:
            progress.close()
        pool.shutdown()
        if self.failed:
            say(f"{len(self.failed)} tiles failed; see .cache/bake/failed.json. Run again to retry them.")


def fmt_duration(s):
    s = int(s)
    d, h, m = s // 86400, s // 3600 % 24, s // 60 % 60
    return f"{d}d {h}h {m:02d}m" if d else f"{h}h {m:02d}m" if h else f"{m}m {s % 60:02d}s"


def set_title(text):
    if os.name == "nt":
        try:
            ctypes.windll.kernel32.SetConsoleTitleW(text)
        except (AttributeError, OSError):
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    parser.add_argument("--tiles", help="comma-separated tile ids to bake instead of all of GB")
    parser.add_argument("--prep-only", action="store_true")
    parser.add_argument("--keep-cache", action="store_true", help="keep each tile's lidar and scene caches")
    parser.add_argument("--tile-at", help="print the id of the tile holding lon,lat and stop")
    args = parser.parse_args()
    if args.tile_at:
        lon, lat = map(float, args.tile_at.split(","))
        x, y = ba.from_lonlat.transform(lon, lat)
        print(f"{int(np.floor(x / ba.TILE_M))}_{int(np.floor(y / ba.TILE_M))}")
        return
    if os.name == "nt":
        psutil.Process().nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
        os.system("")  # turn on ANSI escapes in the Windows console
    kill_stale()
    tiles = prepare()
    if args.prep_only:
        return
    if args.tiles:
        wanted = set(args.tiles.split(","))
        known = {t["id"]: t for t in tiles}
        tiles = [known.get(i, {"id": i, "england": True}) for i in sorted(wanted)]
    todo = [t for t in tiles if not (ba.BAKE / t["id"] / "done.json").exists()]
    # Shuffled (always the same way), so the rate, and the ETA from it, isn't skewed by doing
    # all the busy English towns or all the empty Highlands first.
    random.Random(1).shuffle(todo)
    Bake(tiles, args.workers, args.keep_cache).run(todo)


if __name__ == "__main__":
    main()

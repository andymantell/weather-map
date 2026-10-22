"""Bake the real Milky Way for the night sky from NASA's Deep Star Maps 2020.

NASA/Goddard Space Flight Center Scientific Visualization Studio, "Deep Star Maps 2020" (https://svs.gsfc.nasa.gov/4851),
built from Hipparcos-2, Tycho-2 and Gaia DR2 (ESA/Gaia/DPAC). Two of its plate carree maps in J2000 equatorial
coordinates, linear half-float EXR, are used:

- milkyway_2020_4k.exr: the light of the 1.7 billion stars fainter than Tycho-2's limit (about magnitude 11.5), with
  the Hipparcos and Tycho stars left out. This is the Milky Way as a glow.
- hiptyc_2020_4k.exr: the Hipparcos and Tycho stars alone. Used to calibrate the maps' units against our own
  catalogue (stars.bin), and for the light of the stars between our magnitude-8 limit and Tycho's, folded into the
  glow at a coarse scale.

The maps' units are arbitrary. Two steps set them:

1. Relative: the bright stars in the Hipparcos/Tycho layer, summed over their pixels (weighted by each pixel's solid
   angle, since the maps hold radiance, not flux per pixel), against their V magnitudes. This lines the two layers
   up with our catalogue, so the light of the magnitude 8 to 11.5 stars can be added without double counting.
2. Absolute: the NASA maps' faint light comes out several times brighter than the real sky, so the total starlight
   at the galactic poles (|b| > 75 degrees: our catalogue plus both layers) is scaled to the measured integrated
   starlight there, 24.16 V mag/arcsec^2 (the mean of the north and south galactic poles, 24.24 and 24.08, from
   Mattila et al., arXiv:1011.2941, table 1).

The result is radiance relative to the sun's illuminance per steradian (the sky shader's units), stored log-encoded in
an 8-bit JPEG (public/data/milkyway.jpg) with its range in public/data/milkyway.json.

Usage: pip install -r scripts/requirements.txt && python3 scripts/stars/build_milkyway.py
Run scripts/stars/build_stars.py first. The EXRs (70 MB) are cached in .cache/milkyway/.
"""

import json
import math
import pathlib
import struct
import sys
import urllib.request

import numpy as np
import OpenEXR
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[2]
CACHE = ROOT / ".cache" / "milkyway"
BASE = "https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/"
OUT_IMAGE = ROOT / "public" / "data" / "milkyway.jpg"
OUT_META = ROOT / "public" / "data" / "milkyway.json"
SUN_V = -26.74
LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float64)
# Radiance range kept, relative to sunlight per steradian. The natural night sky is about 1.6e-9, so the floor is
# far below anything visible.
FLOOR = 1e-12
# Coarse block size, in pixels, for the light of the magnitude 8 to 11.5 stars.
BLOCK = 16
# Integrated starlight at the galactic poles, V mag/arcsec^2 (Mattila et al. 2010, arXiv:1011.2941).
POLE_STARLIGHT = 24.16
ARCSEC2 = (math.pi / 180 / 3600) ** 2
NGP = np.array([-0.8676, -0.1981, 0.4560])


def fetch(name: str) -> pathlib.Path:
    path = CACHE / name
    if not path.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        print(f"downloading {name}")
        urllib.request.urlretrieve(BASE + name, path)
    return path


def read_exr(path: pathlib.Path) -> np.ndarray:
    with OpenEXR.File(str(path)) as f:
        channels = f.channels()
        if "RGB" in channels:
            rgb = np.asarray(channels["RGB"].pixels, dtype=np.float64)
        else:
            rgb = np.stack([np.asarray(channels[c].pixels, dtype=np.float64) for c in "RGB"], axis=-1)
    return np.nan_to_num(np.maximum(rgb, 0.0))


def read_catalogue() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    data = (ROOT / "public" / "data" / "stars.bin").read_bytes()
    (n,) = struct.unpack_from("<I", data, 0)
    ra = np.frombuffer(data, "<f4", n, 4).astype(np.float64)
    dec = np.frombuffer(data, "<f4", n, 4 + 4 * n).astype(np.float64)
    mag = np.frombuffer(data, "<i2", n, 4 + 8 * n) / 100.0
    return ra, dec, mag


def pixel_of(ra: np.ndarray, dec: np.ndarray, width: int, height: int, sign: float) -> tuple[np.ndarray, np.ndarray]:
    """Plate carree with 0h at the centre; sign -1 puts right ascension increasing to the left (as seen from inside)."""
    u = np.mod(0.5 + sign * ra / (2 * math.pi), 1.0)
    v = 0.5 - dec / math.pi
    return (u * width).astype(int) % width, np.clip((v * height).astype(int), 0, height - 1)


def row_omega(height: int, width: int) -> np.ndarray:
    """Solid angle of a pixel in each row."""
    row_dec = (0.5 - (np.arange(height) + 0.5) / height) * math.pi
    return (2 * math.pi / width) * (math.pi / height) * np.cos(row_dec)


def calibrate(hiptyc: np.ndarray, ra, dec, mag) -> tuple[float, float, dict]:
    """Map value (luminance) times solid angle per unit flux (V = 0), and which way right ascension runs."""
    height, width, _ = hiptyc.shape
    lum = (hiptyc @ LUMA) * row_omega(height, width)[:, None]
    # Bright, isolated-enough stars away from the poles: magnitudes 0.5 to 3.5.
    pick = np.where((mag > 0.5) & (mag < 3.5) & (np.abs(dec) < math.radians(70)))[0]
    best = None
    for sign in (-1.0, 1.0):
        x, y = pixel_of(ra[pick], dec[pick], width, height, sign)
        def sums(r: int) -> np.ndarray:
            out = []
            for i, xi, yi in zip(pick, x, y):
                window = np.take(lum[max(yi - r, 0) : yi + r + 1], range(xi - r, xi + r + 1), axis=1, mode="wrap")
                out.append(window.sum() / 10 ** (-0.4 * mag[i]))
            return np.array(out)

        ks = sums(7)
        # A star's light should be within a few pixels: a wider window should find little more.
        print(f"  right ascension sign {sign:+.0f}: 15 px over 7 px windows {np.median(ks / np.maximum(sums(3), 1e-30)):.3f}")
        k = float(np.median(ks))
        # The right orientation finds a star at every position: the scatter is small.
        spread = float(np.median(np.abs(np.log10(np.maximum(ks, 1e-30) / max(k, 1e-30)))))
        print(f"  right ascension sign {sign:+.0f}: K = {k:.4g}, median scatter {spread:.3f} dex over {len(ks)} stars")
        if best is None or spread < best[1]:
            best = (k, spread, sign, ks, dec[pick])
    k, spread, sign, ks, decs = best
    # Is the map linear in flux? K should not change with magnitude.
    mags = mag[pick]
    for lo, hi in ((0.5, 1.5), (1.5, 2.5), (2.5, 3.5)):
        sel = (mags >= lo) & (mags < hi)
        if sel.any():
            print(f"  K for magnitudes {lo} to {hi}: {np.median(ks[sel]):.4g} ({sel.sum()} stars)")
    if spread > 0.3:
        sys.exit(f"calibration failed: no orientation lines the map up with the catalogue (scatter {spread:.2f} dex)")
    # Does a star's summed light depend on declination? It should not, if each star is drawn with its whole flux.
    low = np.median(ks[np.abs(decs) < math.radians(25)])
    high = np.median(ks[np.abs(decs) > math.radians(45)])
    stats = {"K": k, "scatter_dex": spread, "raSign": sign, "K_low_dec_over_high": float(low / high)}
    print(f"  K at |dec| < 25 over K at |dec| > 45: {low / high:.3f}")
    return k, sign, stats


def main() -> None:
    milkyway = read_exr(fetch("milkyway_2020_4k.exr"))
    hiptyc = read_exr(fetch("hiptyc_2020_4k.exr"))
    height, width, _ = milkyway.shape
    ra, dec, mag = read_catalogue()
    print("calibrating against the catalogue")
    k, sign, stats = calibrate(hiptyc, ra, dec, mag)

    omega = row_omega(height, width)
    to_sun = 10 ** (0.4 * SUN_V)  # flux of V = 0 relative to the sun's
    radiance = milkyway / k * to_sun

    # The stars between our catalogue's limit (8) and Tycho's: the Tycho map's light less our catalogue's, block by
    # block, spread smoothly into the glow.
    bh, bw = height // BLOCK, width // BLOCK
    flux = (hiptyc * omega[:, None, None]).reshape(bh, BLOCK, bw, BLOCK, 3).sum(axis=(1, 3))
    ours = np.zeros((bh, bw))
    x, y = pixel_of(ra, dec, width, height, sign)
    np.add.at(ours, (y // BLOCK, x // BLOCK), 10 ** (-0.4 * mag) * k)
    flux_lum = flux @ LUMA
    keep = np.clip(1.0 - ours / np.maximum(flux_lum, 1e-30), 0.0, 1.0)
    block_omega = omega.reshape(bh, BLOCK).sum(axis=1) * BLOCK
    faint_radiance = flux * keep[..., None] / k * to_sun / block_omega[:, None, None]
    up = np.stack(
        [np.asarray(Image.fromarray(faint_radiance[..., c].astype(np.float32)).resize((width, height), Image.BICUBIC)) for c in range(3)],
        axis=-1,
    )
    up = np.maximum(up, 0.0)
    radiance += up
    print(f"  stars 8 to 11.5 add {100 * (up @ LUMA).sum() / max((radiance @ LUMA).sum(), 1e-30):.1f}% of the glow")

    # Absolute scale: all starlight round the galactic poles, ours included, against the measured value.
    row_dec = (0.5 - (np.arange(height) + 0.5) / height) * math.pi
    u = (np.arange(width) + 0.5) / width
    col_ra = (u - 0.5) * 2 * math.pi / sign
    vec = np.stack(
        [np.cos(row_dec)[:, None] * np.cos(col_ra)[None, :], np.cos(row_dec)[:, None] * np.sin(col_ra)[None, :], np.repeat(np.sin(row_dec)[:, None], width, 1)],
        axis=-1,
    )
    polar = np.abs(vec @ NGP) > math.sin(math.radians(75))
    weights = np.broadcast_to(omega[:, None], (height, width))
    polar_omega = weights[polar].sum()
    glow = ((radiance @ LUMA) * weights)[polar].sum() / polar_omega
    sv = np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)], axis=-1)
    in_polar = np.abs(sv @ NGP) > math.sin(math.radians(75))
    ours_polar = (10 ** (-0.4 * mag[in_polar])).sum() * to_sun / polar_omega
    target = 10 ** (-0.4 * (POLE_STARLIGHT - SUN_V)) / ARCSEC2
    scale = (target - ours_polar) / glow
    print(f"  galactic poles: measured starlight {target:.3g}, ours {ours_polar:.3g}, maps {glow:.3g}: maps scaled by {scale:.3f}")
    if not 0.01 < scale < 10:
        sys.exit("absolute calibration out of range; check the maps")
    radiance *= scale
    stats["absoluteScale"] = scale

    lum = radiance @ LUMA
    top = float(np.percentile(lum, 99.995)) * 2
    lo, hi = math.log2(FLOOR), math.log2(top)
    code = (np.log2(np.maximum(radiance, FLOOR)) - lo) / (hi - lo)
    code = np.clip(np.round(code * 255), 0, 255).astype(np.uint8)
    Image.fromarray(code, "RGB").save(OUT_IMAGE, quality=92, subsampling=0)
    pct = {p: float(np.percentile(lum, p)) for p in (1, 50, 99, 99.9)}
    print(f"  radiance percentiles (sun = 1): {pct}")
    meta = {
        "source": "NASA/Goddard Space Flight Center Scientific Visualization Studio, Deep Star Maps 2020; Gaia DR2: ESA/Gaia/DPAC",
        "projection": "plate carree, J2000 equatorial, 0h at the centre, right ascension "
        + ("increasing to the left" if sign < 0 else "increasing to the right"),
        "raSign": sign,
        "log2Min": lo,
        "log2Max": hi,
        "calibration": stats,
        "percentiles": pct,
    }
    OUT_META.write_text(json.dumps(meta, indent=2) + "\n")
    print(f"wrote {OUT_IMAGE} ({OUT_IMAGE.stat().st_size // 1024} KB) and {OUT_META}")


if __name__ == "__main__":
    main()

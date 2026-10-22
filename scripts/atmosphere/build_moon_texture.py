"""Bake the moon's surface map for the sky from NASA's CGI Moon Kit.

NASA/Goddard Space Flight Center Scientific Visualization Studio, "CGI Moon Kit" (https://svs.gsfc.nasa.gov/4720):
the Lunar Reconnaissance Orbiter Camera's wide-angle colour mosaic (LROC WAC, with the poles filled in), plate carree,
public domain. Unlike a shaded relief it holds the surface's albedo, so it can be lit by the sun at any phase.

The map is resampled to 2048x1024 and scaled so that the near side (longitude -90 to 90) has a mean linear luminance
of 0.4, which the sky shader (moonAlbedo in src/atmosphere/shaders.ts) maps to the moon's mean albedo of 0.12.

Usage: python3 scripts/atmosphere/build_moon_texture.py   (needs numpy and Pillow; writes public/textures/moon.jpg)
The download is cached in .cache/moon/.
"""

import pathlib
import sys
import urllib.request

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

BASE = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/"
CANDIDATES = ["lroc_color_poles_2k.tif", "lroc_color_poles_4k.tif", "lroc_color_poles_1k.jpg"]
NEAR_SIDE_MEAN = 0.4
ROOT = pathlib.Path(__file__).resolve().parents[2]
CACHE = ROOT / ".cache" / "moon"
OUT = ROOT / "public" / "textures" / "moon.jpg"


def download() -> pathlib.Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    for name in CANDIDATES:
        path = CACHE / name
        if path.exists() and path.stat().st_size > 0:
            return path
        try:
            print(f"downloading {BASE}{name}")
            urllib.request.urlretrieve(BASE + name, path)
            return path
        except Exception as error:  # noqa: BLE001 - try the next size
            print(f"  failed: {error}")
            path.unlink(missing_ok=True)
    sys.exit("no map could be downloaded")


def to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def main() -> None:
    source = download()
    image = Image.open(source).convert("RGB")
    print(f"{source.name}: {image.size[0]}x{image.size[1]}")
    image = image.resize((2048, 1024), Image.LANCZOS)
    rgb = to_linear(np.asarray(image, dtype=np.float64) / 255.0)
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722])
    near = lum[:, 512:1536].mean()
    print(f"near-side mean linear luminance {near:.4f}, scaled by {NEAR_SIDE_MEAN / near:.3f}")
    # Where the darkest broad patch sits, to check the map's longitude convention: the maria lie on the near side,
    # so its centre column should be within about 40 degrees of the map's centre.
    columns = lum[256:768].mean(axis=0)
    darkest = int(np.argmin(np.convolve(columns, np.ones(128) / 128, mode="same")))
    print(f"darkest band centre at longitude {darkest / 2048 * 360 - 180:.0f}")
    rgb = np.clip(rgb * (NEAR_SIDE_MEAN / near), 0.0, 1.0)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray((to_srgb(rgb) * 255.0 + 0.5).astype(np.uint8)).save(OUT, quality=90)
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()

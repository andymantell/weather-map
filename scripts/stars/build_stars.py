"""Build the star catalogue the night sky draws: every Hipparcos star down to magnitude 8.

The source is d3-celestial's stars.8.json (BSD licence, Olaf Frohn), itself taken from XHIP, the Extended
Hipparcos Compilation (Anderson & Francis 2012, VizieR V/137D): J2000 positions, V magnitudes and B-V colours
for 41,000 stars. The app precesses the J2000 positions to the date it shows, so the file holds them as given.

Output, little-endian, arrays one after another so each is aligned:

    uint32  count
    float32 ra[count]     right ascension, radians, J2000
    float32 dec[count]    declination, radians, J2000
    int16   mag[count]    V magnitude x 100
    int16   bv[count]     B-V colour index x 1000 (sun-like 0.65 where the catalogue has none)

Sorted brightest first. Usage: python3 scripts/stars/build_stars.py
"""

import json
import math
import pathlib
import struct
import urllib.request

SOURCE = "https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/stars.8.json"
OUT = pathlib.Path(__file__).resolve().parents[2] / "public" / "data" / "stars.bin"


def main() -> None:
    with urllib.request.urlopen(SOURCE) as response:
        features = json.load(response)["features"]
    stars = []
    for f in features:
        lon, lat = f["geometry"]["coordinates"]
        bv = f["properties"].get("bv")
        bv = float(bv) if bv not in (None, "") else 0.65
        stars.append((math.radians(lon % 360.0), math.radians(lat), float(f["properties"]["mag"]), bv))
    stars.sort(key=lambda s: s[2])
    n = len(stars)
    data = struct.pack("<I", n)
    data += struct.pack(f"<{n}f", *(s[0] for s in stars))
    data += struct.pack(f"<{n}f", *(s[1] for s in stars))
    data += struct.pack(f"<{n}h", *(round(s[2] * 100) for s in stars))
    data += struct.pack(f"<{n}h", *(max(-32768, min(32767, round(s[3] * 1000))) for s in stars))
    OUT.write_bytes(data)
    print(f"{n} stars, magnitudes {stars[0][2]} to {stars[-1][2]}, {len(data)} bytes -> {OUT}")


if __name__ == "__main__":
    main()

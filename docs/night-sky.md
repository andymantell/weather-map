# The night sky

The sky over the map shows the stars and planets you would actually see from where the camera is, at the moment
the map shows. Orion rises in the east-south-east after midnight in late October, the Plough sits low over the
northern horizon, Saturn stands in the south near the moon on 22 October 2026, and the Pleiades are a recognisable
little cluster when you zoom in.

This replaces the first version of the night sky (see [atmosphere.md](atmosphere.md)), which had about 31,000
procedural stars with a realistic count per magnitude. They turned correctly with sidereal time, but they were
random stars, with no constellations and no planets.

## What is drawn

| Object | Source | Accuracy |
| --- | --- | --- |
| Stars | Hipparcos, via XHIP (Anderson & Francis 2012) as packaged by [d3-celestial](https://github.com/ofrohn/d3-celestial) (`stars.8.json`, BSD licence): 41,411 stars to V = 8.0 with B-V colours | J2000 positions, precessed to the date; within about 20 arcseconds of astropy |
| Planets | JPL's *Approximate Positions of the Planets* (Standish), table 1 (1800–2050), corrected for light time | Within about 0.1° of astropy's built-in ephemeris (checked for Mercury to Neptune on 22 Oct 2026) |
| Planet brightness | Mallama & Hilton (2018), *Computing Apparent Planetary Magnitudes for The Astronomical Almanac* | Mars's rotation and season terms and Uranus's latitude term left out (0.1 mag or less). Checked: Mars at the 2020 opposition comes out at −2.7 |
| Planet colour | B-V from Wikipedia's [Color index](https://en.wikipedia.org/wiki/Color_index) table | |
| Milky Way | Unchanged: a procedural band about the galactic equator (now precessed with the stars) | |

Positions were checked against astropy 8.0 for Plymouth Hoe at 22:00 UTC on 22 October 2026: Polaris, Vega,
Betelgeuse, Sirius and Capella agree to 0.005°. Saturn (0.09°) has the largest planet error. The great conjunction of
Jupiter and Saturn on 21 December 2020 comes out at 0.11° (it was 0.10°).

## How it works

**Data.** `scripts/stars/build_stars.py` downloads the catalogue and writes `public/data/stars.bin` (497 KB, 368 KB
gzipped): right ascension and declination as float32, magnitude and B-V as int16, brightest first.

**Grid lookup.** `src/atmosphere/stars.ts` loads the file and splits the sky into a cube-map grid in J2000
equatorial coordinates (6 × 64 × 64 cells, about 1.4° each). Each cell lists every star within 0.3° of it, so a sky
pixel reads only its own cell, and stars still light pixels across cell and cube-face edges. That gives about 95,000
entries, with at most 23 in one cell. Three float textures hold the data: the cell table (start, count), the star
directions with their illuminance, and the star colours.

**Placing the sky.** `skyState` in `astronomy.ts` now also returns `j2000ToWorld`: precession from J2000 to the date
(IAU 1976, Lieske), then the existing rotation by local sidereal time and latitude into the map's world space,
including the grid's convergence from true north. Precession is a third of a degree by the 2020s, which is enough to
move a star from on a ridge line to above it. Nutation (under 20 arcseconds) and aberration (20 arcseconds) are left
out.

**Refraction.** Each sky pixel's direction is "un-refracted" with Bennett's formula before the lookup, so stars and
planets near the horizon are lifted by up to half a degree, as they really are.

**Brightness.** Each star carries its illuminance relative to the sun's, 10^(−0.4 (V + 26.74)), spread over a
Gaussian about 0.7 pixels wide. That is the same physical scaling as before, so the eye adaptation in
`atmosphere.ts` decides what shows: under a bright moon only the brighter stars come through, and on a moonless night
the full field appears. Starlight goes through the same atmospheric transmittance as everything else, so stars
redden and fade towards the horizon.

**Bright stars and planets.** A screen cannot show a point as bright as Sirius or Venus. So the planets and the
57 brightest stars (to magnitude 2.07) are drawn from a separate list of 64 uniforms. Once a point would be past
white, its light spreads over a larger disc instead (radius growing with the cube root of the excess, up to 6×), with
6% of it in a soft glare three times wider. Planetarium software does much the same, and it makes the bright stars
read as bright.

**Colour.** B-V becomes a temperature (Ballesteros 2012), then a black body integrated against the CIE 1931
colour-matching functions (the Wyman, Sloan and Shirley 2013 fit), then linear sRGB balanced so that 6500 K is white.
Betelgeuse and Aldebaran come out orange, Rigel and Vega a little blue, and the sun's colour slightly warm. The eye
sees colour only in bright stars, so saturation fades from 115% at magnitude −0.5 to 35% at 4.5 and fainter.

**Twinkling.** Scintillation grows with airmass: faint overhead, strong near the horizon, where each colour also
flickers on its own. Planets are discs rather than points, so they twinkle at 15% of a star's amount. Each star's
flicker is seeded by its direction, so its grid point and its glare twinkle together.

## Cost

Per sky pixel at night: one cell-table read, a loop over that cell's stars (usually a handful, at most 23) with two
texture reads each, and a loop over the 64 bright objects that skips anything further than four glare widths away.
The night-sky block runs by day too, where the stars are far below the sky's brightness.

On Andy's laptop (Radeon RX 7700S, Chrome, 1600 × 900), a moonless view looking up from Plymouth Hoe with the clouds
off runs at a median of 8.0 ms a frame (p90 8.3–15 ms over two runs of 120 frames). That is the whole frame; there
is no switch to turn the stars off for comparison.

## Screenshots

`scripts/stars/shots.mjs` turns the clouds off, tells the atmosphere the sky is clear, and takes five views from
Plymouth Hoe: Saturn and the moon to the south, the Plough to the north, Orion rising, a 12° zoom on the Pleiades,
and a moonless sky overhead on 10 November. Run it with `--gpu` on a real GPU. Images go to `docs/images/stars/`
(not committed). On the real GPU there were no shader errors.

## Not done yet

- **A real Milky Way.** The band is still procedural. A real all-sky map (for example ESA's Gaia sky map, CC BY-SA
  3.0 IGO) would give the actual Cygnus rift and star clouds.
- **Very wide views.** At 90° field of view, stars near the screen edge stretch slightly, because their size is set
  from the pixel's average angle.
- **Planet discs.** Venus's crescent and Jupiter's moons need about 30× zoom, which the camera does not offer.

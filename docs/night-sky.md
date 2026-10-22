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
| Milky Way | NASA/Goddard Space Flight Center Scientific Visualization Studio, [Deep Star Maps 2020](https://svs.gsfc.nasa.gov/4851) (Gaia DR2: ESA/Gaia/DPAC), Milky-Way-only layer | Brightness anchored to the measured starlight at the galactic poles (see below) |

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

## The Milky Way

`scripts/stars/build_milkyway.py` bakes `public/data/milkyway.jpg` (4096 × 2048, 3.5 MB) from two layers of NASA's
Deep Star Maps 2020. Both are linear, half-float, plate carrée maps in J2000 equatorial coordinates. The cloud
container can't reach svs.gsfc.nasa.gov, so the bake runs on Andy's machine.

- `milkyway_2020_4k.exr` is the light of the 1.7 billion Gaia stars, with the Hipparcos and Tycho stars removed.
  This is the glow itself.
- `hiptyc_2020_4k.exr` holds the Hipparcos and Tycho stars alone (to about magnitude 11.5).

**Lining up.** The script finds which way right ascension runs by checking that our catalogue's bright stars land on
stars in the Hipparcos/Tycho layer: 0h is at the centre and RA increases to the left.

**Relative brightness.** The maps hold radiance, so each star's pixels, weighted by solid angle and summed against
its V magnitude, give the maps' scale. Before the solid-angle weighting, the scale depended on declination by a
factor of 0.62. With it, the factor is 1.09. This scale is used to add the light of the magnitude 8 to 11.5 stars:
the Tycho layer, less our own catalogue, block by block (1.4°), smoothed into the glow. They add about 5% of it.

**Absolute brightness.** The maps' faint light, taken at that scale, came out about ten times brighter than the real
sky. The scale also drifts with magnitude: it is 2.3 times higher for magnitude 3 stars than for magnitude 1, so NASA's
rendering isn't linear in flux. Instead, the total starlight at the galactic poles (|b| > 75°: our catalogue plus
both layers) is set to the measured integrated starlight there, 24.16 V mag/arcsec² (the mean of 24.24 and 24.08 for
the north and south galactic poles; Mattila et al. 2010, arXiv:1011.2941, table 1). That scales the maps by 0.103.
The result puts the brightest 0.1% of the sky (the Sagittarius and Scutum star clouds) at about 6.5e-9 of sunlight
per steradian, around 20.4 mag/arcsec². That is close to the usually quoted brightness of the brightest Milky Way.
The natural night sky in `atmosphere.ts` is 1.6e-9.

**Encoding.** The radiance is log-encoded per channel over 2^-39.9 to 2^-17.1 (`milkyway.json`), so 8 bits give steps
of about 6%. The shader picks the mip level itself from the pixel's angle, because derivatives jump where right
ascension wraps. It keeps 45% of the map's colour, because the dark-adapted eye sees little colour in so faint a
glow.

## What the eye can see

A screen shows every catalogued star unless something stops it, and 41,000 stars to magnitude 8 swamp the Milky Way.
The sky shader now works out the faintest star the eye could see at each pixel. It takes the sky behind the pixel
(scattered sun and moon light, airglow and town glow, the Milky Way) and applies Schaefer's (1990) relation as usually
quoted: NELM = 7.93 − 5 log10(10^(4.316 − b/5) + 1), with b in mag/arcsec² (via
[Unihedron's NELM calculator](https://unihedron.com/projects/darksky/NELM2BCalc.html)). It also allows for the
starlight lost to the air. Stars fade out over the last magnitude above that limit.

Against the app's natural sky (21.8 mag/arcsec²) the limit is about 6.5. A moonlit sky brings it down to about 3, and
low on the horizon the extinction takes off more. The faint field thins out, the Milky Way reads as a band, and
under the moon you're left with the constellations' main stars, as you would be outdoors.

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
a moonless sky overhead on 10 November, and the Milky Way through Cygnus (10 September) and Sagittarius (12 August). Run it with `--gpu` on a real GPU. Images go to `docs/images/stars/`
(not committed). On the real GPU there were no shader errors.

## Not done yet

- **Milky Way brightness.** It is anchored to one measurement, at the galactic poles. If it looks too faint on a real
  screen, a single gain on `milkyWayMap` would be a perceptual tweak rather than a physical one.
- **Very wide views.** At 90° field of view, stars near the screen edge stretch slightly, because their size is set
  from the pixel's average angle.
- **Planet discs.** Venus's crescent and Jupiter's moons need about 30× zoom, which the camera does not offer.

# Ground-level atmosphere: sky, sun, moon, haze and light

The map's sky used to be three.js's `Sky` (Preetham) with a fixed sun at 28°, a linear `THREE.Fog` and a hemisphere
light. From the ground camera (about 50 m up) that read as a flat blue backdrop with fog that ignored the weather.
`src/atmosphere/` replaces all of it with a physically based atmosphere that is lit by the sun and moon for the time
being viewed and thickened or greyed by the UKV weather over the camera.

## What it does

- **Sky.** Hillaire (2020), "A Scalable and Production Ready Sky and Atmosphere Rendering Technique", the method in
  Unreal Engine: a transmittance LUT (256x64), a multiple-scattering LUT (32x32), and a sky-view LUT (192x108) per
  light, rendered every frame from the camera's altitude. Rayleigh, Mie and ozone use Bruneton's Earth parameters.
  Sunrise, sunset, twilight colours and the Earth's shadow come out of the model; nothing is hand-painted.
- **Sun and moon placed for the time.** `astronomy.ts` computes the sun (Astronomical Almanac short series) and moon
  (Schlyter's elements with the main perturbation terms, plus topocentric parallax of about a degree) for the camera's
  latitude and longitude. Directions are turned from true north into the map's grid, which is rotated up to about 10°
  from true north across the UK (LAEA convergence). Accuracy is a few arcminutes.
- **Time follows the data.** The sun and moon follow the weather's valid time (the static hour, or the `?live` time
  slider). The HUD's *Time of day* slider overrides it; *Follow the weather's time* goes back.
- **Sun disc** with limb darkening, drawn at its real angular size and brightness (capped so it cannot glare through
  thick cloud). The clouds now treat their 1% stopping transmittance as opaque for the same reason.
- **Moon** at its real size, with its phase lit from the sun's direction (Lommel-Seeliger reflectance, so the full
  moon looks flat as it does), the main maria and Tycho placed roughly as on the near side, earthshine on the dark
  limb, and the disc turned to celestial north so its tilt changes through the night. It shows faintly by day.
- **Moonlight.** At night (sun below about -4°) the key light swaps to the moon: illuminance is the full moon's
  2.5 millionths of sunlight, falling off with phase (Allen's magnitude law). It lights the clouds, casts the detailed
  terrain's shadows and scatters in the air, so a moonlit sky is a faint blue.
- **Stars and Milky Way.** About 31,000 procedural stars on a grid fixed to the celestial sphere, with the real count
  law (roughly three times as many per magnitude), each carrying its physical illuminance and drawn as a pixel-sized
  spot, so they appear by themselves as the sky darkens and the moon washes the faint ones out. They turn with
  sidereal time about the celestial pole. A Milky Way band follows the galactic equator, and a faint airglow plus town
  glow keeps a moonless night from going black.
- **Aerial perspective.** A 32x32x32 froxel volume of in-scattering and transmittance (RGB) in camera space, rendered
  every frame, applied to every scene pixel in the clouds' composite (after the cloud shadow, before the clouds are
  blended) and to the clouds themselves at their mean depth. Distant hills turn blue, then into the horizon's colour;
  at sunset the haze goes orange. Close to the ground it follows the planet's curve, so terrain at the horizon matches
  the sky behind it; from high up it flattens to the map's flat ground.
- **Haze from UKV visibility.** `pipeline/ukv_surface.py` bakes `visibility_at_screen_level` (plus fog fraction and
  relative humidity) for the static hour; the live reader adds the 15-minute visibility files. The visibility over the
  camera (a log mean over a few km) becomes a boundary-layer aerosol by Koschmieder's law (extinction = 3.912 / V).
  Ordinary haze fills about 1 km and absorbs a little; under 1 km visibility it turns into a thin, white droplet fog
  layer about 120 m deep. From high up the region's mean visibility is used instead of the spot's.
- **Weather overhead.** The CPU reads the same cloud volume the clouds draw: cover within 5 km, the deck's base and
  top, and how much of the sun or moon gets through along its path. Below the deck the air's direct light is cut by
  that amount and replaced by the cloud base's grey light, so overcast haze is grey, not sunlit blue.
- **Sky light on materials.** Every `MeshStandardMaterial` (terrain, towns, trees, roads) and the sea now get their
  ambient and reflections from a prefiltered copy of this sky (`scene.environment`, PMREM), re-baked when the sun or
  moon moves or the cloud cover changes. Under cloud the copy turns into the cloud base, so lighting goes flat and grey.
  The hemisphere light is gone.
- **Exposure.** All light is physical and relative to sunlight, then multiplied by a pre-exposure that adapts like an
  eye over about a second: 85% of the way from noon to a moonlit night, so night is still darker and bluer than day.
  The clouds keep their own exposure and the composite rescales them, so adaptation does not restart their
  accumulation. The old fixed sun (3.2 at 28°) is the reference, so the materials and clouds keep their tuning at
  midday.

## Files

| File | What |
| --- | --- |
| `src/atmosphere/atmosphere.ts` | `Atmosphere`: LUT passes, lights, environment, exposure, cloud lighting; the HUD control |
| `src/atmosphere/shaders.ts` | GLSL: medium, LUTs, aerial perspective, sky dome (sun, moon, stars, Milky Way) |
| `src/atmosphere/astronomy.ts` | Sun, moon and star directions for a time and place |
| `src/atmosphere/medium.ts` | Air parameters, haze from visibility, CPU transmittance for sun and moon colour |
| `src/atmosphere/localWeather.ts` | Cover, deck, key-light visibility and screen-level visibility over a point |
| `pipeline/ukv_surface.py` | Bakes visibility, fog fraction and humidity: `public/data/ukv-surface.{png,json}` |
| `scripts/atmosphere/shots.mjs` | Screenshots and frame times at several times of day |

Hooks elsewhere: `src/weather/clouds.ts` takes the atmosphere's GLSL and uniforms (`options.atmosphere`) and exposes
`lighting`; the composite in `cloudShaders.ts` applies aerial perspective and pre-exposure, and still composites when
clouds are switched off. `scene.fog` and the camera rig's fog fitting are gone. The detailed terrain's shadows follow
the shared key-light direction. Console handle in dev: `atmosphere` (`atmosphere.setTime(new Date(...))`,
`atmosphere.snapExposure()`).

## Results

Checked first in headless Chromium with software GL (SwiftShader) at 640x360, with the detailed tiles off
(`?detail=off`, added for this; the tiles are too slow under software GL), on Plymouth Hoe 60 m up and on Dartmoor, at
the static hour's day (21 October 2026). `node scripts/atmosphere/shots.mjs` reproduces the views.

- Noon (sun 29° south): deep blue zenith fading to a pale, slightly hazy horizon (UKV visibility there is 37 km);
  the cumulus sit in front of the sky with distance haze on the far ones.
- Sunrise (07:05) and sunset (16:50): orange-pink skies and haze from the model alone, the sun's path on the sea,
  and the clouds lit warm from below. Dusk (17:30, sun -6°) gives a violet sky with the last light on cloud tops.
- 22:00: the 80%-lit waxing gibbous moon at 27° in the south-south-west, with its Mie glow, stars coming through,
  a moon path on the sea and moonlit cloud edges. Exposure has adapted by about 2x10^5 and the scene is a dark blue.
- From the map view the sky is drawn as if from 6 km up (the map camera is hundreds of km up, which would otherwise
  put it in space), and the UK picks up a faint blue veil. At night the map is moonlit.

On Andy's desktop GPU (Chrome, 1600x900, `--gpu`), with the detailed tiles: Plymouth Hoe at noon runs at a 12 ms
median frame (p90 33 ms while tiles and clouds were still settling), and at 22:00 at 12.4 ms (p90 13.7 ms). There
were no shader errors and no NaN or black pixels. The real-GPU run showed two problems, fixed since: the land at dusk
was lit almost like day, because exposure adapted too far through twilight, and the rain went navy against twilight
skies, because it took the full colour of the sky light. The added cost is a few small LUT passes per frame
(sky views 2x192x108 with 40 steps, the froxel volume 32,768 cells with 24 steps), the sky dome, one PMREM re-bake
when the sun, moon or cover changes, and a sky irradiance read-back every 0.4 s (asynchronous).

## Known gaps and next steps

- Haze density comes from the visibility over the camera and is the same everywhere in view; a fog bank in the next
  valley is not drawn as a bank. A spatially varying haze (marching the visibility field in the froxel pass) is the
  natural next step.
- The animated rain is drawn after tone mapping, so it only gets a daylight tint and level (`RainLayer.light`), not
  aerial perspective.
- The detailed tiles' inland water adds its own gradient sky (`WATER` in `src/detail/ground.ts`); now that every
  material gets the real sky as its environment, that is counted twice and should go.
- No bloom or glare around the sun and moon, and no town lights at night.
- Exposure follows estimated ground light, not a measured histogram, so a view straight at the bright sky does not
  stop down.

## References

- S. Hillaire, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique", EGSR 2020.
- E. Bruneton, F. Neyret, "Precomputed Atmospheric Scattering", EGSR 2008 (atmosphere parameters).
- P. Schlyter, "How to compute planetary positions" (moon).
- The Astronomical Almanac, low-precision formulas for the sun.
- C. W. Allen, *Astrophysical Quantities* (moon brightness against phase).

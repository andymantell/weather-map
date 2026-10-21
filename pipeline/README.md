# UKV data pipeline

`ukv_to_grid.py` converts one Met Office UKV field from the free AWS Open Data bucket into a 16-bit packed PNG
with a JSON sidecar that the browser can decode.

```
pip install -r requirements.txt
python ukv_to_grid.py --param temperature_at_screen_level --step 6 --out-dir out --preview
```

The research behind it covers data access, the grid, the encoding, and decoding in Three.js. It lives in
[docs/ukv-data-access.md](../docs/ukv-data-access.md).

## Sea state

`wave_to_grid.py` converts the Met Office UK 1.5 km wave model (a separate free bucket,
`met-office-nws-wave-model-data`) into three small RGB textures for the sea shader, resampled onto the terrain's
LAEA extent.

```
python wave_to_grid.py --run 20261021T0600Z --valid 20261021T1200Z --out-dir ../public/data/waves
```

The research and the rendering approach are in [docs/sea-state-research.md](../docs/sea-state-research.md).

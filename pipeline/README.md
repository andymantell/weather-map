# UKV data pipeline

`ukv_to_grid.py` converts one Met Office UKV field from the free AWS Open Data bucket into a 16-bit packed PNG
with a JSON sidecar that the browser can decode.

```
pip install -r requirements.txt
python ukv_to_grid.py --param temperature_at_screen_level --step 6 --out-dir out --preview
```

The research behind it covers data access, the grid, the encoding, and decoding in Three.js. It lives in
[docs/ukv-data-access.md](../docs/ukv-data-access.md).

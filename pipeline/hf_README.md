---
license: cc-by-4.0
pretty_name: Taiwan tree cover 1984–2026 (Landsat, 30 m, native grid)
language:
- zh
- en
tags:
- geospatial
- remote-sensing
- landsat
- tree-cover
- taiwan
size_categories:
- 1M<n<10M
---

# Taiwan tree cover 1984–2026 (tw-tree)

Tree fraction (0–100 %) per 30 m Landsat pixel for each year, with per-pixel provenance back to the single raw
Landsat scene each value came from. Data for the 3D viewer 臺灣樹冠時光機 (<https://chenhunghan.github.io/tw-tree/>).

Releases:
- **`taiwan/` — island-wide v3 (in progress).** 761 tiles in UTM zones 51 and 50 covering the main island, Penghu, Kinmen
  and Matsu (36,319 km² of land). Tiles are published north to south as the export completes; `index.json` has
  `complete` and `tiles_planned`. Code: <https://github.com/chenhunghan/tw-tree>.
- **`pilot/` — Taipei pilot v2** (20 tiles in zone 51, sensor-calibrated). Kept unchanged.

## Layout (`taiwan/` adds `own`, `land` and `overview.arrow.gz`)

```
taiwan/index.json                 tiles, years, scene counts per zone, model, island totals (land pixels only)
taiwan/overview.arrow.gz          480 m block means per tile: zone, i, j, x_utm, y_utm, z_m, own, land, f<year>
taiwan/summary.parquet            per tile x year: owned/land/valid pixels, observed and gap-filled tree hectares
taiwan/<zone>/<i>_<j>.frac.arrow.gz   x_utm, y_utm, z_m, own, land, f<year>
taiwan/<zone>/<i>_<j>.prov.arrow.gz   x_utm, y_utm, s<year>, n<year>
```

- `own`: 1 = canonical pixel for this location. Where a zone-50 tile overlaps a zone-51 tile along the zone boundary,
  the zone-50 pixels are `own = 0` (use the zone-51 tile). Every location is counted once.
- `land`: 1 = land (ESA WorldCover 2021 permanent water < 50 % of the pixel). `f` is still stored for water pixels (it
  is the model's raw output), but totals and the viewer use land pixels only.

Pilot layout:

```
pilot/index.json                  tiles, years, per-year scene counts, model metrics
pilot/summary.parquet             per tile x year: valid pixels, tree hectares, scenes
pilot/51/<i>_<j>.frac.arrow.gz    x_utm, y_utm (int32), z_m (int16), f<year> (uint8)
pilot/51/<i>_<j>.prov.arrow.gz    x_utm, y_utm, s<year> (uint16), n<year> (uint8)
```

Each file is an Arrow IPC file, gzipped as a whole (so the browser can decompress it with `DecompressionStream`).
Schema metadata key `tpetree` holds a JSON description.

- `x_utm`, `y_utm`: exact pixel centre in EPSG:32651 (zone 51) or EPSG:32650 (zone 50). Values are multiples of 30 m on the
  native Landsat Collection 2 grid; **no resampling**.
- `f<year>`: tree fraction percent, 255 = no clear observation that year.
- `s<year>`: index into `scenes[year]` in the provenance metadata (Landsat product IDs), 65535 = none.
  The raw pixel is `col = (x_utm − 15 − scene_ulx) / 30`, `row = (scene_uly − y_utm − 15) / 30`.
- `n<year>`: number of distinct clear acquisition dates in that year.
- `z_m`: Copernicus DEM GLO-30, bilinear to the pixel centre (display only).

Tiles are 256 × 256 pixels. Tile `(i, j)` covers x ∈ [15 + 7680·i, 15 + 7680·(i+1)), y ∈ [15 + 7680·j, 15 + 7680·(j+1)).

```python
import gzip, pyarrow.ipc as ipc, polars as pl
t = ipc.open_file(gzip.open("pilot/51/46_360.frac.arrow.gz").read()).read_all()
df = pl.from_arrow(t)            # one row per pixel, one column per year
```

## Verification

**`taiwan/` (v3):** Earth Engine returns the raw Collection 2 DN of each pixel's medoid observation; calibration, features and
the model run locally. On 60 random stored pixels, the position formula gave an integer raw pixel in 60/60 and the pixel
was clear in QA_PIXEL in 60/60. The six raw DN read from the independent Planetary Computer copy were **identical** to the
DN Earth Engine returned in 59/59 cases with the same processing version (the 60th is a Landsat 9 scene USGS reprocessed in
2023; Planetary Computer serves the 2022 processing). Recomputed tree fraction: 59/60 exact, 1 off by 1 point (that
reprocessed scene). Before the switch, a pilot tile was exported both ways: medoid scene index identical for 100 % of
pixels, local tree fraction within 1 point of Earth Engine's (99.8–100 % exact).

**`pilot/` (v2):**

`verify_provenance.py` (v2) checked 60 random stored pixels (25 TM, 25 ETM+, 6 OLI, 3 OLI-2, 1 Landsat 4) against the raw USGS files on Microsoft Planetary Computer, an independent copy of the data. For 60/60 the position formula gives an integer raw pixel, and that pixel is clear in QA_PIXEL. Recomputing locally from the raw DN with the recorded calibration gave the same tree fraction in 59/60 cases. The remaining case differed by 2 points, which fits float rounding at a single split of the 60-tree model.

## Method

- Landsat 4/5/7/8/9 Collection 2 Level-2, Tier 1 only, processed in Google Earth Engine.
- Per year: clouds, shadows, snow and saturated pixels are masked (QA_PIXEL, QA_RADSAT), and same-date overlapping scenes
  are mosaicked. Then a **medoid** composite is built: for each pixel, the one real observation closest to the per-band
  median. That is why every value traces back to one scene.
- Cross-sensor calibration: LT04/LT05 use a TM→ETM+ reduced-major-axis fit (same-year per-sensor medians, northern Taiwan, 2000–2009 overlap years) followed by Roy et al. (2016) ETM+→OLI. LE07 uses Roy et al. (2016). LC08 is the reference. LC09 is unchanged (no measured bias). Coefficients: `pipeline/model/sensor_calibration.json`; each tile's metadata records them.
- `taiwan/` model `rf_tw_2021`: random forest (scikit-learn, exported as Earth Engine tree strings; the rebuild matches to
  2e-16) trained on 2021 all-sensor composites at 22,048 points stratified by WorldCover tree-fraction bin × elevation band
  in every tile. Held-out (3 km blocks) agreement with WorldCover 2021: R² 0.46, MAE 21 points, bias −0.3 points. This is
  lower than the pilot's northern figure because the island sample includes many mountain grassland/bamboo pixels.
  A multi-year (2014–2025) model was tested and was no more stable over time, so the single-year model is used.
- `pilot/` model: trained on Landsat 8 only (2021), the reference sensor.
- A random-forest regression on 6 bands plus NDVI, NDMI, NBR and NDWI, trained on 2021 composites against ESA WorldCover 2021
  (tree class averaged to 30 m). On held-out 3 km blocks it agrees with WorldCover at R² ≈ 0.71 and MAE ≈ 13 points. That
  measures agreement with the reference; it is not an independent accuracy assessment.
- Code: the `pipeline/` scripts (`train_model.py`, `export_tiles.py`, `verify_provenance.py`).

## Limitations

> **The post-2013 rise (investigated).** The pilot total rose ~54 % → ~64 % between 2013 and 2021. It is **mostly a
> measurement effect, not new canopy**: a Landsat-8-only rebuild keeps the trend (so it is not a sensor switch), but stable
> closed forest (Hansen tree cover 2000 ≥ 80 %, no loss, WorldCover ≥ 0.95) rises just as much (77 % → 99 %), tracking
> NDVI and inversely the L8 aerosol QA level, while Sentinel-2 Dynamic World stays flat on the same pixels. Island-wide,
> only northern Taiwan's forest drifts this way (~+8 points 2014–2021); central/southern forest is flat. Treat northern
> trends smaller than ~8 points after 2013 as unreliable. Island-wide, stable forest also reads ~4–5 points lower in the
> TM/ETM+ era (2000–2010) than in the OLI era, and steps up ~3–4 points in 2022 and 2024–25.

> **Sensor transitions (v2):** v1 used Roy et al. (2016) coefficients alone, and yearly totals stepped at each sensor change.
> Measuring the same pixels in the same year showed that **Landsat 5 TM read about 4.9 points lower than Landsat 7 ETM+**.
> v2 adds a TM→ETM+ correction fitted on northern Taiwan overlap years, which brings that gap to −0.4 points.
> Pilot-area means for 1987–98 / 2000–11 / 2013–21 / 2022–26: v1 59,947 / 66,417 / 73,096 / 76,185 ha; **v2 62,345 / 65,009 / 70,402 / 74,594 ha**.
> The step around 1999 shrank from +6,470 ha to +2,660 ha. The rise after 2013 happens gradually within the Landsat 8 era,
> so it is not a sensor switch. It may be real regrowth or another effect (for example, Landsat 7's shrinking share in the
> composites) and has **not been independently verified**.


- No Tier-1 scenes over Taipei in 1982, 1983 or 1985. 1984 and 1986 have only 3 scenes each (low confidence).
- Raw geolocation is about 12 m RMSE, so there can be sub-pixel shifts between years.
- Same-year residual differences between sensors after calibration are within about ±3 points in a given year. Landsat 7 has SLC-off gaps from 2003.
- The model is trained on one year and one reference. Applying it to the 1980s–1990s assumes the spectral relationships held then.
- A full-year composite mixes seasons, so there is some phenology noise. Most street trees are smaller than a 30 m pixel.

## Attribution

- Landsat Collection 2 Level-2 courtesy of the U.S. Geological Survey.
- ESA WorldCover 2021 v200 © ESA WorldCover project, CC BY 4.0.
- Copernicus DEM GLO-30 © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by
  the European Union and ESA.

This dataset (derived tree fraction, provenance and summaries) is released under **CC BY 4.0**.

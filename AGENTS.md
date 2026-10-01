# AGENTS.md — Taipei tree cover data sources

Source site: https://taipei-tree-cover.pages.dev/ (台北市樹冠變化, by the 中央研究院 生物多樣性研究中心 生態與社會生物實驗室).
Crawled on 2026-09-27. The site's own "updated" date is 2026-09-24.

The site's pages are:
- `/`
- `/taipei_satellite_change.html`
- `/history_qc60/taipei_history.html`
- `/reference/index.html`
- the methods docs: `SATELLITE_RESULTS.md`, `COREGISTRATION_RESULTS.md`, `READER_PRESENTATION.md`, `history_qc60/HISTORICAL_RESULTS.md`

It draws on three upstream raw sources. Rule for this repo: **if a source can be reached through an API, do not copy it into `data/`**. Fetch it on demand as described below.

| Source | License | Access | In `data/`? |
|---|---|---|---|
| Copernicus Sentinel-2 L2A | Copernicus free & open (attribution) | Planetary Computer STAC API | No, use the API |
| ESA WorldCover 2021 v200 | CC BY 4.0 | Planetary Computer STAC API / public S3 | No, use the API |
| Taipei Parks Office half-year tree reports (31 ODS files) | Taipei City open-data declaration (free reuse, attribution required) | Static file uploads only, no API | Yes, `data/taipei_parks_halfyear_ods/` |

---

## 1. Sentinel-2 L2A (API: Microsoft Planetary Computer)

The site's tree-cover figures are all computed from this imagery.

- STAC API: `https://planetarycomputer.microsoft.com/api/stac/v1`, collection `sentinel-2-l2a`
- Search needs no key. To read asset hrefs, sign them with a SAS token: use `planetary_computer.sign`, or `GET https://planetarycomputer.microsoft.com/api/sas/v1/token/sentinel-2-l2a`.
- Taipei bbox (WGS84): `[121.45, 24.96, 121.67, 25.21]`. Taipei is covered by MGRS tile `51RUH`, relative orbit `R046`.
- **Years and window the site uses:** 2017, 2019, 2021, 2024, 2025, 2026, each from **07-01 to 09-23**. 2016 was dropped by the site for poor data quality.
- Scene counts found on 2026-09-27 with the bbox above: 2017 = 7, 2019 = 16, 2021 = 17, 2024 = 16, 2025 = 21, 2026 = 22. The site reports 16/22/22 for 2024/2025/2026. A small difference is expected because its footprint is slightly different.
- **Bands used:** `B02 B03 B04 B08` (10 m); `B05 B8A B11 B12` (20 m, resampled bilinearly to 10 m); `SCL` for masking.
- **Processing notes from the site:**
  - Grid is EPSG:3826 (TWD97 / TM2) at 10 m.
  - Pixels with SCL 4/5/6 are kept.
  - SCL 3/8/9/10 (cloud and shadow) are masked and dilated by 20 m.
  - For processing baseline ≥ 04.00, reflectance = `(DN - 1000) / 10000`, applied once.
  - Scenes are co-registered to the 2024-08-22 image.
  - A per-year medoid composite is built from the scenes.

```python
# pip install pystac-client planetary-computer rioxarray
import pystac_client, planetary_computer
cat = pystac_client.Client.open("https://planetarycomputer.microsoft.com/api/stac/v1",
                                modifier=planetary_computer.sign_inplace)
items = cat.search(collections=["sentinel-2-l2a"], bbox=[121.45, 24.96, 121.67, 25.21],
                   datetime="2024-07-01/2024-09-23").item_collection()
href = items[0].assets["B08"].href   # signed COG URL, readable with rasterio/rioxarray
```

## 2. ESA WorldCover 2021 v200 (API: Planetary Computer, or public S3)

The site uses this as training labels for its tree classifier (the tree class) and to define its urban and edge zones.

- **STAC:** collection `esa-worldcover`, item `ESA_WorldCover_10m_2021_v200_N24E120`, asset `map`. Assets need the same SAS signing as above.
- **Direct COG:** no auth, publicly readable: `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N24E120_Map.tif`
- In this dataset, class `10` means Tree cover.
- User manual: https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/docs/WorldCover_PUM_V2.0.pdf

## 3. Taipei half-year tree reports (downloaded locally)

- **Publisher:** 臺北市政府工務局公園路燈工程管理處. The report is 「臺北市行道樹及其他植栽」 半年報, covering 2011 H1 through 2026 H1 (31 files).
- **Location:** `data/taipei_parks_halfyear_ods/` holds the files as `YYYYHn.ods`. `manifest.json` records each file's original URL, size and SHA-256.
- **Integrity:** all 31 SHA-256 hashes match the `source_sha256` column in the site's `reference/official_halfyear_flows.csv`.
- **License:** the Parks Office open-data declaration (政府網站資料開放宣告) grants free, non-exclusive, irrevocable reuse, including modification and redistribution, with attribution. It covers copyright only, not trademarks or logos. Declaration: https://pkl.gov.taipei/News_Content.aspx?n=E6C86666B7A86451&sms=9E2FE7F26B57E721&s=40CFBA6200D34643
- **No API:** these are file uploads on `www-ws.gov.taipei`, and they are not listed on data.taipei.
- **Re-fetching:** use `curl` with the URLs in `manifest.json`. Python 3.14's `urllib` fails TLS verification on `*.gov.taipei` ("Missing Subject Key Identifier"). Use curl rather than disabling verification.
- **Important context:** in January 2025, 23,544 park trees were transferred to district offices. That transfer causes a drop in the park-tree totals; it is not a removal of trees.

---

## Not mirrored

**The site's own derived tables** (CSV/JSON/MD) have **no license stated**, so they are not copied here. They are plain static files you can fetch on demand from `https://taipei-tree-cover.pages.dev/<path>`:
- `reader_summary.json`, `reader_six_year.csv`, `reader_district_change.csv`
- `classification_sensitivity.csv`, `direct_only_sensitivity.csv`
- `registration_validation.json`, `official_tree_context.csv`
- `history_qc60/`: `historical_summary.json`, `historical_district_change.csv`, `historical_screening.csv`, `historical_sensitivity.csv`, `quality_control.csv`
- `reference/`: `official_halfyear_flows.csv`, `official_annual_flows.csv`, `official_rolling_july_june.csv`, `district_flow_diagnostics.csv`

The site's GeoTIFFs (composites, classifications, change rasters) are not published. Its methods docs refer to them only by local paths under `data/interim/...`.

**Also not mirrored:**
- **Rendered images:** `assets/rgb_*.png`, the change and unknown-area overlays, and the `reader_art/` illustrations. These are visualisations, not raw data; regenerate them from the Sentinel-2 API if needed.
- **Google Maps embeds and links:** used only to locate places. They are proprietary under Google's terms and are not data inputs.
- **District and zone boundaries:** the site loads these locally but does not name their source. The urban/edge/forest zones come from WorldCover 2021; see `SATELLITE_RESULTS.md` on the site for the rules.

## Attribution (required when publishing derived work)

> Contains modified Copernicus Sentinel data [years]. ESA WorldCover 2021 v200 / CC BY 4.0. 資料來源：臺北市政府工務局公園路燈工程管理處「臺北市行道樹及其他植栽」半年報。

---

# Project: 3D Taiwan tree-cover timeline (decisions as of 2026-09-27)

## Goal
A GitHub Pages site. It shows tree cover as procedural three.js trees on custom 3D terrain, with a timeline for **1984–2026** that autoplays on load and can be scrubbed to any year. Users jump to a place by typing coordinates, using their device location, or typing a Traditional Chinese address. Build order: **Taipei pilot first, then all of Taiwan** with the same pipeline.

## Decisions
- **Imagery:** Landsat Collection 2 Level-2, **Tier 1 only** (Landsat 4/5 TM, Landsat 7 ETM+, Landsat 8/9 OLI), processed in **Google Earth Engine** (collections `LANDSAT/LT04|LT05|LE07|LC08|LC09/C02/T1_L2`).
- **Grid: native Landsat grid, no resampling.**
  - 30 m pixels; pixel edges fall 15 m past a multiple of 30 m, so pixel centres are exact multiples of 30 m.
  - Taiwan spans **two UTM zones**. EPSG:32651 covers north/east (WRS paths 116–118, rows ≤043). EPSG:32650 covers the west/southwest, Penghu, Kinmen and Matsu (paths 119–120, and 118/044–045).
  - Every tile belongs to exactly one zone and uses only scenes delivered in that zone.
  - Earth Engine exports use `crs` + `crsTransform` aligned to that grid, so values are not resampled.
- **Composite:** one **medoid** per pixel per year. Each value comes from one real observation, which keeps every pixel traceable to a single scene.
- **Measure:** **tree fraction** 0–100 % per pixel (255 = no data), from a regression model trained on ESA WorldCover 2021 (the tree class, averaged to 30 m) against 2021 Landsat 8 composites. TM/ETM+ reflectances are harmonised to OLI with the Roy et al. 2016 coefficients before the model is applied.
- **Data format:**
  - Arrow IPC tiles of 256 × 256 px (7.68 km), one column per year, gzipped as a whole file (the JS `apache-arrow` library can't read Arrow's built-in compression).
  - `frac` tile columns: `x_utm`, `y_utm` (int32, exact pixel centre), `z_m` (int16, elevation), `f1984…f2026` (uint8). The zone is in the schema metadata.
  - `provenance` tile columns: `x_utm`, `y_utm`, `s1984…s2026` (uint16 index into that tile's per-year scene-ID list, stored in the schema metadata under `scenes`; 65535 = none) and `n1984…n2026` (uint8, distinct clear acquisition dates).
  - Summaries in **Parquet only** (no CSV).
  - Tracing a value to its raw pixel: `col = (x_utm − 15 − scene_ulx) / 30`, `row = (scene_uly − y_utm − 15) / 30`.
- **Local copies:** `site/data/` is not kept locally (deleted 2026-09-29 to save disk; every file was on HF). Rebuild it with
  `export_tiles.py --assemble-only` from `build/cache/` before local `?data=` testing or a publish.
- **Raw-DN cache on HF (2026-09-30):** `build/cache/taiwan/` (~20 GB) is archived to the public dataset as
  `cache/taiwan/<zone>/part-NNN.tar` (40 parts of ~500 MB, whole tiles) + `manifest.json` (tiles, files, bytes, SHA-256 per
  part; lists verified parts only) by `uv run pipeline/archive_cache.py archive chenhunghan/tw-tree taiwan --delete`. Each part
  is checked member by member against the source, uploaded, downloaded back and hash-compared before its tiles are deleted
  locally; network errors, 429 and 5xx are retried with backoff (up to ~1 h), downloads resume with Range. Progress:
  `build/archive_taiwan.json`, log `build/archive_taiwan.log`. Restore before any `--assemble-only`, normalisation or
  analysis run: `uv run pipeline/archive_cache.py restore chenhunghan/tw-tree taiwan` (checks SHA-256, extracts into
  `build/cache/`). All sources in the cache (USGS Landsat, Copernicus DEM, WorldCover, Hansen, GISA, GHSL) allow
  redistribution with the attribution already on the card.
- **Hosting:** site on GitHub Pages. Data tiles on a public **Hugging Face dataset** (anonymous browser reads, CORS verified). Uploads use a fine-grained token scoped to that repo only (`hf auth login` locally, the `HF_TOKEN` secret in CI); never commit a token.
- **App:** plain HTML + ES modules + three.js from a CDN importmap (pattern: `~/lns-lab`), with no build step and no external model/texture assets; all geometry is procedural.
  - The basemap is fully custom: terrain from elevation, shaded by land/water/tree fraction.
  - Optional baked-in OSM coastline, roads and labels require ODbL attribution.
- **Location search:**
  - `lat,lon` parsing and browser geolocation run locally.
  - Addresses go to Nominatim (CORS verified) with `countrycodes=tw` and `accept-language=zh-TW` (`en,zh-TW` in the English UI), at most 1 request per second, with no autocomplete, and with OSM attribution shown.

## Implementation (pilot, 2026-09-27)

```
pipeline/                 Python, run with `uv run <script>` (dependencies declared inline; no project venv)
  gee_common.py           grid/tiles, per-sensor prep + calibration, medoid composite (optionally carrying raw DN),
                          features, WorldCover target, DEM; NumPy twins reflectance_np/features_np for local classification
  plan_tiles.py           island tile set + UTM-zone ownership -> tiles_taiwan.json
  sample_training.py      stratified points in every tile + their yearly composite features -> build/train_cache (resumable)
  train_rf.py             local scikit-learn RF on cached samples -> model/<name>.json (EE tree strings, verified) +
                          build/models/<name>.joblib; --compare = temporal stability of saved models on the same points
  train_model.py          v1/v2 trainer (EE smileRandomForest, northern Taiwan, one year)
  export_tiles.py         per tile x year computePixels of the medoid's raw DN + scene index -> build/cache (resumable),
                          then local classification -> site/data/<name>/...; --plan for multi-zone, --assemble-only
  normalise.py            per tile-year relative normalisation on stable forest + stable open land anchors
                          -> model/normalisation_<name>.json (applied by export_tiles.py when present)
  verify_provenance.py    independent check: stored pixel -> raw USGS file on Planetary Computer -> recompute
  analysis/               diagnostics for the post-2013 rise (decompose_cache, where_rise, season_forest,
                          forest_signal, drift_by_region), wrs_zones, and the normalisation inputs/checks
                          (anchor_stats, eval_normalisation, dw_tiles)
site/                     static app (GitHub Pages root); open with `python3 -m http.server` in site/
  index.html              layout + about/limitations dialog (zh-TW)
  js/app.js               scene, timeline autoplay/scrub, tree LOD, picking/info panel, search, `window.__app` test hook
  js/data.js              index.json + gzipped Arrow tiles -> typed arrays
  js/geo.js               UTM<->WGS84 (Krüger series; matches pyproj to 0.1 mm), coordinate parsing, Nominatim with fallback
  js/terrain.js           per-tile terrain mesh at exact pixel centres, GPU year blending
  js/trees.js             procedural instanced broadleaf/conifer trees, 4 slots per pixel
  js/buildings.js         illustrative instanced buildings from GISA first-built year + GHSL height/share
  js/weather.js           decorative sky/weather: sun and moon path, sky colours, stars, drifting clouds + cloud
                          shadows, wind, rain; shared water shader (rivers, lakes, sea)
site/data/<name>/         index.json, summary.parquet, overview.arrow.gz, <zone>/<i>_<j>.{frac,prov}.arrow.gz (published to HF)
.github/workflows/pages.yml  deploys site/ to GitHub Pages on push to main (site/data/ is git-ignored)
```

- Earth Engine project `tpetree` (Community tier). Credentials: `~/.config/earthengine/credentials`. Asset storage is not initialised, so the model is sent inline with each request (about 3 MB).
- Year composite window: the **full calendar year** (Landsat is too sparse for a summer-only window before 2000). Same-date overlapping WRS rows are mosaicked first, so `n` counts dates, not scenes.
- DEM: `COPERNICUS/DEM/GLO30_2024_1`. `mosaic()` must get `setDefaultProjection(native)` before `resample('bilinear')`, otherwise it interpolates at 1°.
- Model `rf_z51_2021`: 60 trees, maxNodes 400, trained on northern Taiwan (zone 51). On held-out 3 km blocks it agrees with WorldCover at R² 0.71, MAE 13 percentage points, bias −0.3 points; the test samples are balanced across tree-fraction levels, so this is not the distribution of the landscape. The model rebuilt from its saved tree strings (6-digit thresholds) differs from the original by at most 0.7 points; every export uses the rebuilt one.
- Export speed: about 23 s per tile-year request; with 6 workers, about 0.24 requests/s. The 20-tile Taipei pilot takes about 1 hour.
- **Published:** https://huggingface.co/datasets/chenhunghan/tw-tree (public, CC BY 4.0; card source: `pipeline/hf_README.md`; upload: `uv run pipeline/publish_hf.py chenhunghan/tw-tree pilot`). The app's default data source is `…/resolve/main/pilot/`; use `?data=./data/pilot/` for local tiles.
- **Verified v2 (2026-09-27):** 60/60 integer positions, 60/60 clear, 59/60 exact, 1 off by 2 points (LC09 2022; float rounding at one tree split). v1 results: `verify_provenance.py` on 60 random pixels: 60/60 integer raw-pixel positions, 60/60 clear in QA, 59/60 exact tree-fraction match, 1 off by 1 point (float rounding). Results are in `build/verify_pilot.json`.
- **Sensor calibration (v2, 2026-09-27):** `pipeline/sensor_calibration.py` fits reduced-major-axis lines per band on same-year, per-sensor annual medians over northern Taiwan, and `--diagnose <model>` measures same-year tree-fraction differences between sensors on the same pixels. Findings:
  - Under Roy et al. 2016 alone, **TM read about 4.9 points lower than ETM+** (2000–02), which caused the step around 1999.
  - ETM+ vs OLI showed no systematic bias.
  - Applied: LT04/LT05 = fitted TM→ETM+ followed by Roy ETM+→OLI; LE07 = Roy; LC08 = reference; LC09 = identity.
  - Rejected: the fitted ETM+→OLI line (visible-band r 0.37–0.52; noise-driven slopes of 1.6–2.1) and the L9→L8 fit.
  - After the fix, TM vs ETM+ is −0.4 points on average. The model was retrained on LC08 only (`rf_z51_2021_oli`, R² 0.714).
  - Coefficients and decisions: `pipeline/model/sensor_calibration.json`. Tile metadata records `harmonisation` and the per-sensor `calibration`.
  - `gee_common.HARMONISATION` defaults to "calibrated" when that file exists; `set_harmonisation("roy")` reproduces v1. The v1 release's `index.json` and `summary.parquet` are kept in `build/releases/pilot_v1` (tiles deleted 2026-09-29; rebuild with `set_harmonisation("roy")`).
- **Earth Engine stalls:** interactive requests occasionally hang indefinitely (one waited over 70 minutes with no CPU). `gee_common.init()` sets `ee.data.setDeadline(300000)`, so a stall fails after 5 minutes and is retried.
- **App look (2026-09-28):** logarithmic depth buffer (the view spans 5 m–900 km; without it water z-fought the sea plane
  and flickered while zooming). Water uses one shader for terrain water pixels and the sea (ripples that fade with
  distance, Fresnel sky reflection, sun/moon glint). Terrain lightness follows tree fraction (the legend ramp) while hue
  varies with elevation and slope (lowland field mosaic, rock on steep slopes, alpine grass > 2,800 m, darker montane
  forest). Weather and time of day are decorative only (URL `?weather=clear|cloudy|rain&hour=0-24`), stated in the about
  panel. Each visit starts ~1.7 km from a random land pixel with mid-range, changing tree cover; 隨機地點 flies to another.
  Tree LOD rebuilds ignore autorotation (only user input counts as moving).
- **Trees and canopy (2026-09-29):** crowns are clusters of alpha-tested leaf cards (four sprig textures painted on a canvas
  at startup: broadleaf, acacia, conifer needles, bamboo; read as linear greys that multiply the vertex colour) around a
  small dark core, with crown-shaped normals. LODs: near (< 320 m: cards per cluster), mid (< 1.5 km: one envelope core +
  16 cards), far (envelope only, no shadow). Instances cover the focus area (see "Tree range"), only
  inside the view cone (horizontal half-FOV + 0.55 rad; all around for steep views) and rebuild on a > 17° turn. Crowns are
  widened up to 1.5× where the pixel's max cover is high, so 100 % closes the canopy. Beyond the trees the terrain shader
  draws the canopy by on-screen scale: lit ~9 m crown cells where crowns are 1–12 px (share of cells = tree fraction),
  soft understorey where the instanced trees stand, the flat ramp colour when crowns are sub-pixel. An adaptive budget
  (`treeQ`, 0.4–1) shrinks the tree radius and the near distance when frames exceed ~26 ms and grows them back under
  ~18 ms; `?trees=1` fixes it (tests). Measured on an M2 Pro at 1280×577: 60 fps at the 1.7 km start view (~70k trees,
  ~2M triangles), ~47 fps with the camera in the canopy at 350 m; rebuilds 30–70 ms for up to 120k trees (per-tile
  cached max cover, row/column window, typed-array output). Alpha-to-coverage was dropped: it left white specks at night.
- **Tree range (2026-10-01):** instanced trees reach `clamp(3 km + 3 × distance, 6–14 km) × (0.5 + 0.5 treeQ)` around
  the focus instead of 1–3.6 km. Four LODs: near < 320 m, mid < 1.5 km, far (20-tri envelope + trunk) < 3 km, dist
  (20-tri crown, 4-sided cone for conifers, no trunk) beyond. Past `THIN_DIST` (3 km × treeQ) from the camera, 8 × 8-pixel blocks get a stride of
  2/4/8 (at 1×/2×/4× that distance), capped so a widened crown (15 m × st) stays under 10 screen px: only every st-th pixel is visited and its 4 trees spread over the block with crowns
  st× wider and st^0.4× taller (same cover; power-of-two grids, so coarser rings are subsets). The outer 20 % of the radius
  is dropped pixel by pixel (hashed, rising to 100 % at the edge) and `uTreeR` is 0.9 × radius, so the canopy lift on the
  terrain takes over as trees thin. Tile streaming follows the tree radius; tile arrivals coalesce into at most one rebuild
  per second. Measured (`?trees=1`, 1280×720): 3.2 km view 85k trees / 1.13M tri (was 120k / 2.47M, forest ending ~4 km
  out), 900 m oblique view 60k / 1.62M (was 20k / 1.11M); steady rebuilds ~50 ms. Frame timing on the test machine was
  too noisy to compare (GPU timer 50–98 ms for identical frames; another GPU load was running). In the 900 m oblique
  view, freezing the shadow map was the one toggle that clearly sped frames up (to the 16.7 ms vsync floor); not yet fixed.
- **Forest realism (2026-10-01, ideas from boring-forest.vercel.app):**
  - Conifers (cypress, hemlock, fir) are grown as whorls of branches. Each branch carries needle-spray cards along it:
    near = 2 cards per branch, folded along the stem so they never vanish edge-on; mid = every 2nd whorl, 1 flat card.
    The needle atlas cell is a single branch spray along u. A dark core cone fills the gaps; far = a cone.
  - Broadleaf crowns are deeper and sit lower: `CLOSURE` widening also raises crown height (×1.225 at full cover), and
    camphor, evergreen broadleaf and golden-rain have a card-only "skirt" ring of lower clusters.
  - An `understorey` pseudo-species (one shrub/sapling clump per pixel with max cover ≥ 55 %, z < 3,000 m, near/mid only,
    appears at fraction 0.5–0.75) hides bare trunks and bright ground.
  - Foliage and trunks get a small ambient floor light (crown undersides were black). Translucency is weighted by the
    baked AO.
  - The LOD distance is divided by tree size. Shadow casters (near/mid within 1.35 × the shadow half-size of the focus)
    come first in each instance buffer, and `onBeforeShadow` draws only those.
  - Terrain:
    - Under dense canopy, the near-scale floor shades toward dark leaf litter.
    - Beyond the instanced-tree radius (`uTreeFocus`/`uTreeR`), land vertices are lifted by 13 m × the closed-canopy
      share (display only; picking still uses the DEM).
  - The grade split-tones the image: cool shade, warm light.
  - Measured on an M2 Pro (1280×720): 23 ms at the 1.7 km test view (unchanged, because trees are not the bottleneck
    there: hiding them all saves < 1 ms); rebuilds 25–70 ms.
- **Shareable views (2026-10-01):** `?at=lat,lon&d=<m>&az=<deg>&el=<deg>&y=<year>` opens at that point (pin + info panel,
  timeline paused on `y`, no autorotate) instead of a random start; only `at` is required. The 分享 button builds the link
  from the selected pixel (else the view centre), the camera distance/heading/tilt and the shown year, writes it to the
  address bar and copies it (shows it in the status line if the clipboard is refused).
- **Site stories (2026-10-01):** `?story=tsmc-<site>` (or `?story=tsmc` for the first) flies to a TSMC site, draws its
  OSM outline on the ground (Line2, depth test off, re-draped as detailed tiles arrive), opens in daylight, holds 3 s on
  the start year (6 years before the decline), then plays at 0.45 years/s through the decline and 2.6 years/s outside it,
  and shows the site vs a 400 m ring series, live per-year values and the before/after summary (`js/story.js`). Data:
  `site/stories/tsmc.json`, from `pipeline/analysis/site_series.py` (owned land pixels whose centre is inside the
  outline, gap-filled like the app, from the published `taiwan/` tiles) and `build_stories.py` (largest 4-vs-3-year step
  down, widened to the whole decline; context text with dates checked against the cited sources; site definitions in
  `pipeline/analysis/tsmc_sites.json`). Outlines are OSM-derived (ODbL; credited in the footer while a story is open).
  Clear stories: Fab 20 Baoshan 55 → 19 % (2023–24), Fab 25 Taichung 47 → 11 % (2025–26), Global R&D Center 55 → 11 %
  (2020–21), Fab 18 Tainan 28 → 7 % (2017–20), Fab 12 Hsinchu 50 → 13 % (2008), Fab 15 Taichung 37 → 15 % (2015–16), AP6
  Zhunan 41 → 21 % (2020–22), Fab 14 Tainan 37 → 20 % (1998, the ring fell too); AP7 Chiayi was farmland (crops read as
  partial cover) and Fab 22 a refinery (16 → 8 %). On phones, story mode hides the header's weather/stats rows, the legend
  and camera buttons, pulls the camera back 1.6× and shifts the image up (`setViewOffset`) above the card.
- **Languages (2026-10-01):** Traditional Chinese and English (`js/i18n.js`). Order: `?lang=zh|en`, then the choice
  saved by the 中文/EN button (localStorage `tpetree.lang`; switching reloads), then `navigator.languages` (zh-* → zh,
  en-* → en), else English. `index.html` is written in Chinese; elements with `data-i18n`, `-title`, `-ph`, `-aria`,
  `-content` keys are replaced in English, and the about dialog has a full `data-lang="en"` copy. Share and story links
  never carry `lang`. Nominatim gets `accept-language=en,zh-TW` in English.
- **Camera (2026-09-29):** MapControls: left-drag pans; right-drag, Shift/Ctrl/⌘+drag or a two-finger twist rotates. A
  control column (row on phones) adds rotate ±26°, tilt ±10°, and a compass that shows north and resets to north-up;
  keys Q/E rotate, R/F tilt, N north. Pending turns are eased and capped, so a held key keeps a steady pace.
- **Display rule:** when a pixel has no clear observation in a year, the app shows its last observed value (leading gaps are back-filled from the first observation) and greys/stripes it. Stored data keeps 255. Area stats in the header use this filled series over the whole tile area (the pilot rectangle, not the city boundary).

## Post-2013 rise (investigated 2026-09-27)
The v2 pilot total rose from ~54 % (2013) to ~64 % (2021) and then stayed flat. Findings:
- **Not a sensor switch.** Rebuilding 2013–2021 with Landsat 8 only (`export_tiles.py --sensors LC08`) keeps the trend and
  makes it steeper (50.9 % → 65.2 %). Within the all-sensor composites, pixels sourced from L7 and from L8 both rise.
- **It sits in forest that cannot gain canopy.** The rise is largest where the 2013–15 baseline was already 50–90 % and at
  100–2000 m (+8–9 points). On stable closed forest (Hansen tree cover 2000 ≥ 80 %, no loss 2001–2025, WorldCover ≥ 0.95),
  L8-only v2 output goes 77 → 81 → 94 → … → 99 (2013 → 2021). Across years it correlates with NDVI (r 0.96) and inversely with
  the L8 `SR_QA_AEROSOL` level (r −0.86). 2013 is hazy (97 % of clear forest observations flagged high aerosol; visible
  reflectance 2–3× 2014); 2014's forest medoid is 79 % winter observations (low NIR).
- **Independent reference is flat.** Dynamic World (Sentinel-2) tree probability on the same forest pixels: 0.71–0.73 for
  2016–2025; all land 0.41–0.44 for 2017–2025.
- **Regional.** On the island-wide sample (22k points), every model (v1, v2, island 2021-only, island multi-year) shows
  northern stable forest (> 24.5° N) rising ~8 points 2014 → 2021, while central/southern forest at any elevation is flat.
  Multi-year training (2014–2025, same WorldCover labels) does **not** remove it, so the change is in the composites'
  reflectance, not an artefact of training on one year.
- **Conclusion:** the rise is mostly a measurement effect: year-to-year changes in northern Taiwan's forest reflectance
  (residual haze, season mix of the medoid dates) that the model reads as tree fraction. Treat regional trends smaller than
  ~8 points in the north after 2013 as unreliable. A step of +3–4 points island-wide appears in 2022 and 2024–25 (L7 leaving,
  L9 arriving, more clear dates).
- **Correction applied (2026-09-29):** see "Normalisation" below.

## Normalisation (applied 2026-09-29)
- **Island-wide picture** (`analysis/anchor_stats.py`, all 761 tiles from the raw-DN cache): stable closed forest reads
  80 % (1987–98) → 83 % → 88 % → 91 % (2022–26), steeper in the north but present everywhere. Its median red falls from
  0.029–0.033 (TM) to 0.020–0.023 after 2018 and SWIR1 from ~0.150 to ~0.135; winter-heavy medoid years (1988, 2010, 2014)
  have low NIR.
- **Forest-only correction rejected.** Mapping each tile-year's stable-forest medians onto 2021 (offset, gain or mixed)
  flattens stable forest but pushes the same shift onto every other surface: stable open land (flat in raw, ~41 %) falls to
  34 %, partial forest (flat, ~57 %) to 52 %. The forest darkening is at least partly forest-specific, not atmospheric.
- **Applied: two anchors** (`normalise.py --mode two --sigma 3 --radius 8`). Per tile-year and band, the line
  `sr' = gain·sr + offset` through the stable-forest and stable-open-land (Hansen 2000 and WorldCover < 10 %, never built)
  medians maps both onto the tile's 2021 medians; where the two medians are < 0.02 apart the gain is 1 (mean offset), and
  gains are clipped to 0.67–1.5. Medians are smoothed within each UTM zone (Gaussian σ 3 tiles ≈ 23 km, radius 8 tiles);
  a tile-year with too little anchor weight uses a wide neighbourhood (σ 5, radius 12; 497 tile-years), otherwise identity
  (1,619 tile-years in 47 tiles: Penghu, Kinmen, Matsu and a few islet/coast tiles). Parameters are in
  `pipeline/model/normalisation_taiwan.json` and in each frac tile's metadata (`normalisation.params[year]`); provenance
  tiles are unchanged.
- **Checks** (`analysis/eval_normalisation.py`, 4,000 sampled land pixels per tile; 1987–98 → 2022–26):
  - all land 62.4 → 69.6 raw vs 63.8 → 66.5; mean |year-to-year| change 1.71 → 0.79 points; 2021 → 2022: 67.5 → 72.4 raw vs 67.5 → 67.8.
  - stable forest 80 → 91 raw vs 84 → 88; partial forest (not fitted) 57 → 57 vs 57 → 54; long-built 18 → 11 vs 17 → 11.
  - Dynamic World (`analysis/dw_tiles.py`, 2016–2025 tile means): island slope +0.04 points/yr; raw +0.39, normalised +0.08.
- **Trade-off:** raw's year-to-year island signal tracks Dynamic World's in direction (r 0.83, but ~5× larger); the
  normalisation removes it (r 0.13), and per-tile agreement with Dynamic World drops (tile anomalies with each year's island mean
  removed: r 0.35 → 0.27). A variant that keeps year-to-year variation (5-year temporal median of the params) kept the 2022 spike; chosen:
  the annual correction, for trends and a steadier timeline. Variants and scores: `build/diag/`.
- **Published:** `taiwan/` is normalised; the previous values are `taiwan_raw/` on Hugging Face (`build/releases/taiwan_v3_raw` keeps only its `index.json` and verify files).
  `export_tiles.py --normalisation none` rebuilds raw.

## Island-wide build (v3, started 2026-09-27, complete 2026-09-29)
- **Tiles:** `plan_tiles.py` → `tiles_taiwan.json`: 761 tiles, 36,319 km² of land (USDOS LSIB, lon ≥ 118, lat ≥ 21.8; Dongsha
  and Taiping excluded). Zone 51 owns every land tile fully inside its real Landsat 8 footprints (663 tiles, including
  Matsu on path 118/042); zone 50 takes the remaining land (98 tiles: SW plain edge 72, Penghu 13, Kinmen 13).
- **Ownership:** where a zone-50 tile overlaps a zone-51 tile, the frac tile's `own` column is 0 (zone 51 takes
  precedence). Stats count owned pixels only; the app discards non-owned pixels in the shader.
- **Land:** frac tiles have `land` (1 = WorldCover 2021 permanent water < 50 %). The model gives open sea a nonzero,
  sensor-dependent "tree fraction" (Matsu tiles showed a fake 2024 collapse), so stats, the overview and trees use land
  pixels only; `f` is still stored for water. The app lets the sea plane show through sea-level water pixels.
- **Built-up context (2026-09-28):** static layers add `built` (GISA 1972–2021 first impervious year − 1900; code 1 = 1972,
  2 = 1978, v ≥ 3 → 1982 + v), `bh` (GHSL GHS-BUILT-H 2018 m) and `bs` (GHS-BUILT-S 2018 10 m share %), all display-only and
  CC BY-compatible. Sources compared: OSM/Overture footprints are ODbL (≈13 % / ≈2M buildings in Taiwan), Microsoft and
  Google footprints do not cover Taiwan, NLSC 3D buildings are not open data, and no open source has per-building
  construction dates. The app draws illustrative instanced buildings (1–3 per built pixel by `bs`, height from `bh`) that
  rise in the pixel's first-built year, tints built-up ground once that year passes, and shows city lights at night.
  GISA only records first construction (no demolition or re-greening) and ends in 2021.
- **Format v2 tiles** (`tpetree tile v2`): frac `x_utm, y_utm, z_m, own, land, built, bh, bs, f<year>`; `overview.arrow.gz` (480 m blocks
  of owned land pixels); index.json `totals` (gap-filled and observed land tree hectares per year), `complete`,
  `tiles_planned`, `scenes_per_year_zone`. Gzip is written with mtime 0, so unchanged tiles are byte-identical and are not
  re-uploaded.
- **Raw-DN caching:** Earth Engine returns, per tile-year, the raw Collection 2 DN of the medoid observation (6 bands,
  uint16) + `s` + `n`, and per tile `static.npz` (z, WorldCover %, Hansen tree cover 2000, loss). Calibration, features and
  the model run locally (`classify()` in `export_tiles.py`). Verified on a pilot tile: scene index identical to the v2 export
  for 100 % of pixels; local tree fraction equals Earth Engine's within 1 point (99.8–100 % exact). A model change is
  `--assemble-only --model <name>`, no Earth Engine. Cache size ~17 GB for the island.
- **Memory-limit fallbacks** (dense years, ~90–150+ scenes per tile): if the DN request exceeds Earth Engine's user memory,
  fetch the composite's reflectance and invert it to the exact DN; if that also fails (zone-51 2022/2023 near 23.9° N),
  `local_medoid` fetches the per-date mosaics' DN + `s` in batches of 24 dates and picks the medoid locally with the same
  rule. Checked against Earth Engine on 40- and 122-scene tile-years: `s`, DN and `n` identical for 100 % of pixels.
  `dn_source` in each year's npz records which path was used (`ee`, `reflectance`, `local_medoid`).
- **Model:** `train_rf.py` on island-wide samples (stratified tree bin × elevation band, 3 per stratum per tile, 22,048
  points, 3 km block hold-out). Island-wide held-out agreement with WorldCover 2021 is lower than the northern v2 figure:
  R² ≈ 0.45, MAE ≈ 21 points (the sample includes many mountain grassland/bamboo pixels; the v2 northern sample scored 0.57 on
  this sample design vs 0.71 on its own). The EE tree strings round-trip exactly (local parser vs sklearn: 3e-16).
- **Verified v3 (2026-09-27, first 8 tiles, 60 pixels):** 60/60 integer positions, 60/60 clear; raw DN identical to
  Planetary Computer in 59/59 same-processing cases (one L9 scene is a 2023 USGS reprocessing in EE vs the 2022 processing
  on PC); tree fraction 59/60 exact, 1 off by 1. Two products are missing on PC and are skipped (that file was later overwritten by the complete-release check below).
- **Complete (2026-09-29 05:21):** 761/761 tiles published to `taiwan/` (`complete: true`); first pass 29,799 requests with 40
  memory-limit failures, the retry pass 1,204 requests with 0. Fetch paths: 31,755 tile-years `ee`, 173 `reflectance`,
  34 `local_medoid`. Gap-filled land tree area before normalisation (now `taiwan_raw/`): 65.2 % (1987–98), 65.7 % (2000–12),
  70.0 % (2014–21), 72.4 % (2022–26) of 3.57 M ha; 2022 alone 75.3 %. Normalised (`taiwan/`): 66.7 %, 68.3 %, 69.1 %, 69.3 %;
  2021 70.3 %, 2022 70.5 %.
- **Verified complete v3 (2026-09-29):** 60 random pixels: 60/60 integer positions and clear, DN identical in 59/59
  same-processing cases, tree fraction 60/60 exact (`build/verify_taiwan.json`). 20 pixels from `local_medoid` tile-years
  (`verify_provenance.py taiwan 20 local_medoid`): 20/20 positions and clear, DN 19/19, tree fraction 20/20 exact, 5 products
  missing on PC skipped (`build/verify_taiwan_local_medoid.json`). Both files for the raw release are kept in
  `build/releases/taiwan_v3_raw/`.
- **Verified normalised v3 (2026-09-29):** 60 random pixels, normalisation applied from the frac metadata: 60/60 integer
  positions and clear, DN identical in 59/59 same-processing cases, tree fraction 59/60 exact; the 60th (1 point) is the
  2023-reprocessed LC09 scene whose DN differ on PC (`build/verify_taiwan.json`).
- **Unattended run:** `pipeline/island_loop.sh` keeps the export running and assembles + publishes `taiwan/` to Hugging Face
  every 3 h; it stops after the final publish. The app reads `taiwan/` once it has ≥ 150 tiles (or is complete) and falls
  back to `pilot/` before that; `?data=` overrides.
- **Earth Engine quota:** the Community tier (150 EECU-hours/month) was exhausted on 2026-09-27; the project runs in
  restricted mode (lower concurrency) until the 1st of each month. Measured throughput in restricted mode ~0.3 requests/s,
  ~30 h for 32,700 requests. The Contributor tier (1,000 EECU-hours/month) needs a billing account (no EE charges).

## Known limitations (best effort; show these in the app's "about" panel)
- **Timeline gaps:** no Tier-1 scenes over Taipei for 1982, 1983 or 1985. 1984 and 1986 have only 1–3 usable scenes. Show gaps as "no data", never interpolate them, and flag low-observation years.
- **Positional accuracy:** exact relative to the raw data, but raw Tier-1 geolocation is about **12 m RMSE**, so features can shift by a fraction of a pixel between years.
- **Landsat 7 stripes:** Landsat 7 has missing stripes from 2003-05-31 (SLC-off). Where no other sensor covers a pixel that year, it is no data.
- **Sensor changes:** v1 totals stepped at the transitions (59.7k ha for 1987–98, 66.6k for 2000–12, 74.8k for 2014–26). v2 removes the measured TM bias (see Sensor calibration). Same-year residuals are within ±3 points per year, and any remaining step in the totals is reported in the dataset card.
- **Model reach:** the model is trained on one year (2021) against one reference (WorldCover). Applying it to the 1980s–1990s assumes the spectral relationships still hold. It has not been independently validated against dated high-resolution imagery.
- **Pixel size:** at 30 m (0.09 ha) most street trees are sub-pixel. Tree fraction shows canopy share, not individual trees; the rendered trees are illustrative, with counts proportional to fraction.
- **UTM zone overlap:** tiles in the overlap band use scenes from one zone only (to stay lossless), which discards some observations.
- **Elevation:** `z_m` is resampled from Copernicus DEM GLO-30. It is for display only and is not a measured value on our grid.
- **Address search:** OSM's Taiwan address coverage is uneven. House numbers often don't resolve, so the search falls back to road, village or district level and tells the user the precision it reached.
- **Model coverage:** the island model is trained on both zones and all elevation bands, but it agrees with WorldCover less well in the mountains (grassland, dwarf bamboo vs forest) than in the lowlands.
- **Drift (normalised):** stable-forest reflectance drifted over time (most in the north after 2013); the per tile-year
  normalisation removes most of it (island land tree area +2.6 points from 1987–98 to 2022–26 instead of +7.2), but stable forest still reads
  ~4 points lower in 1987–98 than after 2014, and the correction also removes some real regional year-to-year signal; the
  outlying islands are not normalised. See "Normalisation".
- **Timing of changes:** a full-year medoid mixes seasons (rice paddies, deciduous trees), so year-to-year differences include some phenology noise.

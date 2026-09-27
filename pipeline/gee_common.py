"""Shared Earth Engine logic: the native Landsat grid, tiles, yearly medoid composites, features.

Grid: Landsat Collection 2 pixel edges sit at 15 m past a multiple of 30 m in each UTM zone, so pixel
centres are exact multiples of 30 m. Requests use a crsTransform aligned to that grid, which means Earth
Engine returns native pixels without resampling.
"""
import json, pathlib
import ee
from pyproj import Transformer

PROJECT = "tpetree"
RES = 30
TILE = 256                      # pixels per tile side
TILE_M = RES * TILE             # 7680 m
EDGE = 15                       # grid edge offset (m)
NODATA_F = 255                  # tree fraction no-data
NODATA_S = 65535                # scene index no-data

COLLECTIONS = {
    "LT04": "LANDSAT/LT04/C02/T1_L2",
    "LT05": "LANDSAT/LT05/C02/T1_L2",
    "LE07": "LANDSAT/LE07/C02/T1_L2",
    "LC08": "LANDSAT/LC08/C02/T1_L2",
    "LC09": "LANDSAT/LC09/C02/T1_L2",
}
BANDS = ["blue", "green", "red", "nir", "swir1", "swir2"]
TM_BANDS = ["SR_B1", "SR_B2", "SR_B3", "SR_B4", "SR_B5", "SR_B7"]    # TM and ETM+
OLI_BANDS = ["SR_B2", "SR_B3", "SR_B4", "SR_B5", "SR_B6", "SR_B7"]
# Roy et al. 2016, Remote Sens. Environ. 185:57-70, Table 2 OLS: OLI = slope * ETM+ + intercept.
# Applied to TM as well (TM and ETM+ are close; see AGENTS.md limitations).
ROY_SLOPE = [0.8474, 0.8483, 0.9047, 0.8462, 0.8937, 0.9071]
ROY_INTERCEPT = [0.0003, 0.0088, 0.0061, 0.0412, 0.0254, 0.0172]
FEATURES = BANDS + ["ndvi", "ndmi", "nbr", "ndwi"]
DN = [f"dn_{b}" for b in BANDS]   # raw Collection 2 Level-2 digital numbers of the chosen observation

# QA_PIXEL bits: 0 fill, 1 dilated cloud, 2 cirrus, 3 cloud, 4 cloud shadow, 5 snow.
QA_REJECT = 0b111111


def init():
    ee.Initialize(project=PROJECT)
    ee.data.setDeadline(300_000)   # fail a stalled request after 5 min instead of hanging


def epsg(zone):
    return 32600 + zone


def tiles_for_bbox(lonlat_bbox, zone):
    """Tile indices (i, j) covering a lon/lat bbox. Tile (i, j) spans
    x in [EDGE + i*TILE_M, EDGE + (i+1)*TILE_M), y in [EDGE + j*TILE_M, EDGE + (j+1)*TILE_M)."""
    tr = Transformer.from_crs(4326, epsg(zone), always_xy=True)
    w, s, e, n = lonlat_bbox
    pts = [tr.transform(x, y) for x in (w, e) for y in (s, n)]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    i0, i1 = int((min(xs) - EDGE) // TILE_M), int((max(xs) - EDGE) // TILE_M)
    j0, j1 = int((min(ys) - EDGE) // TILE_M), int((max(ys) - EDGE) // TILE_M)
    return [(i, j) for j in range(j1, j0 - 1, -1) for i in range(i0, i1 + 1)]


def tile_grid(zone, i, j):
    """computePixels grid for a tile, north-up, row 0 at the top."""
    return {
        "dimensions": {"width": TILE, "height": TILE},
        "affineTransform": {"scaleX": RES, "shearX": 0, "translateX": EDGE + i * TILE_M,
                            "shearY": 0, "scaleY": -RES, "translateY": EDGE + (j + 1) * TILE_M},
        "crsCode": f"EPSG:{epsg(zone)}",
    }


def tile_bounds_geom(zone, i, j):
    x0, y0 = EDGE + i * TILE_M, EDGE + j * TILE_M
    return ee.Geometry.Rectangle([x0, y0, x0 + TILE_M, y0 + TILE_M], f"EPSG:{epsg(zone)}", False)


def pixel_centres(zone, i, j):
    """(x_utm, y_utm) int arrays, row-major, matching computePixels output order."""
    import numpy as np
    c = np.arange(TILE)
    xs = EDGE + i * TILE_M + RES * c + RES // 2
    ys = EDGE + (j + 1) * TILE_M - RES * c - RES // 2
    X, Y = np.meshgrid(xs, ys)
    return X.ravel().astype("int32"), Y.ravel().astype("int32")


def _mask(img, sr):
    qa_ok = img.select("QA_PIXEL").bitwiseAnd(QA_REJECT).eq(0)
    sat_ok = img.select("QA_RADSAT").eq(0)
    range_ok = sr.reduce(ee.Reducer.min()).gte(0).And(sr.reduce(ee.Reducer.max()).lte(1))
    return sr.toFloat().updateMask(qa_ok.And(sat_ok).And(range_ok))


_CALIB_PATH = pathlib.Path(__file__).parent / "model" / "sensor_calibration.json"
# "calibrated": per-sensor RMA lines fitted on Taiwan overlap years (sensor_calibration.py), chained to OLI.
# "roy": Roy et al. 2016 ETM+->OLI coefficients for TM and ETM+ (the first pilot release).
HARMONISATION = "calibrated" if _CALIB_PATH.exists() else "roy"


def set_harmonisation(mode):
    global HARMONISATION
    HARMONISATION = mode


def calibration(key):
    """(slope, intercept) applied to scaled SR for this sensor, or None."""
    if key == "LC08":
        return None
    if HARMONISATION == "roy":
        return None if key == "LC09" else (ROY_SLOPE, ROY_INTERCEPT)
    c = json.loads(_CALIB_PATH.read_text())["apply"][key]
    return c["slope"], c["intercept"]


def prep_for(key, with_dn=False):
    """Scale DN to surface reflectance, rename, apply the sensor calibration, mask.
    with_dn: also carry the raw DN bands (same mask), so a composite can return the untouched source values."""
    bands = OLI_BANDS if key in ("LC08", "LC09") else TM_BANDS
    co = calibration(key)

    def prep(img):
        sr = img.select(bands, BANDS).multiply(0.0000275).add(-0.2)
        if co:
            sr = sr.multiply(ee.Image.constant(co[0])).add(ee.Image.constant(co[1])).rename(BANDS)
        out = _mask(img, sr)
        if with_dn:
            out = out.addBands(img.select(bands, DN).toFloat().updateMask(out.mask().reduce(ee.Reducer.min())))
        return out
    return prep


def reflectance_np(dn, key):
    """Local twin of prep_for: raw DN (..., 6) -> calibrated reflectance, float32 like Earth Engine."""
    import numpy as np
    sr = dn.astype(np.float32) * np.float32(0.0000275) + np.float32(-0.2)
    co = calibration(key)
    if co:
        sr = sr * np.asarray(co[0], np.float32) + np.asarray(co[1], np.float32)
    return sr


def features_np(sr):
    """Local twin of features(): (..., 6) reflectance -> (..., 10) model features."""
    import numpy as np
    b = {k: sr[..., i] for i, k in enumerate(BANDS)}
    nd = lambda a, c: (b[a] - b[c]) / (b[a] + b[c])
    with np.errstate(divide="ignore", invalid="ignore"):
        extra = [nd("nir", "red"), nd("nir", "swir1"), nd("nir", "swir2"), nd("green", "nir")]
    return np.concatenate([sr, np.stack(extra, -1)], -1).astype(np.float32)


def _filtered(cid, region, year, zone):
    return (ee.ImageCollection(cid).filterBounds(region)
            .filterDate(f"{year}-01-01", f"{year + 1}-01-01").filter(ee.Filter.eq("UTM_ZONE", zone)))


def scenes(region, year, zone):
    """Tier-1 scenes for a region/year/zone, sorted by product ID (the order defines the scene index)."""
    col = None
    for cid in COLLECTIONS.values():
        c = _filtered(cid, region, year, zone)
        col = c if col is None else col.merge(c)
    return col.sort("LANDSAT_PRODUCT_ID")


def composite(region, year, zone, sensors=None, with_dn=False):
    """Medoid composite for one year. Returns (image, product_id_list).

    Image bands: BANDS (harmonised reflectance), 's' (scene index, uint16), 'n' (distinct clear dates).
    Overlapping WRS rows on the same date are mosaicked first so a date counts once.
    Every band shares one mask, so the chosen reflectance and scene index always come from the same scene.
    with_dn: the image also has DN (raw digital numbers of the chosen observation).
    """
    pids = scenes(region, year, zone).aggregate_array("LANDSAT_PRODUCT_ID")

    def tagger(prep):
        def tag(img):
            sr = prep(img)
            idx = ee.Image.constant(pids.indexOf(img.get("LANDSAT_PRODUCT_ID"))).toUint16().rename("s")
            return sr.addBands(idx.updateMask(sr.mask().reduce(ee.Reducer.min()))) \
                     .set("DATE_ACQUIRED", img.get("DATE_ACQUIRED"))
        return tag

    tagged = None
    for key, cid in COLLECTIONS.items():
        if sensors and key not in sensors:
            continue
        c = _filtered(cid, region, year, zone).map(tagger(prep_for(key, with_dn)))
        tagged = c if tagged is None else tagged.merge(c)
    dates = tagged.aggregate_array("DATE_ACQUIRED").distinct()
    per_date = ee.ImageCollection(dates.map(
        lambda d: tagged.filter(ee.Filter.eq("DATE_ACQUIRED", d)).mosaic()))
    med = per_date.select(BANDS).median()

    def score(img):
        d = img.select(BANDS).subtract(med).pow(2).reduce(ee.Reducer.sum())
        return img.addBands(d.multiply(-1).rename("q"))

    best = per_date.map(score).qualityMosaic("q")
    n = per_date.select("red").count().rename("n")
    return best.select(BANDS + (DN if with_dn else []) + ["s"]).addBands(n), pids


def features(img):
    b = {k: img.select(k) for k in BANDS}
    nd = lambda a, c, name: b[a].subtract(b[c]).divide(b[a].add(b[c])).rename(name)
    return img.select(BANDS).addBands([
        nd("nir", "red", "ndvi"), nd("nir", "swir1", "ndmi"),
        nd("nir", "swir2", "nbr"), nd("green", "nir", "ndwi")])


def worldcover_tree_fraction(zone):
    """WorldCover 2021 tree class (10) averaged onto our 30 m grid; training target only."""
    wc = ee.ImageCollection("ESA/WorldCover/v200").first().select("Map").eq(10).toFloat()
    return (wc.reduceResolution(ee.Reducer.mean(), maxPixels=1024)
            .reproject(crs=f"EPSG:{epsg(zone)}", crsTransform=[RES, 0, EDGE, 0, -RES, EDGE])
            .rename("wc_frac"))


def elevation():
    """Copernicus DEM GLO-30 (2024 release), bilinear onto the requested grid. Display only."""
    col = ee.ImageCollection("COPERNICUS/DEM/GLO30_2024_1").select("DEM")
    # mosaic() drops the native projection (defaults to 1 degree), which would make bilinear
    # interpolate between 1-degree cells; restore the native 30 m grid first.
    return col.mosaic().setDefaultProjection(col.first().projection()) \
              .resample("bilinear").round().toInt16().rename("z")

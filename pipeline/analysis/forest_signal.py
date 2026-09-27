# /// script
# requires-python = ">=3.11"
# dependencies = ["earthengine-api", "pyproj", "numpy"]
# ///
"""Stable-forest test for the post-2013 rise.

Fixed sample of pixels in the pilot area that are stable closed forest: Hansen GFC tree cover 2000 >= 80 %, no loss
2001-2024, WorldCover 2021 tree fraction >= 0.95, elevation >= 200 m. True canopy share there is ~100 % every year,
so any trend in the model output is a signal/processing effect, not canopy gain.

Per year (Landsat 8 only, the pipeline's medoid composite): mean band reflectance, NDVI, model tree %, and the
mean SR_QA_AEROSOL level of clear observations. Plus Dynamic World (Sentinel-2) mean tree probability, 2016+, on the
same pixels and on a random sample of all land pixels.
  uv run pipeline/analysis/forest_signal.py   ->  build/diag/forest_signal.json
"""
import json, pathlib
import sys; sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import ee, numpy as np
import gee_common as g

ROOT = pathlib.Path(__file__).resolve().parents[2]
BBOX = [121.457, 24.960, 121.666, 25.210]
ZONE, N = 51, 1500
g.init()
region = ee.Geometry.Rectangle(BBOX)
proj = ee.Projection(f"EPSG:{g.epsg(ZONE)}", [30, 0, 15, 0, -30, 15])
han = ee.Image("UMD/hansen/global_forest_change_2025_v1_13")
stable = (han.select("treecover2000").gte(80).And(han.select("lossyear").unmask(0).eq(0))
          .reproject(proj).And(g.worldcover_tree_fraction(ZONE).gte(0.95))
          .And(g.elevation().reproject(proj).gte(200)))
land = g.elevation().reproject(proj).gt(0)
pts_f = stable.selfMask().rename("m").sample(region=region, projection=proj, scale=30, numPixels=N * 4, seed=7,
                                             geometries=True, dropNulls=True).limit(N)
pts_l = land.selfMask().rename("m").sample(region=region, projection=proj, scale=30, numPixels=N * 2, seed=8,
                                           geometries=True, dropNulls=True).limit(N)
m = json.loads((ROOT / "pipeline" / "model" / "rf_z51_2021_oli.json").read_text())
clf = ee.Classifier.decisionTreeEnsemble(m["trees"]).setOutputMode("REGRESSION")


def aerosol_level(y):
    def f(img):
        qa = img.select("QA_PIXEL").bitwiseAnd(g.QA_REJECT).eq(0)
        return img.select("SR_QA_AEROSOL").rightShift(6).bitwiseAnd(3).updateMask(qa).toFloat().rename("aero")
    return g._filtered(g.COLLECTIONS["LC08"], region, y, ZONE).map(f).mean()


def dw(y):
    return (ee.ImageCollection("GOOGLE/DYNAMICWORLD/V1").filterBounds(region)
            .filterDate(f"{y}-01-01", f"{y+1}-01-01").select("trees").mean().rename("dw"))


def ls(y):
    comp, _ = g.composite(region, y, ZONE, sensors=["LC08"])
    feat = g.features(comp)
    f = feat.classify(clf).clamp(0, 1).multiply(100).rename("f")
    return feat.select(g.BANDS + ["ndvi"]).addBands([f, aerosol_level(y)])


out = {"n_forest": pts_f.size().getInfo(), "n_land": pts_l.size().getInfo(), "years": {}}
print("forest pts", out["n_forest"], "land pts", out["n_land"], flush=True)
for y in range(2013, 2026):
    img = ls(y)
    if y >= 2016:
        img = img.addBands(dw(y))
    rows = img.reduceRegions(pts_f, ee.Reducer.first(), crs=proj).getInfo()["features"]
    keys = [k for k in (g.BANDS + ["ndvi", "f", "aero", "dw"]) if k in rows[0]["properties"]]
    vals = {k: np.array([r["properties"].get(k) for r in rows if r["properties"].get(k) is not None], float) for k in keys}
    rec = {k: float(np.mean(v)) for k, v in vals.items() if len(v)}
    rec["high_aero_share"] = float(np.mean(vals["aero"] > 2)) if len(vals.get("aero", [])) else None
    if y >= 2016:
        lr = dw(y).reduceRegions(pts_l, ee.Reducer.first(), crs=proj).getInfo()["features"]
        lv = np.array([r["properties"]["first"] for r in lr if r["properties"].get("first") is not None], float)
        rec["dw_all_land"] = float(lv.mean())
    out["years"][y] = rec
    print(y, json.dumps({k: round(v, 4) if isinstance(v, float) else v for k, v in rec.items()}), flush=True)
p = ROOT / "build" / "diag" / "forest_signal.json"
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(out, indent=1))
print("saved", p)

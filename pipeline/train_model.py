# /// script
# requires-python = ">=3.11"
# dependencies = ["earthengine-api", "pyproj", "numpy"]
# ///
"""Train the tree-fraction model once and save it to model/<name>.json.

Target: ESA WorldCover 2021 tree class averaged to the 30 m grid. Features: the 2021 medoid composite.
Evaluation: 3 km spatial blocks, 1 in 5 held out. This measures agreement with WorldCover, not true accuracy.
The saved tree strings are rebuilt with ee.Classifier.decisionTreeEnsemble, so every export uses the same model.
"""
import json, sys, pathlib, datetime
import ee, numpy as np
import gee_common as g

ZONE = 51
TRAIN_BBOX = [121.20, 24.70, 122.00, 25.30]   # northern Taiwan in zone 51 (Taipei, New Taipei, Keelung, Taoyuan east)
YEAR = 2021
N_PER_BIN = 1500
N_TREES, MAX_NODES, MIN_LEAF = 60, 400, 5
BLOCK_M = 3000
NAME = sys.argv[1] if len(sys.argv) > 1 else "rf_z51_2021"
SENSORS = sys.argv[2].split(",") if len(sys.argv) > 2 else None   # e.g. LC08: train on the reference sensor only

g.init()
region = ee.Geometry.Rectangle(TRAIN_BBOX)
comp, pids = g.composite(region, YEAR, ZONE, sensors=SENSORS)
feat = g.features(comp)
target = g.worldcover_tree_fraction(ZONE)
coords = ee.Image.pixelCoordinates(ee.Projection(f"EPSG:{g.epsg(ZONE)}"))
fold = coords.select("x").divide(BLOCK_M).floor().add(coords.select("y").divide(BLOCK_M).floor().multiply(7919)) \
             .mod(5).abs().toInt().rename("fold")
strata = target.multiply(4).round().toInt().rename("bin")
stack = feat.addBands([target, fold, strata])

samples = stack.stratifiedSample(
    numPoints=N_PER_BIN, classBand="bin", region=region, scale=g.RES,
    projection=ee.Projection(f"EPSG:{g.epsg(ZONE)}", [g.RES, 0, g.EDGE, 0, -g.RES, g.EDGE]),
    seed=42, dropNulls=True, tileScale=4)
train = samples.filter(ee.Filter.neq("fold", 0))
test = samples.filter(ee.Filter.eq("fold", 0))

rf = ee.Classifier.smileRandomForest(numberOfTrees=N_TREES, minLeafPopulation=MIN_LEAF, maxNodes=MAX_NODES,
                                     bagFraction=0.6, seed=42).setOutputMode("REGRESSION") \
       .train(train, "wc_frac", g.FEATURES)
info = rf.explain().getInfo()
trees = info["trees"]

rebuilt = ee.Classifier.decisionTreeEnsemble(trees).setOutputMode("REGRESSION")
pred = test.classify(rebuilt, "pred").classify(rf, "pred_orig")
rows = pred.select(["wc_frac", "pred", "pred_orig"]).getInfo()["features"]
y = np.array([r["properties"]["wc_frac"] for r in rows])
p = np.clip(np.array([r["properties"]["pred"] for r in rows]), 0, 1)
po = np.clip(np.array([r["properties"]["pred_orig"] for r in rows]), 0, 1)
metrics = {
    "n_train": train.size().getInfo(), "n_test": len(rows),
    "mae": float(np.mean(np.abs(p - y))), "rmse": float(np.sqrt(np.mean((p - y) ** 2))),
    "r2": float(1 - np.sum((p - y) ** 2) / np.sum((y - y.mean()) ** 2)),
    "bias": float(np.mean(p - y)),
    "rebuilt_vs_original_max_abs_diff": float(np.max(np.abs(p - po))),
}
print(json.dumps(metrics, indent=1))

out = pathlib.Path(__file__).parent / "model" / f"{NAME}.json"
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps({
    "name": NAME, "created": datetime.date.today().isoformat(),
    "target": "ESA WorldCover 2021 v200 class 10 (tree cover), mean onto 30 m grid",
    "features": g.FEATURES, "training_year": YEAR, "training_sensors": SENSORS or "all", "harmonisation": g.HARMONISATION, "zone": ZONE, "train_bbox": TRAIN_BBOX,
    "classifier": {"type": "smileRandomForest/REGRESSION", "numberOfTrees": N_TREES, "maxNodes": MAX_NODES,
                   "minLeafPopulation": MIN_LEAF, "bagFraction": 0.6, "seed": 42},
    "sampling": {"stratified_bins": "round(wc_frac*4)", "per_bin": N_PER_BIN, "holdout": f"{BLOCK_M} m blocks, fold 0 of 5"},
    "metrics_vs_worldcover_holdout": metrics,
    "importance": info.get("importance"),
    "trees": trees,
}, ensure_ascii=False))
print("saved", out, f"{out.stat().st_size/1e6:.2f} MB")

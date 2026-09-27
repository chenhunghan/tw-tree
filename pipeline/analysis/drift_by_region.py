# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pyproj", "scikit-learn", "earthengine-api"]
# ///
"""Stable-forest tree % per year by region, for saved models (cached training samples, all folds).
  uv run pipeline/analysis/drift_by_region.py <model> ... [--years 2014 2025]"""
import argparse, json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import numpy as np
from pyproj import Transformer
import train_rf as T, gee_common as g

ap = argparse.ArgumentParser(); ap.add_argument("models", nargs="+"); ap.add_argument("--years", type=int, nargs="*")
a = ap.parse_args()
P, F = T.load()
years = a.years or list(range(2014, 2026))
tr = {z: Transformer.from_crs(g.epsg(z), 4326, always_xy=True) for z in (50, 51)}
for p in P:
    p["lon"], p["lat"] = tr[p["zone"]].transform(p["x"], p["y"])
sf = [p for p in P if T.stable_forest(p) and all((p["id"], y) in F for y in years)]
groups = {"north (>24.5N)": [p for p in sf if p["lat"] > 24.5],
          "centre+south <800m": [p for p in sf if p["lat"] <= 24.5 and p["z"] < 800],
          "centre+south >=800m": [p for p in sf if p["lat"] <= 24.5 and p["z"] >= 800]}
for name in a.models:
    pred = T.parse_ee_trees(json.loads((T.ROOT / "pipeline" / "model" / f"{name}.json").read_text())["trees"])
    for gname, grp in groups.items():
        ser = [np.clip(pred(np.array([F[(p["id"], y)][:10] for p in grp], np.float32)), 0, 1).mean() * 100 for y in years]
        print(f"{name:16s} {gname:20s} n={len(grp):4d} | " + " ".join(f"{y % 100:02d}:{v:.0f}" for y, v in zip(years, ser)), flush=True)

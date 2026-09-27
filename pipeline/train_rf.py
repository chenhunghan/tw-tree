# /// script
# requires-python = ">=3.11"
# dependencies = ["earthengine-api", "pyproj", "numpy", "scikit-learn"]
# ///
"""Train the tree-fraction random forest locally on cached samples and save it as Earth Engine tree strings.

  uv run train_rf.py <name> --train-years 2014 2025 [--zones 50 51] [--bbox W S E N]
  uv run train_rf.py --compare <model> ... [--years ...]      # temporal stability of saved models, same points

Samples come from sample_training.py (build/train_cache). Rows are (point, year) pairs: the features of that year's
medoid composite with the WorldCover 2021 tree fraction as the target. Training on several years teaches the model
to ignore year-to-year differences in atmosphere and season mix, which a single-year model reads as tree change.

Evaluation (3 km blocks, fold 0 held out):
  - agreement with WorldCover 2021 on held-out points, overall and per year;
  - temporal stability: mean prediction per year on held-out *stable forest* (Hansen tree cover 2000 >= 80 %, no loss
    2001-2025, WorldCover 2021 tree fraction >= 0.95), whose true canopy share is ~100 % every year.
The saved trees are rebuilt with ee.Classifier.decisionTreeEnsemble and checked against the local predictions.
"""
import argparse, datetime, json, pathlib, time
import numpy as np
from sklearn.ensemble import RandomForestRegressor
import gee_common as g

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / "build" / "train_cache"
N_TREES, MAX_LEAVES, MIN_LEAF, MAX_DEPTH = 60, 400, 5, 26


def load(zones=None, bbox=None):
    pts = []
    for p in sorted((CACHE / "points").glob("*.json")):
        pts += json.loads(p.read_text())
    for k, p in enumerate(pts):
        p["id"] = k
    feats = {}
    for f in (CACHE / "features").glob("*.json"):
        zone, _, year = f.stem.split("_")
        for pid, v in json.loads(f.read_text()).items():
            if all(x is not None for x in v):
                feats[(int(pid), int(year))] = v
    if zones:
        pts = [p for p in pts if p["zone"] in zones]
    if bbox:
        from pyproj import Transformer
        keep = []
        for p in pts:
            lon, lat = Transformer.from_crs(g.epsg(p["zone"]), 4326, always_xy=True).transform(p["x"], p["y"])
            if bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]:
                keep.append(p)
        pts = keep
    return pts, feats


def rows(pts, feats, years):
    X, y, meta = [], [], []
    for p in pts:
        for yr in years:
            v = feats.get((p["id"], yr))
            if v is not None:
                X.append(v[:len(g.FEATURES)]); y.append(p["wc_frac"]); meta.append((p["id"], yr, p["fold"]))
    return np.array(X, dtype=np.float32), np.array(y), np.array(meta)


def stable_forest(p):
    return p["tc2000"] >= 80 and p["loss"] == 0 and p["wc_frac"] >= 0.95


def metrics(y, p):
    p = np.clip(p, 0, 1)
    return {"n": int(len(y)), "mae": float(np.mean(np.abs(p - y))), "rmse": float(np.sqrt(np.mean((p - y) ** 2))),
            "r2": float(1 - np.sum((p - y) ** 2) / np.sum((y - y.mean()) ** 2)), "bias": float(np.mean(p - y))}


def stability(predict, pts, feats, years):
    """Per year: mean predicted tree % on held-out stable forest and on all held-out points (same points every year)."""
    held = [p for p in pts if p["fold"] == 0]
    out = {}
    for name, sel in (("stable_forest", [p for p in held if stable_forest(p)]), ("all_heldout", held)):
        common = [p for p in sel if all((p["id"], yr) in feats for yr in years)]
        per = {}
        for yr in years:
            X = np.array([feats[(p["id"], yr)][:len(g.FEATURES)] for p in common], dtype=np.float32)
            per[yr] = float(np.clip(predict(X), 0, 1).mean() * 100) if len(X) else None
        v = np.array([per[yr] for yr in years])
        out[name] = {"n_points": len(common), "per_year": per, "std": float(v.std()),
                     "range": float(v.max() - v.min())}
    return out


def tree_string(est):
    t, names = est.tree_, g.FEATURES
    lines = [f"n= {t.n_node_samples[0]}", "node), split, n, loss, yval, (yprob)", "* denotes terminal node"]

    def rec(node, nid, depth, split):
        n = int(t.n_node_samples[node])
        leaf = t.children_left[node] == -1
        loss = float(t.impurity[node] * n)
        yval = repr(float(t.value[node].ravel()[0])) if leaf else "0"
        lines.append(f"{' ' * depth}{nid}) {split} {n} {loss:.5g} {yval}{' *' if leaf else ' '}")
        if not leaf:
            f, thr = names[t.feature[node]], repr(float(t.threshold[node]))
            rec(t.children_left[node], 2 * nid, depth + 1, f"{f}<={thr}")
            rec(t.children_right[node], 2 * nid + 1, depth + 1, f"{f}>{thr}")
    rec(0, 1, 0, "root")
    return "\n".join(lines) + "\n"


def parse_ee_trees(trees):
    """Earth Engine / rpart tree strings -> a local predict(X) (mean over trees). Children of node k are 2k and 2k+1."""
    import re
    parsed = []
    for t in trees:
        nodes = {}
        for line in t.splitlines():
            m = re.match(r"\s*(\d+)\) (\S+) \S+ \S+ (\S+)( \*)?", line)
            if not m:
                continue
            nid, split, yval, leaf = int(m[1]), m[2], float(m[3]), bool(m[4])
            nodes[nid] = {"split": split, "leaf": leaf, "yval": yval}
        for nid, n in nodes.items():         # the split on child 2k tells how node k splits
            if not n["leaf"]:
                f, thr = nodes[2 * nid]["split"].split("<=")
                n["f"], n["thr"] = g.FEATURES.index(f), float(thr)
        parsed.append(nodes)

    def predict(X):
        out = np.zeros(len(X))
        for nodes in parsed:
            for r, x in enumerate(X):
                k = 1
                while not nodes[k]["leaf"]:
                    k = 2 * k if x[nodes[k]["f"]] <= nodes[k]["thr"] else 2 * k + 1
                out[r] += nodes[k]["yval"]
        return out / len(parsed)
    return predict


def compare(names, years):
    """Temporal stability of saved models on the same held-out points (local evaluation of the tree strings)."""
    pts, feats = load()
    for name in names:
        m = json.loads((ROOT / "pipeline" / "model" / f"{name}.json").read_text())
        stab = stability(parse_ee_trees(m["trees"]), pts, feats, years)
        for k, s in stab.items():
            print(f"{name:18s} {k:13s} n={s['n_points']:4d} std {s['std']:.2f} range {s['range']:.2f} | "
                  + " ".join(f"{yr % 100:02d}:{v:.1f}" for yr, v in s["per_year"].items()), flush=True)


def verify_ee(trees, X, local, n=400):
    import ee
    g.init()
    clf = ee.Classifier.decisionTreeEnsemble(trees).setOutputMode("REGRESSION")
    idx = np.random.default_rng(0).choice(len(X), size=min(n, len(X)), replace=False)
    fc = ee.FeatureCollection([ee.Feature(None, {**{k: float(X[i, j]) for j, k in enumerate(g.FEATURES)}, "k": int(i)})
                               for i in idx])
    for k in range(8):                   # restricted mode: concurrency errors are common, back off and retry
        try:
            res = fc.classify(clf, "pred").getInfo()["features"]
            break
        except Exception as e:
            if k == 7 or "Too Many" not in str(e):
                raise
            time.sleep(15 * (k + 1))
    d = np.array([abs(r["properties"]["pred"] - local[r["properties"]["k"]]) for r in res])
    return {"n": len(d), "max_abs_diff": float(d.max()), "mean_abs_diff": float(d.mean())}


def fit(X, y, seed=42):
    rf = RandomForestRegressor(n_estimators=N_TREES, max_leaf_nodes=MAX_LEAVES, min_samples_leaf=MIN_LEAF,
                               max_depth=MAX_DEPTH, max_features=0.5, max_samples=0.6, n_jobs=-1, random_state=seed)
    return rf.fit(X, y)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("name", nargs="?")
    ap.add_argument("--train-years", type=int, nargs=2, default=[2014, 2025])
    ap.add_argument("--only-years", type=int, nargs="*", help="train on exactly these years instead of the span")
    ap.add_argument("--zones", type=int, nargs="*")
    ap.add_argument("--bbox", type=float, nargs=4)
    ap.add_argument("--no-verify", action="store_true")
    ap.add_argument("--compare", nargs="*", help="only report temporal stability of these saved models")
    ap.add_argument("--years", type=int, nargs="*", help="years for --compare")
    a = ap.parse_args()
    if a.compare:
        compare(a.compare, a.years or list(range(2014, 2026)))
        return

    pts, feats = load(a.zones, a.bbox)
    all_years = sorted({yr for (_, yr) in feats})
    train_years = a.only_years or list(range(a.train_years[0], a.train_years[1] + 1))
    X, y, meta = rows(pts, feats, train_years)
    tr, te = meta[:, 2] != 0, meta[:, 2] == 0
    print(f"{len(pts)} points, train rows {tr.sum()}, held-out rows {te.sum()}, years {train_years}", flush=True)
    rf = fit(X[tr], y[tr])
    p = rf.predict(X[te])
    m_all = metrics(y[te], p)
    per_year = {int(yr): metrics(y[te][meta[te, 1] == yr], p[meta[te, 1] == yr]) for yr in train_years}
    stab = stability(rf.predict, pts, feats, all_years)
    print("held-out vs WorldCover:", json.dumps({k: round(v, 3) for k, v in m_all.items()}))
    print("2021 held-out:", json.dumps({k: round(v, 3) for k, v in per_year.get(2021, {}).items()}))
    for k, s in stab.items():
        print(f"{k} (n={s['n_points']}): std {s['std']:.2f}, range {s['range']:.2f} points")
        print("   " + " ".join(f"{yr}:{v:.1f}" for yr, v in s["per_year"].items()))

    trees = [tree_string(e) for e in rf.estimators_]
    ver = None if a.no_verify else verify_ee(trees, X[te], p)
    if ver:
        print("EE rebuild vs local:", ver)
    out = ROOT / "pipeline" / "model" / f"{a.name}.json"
    out.write_text(json.dumps({
        "name": a.name, "created": datetime.date.today().isoformat(),
        "target": "ESA WorldCover 2021 v200 class 10 (tree cover), mean onto 30 m grid",
        "features": g.FEATURES, "training_year": train_years, "training_sensors": "all (calibrated to OLI)",
        "harmonisation": g.HARMONISATION, "zones": sorted({p["zone"] for p in pts}), "bbox": a.bbox,
        "classifier": {"type": "sklearn RandomForestRegressor -> EE decisionTreeEnsemble", "n_estimators": N_TREES,
                       "max_leaf_nodes": MAX_LEAVES, "min_samples_leaf": MIN_LEAF, "max_depth": MAX_DEPTH,
                       "max_features": 0.5, "max_samples": 0.6, "random_state": 42},
        "sampling": {"strata": "round(wc_frac*4) x elevation band (<100, 100-500, 500-1500, >=1500 m), 3 per stratum per tile",
                     "holdout": "3000 m blocks, fold 0 of 5", "points": len(pts)},
        "metrics_vs_worldcover_holdout": m_all, "metrics_per_year": per_year,
        "temporal_stability": stab, "ee_rebuild_check": ver,
        "trees": trees,
    }, ensure_ascii=False))
    print("saved", out, f"{out.stat().st_size / 1e6:.2f} MB")
    import joblib                        # the identical forest for fast local prediction in export_tiles.py
    (ROOT / "build" / "models").mkdir(parents=True, exist_ok=True)
    joblib.dump(rf, ROOT / "build" / "models" / f"{a.name}.joblib", compress=3)


if __name__ == "__main__":
    main()

# /// script
# requires-python = ">=3.11"
# dependencies = ["earthengine-api", "pyproj", "numpy"]
# ///
"""Cross-sensor calibration from overlap years (same region, same year, different sensors).

For each pair (source -> target) and overlap year, build per-sensor annual median composites (raw scaled SR, no
harmonisation), sample pixels valid in both, and fit a reduced-major-axis line per band. Chained to OLI:
  ETM+ -> OLI from LE07 vs LC08 (2013-2016, before Landsat 7's orbit drift)
  TM   -> ETM+ from LT05 vs LE07 (2000-2002 SLC-on, 2005-2010)
  L9   -> L8 checked (2022-2024)
Writes model/sensor_calibration.json. `--diagnose` reports the same-year tree-fraction difference between sensors
(with the current prep in gee_common), which should be near zero after calibration.
"""
import json, sys, pathlib, datetime, time
import ee, numpy as np
import gee_common as g

ZONE = 51
REGION = [121.20, 24.70, 122.00, 25.30]
N = 4000
PAIRS = {
    "ETM_to_OLI": ("LE07", "LC08", [2013, 2014, 2015, 2016]),
    "TM_to_ETM": ("LT05", "LE07", [2000, 2001, 2002, 2005, 2007, 2009]),
    "L9_to_L8": ("LC09", "LC08", [2022, 2023, 2024]),
}


def raw_median(sensor, year, region):
    col = g._filtered(g.COLLECTIONS[sensor], region, year, ZONE)
    bands = g.OLI_BANDS if sensor in ("LC08", "LC09") else g.TM_BANDS
    def prep(img):
        sr = img.select(bands, g.BANDS).multiply(0.0000275).add(-0.2)
        return g._mask(img, sr)
    return col.map(prep).median()


def pairs_sample(src, dst, year, region, seed):
    a = raw_median(src, year, region).rename([f"a_{b}" for b in g.BANDS])
    b = raw_median(dst, year, region).rename([f"b_{b}" for b in g.BANDS])
    fc = a.addBands(b).sample(region=region, scale=g.RES, projection=ee.Projection(f"EPSG:{g.epsg(ZONE)}", [30, 0, 15, 0, -30, 15]),
                              numPixels=N, seed=seed, dropNulls=True, tileScale=4)
    rows = fc.getInfo()["features"]
    A = np.array([[r["properties"][f"a_{k}"] for k in g.BANDS] for r in rows])
    B = np.array([[r["properties"][f"b_{k}"] for k in g.BANDS] for r in rows])
    return A, B


def rma(x, y):
    r = np.corrcoef(x, y)[0, 1]
    slope = np.sign(r) * y.std() / x.std()
    return float(slope), float(y.mean() - slope * x.mean()), float(r)


def fit():
    g.init()
    region = ee.Geometry.Rectangle(REGION)
    out = {"created": datetime.date.today().isoformat(), "method": "reduced major axis per band on same-year per-sensor annual medians",
           "region": REGION, "zone": ZONE, "bands": g.BANDS, "pairs": {}}
    for name, (src, dst, years) in PAIRS.items():
        As, Bs = [], []
        for y in years:
            A, B = pairs_sample(src, dst, y, region, seed=y)
            print(f"{name} {y}: {len(A)} pixels", flush=True)
            As.append(A); Bs.append(B)
        A, B = np.vstack(As), np.vstack(Bs)
        ok = np.all((A > 0) & (A < 1) & (B > 0) & (B < 1), axis=1)
        A, B = A[ok], B[ok]
        fits = [rma(A[:, i], B[:, i]) for i in range(len(g.BANDS))]
        out["pairs"][name] = {"source": src, "target": dst, "years": years, "n": int(len(A)),
                              "slope": [f[0] for f in fits], "intercept": [f[1] for f in fits], "r": [f[2] for f in fits],
                              "mean_bias_before": (B - A).mean(0).tolist()}
        print(name, json.dumps(out["pairs"][name], indent=None)[:400], flush=True)
    # chain TM -> OLI = ETM_to_OLI(TM_to_ETM(x))
    s1, i1 = np.array(out["pairs"]["TM_to_ETM"]["slope"]), np.array(out["pairs"]["TM_to_ETM"]["intercept"])
    s2, i2 = np.array(out["pairs"]["ETM_to_OLI"]["slope"]), np.array(out["pairs"]["ETM_to_OLI"]["intercept"])
    out["apply"] = {
        "LT04": {"slope": (s1 * s2).tolist(), "intercept": (i1 * s2 + i2).tolist(), "note": "TM chained via ETM+ (LT04 assumed like LT05)"},
        "LT05": {"slope": (s1 * s2).tolist(), "intercept": (i1 * s2 + i2).tolist()},
        "LE07": {"slope": s2.tolist(), "intercept": i2.tolist()},
        "LC08": {"slope": [1] * 6, "intercept": [0] * 6},
        "LC09": {"slope": out["pairs"]["L9_to_L8"]["slope"], "intercept": out["pairs"]["L9_to_L8"]["intercept"]},
    }
    p = pathlib.Path(__file__).parent / "model" / "sensor_calibration.json"
    p.write_text(json.dumps(out, indent=1))
    print("saved", p)


def diagnose(model_name):
    """Same-year, same-pixel tree fraction from single-sensor medoid composites, using gee_common's current prep."""
    g.init()
    region = ee.Geometry.Rectangle(REGION)
    m = json.loads((pathlib.Path(__file__).parent / "model" / f"{model_name}.json").read_text())
    clf = ee.Classifier.decisionTreeEnsemble(m["trees"]).setOutputMode("REGRESSION")
    report = {}
    for name, (src, dst, years) in PAIRS.items():
        diffs = []
        for y in years[:3]:
            fa = g.features(g.composite(region, y, ZONE, sensors=[src])[0]).classify(clf).rename("fa")
            fb = g.features(g.composite(region, y, ZONE, sensors=[dst])[0]).classify(clf).rename("fb")
            fc = fa.addBands(fb).sample(region=region, scale=g.RES, numPixels=3000, seed=y, dropNulls=True, tileScale=4)
            t0 = time.time()
            for attempt in range(3):
                try:
                    rows = fc.getInfo()["features"]; break
                except Exception as e:
                    print(f"  {name} {y}: attempt {attempt + 1} failed after {time.time() - t0:.0f}s: {str(e)[:120]}", flush=True)
                    if attempt == 2: raise
            a = np.array([r["properties"]["fa"] for r in rows]); b = np.array([r["properties"]["fb"] for r in rows])
            diffs.append(float(np.mean(np.clip(a, 0, 1) - np.clip(b, 0, 1)) * 100))
            print(f"{name} {y}: mean tree% {src} - {dst} = {diffs[-1]:+.2f} points (n={len(a)}, {time.time() - t0:.0f}s)", flush=True)
        report[name] = {"years": years[:3], "mean_diff_points": diffs}
    out = pathlib.Path(__file__).resolve().parent.parent / "build" / f"sensor_diagnose_{model_name}.json"
    out.write_text(json.dumps(report, indent=1))
    print("saved", out)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--diagnose":
        diagnose(sys.argv[2] if len(sys.argv) > 2 else "rf_z51_2021")
    else:
        fit()

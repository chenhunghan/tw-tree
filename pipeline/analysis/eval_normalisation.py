# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pyarrow", "pandas", "scikit-learn", "joblib", "earthengine-api", "pyproj"]
# ///
"""Compare tree % with and without per tile-year normalisation, on a fixed random sample of owned land pixels per tile.

Groups (from the static layers): anchor = stable closed forest (the pixels the correction is fitted on); partial = forest
not used for the fit (Hansen 2000 30-79 %, WorldCover 30-90 %, no loss, never built); built = built by 1990 with GHSL share
>= 50 %; open = WorldCover and Hansen 2000 < 10 %, never built; all = every sampled land pixel.

  uv run pipeline/analysis/eval_normalisation.py taiwan build/diag/norm_add.json build/diag/norm_mixed.json ...
      ->  build/diag/eval_normalisation.parquet (tile, year, variant, group, n, f_mean)
"""
import concurrent.futures as cf, json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import joblib, numpy as np, pyarrow as pa, pyarrow.parquet as pq
import gee_common as g, normalise as N

ROOT = pathlib.Path(__file__).resolve().parents[2]
SAMPLE = 4000


def groups(st, keep):
    tc, wc, loss = st["tc2000"].ravel()[keep], st["wc"].ravel()[keep], st["loss"].ravel()[keep]
    built, bs = st["built"].ravel()[keep], st["bs"].ravel()[keep]
    v = (tc != 255) & (wc != 255)
    return {"all": np.ones(keep.size, bool),
            "anchor": v & (tc >= 80) & (wc >= 95) & (loss == 0) & (built == 0),
            "partial": v & (tc >= 30) & (tc < 80) & (wc >= 30) & (wc <= 90) & (loss == 0) & (built == 0),
            "built": (built > 0) & (built <= 90) & (bs >= 50),
            "open": v & (tc < 10) & (wc < 10) & (built == 0)}


def run(job):
    name, zone, i, j, own, variants, model = job
    rf = joblib.load(ROOT / "build" / "models" / f"{model}.joblib")
    cache = ROOT / "build" / "cache" / name / str(zone) / f"{i}_{j}"
    st = np.load(cache / "static.npz")
    cand = np.flatnonzero(own & (st["water"].ravel() < 50))
    if not len(cand):
        return []
    keep = np.sort(np.random.default_rng(zone * 100000 + i * 1000 + j).choice(cand, min(SAMPLE, len(cand)), replace=False))
    gr = groups(st, keep)
    key, rows = f"{zone}_{i}_{j}", []
    for p in sorted(cache.glob("[12]*.npz")):
        yr = int(p.stem)
        d = np.load(p)
        s, dn, pids = d["s"].ravel()[keep], d["dn"].reshape(-1, 6)[keep], d["pids"]
        ok = s != g.NODATA_S
        if not ok.any():
            continue
        sensor = np.array([q[:4] for q in pids])[s[ok]]
        sr = np.empty((ok.sum(), 6), np.float32)
        for k in np.unique(sensor):
            m = sensor == k
            sr[m] = g.reflectance_np(dn[ok][m], k)
        for vname, v in [("raw", None)] + variants:
            x = sr if v is None else N.apply(sr, v["params"][key][yr])
            X = np.nan_to_num(g.features_np(x), nan=0.0, posinf=0.0, neginf=0.0)
            f = np.clip(rf.predict(X), 0, 1) * 100
            for gname, gm in gr.items():
                m = gm[ok]
                if m.sum():
                    rows.append({"zone": zone, "i": i, "j": j, "year": yr, "variant": vname, "group": gname,
                                 "n": int(m.sum()), "f_mean": float(f[m].mean())})
    return rows


if __name__ == "__main__":
    import export_tiles as E
    name, paths = sys.argv[1], sys.argv[2:]
    model = "rf_tw_2021"
    variants = []
    for p in paths:
        d = N.load(p)
        variants.append((pathlib.Path(p).stem.replace("norm_", ""), d))
    plan = json.loads((ROOT / "pipeline" / "tiles_taiwan.json").read_text())
    tiles = [(t["zone"], t["i"], t["j"]) for t in plan["tiles"]]
    z51 = {(i, j) for (z, i, j) in tiles if z == 51}
    jobs = [(name, z, i, j, E.own_mask(z, i, j, z51).astype(bool), variants, model) for (z, i, j) in tiles]
    rows = []
    with cf.ProcessPoolExecutor(8) as ex:
        for k, r in enumerate(ex.map(run, jobs)):
            rows += r
            if k % 50 == 0:
                print(f"{k}/{len(jobs)}", flush=True)
    out = ROOT / "build" / "diag" / "eval_normalisation.parquet"
    pq.write_table(pa.Table.from_pylist(rows), out)
    print("saved", out, len(rows))

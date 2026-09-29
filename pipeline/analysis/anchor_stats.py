# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pyarrow", "scikit-learn", "joblib", "earthengine-api", "pyproj"]
# ///
"""Per tile-year reflectance and tree % of stable pixel groups, from the raw-DN cache (no Earth Engine).

Groups (owned land pixels only):
  anchor   stable closed forest (Hansen tree cover 2000 >= 80 %, no loss 2001-2025, WorldCover 2021 tree >= 95 %,
           never built) in even 480 m blocks of a checkerboard
  holdout  the same definition in odd blocks: never used to fit a correction, only to check it
  built    long-built pixels (GISA first impervious <= 1990, GHSL built share >= 50 %)
  open     stable non-tree land (Hansen tree cover 2000 < 10 %, WorldCover 2021 tree < 10 %, never built)
Per group: pixel count, per-band median calibrated reflectance, mean model tree %, mean month and summer share of the
chosen observations.

  uv run pipeline/analysis/anchor_stats.py taiwan [model] [first_n_tiles]   ->  build/diag/anchor_stats_<name>.parquet
"""
import concurrent.futures as cf, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import joblib, numpy as np, pyarrow as pa, pyarrow.parquet as pq
import gee_common as g

ROOT = pathlib.Path(__file__).resolve().parents[2]
name = sys.argv[1] if len(sys.argv) > 1 else "taiwan"
model = sys.argv[2] if len(sys.argv) > 2 else "rf_tw_2021"
BLK = 16


def groups(st, own):
    tc, wc, loss = st["tc2000"].ravel(), st["wc"].ravel(), st["loss"].ravel()
    built, bs, land = st["built"].ravel(), st["bs"].ravel(), st["water"].ravel() < 50
    base = land & own
    forest = base & (tc >= 80) & (tc != 255) & (wc >= 95) & (wc != 255) & (loss == 0) & (built == 0)
    r, c = np.divmod(np.arange(g.TILE * g.TILE), g.TILE)
    even = ((r // BLK + c // BLK) % 2) == 0
    return {"anchor": forest & even, "holdout": forest & ~even,
            "built": base & (built > 0) & (built <= 90) & (bs >= 50),
            "open": base & (tc < 10) & (wc < 10) & (built == 0)}


def tile_rows(job):
    zone, i, j, own = job
    rf = joblib.load(ROOT / "build" / "models" / f"{model}.joblib")
    cache = ROOT / "build" / "cache" / name / str(zone) / f"{i}_{j}"
    st = np.load(cache / "static.npz")
    gr = groups(st, own)
    z = st["z"].ravel()
    rows = []
    for p in sorted(cache.glob("[12]*.npz")):
        d = np.load(p)
        s, dn, pids = d["s"].ravel(), d["dn"].reshape(-1, 6), d["pids"]
        ok = s != g.NODATA_S
        if not ok.any():
            continue
        sensor = np.array([q[:4] for q in pids])
        month = np.array([int(q.split("_")[3][4:6]) for q in pids])
        for gname, m in gr.items():
            m = m & ok
            rec = {"zone": zone, "i": i, "j": j, "year": int(p.stem), "group": gname, "n": int(m.sum())}
            if m.sum() >= 20:
                sm = s[m]
                sr = np.empty((m.sum(), 6), np.float32)
                for key in np.unique(sensor[sm]):
                    k = sensor[sm] == key
                    sr[k] = g.reflectance_np(dn[m][k], key)
                X = np.nan_to_num(g.features_np(sr), nan=0.0, posinf=0.0, neginf=0.0)
                f = np.clip(rf.predict(X), 0, 1) * 100
                med = np.median(sr, 0)
                rec.update({f"med_{b}": float(v) for b, v in zip(g.BANDS, med)})
                rec.update({"f_mean": float(f.mean()), "z_mean": float(z[m].mean()),
                            "month_mean": float(month[sm].mean()), "summer": float(np.isin(month[sm], [5, 6, 7, 8, 9]).mean()),
                            "main_sensor": str(np.unique(sensor[sm], return_counts=True)[0][np.argmax(np.unique(sensor[sm], return_counts=True)[1])])})
            rows.append(rec)
    return rows


if __name__ == "__main__":
    import json
    import export_tiles as E
    plan = json.loads((ROOT / "pipeline" / "tiles_taiwan.json").read_text()) if name == "taiwan" else None
    tiles = [(t["zone"], t["i"], t["j"]) for t in plan["tiles"]] if plan else \
        [(int(p.parent.name), *map(int, p.name.split("_"))) for p in sorted((ROOT / "build" / "cache" / name).glob("*/*_*")) if p.is_dir()]
    z51 = {(i, j) for (z, i, j) in tiles if z == 51} if len({t[0] for t in tiles}) > 1 else set()
    if len(sys.argv) > 3:                          # quick test: first N tiles
        tiles = tiles[:int(sys.argv[3])]
    jobs = [(z, i, j, E.own_mask(z, i, j, z51).astype(bool)) for (z, i, j) in tiles]
    rows = []
    with cf.ProcessPoolExecutor(8) as ex:
        for k, r in enumerate(ex.map(tile_rows, jobs)):
            rows += r
            if k % 50 == 0:
                print(f"{k}/{len(jobs)}", flush=True)
    out = ROOT / "build" / "diag" / f"anchor_stats_{name}.parquet"
    out.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(rows), out)
    print("saved", out, len(rows), "rows")

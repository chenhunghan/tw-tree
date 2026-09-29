# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pyarrow", "pandas", "pyproj", "earthengine-api"]
# ///
"""Per tile-year relative normalisation on stable anchor pixels.

Anchors (analysis/anchor_stats.py):
  forest  stable closed forest: Hansen tree cover 2000 >= 80 %, no loss 2001-2025, WorldCover 2021 tree >= 95 %,
          never built. ~100 % canopy every year, yet its composite reflectance drifts (residual haze, season mix of the
          medoid dates) and the model reads that drift as tree fraction.
  open    stable non-tree land: Hansen 2000 and WorldCover 2021 tree < 10 %, never built.
For each tile-year a per-band line sr' = gain * sr + offset maps the anchors' median reflectance onto the same tile's
reference-year medians, and is applied to every pixel of that tile-year before the model.

Modes:
  add, mul, mixed   forest anchor only: offset, gain, or offset for visible bands and gain for NIR/SWIR
  two               both anchors: the line through (forest, open) for each band; where the two medians are closer than
                    MIN_SPREAD in a band, gain 1 and the mean offset of the two anchors
The anchor medians are smoothed spatially within each UTM zone (Gaussian over tile centres, weighted by anchor count), so
tiles with few anchors borrow from their neighbours; a tile-year with too little anchor weight nearby tries a wide
neighbourhood (sigma ~38 km, up to ~90 km), and failing that gets no correction (identity) and is flagged. The reference
and the year are always taken from the same neighbourhood.

  uv run normalise.py taiwan --mode two        ->  model/normalisation_<name>.json
"""
import argparse, json, pathlib
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
BANDS = ["blue", "green", "red", "nir", "swir1", "swir2"]
MODES = ("add", "mul", "mixed", "two")
LEVELS = ((1.5, 4, 2000), (5.0, 12, 5000))   # (sigma, radius in tiles, min anchor weight): local, then wide
MIN_SPREAD = 0.02                            # reflectance; below this the two-anchor slope is not trusted
GAIN_RANGE = (0.67, 1.5)


def _line(ref, cur, mode):
    """Per-band (gain, offset) from reference and current medians: dict group -> (6,) arrays."""
    rf, cf = ref["anchor"], cur["anchor"]
    if mode == "add":
        return np.ones(6), rf - cf
    if mode == "mul":
        return rf / cf, np.zeros(6)
    if mode == "mixed":
        vis = np.array([True, True, True, False, False, False])
        return np.where(vis, 1.0, rf / cf), np.where(vis, rf - cf, 0.0)
    ro, co = ref["open"], cur["open"]
    spread = co - cf
    ok = (np.abs(spread) >= MIN_SPREAD) & (np.abs(ro - rf) >= MIN_SPREAD)
    gain = np.where(ok, (ro - rf) / np.where(ok, spread, 1), 1.0)
    gain = np.clip(gain, *GAIN_RANGE)
    offset = np.where(ok, rf - gain * cf, ((rf - cf) + (ro - co)) / 2)
    return gain, offset


def temporal(params, k):
    """Centred rolling median of each tile's params over 2k+1 available years: keeps the slow drift and sensor steps
    in the correction but leaves single-year departures in the data."""
    out = {}
    for key, ys in params.items():
        yrs = sorted(ys)
        P = np.array([ys[y] for y in yrs])
        out[key] = {y: [float(v) for v in np.median(P[max(0, n - k):n + k + 1], 0)] for n, y in enumerate(yrs)}
    return out


def fit(stats, all_tiles, mode, ref_year=2021, levels=LEVELS):
    """stats: anchor_stats rows. Returns {(zone, i, j): {year: [gain x6, offset x6]}} and, per tile, the tile-years that
    needed the wide neighbourhood or got no correction (identity)."""
    groups = ("anchor", "open") if mode == "two" else ("anchor",)
    st = stats[stats.group.isin(groups) & (stats.n >= 20)]
    params, wide, ident = {}, {}, {}
    for zone in sorted({z for z, _, _ in all_tiles}):
        by = {(gname, y): d.set_index(["i", "j"]) for (gname, y), d in st[st.zone == zone].groupby(["group", "year"])}

        def smooth(i, j, d, sigma, radius, min_weight):
            if d is None:
                return None
            di, dj = d.index.get_level_values(0).values - i, d.index.get_level_values(1).values - j
            near = (np.abs(di) <= radius) & (np.abs(dj) <= radius)
            w = d.n.values[near] * np.exp(-(di[near] ** 2 + dj[near] ** 2) / (2 * sigma ** 2))
            if w.sum() < min_weight:
                return None
            return (w[:, None] * d[[f"med_{b}" for b in BANDS]].values[near]).sum(0) / w.sum()

        def medians(i, j, y, lv):
            out = {gname: smooth(i, j, by.get((gname, y)), *lv) for gname in groups}
            return out if all(v is not None for v in out.values()) else None

        years = sorted({int(y) for y in stats[stats.zone == zone].year})
        for (i, j) in sorted({(i, j) for (z, i, j) in all_tiles if z == zone}):
            key, out = f"{zone}_{i}_{j}", {}
            for y in years:
                for k, lv in enumerate(levels):
                    ref, cur = medians(i, j, ref_year, lv), medians(i, j, y, lv)
                    if ref is not None and cur is not None:
                        gain, offset = _line(ref, cur, mode)
                        out[y] = [float(v) for v in gain] + [float(v) for v in offset]
                        if k:
                            wide.setdefault(key, []).append(y)
                        break
                else:
                    out[y] = [1.0] * 6 + [0.0] * 6
                    ident.setdefault(key, []).append(y)
            params[(zone, i, j)] = out
    return params, wide, ident


def apply(sr, p):
    """sr (..., 6) float32 reflectance -> gain * sr + offset with this tile-year's params [gain x6, offset x6]."""
    p = np.asarray(p, np.float32)
    return (sr * p[:6] + p[6:]).astype(np.float32)


def load(path):
    d = json.loads(pathlib.Path(path).read_text())
    d["params"] = {k: {int(y): v for y, v in ys.items()} for k, ys in d["params"].items()}
    return d


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("name")
    ap.add_argument("--mode", default="two", choices=MODES)
    ap.add_argument("--ref-year", type=int, default=2021)
    ap.add_argument("--sigma", type=float, default=LEVELS[0][0], help="local smoothing sigma, in tiles (7.68 km)")
    ap.add_argument("--radius", type=int, default=LEVELS[0][1], help="local neighbourhood half-width, in tiles")
    ap.add_argument("--temporal", type=int, default=0, help="rolling median of the params over +-k years (0 = off)")
    ap.add_argument("--out", help="output JSON (default model/normalisation_<name>.json)")
    a = ap.parse_args()
    plan = json.loads((ROOT / "pipeline" / "tiles_taiwan.json").read_text())
    import pandas as pd
    stats = pd.read_parquet(ROOT / "build" / "diag" / f"anchor_stats_{a.name}.parquet")
    levels = ((a.sigma, a.radius, LEVELS[0][2]),) + LEVELS[1:]
    params, wide, flags = fit(stats, [(t["zone"], t["i"], t["j"]) for t in plan["tiles"]], a.mode, a.ref_year, levels)
    if a.temporal:
        params = temporal(params, a.temporal)
    out = pathlib.Path(a.out) if a.out else ROOT / "pipeline" / "model" / f"normalisation_{a.name}.json"
    out.write_text(json.dumps({
        "method": "per tile-year relative normalisation: sr' = gain * sr + offset per band, mapping the median "
                  "reflectance of stable anchor pixels onto the same tile's reference year (see normalise.py)",
        "mode": a.mode, "bands": BANDS, "params_layout": "gain x6, offset x6", "reference_year": a.ref_year,
        "levels": [{"sigma_tiles": sg, "radius_tiles": r, "min_anchor_weight": w} for sg, r, w in levels],
        "temporal_median_halfwidth_years": a.temporal, "min_spread": MIN_SPREAD, "gain_range": GAIN_RANGE,
        "wide_tile_years": wide, "identity_tile_years": flags,
        "params": {f"{z}_{i}_{j}": {str(y): [round(v, 6) for v in ps] for y, ps in ys.items()}
                   for (z, i, j), ys in sorted(params.items())},
    }, indent=0))
    n_id = sum(len(v) for v in flags.values())
    print(f"wrote {out}: {len(params)} tiles; wide neighbourhood {sum(map(len, wide.values()))} tile-years, "
          f"identity {n_id} tile-years in {len(flags)} tiles")

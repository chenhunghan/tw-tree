# /// script
# requires-python = ">=3.11"
# dependencies = ["earthengine-api", "pyproj", "numpy", "pyarrow", "scikit-learn", "joblib"]
# ///
"""Export tree-fraction tiles on the native Landsat grid.

  uv run export_tiles.py --name pilot --bbox 121.457 24.960 121.666 25.210 --zone 51
  uv run export_tiles.py --name taiwan --plan tiles_taiwan.json          # both UTM zones, island-wide
  uv run export_tiles.py --name taiwan --plan tiles_taiwan.json --assemble-only   # write whatever tiles are complete

For each 256x256 tile and year, Earth Engine computes the medoid composite and returns the raw Collection 2 digital
numbers of the chosen observation (6 bands, uint16), s (scene index, uint16) and n (clear dates, uint8); once per tile
it returns static layers (elevation, WorldCover 2021 tree fraction, Hansen tree cover 2000 and loss). Responses are
cached under build/cache so an interrupted run resumes; failed requests are logged and retried on the next run.

Everything after the medoid choice is local: DN -> reflectance -> sensor calibration -> features -> model -> f. So a new
model or correction never needs Earth Engine again; `--assemble-only --model <name>` rebuilds the tiles.
The assembled tiles are written to site/data/<name>/<zone>/<i>_<j>.{frac,prov}.arrow.gz, plus index.json,
summary.parquet and overview.arrow.gz (480 m block means for the zoomed-out view).

Ownership: with --plan, a zone-50 tile can overlap zone-51 tiles along the zone boundary. The `own` column is 0 for
pixels whose location is also inside a zone-51 tile (zone 51 takes precedence), so every location is counted once.
"""
import argparse, concurrent.futures as cf, datetime, gzip, io, json, pathlib, threading, time
import ee, joblib, numpy as np, pyarrow as pa, pyarrow.ipc as ipc, pyarrow.parquet as pq
from pyproj import Transformer
import gee_common as g

ROOT = pathlib.Path(__file__).resolve().parent.parent
ATTRIBUTION = ("Landsat Collection 2 Level-2 courtesy of the U.S. Geological Survey; "
               "ESA WorldCover 2021 v200 (CC BY 4.0); Copernicus DEM GLO-30 (c) DLR/Airbus, provided under COPERNICUS by the EU and ESA; "
               "Hansen/UMD/Google/USGS/NASA Global Forest Change 2000-2025 v1.13 (CC BY 4.0); GISA 1972-2021, Ren et al. 2025 (CC BY 4.0); "
               "JRC GHSL P2023A GHS-BUILT-H/GHS-BUILT-S (European Commission, JRC)")
OV = 16                         # overview block size in pixels (480 m)
TRANSIENT = ("429", "Too Many", "timed out", "503", "500", "deadline", "Deadline", "Computation timed out",
             "Connection", "capacity", "Internal error")


def load_model(name):
    """The published tree strings (model/<name>.json) plus the identical scikit-learn forest for fast local prediction
    (build/models/<name>.joblib, written by train_rf.py). The two are checked against each other before use."""
    m = json.loads((ROOT / "pipeline" / "model" / f"{name}.json").read_text())
    rf = joblib.load(ROOT / "build" / "models" / f"{name}.joblib")
    import train_rf
    X = np.random.default_rng(1).uniform([0] * 6 + [-1] * 4, [0.6] * 6 + [1] * 4, size=(2000, 10)).astype(np.float32)
    d = np.abs(train_rf.parse_ee_trees(m["trees"])(X) - rf.predict(X)).max()
    if d > 1e-9:
        raise SystemExit(f"{name}: joblib forest differs from the published tree strings (max {d})")
    return m, rf


def year_image(zone, i, j, year, sensors=None):
    region = g.tile_bounds_geom(zone, i, j)
    comp, pids = g.composite(region, year, zone, sensors=sensors, with_dn=True)
    img = ee.Image.cat([comp.select(g.DN).unmask(0).toUint16(),
                        comp.select("s").unmask(g.NODATA_S).toUint16(),
                        comp.select("n").unmask(0).toUint8()])
    return img, pids


def static_image(zone):
    proj = ee.Projection(f"EPSG:{g.epsg(zone)}", [g.RES, 0, g.EDGE, 0, -g.RES, g.EDGE])
    han = ee.Image("UMD/hansen/global_forest_change_2025_v1_13")
    wc = ee.ImageCollection("ESA/WorldCover/v200").first().select("Map")
    # Built-up context (display only): GISA first impervious year (1 = 1972, 2 = 1978, v >= 3 -> 1982 + v; 0 = never),
    # stored as year - 1900; GHSL 2018 building height (m, 100 m) and built surface share of the pixel (%, from 10 m).
    gisa = ee.Image("projects/sat-io/open-datasets/GISA_1972_2021").select(0)
    built = gisa.add(82).where(gisa.eq(1), 72).where(gisa.eq(2), 78).where(gisa.eq(0), 0)
    bh = ee.ImageCollection("JRC/GHSL/P2023A/GHS_BUILT_H").first().select("built_height")
    bs = ee.ImageCollection("JRC/GHSL/P2023A/GHS_BUILT_S_10m").first().select(0)
    return ee.Image.cat([
        g.elevation(),
        wc.eq(80).toFloat().reduceResolution(ee.Reducer.mean(), maxPixels=1024).reproject(proj)
          .multiply(100).round().unmask(100).toUint8().rename("water"),
        g.worldcover_tree_fraction(zone).multiply(100).round().unmask(255).toUint8().rename("wc"),
        han.select("treecover2000").reproject(proj).unmask(255).toUint8().rename("tc2000"),
        han.select("lossyear").unmask(0).gt(0).reduceResolution(ee.Reducer.max(), maxPixels=64).reproject(proj)
           .unmask(0).toUint8().rename("loss"),
        built.reproject(proj).unmask(0).toUint8().rename("built"),
        bh.reproject(proj).round().clamp(0, 255).unmask(0).toUint8().rename("bh"),
        bs.reduceResolution(ee.Reducer.mean(), maxPixels=64).reproject(proj).round().clamp(0, 100).unmask(0).toUint8().rename("bs"),
    ])


def call(fn, tries=6):
    for k in range(tries):
        try:
            return fn()
        except Exception as e:  # quota / transient errors: back off and retry
            if k == tries - 1 or not any(t in str(e) for t in TRANSIENT):
                raise
            time.sleep(min(120, 5 * 2 ** k))


def pixels(img, zone, i, j):
    arr = call(lambda: ee.data.computePixels({"expression": img, "fileFormat": "NUMPY_NDARRAY",
                                              "grid": g.tile_grid(zone, i, j)}))
    return {k: arr[k] for k in arr.dtype.names}


def dn_from_reflectance(sr, s, pids):
    """Invert scaling + sensor calibration: calibrated float32 reflectance -> the exact integer DN (error ~0.001 DN)."""
    dn = np.zeros(sr.shape, "u2")
    ok = s != g.NODATA_S
    sensor = np.array([p[:4] for p in pids])[s[ok]] if len(pids) else np.array([])
    for key in np.unique(sensor):
        m = np.zeros(s.shape, bool); m[ok] = sensor == key
        x = sr[m].astype("f8")
        co = g.calibration(key)
        if co:
            x = (x - np.array(co[1])) / np.array(co[0])
        v = (x + 0.2) / 0.0000275
        if np.abs(v - np.round(v)).max() > 0.05:
            raise ValueError(f"DN reconstruction not integral for {key}")
        dn[m] = np.round(v).astype("u2")
    return dn


def fetch_year(cache, zone, i, j, year, sensors=None):
    out = cache / f"{year}.npz"
    if out.exists():
        return year, "cached"
    img, pids = year_image(zone, i, j, year, sensors)
    pid_list = call(lambda: pids.getInfo())
    shape = (g.TILE, g.TILE)
    if not pid_list:
        np.savez_compressed(out, dn=np.zeros(shape + (6,), "u2"), s=np.full(shape, g.NODATA_S, "u2"),
                            n=np.zeros(shape, "u1"), pids=np.array([], dtype=str))
        return year, "no scenes"
    try:
        arr = pixels(img, zone, i, j)
        dn, src = np.stack([arr[b] for b in g.DN], -1).astype("u2"), "ee"
    except Exception as e:
        # Years with ~90 scenes can exceed Earth Engine's per-request memory when the six DN bands ride along.
        # Fetch the calibrated reflectance instead (the same medoid) and invert it to the identical integer DN.
        if "memory" not in str(e).lower():
            raise
        comp, _ = g.composite(g.tile_bounds_geom(zone, i, j), year, zone, sensors=sensors)
        arr = pixels(ee.Image.cat([comp.select(g.BANDS).unmask(-1).toFloat(),
                                   comp.select("s").unmask(g.NODATA_S).toUint16(),
                                   comp.select("n").unmask(0).toUint8()]), zone, i, j)
        dn, src = dn_from_reflectance(np.stack([arr[b] for b in g.BANDS], -1), arr["s"], pid_list), "reflectance"
    np.savez_compressed(out, dn=dn, s=arr["s"], n=arr["n"], pids=np.array(pid_list), dn_source=np.array(src))
    return year, f"{len(pid_list)} scenes"


STATIC = ("z", "water", "wc", "tc2000", "loss", "built", "bh", "bs")


def fetch_static(cache, zone, i, j):
    out = cache / "static.npz"
    if not out.exists() or set(STATIC) - set(np.load(out).files):
        arr = call(lambda: ee.data.computePixels({"expression": static_image(zone), "fileFormat": "NUMPY_NDARRAY",
                                                  "grid": g.tile_grid(zone, i, j)}))
        np.savez_compressed(out, **{k: arr[k] for k in STATIC})
    return "static"


def classify(d, rf):
    """Cached DN composite for one tile-year -> tree fraction % (uint8, 255 = no data)."""
    s, dn, pids = d["s"].ravel(), d["dn"].reshape(-1, 6), d["pids"]
    f = np.full(s.size, g.NODATA_F, "u1")
    ok = s != g.NODATA_S
    if not ok.any():
        return f
    sensor = np.array([p[:4] for p in pids])[s[ok]]
    X = np.empty((ok.sum(), len(g.FEATURES)), np.float32)
    for key in np.unique(sensor):
        m = sensor == key
        X[m] = g.features_np(g.reflectance_np(dn[ok][m], key))
    X = np.nan_to_num(X, nan=0.0, posinf=0.0, neginf=0.0)
    f[ok] = np.clip(np.round(np.clip(rf.predict(X), 0, 1) * 100), 0, 100).astype("u1")
    return f


def write_arrow(path, table):
    buf = io.BytesIO()
    with ipc.new_file(buf, table.schema) as w:
        w.write_table(table)
    path.write_bytes(gzip.compress(buf.getvalue(), 9, mtime=0))   # deterministic bytes: unchanged tiles are not re-uploaded


def own_mask(zone, i, j, zone51_tiles):
    """1 where this tile is the canonical source for the pixel location; 0 where a zone-51 tile also covers it."""
    x, y = g.pixel_centres(zone, i, j)
    if zone == 51 or not zone51_tiles:
        return np.ones(x.size, "u1")
    lon, lat = Transformer.from_crs(g.epsg(zone), 4326, always_xy=True).transform(x, y)
    X, Y = Transformer.from_crs(4326, g.epsg(51), always_xy=True).transform(lon, lat)
    ti, tj = np.floor((X - g.EDGE) / g.TILE_M).astype(int), np.floor((Y - g.EDGE) / g.TILE_M).astype(int)
    covered = np.array([(a, b) in zone51_tiles for a, b in zip(ti, tj)])
    return (~covered).astype("u1")


def filled(fcols):
    """The app's display series: carry the last observation forward, back-fill leading gaps, never observed = 0."""
    out, prev = [], np.full(fcols[0].shape, g.NODATA_F, "u1")
    for f in fcols:
        cur = np.where(f == g.NODATA_F, prev, f)
        out.append(cur); prev = cur
    for k in range(len(out) - 2, -1, -1):
        out[k] = np.where(out[k] == g.NODATA_F, out[k + 1], out[k])
    return [np.where(a == g.NODATA_F, 0, a) for a in out]


def overview(zone, i, j, z, own, land, fcols, years, ctx):
    """480 m block means: tree % over owned land pixels (255 if none observed), mean elevation over owned pixels,
    own = at least half the block owned, land = at least half of the owned pixels are land."""
    B = g.TILE // OV
    blk = lambda a: a.reshape(B, OV, B, OV).swapaxes(1, 2).reshape(B * B, OV * OV)
    o = blk(own.reshape(g.TILE, g.TILE)).astype(bool)
    ol = o & blk(land.reshape(g.TILE, g.TILE)).astype(bool)
    zz = blk(z.reshape(g.TILE, g.TILE)).astype(float)
    n_own = o.sum(1)
    zmean = np.where(n_own > 0, (zz * o).sum(1) / np.maximum(n_own, 1), 0).round().astype("int16")
    c = np.arange(B)
    cx = g.EDGE + i * g.TILE_M + OV * g.RES * c + OV * g.RES // 2
    cy = g.EDGE + (j + 1) * g.TILE_M - OV * g.RES * c - OV * g.RES // 2
    X, Y = np.meshgrid(cx, cy)
    cols = {"zone": np.full(B * B, zone, "u1"), "i": np.full(B * B, i, "i2"), "j": np.full(B * B, j, "i2"),
            "x_utm": X.ravel().astype("i4"), "y_utm": Y.ravel().astype("i4"), "z_m": zmean,
            "own": (n_own * 2 >= OV * OV).astype("u1"), "land": (ol.sum(1) * 2 >= np.maximum(n_own, 1)).astype("u1")}
    bb = blk(ctx["built"].reshape(g.TILE, g.TILE)).astype(float)
    bsb = blk(ctx["bs"].reshape(g.TILE, g.TILE)).astype(float)
    n_ol = np.maximum(ol.sum(1), 1)
    cols["bs"] = ((bsb * ol).sum(1) / n_ol).round().astype("u1")                   # mean built-up share
    bmask = ol & (bb > 0)
    med = np.array([np.median(bb[r][bmask[r]]) if bmask[r].any() else 0 for r in range(bb.shape[0])])
    cols["built"] = med.round().astype("u1")                                        # median first-built year - 1900
    cols["built_share"] = ((bmask.sum(1) / n_ol) * 100).round().astype("u1")       # % of land ever built
    for yr, f in zip(years, fcols):
        fb = blk(f.reshape(g.TILE, g.TILE)).astype(float)
        v = ol & (fb != g.NODATA_F)
        nv = v.sum(1)
        cols[f"f{yr}"] = np.where(nv > 0, (fb * v).sum(1) / np.maximum(nv, 1), g.NODATA_F).round().astype("u1")
    return cols


def assemble(cache, outdir, zone, i, j, years, model, rf, zone51_tiles):
    x, y = g.pixel_centres(zone, i, j)
    st = np.load(cache / "static.npz")
    z = st["z"].ravel().astype("int16")
    land = (st["water"].ravel() < 50).astype("u1")          # WorldCover 2021 permanent water < 50 % of the pixel
    own = own_mask(zone, i, j, zone51_tiles)
    use = (own == 1) & (land == 1)
    fcols, scols, ncols, scenes, stats = {}, {}, {}, {}, []
    for yr in years:
        d = np.load(cache / f"{yr}.npz")
        fcols[f"f{yr}"] = classify(d, rf)
        scols[f"s{yr}"] = d["s"].ravel().astype("uint16")
        ncols[f"n{yr}"] = d["n"].ravel().astype("uint8")
        scenes[str(yr)] = [str(p) for p in d["pids"]]
    fl = filled(list(fcols.values()))
    px_ha = g.RES * g.RES / 1e4
    for yr, fill in zip(years, fl):
        f = fcols[f"f{yr}"]
        valid = (f != g.NODATA_F) & use
        stats.append({"zone": zone, "i": i, "j": j, "year": yr, "own_px": int(own.sum()), "land_px": int(use.sum()),
                      "valid_px": int(valid.sum()),
                      "tree_ha": float(f[valid].astype("float64").sum() / 100 * px_ha),
                      "filled_tree_ha": float(fill[use].astype("float64").sum() / 100 * px_ha),
                      "scenes": len(scenes[str(yr)])})
    meta = {
        "format": "tpetree tile v2", "zone": zone, "crs": f"EPSG:{g.epsg(zone)}", "tile": [i, j],
        "res_m": g.RES, "tile_px": g.TILE,
        "position": "x_utm/y_utm are exact pixel centres (multiples of 30 m) on the native Landsat C2 grid; no resampling",
        "years": years, "model": model["name"], "harmonisation": g.HARMONISATION,
        "calibration": {k: g.calibration(k) for k in g.COLLECTIONS},
        "f": "tree fraction percent 0-100: model applied to the calibrated raw DN of the medoid observation; 255 = no data",
        "own": "1 = canonical pixel for this location; 0 = a zone-51 tile also covers it (use that one)",
        "land": "1 = land (ESA WorldCover 2021 permanent water < 50 % of the pixel); stats and the app use land pixels only",
        "built": "first year impervious minus 1900 (GISA 1972-2021, Ren et al. 2025, CC BY 4.0; 72 = by 1972, 78 = 1978-84); 0 = never; display only",
        "bh": "building height m (JRC GHSL GHS-BUILT-H 2018, 100 m); display only",
        "bs": "built-up surface % of the pixel (JRC GHSL GHS-BUILT-S 2018, 10 m averaged); display only",
        "z_m": "Copernicus DEM GLO-30 (2024_1), bilinear to pixel centre, display only",
        "generated": datetime.date.today().isoformat(), "attribution": ATTRIBUTION,
    }
    ctx = {k: st[k].ravel().astype("u1") for k in ("built", "bh", "bs")}
    frac = pa.table({"x_utm": x, "y_utm": y, "z_m": z, "own": own, "land": land, **ctx, **fcols},
                    metadata={"tpetree": json.dumps(meta, ensure_ascii=False)})
    prov_meta = dict(meta, s="index into scenes[year] (Landsat product IDs); 65535 = none",
                     n="distinct clear acquisition dates in the year",
                     trace="col=(x_utm-15-scene_ulx)/30, row=(scene_uly-y_utm-15)/30", scenes=scenes)
    prov = pa.table({"x_utm": x, "y_utm": y, **scols, **ncols},
                    metadata={"tpetree": json.dumps(prov_meta, ensure_ascii=False)})
    outdir.mkdir(parents=True, exist_ok=True)
    write_arrow(outdir / f"{i}_{j}.frac.arrow.gz", frac)
    write_arrow(outdir / f"{i}_{j}.prov.arrow.gz", prov)
    return stats, overview(zone, i, j, z, own, land, list(fcols.values()), years, ctx)


_RF = None


def _init_worker(name):
    global _RF
    _RF = joblib.load(ROOT / "build" / "models" / f"{name}.joblib")


def _assemble_job(job):
    cache, outdir, z, i, j, years, model_name, zone51_tiles = job
    return (z, i, j), assemble(cache, outdir, z, i, j, years, {"name": model_name}, _RF, zone51_tiles)


def tile_complete(cache, years):
    st = cache / "static.npz"
    return st.exists() and not set(STATIC) - set(np.load(st).files) and all((cache / f"{yr}.npz").exists() for yr in years)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--plan", help="tile plan JSON (plan_tiles.py) for a multi-zone export")
    ap.add_argument("--bbox", type=float, nargs=4, metavar=("W", "S", "E", "N"))
    ap.add_argument("--zone", type=int)
    ap.add_argument("--years", type=int, nargs=2, default=[1984, 2026])
    ap.add_argument("--model", default="rf_tw_2021")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--tiles", nargs="*", help="limit to zone_i_j (or i_j) tile ids")
    ap.add_argument("--sensors", nargs="*", help="restrict composites to these sensors (diagnostics), e.g. LC08")
    ap.add_argument("--outroot", default=str(ROOT / "site" / "data"), help="parent folder of the <name> output")
    ap.add_argument("--assemble-only", action="store_true", help="skip Earth Engine; write the tiles already complete")
    ap.add_argument("--max-consecutive-failures", type=int, default=25)
    ap.add_argument("--assemble-workers", type=int, default=6, help="local processes for classification/assembly")
    a = ap.parse_args()

    g.init()
    if a.plan:
        plan = json.loads((ROOT / "pipeline" / a.plan).read_text())
        tiles = [(t["zone"], t["i"], t["j"]) for t in plan["tiles"]]
    else:
        tiles = [(a.zone, i, j) for (i, j) in g.tiles_for_bbox(a.bbox, a.zone)]
    if a.tiles:
        tiles = [t for t in tiles if f"{t[0]}_{t[1]}_{t[2]}" in a.tiles or f"{t[1]}_{t[2]}" in a.tiles]
    zones = sorted({t[0] for t in tiles})
    zone51_tiles = {(i, j) for (z, i, j) in tiles if z == 51} if len(zones) > 1 else set()
    to_ll = {z: Transformer.from_crs(g.epsg(z), 4326, always_xy=True) for z in zones}

    def zone_bbox(zone):
        pts = [to_ll[zone].transform(g.EDGE + (i + di) * g.TILE_M, g.EDGE + (j + dj) * g.TILE_M)
               for (z, i, j) in tiles if z == zone for di in (0, 1) for dj in (0, 1)]
        return [min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)]
    bboxes = {z: zone_bbox(z) for z in zones}
    all_years = list(range(a.years[0], a.years[1] + 1))
    counts_path = ROOT / "build" / "cache" / a.name / "scene_counts.json"
    if counts_path.exists():
        counts = {int(z): v for z, v in json.loads(counts_path.read_text()).items()}
    else:
        counts = {z: ee.Dictionary.fromLists([str(y) for y in all_years],
                                             [g.scenes(ee.Geometry.Rectangle(bboxes[z]), y, z).size() for y in all_years]).getInfo()
                  for z in zones}
        counts_path.parent.mkdir(parents=True, exist_ok=True)
        counts_path.write_text(json.dumps(counts))
    years = [y for y in all_years if sum(counts[z][str(y)] for z in zones) > 0]
    cache_of = lambda z, i, j: ROOT / "build" / "cache" / a.name / str(z) / f"{i}_{j}"
    print(f"{len(tiles)} tiles in zones {zones}; years with scenes: {years[0]}..{years[-1]} ({len(years)}); skipped:",
          [y for y in all_years if y not in years], flush=True)

    if not a.assemble_only:
        failures, streak, stop = [], [0], threading.Event()

        def guarded(fn, *args):
            if stop.is_set():
                return "skipped"
            try:
                r = fn(*args)
                streak[0] = 0
                return r
            except Exception as e:
                streak[0] += 1
                failures.append((args[1:4], args[4] if len(args) > 4 else "z", str(e)[:200]))
                if streak[0] >= a.max_consecutive_failures:
                    stop.set()
                return f"FAILED {str(e)[:120]}"

        todo = [t for t in tiles if not tile_complete(cache_of(*t), years)]
        print(f"{len(tiles) - len(todo)} tiles already complete, {len(todo)} to fetch", flush=True)
        with cf.ThreadPoolExecutor(a.workers) as ex:
            jobs = []
            for (z, i, j) in todo:
                cache = cache_of(z, i, j)
                cache.mkdir(parents=True, exist_ok=True)
                jobs.append(ex.submit(guarded, fetch_static, cache, z, i, j))
                for yr in years:
                    jobs.append(ex.submit(guarded, fetch_year, cache, z, i, j, yr, a.sensors))
            done, t0 = 0, time.time()
            for fut in cf.as_completed(jobs):
                done += 1
                r = fut.result()
                if done % 50 == 0 or done == len(jobs) or (isinstance(r, str) and r.startswith("FAILED")):
                    rate = done / max(1, time.time() - t0)
                    print(f"  {done}/{len(jobs)}  last={r}  {time.time() - t0:.0f}s  "
                          f"eta {(len(jobs) - done) / max(rate, 1e-9) / 3600:.1f} h  failures {len(failures)}", flush=True)
        if failures:
            log = ROOT / "build" / "cache" / a.name / "failures.json"
            log.write_text(json.dumps(failures, indent=1))
            print(f"{len(failures)} failed requests (see {log}); rerun to retry"
                  + ("; stopped after repeated failures (quota?)" if stop.is_set() else ""), flush=True)

    outroot = pathlib.Path(a.outroot) / a.name
    stats, index_tiles, ov = [], [], []
    ready = [t for t in tiles if tile_complete(cache_of(*t), years)]
    if not ready:
        print("no complete tiles yet"); return
    model, _ = load_model(a.model)          # checks the joblib forest against the published tree strings
    jobs = [(cache_of(z, i, j), outroot / str(z), z, i, j, years, a.model, zone51_tiles) for (z, i, j) in ready]
    with cf.ProcessPoolExecutor(a.assemble_workers, initializer=_init_worker, initargs=(a.model,)) as ex:
        done = {key: res for key, res in ex.map(_assemble_job, jobs, chunksize=4)}
    for (z, i, j) in ready:
        s, o = done[(z, i, j)]
        stats += s; ov.append(o)
        x0, y0 = g.EDGE + i * g.TILE_M, g.EDGE + j * g.TILE_M
        corners = [to_ll[z].transform(x, y) for x, y in ((x0, y0), (x0 + g.TILE_M, y0), (x0 + g.TILE_M, y0 + g.TILE_M), (x0, y0 + g.TILE_M))]
        index_tiles.append({"zone": z, "i": i, "j": j, "frac": f"{z}/{i}_{j}.frac.arrow.gz",
                            "prov": f"{z}/{i}_{j}.prov.arrow.gz", "x0": x0, "y0": y0,
                            "corners_lonlat": [[round(c[0], 6), round(c[1], 6)] for c in corners]})
    pq.write_table(pa.Table.from_pylist(stats), outroot / "summary.parquet")
    ovt = pa.table({k: np.concatenate([o[k] for o in ov]) for k in ov[0]},
                   metadata={"tpetree": json.dumps({"format": "tpetree overview v1", "block_px": OV, "block_m": OV * g.RES,
                                                    "years": years, "f": "mean tree % of owned, observed land pixels; 255 = none",
                                                    "own": "1 if at least half the block's pixels are owned",
                                                    "land": "1 if at least half the owned pixels are land"})})
    write_arrow(outroot / "overview.arrow.gz", ovt)
    totals = {}
    for yr in years:
        rows = [s for s in stats if s["year"] == yr]
        totals[str(yr)] = {"filled_tree_ha": round(sum(s["filled_tree_ha"] for s in rows), 1),
                           "observed_tree_ha": round(sum(s["tree_ha"] for s in rows), 1),
                           "valid_px": sum(s["valid_px"] for s in rows), "land_px": sum(s["land_px"] for s in rows)}
    lons = [c[0] for t in index_tiles for c in t["corners_lonlat"]]
    lats = [c[1] for t in index_tiles for c in t["corners_lonlat"]]
    (outroot / "index.json").write_text(json.dumps({
        "name": a.name, "generated": datetime.date.today().isoformat(),
        "bbox_lonlat": a.bbox or [min(lons), min(lats), max(lons), max(lats)], "zones": zones,
        "res_m": g.RES, "tile_px": g.TILE, "tile_m": g.TILE_M, "edge_m": g.EDGE, "overview_block_px": OV,
        "years": years, "scenes_per_year_region": {str(y): sum(counts[z][str(y)] for z in zones) for y in years},
        "scenes_per_year_zone": {str(z): {str(y): counts[z][str(y)] for y in years} for z in zones},
        "model": {k: model.get(k) for k in ("name", "target", "training_year", "training_sensors", "metrics_vs_worldcover_holdout")},
        "harmonisation": g.HARMONISATION, "sensors": a.sensors or "all",
        "complete": len(ready) == len(tiles), "tiles_planned": len(tiles),
        "totals": totals, "tiles": index_tiles, "attribution": ATTRIBUTION,
    }, ensure_ascii=False, indent=1))
    print(f"wrote {outroot} ({len(ready)}/{len(tiles)} tiles)")


if __name__ == "__main__":
    main()

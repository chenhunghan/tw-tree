# /// script
# requires-python = ">=3.11"
# dependencies = ["earthengine-api", "pyproj", "numpy"]
# ///
"""Sample training/evaluation points island-wide and cache their yearly composite features.

  uv run sample_training.py points            # stratified points in every tile of tiles_taiwan.json
  uv run sample_training.py features 2014 2025 [--years 1990 1995 ...]

Points: in each tile, up to PER_CLASS pixels per stratum, stratum = WorldCover 2021 tree-fraction bin (round(frac*4))
x elevation band (<100, 100-500, 500-1500, >=1500 m). Open water (WorldCover class 80 fraction >= 0.5) is excluded.
Each point keeps: zone, x/y (pixel centre), wc_frac (target), fold (3 km blocks, 0 = held out), z, Hansen tree cover
2000 and loss 2001-2025 (to find stable forest for the temporal-stability check).

Features: for each year, the same medoid composite as the export (all sensors, calibrated) is sampled at the points,
in spatially compact chunks. Results are cached under build/train_cache/ so the run resumes.
"""
import argparse, concurrent.futures as cf, json, pathlib, time
import ee, numpy as np
import gee_common as g

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / "build" / "train_cache"
PER_CLASS, BLOCK_M, CHUNK = 3, 3000, 800
E_BANDS = [100, 500, 1500]


def call(fn, tries=6, retry_memory=True):
    for k in range(tries):
        try:
            return fn()
        except Exception as e:
            if k == tries - 1 or (not retry_memory and "memory" in str(e).lower()):
                raise
            print(f"   retry {k + 1}: {str(e)[:100]}", flush=True)
            time.sleep(min(90, 5 * 2 ** k))


def strata_image(zone):
    proj = ee.Projection(f"EPSG:{g.epsg(zone)}", [g.RES, 0, g.EDGE, 0, -g.RES, g.EDGE])
    wc = ee.ImageCollection("ESA/WorldCover/v200").first().select("Map")
    water = wc.eq(80).toFloat().reduceResolution(ee.Reducer.mean(), maxPixels=1024).reproject(proj)
    target = g.worldcover_tree_fraction(zone)
    z = g.elevation().reproject(proj).rename("z")
    eband = z.gte(E_BANDS[0]).add(z.gte(E_BANDS[1])).add(z.gte(E_BANDS[2]))
    coords = ee.Image.pixelCoordinates(ee.Projection(f"EPSG:{g.epsg(zone)}"))
    fold = coords.select("x").divide(BLOCK_M).floor().add(coords.select("y").divide(BLOCK_M).floor().multiply(7919)) \
                 .mod(5).abs().toInt().rename("fold")
    han = ee.Image("UMD/hansen/global_forest_change_2025_v1_13")
    tc = han.select("treecover2000").reproject(proj).rename("tc2000")
    loss = han.select("lossyear").unmask(0).gt(0).reduceResolution(ee.Reducer.max(), maxPixels=64).reproject(proj).rename("loss")
    cls = target.multiply(4).round().toInt().multiply(4).add(eband).rename("cls")
    return ee.Image.cat([target, fold, z, tc, loss, cls]).updateMask(water.lt(0.5)), proj


def sample_tile(t):
    out = CACHE / "points" / f"{t['zone']}_{t['i']}_{t['j']}.json"
    if out.exists():
        return 0
    img, proj = strata_image(t["zone"])
    fc = img.stratifiedSample(numPoints=PER_CLASS, classBand="cls", region=g.tile_bounds_geom(t["zone"], t["i"], t["j"]),
                              projection=proj, scale=g.RES, seed=t["i"] * 1000 + t["j"], geometries=True,
                              dropNulls=True, tileScale=2)
    fc = fc.map(lambda f: f.setGeometry(f.geometry().transform(f"EPSG:{g.epsg(t['zone'])}", 0.001)))
    rows = call(lambda: fc.getInfo())["features"]
    pts = []
    for r in rows:
        x, y = r["geometry"]["coordinates"]
        p = r["properties"]
        pts.append({"zone": t["zone"], "x": int(round(x)), "y": int(round(y)), **{k: p[k] for k in ("wc_frac", "fold", "z", "tc2000", "loss", "cls")}})
    out.write_text(json.dumps(pts))
    return len(pts)


def all_points():
    pts = []
    for p in sorted((CACHE / "points").glob("*.json")):
        pts += json.loads(p.read_text())
    for k, p in enumerate(pts):
        p["id"] = k
    return pts


def chunks(pts):
    """Spatially compact chunks: points are grouped by zone and tile order already."""
    by_zone = {}
    for p in pts:
        by_zone.setdefault(p["zone"], []).append(p)
    out = []
    for zone, zp in by_zone.items():
        zp.sort(key=lambda p: (-(p["y"] // 30720), p["x"] // 30720, -p["y"], p["x"]))   # 4x4-tile blocks
        for k in range(0, len(zp), CHUNK):
            out.append((zone, k // CHUNK, zp[k:k + CHUNK]))
    return out


def _sample(zone, pts, year):
    """Features at the points; halves the request when Earth Engine runs out of memory."""
    crs = f"EPSG:{g.epsg(zone)}"
    fc = ee.FeatureCollection([ee.Feature(ee.Geometry.Point([p["x"], p["y"]], crs), {"id": p["id"]}) for p in pts])
    comp, _ = g.composite(fc.geometry(), year, zone)
    img = g.features(comp).addBands(comp.select("n"))
    proj = ee.Projection(crs, [g.RES, 0, g.EDGE, 0, -g.RES, g.EDGE])
    try:
        rows = call(lambda: img.sampleRegions(fc, projection=proj, scale=g.RES, tileScale=4, geometries=False).getInfo(),
                    retry_memory=len(pts) <= 50)["features"]
    except Exception as e:
        if "memory" not in str(e).lower() or len(pts) <= 50:
            raise
        h = len(pts) // 2
        return {**_sample(zone, pts[:h], year), **_sample(zone, pts[h:], year)}
    return {r["properties"]["id"]: [r["properties"].get(k) for k in g.FEATURES + ["n"]] for r in rows}


def sample_features(zone, ci, pts, year):
    out = CACHE / "features" / f"{zone}_{ci}_{year}.json"
    if out.exists():
        return "cached"
    res = _sample(zone, pts, year)
    out.write_text(json.dumps(res))
    return f"{len(res)}/{len(pts)}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["points", "features"])
    ap.add_argument("span", type=int, nargs="*", help="first last year (features)")
    ap.add_argument("--years", type=int, nargs="*", default=[], help="extra single years (evaluation)")
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    g.init()
    (CACHE / "points").mkdir(parents=True, exist_ok=True)
    (CACHE / "features").mkdir(parents=True, exist_ok=True)
    if a.step == "points":
        tiles = json.loads((ROOT / "pipeline" / "tiles_taiwan.json").read_text())["tiles"]
        with cf.ThreadPoolExecutor(a.workers) as ex:
            n = 0
            for k, c in enumerate(ex.map(sample_tile, tiles)):
                n += c
                if k % 50 == 0:
                    print(f"  {k}/{len(tiles)} tiles, {n} new points", flush=True)
        print("points:", len(all_points()))
        return
    years = (list(range(a.span[0], a.span[1] + 1)) if a.span else []) + a.years
    cs = chunks(all_points())
    jobs = [(z, ci, p, y) for y in years for (z, ci, p) in cs]
    print(f"{len(cs)} chunks x {len(years)} years = {len(jobs)} requests", flush=True)
    t0 = time.time()
    with cf.ThreadPoolExecutor(a.workers) as ex:
        futs = {ex.submit(sample_features, *j): j for j in jobs}
        for k, f in enumerate(cf.as_completed(futs)):
            z, ci, _, y = futs[f]
            try:
                r = f.result()
            except Exception as e:
                r = f"FAILED {str(e)[:120]}"
            if k % 10 == 0 or r.startswith("FAILED"):
                print(f"  {k + 1}/{len(jobs)} zone {z} chunk {ci} {y}: {r}  {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()

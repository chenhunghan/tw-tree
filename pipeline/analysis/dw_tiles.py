# /// script
# requires-python = ">=3.11"
# dependencies = ["earthengine-api", "numpy", "pyarrow", "pyproj"]
# ///
"""Dynamic World (Sentinel-2) mean tree probability per tile and year, over land (WorldCover 2021 not water), as an
independent reference for year-to-year changes in our tile means.

  uv run pipeline/analysis/dw_tiles.py [first_year last_year]   ->  build/diag/dw_tiles.parquet (resumable per year)
"""
import json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import ee, pyarrow as pa, pyarrow.parquet as pq
import gee_common as g

ROOT = pathlib.Path(__file__).resolve().parents[2]
y0, y1 = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) > 2 else (2016, 2025)
g.init()
plan = json.loads((ROOT / "pipeline" / "tiles_taiwan.json").read_text())
fc = ee.FeatureCollection([ee.Feature(g.tile_bounds_geom(t["zone"], t["i"], t["j"]), {"key": f"{t['zone']}_{t['i']}_{t['j']}"})
                           for t in plan["tiles"]])
land = ee.ImageCollection("ESA/WorldCover/v200").first().neq(80)
out_dir = ROOT / "build" / "diag" / "dw"
out_dir.mkdir(parents=True, exist_ok=True)
for y in range(y0, y1 + 1):
    p = out_dir / f"{y}.json"
    if p.exists():
        continue
    dw = (ee.ImageCollection("GOOGLE/DYNAMICWORLD/V1").filterBounds(ee.Geometry.Rectangle([118.0, 21.8, 122.1, 26.4]))
          .filterDate(f"{y}-01-01", f"{y + 1}-01-01").select("trees").mean().updateMask(land))
    r = dw.reduceRegions(fc, ee.Reducer.mean(), scale=120, tileScale=4).getInfo()
    p.write_text(json.dumps({f["properties"]["key"]: f["properties"].get("mean") for f in r["features"]}))
    print(y, "done", flush=True)
rows = []
for p in sorted(out_dir.glob("*.json")):
    for k, v in json.loads(p.read_text()).items():
        z, i, j = map(int, k.split("_"))
        rows.append({"zone": z, "i": i, "j": j, "year": int(p.stem), "dw_trees": v})
pq.write_table(pa.Table.from_pylist(rows), ROOT / "build" / "diag" / "dw_tiles.parquet")
print("saved", len(rows))

# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pyarrow", "rasterio", "pystac-client", "planetary-computer"]
# ///
"""End-to-end provenance check, independent of Earth Engine.

For random stored pixels: take (x_utm, y_utm) and the scene index s -> Landsat product ID, open the raw
USGS file for that product on Microsoft Planetary Computer, read the raw DN at
  col = (x_utm - 15 - scene_ulx) / 30,  row = (scene_uly - y_utm - 15) / 30
(which must be integers), re-apply scaling + Roy harmonisation + the saved model locally, and
compare with the stored tree fraction.

  uv run verify_provenance.py pilot 60
"""
import gzip, json, pathlib, random, re, sys
import numpy as np, pyarrow.ipc as ipc, rasterio, pystac_client, planetary_computer
from rasterio.windows import Window

ROOT = pathlib.Path(__file__).resolve().parent.parent
ROY_SLOPE = np.array([0.8474, 0.8483, 0.9047, 0.8462, 0.8937, 0.9071])
ROY_INTERCEPT = np.array([0.0003, 0.0088, 0.0061, 0.0412, 0.0254, 0.0172])
PC_BANDS = ["blue", "green", "red", "nir08", "swir16", "swir22"]


def parse_tree(text):
    nodes = {}
    for line in text.splitlines():
        m = re.match(r"\s*(\d+)\) (root|(\w+)(<=|>)(\S+)) \S+ \S+ (\S+)( \*)?", line)
        if m:
            nodes[int(m[1])] = {"leaf": bool(m[7]), "yval": float(m[6])}
            if m[3]:
                nodes[int(m[1])].update(feat=m[3], thr=float(m[5]))
    return nodes


def predict(trees, fv):
    out = []
    for nodes in trees:
        k = 1
        while not nodes[k]["leaf"]:
            left = nodes[2 * k]
            k = 2 * k if fv[left["feat"]] <= left["thr"] else 2 * k + 1
        out.append(nodes[k]["yval"])
    return float(np.mean(out))


def features(dn, sensor, calib):
    sr = dn.astype("float64") * 0.0000275 - 0.2
    co = calib.get(sensor)          # (slope, intercept) recorded in the tile metadata, or None
    if co:
        sr = sr * np.array(co[0]) + np.array(co[1])
    b = dict(zip(["blue", "green", "red", "nir", "swir1", "swir2"], sr.astype("float32")))
    nd = lambda a, c: np.float32((b[a] - b[c]) / (b[a] + b[c]))
    return {**b, "ndvi": nd("nir", "red"), "ndmi": nd("nir", "swir1"), "nbr": nd("nir", "swir2"), "ndwi": nd("green", "nir")}


def load(path):
    return ipc.open_file(gzip.open(path).read()).read_all()


def main(name, n):
    idx = json.loads((ROOT / "site" / "data" / name / "index.json").read_text())
    model = json.loads((ROOT / "pipeline" / "model" / f"{idx['model']['name']}.json").read_text())
    trees = [parse_tree(t) for t in model["trees"]]
    cat = pystac_client.Client.open("https://planetarycomputer.microsoft.com/api/stac/v1",
                                    modifier=planetary_computer.sign_inplace)
    rnd = random.Random(7)
    results = []
    while len(results) < n:
        t = rnd.choice(idx["tiles"])
        frac = load(ROOT / "site" / "data" / name / t["frac"])
        prov = load(ROOT / "site" / "data" / name / t["prov"])
        pmeta = json.loads(prov.schema.metadata[b"tpetree"])
        scenes = pmeta["scenes"]
        calib = pmeta.get("calibration") or {k: None if k in ("LC08", "LC09") else (ROY_SLOPE.tolist(), ROY_INTERCEPT.tolist()) for k in ("LT04", "LT05", "LE07", "LC08", "LC09")}
        yr = rnd.choice(idx["years"])
        s = prov[f"s{yr}"].to_numpy()
        cand = np.flatnonzero(s != 65535)
        if not len(cand):
            continue
        k = int(rnd.choice(cand))
        x, y = int(frac["x_utm"][k].as_py()), int(frac["y_utm"][k].as_py())
        f_stored = int(frac[f"f{yr}"][k].as_py())
        pid = scenes[str(yr)][int(s[k])]
        p = pid.split("_")
        pc_id = "_".join(p[:4] + p[5:])          # PC ids drop the processing date
        item = cat.get_collection("landsat-c2-l2").get_item(pc_id)
        tr = item.assets["red"].extra_fields.get("proj:transform") or item.properties["proj:transform"]
        colf, rowf = (x - 15 - tr[2]) / 30, (tr[5] - y - 15) / 30
        col, row = int(round(colf)), int(round(rowf))
        dn = []
        for band in PC_BANDS + ["qa_pixel"]:
            with rasterio.open(item.assets[band].href) as ds:
                dn.append(int(ds.read(1, window=Window(col, row, 1, 1))[0, 0]))
        fv = features(np.array(dn[:6]), p[0], calib)
        f_local = int(np.floor(np.clip(predict(trees, fv), 0, 1) * 100 + 0.5))
        r = {"year": yr, "x_utm": x, "y_utm": y, "product": pid, "col": colf, "row": rowf,
             "integer_position": colf == col and rowf == row, "qa_clear": (dn[6] & 0b111111) == 0,
             "f_stored": f_stored, "f_local": f_local, "diff": f_local - f_stored}
        results.append(r)
        print(f"{yr} ({x},{y}) {pid} col={colf} row={rowf} stored={f_stored} local={f_local}", flush=True)
    d = np.array([r["diff"] for r in results])
    summary = {"checked": len(results),
               "integer_positions": sum(r["integer_position"] for r in results),
               "raw_pixel_clear_in_qa": sum(r["qa_clear"] for r in results),
               "exact_match": int((d == 0).sum()), "within_1pct": int((abs(d) <= 1).sum()),
               "max_abs_diff": int(abs(d).max())}
    print(json.dumps(summary, indent=1))
    out = ROOT / "build" / f"verify_{name}.json"
    out.write_text(json.dumps({"summary": summary, "results": results}, indent=1))
    print("saved", out)


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 40)

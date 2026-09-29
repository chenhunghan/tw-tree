# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pyarrow", "rasterio", "pystac-client", "planetary-computer"]
# ///
"""End-to-end provenance check, independent of Earth Engine.

For random stored pixels: take (x_utm, y_utm) and the scene index s -> Landsat product ID, open the raw
USGS file for that product on Microsoft Planetary Computer, read the raw DN at
  col = (x_utm - 15 - scene_ulx) / 30,  row = (scene_uly - y_utm - 15) / 30
(which must be integers), re-apply scaling + the recorded sensor calibration + the saved model locally, and
compare with the stored tree fraction. For raw-DN exports (v3) the six DN read from Planetary Computer are also
compared with the DN Earth Engine returned (build/cache), which must be identical integers. When the frac tile records a
per tile-year normalisation (normalise.py), its gain and offset are applied to the calibrated reflectance before the model.

  uv run verify_provenance.py pilot 60
  uv run verify_provenance.py taiwan 20 local_medoid     # only tile-years fetched by that path (dn_source in the cache)
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


def features(dn, sensor, calib, norm=None):
    sr = dn.astype("float64") * 0.0000275 - 0.2
    co = calib.get(sensor)          # (slope, intercept) recorded in the tile metadata, or None
    if co:
        sr = sr * np.array(co[0]) + np.array(co[1])
    sr = sr.astype("float32")
    if norm:                        # per tile-year normalisation from the frac tile metadata: sr * gain + offset
        p = np.asarray(norm, np.float32)
        sr = (sr * p[:6] + p[6:]).astype("float32")
    b = dict(zip(["blue", "green", "red", "nir", "swir1", "swir2"], sr))
    nd = lambda a, c: np.float32((b[a] - b[c]) / (b[a] + b[c]))
    return {**b, "ndvi": nd("nir", "red"), "ndmi": nd("nir", "swir1"), "nbr": nd("nir", "swir2"), "ndwi": nd("green", "nir")}


def load(path):
    return ipc.open_file(gzip.open(path).read()).read_all()


def main(name, n, source=None):
    idx = json.loads((ROOT / "site" / "data" / name / "index.json").read_text())
    model = json.loads((ROOT / "pipeline" / "model" / f"{idx['model']['name']}.json").read_text())
    trees = [parse_tree(t) for t in model["trees"]]
    cat = pystac_client.Client.open("https://planetarycomputer.microsoft.com/api/stac/v1",
                                    modifier=planetary_computer.sign_inplace)
    rnd = random.Random(7)
    results, missing = [], []
    pairs = None
    if source:                                   # (tile, year) pairs whose cached DN came from this fetch path
        cache_dir = ROOT / "build" / "cache" / name
        pairs = [(t, yr) for t in idx["tiles"] for yr in idx["years"]
                 if (f := cache_dir / str(t["zone"]) / f"{t['i']}_{t['j']}" / f"{yr}.npz").exists()
                 and str(np.load(f).get("dn_source", "ee")) == source]
        print(f"{len(pairs)} tile-years with dn_source={source}", flush=True)
    while len(results) < n:
        t, yr = rnd.choice(pairs) if pairs else (rnd.choice(idx["tiles"]), None)
        frac = load(ROOT / "site" / "data" / name / t["frac"])
        prov = load(ROOT / "site" / "data" / name / t["prov"])
        pmeta = json.loads(prov.schema.metadata[b"tpetree"])
        scenes = pmeta["scenes"]
        calib = pmeta.get("calibration") or {k: None if k in ("LC08", "LC09") else (ROY_SLOPE.tolist(), ROY_INTERCEPT.tolist()) for k in ("LT04", "LT05", "LE07", "LC08", "LC09")}
        yr = yr or rnd.choice(idx["years"])
        norm = (json.loads(frac.schema.metadata[b"tpetree"]).get("normalisation") or {}).get("params", {}).get(str(yr))
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
        if item is None:                         # product not mirrored on Planetary Computer: count and skip
            missing.append(pid)
            print(f"{yr} {pid}: not on Planetary Computer, skipped", flush=True)
            continue
        pc_pid = item.assets["red"].href.split("?")[0].split("/")[-2]   # full product ID incl. processing date
        tr = item.assets["red"].extra_fields.get("proj:transform") or item.properties["proj:transform"]
        colf, rowf = (x - 15 - tr[2]) / 30, (tr[5] - y - 15) / 30
        col, row = int(round(colf)), int(round(rowf))
        dn = []
        for band in PC_BANDS + ["qa_pixel"]:
            with rasterio.open(item.assets[band].href) as ds:
                dn.append(int(ds.read(1, window=Window(col, row, 1, 1))[0, 0]))
        cache = ROOT / "build" / "cache" / name / str(t["zone"]) / f"{t['i']}_{t['j']}" / f"{yr}.npz"
        dn_ee = np.load(cache)["dn"][k // 256, k % 256].tolist() if cache.exists() and "dn" in np.load(cache).files else None
        fv = features(np.array(dn[:6]), p[0], calib, norm)
        f_local = int(np.floor(np.clip(predict(trees, fv), 0, 1) * 100 + 0.5))
        r = {"year": yr, "x_utm": x, "y_utm": y, "product": pid, "col": colf, "row": rowf,
             "integer_position": colf == col and rowf == row, "qa_clear": (dn[6] & 0b111111) == 0,
             "f_stored": f_stored, "f_local": f_local, "diff": f_local - f_stored,
             "pc_product": pc_pid, "same_processing": pc_pid == pid,
             "dn_pc": dn[:6], "dn_ee": dn_ee, "dn_identical": None if dn_ee is None else dn_ee == dn[:6]}
        results.append(r)
        print(f"{yr} ({x},{y}) {pid} col={colf} row={rowf} stored={f_stored} local={f_local}", flush=True)
    d = np.array([r["diff"] for r in results])
    summary = {"checked": len(results),
               "integer_positions": sum(r["integer_position"] for r in results),
               "raw_pixel_clear_in_qa": sum(r["qa_clear"] for r in results),
               "exact_match": int((d == 0).sum()), "within_1pct": int((abs(d) <= 1).sum()),
               "max_abs_diff": int(abs(d).max()),
               "dn_compared_same_processing": sum(r["dn_identical"] is not None and r["same_processing"] for r in results),
               "dn_identical_same_processing": sum(bool(r["dn_identical"]) and r["same_processing"] for r in results),
               "different_processing_version": [r["product"] + " vs PC " + r["pc_product"] for r in results if not r["same_processing"]],
               "skipped_not_on_planetary_computer": missing}
    print(json.dumps(summary, indent=1))
    out = ROOT / "build" / (f"verify_{name}_{source}.json" if source else f"verify_{name}.json")
    out.write_text(json.dumps({"summary": summary, "results": results}, indent=1))
    print("saved", out)


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 40, sys.argv[3] if len(sys.argv) > 3 else None)

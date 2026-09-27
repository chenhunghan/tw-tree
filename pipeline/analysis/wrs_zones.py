import sys, pathlib; sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import ee, json, gee_common as g
g.init()
tw = ee.Geometry.Rectangle([118.0, 21.8, 122.1, 26.4])
out = {}
for zone in (50, 51):
    col = (ee.ImageCollection(g.COLLECTIONS["LC08"]).filterBounds(tw).filterDate("2021-01-01", "2022-01-01")
           .filter(ee.Filter.eq("UTM_ZONE", zone)))
    pr = col.aggregate_array("WRS_PATH").zip(col.aggregate_array("WRS_ROW")).distinct().getInfo()
    out[zone] = sorted(pr)
    print(zone, sorted(pr))
# footprint of one scene per path/row
for zone, prs in out.items():
    for p, r in prs:
        im = (ee.ImageCollection(g.COLLECTIONS["LC08"]).filterBounds(tw).filter(ee.Filter.eq("WRS_PATH", p))
              .filter(ee.Filter.eq("WRS_ROW", r)).filterDate("2021-01-01", "2022-01-01").first())
        b = ee.Geometry(im.geometry()).bounds().coordinates().getInfo()[0]
        xs, ys = [c[0] for c in b], [c[1] for c in b]
        print(f"zone {zone} path {p} row {r}: lon {min(xs):.2f}-{max(xs):.2f} lat {min(ys):.2f}-{max(ys):.2f}")

# /// script
# requires-python = ">=3.11"
# dependencies = ["earthengine-api", "pyproj", "numpy", "shapely>=2"]
# ///
"""Plan the island-wide tile set and its UTM-zone ownership -> pipeline/tiles_taiwan.json.

Land: USDOS LSIB (Taiwan), limited to the main island, Penghu, Kinmen, Matsu and nearby islets (lon >= 118, lat >= 21.8;
Dongsha and Taiping are excluded). Footprints: union of the real Landsat 8 scene footprints per zone (2019-2023), shrunk
by 1 km. Zone 51 owns every tile that intersects land and lies fully inside the zone-51 footprints; zone 50 takes every tile
that covers land left over (full_footprint records whether it lies fully inside the zone-50 footprints).
"""
import json, pathlib
import ee
from shapely.geometry import shape, box, mapping
from shapely.ops import transform, unary_union
from pyproj import Transformer
import gee_common as g

g.init()
AOI = ee.Geometry.Rectangle([118.0, 21.8, 122.2, 26.5])
land = ee.FeatureCollection("USDOS/LSIB/2017").filter(ee.Filter.eq("COUNTRY_NA", "Taiwan")).filterBounds(AOI)
land_ll = shape(land.geometry().intersection(AOI, 10).getInfo()).buffer(0)

fp = {}
for zone in (50, 51):
    col = (ee.ImageCollection(g.COLLECTIONS["LC08"]).filterBounds(AOI).filterDate("2019-01-01", "2024-01-01")
           .filter(ee.Filter.eq("UTM_ZONE", zone)))
    geoms = col.map(lambda im: ee.Feature(im.geometry())).geometry(100).dissolve(100).getInfo()
    fp[zone] = shape(geoms).buffer(0)

out = {"land_source": "USDOS/LSIB/2017 COUNTRY_NA=Taiwan within lon 118-122.2, lat 21.8-26.5", "tiles": []}
owned_ll = []
for zone in (51, 50):
    to_utm = Transformer.from_crs(4326, g.epsg(zone), always_xy=True).transform
    to_ll = Transformer.from_crs(g.epsg(zone), 4326, always_xy=True).transform
    fz = transform(to_utm, fp[zone]).buffer(-1000)
    L = transform(to_utm, land_ll)
    if zone == 50:                       # only land not already covered by zone-51 tiles
        L = L.difference(transform(to_utm, unary_union(owned_ll)))
    tiles = g.tiles_for_bbox(land_ll.bounds, zone)
    n = 0
    for (i, j) in tiles:
        x0, y0 = g.EDGE + i * g.TILE_M, g.EDGE + j * g.TILE_M
        r = box(x0, y0, x0 + g.TILE_M, y0 + g.TILE_M)
        piece = r.intersection(L)
        if piece.area < 900:             # less than one pixel of land
            continue
        inside = fz.contains(r)
        if zone == 51 and not inside:
            continue
        out["tiles"].append({"zone": zone, "i": i, "j": j, "land_km2": round(piece.area / 1e6, 3),
                             "full_footprint": bool(inside)})
        if zone == 51:
            owned_ll.append(transform(to_ll, r))
        n += 1
    print(f"zone {zone}: {n} tiles, land {sum(t['land_km2'] for t in out['tiles'] if t['zone'] == zone):.0f} km2")
out["land_km2_total"] = round(transform(Transformer.from_crs(4326, 3826, always_xy=True).transform, land_ll).area / 1e6, 1)
out["zone51_tiles_lonlat"] = mapping(unary_union(owned_ll).simplify(0.0001))
p = pathlib.Path(__file__).resolve().parent / "tiles_taiwan.json"
p.write_text(json.dumps(out))
print("land km2", out["land_km2_total"], "total tiles", len(out["tiles"]), "->", p)

# /// script
# requires-python = ">=3.11"
# dependencies = ["pyarrow", "pyproj", "shapely", "numpy"]
# ///
"""Tree-fraction series inside named sites (OSM polygons) and a surrounding ring, from the published tiles.

usage: uv run pipeline/analysis/site_series.py sites.json osm.json out.json [--data URL] [--ring 400]
sites.json: [{"id", "ways": [osm way ids], "hull": bool, "buffer": m}] (e.g. pipeline/analysis/tsmc_sites.json);
osm.json: Overpass `out geom` result, for TSMC (2026-10-01):
  [out:json];(way["name"~"台積|TSMC"](21.8,119.9,25.4,122.1);relation["name"~"台積|TSMC"](21.8,119.9,25.4,122.1););out geom tags;
Per site and year: mean gap-filled tree fraction over owned land pixels (as the app shows it), share observed,
and the GISA first-built year histogram. Tiles are cached under build/cache_site_tiles/.
"""
import argparse, gzip, json, pathlib, urllib.request
import numpy as np, pyarrow.ipc as ipc
from pyproj import Transformer
from shapely.geometry import Polygon, Point, MultiPoint
from shapely.ops import unary_union, transform
from shapely import contains_xy

ap = argparse.ArgumentParser()
ap.add_argument('sites'); ap.add_argument('osm'); ap.add_argument('out')
ap.add_argument('--data', default='https://huggingface.co/datasets/chenhunghan/tw-tree/resolve/main/taiwan/')
ap.add_argument('--ring', type=float, default=400)
a = ap.parse_args()
cache = pathlib.Path('build/cache_site_tiles'); cache.mkdir(parents=True, exist_ok=True)

def get(rel):
    p = cache / rel.replace('/', '_')
    if not p.exists():
        with urllib.request.urlopen(a.data + rel) as r: p.write_bytes(r.read())
    return p.read_bytes()

idx = json.loads(get('index.json'))
years, T, E, P = idx['years'], idx['tile_m'], idx['edge_m'], idx['tile_px']
entries = {(t['zone'], t['i'], t['j']): t for t in idx['tiles']}
ways = {e['id']: e for e in json.load(open(a.osm))['elements'] if e['type'] == 'way'}
tiles = {}

def read_tile(key):
    if key in tiles: return tiles[key]
    raw = gzip.decompress(get(entries[key]['frac']))
    try: t = ipc.open_file(raw).read_all()
    except Exception: t = ipc.open_stream(raw).read_all()
    cols = {n: t.column(n).to_numpy() for n in t.column_names}
    tiles[key] = cols
    return cols

def pixels(poly_ll):
    """Owned land pixels whose centre lies in poly_ll (lon/lat). Zone 51 wins where both zones own data."""
    out = []
    for zone in (51, 50):
        tr = Transformer.from_crs(4326, 32600 + zone, always_xy=True).transform
        g = transform(tr, poly_ll)
        x0, y0, x1, y1 = g.bounds
        for i in range(int((x0 - E) // T), int((x1 - E) // T) + 1):
            for j in range(int((y0 - E) // T), int((y1 - E) // T) + 1):
                if (zone, i, j) not in entries: continue
                c = read_tile((zone, i, j))
                m = contains_xy(g, c['x_utm'], c['y_utm']) & (c['own'] == 1) & (c['land'] == 1)
                if m.any(): out.append((zone, c, m))
        if out: return out          # this zone owns the site
    return out

def series(px):
    F = []; B = []
    for _, c, m in px:
        f = np.stack([c[f'f{y}'][m].astype(float) for y in years])       # years x n
        f[f == 255] = np.nan
        F.append(f); B.append(c['built'][m])
    if not F: return None
    f = np.concatenate(F, axis=1); built = np.concatenate(B)
    obs = ~np.isnan(f)
    filled = f.copy()                                   # last observation carried forward, leading gap back-filled
    for k in range(1, len(years)):
        filled[k] = np.where(np.isnan(filled[k]), filled[k - 1], filled[k])
    for k in range(len(years) - 2, -1, -1):
        filled[k] = np.where(np.isnan(filled[k]), filled[k + 1], filled[k])
    yrs, cnt = np.unique(built[built > 0], return_counts=True)
    return {'n': int(f.shape[1]), 'ha': round(f.shape[1] * 0.09, 1),
            'mean': [None if np.isnan(v) else round(float(v), 1) for v in np.nanmean(filled, axis=1)],
            'observed': [round(float(v), 2) for v in obs.mean(axis=1)],
            'built': {1900 + int(y): int(n) for y, n in zip(yrs, cnt)}, 'never_built': int((built == 0).sum())}

def geom(s):
    polys = []
    for w in s['ways']:
        g = [(p['lon'], p['lat']) for p in ways[w]['geometry']]
        polys.append(Polygon(g) if len(g) >= 4 else MultiPoint(g).convex_hull)
    u = unary_union(polys)
    if s.get('hull'): u = u.convex_hull
    if s.get('buffer'):   # metres, roughly (1e-5 deg ~ 1 m)
        u = u.buffer(s['buffer'] / 111000)
    return u

out = {'years': years, 'data': a.data, 'ring_m': a.ring, 'sites': {}}
for s in json.load(open(a.sites)):
    g = geom(s)
    ring = g.buffer(a.ring / 111000).difference(g.buffer(60 / 111000))
    c = g.centroid
    out['sites'][s['id']] = {'centroid': [round(c.y, 5), round(c.x, 5)], 'bounds': [round(v, 5) for v in g.bounds],
                             'polygon': [[round(x, 5), round(y, 5)] for x, y in (g.exterior.coords if g.geom_type == 'Polygon' else g.convex_hull.exterior.coords)],
                             'site': series(pixels(g)), 'ring': series(pixels(ring))}
    r = out['sites'][s['id']]['site']
    print(s['id'], r and r['ha'], r and [r['mean'][years.index(y)] for y in (1990, 2000, 2010, 2015, 2018, 2020, 2022, 2024, 2026)])
json.dump(out, open(a.out, 'w'), ensure_ascii=False, indent=1)

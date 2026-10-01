# /// script
# requires-python = ">=3.11"
# dependencies = ["pyarrow", "pyproj", "shapely", "numpy"]
# ///
"""Real building footprints for site stories: OSM buildings inside each story's outline, with height and the year they
appear on the timeline, added in place to site/stories/<collection>.json (ODbL, like the outlines).

usage: uv run pipeline/analysis/site_buildings.py site/stories/tsmc.json buildings_osm.json [--data URL]
buildings_osm.json: Overpass `way["building"](bbox); out geom tags;` around the stories (see AGENTS.md).

height: OSM `height`, else `building:levels` x 7.6 m (a fab floor; Fab 18's 4 levels are tagged 30.4 m), else by type
  and size (fab-sized factory/industrial > 15,000 m2: 30 m; office 25 m; other industrial/CUP 20 m), flagged "est".
year: OSM `start_date`; else the median GISA first-built year of the pixels under the footprint, moved up to the start
  of the site's tree-cover decline if the footprint was still treed (> 30 %) before it (a building cannot predate the
  clearing); else (built after GISA ends in 2021) the year the decline ended. Per-site floors from dated sources: FLOOR.
"""
import argparse, gzip, json, pathlib, urllib.request
import numpy as np, pyarrow.ipc as ipc
from pyproj import Transformer
from shapely.geometry import Polygon
from shapely.ops import transform
from shapely import contains_xy

# earliest year a site's buildings can appear, from the dated sources in build_stories.py
FLOOR = {'tsmc-fab22': 2023,   # refinery ground was impervious long before (GISA 1972); construction began late 2022
         'tsmc-fab18': 2018,   # ground broken 26 January 2018
         'tsmc-fab20': 2023}   # leveling from spring 2022
# named buildings inside an outline that are not the fab's own (fire station, a neighbour's HQ) are left out
import re
FAB_NAME = re.compile(r'台積|TSMC|Fab|F\d|P\d|CUP|AP\d|廠|工務所|公務所|辦公|Office|研發中心|棟', re.I)
SKIP_TYPES = {'residential', 'house', 'apartments', 'dormitory', 'religious', 'temple', 'shrine', 'carport', 'roof', 'shed', 'greenhouse'}

ap = argparse.ArgumentParser()
ap.add_argument('stories'); ap.add_argument('osm')
ap.add_argument('--data', default='https://huggingface.co/datasets/chenhunghan/tw-tree/resolve/main/taiwan/')
a = ap.parse_args()
cache = pathlib.Path('build/cache_site_tiles'); cache.mkdir(parents=True, exist_ok=True)

def get(rel):
    p = cache / rel.replace('/', '_')
    if not p.exists():
        with urllib.request.urlopen(a.data + rel) as r: p.write_bytes(r.read())
    return p.read_bytes()

idx = json.loads(get('index.json'))
years, T, E = idx['years'], idx['tile_m'], idx['edge_m']
entries = {(t['zone'], t['i'], t['j']): t for t in idx['tiles']}
tiles = {}
def tile(key):
    if key not in tiles:
        raw = gzip.decompress(get(entries[key]['frac']))
        try: t = ipc.open_file(raw).read_all()
        except Exception: t = ipc.open_stream(raw).read_all()
        tiles[key] = {n: t.column(n).to_numpy() for n in t.column_names}
    return tiles[key]

def under(poly_ll):
    """built codes and tree-fraction rows (years x n) of owned land pixels whose centre is inside poly_ll."""
    for zone in (51, 50):
        g = transform(Transformer.from_crs(4326, 32600 + zone, always_xy=True).transform, poly_ll)
        x0, y0, x1, y1 = g.bounds; B, F = [], []
        for i in range(int((x0 - E) // T), int((x1 - E) // T) + 1):
            for j in range(int((y0 - E) // T), int((y1 - E) // T) + 1):
                if (zone, i, j) not in entries: continue
                c = tile((zone, i, j))
                m = contains_xy(g, c['x_utm'], c['y_utm']) & (c['own'] == 1)
                if m.any():
                    B.append(c['built'][m]); F.append(np.stack([c[f'f{y}'][m].astype(float) for y in years]))
        if B: return np.concatenate(B), np.concatenate(F, axis=1), g.area
    return np.array([]), np.zeros((len(years), 0)), 0.0

doc = json.load(open(a.stories))
osm = [e for e in json.load(open(a.osm))['elements'] if e['type'] == 'way' and e.get('geometry')]
for st in doc['stories']:
    site = Polygon(st['polygon']).buffer(40 / 111000)
    b0, b1 = years.index(st['before'][0]), years.index(st['before'][1]) + 1
    out = []
    for e in osm:
        t = e['tags']; kind = t.get('building', 'yes')
        if kind in SKIP_TYPES or 'religion' in t or t.get('amenity') == 'place_of_worship': continue
        ring = [(p['lon'], p['lat']) for p in e['geometry']]
        if len(ring) < 4: continue
        fp = Polygon(ring)
        if not fp.is_valid or not site.contains(fp.centroid): continue
        built, f, area = under(fp)
        if area < 400: continue                                     # sheds, kiosks, gatehouses
        name = t.get('name') or t.get('name:en') or ''
        if name and not FAB_NAME.search(name): continue
        construction = kind == 'construction' or 'construction' in t
        typ = t.get('construction', kind) if kind == 'construction' else kind
        if 'height' in t:
            h, hs = float(str(t['height']).split()[0]), 'osm'
        elif 'building:levels' in t:
            h, hs = float(t['building:levels']) * 7.6, 'levels'
        else:
            h = 30.0 if typ in ('factory', 'industrial') and area > 15000 else 25.0 if typ == 'office' else 20.0
            hs = 'est'
        if 'start_date' in t and t['start_date'][:4].isdigit():
            y, ys = int(t['start_date'][:4]), 'osm'
        elif built.size and (built > 0).mean() >= 0.3:
            b = built[built > 0].astype(int)
            y = int(np.median(np.where(b == 72, 1972 - 1900, np.where(b == 78, 1978 - 1900, b)))) + 1900
            ys = 'gisa'
            treed = f.shape[1] and np.nanmean(np.where(f[b0:b1] == 255, np.nan, f[b0:b1])) > 30
            if treed and y < st['change'][0]: y, ys = st['change'][0], 'gisa+trees'
        else:
            y, ys = st['change'][1], 'trees'
        if st['id'] in FLOOR and y < FLOOR[st['id']]: y, ys = FLOOR[st['id']], 'source'
        out.append({'id': e['id'], 'name': name, 'h': round(h, 1), 'h_src': hs, 'year': y, 'year_src': ys,
                    'construction': construction, 'area': round(area),
                    'poly': [[round(x, 6), round(y_, 6)] for x, y_ in ring]})
    out.sort(key=lambda b: -b['area'])
    kept = []                                    # the same building mapped twice: keep the larger outline
    for b in out:
        fp = Polygon(b['poly'])
        if any(fp.intersection(Polygon(k['poly'])).area > 0.5 * fp.area for k in kept): continue
        kept.append(b)
    out = kept
    st['buildings'] = out
    print(f"{st['id']:11} {len(out):2} buildings", ', '.join(f"{b['name'] or '-'}:{b['h']:.0f}m/{b['year']}{'*' if b['construction'] else ''}" for b in out[:9]))
doc['about'] = doc['about'].replace('Site outlines (polygon)', 'Site outlines (polygon) and building footprints (buildings)')
json.dump(doc, open(a.stories, 'w'), ensure_ascii=False, separators=(',', ':'))

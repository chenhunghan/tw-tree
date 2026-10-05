# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pyarrow", "rasterio", "pystac-client", "planetary-computer", "pyproj", "pillow", "requests"]
# ///
"""One real pixel, from the raw Landsat scene to the stored tree-cover value (for the blog's "pixel journey" figure).

Picks the pixel inside a story site (default Fab 14) whose tree cover fell the most across the clearing, then for the
last clear year before it: the scene's rendered preview, a true-colour crop around the pixel at native 30 m, the six raw
DN at the pixel (Planetary Computer, same file as verify_provenance.py), reflectance, calibration, normalisation,
features, every tree's prediction and the result, checked against the stored value. Also the pixel's yearly series
with scene IDs and small true-colour crops of the same area for a few years.

  uv run pipeline/analysis/pixel_story.py --out-json ~/blog/src/components/trees/pixel.json \
      --out-img ~/blog/public/images/trees-vs-unicorns/pixel
"""
import argparse, gzip, io, json, pathlib, sys
import numpy as np, pyarrow.ipc as ipc, rasterio, requests, pystac_client, planetary_computer
from rasterio.windows import Window
from pyproj import Transformer
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'pipeline'))
from verify_provenance import parse_tree, features, PC_BANDS, ROY_SLOPE, ROY_INTERCEPT  # noqa: E402

HF = 'https://huggingface.co/datasets/chenhunghan/tw-tree/resolve/main/taiwan/'
ap = argparse.ArgumentParser()
ap.add_argument('--story', default='tsmc-fab14')
ap.add_argument('--out-json', required=True)
ap.add_argument('--out-img', required=True)
ap.add_argument('--crop', type=int, default=64, help='crop size in pixels (30 m)')
ap.add_argument('--thumbs', default='', help='years for the small crops, e.g. 1995,1997,2000,2015,2025 (avoid Landsat 7 SLC-off years: stripes)')
a = ap.parse_args()
out_img = pathlib.Path(a.out_img).expanduser(); out_img.mkdir(parents=True, exist_ok=True)

story = next(s for s in json.loads((ROOT / 'site/stories/tsmc.json').read_text())['stories'] if s['id'] == a.story)
idx = requests.get(HF + 'index.json', timeout=60).json()
years = idx['years']
model = json.loads((ROOT / 'pipeline/model' / f"{idx['model']['name']}.json").read_text())
trees = [parse_tree(t) for t in model['trees']]
load = lambda rel: ipc.open_file(gzip.decompress(requests.get(HF + rel, timeout=120).content)).read_all()


def inside(lon, lat, poly):
    c = False
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1): c = not c
    return c


# the tile with the site centre (zone 51 owns the south-west plain here? try both zones)
tile = None
for t in idx['tiles']:
    tr = Transformer.from_crs(4326, 32600 + t['zone'], always_xy=True)
    x, y = tr.transform(story['lon'], story['lat'])
    if t['x0'] <= x < t['x0'] + idx['tile_m'] and t['y0'] <= y < t['y0'] + idx['tile_m']:
        tile = t; break
frac, prov = load(tile['frac']), load(tile['prov'])
pmeta = json.loads(prov.schema.metadata[b'tpetree'])
fmeta = json.loads(frac.schema.metadata[b'tpetree'])
calib = pmeta.get('calibration') or fmeta.get('calibration') or {k: None if k in ('LC08', 'LC09') else (ROY_SLOPE.tolist(), ROY_INTERCEPT.tolist()) for k in ('LT04', 'LT05', 'LE07', 'LC08', 'LC09')}
inv = Transformer.from_crs(32600 + tile['zone'], 4326, always_xy=True)
X, Y = frac['x_utm'].to_numpy(), frac['y_utm'].to_numpy()
F = {y: frac[f'f{y}'].to_numpy() for y in years}
S = {y: prov[f's{y}'].to_numpy() for y in years}
own = frac['own'].to_numpy() if 'own' in frac.column_names else np.ones(len(X), bool)

# the pixel with the largest drop across the clearing (inside the outline, observed in both windows)
c0, c1 = story['change']
before = [y for y in years if story['before'][0] <= y <= story['before'][1]]
after = [y for y in years if c1 + 2 <= y <= c1 + 6]
best, bestd = None, -1
lons, lats = inv.transform(X.astype(float), Y.astype(float))
for k in np.flatnonzero(own):
    if not inside(lons[k], lats[k], story['polygon']): continue
    b = [F[y][k] for y in before if F[y][k] != 255]; c = [F[y][k] for y in after if F[y][k] != 255]
    if len(b) < 3 or len(c) < 3: continue
    d = np.mean(b) - np.mean(c)
    if d > bestd: best, bestd = k, d
k = best
x, y = int(X[k]), int(Y[k])
print(f'pixel {k}: ({x},{y}) {lats[k]:.5f},{lons[k]:.5f} drop {bestd:.0f} points')

cat = pystac_client.Client.open('https://planetarycomputer.microsoft.com/api/stac/v1', modifier=planetary_computer.sign_inplace)
scene_id = lambda yr: None if S[yr][k] == 65535 else pmeta['scenes'][str(yr)][int(S[yr][k])]


def pc_item(pid):
    p = pid.split('_')
    return cat.get_collection('landsat-c2-l2').get_item('_'.join(p[:4] + p[5:]))


def window_of(item, size):
    tr = item.assets['red'].extra_fields.get('proj:transform') or item.properties['proj:transform']
    col, row = (x - 15 - tr[2]) / 30, (tr[5] - y - 15) / 30
    assert col == int(col) and row == int(row), (col, row)
    return int(col), int(row), Window(int(col) - size // 2, int(row) - size // 2, size, size)


def rgb_crop(item, size, path, scale=4):
    col, row, win = window_of(item, size)
    bands = []
    for b in ('red', 'green', 'blue'):
        with rasterio.open(item.assets[b].href) as ds: bands.append(ds.read(1, window=win, boundless=True, fill_value=0).astype('float64'))
    sr = np.clip(np.stack(bands, -1) * 0.0000275 - 0.2, 0, None)
    lo, hi = np.percentile(sr[sr > 0], 1), np.percentile(sr[sr > 0], 99)
    img = (np.clip((sr - lo) / (hi - lo), 0, 1) ** 0.8 * 255).astype('uint8')
    Image.fromarray(img).resize((size * scale, size * scale), Image.NEAREST).save(path, quality=88)
    return col, row


# the detailed year: the last observed year before the clearing with the highest value
cands = [yy for yy in before if F[yy][k] != 255 and scene_id(yy)]
Yd = max(cands, key=lambda yy: (F[yy][k], yy))
pid = scene_id(Yd); item = pc_item(pid)
assert item is not None, f'{pid} not on Planetary Computer'
col, row, _ = window_of(item, 1)
dn = []
for band in PC_BANDS + ['qa_pixel']:
    with rasterio.open(item.assets[band].href) as ds: dn.append(int(ds.read(1, window=Window(col, row, 1, 1))[0, 0]))
norm = (fmeta.get('normalisation') or {}).get('params', {}).get(str(Yd))
sensor = pid.split('_')[0]
sr = (np.array(dn[:6]) * 0.0000275 - 0.2)
co = calib.get(sensor)
sr_cal = sr * np.array(co[0]) + np.array(co[1]) if co else sr
fv = features(np.array(dn[:6]), sensor, calib, norm)
votes = []
for nodes in trees:
    n = 1
    while not nodes[n]['leaf']:
        left = nodes[2 * n]
        n = 2 * n if fv[left['feat']] <= left['thr'] else 2 * n + 1
    votes.append(nodes[n]['yval'])
f_local = int(np.floor(np.clip(np.mean(votes), 0, 1) * 100 + 0.5))
print(f'{Yd} {pid}: DN {dn[:6]} -> {f_local}% (stored {F[Yd][k]})')

# images: the whole scene's preview, a 64 px (1.9 km) crop around the pixel, small crops for a few years
prev = requests.get(item.assets['rendered_preview'].href, timeout=120).content
im = Image.open(io.BytesIO(prev)).convert('RGB'); im.thumbnail((720, 720)); im.save(out_img / 'scene.jpg', quality=82)
tr = item.assets['red'].extra_fields.get('proj:transform') or item.properties['proj:transform']
shape = item.assets['red'].extra_fields.get('proj:shape') or item.properties['proj:shape']
rgb_crop(item, a.crop, out_img / 'crop.jpg')
series_years = [yy for yy in ([int(v) for v in a.thumbs.split(',')] if a.thumbs else (before[0], Yd, c1 + 2, 2015, years[-2])) if yy in years]
thumbs = []
for yy in dict.fromkeys(series_years):
    sid = scene_id(yy)
    it = sid and pc_item(sid)
    if not it: continue
    rgb_crop(it, 32, out_img / f'y{yy}.jpg', scale=4)
    thumbs.append({'year': yy, 'scene': sid, 'f': int(F[yy][k]), 'img': f'y{yy}.jpg'})

out = {
    'story': a.story, 'site': story['en'], 'lat': round(float(lats[k]), 6), 'lon': round(float(lons[k]), 6),
    'zone': tile['zone'], 'x_utm': x, 'y_utm': y, 'tile': f"{tile['zone']}/{tile['i']}_{tile['j']}",
    'detail': {
        'year': Yd, 'scene': pid, 'sensor': sensor, 'date': item.properties['datetime'][:10],
        'scene_px': [int(shape[1]), int(shape[0])], 'pixel_in_scene': [col, row], 'crop_px': a.crop,
        'dn': dn[:6], 'qa_pixel': dn[6], 'clear': (dn[6] & 0b111111) == 0, 'sr': [round(v, 4) for v in sr],
        'sr_calibrated': [round(float(v), 4) for v in sr_cal],
        'sr_normalised': [round(float(fv[b]), 4) for b in ('blue', 'green', 'red', 'nir', 'swir1', 'swir2')],
        'normalisation': norm, 'calibration': co,
        'features': {kk: round(float(v), 4) for kk, v in fv.items()},
        'votes': [round(float(v), 4) for v in votes], 'f_local': f_local, 'f_stored': int(F[Yd][k]),
    },
    'series': [{'year': yy, 'f': None if F[yy][k] == 255 else int(F[yy][k]), 'scene': scene_id(yy)} for yy in years],
    'thumbs': thumbs, 'model': idx['model']['name'], 'n_trees': len(trees),
}
pathlib.Path(a.out_json).expanduser().write_text(json.dumps(out, indent=1))
print('saved', a.out_json)

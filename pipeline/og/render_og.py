# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow"]
# ///
"""Social preview images and share pages for the site stories (crawlers don't run JS, so a ?story= link alone always
previews as the plain app).

For each story in site/stories/<collection>.json:
  site/og/<id>.jpg       1200x630: the story's own view rendered by the app (headless, `?ui=0`), the year before the
                         clearing on the left and the last year on the right, with the name and the measured drop
  site/s/<id>/index.html a static page with that story's og:/twitter: tags; it forwards to ../../?story=<id> (plus
                         any at/d/az/el/from on the link) at once
and site/og/default.jpg for the app itself.

usage: uv run pipeline/og/render_og.py [--collection tsmc] [--only id,id] [--pages-only]
Needs agent-browser (Chrome) and network access to the tile data; fonts: macOS STHeiti.
"""
import argparse, functools, html, http.server, json, pathlib, subprocess, threading, time
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[2]
SITE = ROOT / 'site'
BASE = 'https://chenhunghan.github.io/tw-tree/'
W, H = 1200, 630
FONT_B = '/System/Library/Fonts/STHeiti Medium.ttc'
FONT_L = '/System/Library/Fonts/STHeiti Light.ttc'
SESSION = 'tpetree-og'

ap = argparse.ArgumentParser()
ap.add_argument('--collection', default='tsmc')
ap.add_argument('--only', default='')
ap.add_argument('--pages-only', action='store_true')
a = ap.parse_args()
doc = json.loads((SITE / 'stories' / f'{a.collection}.json').read_text())
stories = [s for s in doc['stories'] if not a.only or s['id'] in a.only.split(',')]


# ---------- local server + browser ----------
class Quiet(http.server.SimpleHTTPRequestHandler):
    def end_headers(self): self.send_header('Cache-Control', 'no-store'); super().end_headers()
    def log_message(self, *_): pass

def serve():
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(SITE)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f'http://127.0.0.1:{srv.server_address[1]}/'

def ab(*args, timeout=90):
    r = subprocess.run(['agent-browser', '--session', SESSION, *args], capture_output=True, text=True, timeout=timeout)
    return r.stdout.strip()

def js(expr):
    out = ab('eval', expr)
    try: return json.loads(out)
    except json.JSONDecodeError: return out

def wait(expr, limit=90):
    t0 = time.time()
    while time.time() - t0 < limit:
        if js(expr) is True: return True
        time.sleep(1)
    return False

def capture(url, shots):
    """Open url and save one screenshot per (year, path)."""
    ab('open', url)
    wait('!!window.__app?.ready')
    wait("(() => { const w = document.getElementById('storyWait'); return !w || w.hidden; })()")
    time.sleep(3)
    for year, path in shots:
        js(f'(() => {{ window.__app.setYear({year}); window.__app.advance(0.4); return 1; }})()')
        time.sleep(3)
        ab('screenshot', str(path))


# ---------- composition ----------
def font(path, size): return ImageFont.truetype(path, size)

def shade(img, box, top_alpha, bottom_alpha):
    """Vertical dark gradient over box (for legible text)."""
    x0, y0, x1, y1 = box
    g = Image.new('L', (1, y1 - y0))
    for y in range(y1 - y0): g.putpixel((0, y), int(top_alpha + (bottom_alpha - top_alpha) * y / max(1, y1 - y0 - 1)))
    g = g.resize((x1 - x0, y1 - y0))
    img.paste(Image.new('RGB', (x1 - x0, y1 - y0), (12, 22, 16)), (x0, y0), g)

def pill(d, xy, text, f, fill=(250, 250, 245), ink=(29, 42, 34)):
    x, y = xy; l, t, r, b = d.textbbox((0, 0), text, font=f)
    d.rounded_rectangle((x, y, x + r - l + 28, y + b - t + 18), radius=14, fill=fill)
    d.text((x + 14 - l, y + 9 - t), text, font=f, fill=ink)

def compose(s, before, after, out):
    A, B = Image.open(before).convert('RGB'), Image.open(after).convert('RGB')
    img = Image.new('RGB', (W, H))
    img.paste(A.crop((W // 4, 0, W // 4 + W // 2, H)), (0, 0))         # centre half of each view
    img.paste(B.crop((W // 4, 0, W // 4 + W // 2, H)), (W // 2, 0))
    shade(img, (0, 0, W, 120), 150, 0)
    shade(img, (0, H - 190, W, H), 0, 225)
    d = ImageDraw.Draw(img)
    d.line((W // 2, 0, W // 2, H), fill=(250, 250, 245), width=4)
    y0, y1 = s['before'][1], doc['years'][-1]
    pill(d, (24, 22), str(y0), font(FONT_B, 40))
    pill(d, (W // 2 + 24, 22), str(y1), font(FONT_B, 40), fill=(217, 72, 15), ink=(255, 255, 255))
    d.text((32, H - 168), s['zh'], font=font(FONT_B, 46), fill=(255, 255, 255))
    d.text((34, H - 112), s['en'], font=font(FONT_L, 28), fill=(225, 232, 226))
    sb, sa = round(s['site_before']), round(s['site_after'])
    d.text((34, H - 66), f'樹冠 Tree cover {sb}% → {sa}%  /  約 {round(s["lost_ha"])} 公頃 (ha) 消失 lost',
           font=font(FONT_B, 28), fill=(255, 214, 170))
    credit = 'Landsat USGS  /  ESA WorldCover  /  © OpenStreetMap  /  tw-tree'
    f = font(FONT_L, 15); w = d.textlength(credit, font=f)
    d.text((W - w - 18, H - 26), credit, font=f, fill=(200, 210, 204))
    img.save(out, quality=86, optimize=True, progressive=True)

def compose_default(shot, out):
    img = Image.open(shot).convert('RGB').resize((W, H))
    shade(img, (0, H - 230, W, H), 0, 225)
    d = ImageDraw.Draw(img)
    d.text((34, H - 200), '臺灣樹冠時光機', font=font(FONT_B, 64), fill=(255, 255, 255))
    d.text((36, H - 118), 'Taiwan Tree-Cover Time Machine  /  1984–2026', font=font(FONT_L, 32), fill=(225, 232, 226))
    d.text((36, H - 70), '每 30 公尺、每一年的樹冠，3D 時間軸  /  every 30 m pixel, every year, in 3D', font=font(FONT_B, 24), fill=(255, 214, 170))
    img.save(out, quality=86, optimize=True, progressive=True)


# ---------- share pages ----------
PAGE = """<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="臺灣樹冠時光機 · Taiwan Tree-Cover Time Machine">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="{image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="{url}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{image}">
<link rel="canonical" href="{app}">
<script>
  // forward to the app with this story, keeping any view parameters on the link (at, d, az, el, from, lang)
  var q = location.search ? '&' + location.search.slice(1) : '';
  location.replace('../../?story={id}' + q + location.hash);
</script>
</head>
<body><p><a href="../../?story={id}">{title}</a></p></body>
</html>
"""

def page(s):
    sb, sa = round(s['site_before']), round(s['site_after'])
    title = f"{s['zh']}：樹冠 {sb}% → {sa}% · {s['en']}"
    desc = (f"{s['before'][0]}–{s['before'][1]} 年樹冠 {sb}%，{s['after'][0]}–{s['after'][1]} 年 {sa}%，約 {round(s['lost_ha'])} 公頃消失。"
            f" Tree cover {sb}% → {sa}%, about {round(s['lost_ha'])} ha lost. 3D Landsat timeline 1984–2026.")
    e = lambda x: html.escape(x, quote=True)
    out = SITE / 's' / s['id']; out.mkdir(parents=True, exist_ok=True)
    (out / 'index.html').write_text(PAGE.format(title=e(title), desc=e(desc), image=f"{BASE}og/{s['id']}.jpg",
                                                url=f"{BASE}s/{s['id']}/", app=f"{BASE}?story={s['id']}", id=s['id']))


(SITE / 'og').mkdir(exist_ok=True)
for s in stories: page(s)
print(f'{len(stories)} share pages')
if not a.pages_only:
    base = serve()
    ab('set', 'viewport', str(W), str(H))
    tmp = ROOT / 'build' / 'og'; tmp.mkdir(parents=True, exist_ok=True)
    for s in stories:
        b, f = tmp / f"{s['id']}_before.png", tmp / f"{s['id']}_after.png"
        # closer than the story's opening view: each half is only 600 px wide, the fab should fill it
        capture(f"{base}?story={s['id']}&ui=0&lang=zh&weather=clear&hour=10.5&trees=1&d={round(s['d'] * 0.45)}&el=50",
                [(s['before'][1], b), (doc['years'][-1], f)])
        compose(s, b, f, SITE / 'og' / f"{s['id']}.jpg")
        print('og', s['id'])
    if not a.only:
        d = tmp / 'default.png'
        capture(f"{base}?ui=0&lang=zh&weather=clear&hour=9.5&trees=1&at=24.86,121.53&d=2600&az=150&el=24&y=2024", [(2024, d)])
        compose_default(d, SITE / 'og' / 'default.jpg')
        print('og default')
    ab('close')

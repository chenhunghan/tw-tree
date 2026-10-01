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
Images and pages are in English (social sites show one language); the headline is the measured tree-cover drop 🌳
vs the site's estimated revenue in unicorns 🦄 (1 = US$1 bn, as in the app), and the "after" half shows them flying.
Needs agent-browser (Chrome) and network access to the tile data; fonts: macOS STHeiti, Apple Color Emoji.
"""
import argparse, functools, html, http.server, json, pathlib, subprocess, threading, time
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[2]
SITE = ROOT / 'site'
BASE = 'https://chenhunghan.github.io/tw-tree/'
W, H = 1200, 630
FONT_B = '/System/Library/Fonts/STHeiti Medium.ttc'
FONT_L = '/System/Library/Fonts/STHeiti Light.ttc'
FONT_EMOJI = '/System/Library/Fonts/Apple Color Emoji.ttc'     # bitmap strikes only: rendered at 160 px, then scaled
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

# a flock of the app's unicorns in mid-flight out of the site's standing roofs (spawned at staggered times)
UNICORN_JS = """(() => { const a = window.__app, st = a.story;
  const roofs = st.blds.filter(o => o.mesh.visible && !o.b.construction).sort((p, q) => q.b.area - p.b.area).slice(0, 8);
  if (!roofs.length) return 0;
  for (let i = 0; i < 12; i++) {
    const o = roofs[i % roofs.length], top = o.top.clone();
    st.unicorns.spawn(top, Math.max(8, a.camera.position.distanceTo(top) * 0.016));
    a.advance(0.28);
  }
  return st.unicorns.flying; })()"""

def capture(url, shots):
    """Open url and save one screenshot per (year, path[, js to run before the shot])."""
    ab('open', url)
    wait('!!window.__app?.ready')
    wait("(() => { const w = document.getElementById('storyWait'); return !w || w.hidden; })()")
    time.sleep(3)
    for year, path, *pre in shots:
        js(f'(() => {{ window.__app.setYear({year}); window.__app.advance(0.4); return 1; }})()')
        time.sleep(3)
        for p in pre: js(p)
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

def emoji(img, ch, xy, size):
    """Paste one colour emoji with its top-left at xy, `size` px tall."""
    f = ImageFont.truetype(FONT_EMOJI, 160)
    tile = Image.new('RGBA', (200, 200), (0, 0, 0, 0))
    ImageDraw.Draw(tile).text((0, 0), ch, font=f, embedded_color=True)
    tile = tile.crop(tile.getbbox()).resize((size, size), Image.LANCZOS)
    img.paste(tile, xy, tile)

def run(img, x, y, parts, size):
    """Draw a line of text and emoji runs: ('t', text, font, fill) or ('e', emoji); returns the end x."""
    d = ImageDraw.Draw(img)
    for p in parts:
        if p[0] == 'e':
            emoji(img, p[1], (int(x), int(y + size * 0.02)), size); x += size * 1.12
        else:
            d.text((x, y), p[1], font=p[2], fill=p[3]); x += d.textlength(p[1], font=p[2])
    return x

def revenue_bn(s):
    """The site's estimated revenue (US$ bn) through the last year of the timeline, or None."""
    r = s.get('revenue')
    if not r: return None
    return sum(v for y, v in zip(r['years'], r['usd']) if y <= doc['years'][-1])

def compose(s, before, after, out):
    A, B = Image.open(before).convert('RGB'), Image.open(after).convert('RGB')
    img = Image.new('RGB', (W, H))
    img.paste(A.crop((W // 4, 0, W // 4 + W // 2, H)), (0, 0))         # centre half of each view
    img.paste(B.crop((W // 4, 0, W // 4 + W // 2, H)), (W // 2, 0))
    shade(img, (0, 0, W, 120), 150, 0)
    shade(img, (0, H - 210, W, H), 0, 230)
    d = ImageDraw.Draw(img)
    d.line((W // 2, 0, W // 2, H), fill=(250, 250, 245), width=4)
    y0, y1 = s['before'][1], doc['years'][-1]
    pill(d, (24, 22), str(y0), font(FONT_B, 40))
    pill(d, (W // 2 + 24, 22), str(y1), font(FONT_B, 40), fill=(217, 72, 15), ink=(255, 255, 255))
    sb, sa, bn = round(s['site_before']), round(s['site_after']), revenue_bn(s)
    big, white, gold = font(FONT_B, 54), (255, 255, 255), (255, 214, 120)
    parts = [('e', '🌳'), ('t', f' {sb}% → {sa}%', big, white)]
    if bn and bn >= 1: parts += [('t', '   vs   ', font(FONT_L, 40), (225, 232, 226)), ('e', '🦄'), ('t', f' × {int(bn):,}', big, gold)]
    run(img, 32, H - 190, parts, 54)
    d.text((34, H - 112), s['en'], font=font(FONT_B, 32), fill=(240, 244, 240))
    small = (font(FONT_L, 25), (255, 214, 170))
    parts = [('t', f"{round(s['lost_ha'])} ha of tree canopy lost", *small)]
    if bn and bn >= 1: parts += [('t', f"  ·  est. US${int(bn):,} bn revenue (1 ", *small), ('e', '🦄'), ('t', ' = US$1 bn)', *small)]
    run(img, 34, H - 64, parts, 25)
    credit = 'Landsat USGS  /  ESA WorldCover  /  © OpenStreetMap  /  tw-tree'
    f = font(FONT_L, 15); w = d.textlength(credit, font=f)
    d.text((W - w - 18, H - 26), credit, font=f, fill=(200, 210, 204))
    img.save(out, quality=86, optimize=True, progressive=True)

def compose_default(shot, out):
    img = Image.open(shot).convert('RGB').resize((W, H))
    shade(img, (0, H - 230, W, H), 0, 225)
    d = ImageDraw.Draw(img)
    run(img, 34, H - 196, [('e', '🌳'), ('t', ' Taiwan Tree-Cover Time Machine', font(FONT_B, 58), (255, 255, 255))], 58)
    d.text((36, H - 112), '1984–2026  ·  every 30 m Landsat pixel, every year, in 3D', font=font(FONT_L, 32), fill=(225, 232, 226))
    run(img, 36, H - 66, [('t', 'Plus TSMC fab stories: tree cover lost vs revenue in ', font(FONT_B, 24), (255, 214, 170)), ('e', '🦄'),
                          ('t', ' (1 = US$1 bn)', font(FONT_B, 24), (255, 214, 170))], 24)
    img.save(out, quality=86, optimize=True, progressive=True)


# ---------- share pages ----------
PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Taiwan Tree-Cover Time Machine">
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
<meta property="og:locale" content="en_US">
<meta property="og:locale:alternate" content="zh_TW">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:alt" content="{alt}">
<meta name="twitter:image:alt" content="{alt}">
<meta name="theme-color" content="#2f6b3a">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8C%B3%3C/text%3E%3C/svg%3E">
<link rel="canonical" href="{url}">
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
    bn = revenue_bn(s)
    title = f"🌳 {sb}% → {sa}%" + (f" vs 🦄 × {int(bn):,}" if bn and bn >= 1 else '') + f" · {s['en']}"
    a0, a1 = s['after']
    desc = (f"Tree cover inside the site averaged {sb}% in {s['before'][0]}–{s['before'][1]} and {sa}% in "
            f"{a0 if a0 == a1 else f'{a0}–{a1}'}: about {round(s['lost_ha'])} ha of canopy lost."
            + (f" Estimated revenue since: about US${int(bn):,} bn, one 🦄 per billion." if bn and bn >= 1 else '')
            + " 3D Landsat timeline 1984–2026.")
    alt = (f"{s['en']} in 3D: the site in {s['before'][1]} with {sb}% tree cover (left) and in {doc['years'][-1]} with {sa}%"
           + (", unicorns flying out of the fab" if bn and bn >= 1 else '') + " (right)")
    e = lambda x: html.escape(x, quote=True)
    out = SITE / 's' / s['id']; out.mkdir(parents=True, exist_ok=True)
    (out / 'index.html').write_text(PAGE.format(title=e(title), desc=e(desc), alt=e(alt), image=f"{BASE}og/{s['id']}.jpg",
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
        capture(f"{base}?story={s['id']}&ui=0&lang=en&weather=clear&hour=10.5&trees=1&d={round(s['d'] * 1.78)}&el=50",
                [(s['before'][1], b), (doc['years'][-1], f, *([UNICORN_JS] if revenue_bn(s) else []))])
        compose(s, b, f, SITE / 'og' / f"{s['id']}.jpg")
        print('og', s['id'])
    if not a.only:
        d = tmp / 'default.png'
        capture(f"{base}?ui=0&lang=en&weather=clear&hour=9.5&trees=1&at=24.86,121.53&d=2600&az=150&el=24&y=2024", [(2024, d)])
        compose_default(d, SITE / 'og' / 'default.jpg')
        print('og default')
    ab('close')

# /// script
# requires-python = ">=3.11"
# ///
"""Estimated monthly revenue per TSMC story site -> site/stories/tsmc.json (each story's `revenue`).

TSMC publishes revenue only for the whole company. Per site and month we estimate
    wafer sites:     monthly revenue (NT$) x wafer share of revenue x Σ_node [node share of wafer revenue (that quarter)
                     x the site's share of that node (capacity-based, node_fab_share)]
    packaging sites: monthly revenue x advanced-packaging share of revenue x the site's share of packaging revenue
converted to US$ at the year's average rate. A likely range widens each node's contribution by the confidence of its
fab split (high ±10 %, medium ±25 %, low ±45 %; packaging site split ±50 %), taken as fully correlated (conservative).
Inputs, with a source for every number: pipeline/analysis/tsmc_revenue_inputs.json (researched 2026-10-01).

The app flies one unicorn per US$1 bn of the estimate (js/story.js, js/unicorns.js).
Run after build_stories.py and site_buildings.py (it only adds `revenue` to the stories):
    uv run pipeline/analysis/fab_revenue.py
"""
import json, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parents[2]
IN = json.loads((ROOT / 'pipeline/analysis/tsmc_revenue_inputs.json').read_text())
OUT = ROOT / 'site/stories/tsmc.json'

# story -> fabs (as named in node_fab_share) or packaging sites; Fab 6's buildings lie inside the Fab 14 outline
SITES = {'tsmc-fab12': ['Fab 12'], 'tsmc-fab14': ['Fab 14', 'Fab 6'], 'tsmc-fab15': ['Fab 15'], 'tsmc-fab18': ['Fab 18'],
         'tsmc-fab20': ['Fab 20'], 'tsmc-fab22': ['Fab 22'], 'tsmc-ap6': ['AP6'], 'tsmc-ap7': ['AP7']}
ERR = {'high': 0.10, 'medium': 0.25, 'low': 0.45}
PKG_ERR = 0.5

# ---------- inputs ----------
years = IN['annual_revenue']['years']
def fx(y):
    """NT$ per US$ for year y (2026: from TSMC's reported US$ for Q1+Q2)."""
    if str(y) in years and years[str(y)].get('fx_ntd_per_usd'): return years[str(y)]['fx_ntd_per_usd']
    ytd = IN['annual_revenue']['2026_ytd']
    return (ytd['q1_ntd_bn'] + ytd['q2_ntd_bn']) / ytd['usd_bn_tsmc_reported_q1_q2']

months = {k: v['ntd_m'] for k, v in IN['monthly_revenue']['months'].items() if v.get('ntd_m') is not None}

nonwafer = {int(k): v / 100 for k, v in IN['packaging']['non_wafer_share_of_net_revenue_pct']['values'].items()}
def wafer_share(y):
    # 2018-2025 from the 20-F notes; earlier (masks, design services; little packaging) ~7 %; 2026 like 2025 + growth
    return 1 - (nonwafer.get(y) or (0.07 if y < 2018 else 0.15))

def pkg_share(y):
    """Advanced packaging share of revenue (only needed from AP6's opening, 2023)."""
    return {2022: 0.07, 2023: 0.065, 2024: 0.08, 2025: 0.105, 2026: 0.125}.get(y, 0.0)

site_pkg = {k: v for k, v in IN['packaging']['site_share_of_advanced_packaging_revenue_ESTIMATE'].items() if re.fullmatch(r'\d{4}(-\d{4})?', k)}
def pkg_site(site, y, mo):
    if site == 'AP6' and (y, mo) < (2023, 6): return 0.0        # opened 2023-06-08
    if site == 'AP7' and y < 2026: return 0.0                    # volume production 2026
    for k, v in site_pkg.items():
        a, b = (int(k), int(k)) if '-' not in k else map(int, k.split('-'))
        if a <= y <= b: return v.get(site, 0.0)
    return 0.0

# TSMC's changing node bucket labels -> canonical rows (with splits)
def canon(label, y):
    s = label.replace('µ', 'u').replace('≤', '<=').replace('≥', '>=').replace(' ', '').lower()
    table = {
        'x<=0.18u': {'0.15/0.18um': 1}, '0.18u<x<=0.25u': {'0.25/0.35um': 1}, '0.25u<x<=0.35u': {'0.25/0.35um': 1},
        'x>=0.50u': {'>=0.5um': 1}, '0.35u<x': {'>=0.5um': 1}, 'x<=0.15u': {'0.15/0.18um': 1}, '0.15u<x<=0.18u': {'0.15/0.18um': 1},
        'x<=0.13um': {'0.11/0.13um': 1}, '0.13um<x<=0.15um': {'0.15/0.18um': 1}, '0.15um<x<=0.18um': {'0.15/0.18um': 1},
        '0.18um<x<=0.25um': {'0.25/0.35um': 1}, '0.25um<x<=0.35um': {'0.25/0.35um': 1}, 'x>=0.50um': {'>=0.5um': 1},
        '0.13um-': {'0.11/0.13um': 1}, '0.15um': {'0.15/0.18um': 1}, '0.18um': {'0.15/0.18um': 1}, '0.25um': {'0.25/0.35um': 1},
        '0.35um': {'0.25/0.35um': 1}, '0.50um+': {'>=0.5um': 1}, '0.50umandabove': {'>=0.5um': 1}, '0.35um+': {'0.25/0.35um': 0.5, '>=0.5um': 0.5},
        '0.15/0.18um': {'0.15/0.18um': 1}, '0.11/0.13um': {'0.11/0.13um': 1}, '0.25/0.35um': {'0.25/0.35um': 1},
        '0.25umandabove': {'0.25/0.35um': 0.8, '>=0.5um': 0.2}, '>=0.15um': {'0.15/0.18um': 1},
        '90nm': {'90nm': 1}, '90nm-': {'90nm': 1}, 'n90-': {'90nm': 1}, '90nm-0.13um': {'90nm': 0.4, '0.11/0.13um': 0.6},
        '65nm': {'65nm': 1}, '65nmandbelow': {'65nm': 1}, '40/45nm': {'40/45nm': 1}, '45/40nm': {'40/45nm': 1},
        '40/45nmandbelow': {'40/45nm': 1}, '28nm': {'28nm': 1}, '20nm': {'20nm': 1}, '16nm': {'16nm': 1},
        '16/20nm': {'20nm': 1} if y <= 2015 else {'16nm': 0.9, '20nm': 0.1},
        '10nm': {'10nm': 1}, '7nm': {'7nm': 1}, '5nm': {'5nm': 1}, '3nm': {'3nm': 1}, '2nm': {'2nm': 1},
    }
    if s not in table: raise KeyError(f'unmapped node bucket {label!r}')
    return table[s]

rows = IN['node_fab_share']['rows']
def fab_split(node, y):
    """(shares, confidence) of the node's row covering year y, else the nearest period's row."""
    best, gap = None, 1e9
    for r in rows:
        if r['node'] != node: continue
        p = str(r['period']); a, b = (int(p), int(p)) if '-' not in p else map(int, p.split('-'))
        g = 0 if a <= y <= b else min(abs(y - a), abs(y - b))
        if g < gap: best, gap = r, g
    return (best['shares'], best['confidence']) if best else ({}, 'low')

def share_of(shares, fab):
    return sum(v for k, v in shares.items() if k == fab or k.startswith(fab + ' ('))

quarters = IN['node_share_quarterly']['quarters']
def node_mix(y, mo):
    """Node shares of wafer revenue (fractions) for the month's quarter (latest reported quarter after it)."""
    q = f'{y}Q{mo // 3 + 1}'
    if q not in quarters: q = max(k for k in quarters if k <= q) if any(k <= q for k in quarters) else None
    if not q: return None
    out = {}
    for label, pct in quarters[q]['buckets'].items():
        for node, f in canon(label, y).items(): out[node] = out.get(node, 0) + pct / 100 * f
    tot = sum(out.values()) or 1
    return {k: v / tot for k, v in out.items()}

# ---------- estimate ----------
def estimate(fabs):
    """{year: [12 x (mid, lo, hi) US$ bn]}"""
    res = {}
    for key, ntd_m in sorted(months.items()):
        y, mo = int(key[:4]), int(key[5:]) - 1
        usd = ntd_m / 1000 / fx(y)                                 # US$ bn
        mid = lo = hi = 0.0
        for fab in fabs:
            if fab.startswith('AP'):
                v = usd * pkg_share(y) * pkg_site(fab, y, mo)
                mid += v; lo += v * (1 - PKG_ERR); hi += v * (1 + PKG_ERR)
                continue
            mix = node_mix(y, mo)
            if not mix: continue
            for node, ns in mix.items():
                shares, conf = fab_split(node, y)
                v = usd * wafer_share(y) * ns * share_of(shares, fab)
                e = ERR[conf]; mid += v; lo += v * (1 - e); hi += v * (1 + e)
        res.setdefault(y, [(0, 0, 0)] * 12)[mo] = (mid, lo, hi)
    return res

doc = json.loads(OUT.read_text())
last = max(months)
NOTE_EN = ("Estimate, not reported: TSMC publishes revenue only for the whole company. Each month's TSMC revenue is split by "
           "that quarter's process-node mix and by this site's estimated share of each node's capacity (packaging sites: "
           "by the advanced-packaging share). Low/high from how certain each split is. Through {last}.")
NOTE_ZH = ("此為估計，非公開數字：台積電只公布全公司營收。每月營收依當季製程組合，再依本廠區在各製程產能中的估計占比拆分"
           "（封測廠依先進封裝占比）；範圍依各項拆分的把握程度。資料至 {last}。")
for s in doc['stories']:
    fabs = SITES.get(s['id'])
    s.pop('revenue', None)
    if not fabs: continue
    est = estimate(fabs)
    ys = [y for y in sorted(est) if sum(m[0] for m in est[y]) > 0.0005]
    if not ys: continue
    ys = list(range(ys[0], max(ys) + 1))
    r = {'years': ys, 'usd': [], 'lo': [], 'hi': [], 'months': [], 'through': last, 'fabs': fabs,
         'note_en': NOTE_EN.format(last=last), 'note_zh': NOTE_ZH.format(last=last)}
    for y in ys:
        m = est.get(y, [(0, 0, 0)] * 12)
        r['months'].append([round(v[0], 4) for v in m])
        r['usd'].append(round(sum(v[0] for v in m), 3)); r['lo'].append(round(sum(v[1] for v in m), 3)); r['hi'].append(round(sum(v[2] for v in m), 3))
    s['revenue'] = r
    print(f"{s['id']:12s} {'+'.join(fabs):14s} {ys[0]}-{ys[-1]}  total US${sum(r['usd']):7.1f} bn  "
          f"(range {sum(r['lo']):.0f}-{sum(r['hi']):.0f})  last full year {ys[-2] if len(ys) > 1 else ys[-1]}: {r['usd'][-2] if len(ys) > 1 else r['usd'][-1]:.2f}")
OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')))

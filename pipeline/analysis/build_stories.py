# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""Site stories for the app (?story=<id>): measured tree-fraction series inside each site outline and a ring around
it (from site_series.py), the largest step down, and hand-checked context in zh/en.

usage: uv run pipeline/analysis/build_stories.py series.json site/stories/tsmc.json
Outlines come from OpenStreetMap (ODbL); the output file says so.
"""
import json, sys
import numpy as np

S = {  # id -> names, context (dates checked against the sources listed), camera heading
 'fab20': dict(zh='台積電 Fab 20（寶山）', en='TSMC Fab 20 (Baoshan)', place_zh='新竹縣寶山鄉 · 2 奈米', place_en='Baoshan, Hsinchu County · 2 nm',
   ctx_zh='新竹科學園區寶山二期。2022 年 3 月起部分土地租給台積電整地，原本是丘陵、墓地與客家聚落；2 奈米於 2025 年底量產，南側 P3/P4 仍在興建。',
   ctx_en='Hsinchu Science Park, Baoshan phase 2. TSMC began leveling leased land in spring 2022 on hills that held woods, graves and a Hakka village; 2 nm volume production began in late 2025, and P3/P4 to the south are still being built.',
   src=['https://www.ctee.com.tw/news/20220421700118-430502', 'https://www.businessweekly.com.tw/Archive/Article?StrId=7008502']),
 'fab25': dict(zh='台積電 Fab 25（臺中）', en='TSMC Fab 25 (Taichung)', place_zh='中部科學園區二期 · 1.4 奈米（A14）', place_en='Central Taiwan Science Park phase 2 · 1.4 nm (A14)',
   ctx_zh='台積電於 2025 年 6 月取得中科二期擴建用地，2025 年 11 月 5 日開始基礎工程，預計 2028 年下半年量產。',
   ctx_en='TSMC took over the Central Taiwan Science Park phase 2 expansion land in June 2025 and began foundation work on 5 November 2025; volume production is planned for the second half of 2028.',
   src=['https://www.taipeitimes.com/News/front/archives/2025/08/29/2003842865', 'https://www.trendforce.com/news/2025/10/20/news-tsmc-reportedly-to-break-ground-1-4nm-taichung-fab-on-nov-5-mass-production-slated-in-2h28/']),
 'rd': dict(zh='台積電全球研發中心（寶山）', en='TSMC Global R&D Center (Baoshan)', place_zh='新竹科學園區 · 2 奈米以下研發', place_en='Hsinchu Science Park · 2 nm-and-beyond R&D',
   ctx_zh='2020 年動工，2023 年 7 月 28 日啟用，總樓地板面積約 30 萬平方公尺，研發人員超過 7,000 人。',
   ctx_en='Construction started in 2020 and the centre opened on 28 July 2023: about 300,000 m² of floor space for more than 7,000 R&D staff.',
   src=['https://www.taipeitimes.com/News/front/archives/2023/07/29/2003803911']),
 'fab18': dict(zh='台積電 Fab 18（臺南）', en='TSMC Fab 18 (Tainan)', place_zh='南部科學園區 · 5／3 奈米', place_en='Southern Taiwan Science Park · 5 / 3 nm',
   ctx_zh='2018 年 1 月 26 日動土，2020 年第二季 5 奈米量產；基地約 42 公頃。',
   ctx_en='Ground was broken on 26 January 2018 and 5 nm volume production began in Q2 2020; the site is about 42 ha.',
   src=['https://pr.tsmc.com/english/news/1951']),
 'ap6': dict(zh='台積電先進封測六廠（竹南）', en='TSMC Advanced Backend Fab 6 (Zhunan)', place_zh='竹南科學園區 · 3DFabric 先進封裝', place_en='Zhunan Science Park · 3DFabric packaging',
   ctx_zh='2020 年動工，2023 年 6 月 8 日啟用，基地 14.3 公頃，是台積電最大的先進封測廠。',
   ctx_en='Construction began in 2020 and the fab opened on 8 June 2023; at 14.3 ha it is TSMC\'s largest advanced backend fab.',
   src=['https://pr.tsmc.com/english/news/3033']),
 'fab12': dict(zh='台積電 Fab 12（新竹）', en='TSMC Fab 12 (Hsinchu)', place_zh='新竹科學園區 · 12 吋晶圓廠', place_en='Hsinchu Science Park · 12-inch fab',
   ctx_zh='Fab 12 的廠房分期興建；依 GISA 衛星資料，這塊基地大多在 2008–2009 年第一次成為不透水面。',
   ctx_en='Fab 12 was built in phases; according to GISA satellite data, most of this part of the site first became impervious surface in 2008–2009.',
   src=[]),
 'fab15': dict(zh='台積電 Fab 15（臺中）', en='TSMC Fab 15 (Taichung)', place_zh='中部科學園區 · 12 吋晶圓廠', place_en='Central Taiwan Science Park · 12-inch fab',
   ctx_zh='Fab 15 分期興建；依 GISA 衛星資料，基地一部分在 2011 年、另一大部分在 2016–2018 年第一次成為不透水面。',
   ctx_en='Fab 15 was built in phases; according to GISA satellite data, part of the site first became impervious in 2011 and a larger part in 2016–2018.',
   src=[]),
 'fab14': dict(zh='台積電 Fab 14（臺南）', en='TSMC Fab 14 (Tainan)', place_zh='南部科學園區 · 12 吋晶圓廠', place_en='Southern Taiwan Science Park · 12-inch fab',
   ctx_zh='南科在 1990 年代後期開發；依 GISA 衛星資料，這塊基地大多在 1998–2000 年第一次成為不透水面，後續分期擴建到 2013 年。',
   ctx_en='The Southern Taiwan Science Park was developed in the late 1990s; according to GISA satellite data, most of this site first became impervious in 1998–2000, with later phases up to 2013.',
   src=[]),
 'ap7': dict(zh='台積電先進封測七廠（嘉義）', en='TSMC Advanced Backend Fab 7 (Chiayi)', place_zh='嘉義科學園區 · 先進封裝', place_en='Chiayi Science Park · advanced packaging',
   ctx_zh='2024 年 5 月動工，6 月因發現疑似遺址暫停；2025 年 12 月啟用。基地原為農地，作物也可能被模型讀成部分樹冠。',
   ctx_en='Construction began in May 2024 and paused in June after a suspected archaeological site was found; it opened in December 2025. The site was farmland, and crops can read as partial tree cover.',
   src=['https://www.tomshardware.com/tech-industry/tsmc-suspends-cowos-fab-construction-because-of-archeological-findings', 'https://www.trendforce.com/news/2025/12/04/news-tsmc-speeds-advanced-packaging-ap7-targets-2026-output-arizona-p6-eyed-for-u-s-packaging-hub/']),
 'fab22': dict(zh='台積電 Fab 22（高雄楠梓）', en='TSMC Fab 22 (Nanzi, Kaohsiung)', place_zh='楠梓產業園區 · 2 奈米', place_en='Nanzih Technology Industrial Park · 2 nm',
   ctx_zh='建在中油高雄煉油廠舊址上，2022 年動工、2025 年底 2 奈米量產。煉油廠時期樹冠就很少，所以變化不大。',
   ctx_en='Built on the former CPC Kaohsiung refinery, with construction from 2022 and 2 nm volume production from late 2025. The refinery left little tree cover, so the change is small.',
   src=['https://www.taipeitimes.com/News/biz/archives/2022/11/22/2003789359', 'https://en.wikipedia.org/wiki/Kaohsiung_Refinery']),
}
ORDER = ['fab20', 'fab25', 'rd', 'fab18', 'ap6', 'fab12', 'fab15', 'fab14', 'ap7', 'fab22']

d = json.load(open(sys.argv[1])); Y = d['years']
out = {'about': 'Tree fraction inside TSMC site outlines and a ring around them, from chenhunghan/tw-tree (taiwan/, '
                'CC BY 4.0). Site outlines (polygon) © OpenStreetMap contributors, ODbL 1.0.',
       'ring_m': d['ring_m'], 'years': Y, 'stories': []}
for sid in ORDER:
    v = d['sites'][sid]; s = np.array(v['site']['mean']); r = np.array(v['ring']['mean'])
    # largest step down: mean of the 4 years before vs the 3 years from it; then widen it to the whole decline
    best, k = -1e9, None
    for i in range(4, len(Y)):
        drop = s[i - 4:i].mean() - s[i:i + 3].mean()
        if drop > best: best, k = drop, i
    k0 = k                                   # decline starts where the year-on-year fall stops being > 5 points
    while k0 > 1 and s[k0 - 1] < s[k0 - 2] - 5: k0 -= 1
    j = k0                                   # ... and ends once less than 5 more points are lost in the next 3 years
    while j < len(Y) - 1 and s[j] - s[j + 1:j + 4].min() >= 5: j += 1
    b, a = slice(max(0, k0 - 5), k0), slice(j, min(len(Y), j + 3))
    lon0, lat0, lon1, lat1 = v['bounds']
    diag = np.hypot((lon1 - lon0) * 101000, (lat1 - lat0) * 111000)
    st = {'id': f'tsmc-{sid}', **{x: S[sid][x] for x in ('zh', 'en', 'place_zh', 'place_en', 'ctx_zh', 'ctx_en', 'src')},
          'lat': v['centroid'][0], 'lon': v['centroid'][1], 'd': int(np.clip(diag * 2.4, 1500, 3600)), 'az': 15, 'el': 40,
          'ha': v['site']['ha'], 'change': [Y[k0], Y[j]], 'before': [Y[b.start], Y[b.stop - 1]], 'after': [Y[a.start], Y[a.stop - 1]],
          'site_before': round(float(s[b].mean()), 1), 'site_after': round(float(s[a].mean()), 1), 'site_now': s[-1],
          'ring_before': round(float(r[b].mean()), 1), 'ring_after': round(float(r[a].mean()), 1), 'ring_now': r[-1],
          'site': list(s), 'ring': list(r), 'polygon': v['polygon']}
    st['lost_ha'] = round(st['ha'] * (st['site_before'] - st['site_after']) / 100, 1)
    out['stories'].append(st)
    print(f"{sid:6} change {Y[k0]}-{Y[j]} before {Y[b.start]}-{Y[b.stop-1]} site {st['site_before']}→{st['site_after']} (now {s[-1]}) ring {st['ring_before']}→{st['ring_after']} lost {st['lost_ha']} ha of {st['ha']}")
json.dump(out, open(sys.argv[2], 'w'), ensure_ascii=False, separators=(',', ':'))

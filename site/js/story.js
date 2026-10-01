// Site stories (?story=<collection>-<site>, or ?story=<collection> for its first site): fly to a site, outline it on
// the ground, play the timeline through the years its tree cover fell, and show the measured series inside the
// outline and in a ring around it (precomputed in stories/<collection>.json by pipeline/analysis/build_stories.py).
// The site's real buildings (OSM footprints, pipeline/analysis/site_buildings.py) are extruded and rise in the year they
// appear; buildings still under construction are translucent shells. Illustrative buildings inside the outline are
// left out while a story is open (`excludes`).
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { t, pickLang, lang } from './i18n.js';
import { Unicorns } from './unicorns.js';

const $ = (id) => document.getElementById(id);
const SLOW = 0.5, MID = 1.2;                   // years per second: through the clearing and around each building's year / else
const TREE_M2 = 50;                            // canopy area of one tree (m², a mature lowland broadleaf crown): ha lost -> trees
const LEAD = 3;                                // playback starts this many years before the clearing
const HOLD_OPEN = 1500, HOLD_REPLAY = 1000;   // ms on the first year once the site is ready (read the card)

// Short site name for the picker (the card's title has the full one): Fab 25, AP6, R&D Center
function shortName(s) {
  const m = s.id.match(/-(fab|ap)(\d+)$/);
  if (m) return m[1] === 'fab' ? `Fab ${m[2]}` : `AP${m[2]}`;
  return pickLang(s).replace(/^台積電|^TSMC\s*/, '').replace(/[（(].*$/, '').replace(/^Global\s*/, '').trim();
}

export class Story {
  // app: { scene, years(), ground(lon, lat) -> world [x, y, z], view(lon, lat, d, el, az, animate), setYear(i, play),
  //        status(msg, warn), tilesVersion(), layout() (story mode toggled), refreshCity(),
  //        siteProgress([lon0, lat0, lon1, lat1]) -> { done, total, trees } (detail tiles around the site, trees built),
  //        viewState() -> { lat, lon, d, az, el, year } }
  constructor(app) {
    this.app = app; this.data = null; this.cur = null; this.line = null; this.drapedAt = -1; this.blds = []; this.ring = null;
    this.fabMat = new THREE.MeshLambertMaterial({ color: 0xd3d8db });
    this.shellMat = new THREE.MeshLambertMaterial({ color: 0xe0a46a, transparent: true, opacity: 0.38, depthWrite: false });
    this.edgeMat = new THREE.LineBasicMaterial({ color: 0x34424a, transparent: true, opacity: 0.85 });
    this.shellEdge = new THREE.LineBasicMaterial({ color: 0xb4632a, transparent: true, opacity: 0.85 });
    this.unicorns = new Unicorns(app.scene); this.revCum = null;
    this.labels = document.createElement('div'); this.labels.id = 'storyLabels'; document.body.appendChild(this.labels);
    this.mat = new LineMaterial({ color: 0xd9480f, linewidth: 3, depthTest: false, transparent: true, opacity: 0.95 });
    this.mat.resolution.set(innerWidth, innerHeight);
    addEventListener('resize', () => this.mat.resolution.set(innerWidth, innerHeight));
    $('storyClose').onclick = () => this.close();
    $('storyReplay').onclick = () => this.replay();
    $('storyShare').onclick = () => this.share();
    $('storyPick').onchange = (e) => this.open(e.target.value, true);
    $('storyReplay').textContent = t('sReplay'); $('storyShare').textContent = t('sShare');
  }

  static requested(params) { return params.get('story'); }

  async load(id) {
    const coll = id.split('-')[0];
    const r = await fetch(`./stories/${coll}.json`);
    if (!r.ok) throw new Error(`${coll}: ${r.status}`);
    this.data = await r.json(); this.coll = coll;
    const pick = $('storyPick');
    pick.innerHTML = `<option value="" disabled>${t('sOther')}</option>` +
      this.data.stories.map(s => `<option value="${s.id}" title="${pickLang(s)}">${shortName(s)}</option>`).join('');
  }

  // Open a story by id (animate: fly there from the current view). Returns false if it does not exist.
  // `opts` (from the link) may set the view centre (lat, lon), distance d, heading az, elevation el and start year `from`.
  open(id, animate = false, opts = {}) {
    const s = this.data?.stories.find(x => x.id === id) ?? (id === this.coll ? this.data?.stories[0] : null);
    if (!s) { this.app.status(t('sNotFound', id), true); return false; }
    this.cur = s;
    const yrs = this.app.years();
    this.idx = (y) => { let i = yrs.findIndex(v => v >= y); return i < 0 ? yrs.length - 1 : i; };
    this.from = this.idx(Number.isFinite(opts.from) ? opts.from : Math.max(yrs[0], s.change[0] - LEAD));
    // slow through the clearing and for a year around each building's appearance (index positions on the timeline)
    this.slow = [[this.idx(s.change[0] - 1) - 0.5, this.idx(s.change[1] + 1)],
      ...[...new Set((s.buildings ?? []).map(b => b.year))].map(y => [this.idx(y) - 1, this.idx(y) + 0.3])];
    document.body.classList.add('story-mode');
    this.app.view(opts.lon ?? s.lon, opts.lat ?? s.lat, opts.d ?? s.d, opts.el ?? s.el, opts.az ?? s.az, animate);
    // wait for the detail around what the view shows: the site plus ~a third of the camera distance (at least 1.3 km)
    const xs = s.polygon.map(p => p[0]), ys = s.polygon.map(p => p[1]), pad = Math.max(1300, 0.35 * (opts.d ?? s.d)) / 111000;
    this.area = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
    this.ring = s.polygon.map(([lo, la]) => { const [x, , z] = this.app.ground(lo, la); return [x, z]; });
    this.outline(true);
    this.buildings(true);
    this.app.refreshCity();
    this.render();
    $('story').hidden = false; $('creditsStory').hidden = false;
    $('story').classList.remove('folded'); $('story').querySelector('button.fold')?.setAttribute('aria-expanded', 'true');
    $('storyPick').value = s.id;
    const u = new URL(location.href);                       // a link's own view stays in the address bar until a switch
    if (animate) for (const k of ['at', 'd', 'az', 'el', 'y', 'from']) u.searchParams.delete(k);
    u.searchParams.set('story', s.id);
    history.replaceState(null, '', u);
    this.waitForSite();
    return true;
  }

  close() {
    this.cur = null; this.ring = null; this.waiting = 0; this.unicorns.clear(); this.revCum = null; $('storyWait').hidden = true; $('story').hidden = true; $('creditsStory').hidden = true;
    this.clearBuildings(); this.app.refreshCity();
    document.body.classList.remove('story-mode'); this.app.layout();
    if (this.line) { this.app.scene.remove(this.line); this.line.geometry.dispose(); this.line = null; }
    const u = new URL(location.href); u.searchParams.delete('story'); history.replaceState(null, '', u);
  }

  replay(hold = HOLD_REPLAY) { this.holdUntil = performance.now() + hold; this.app.setYear(this.from, true); }

  // Hold on the start year with a progress pill until the site's detail tiles are loaded and trees are built on them.
  waitForSite() {
    this.waiting = performance.now(); this.readyAt = 0;
    this.app.setYear(this.from, true);
    $('storyWait').hidden = false;
  }
  #checkWait() {
    const p = this.app.siteProgress(this.area), el = $('storyWait');
    el.textContent = t('sLoading', p.done, p.total);
    if (p.done >= p.total && p.trees && !this.readyAt) this.readyAt = performance.now();
    // ready (plus a moment so the first frames with the new trees are drawn), or give up after 25 s
    if ((this.readyAt && performance.now() - this.readyAt > 400) || performance.now() - this.waiting > 25000) {
      this.waiting = 0; this.readyAt = 0; el.hidden = true;
      this.replay(HOLD_OPEN);
    }
  }

  async share() {
    // s/<id>/ is a static page with this story's preview image and title for social sites; it forwards here at once
    const u = new URL(`s/${this.cur.id}/`, location.origin + location.pathname.replace(/[^/]*$/, ''));
    const data = new URLSearchParams(location.search).get('data');
    if (data) u.searchParams.set('data', data);
    // the current view (centre if moved, distance, heading, tilt) and, before the end of the clearing, the start year
    const v = this.app.viewState(), s = this.cur;
    if (Math.hypot((v.lon - s.lon) * 101000, (v.lat - s.lat) * 111000) > 60) u.searchParams.set('at', `${v.lat.toFixed(5)},${v.lon.toFixed(5)}`);
    u.searchParams.set('d', String(Math.round(v.d)));
    u.searchParams.set('az', String(Math.round(v.az)));
    u.searchParams.set('el', String(Math.round(v.el)));
    if (v.year <= s.change[1]) u.searchParams.set('from', String(v.year));
    const url = u.toString().replace('%2C', ',');
    try { await navigator.clipboard.writeText(url); this.app.status(t('sCopied')); }
    catch { this.app.status(t('linkIs', url)); }
  }

  get active() { return !!this.cur; }
  speed(yearPos) {
    if (this.waiting) { this.#checkWait(); return 0; }
    if (performance.now() < this.holdUntil) return 0;
    return this.slow.some(([a, b]) => yearPos >= a && yearPos < b) ? SLOW : MID;
  }

  // Inside the open story's outline (world x/z)? Illustrative buildings are skipped there when it has real ones.
  excludes(x, z) {
    const r = this.ring;
    if (!r || !this.cur.buildings?.length) return false;
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if ((r[i][1] > z) !== (r[j][1] > z) && x < (r[j][0] - r[i][0]) * (z - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
    }
    return inside;
  }

  clearBuildings() {
    for (const b of this.blds) { this.app.scene.remove(b.mesh); b.mesh.geometry.dispose(); b.edges.geometry.dispose(); b.label?.remove(); }
    this.blds = [];
  }

  // Footprints extruded from just under the lowest ground at their corners to `h` above the highest (fab pads are
  // levelled; heights are real metres, the terrain is exaggerated). Rebuilt with the outline as detail tiles arrive.
  buildings(force = false) {
    this.clearBuildings();
    const list = this.cur.buildings ?? [];
    const labelled = new Set(list.filter(b => (lang === 'en' ? b.name_en : b.name) && b.area >= 6000).slice(0, 10).map(b => b.id));
    for (const b of list) {
      let ring = b.poly;
      if (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) ring = ring.slice(0, -1);
      const pts = ring.map(([lo, la]) => this.app.ground(lo, la));
      const ys = pts.map(p => p[1]), base = Math.min(...ys) - 2, top = Math.max(...ys) + b.h;
      const shape = new THREE.Shape(pts.map(([x, , z]) => new THREE.Vector2(x, -z)));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: top - base, bevelEnabled: false }).rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, b.construction ? this.shellMat : this.fabMat);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), b.construction ? this.shellEdge : this.edgeMat);
      mesh.add(edges); mesh.position.y = base; mesh.castShadow = !b.construction; mesh.receiveShadow = true;
      mesh.visible = false; mesh.renderOrder = b.construction ? 3 : 0;
      this.app.scene.add(mesh);
      let label = null;
      if (labelled.has(b.id)) {
        label = document.createElement('div'); label.className = 'blabel' + (b.construction ? ' building' : '');
        label.textContent = (lang === 'en' && b.name_en ? b.name_en : b.name.replace(/^台積電\s*|^TSMC\s*/i, '')) + (b.construction ? ` · ${t('sUnderConstruction')}` : '');
        this.labels.appendChild(label);
      }
      const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cz = pts.reduce((a, p) => a + p[2], 0) / pts.length;
      this.blds.push({ b, mesh, edges, label, top: new THREE.Vector3(cx, top + 6, cz) });
    }
  }

  // Estimated revenue (US$ bn) earned by the continuous year yf. Year Y is earned while the timeline shows Y
  // (yf in [Y - 0.5, Y + 0.5)), month by month when the estimate is monthly (r.months[i]: 12 values, US$ bn).
  revenueAt(yf) {
    const r = this.cur?.revenue;
    if (!r) return 0;
    let sum = 0;
    r.years.forEach((y, i) => {
      if (yf >= y + 0.5) { sum += r.usd[i]; return; }
      if (yf <= y - 0.5) return;
      const f = (yf - y + 0.5) * 12, m = r.months?.[i];
      if (!m) { sum += r.usd[i] * f / 12; return; }
      const mi = Math.min(11, Math.floor(f));
      for (let k = 0; k < mi; k++) sum += m[k];
      sum += m[mi] * (f - mi);
    });
    return sum;
  }

  // The month the continuous year yf is in: [year index, month 0-11]
  monthAt(yf) {
    const r = this.cur?.revenue, y = Math.round(yf), i = r ? r.years.indexOf(y) : -1;
    return [i, Math.max(0, Math.min(11, Math.floor((yf - y + 0.5) * 12)))];
  }

  // One unicorn per US$1 bn of estimated revenue: when the cumulative total passes the next billion while the
  // timeline plays forward, one flies out of a random standing fab roof (a jump back or a replay only resets the count).
  #unicorns(camera, yearF, dt) {
    const cum = this.revenueAt(yearF), k = Math.floor(cum);
    if (this.revCum === null || yearF < this.revYear || yearF - this.revYear > 1.5) this.revCum = k;
    const due = k - this.revCum;
    this.revCum = k; this.revYear = yearF;
    if (due > 0) {
      const roofs = this.blds.filter(o => o.mesh.visible && o.mesh.scale.y > 0.6 && !o.b.construction);
      for (let i = 0; i < Math.min(due, 8); i++) {
        let o;
        if (roofs.length) { const r = roofs[Math.floor(Math.random() * roofs.length)]; o = new THREE.Vector3(r.top.x, r.mesh.position.y + (r.top.y - r.mesh.position.y), r.top.z); }
        else { const c = this.cur, [x, y, z] = this.app.ground(c.lon, c.lat); o = new THREE.Vector3(x, y + 30, z); }
        this.unicorns.spawn(o, Math.max(8, camera.position.distanceTo(o) * 0.016));
      }
    }
    this.unicorns.update(dt, camera.position);
    const el = $('storyUni');
    if (el && this.cur?.revenue) el.textContent = k > 0 ? t('sUnicorns', k) : '';
    if (this.cur?.revenue) this.#revNow(yearF);
  }

  // The revenue readout for the month shown (estimate, its likely range, total so far) and the chart's marker.
  #revNow(yf) {
    const r = this.cur.revenue, [i, mo] = this.monthAt(yf), y = Math.round(yf), key = `${y}-${mo}-${lang}`;
    if (key === this.revShown) return;
    this.revShown = key;
    const f = this.revenueFmt, ann = i < 0 ? 0 : r.usd[i];
    const v = i < 0 ? 0 : r.months ? r.months[i][mo] : ann / 12, kLo = ann ? (r.lo?.[i] ?? ann) / ann : 1, kHi = ann ? (r.hi?.[i] ?? ann) / ann : 1;
    const when = new Date(Date.UTC(y, mo, 1)).toLocaleDateString(lang === 'zh' ? 'zh-TW' : 'en-US', { year: 'numeric', month: 'short', timeZone: 'UTC' });
    const cum = this.revenueAt(yf);                // no revenue that month: no readout (and no unicorns)
    // trees given up per unicorn: the measured canopy loss (reached across the clearing years) over unicorns so far
    const s = this.cur, ramp = Math.max(0, Math.min(1, (yf - s.change[0] + 0.5) / (s.change[1] - s.change[0] + 1)));
    const trees = Math.round(s.lost_ha * ramp * 10000 / TREE_M2 / 100) * 100, uni = Math.floor(cum);
    $('storyTrees').innerHTML = trees > 0 ? t('sTreesLost', trees.toLocaleString(), uni ? (trees / uni >= 10 ? Math.round(trees / uni) : (trees / uni).toFixed(1)) : null, TREE_M2) : '';
    $('storyRevNow').innerHTML = [v > 0 ? t('sRevNow', when, f(v), f(v * kLo), f(v * kHi)) : '', cum > 0 ? t('sRevCum', f(cum)) : ''].filter(Boolean).join(' · ');
    const rl = $('storyRevYear');
    if (rl) { const x = this.rxp(y - 0.5 + (mo + 0.5) / 12); rl.setAttribute('x1', x); rl.setAttribute('x2', x); }
  }

  // Every frame: grow buildings with the (continuous) year, place labels, fly unicorns.
  tick(camera, yearF, dt) {
    dt = Math.min(0.1, dt);
    if (!this.cur) { this.unicorns.update(dt, camera.position); return; }
    this.#unicorns(camera, yearF, dt);
    if (!this.blds.length) return;
    const v = new THREE.Vector3(), w = innerWidth, h = innerHeight, placed = [];
    const circles = this.unicorns.flying ? this.unicorns.screenCircles(camera, w, h) : [];
    for (const o of this.blds) {                   // largest first: a label overlapping one already placed is hidden
      const g = THREE.MathUtils.smoothstep(yearF, o.b.year - 0.8, o.b.year + 0.2);
      o.mesh.visible = g > 0.001; o.mesh.scale.y = Math.max(g, 0.001);
      if (!o.label) continue;
      v.copy(o.top); v.y = o.mesh.position.y + (o.top.y - o.mesh.position.y) * g; v.project(camera);
      let show = g > 0.6 && v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      const x = (v.x + 1) / 2 * w, y = (1 - v.y) / 2 * h, lw = (o.lw ??= o.label.offsetWidth || 80) / 2 + 3, lh = 22;
      if (show && placed.some(r => Math.abs(r[0] - x) < r[2] + lw && Math.abs(r[1] - y) < lh)) show = false;
      if (show) placed.push([x, y, lw]);
      o.label.hidden = !show;
      // unicorns fly above everything: a label one passes over fades out
      if (show) o.label.classList.toggle('under', circles.some(([cx, cy, r]) => Math.abs(cx - x) < lw + r && y - lh - r < cy && cy < y + r));
      if (show) o.label.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) translate(-50%, -100%)`;
    }
  }

  // Outline draped on the terrain, densified every ~25 m; redrawn when more detailed tiles arrive.
  outline(force = false) {
    const v = this.app.tilesVersion();
    if (!this.cur || (!force && v === this.drapedAt)) return;
    if (!force) this.buildings();
    this.drapedAt = v;
    const poly = this.cur.polygon, pts = [];
    for (let i = 0; i < poly.length - 1; i++) {
      const [lo0, la0] = poly[i], [lo1, la1] = poly[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot((lo1 - lo0) * 101000, (la1 - la0) * 111000) / 25));
      for (let k = 0; k < n; k++) pts.push(this.app.ground(lo0 + (lo1 - lo0) * k / n, la0 + (la1 - la0) * k / n));
    }
    pts.push(pts[0]);
    const g = new LineGeometry(); g.setPositions(pts.flatMap(([x, y, z]) => [x, y + 4, z]));
    if (this.line) { this.line.geometry.dispose(); this.line.geometry = g; this.line.computeLineDistances(); return; }
    this.line = new Line2(g, this.mat); this.line.computeLineDistances();
    this.line.renderOrder = 11; this.line.frustumCulled = false;
    this.app.scene.add(this.line);
  }

  render() {
    const s = this.cur;
    $('storyTitle').textContent = pickLang(s);
    $('storyPlace').textContent = `${pickLang(s, 'place')} · ${t('sArea', Math.round(s.ha))}`;
    $('storyCtx').textContent = pickLang(s, 'ctx');
    $('storySummary').innerHTML = t('sSummary', s.before[0], s.before[1], Math.round(s.site_before), s.after[0], s.after[1], Math.round(s.site_after), Math.round(s.lost_ha))
      + ' ' + t('sRingSummary', this.data.ring_m, Math.round(s.ring_before), Math.round(s.ring_after));
    $('storyNote').textContent = t('sNote');
    $('storySrc').innerHTML = s.src.length ? `${t('sSources')}: ` + s.src.map(u => `<a href="${u}" target="_blank" rel="noopener">${new URL(u).hostname.replace(/^www\./, '')}</a>`).join(' · ') : '';
    $('storyChart').setAttribute('aria-label', t('sChartAria'));
    $('storyLegend').innerHTML = `<span><i style="background:var(--loss)"></i>${t('sSite')}</span><span><i style="background:#8c8c86"></i>${t('sRing', this.data.ring_m)}</span>`
      + `<span><i style="background:#f6e3d3;height:8px;vertical-align:-1px"></i>${t('sLegendChange')}</span>`;
    this.chart();
    this.revChart();
  }

  // Estimated revenue bars (US$ bn per year) on the tree chart's years, with the likely range as a whisker.
  revChart() {
    const r = this.cur.revenue;
    $('storyRev').hidden = !r;
    this.revenueFmt = (v) => (lang === 'zh' ? Math.round(v * 10).toLocaleString() : v >= 10 ? Math.round(v).toLocaleString() : v.toFixed(1));
    if (!r) return;
    $('storyRevTitle').textContent = t('sRevTitle');
    $('storyRevNote').textContent = pickLang(r, 'note');
    const all = this.data.years, s = this.cur, W = 300, H = 64, pad = 4;
    const lo = Math.max(all[0], Math.min(s.change[0] - 15, all[all.length - 1] - 20)), hiY = all[all.length - 1];
    const xp = (y) => pad + (W - 2 * pad) * (y - lo) / (hiY - lo);
    const idx = r.years.map((y, i) => i).filter(i => r.years[i] >= lo && r.years[i] <= hiY);
    const top = Math.max(1, ...idx.map(i => Math.max(r.hi?.[i] ?? r.usd[i], r.months ? 12 * Math.max(...r.months[i]) : 0)));
    const yp = (v) => H - 10 - (H - 14) * v / top, bw = Math.max(1.5, (W - 2 * pad) / (hiY - lo + 1) * 0.66);
    $('storyRevChart').setAttribute('aria-label', t('sRevAria'));
    const mw = (W - 2 * pad) / (hiY - lo + 1) / 12;
    $('storyRevChart').innerHTML = idx.map(i => {
      const x = xp(r.years[i]), v = r.usd[i];
      if (r.months) {                          // monthly bars (heights in the yearly scale x 12) under the year's range
        const k12 = 12, band = r.hi ? `<rect x="${(x - 6 * mw).toFixed(1)}" y="${yp(r.hi[i]).toFixed(1)}" width="${(12 * mw).toFixed(1)}" height="${Math.max(0, yp(r.lo[i]) - yp(r.hi[i])).toFixed(1)}" fill="#e2b93b" fill-opacity="0.16"/>` : '';
        return band + r.months[i].map((m, k) => `<rect x="${(x + (k - 6) * mw).toFixed(2)}" y="${yp(m * k12).toFixed(1)}" width="${Math.max(0.4, mw * 0.8).toFixed(2)}" height="${Math.max(0, H - 10 - yp(m * k12)).toFixed(1)}" fill="#e2b93b"/>`).join('');
      }
      const whisk = r.hi ? `<line x1="${x}" x2="${x}" y1="${yp(r.hi[i])}" y2="${yp(r.lo[i])}" stroke="#c9a227" stroke-opacity="0.55" vector-effect="non-scaling-stroke"/>` : '';
      return `<rect x="${(x - bw / 2).toFixed(1)}" y="${yp(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, H - 10 - yp(v)).toFixed(1)}" fill="#e2b93b" rx="0.6"/>` + whisk;
    }).join('')
      + `<text x="${pad + 1}" y="8" font-size="8" fill="#999">${r.months ? t('sRevScaleMo', this.revenueFmt(top / 12)) : t('sRevScaleYr', this.revenueFmt(top))}</text>`
      + `<line x1="${pad}" x2="${W - pad}" y1="${H - 10}" y2="${H - 10}" stroke="#ccc" vector-effect="non-scaling-stroke"/>`
      + `<line id="storyRevYear" y1="0" y2="${H - 10}" stroke="#d9480f" stroke-width="1" vector-effect="non-scaling-stroke"/>`
      + `<text x="${pad}" y="${H - 1}" font-size="8" fill="#999">${lo}</text><text x="${W - pad}" y="${H - 1}" font-size="8" fill="#999" text-anchor="end">${hiY}</text>`;
    this.rxp = (y) => (y < lo ? -10 : xp(y)); this.revShown = '';
  }

  chart() {
    // the ~15 years before the change to today
    const s = this.cur, all = this.data.years, W = 300, H = 92, pad = 4;
    const lo = Math.max(all[0], Math.min(s.change[0] - 15, all[all.length - 1] - 20)), k0 = all.findIndex(y => y >= lo);
    const Y = all.slice(k0), site = s.site.slice(k0), ring = s.ring.slice(k0);
    const xp = (y) => pad + (W - 2 * pad) * (y - Y[0]) / (Y[Y.length - 1] - Y[0]), yp = (v) => H - pad - (H - 2 * pad) * v / 100;
    const path = (v) => v.map((x, i) => `${i ? 'L' : 'M'}${xp(Y[i]).toFixed(1)},${yp(x).toFixed(1)}`).join('');
    const x0 = xp(s.change[0] - 0.5), x1 = xp(s.change[1] + 0.5);
    $('storyChart').innerHTML = `<rect x="${x0}" y="0" width="${x1 - x0}" height="${H}" fill="#f6e3d3"/>`
      + [25, 50, 75].map(v => `<line x1="${pad}" x2="${W - pad}" y1="${yp(v)}" y2="${yp(v)}" stroke="#ddd" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>`).join('')
      + `<text x="${pad + 1}" y="${yp(50) - 2}" font-size="8" fill="#999">50%</text>`
      + `<path d="${path(ring)}" fill="none" stroke="#8c8c86" stroke-width="1.4" vector-effect="non-scaling-stroke"/>`
      + `<path d="${path(site)}" fill="none" stroke="#a8622d" stroke-width="2" vector-effect="non-scaling-stroke"/>`
      + `<line id="storyYear" y1="0" y2="${H}" stroke="#d9480f" stroke-width="1" vector-effect="non-scaling-stroke"/>`
      + `<text x="${pad}" y="${H - 1}" font-size="8" fill="#999">${Y[0]}</text><text x="${W - pad}" y="${H - 1}" font-size="8" fill="#999" text-anchor="end">${Y[Y.length - 1]}</text>`;
    this.xp = (y) => (y < Y[0] ? -10 : xp(y));
  }

  // Called whenever the shown year changes.
  update(year) {
    if (!this.cur) return;
    this.outline();
    const s = this.cur, i = this.data.years.indexOf(year);
    if (i < 0) return;
    const phase = year < s.change[0] ? 'Before' : year <= s.change[1] ? 'Change' : 'After';
    $('storyNow').innerHTML = `<div>${t('sNow', year)}<b>${Math.round(s.site[i])}%</b>${t('sSite')}</div>`
      + `<div>&nbsp;<b>${Math.round(s.ring[i])}%</b>${t('sRing', this.data.ring_m)}</div>`
      + `<span class="phase${phase === 'Change' ? ' change' : ''}">${t('sPhase' + phase)}</span>`;
    const l = $('storyYear'); if (l) { const x = this.xp(year); l.setAttribute('x1', x); l.setAttribute('x2', x); }
  }
}

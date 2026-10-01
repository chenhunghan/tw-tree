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
import { t, pickLang } from './i18n.js';

const $ = (id) => document.getElementById(id);
const SLOW = 0.45, FAST = 2.6;                 // years per second inside / outside the change window
const HOLD_OPEN = 3000, HOLD_REPLAY = 1200;   // ms on the first year before playing (read the card, let tiles arrive)

export class Story {
  // app: { scene, years(), ground(lon, lat) -> world [x, y, z], view(lon, lat, d, el, az, animate), setYear(i, play),
  //        status(msg, warn), tilesVersion(), layout() (story mode toggled), refreshCity() }
  constructor(app) {
    this.app = app; this.data = null; this.cur = null; this.line = null; this.drapedAt = -1; this.blds = []; this.ring = null;
    this.fabMat = new THREE.MeshLambertMaterial({ color: 0xd3d8db });
    this.shellMat = new THREE.MeshLambertMaterial({ color: 0xe0a46a, transparent: true, opacity: 0.38, depthWrite: false });
    this.edgeMat = new THREE.LineBasicMaterial({ color: 0x34424a, transparent: true, opacity: 0.85 });
    this.shellEdge = new THREE.LineBasicMaterial({ color: 0xb4632a, transparent: true, opacity: 0.85 });
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
      this.data.stories.map(s => `<option value="${s.id}">${pickLang(s)}</option>`).join('');
  }

  // Open a story by id (animate: fly there from the current view). Returns false if it does not exist.
  open(id, animate = false) {
    const s = this.data?.stories.find(x => x.id === id) ?? (id === this.coll ? this.data?.stories[0] : null);
    if (!s) { this.app.status(t('sNotFound', id), true); return false; }
    this.cur = s;
    const yrs = this.app.years();
    this.idx = (y) => { let i = yrs.findIndex(v => v >= y); return i < 0 ? yrs.length - 1 : i; };
    this.from = this.idx(Math.max(yrs[0], s.change[0] - 6));
    this.slow = [this.idx(s.change[0] - 2), this.idx(s.change[1] + 1)];
    document.body.classList.add('story-mode');
    this.app.view(s.lon, s.lat, s.d, s.el, s.az, animate);
    this.ring = s.polygon.map(([lo, la]) => { const [x, , z] = this.app.ground(lo, la); return [x, z]; });
    this.outline(true);
    this.buildings(true);
    this.app.refreshCity();
    this.render();
    $('story').hidden = false; $('creditsStory').hidden = false;
    $('storyPick').value = s.id;
    const u = new URL(location.href);
    for (const k of ['at', 'd', 'az', 'el', 'y']) u.searchParams.delete(k);
    u.searchParams.set('story', s.id);
    history.replaceState(null, '', u);
    this.replay(HOLD_OPEN);
    return true;
  }

  close() {
    this.cur = null; this.ring = null; $('story').hidden = true; $('creditsStory').hidden = true;
    this.clearBuildings(); this.app.refreshCity();
    document.body.classList.remove('story-mode'); this.app.layout();
    if (this.line) { this.app.scene.remove(this.line); this.line.geometry.dispose(); this.line = null; }
    const u = new URL(location.href); u.searchParams.delete('story'); history.replaceState(null, '', u);
  }

  replay(hold = HOLD_REPLAY) { this.holdUntil = performance.now() + hold; this.app.setYear(this.from, true); }

  async share() {
    const u = new URL(location.origin + location.pathname);
    const data = new URLSearchParams(location.search).get('data');
    if (data) u.searchParams.set('data', data);
    u.searchParams.set('story', this.cur.id);
    const url = u.toString();
    try { await navigator.clipboard.writeText(url); this.app.status(t('sCopied')); }
    catch { this.app.status(t('linkIs', url)); }
  }

  get active() { return !!this.cur; }
  speed(yearPos) {
    if (performance.now() < this.holdUntil) return 0;
    return yearPos >= this.slow[0] && yearPos < this.slow[1] ? SLOW : FAST;
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
    const labelled = new Set(list.filter(b => b.name && b.area >= 6000).slice(0, 10).map(b => b.id));
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
        label.textContent = b.name.replace(/^台積電\s*|^TSMC\s*/i, '') + (b.construction ? ` · ${t('sUnderConstruction')}` : '');
        this.labels.appendChild(label);
      }
      const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cz = pts.reduce((a, p) => a + p[2], 0) / pts.length;
      this.blds.push({ b, mesh, edges, label, top: new THREE.Vector3(cx, top + 6, cz) });
    }
  }

  // Every frame: grow buildings with the (continuous) year and place labels.
  tick(camera, yearF) {
    if (!this.cur || !this.blds.length) return;
    const v = new THREE.Vector3(), w = innerWidth, h = innerHeight;
    for (const o of this.blds) {
      const g = THREE.MathUtils.smoothstep(yearF, o.b.year - 0.8, o.b.year + 0.2);
      o.mesh.visible = g > 0.001; o.mesh.scale.y = Math.max(g, 0.001);
      if (!o.label) continue;
      v.copy(o.top); v.y = o.mesh.position.y + (o.top.y - o.mesh.position.y) * g; v.project(camera);
      const show = g > 0.6 && v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      o.label.hidden = !show;
      if (show) o.label.style.transform = `translate(${((v.x + 1) / 2 * w).toFixed(0)}px, ${((1 - v.y) / 2 * h).toFixed(0)}px) translate(-50%, -100%)`;
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

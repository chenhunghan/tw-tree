import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { HorizontalTiltShiftShader } from 'three/addons/shaders/HorizontalTiltShiftShader.js';
import { VerticalTiltShiftShader } from 'three/addons/shaders/VerticalTiltShiftShader.js';
import { DataSet, NODATA_F, NODATA_S } from './data.js';
import { lonLatToUtm, utmToLonLat, parseCoords, geocode } from './geo.js';
import { EXAG, DISPLAY_ZONE, prepareFilled, buildTerrain, setTerrainYears, makeTerrainMaterial, makeWaterMaterial, toWorld, worldToDisplayUtm } from './terrain.js';
import { Weather, PRESETS } from './weather.js';
import { Forest, NEAR_DIST } from './trees.js';
import { City } from './buildings.js';

const params = new URLSearchParams(location.search);
const HF = 'https://huggingface.co/datasets/chenhunghan/tw-tree/resolve/main/';
// Island data once enough of it is published (the export fills tiles north to south); the Taipei pilot until then.
const DATA_BASES = params.get('data') ? [params.get('data')] : [HF + 'taiwan/', HF + 'pilot/'];
const MIN_ISLAND_TILES = 150;
const YEARS_PER_SEC = 0.8;
const LOW_SCENES = 5;
const $ = (id) => document.getElementById(id);

// ---------- scene ----------
// Logarithmic depth: the view spans 5 m to 900 km, and water 4 m above the sea plane must not z-fight (flicker).
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
$('scene').appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(new THREE.Color(0xd6e3e6), 0.000032);
const camera = new THREE.PerspectiveCamera(34, innerWidth / innerHeight, 5, 900000);
const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.44;
controls.minDistance = 120;
controls.maxDistance = 420000;          // whole island
controls.zoomToCursor = true;

// Light: the weather module moves the sun (or moon) through the day and sets sky, fog and light colours.
const hemi = new THREE.HemisphereLight(0xd4e6f5, 0x4d5a3c, 1.05);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.8;
scene.add(sun, sun.target);
const weather = new Weather(scene);
const uniforms = { uT: { value: 0 }, uTime: { value: 0 }, uSunView: { value: new THREE.Vector3() }, uYearF: { value: 1984 }, ...weather.uniforms };
const sea = new THREE.Mesh(new THREE.PlaneGeometry(4000000, 4000000), makeWaterMaterial(uniforms));
sea.rotation.x = -Math.PI / 2; sea.position.y = -1.5; sea.receiveShadow = true;
scene.add(sea);

// Post-processing (as in lns-lab): MSAA half-float target, faint bloom, tilt-shift "miniature" blur, grade, output.
const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.12, 0.4, 0.92);
composer.addPass(bloom);
const tiltH = new ShaderPass(HorizontalTiltShiftShader), tiltV = new ShaderPass(VerticalTiltShiftShader);
tiltH.uniforms.r.value = tiltV.uniforms.r.value = 0.5;
composer.addPass(tiltH); composer.addPass(tiltV);
const grade = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uSat: { value: 1.12 }, uContrast: { value: 1.05 }, uVig: { value: 0.28 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uSat, uContrast, uVig; varying vec2 vUv;
    void main(){ vec4 c = texture2D(tDiffuse, vUv); float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, uSat); c.rgb = (c.rgb - 0.18) * uContrast + 0.18;
      float d = distance(vUv, vec2(0.5)); c.rgb *= 1.0 - uVig * smoothstep(0.35, 0.85, d);
      gl_FragColor = c; }`,
});
composer.addPass(grade);
composer.addPass(new OutputPass());
let miniature = true;
function setMiniature(on) {
  miniature = on; tiltH.enabled = tiltV.enabled = on;
  document.getElementById('tilt')?.classList.toggle('on', on);
}
function resize() {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setSize(w, h); composer.setSize(w, h); bloom.setSize(w, h);
  tiltH.uniforms.h.value = 3.2 / w; tiltV.uniforms.v.value = 3.2 / h;
}
resize();
const terrainMat = makeTerrainMaterial(uniforms);
const forest = new Forest(scene, uniforms);
const city = new City(scene, uniforms);
const terrain = [];                      // meshes that can be picked (detailed + overview)
const detail = new Map();                // tile key -> detailed mesh
const coarse = new Map();                // tile key -> overview mesh
let ds = new DataSet(DATA_BASES[0]);
let frame, years = [], yearPos = 0, playing = false, pairKey = '', streaming = false;
const EAGER_MAX = 40;                    // small datasets (the pilot) load every tile up front

// ---------- load ----------
async function openData() {
  for (const [n, base] of DATA_BASES.entries()) {
    ds = new DataSet(base);
    try {
      const index = await ds.init();
      const last = n === DATA_BASES.length - 1;
      if (last || index.complete !== false || index.tiles.length >= MIN_ISLAND_TILES) return index;
    } catch (err) { if (n === DATA_BASES.length - 1) throw err; }
  }
}

async function load() {
  const index = await openData();
  years = ds.years;
  const [w, s, e, n] = index.bbox_lonlat;
  const [ox, oy] = lonLatToUtm((w + e) / 2, (s + n) / 2, DISPLAY_ZONE);
  frame = { ox: Math.round(ox), oy: Math.round(oy) };
  const r2 = index.model?.metrics_vs_worldcover_holdout?.r2;
  if (r2) $('metricR2').textContent = `R² ≈ ${r2.toFixed(2)}`;
  if (index.name !== 'pilot') $('regionName').textContent = index.complete === false ? `全臺（製作中：${index.tiles.length}/${index.tiles_planned} 圖塊）`
    : index.normalisation ? '全臺' : '全臺（未正規化）';
  streaming = index.tiles.length > EAGER_MAX || params.has('stream');
  if (streaming) {
    $('loadMsg').textContent = '全島概觀…';
    if (await ds.loadOverview()) {
      for (const t of ds.overview.values()) prepareFilled(t, years);
      const look = (z, i, j) => ds.overview.get(`${z}_${i}_${j}`);
      for (const t of ds.overview.values()) {
        const m = buildTerrain(t, look, frame, terrainMat);
        m.position.y = -1.5;             // sits just under detailed tiles while both exist
        coarse.set(t.key, m); terrain.push(m); scene.add(m);
      }
    }
  } else {
    let done = 0;
    const queue = [...index.tiles];
    const worker = async () => {
      while (queue.length) {
        const tile = await ds.loadTile(queue.shift());
        prepareFilled(tile, years);
        done++;
        $('loadBar').style.width = `${(100 * done / index.tiles.length).toFixed(0)}%`;
        $('loadMsg').textContent = `${done} / ${index.tiles.length} 個圖塊`;
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    for (const tile of ds.tiles.values()) addDetail(tile);
  }
  computeStats(index);
  buildTimeline(index);
  buildMinimap();
  // start close enough to see trees, at a random place where tree cover changed; then autoplay
  const start = pickStart();
  if (start) viewAt(start);
  else {
    const span = Math.max(...index.tiles.map(t => Math.hypot(...toWorld(frame, t.zone, t.x0, t.y0, 0).filter((_, k) => k !== 1))));
    const d = streaming ? span * 1.9 : 20000;
    controls.target.set(0, 0, 0); camera.position.set(-d * 0.17, d * 0.62, d * 0.76);
  }
  controls.autoRotate = true; controls.autoRotateSpeed = 0.35;
  $('loading').style.opacity = 0;
  setTimeout(() => $('loading').remove(), 700);
  setYearPos(0);
  playing = true; updatePlayButton();
}

// A random land pixel with mid-range tree cover that changed over the timeline (full tiles, or the overview when
// streaming). Returns its native position, or null.
function pickStart() {
  const pool = streaming ? [...ds.overview.values()] : [...ds.tiles.values()];
  if (!pool.length) return null;
  const first = years[0], last = years[years.length - 1];
  let best = null, bestScore = -Infinity;
  for (let n = 0; n < 5000; n++) {
    const t = pool[Math.floor(Math.random() * pool.length)], k = Math.floor(Math.random() * t.z.length);
    if ((t.own && !t.own[k]) || (t.land && !t.land[k]) || t.z[k] <= 3) continue;
    const a = t.filled[first][k], b = t.filled[last][k], mean = (a + b) / 2;
    if (mean < 25 || mean > 90) continue;
    const score = Math.abs(a - b) + Math.random() * 12 - (t.z[k] > 900 ? 25 : 0);
    if (score > bestScore) { bestScore = score; best = [t, k]; }
    if (n > 800 && best) break;
  }
  if (!best) return null;
  const [t, k] = best, row = Math.floor(k / t.P), col = k % t.P;
  return { zone: t.zone, x: t.x0 + t.res * col + t.res / 2, y: t.y0 + t.P * t.res - t.res * row - t.res / 2, z: t.z[k] };
}
function startPose(p, dist = 1700, elevDeg = 33, azDeg = Math.random() * 360) {
  const [wx, wy, wz] = toWorld(frame, p.zone, p.x, p.y, p.z);
  const e = THREE.MathUtils.degToRad(elevDeg), a = THREE.MathUtils.degToRad(azDeg);
  const target = new THREE.Vector3(wx, wy, wz);
  return { target, cam: target.clone().add(new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)).multiplyScalar(dist)) };
}
function viewAt(p) { const { target, cam } = startPose(p); controls.target.copy(target); camera.position.copy(cam); lastFocus = null; }

const lookupDetail = (z, i, j) => ds.tiles.get(`${z}_${i}_${j}`);
function addDetail(tile) {
  const mesh = buildTerrain(tile, lookupDetail, frame, terrainMat);
  mesh.receiveShadow = true;
  if (pairKey) { const [a, b] = pairKey.split('_').map(Number); setTerrainYears(mesh, a, b); }
  detail.set(tile.key, mesh); terrain.push(mesh); scene.add(mesh);
  const cm = coarse.get(tile.key); if (cm) cm.visible = false;
}
function removeDetail(key) {
  const mesh = detail.get(key);
  if (!mesh) return;
  scene.remove(mesh); mesh.geometry.dispose();
  terrain.splice(terrain.indexOf(mesh), 1); detail.delete(key);
  const cm = coarse.get(key); if (cm) cm.visible = true;
}
// A tile's mesh borrows its east/south edge from neighbours; rebuild the west/north neighbours when one arrives.
function refreshNeighbours(tile) {
  for (const [di, dj] of [[-1, 0], [0, 1], [-1, 1]]) {
    const k = `${tile.zone}_${tile.i + di}_${tile.j + dj}`, t = ds.tiles.get(k);
    if (t && detail.has(k)) { removeDetail(k); addDetail(t); }
  }
}

// ---------- streaming (large datasets) ----------
// Full-resolution tiles load around the focus once the camera is close enough; far ones are evicted.
const STREAM_DIST = 30000, MAX_LOADED = 36, loading = new Set(), pending = new Map();
let lastStream = 0;
function streamTiles(now) {
  if (!streaming || now - lastStream < 400) return;
  lastStream = now;
  const dist = camera.position.distanceTo(controls.target);
  const R = THREE.MathUtils.clamp(dist * 0.9, 6000, 16000);
  const want = [];
  if (dist < STREAM_DIST) {
    for (const e of ds.entries.values()) {
      const [cx, , cz] = toWorld(frame, e.zone, e.x0 + ds.tileM / 2, e.y0 + ds.tileM / 2, 0);
      const dd = Math.hypot(cx - controls.target.x, cz - controls.target.z);
      if (dd < R + ds.tileM * 0.71) want.push([dd, e]);
    }
    want.sort((a, b) => a[0] - b[0]);
  }
  const keep = new Set(want.slice(0, MAX_LOADED).map(([, e]) => ds.key(e)));
  for (const k of [...ds.tiles.keys()]) {
    if (!keep.has(k) && ds.tiles.size > MAX_LOADED * 0.6) { removeDetail(k); ds.unloadTile(k); lastFocus = null; }
  }
  for (const [, e] of want) {
    const k = ds.key(e);
    if (loading.size >= 3) break;
    if (ds.tiles.has(k) || loading.has(k) || !keep.has(k)) continue;
    loading.add(k);
    ds.loadTile(e).then((tile) => {
      prepareFilled(tile, years);
      addDetail(tile); refreshNeighbours(tile);
      lastFocus = null;                          // trees can now be placed here
      pending.get(k)?.(); pending.delete(k);
    }).catch((err) => console.warn(err)).finally(() => loading.delete(k));
  }
}

// ---------- mini-map: the data itself (latest year), camera focus marker, click to fly ----------
const mini = { canvas: $('minimap'), scale: 1, x0: 0, z0: 0, base: null };
function buildMinimap() {
  const cv = mini.canvas;
  const cells = [];
  const add = (t, stepPx) => {
    const last = t.filled[years[years.length - 1]];
    for (let r = 0; r < t.P; r += stepPx) for (let c = 0; c < t.P; c += stepPx) {
      const k = r * t.P + c;
      if ((t.own && !t.own[k]) || (t.land && !t.land[k]) || (!t.land && t.z[k] <= 0)) continue;
      const [wx, , wz] = toWorld(frame, t.zone, t.x0 + t.res * (c + 0.5), t.y0 + t.P * t.res - t.res * (r + 0.5), 0);
      cells.push([wx, wz, last[k]]);
    }
  };
  if (ds.overview.size) for (const t of ds.overview.values()) add(t, 1);
  else for (const t of ds.tiles.values()) add(t, 8);
  if (!cells.length) { cv.hidden = true; return; }
  let xmin = Infinity, xmax = -Infinity, zmin = Infinity, zmax = -Infinity;
  for (const [x, z] of cells) { xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); }
  const W = 150, pad = 6, sc = (W - 2 * pad) / Math.max(xmax - xmin, (zmax - zmin) * 0.66);
  const H = Math.round((zmax - zmin) * sc + 2 * pad);
  const dpr = Math.min(devicePixelRatio, 2);
  cv.width = W * dpr; cv.height = H * dpr; cv.style.width = `${W}px`; cv.style.height = `${H}px`;
  Object.assign(mini, { scale: sc, x0: xmin - pad / sc, z0: zmin - pad / sc, dpr, W, H });
  const off = document.createElement('canvas'); off.width = cv.width; off.height = cv.height;
  const g = off.getContext('2d'); g.scale(dpr, dpr);
  const cell = Math.max(1.2, (ds.overview.size ? 480 : 240) * sc + 0.4);
  const ramp = (f) => { f /= 100; const a = [220, 212, 194], b = [163, 189, 120], c = [43, 106, 58];
    const m = f < 0.5 ? a.map((v, i) => v + (b[i] - v) * f * 2) : b.map((v, i) => v + (c[i] - v) * (f - 0.5) * 2);
    return `rgb(${m.map(Math.round).join(',')})`; };
  for (const [x, z, f] of cells) { g.fillStyle = ramp(f); g.fillRect((x - mini.x0) * sc - cell / 2, (z - mini.z0) * sc - cell / 2, cell, cell); }
  mini.base = off;
  cv.hidden = false;
  cv.onclick = (e) => {
    const r = cv.getBoundingClientRect();
    const wx = (e.clientX - r.left) / sc + mini.x0, wz = (e.clientY - r.top) / sc + mini.z0;
    const [X, Y] = worldToDisplayUtm(frame, wx, wz), [lon, lat] = utmToLonLat(X, Y, DISPLAY_ZONE);
    flyTo(lon, lat); pin.visible = false;
  };
}
function drawMinimap() {
  if (!mini.base) return;
  const g = mini.canvas.getContext('2d'), { dpr, scale: sc } = mini;
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, mini.canvas.width, mini.canvas.height); g.drawImage(mini.base, 0, 0);
  g.scale(dpr, dpr);
  const x = (controls.target.x - mini.x0) * sc, z = (controls.target.z - mini.z0) * sc;
  const d = camera.position.distanceTo(controls.target), rad = Math.max(3, d * 0.6 * sc);
  g.strokeStyle = '#d9480f'; g.lineWidth = 1.5; g.beginPath(); g.arc(x, z, rad, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#d9480f'; g.beginPath(); g.arc(x, z, 2.5, 0, Math.PI * 2); g.fill();
}

// ---------- stats ----------
let areaByYear = {};
function computeStats(index) {
  const px_ha = (ds.res * ds.res) / 1e4;
  $('statBaseYear').textContent = years[0];
  if (index.totals) {
    for (const y of years) areaByYear[y] = index.totals[y].filled_tree_ha;
    if (index.totals[years[0]].built_ha !== undefined) buildTrend(index);
    return;
  }
  for (const y of years) {
    let sum = 0;
    for (const t of ds.tiles.values()) { const a = t.filled[y]; for (let k = 0; k < a.length; k++) sum += a[k]; }
    areaByYear[y] = sum / 100 * px_ha;
  }
  $('statBaseYear').textContent = years[0];
}

// Island totals: tree canopy (gap-filled) and built-up area (GISA first-built year) per year, each on its own scale.
function buildTrend(index) {
  const T = years.map(y => index.totals[y].filled_tree_ha), B = years.map(y => index.totals[y].built_ha);
  const W = 300, H = 46, pad = 3, xp = (i) => pad + (W - 2 * pad) * i / (years.length - 1);
  const line = (v, color) => {
    const lo = Math.min(...v), hi = Math.max(...v), yp = (x) => H - pad - (H - 2 * pad) * (hi > lo ? (x - lo) / (hi - lo) : 0.5);
    return `<polyline fill="none" stroke="${color}" stroke-width="1.8" vector-effect="non-scaling-stroke" points="${v.map((x, i) => `${xp(i).toFixed(1)},${yp(x).toFixed(1)}`).join(' ')}"/>`;
  };
  $('trend').innerHTML = line(B, '#8c8c86') + line(T, '#2b6a3a') + `<line id="trendNow" y1="0" y2="${H}" stroke="#d9480f" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  const k = (v) => `${Math.round(Math.min(...v) / 1000)}k–${Math.round(Math.max(...v) / 1000)}k 公頃`;
  $('trendTree').textContent = k(T); $('trendBuilt').textContent = k(B);
  $('trendBox').hidden = false; $('statBuiltBox').hidden = false;
  trend = { xp, B };
}
let trend = null;

function updateStats(year) {
  const a = areaByYear[year], a0 = areaByYear[years[0]];
  $('statArea').textContent = `${Math.round(a).toLocaleString()} 公頃`;
  const d = a - a0, el = $('statDelta');
  el.textContent = `${d >= 0 ? '+' : '−'}${Math.abs(Math.round(d)).toLocaleString()} 公頃`;
  el.className = d < 0 ? 'down' : 'up';
  const nScenes = ds.index.scenes_per_year_region[year];
  $('statScenes').textContent = `${nScenes} 景${nScenes < LOW_SCENES ? '（低信心）' : ''}`;
  if (trend) {
    const i = years.indexOf(year), x = trend.xp(i);
    $('trendNow').setAttribute('x1', x); $('trendNow').setAttribute('x2', x);
    $('statBuilt').textContent = `${Math.round(trend.B[i]).toLocaleString()} 公頃`;
  }
}

// ---------- timeline ----------
function buildTimeline(index) {
  const bars = $('bars'), ticks = $('ticks');
  const max = Math.max(...years.map(y => index.scenes_per_year_region[y]));
  let lastLabel = -9;
  years.forEach((y, i) => {
    const n = index.scenes_per_year_region[y];
    const b = document.createElement('span');
    b.style.height = `${Math.max(10, 100 * n / max)}%`;
    b.title = `${y}：${n} 景`;
    if (n < LOW_SCENES) b.className = 'low';
    const gapBefore = i > 0 && y - years[i - 1] > 1;
    if (gapBefore) {                      // missing years: dashed divider on the bar row
      const miss = `${years[i - 1] + 1}${y - years[i - 1] > 2 ? '–' + (y - 1) : ''}`;
      b.style.borderLeft = '2px dashed #a8622d'; b.title += `（${miss} 無資料）`;
    }
    bars.appendChild(b);
    const last = i === years.length - 1;
    if ((i === 0 || last || y % 5 === 0) && (i - lastLabel >= 3 || last) && (last || years.length - 1 - i >= 3)) {
      const t = document.createElement('span');
      t.style.left = `${100 * i / (years.length - 1)}%`;
      t.textContent = y;
      ticks.appendChild(t);
      lastLabel = i;
    }
  });
}

function setYearPos(p) {
  yearPos = Math.max(0, Math.min(years.length - 1, p));
  let k = Math.floor(yearPos), t = yearPos - k;
  if (k >= years.length - 1) { k = years.length - 2; t = 1; }
  const yA = years[k], yB = years[k + 1], key = `${yA}_${yB}`;
  if (key !== pairKey) {
    pairKey = key;
    for (const m of terrain) setTerrainYears(m, yA, yB);
    forest.setYears(yA, yB);
  }
  uniforms.uT.value = t;
  uniforms.uYearF.value = yA + (yB - yA) * t;          // continuous year: buildings rise as the timeline passes
  const shown = years[Math.round(yearPos)];
  $('yearLabel').textContent = shown;
  $('slider').value = yearPos / (years.length - 1);
  updateStats(shown);
  if (selected) renderInfo();
}

function updatePlayButton() { $('play').textContent = playing ? '❚❚' : '▶'; }
$('play').onclick = () => {
  if (!playing && yearPos >= years.length - 1) setYearPos(0);
  playing = !playing; updatePlayButton();
};
$('slider').addEventListener('input', (e) => { playing = false; updatePlayButton(); setYearPos(+e.target.value * (years.length - 1)); });
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
  if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
    playing = false; updatePlayButton();
    setYearPos(Math.round(yearPos) + (e.code === 'ArrowRight' ? 1 : -1));
  }
});
controls.addEventListener('start', () => { controls.autoRotate = false; });

// ---------- tree level of detail + sun ----------
// Trees exist within `radius` of the focus; detailed geometry within NEAR_DIST of the camera. Rebuild when idle
// after the view has changed enough (focus, zoom or camera position).
let lastFocus = null, lastRadius = 0, lastCam = null, lastMove = 0, shadowSize = 0;
// Only user input counts as "moving": autorotation must not keep the trees from being built.
let userDragging = false;
controls.addEventListener('start', () => { userDragging = true; lastMove = performance.now(); });
controls.addEventListener('end', () => { userDragging = false; lastMove = performance.now(); });
controls.addEventListener('change', () => { if (userDragging || fly) lastMove = performance.now(); });
function updateTrees() {
  if (!years.length) return;
  const dist = camera.position.distanceTo(controls.target);
  if (dist > 14000) { forest.visible = false; city.visible = false; return; }
  forest.visible = true; city.visible = true;
  const radius = THREE.MathUtils.clamp(dist * 0.75, 700, 2400);
  const moved = !lastFocus || lastFocus.distanceTo(controls.target) > radius * 0.3 ||
    Math.abs(radius - lastRadius) / lastRadius > 0.35 || lastCam.distanceTo(camera.position) > Math.max(150, dist * 0.2);
  if (moved && performance.now() - lastMove > 200) {
    lastFocus = controls.target.clone(); lastRadius = radius; lastCam = camera.position.clone();
    forest.build(ds, frame, lastFocus, radius, years, lastCam);
    city.build(ds, frame, lastFocus, radius * 1.3);
    const k = Math.min(Math.floor(yearPos), years.length - 2);
    forest.setYears(years[k], years[k + 1]);
  }
}

function updateSun() {
  const dist = camera.position.distanceTo(controls.target);
  const S = THREE.MathUtils.clamp(dist * 0.8, 400, 1800);
  sun.target.position.copy(controls.target);
  sun.position.copy(controls.target).addScaledVector(weather.lightDir, 6000);
  sun.castShadow = dist < 14000;
  if (Math.abs(S - shadowSize) / S > 0.1) {
    Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 100, far: 14000 });
    sun.shadow.camera.updateProjectionMatrix();
    shadowSize = S;
  }
  // leaf translucency toward the sun, daytime only
  uniforms.uSunView.value.copy(weather.sunDir).transformDirection(camera.matrixWorldInverse).multiplyScalar(weather.uniforms.uDay.value);
}

// ---------- picking & info ----------
const ray = new THREE.Raycaster();
const marker = new THREE.Mesh(new THREE.RingGeometry(9, 15, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xd9480f, depthTest: false, transparent: true }));
marker.renderOrder = 10; marker.visible = false; scene.add(marker);
let selected = null, downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(terrain.filter(m => m.visible), false)[0];
  if (hit) selectWorld(hit.point.x, hit.point.z);
});

// Zone 51 takes precedence where tiles of both zones cover a location (the `own` flag encodes the same rule).
function displayToZones(X, Y) {
  const [lon, lat] = utmToLonLat(X, Y, DISPLAY_ZONE);
  return [[DISPLAY_ZONE, X, Y], ...[50].map(z => [z, ...lonLatToUtm(lon, lat, z)])];
}
function locateDisplay(X, Y) {
  for (const [z, x, y] of displayToZones(X, Y)) { const loc = ds.locate(z, x, y); if (loc) return loc; }
  return null;
}
function entryDisplay(X, Y) {
  for (const [z, x, y] of displayToZones(X, Y)) { const e = ds.entryAt(z, x, y); if (e) return e; }
  return null;
}
function groundDisplay(X, Y) {           // elevation from the full tile if loaded, else the overview cell
  const loc = locateDisplay(X, Y);
  if (loc) return loc.tile.z[loc.k];
  for (const [z, x, y] of displayToZones(X, Y)) { const c = ds.locateCoarse(z, x, y); if (c) return c.tile.z[c.k]; }
  return 0;
}

function selectWorld(wx, wz) {
  const [X, Y] = worldToDisplayUtm(frame, wx, wz);
  const loc = locateDisplay(X, Y);
  if (!loc) {                                   // tile not loaded yet: select once it arrives
    const e = entryDisplay(X, Y);
    if (e && streaming) pending.set(ds.key(e), () => selectWorld(wx, wz));
    return;
  }
  selected = loc;
  const { tile, k } = loc;
  const [mx, my, mz] = toWorld(frame, tile.zone, tile.x[k], tile.y[k], tile.z[k]);
  marker.position.set(mx, my + 2, mz); marker.visible = true;
  $('info').hidden = false;
  renderInfo();
  ds.loadProv(tile).then(() => renderInfo());
}

function renderInfo() {
  const { tile, k } = selected, year = years[Math.round(yearPos)];
  const x = tile.x[k], y = tile.y[k], [lon, lat] = utmToLonLat(x, y, tile.zone);
  const f = tile.f[year][k];
  const prov = ds.prov.get(tile.key);
  let src = '<span class="note">讀取來源中…</span>';
  if (prov) {
    const s = prov.s[year][k], n = prov.n[year][k];
    src = s === NODATA_S ? '當年無清晰觀測' : `<code>${prov.meta.scenes[year][s]}</code><br><span class="note">當年清晰觀測 ${n} 日；原始像元：col = (${x} − 15 − ulx) / 30，row = (uly − ${y} − 15) / 30</span>`;
  }
  $('infoBody').innerHTML = `
    <dl>
      <dt>年份</dt><dd>${year}</dd>
      <dt>樹冠比例</dt><dd><b>${f === NODATA_F ? '無觀測' : f + '%'}</b></dd>
      <dt>經緯度</dt><dd>${lat.toFixed(6)}, ${lon.toFixed(6)}</dd>
      <dt>像元中心</dt><dd>x ${x}, y ${y}<br><span class="note">EPSG:${32600 + tile.zone}（Landsat 原始格網）</span></dd>
      <dt>高度</dt><dd>${tile.z[k]} 公尺</dd>
      ${tile.built ? `<dt>建成</dt><dd>${tile.built[k] ? (tile.built[k] === 72 ? '1972 年以前' : tile.built[k] === 78 ? '1978–1984 年' : `${1900 + tile.built[k]} 年`) + `（GISA）<br><span class="note">建成面積約 ${tile.bs[k]}%、建物高度約 ${tile.bh[k]} 公尺（GHSL 2018）</span>` : '2021 年前未建成（GISA）'}</dd>` : ''}
      <dt>來源影像</dt><dd>${src}</dd>
    </dl>
    ${sparkline(tile, k, year)}
    <div class="note">折線：各年樹冠比例；空缺為當年無清晰觀測。</div>`;
}

function sparkline(tile, k, cur) {
  const W = 290, H = 70, pad = 6, n = years.length;
  const xp = (i) => pad + (W - 2 * pad) * i / (n - 1), yp = (v) => H - pad - (H - 2 * pad) * v / 100;
  let d = '', pen = false, dots = '';
  years.forEach((y, i) => {
    const v = tile.f[y][k];
    if (v === NODATA_F) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${xp(i).toFixed(1)},${yp(v).toFixed(1)}`; pen = true;
    if (y === cur) dots = `<circle cx="${xp(i)}" cy="${yp(v)}" r="3.5" fill="#d9480f"/>`;
  });
  return `<svg id="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="樹冠比例時間序列">
    <line x1="${pad}" x2="${W - pad}" y1="${yp(50)}" y2="${yp(50)}" stroke="#ccc" stroke-dasharray="3 3"/>
    <path d="${d}" fill="none" stroke="#2b6a3a" stroke-width="1.6"/>${dots}</svg>`;
}
$('infoClose').onclick = () => { $('info').hidden = true; marker.visible = false; selected = null; };

// ---------- search ----------
const pin = new THREE.Group();
{
  const m = new THREE.MeshLambertMaterial({ color: 0xd9480f });
  pin.add(new THREE.Mesh(new THREE.ConeGeometry(14, 60, 12).rotateX(Math.PI).translate(0, 30, 0), m));
  pin.add(new THREE.Mesh(new THREE.SphereGeometry(20, 16, 12).translate(0, 68, 0), m));
  pin.visible = false; scene.add(pin);
}
let fly = null;
function flyTo(lon, lat, label) {
  const [X, Y] = lonLatToUtm(lon, lat, DISPLAY_ZONE);
  const inside = !!entryDisplay(X, Y);
  const [wx, wy, wz] = toWorld(frame, DISPLAY_ZONE, X, Y, groundDisplay(X, Y));
  pin.position.set(wx, wy, wz); pin.visible = true;
  const to = new THREE.Vector3(wx, wy, wz);
  const dir = camera.position.clone().sub(controls.target).normalize();
  const camTo = to.clone().add(dir.multiplyScalar(1000));
  camTo.y = Math.max(camTo.y, wy + 380);
  fly = { t0: performance.now(), dur: 1800, fromT: controls.target.clone(), fromC: camera.position.clone(), toT: to, toC: camTo };
  controls.autoRotate = false;
  if (inside) selectWorld(wx, wz);
  return inside;
}

function status(msg, warn = false) { const el = $('searchStatus'); el.textContent = msg; el.className = warn ? 'warn' : ''; }
const outside = () => ds.index?.name === 'pilot' ? '此位置超出目前資料範圍（臺北試行版），全臺資料製作中。' : '此位置不在資料範圍內（臺灣本島、澎湖、金門、馬祖）或該圖塊尚未完成。';

$('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (!q) return;
  const c = parseCoords(q);
  if (c) {
    const inside = flyTo(c[0], c[1]);
    status(inside ? `座標 ${c[1].toFixed(5)}, ${c[0].toFixed(5)}` : outside(), !inside);
    return;
  }
  status('搜尋中…（OpenStreetMap Nominatim）');
  try {
    const r = await geocode(q);
    if (!r) { status('找不到這個地點，試試地標、路名或行政區。', true); return; }
    const inside = flyTo(r.lon, r.lat);
    const precision = r.exact ? '' : `（找不到完整地址，已定位到「${r.query}」的${r.level}層級）`;
    status(inside ? `${r.label.split(',').slice(0, 3).join('，')}${precision}` : outside(), !inside || !r.exact);
  } catch (err) {
    status(`地址搜尋失敗：${err.message}`, true);
  }
});

$('gps').onclick = () => {
  if (!navigator.geolocation) { status('這個瀏覽器不支援定位。', true); return; }
  status('取得裝置位置中…');
  navigator.geolocation.getCurrentPosition(
    (p) => { const inside = flyTo(p.coords.longitude, p.coords.latitude); status(inside ? `你的位置（精度約 ${Math.round(p.coords.accuracy)} 公尺）` : outside(), !inside); },
    (err) => status(`無法取得位置：${err.message}`, true), { enableHighAccuracy: true, timeout: 10000 });
};

$('aboutBtn').onclick = () => $('about').showModal();
$('randomBtn').onclick = () => {
  const p = pickStart();
  if (!p) return;
  const { target, cam } = startPose(p);
  fly = { t0: performance.now(), dur: 2200, fromT: controls.target.clone(), fromC: camera.position.clone(), toT: target, toC: cam };
  controls.autoRotate = true;
  const [lon, lat] = utmToLonLat(p.x, p.y, p.zone);
  status(`隨機地點 ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
};

// ---------- weather controls (decorative) ----------
for (const b of document.querySelectorAll('[data-wx]')) {
  b.onclick = () => { weather.setPreset(b.dataset.wx); syncWeatherUi(); };
}
$('hour').addEventListener('input', (e) => { weather.auto = false; weather.setHour(+e.target.value); syncWeatherUi(); });
$('autoTime').onclick = () => { weather.auto = !weather.auto; syncWeatherUi(); };
function syncWeatherUi() {
  for (const b of document.querySelectorAll('[data-wx]')) b.classList.toggle('on', b.dataset.wx === weather.preset);
  $('autoTime').classList.toggle('on', weather.auto);
  $('hour').value = weather.hour; $('hourVal').textContent = weather.label;
}
{
  const presets = Object.keys(PRESETS);
  weather.setPreset(params.get('weather') in PRESETS ? params.get('weather') : presets[Math.random() < 0.6 ? 0 : Math.random() < 0.7 ? 1 : 2]);
  weather.setHour(params.has('hour') ? +params.get('hour') : 6.5 + Math.random() * 9);
  weather.cur = { ...PRESETS[weather.preset] };
  syncWeatherUi();
}
$('tilt').onclick = () => setMiniature(!miniature);

// Field of view as a dolly zoom: keep the focus framed the same, change only the perspective.
function setFov(deg, keepFraming = true) {
  const old = camera.fov;
  camera.fov = deg; camera.updateProjectionMatrix();
  if (keepFraming) {
    const k = Math.tan(THREE.MathUtils.degToRad(old / 2)) / Math.tan(THREE.MathUtils.degToRad(deg / 2));
    const off = camera.position.clone().sub(controls.target);
    const d = THREE.MathUtils.clamp(off.length() * k, controls.minDistance, controls.maxDistance);
    camera.position.copy(controls.target).add(off.setLength(d));
    lastMove = performance.now();
  }
  $('fov').value = deg; $('fovVal').textContent = `${deg}°`;
  try { localStorage.setItem('tpetree.fov', String(deg)); } catch {}
}
$('fov').addEventListener('input', (e) => setFov(+e.target.value));
try { const saved = +localStorage.getItem('tpetree.fov'); if (saved >= 15 && saved <= 75) setFov(saved, false); } catch {}
addEventListener('keydown', (e) => { if (e.target.tagName !== 'INPUT' && (e.key === 'm' || e.key === 'M')) setMiniature(!miniature); });
setMiniature(true);
$('aboutClose').onclick = () => $('about').close();

// ---------- loop ----------
addEventListener('resize', resize);
let last = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  step(dt, now);
  composer.render(dt);
  requestAnimationFrame(tick);
}
function step(dt, now = performance.now()) {
  if (playing && years.length) {
    setYearPos(yearPos + dt * YEARS_PER_SEC);
    if (yearPos >= years.length - 1) { playing = false; updatePlayButton(); }
  }
  if (fly) {
    const t = Math.min(1, (now - fly.t0) / fly.dur), e = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    controls.target.lerpVectors(fly.fromT, fly.toT, e);
    camera.position.lerpVectors(fly.fromC, fly.toC, e);
    if (t >= 1) fly = null;
  }
  controls.update();
  const dist = camera.position.distanceTo(controls.target);
  scene.fog.density = 0.000032 * THREE.MathUtils.clamp(18000 / dist, 0.04, 1);   // thin the haze for the island view
  const near = THREE.MathUtils.clamp(dist * 0.002, 5, 400);
  if (Math.abs(near - camera.near) / camera.near > 0.2) { camera.near = near; camera.far = Math.max(150000, dist * 5); camera.updateProjectionMatrix(); }
  weather.update(dt, camera, controls.target, dist, { sun, hemi, fog: scene.fog });
  camera.updateMatrixWorld();
  streamTiles(now);
  uniforms.uTime.value = now / 1000;
  updateSun();
  updateTrees();
  if (Math.floor(now / 100) !== Math.floor((now - dt * 1000) / 100)) drawMinimap();
  if (weather.auto && Math.floor(now / 250) !== Math.floor((now - dt * 1000) / 250)) { $('hour').value = weather.hour; $('hourVal').textContent = weather.label; }
  pin.scale.setScalar(Math.max(1, camera.position.distanceTo(pin.position) / 2500));
}

// Testing hook: step without requestAnimationFrame (headless screenshots).
window.__app = {
  setYear: (y) => { playing = false; updatePlayButton(); setYearPos(years.indexOf(y)); },
  advance: (sec) => { for (let i = 0; i < sec * 30; i++) step(1 / 30); composer.render(); },
  setMiniature, setFov, weather,
  flyTo, get trees() { return forest.count; }, get buildings() { return city.n; }, get treeStats() { return { ...forest.stats, triangles: Math.round(forest.triangles) }; },
  renderInfo: () => renderer.info.render,
  view: (lon, lat, dist, elevDeg, azDeg = 200) => {       // test hook: place the camera directly
    const [X, Y] = lonLatToUtm(lon, lat, DISPLAY_ZONE);
    const [wx, wy, wz] = toWorld(frame, DISPLAY_ZONE, X, Y, groundDisplay(X, Y));
    const e = THREE.MathUtils.degToRad(elevDeg), a = THREE.MathUtils.degToRad(azDeg);
    controls.target.set(wx, wy, wz); controls.autoRotate = false;
    camera.position.set(wx + Math.sin(a) * Math.cos(e) * dist, wy + Math.sin(e) * dist, wz + Math.cos(a) * Math.cos(e) * dist);
    lastMove = 0; controls.update();
  }, get ready() { return terrain.length > 0; }, get loaded() { return { tiles: ds.tiles.size, loading: loading.size, coarse: coarse.size }; },
};

requestAnimationFrame(tick);
load().catch((err) => { $('loadMsg').textContent = `載入失敗：${err.message}`; console.error(err); });

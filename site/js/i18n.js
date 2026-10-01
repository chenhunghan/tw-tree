// UI language: ?lang=zh|en, else the choice saved by the language button, else the browser's preferred languages
// (navigator.languages; any zh-* -> Traditional Chinese, en-* -> English), else English. Shared links carry no
// language, so each viewer gets their own.
const SUPPORTED = ['zh', 'en'];
const norm = (l) => (/^zh\b/i.test(l || '') ? 'zh' : /^en\b/i.test(l || '') ? 'en' : null);

function pick() {
  const q = norm(new URLSearchParams(location.search).get('lang'));
  if (q) return q;
  try { const s = localStorage.getItem('tpetree.lang'); if (SUPPORTED.includes(s)) return s; } catch {}
  for (const l of navigator.languages?.length ? navigator.languages : [navigator.language]) { const n = norm(l); if (n) return n; }
  return 'en';
}
export const lang = pick();

const ZH = {
  title: '臺灣樹冠時光機',
  regionBuilding: (n, m) => `全臺（製作中：${n}/${m} 圖塊）`, regionAll: '全臺', regionRaw: '全臺（未正規化）',
  loadOverview: '全島概觀…', loadTiles: (d, n) => `${d} / ${n} 個圖塊`, loadFail: (m) => `載入失敗：${m}`,
  ha: (n) => `${n} 公頃`, haRange: (a, b) => `${a}k–${b}k 公頃`,
  scenes: (n, low) => `${n} 景${low ? '（低信心）' : ''}`, barTitle: (y, n) => `${y}：${n} 景`, barMissing: (m) => `（${m} 無資料）`,
  iYear: '年份', iFrac: '樹冠比例', iNoObs: '無觀測', iLonLat: '經緯度', iPixel: '像元中心', iGrid: 'Landsat 原始格網',
  iElev: '高度', iM: (m) => `${m} 公尺`, iBuilt: '建成', iBuilt72: '1972 年以前', iBuilt78: '1978–1984 年', iBuiltYear: (y) => `${y} 年`,
  iBuiltNote: (bs, bh) => `建成面積約 ${bs}%、建物高度約 ${bh} 公尺（GHSL 2018）`, iNotBuilt: '2021 年前未建成（GISA）',
  iSource: '來源影像', iSrcLoading: '讀取來源中…', iSrcNone: '當年無清晰觀測',
  iSrcNote: (n, x, y) => `當年清晰觀測 ${n} 日；原始像元：col = (${x} − 15 − ulx) / 30，row = (uly − ${y} − 15) / 30`,
  iSpark: '折線：各年樹冠比例；空缺為當年無清晰觀測。', iSparkAria: '樹冠比例時間序列',
  outsidePilot: '此位置超出目前資料範圍（臺北試行版），全臺資料製作中。',
  outside: '此位置不在資料範圍內（臺灣本島、澎湖、金門、馬祖）或該圖塊尚未完成。',
  coords: (la, lo) => `座標 ${la}, ${lo}`, searching: '搜尋中…（OpenStreetMap Nominatim）',
  notFound: '找不到這個地點，試試地標、路名或行政區。', precision: (q, lv) => `（找不到完整地址，已定位到「${q}」的${lv}層級）`,
  searchFail: (m) => `地址搜尋失敗：${m}`, noGeo: '這個瀏覽器不支援定位。', locating: '取得裝置位置中…',
  yourPos: (a) => `你的位置（精度約 ${a} 公尺）`, geoFail: (m) => `無法取得位置：${m}`,
  shared: (la, lo) => `分享的位置 ${la}, ${lo}`, copied: '已複製這個視角的連結。', linkIs: (u) => `連結：${u}`,
  random: (la, lo) => `隨機地點 ${la}, ${lo}`, listSep: '，',
  // story card
  sSite: '廠區', sRing: (m) => `周邊 ${m} 公尺`, sNow: (y) => `${y} 年`, sArea: (ha) => `廠區約 ${ha} 公頃`,
  sPhaseBefore: '開發前', sPhaseChange: '開發中', sPhaseAfter: '開發後',
  sSummary: (b0, b1, sb, a0, a1, sa, lost) => `${b0}–${b1} 年平均樹冠 <b>${sb}%</b>，${a0 === a1 ? a0 : `${a0}–${a1}`} 年 <b>${sa}%</b>，約少了 <b>${lost} 公頃</b>樹冠。`,
  sRingSummary: (m, rb, ra) => `同期周邊 ${m} 公尺環帶：${rb}% → ${ra}%。`,
  sReplay: '重播', sOther: '其他台積電廠區', sClose: '關閉', sShare: '分享這個故事',
  sNote: '數值為 30 公尺 Landsat 像元的樹冠比例估計，單一年份可能有數個百分點的雜訊；廠區範圍 © OpenStreetMap 貢獻者（ODbL）。',
  sSources: '時間資料來源', sChartAria: '廠區與周邊的樹冠比例', sCopied: '已複製故事連結。',
  sNotFound: (id) => `找不到故事「${id}」。`, sLegendChange: '開發期間',
  langBtn: 'EN', langTitle: 'Switch to English',
};

const EN = {
  title: 'Taiwan Tree-Cover Time Machine',
  regionBuilding: (n, m) => `all Taiwan (building: ${n}/${m} tiles)`, regionAll: 'all Taiwan', regionRaw: 'all Taiwan (not normalised)',
  loadOverview: 'Island overview…', loadTiles: (d, n) => `${d} / ${n} tiles`, loadFail: (m) => `Failed to load: ${m}`,
  ha: (n) => `${n} ha`, haRange: (a, b) => `${a}k–${b}k ha`,
  scenes: (n, low) => `${n} scenes${low ? ' (low confidence)' : ''}`, barTitle: (y, n) => `${y}: ${n} scenes`, barMissing: (m) => ` (${m}: no data)`,
  iYear: 'Year', iFrac: 'Tree cover', iNoObs: 'no observation', iLonLat: 'Lat, lon', iPixel: 'Pixel centre', iGrid: 'native Landsat grid',
  iElev: 'Elevation', iM: (m) => `${m} m`, iBuilt: 'Built', iBuilt72: 'before 1972', iBuilt78: '1978–1984', iBuiltYear: (y) => `${y}`,
  iBuiltNote: (bs, bh) => `built-up share ~${bs}%, building height ~${bh} m (GHSL 2018)`, iNotBuilt: 'not built before 2021 (GISA)',
  iSource: 'Source scene', iSrcLoading: 'Loading source…', iSrcNone: 'no clear observation this year',
  iSrcNote: (n, x, y) => `${n} clear dates this year; raw pixel: col = (${x} − 15 − ulx) / 30, row = (uly − ${y} − 15) / 30`,
  iSpark: 'Line: tree cover per year; gaps are years with no clear observation.', iSparkAria: 'Tree cover time series',
  outsidePilot: 'This place is outside the current data (Taipei pilot); island-wide data is being built.',
  outside: 'This place is outside the data (Taiwan, Penghu, Kinmen, Matsu) or its tile is not finished yet.',
  coords: (la, lo) => `Coordinates ${la}, ${lo}`, searching: 'Searching… (OpenStreetMap Nominatim)',
  notFound: 'Place not found. Try a landmark, road or district.', precision: (q, lv) => ` (full address not found; located to the ${lv} level: “${q}”)`,
  searchFail: (m) => `Address search failed: ${m}`, noGeo: 'This browser does not support location.', locating: 'Getting your location…',
  yourPos: (a) => `Your location (accuracy ~${a} m)`, geoFail: (m) => `Could not get location: ${m}`,
  shared: (la, lo) => `Shared location ${la}, ${lo}`, copied: 'Link to this view copied.', linkIs: (u) => `Link: ${u}`,
  random: (la, lo) => `Random place ${la}, ${lo}`, listSep: ', ',
  sSite: 'Site', sRing: (m) => `${m} m around`, sNow: (y) => `${y}`, sArea: (ha) => `site ≈ ${ha} ha`,
  sPhaseBefore: 'Before', sPhaseChange: 'Clearing', sPhaseAfter: 'After',
  sSummary: (b0, b1, sb, a0, a1, sa, lost) => `Tree cover averaged <b>${sb}%</b> in ${b0}–${b1} and <b>${sa}%</b> in ${a0 === a1 ? a0 : `${a0}–${a1}`}: about <b>${lost} ha</b> of canopy lost.`,
  sRingSummary: (m, rb, ra) => `The ${m} m ring around it went ${rb}% → ${ra}% over the same years.`,
  sReplay: 'Replay', sOther: 'Other TSMC sites', sClose: 'Close', sShare: 'Share this story',
  sNote: 'Values are estimated tree cover of 30 m Landsat pixels; single years can be off by a few points. Site outline © OpenStreetMap contributors (ODbL).',
  sSources: 'Sources for dates', sChartAria: 'Tree cover inside the site and around it', sCopied: 'Story link copied.',
  sNotFound: (id) => `No story called “${id}”.`, sLegendChange: 'clearing years',
  langBtn: '中文', langTitle: '切換為中文',
  lvl: { '完整地址': 'full address', '門牌': 'house number', '巷弄': 'lane', '路段': 'road section', '道路': 'road', '鄉鎮市區': 'district' },
};

const D = lang === 'en' ? EN : ZH;
export function t(key, ...args) { const v = D[key] ?? ZH[key]; return typeof v === 'function' ? v(...args) : v; }
export const levelName = (lv) => (lang === 'en' ? EN.lvl[lv] ?? lv : lv);
// zh/en field of a data record: rec.zh / rec.en, or rec[`${base}_zh`] / rec[`${base}_en`]
export const pickLang = (rec, base) => (base ? rec[`${base}_${lang}`] ?? rec[`${base}_zh`] : rec[lang] ?? rec.zh);

// The page is written in Chinese; in English, elements carrying data-i18n* keys are replaced from DOM_EN.
const DOM_EN = {
  desc: '3D timeline of tree cover in Taiwan, 1984–2026, from Landsat satellite imagery.',
  h1: 'Taiwan Tree-Cover Time Machine', pilot: 'Taipei pilot',
  q: 'Address, landmark or coordinates, e.g. Taipei 101, 25.0339, 121.5645', qAria: 'Search for a place',
  go: 'Go', gps: 'My location', gpsTitle: 'Use device location',
  share: 'Share', shareTitle: 'Copy a link to this view (place, heading, year)',
  wxAria: 'Weather (decorative)', wx: 'Weather', wxTitle: 'Weather and time of day are visual effects, not data',
  clear: 'Clear', cloudy: 'Cloudy', rain: 'Rain', hour: 'Time', hourTitle: 'Time of day',
  autoTime: 'Auto', autoTimeTitle: 'Let time run (a day takes about 3.5 minutes; nights are faster)',
  statArea: 'Tree cover', statVs: 'vs', statScenes: 'Scenes', statBuilt: 'Built-up',
  trendAria: 'Tree cover and built-up area trend', trendTree: 'Tree cover', trendBuilt: 'Built-up',
  info: 'This place', close: 'Close', timeline: 'Timeline', play: 'Play/pause', slider: 'Year',
  bars: 'Landsat scenes per year (orange: fewer than 5, low confidence)',
  legendFrac: 'Tree cover', legendNoObs: 'no clear observation this year (previous value kept)', legendLoss: 'tree cover falling',
  fov: 'View', fovTitle: 'Field of view: small = telephoto, flat, miniature look; large = wide angle, deep perspective',
  tilt: 'Miniature', tiltTitle: 'Tilt-shift blur (M)', random: 'Random place', randomTitle: 'Fly to another random place where tree cover changed',
  about: 'Data & limits', camAria: 'Camera',
  camTitle: 'Rotate: right-drag, Shift+drag or two-finger twist; pan: left-drag; zoom: wheel or pinch',
  rotL: 'Rotate left (Q)', compass: 'North up (N)', rotR: 'Rotate right (E)', tiltUp: 'Look down (R)', tiltDn: 'Look level (F)',
  minimap: 'Overview map: click to fly there', search: 'address search ©', loading: 'Loading tree-cover data…',
};

export function applyDom() {
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-Hant-TW';
  document.title = t('title');
  for (const el of document.querySelectorAll('[data-lang]')) el.hidden = el.dataset.lang !== lang;
  const btn = document.getElementById('langBtn');
  if (btn) { btn.textContent = t('langBtn'); btn.title = t('langTitle'); btn.onclick = () => setLang(lang === 'en' ? 'zh' : 'en'); }
  if (lang !== 'en') return;
  const set = (attr, fn) => { for (const el of document.querySelectorAll(`[${attr}]`)) { const v = DOM_EN[el.getAttribute(attr)]; if (v != null) fn(el, v); } };
  set('data-i18n', (el, v) => { el.textContent = v; });
  set('data-i18n-title', (el, v) => { el.title = v; });
  set('data-i18n-ph', (el, v) => { el.placeholder = v; });
  set('data-i18n-aria', (el, v) => { el.setAttribute('aria-label', v); });
  set('data-i18n-content', (el, v) => { el.setAttribute('content', v); });
}

// The button's choice is remembered for this browser; reload so every label is rebuilt in the new language.
function setLang(l) {
  try { localStorage.setItem('tpetree.lang', l); } catch {}
  const u = new URL(location.href); u.searchParams.delete('lang');
  location.replace(u.toString());
}

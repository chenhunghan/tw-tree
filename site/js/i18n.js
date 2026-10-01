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
  sNote: '數值為 30 公尺 Landsat 像元的樹冠比例估計，單一年份可能有數個百分點的雜訊。廠房為 OpenStreetMap 的實際輪廓；高度多為估計（約 20–33 公尺），出現年份依 GISA 建成年份或樹冠消失的年份推估，半透明為興建中。廠區範圍與廠房 © OpenStreetMap 貢獻者（ODbL）。',
  sSources: '時間資料來源', sChartAria: '廠區與周邊的樹冠比例', sCopied: '已複製故事連結。',
  sNotFound: (id) => `找不到故事「${id}」。`, sLegendChange: '開發期間', sUnderConstruction: '興建中', sLoading: (d, n) => `載入廠區細節… ${d}/${n} 圖塊`,
  sRevTitle: '營收估計（每隻 🦄 = 10 億美元）',
  sRevNow: (y, v, lo, hi) => `${y} 估計營收 <b>${v}</b> 億美元<span class="rng">（約 ${lo}–${hi}）</span>`,
  sRevCum: (v) => `累計約 ${v} 億美元`, sUnicorns: (k) => `🦄 × ${k}`,
  sRevScaleMo: (v) => `每月 ${v} 億美元`, sRevScaleYr: (v) => `每年 ${v} 億美元`,
  sRevAria: '廠區估計營收', sRevLegend: '估計年營收', sRevRange: '可能範圍',
  langBtn: 'EN', langTitle: 'Switch to English',
  expand: '展開', collapse: '收合',
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
  sNote: 'Values are estimated tree cover of 30 m Landsat pixels; single years can be off by a few points. Fab buildings are real OpenStreetMap footprints; heights are mostly estimates (about 20–33 m), and the year each appears comes from GISA\'s first-built year or the year the tree cover went; translucent ones are under construction. Site outline and buildings © OpenStreetMap contributors (ODbL).',
  sSources: 'Sources for dates', sChartAria: 'Tree cover inside the site and around it', sCopied: 'Story link copied.',
  sNotFound: (id) => `No story called “${id}”.`, sLegendChange: 'clearing years', sUnderConstruction: 'under construction', sLoading: (d, n) => `Loading site detail… ${d}/${n} tiles`,
  sRevTitle: 'Estimated revenue (each 🦄 = US$1 bn)',
  sRevNow: (y, v, lo, hi) => `Est. revenue ${y}: <b>US$${v} bn</b><span class="rng"> (≈${lo}–${hi})</span>`,
  sRevCum: (v) => `US$${v} bn so far`, sUnicorns: (k) => `🦄 × ${k}`,
  sRevScaleMo: (v) => `US$${v} bn / month`, sRevScaleYr: (v) => `US$${v} bn / year`,
  sRevAria: 'Estimated revenue of the site', sRevLegend: 'estimated revenue', sRevRange: 'likely range',
  langBtn: '中文', langTitle: '切換為中文',
  expand: 'Expand', collapse: 'Collapse',
  lvl: { '完整地址': 'full address', '門牌': 'house number', '巷弄': 'lane', '路段': 'road section', '道路': 'road', '鄉鎮市區': 'district' },
};

const D = lang === 'en' ? EN : ZH;
export function t(key, ...args) { const v = D[key] ?? ZH[key]; return typeof v === 'function' ? v(...args) : v; }
export const levelName = (lv) => (lang === 'en' ? EN.lvl[lv] ?? lv : lv);
// zh/en field of a data record: rec.zh / rec.en, or rec[`${base}_zh`] / rec[`${base}_en`]
export const pickLang = (rec, base) => (base ? rec[`${base}_${lang}`] ?? rec[`${base}_zh`] : rec[lang] ?? rec.zh);

// index.html is written in English; Traditional Chinese (Taiwan) for its marked elements. A key prefixed with the
// attribute (`data-i18n-title:rotL`) is used where one key's Chinese differs by attribute.
const DOM_ZH = {
  desc: "1984–2026 年臺灣樹冠覆蓋的 3D 時間軸，資料來自 Landsat 衛星。",
  h1: "臺灣樹冠時光機",
  pilot: "臺北試行版",
  q: "地址、地標或座標，例：臺北101、25.0339, 121.5645",
  qAria: "搜尋地點",
  go: "前往",
  gpsTitle: "使用裝置定位",
  gps: "我的位置",
  shareTitle: "複製目前視角（位置、方向、年份）的連結",
  share: "分享",
  wxAria: "天氣（裝飾用）",
  wxTitle: "天氣與時間只是畫面效果，不是實際資料",
  wx: "天氣",
  clear: "晴",
  cloudy: "多雲",
  rain: "雨",
  hourTitle: "一天中的時間",
  hour: "時間",
  autoTimeTitle: "時間自動流動（白天約 3.5 分鐘，夜晚較快）",
  autoTime: "自動",
  statArea: "樹冠面積",
  statVs: "相較",
  statScenes: "當年影像",
  statBuilt: "建成區",
  trendAria: "樹冠與建成區面積趨勢",
  trendTree: "樹冠",
  trendBuilt: "建成區",
  close: "關閉",
  info: "這個位置",
  timeline: "時間軸",
  play: "播放/暫停",
  slider: "年份",
  bars: "每年可用的 Landsat 影像數（橘色：少於 5 景，低信心）",
  legendFrac: "樹冠比例",
  legendNoObs: "當年無清晰觀測（沿用前一次）",
  legendLoss: "樹冠減少中",
  fovTitle: "視角（FOV）：小＝望遠、扁平的迷你感；大＝廣角、景深強",
  fov: "視角",
  tiltTitle: "移軸模糊（M）",
  tilt: "迷你世界",
  randomTitle: "飛到另一個樹冠有變化的隨機地點",
  random: "隨機地點",
  about: "資料與限制",
  camTitle: "平移：拖曳地面；旋轉與傾斜：右鍵拖曳，或按住 Ctrl／⌘／Shift 拖曳（左右旋轉、上下傾斜）；縮放：滾輪或兩指捏合（朝游標處），雙擊放大；觸控：兩指轉動旋轉、兩指上下滑動傾斜",
  camAria: "鏡頭",
  rotL: "向左旋轉（Q）",
  "data-i18n-aria:rotL": "向左旋轉",
  compass: "朝北（N）",
  "data-i18n-aria:compass": "朝北",
  rotR: "向右旋轉（E）",
  "data-i18n-aria:rotR": "向右旋轉",
  tiltUp: "俯視（R）",
  "data-i18n-aria:tiltUp": "俯視",
  tiltDn: "平視（F）",
  "data-i18n-aria:tiltDn": "平視",
  minimap: "小地圖：點一下飛過去",
  "data-i18n-aria:minimap": "小地圖",
  search: "地址搜尋 ©",
  loading: "載入樹冠資料…",
};

export function applyDom() {
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-Hant-TW';
  document.title = t('title');
  for (const el of document.querySelectorAll('[data-lang]')) el.hidden = el.dataset.lang !== lang;
  const btn = document.getElementById('langBtn');
  if (btn) { btn.textContent = t('langBtn'); btn.title = t('langTitle'); btn.onclick = () => setLang(lang === 'en' ? 'zh' : 'en'); }
  if (lang !== 'zh') return;
  const set = (attr, fn) => {
    for (const el of document.querySelectorAll(`[${attr}]`)) { const k = el.getAttribute(attr), v = DOM_ZH[`${attr}:${k}`] ?? DOM_ZH[k]; if (v != null) fn(el, v); }
  };
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

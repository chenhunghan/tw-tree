// Coordinates and place search.
// UTM <-> WGS84 uses the Krüger series (sub-millimetre inside a zone), so display positions can be
// derived exactly from the stored integer pixel centres. Nothing here changes stored data.

const A_ = 6378137, F_ = 1 / 298.257223563, K0 = 0.9996, E0 = 500000;
const n = F_ / (2 - F_);
const AA = A_ / (1 + n) * (1 + n * n / 4 + n ** 4 / 64);
const al = [n / 2 - 2 * n * n / 3 + 5 * n ** 3 / 16, 13 * n * n / 48 - 3 * n ** 3 / 5, 61 * n ** 3 / 240];
const be = [n / 2 - 2 * n * n / 3 + 37 * n ** 3 / 96, n * n / 48 + n ** 3 / 15, 17 * n ** 3 / 480];
const de = [2 * n - 2 * n * n / 3 - 2 * n ** 3, 7 * n * n / 3 - 8 * n ** 3 / 5, 56 * n ** 3 / 15];
const rad = Math.PI / 180, c2 = 2 * Math.sqrt(n) / (1 + n);

export function lonLatToUtm(lon, lat, zone) {
  const lam = (lon - (zone * 6 - 183)) * rad, phi = lat * rad;
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - c2 * Math.atanh(c2 * Math.sin(phi)));
  const xi = Math.atan(t / Math.cos(lam)), eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let E = eta, N = xi;
  for (let j = 1; j <= 3; j++) {
    E += al[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    N += al[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  return [E0 + K0 * AA * E, K0 * AA * N];
}

export function utmToLonLat(x, y, zone) {
  const xi = y / (K0 * AA), eta = (x - E0) / (K0 * AA);
  let xp = xi, ep = eta;
  for (let j = 1; j <= 3; j++) {
    xp -= be[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    ep -= be[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xp) / Math.cosh(ep));
  let phi = chi;
  for (let j = 1; j <= 3; j++) phi += de[j - 1] * Math.sin(2 * j * chi);
  return [(zone * 6 - 183) + Math.atan(Math.sinh(ep) / Math.cos(xp)) / rad, phi / rad];
}

// "25.0339, 121.5645", "121.5645 25.0339", "25°02'02\"N 121°33'52\"E" -> [lon, lat] or null.
export function parseCoords(text) {
  const s = text.trim().replace(/，/g, ',');
  const dms = [...s.matchAll(/(\d+(?:\.\d+)?)\s*°\s*(?:(\d+(?:\.\d+)?)\s*['′]\s*)?(?:(\d+(?:\.\d+)?)\s*["″]\s*)?([NSEW北南東西])?/gi)];
  let nums;
  if (dms.length === 2) {
    nums = dms.map(m => {
      const v = +m[1] + (+m[2] || 0) / 60 + (+m[3] || 0) / 3600;
      return /[SW南西]/i.test(m[4] || '') ? -v : v;
    });
  } else {
    const m = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!m) return null;
    nums = [+m[1], +m[2]];
  }
  const [a, b] = nums;
  if (Math.abs(a) <= 90 && Math.abs(b) > 90) return [b, a];   // lat, lon
  if (Math.abs(b) <= 90 && Math.abs(a) > 90) return [a, b];   // lon, lat
  return Math.abs(a) <= 90 ? [b, a] : null;
}

// Nominatim: at most one request per second, no autocomplete, attribution shown in the UI.
let lastCall = 0;
async function nominatim(q) {
  const wait = Math.max(0, lastCall + 1100 - Date.now());
  if (wait) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.search = new URLSearchParams({ q, format: 'jsonv2', countrycodes: 'tw', limit: '1', 'accept-language': 'zh-TW' });
  const r = await fetch(u);
  if (!r.ok) throw new Error(`Nominatim ${r.status}`);
  return (await r.json())[0] || null;
}

// OSM rarely has Taiwanese house numbers, so fall back step by step and report the precision reached.
const STEPS = [
  [s => s, '完整地址'],
  [s => s.replace(/\d+\s*樓.*$/, '').replace(/之\d+/, ''), '門牌'],
  [s => s.replace(/\d+\s*號.*$/, ''), s => /[巷弄]$/.test(s) ? '巷弄' : '路段'],
  [s => s.replace(/\d+\s*[弄巷].*$/, ''), '路段'],
  [s => s.replace(/[一二三四五六七八九十\d]+\s*段.*$/, ''), '道路'],
  [s => (s.match(/^.*?[縣市].*?[區鄉鎮市]/) || [''])[0], '鄉鎮市區'],
];

export async function geocode(text) {
  const tried = new Set();
  for (const variant of [text.trim(), text.trim().replace(/台/g, '臺')]) {
    for (const [fn, level] of STEPS) {
      const q = fn(variant).trim();
      if (!q || tried.has(q)) continue;
      tried.add(q);
      const hit = await nominatim(q);
      const lv = typeof level === 'function' ? level(q) : level;
      if (hit) return { lon: +hit.lon, lat: +hit.lat, label: hit.display_name, level: lv, query: q, exact: lv === '完整地址' };
    }
  }
  return null;
}

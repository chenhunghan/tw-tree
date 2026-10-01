// Procedural Taiwanese trees, instanced. Each 30 m pixel has SLOTS candidate trees; slot k appears when the pixel's
// tree fraction passes its threshold, so visible trees ~ fraction x SLOTS (illustrative, not individual trees).
// Species follow Taiwan's elevation zones (Su 1984) plus urban planting.
// Crowns are clusters of alpha-tested leaf cards (sprig textures painted at runtime, no external assets) around a dark
// core, lit with crown-shaped normals. Three levels of detail: near (leaf cards per cluster), mid (one envelope with a
// few large cards), far (the envelope only, no shadow). Crowns are widened so full cover closes the canopy.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EXAG, DISPLAY_ZONE, toWorld, shareUniforms } from './terrain.js';
import { CLOUD_GLSL } from './weather.js';

const SLOTS = 4;
export const NEAR_DIST = 320;          // metres from the camera: leaf-card crowns inside
export const MID_DIST = 1500;          // simplified crowns inside, envelopes only outside
export const FAR_DIST = 3000;          // envelopes with trunks inside, crowns only (no trunk) beyond
const STRIDE_PX = 10;                  // a stride-widened crown (~15 m x stride) stays below this many screen pixels
const LODS = ['near', 'mid', 'far', 'dist', 'grove'];   // grove: thinned (stride > 1) instances
const CLOSURE = 1.5;                   // horizontal crown scale: 4 crowns per 30 m pixel close the canopy at 100 %
const INST_ATTRS = [['aTint', 3], ['aThr', 1], ['aFa', 1], ['aFb', 1], ['aNd', 1]];

// ---------- deterministic noise ----------
function hash3(x, y, z) { const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return h - Math.floor(h); }
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi, s = (t) => t * t * (3 - 2 * t);
  const u = s(xf), v = s(yf), w = s(zf), L = (a, b, t) => a + (b - a) * t;
  const c = (i, j, k) => hash3(xi + i, yi + j, zi + k);
  return L(L(L(c(0, 0, 0), c(1, 0, 0), u), L(c(0, 1, 0), c(1, 1, 0), u), v),
           L(L(c(0, 0, 1), c(1, 0, 1), u), L(c(0, 1, 1), c(1, 1, 1), u), v), w);
}
// 2D value noise on an integer hash (no Math.sin): the per-pixel species patches in build()
function ihash(x, y) { let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function vnoise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), u = x - xi, v = y - yi, su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  const a = ihash(xi, yi), b = ihash(xi + 1, yi), c = ihash(xi, yi + 1), d = ihash(xi + 1, yi + 1);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}
const PERMS = [];                                   // the 24 orders of the 4 slots
(function perm(a, k) { if (k === a.length) { PERMS.push(a.slice()); return; } for (let i = k; i < a.length; i++) { [a[k], a[i]] = [a[i], a[k]]; perm(a, k + 1); [a[k], a[i]] = [a[i], a[k]]; } })([0, 1, 2, 3], 0);
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const C = (hex) => new THREE.Color(hex);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clampN = (v, a, b) => Math.max(a, Math.min(b, Math.round(v)));

// ---------- leaf atlas: 2 x 2 cells of sprigs, grey (tinted by vertex colour) with alpha ----------
// 0 broadleaf, 1 acacia phyllodes, 2 conifer needles, 3 bamboo
export const CELL = { broad: 0, acacia: 1, needle: 2, bamboo: 3 };
function leafAtlas() {
  const S = 256, cv = document.createElement('canvas');
  cv.width = cv.height = S * 2;
  const g = cv.getContext('2d'), R = rng(99);
  const leaf = (x, y, len, wid, ang, v) => {
    g.save(); g.translate(x, y); g.rotate(ang);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(wid, len * 0.4, 0, len); g.quadraticCurveTo(-wid, len * 0.4, 0, 0); g.fill();
    g.strokeStyle = 'rgba(40,40,40,0.35)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, len * 0.06); g.lineTo(0, len * 0.85); g.stroke();
    g.restore();
  };
  const cellOrigin = (i) => [(i % 2) * S, (1 - Math.floor(i / 2)) * S];     // CanvasTexture flips Y: cell 0 = bottom-left
  // A rounded spray: a few twigs, then many leaves scattered through the disc (denser inside), pointing outward.
  // Greys stay light (170-255): the texture is read as linear data and multiplies the vertex colour.
  function spray(i, { leaves, len, wid, twigs = 6, radius = 0.46, droop = 0 }) {
    const [ox, oy] = cellOrigin(i), c = S / 2;
    g.save(); g.translate(ox, oy); g.beginPath(); g.rect(0, 0, S, S); g.clip();
    g.strokeStyle = 'rgb(120,105,90)'; g.lineWidth = 2.5;
    for (let t = 0; t < twigs; t++) {
      const a = (t / twigs) * Math.PI * 2 + R() * 0.6, L = S * radius * (0.6 + 0.3 * R());
      g.beginPath(); g.moveTo(c, c); g.quadraticCurveTo(c + Math.cos(a + 0.3) * L * 0.5, c + Math.sin(a + 0.3) * L * 0.5, c + Math.cos(a) * L, c + Math.sin(a) * L); g.stroke();
    }
    for (let k = 0; k < leaves; k++) {
      const a = R() * Math.PI * 2, d = S * radius * Math.pow(R(), 0.65) * 0.82;
      const px = c + Math.cos(a) * d, py = c + Math.sin(a) * d;
      const ang = a - Math.PI / 2 + (R() - 0.5) * 1.1 + droop;
      const v = Math.round(172 + 83 * R() * (0.6 + 0.4 * (1 - py / S)));
      leaf(px, py, len * (0.7 + 0.5 * R()), wid * (0.8 + 0.4 * R()), ang, v);
    }
    g.restore();
  }
  spray(CELL.broad, { leaves: 420, len: 19, wid: 7.5, twigs: 9 });
  spray(CELL.acacia, { leaves: 460, len: 24, wid: 3.2, twigs: 9 });
  spray(CELL.bamboo, { leaves: 260, len: 34, wid: 4.5, droop: 0.5 });
  { // conifer: one branch spray along the cell's u axis (the card runs along a branch): a stem, alternating
    // branchlets that shorten toward the tip, short needles on both; tips lighter (new growth)
    const [ox, oy] = cellOrigin(CELL.needle);
    g.save(); g.translate(ox, oy); g.beginPath(); g.rect(0, 0, S, S); g.clip();
    g.lineCap = 'round';
    const needles = (x0, y0, x1, y1, len, k0, k1, n) => {
      const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L;
      for (let s = 0; s < n; s++) {
        const u = s / n, px = x0 + dx * u, py = y0 + dy * u, side = s % 2 ? 1 : -1;
        const a = side * (0.75 + R() * 0.4), c = Math.cos(a), sn = Math.sin(a), l = len * (1 - 0.35 * u) * (0.75 + 0.45 * R());
        const v = Math.round(150 + (k0 + (k1 - k0) * u) * 95 * (0.75 + 0.3 * R()));
        g.strokeStyle = `rgb(${v},${v},${v})`; g.lineWidth = 2.3 * (0.8 + 0.4 * R());
        g.beginPath(); g.moveTo(px, py); g.lineTo(px + (ux * c - uy * sn) * l, py + (ux * sn + uy * c) * l); g.stroke();
      }
    };
    const stem = [];
    for (let s = 0; s <= 24; s++) { const t = s / 24; stem.push([6 + t * 244, S / 2 + Math.sin(t * Math.PI) * 4]); }
    const twigs = [];
    for (let s = 2; s < 22; s++) for (const side of [-1, 1]) {
      const t = s / 24, [x, y] = stem[s];
      twigs.push({ x, y, t, len: (1 - t * 0.55) * 0.42 * S * (0.75 + 0.3 * R()) + 10, ang: side * (0.55 + 0.35 * R()) });
    }
    for (const w of twigs) {
      const x1 = w.x + Math.cos(w.ang) * w.len, y1 = w.y + Math.sin(w.ang) * w.len;
      g.strokeStyle = 'rgb(120,100,80)'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(w.x, w.y); g.lineTo(x1, y1); g.stroke();
      needles(w.x, w.y, x1, y1, 15, 0.45 + 0.4 * w.t, 1, Math.round(w.len * 0.9));
    }
    for (let s = 0; s < 24; s++) needles(...stem[s], ...stem[s + 1], 19, s / 24 * 0.6, (s + 1) / 24 * 0.6 + 0.2, 10);
    g.strokeStyle = 'rgb(110,90,70)'; g.lineWidth = 3; g.beginPath(); stem.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke();
    g.restore();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;          // greys are a linear brightness multiplier
  tex.anisotropy = 4;
  return tex;
}

// ---------- geometry parts: position, normal, aUv, aCol (colour x baked AO), aPart (0 wood, 1 solid foliage, 2 leaf card) ----------
function finish(geo, part, colorAt) {
  if (geo.index) geo = geo.toNonIndexed();
  if (geo.attributes.uv) geo.deleteAttribute('uv');
  const p = geo.attributes.position, n = p.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const c = colorAt(i, p.getX(i), p.getY(i), p.getZ(i)); col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2]; }
  geo.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n).fill(part), 1));
  geo.setAttribute('aUv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return geo;
}

// A lumpy solid crown (core under the leaf cards, or the whole crown far away): displaced icosphere with
// normals blended toward the ellipsoid for a soft, volumetric look.
function clump({ x = 0, y = 0, z = 0, r = 3, sy = 1, detail = 1, rough = 0.32, seed = 0, color, ao = 0.5, dark = 1 }) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position, unit = [];
  for (let i = 0; i < p.count; i++) {
    const ux = p.getX(i), uy = p.getY(i), uz = p.getZ(i);
    unit.push([ux, uy, uz]);
    const d = 1 + rough * (vnoise(ux * 1.9 + seed, uy * 1.9 + seed * 1.7, uz * 1.9 - seed) - 0.5) * 2;
    p.setXYZ(i, x + ux * r * d, y + uy * r * d * sy, z + uz * r * d);
  }
  g.computeVertexNormals();
  const nr = g.attributes.normal, v = new THREE.Vector3(), f = new THREE.Vector3();
  for (let i = 0; i < nr.count; i++) {
    const [ux, uy, uz] = unit[i];
    v.set(ux, uy / sy, uz).normalize();
    f.fromBufferAttribute(nr, i);
    v.multiplyScalar(0.72).addScaledVector(f, 0.28).normalize();
    nr.setXYZ(i, v.x, v.y, v.z);
  }
  const c = C(color);
  return finish(g, 1, (i) => {
    const [ux, uy, uz] = unit[i];
    const k = dark * (ao + (1 - ao) * smooth(-0.9, 0.85, uy)) * (0.86 + 0.28 * hash3(ux * 9 + seed, uy * 9, uz * 9));
    return [c.r * k, c.g * k, c.b * k];
  });
}

// Leaf cards scattered through an ellipsoidal cluster, mostly near its shell and facing outward. Every vertex of a
// card takes the ellipsoid's normal (80 %) so the cluster shades as one soft volume, not as flat quads.
function leafCards({ x = 0, y = 0, z = 0, r = 3, sy = 1, n = 20, size = 2, cell = 0, color, ao = 0.62, seed = 0 }) {
  const R = rng(seed * 7919 + 13 + Math.round(r * 101)), c = C(color);
  const pos = new Float32Array(n * 18), nor = new Float32Array(n * 18), uv = new Float32Array(n * 12), col = new Float32Array(n * 18);
  const u0 = (cell % 2) * 0.5, v0 = Math.floor(cell / 2) * 0.5, e = 0.01;
  const out = new THREE.Vector3(), nrm = new THREE.Vector3(), t = new THREE.Vector3(), b = new THREE.Vector3(), tmp = new THREE.Vector3(), nn = new THREE.Vector3();
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]], tri = [0, 1, 2, 0, 2, 3];
  for (let i = 0; i < n; i++) {
    const dy = R() * 2 - 1;
    const a = R() * Math.PI * 2, rr = Math.sqrt(1 - dy * dy);
    const dx = Math.cos(a) * rr, dz = Math.sin(a) * rr, depth = 0.6 + 0.4 * Math.sqrt(R());
    const cx = x + dx * r * depth, cy = y + dy * r * sy * depth, cz = z + dz * r * depth;
    out.set(dx, dy / sy, dz).normalize();
    nrm.set(dx + (R() - 0.5) * 1.3, dy + 0.12 + (R() - 0.5) * 1.3, dz + (R() - 0.5) * 1.3).normalize();
    tmp.set(R() - 0.5, R() - 0.5, R() - 0.5); t.crossVectors(nrm, tmp).normalize(); b.crossVectors(nrm, t);
    const h = size * (0.75 + 0.5 * R()) / 2;
    nn.copy(out).multiplyScalar(0.8).addScaledVector(nrm, 0.2).normalize();
    const k = (ao + (1 - ao) * smooth(-0.9, 0.85, dy)) * (0.8 + 0.2 * depth) * (0.82 + 0.36 * R());
    tri.forEach((ci, j) => {
      const [s, u] = corners[ci], o = i * 6 + j;
      pos[o * 3] = cx + (t.x * s + b.x * u) * h; pos[o * 3 + 1] = cy + (t.y * s + b.y * u) * h; pos[o * 3 + 2] = cz + (t.z * s + b.z * u) * h;
      nor[o * 3] = nn.x; nor[o * 3 + 1] = nn.y; nor[o * 3 + 2] = nn.z;
      uv[o * 2] = u0 + e + (s + 1) / 2 * (0.5 - 2 * e); uv[o * 2 + 1] = v0 + e + (u + 1) / 2 * (0.5 - 2 * e);
      col[o * 3] = c.r * k; col[o * 3 + 1] = c.g * k; col[o * 3 + 2] = c.b * k;
    });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n * 6).fill(2), 1));
  return g;
}

function trunk({ x = 0, z = 0, h = 5, r0 = 0.5, r1 = 0.3, segs = 6, hseg = 3, lean = [0, 0], y0 = -0.8, color = '#6b5a48' }) {
  const g = new THREE.CylinderGeometry(r1, r0, h, segs, hseg, true).translate(0, h / 2 + y0, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) - y0) / h;
    p.setXYZ(i, p.getX(i) + x + lean[0] * t * t * h, p.getY(i), p.getZ(i) + z + lean[1] * t * t * h);
  }
  g.computeVertexNormals();
  const c = C(color);
  return finish(g, 0, (i, px, py) => { const k = 0.6 + 0.4 * smooth(y0, y0 + h, py); return [c.r * k, c.g * k, c.b * k]; });
}

function cone({ y = 0, r = 3, h = 5, segs = 8, rough = 0.18, seed = 0, color, dark = 1 }) {
  const g = new THREE.ConeGeometry(r, h, segs, 2, true).translate(0, y + h / 2, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const d = 1 + rough * (hash3(p.getX(i) * 3 + seed, p.getY(i), p.getZ(i) * 3) - 0.5) * 2;
    p.setXYZ(i, p.getX(i) * d, p.getY(i) - (1 - (p.getY(i) - y) / h) * rough * 0.8, p.getZ(i) * d);   // droopy rim
  }
  g.computeVertexNormals();
  const c = C(color);
  return finish(g, 1, (i, px, py) => { const k = dark * (0.55 + 0.45 * smooth(y, y + h, py)); return [c.r * k, c.g * k, c.b * k]; });
}

// An arching frond (tree fern, palm): a creased ribbon that rises, then droops.
function frond({ base = [0, 0, 0], ang = 0, len = 3.5, width = 0.9, lift = 0.35, droop = 1.0, segs = 5, color = '#7fa84a' }) {
  const dir = [Math.cos(ang), Math.sin(ang)], side = [-Math.sin(ang), Math.cos(ang)], rows = [];
  for (let s = 0; s <= segs; s++) {
    const t = s / segs, along = len * t;
    const up = len * (lift * Math.sin(Math.PI * t * 0.9) - droop * 0.5 * t * t);
    const cx = base[0] + dir[0] * along, cy = base[1] + up, cz = base[2] + dir[1] * along;
    const w = width * Math.pow(Math.sin(Math.PI * Math.min(0.98, t * 0.95 + 0.04)), 0.7), cr = w * 0.3;
    rows.push([[cx + side[0] * w, cy - cr, cz + side[1] * w], [cx, cy, cz], [cx - side[0] * w, cy - cr, cz - side[1] * w]]);
  }
  const pos = [];
  for (let s = 0; s < segs; s++) {
    const [L0, C0, R0] = rows[s], [L1, C1, R1] = rows[s + 1];
    pos.push(...L0, ...C0, ...L1, ...C0, ...C1, ...L1, ...C0, ...R0, ...C1, ...R0, ...R1, ...C1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  const nr = g.attributes.normal;
  for (let i = 0; i < nr.count; i++) { const v = new THREE.Vector3().fromBufferAttribute(nr, i).lerp(new THREE.Vector3(0, 1, 0), 0.45).normalize(); nr.setXYZ(i, v.x, v.y, v.z); }
  const c = C(color), tip = C('#a8c060');
  return finish(g, 1, (i, px, py, pz) => {
    const t = Math.min(1, Math.hypot(px - base[0], pz - base[2]) / len), k = 0.65 + 0.35 * t;
    return [(c.r + (tip.r - c.r) * t * 0.5) * k, (c.g + (tip.g - c.g) * t * 0.5) * k, (c.b + (tip.b - c.b) * t * 0.5) * k];
  });
}

const merge = (parts) => mergeGeometries(parts);

// A thinned instance stands for a block of st x st pixels with crowns st x wider. One widened crown reads as a smooth
// blob ("green bean"), so its template is the species' distant crown as four half-width crowns of uneven height and
// shade (same footprint, same cover), and the block reads as a stand of trees.
function grove(make, seed) {
  const base = make(), R = rng(97 + seed * 31);
  base.computeBoundingBox();
  const bb = base.boundingBox, cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2;
  const r = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2;
  // five crowns of uneven size, irregularly placed (a regular 2 x 2 reads as a four-leaf clover)
  const crowns = [0.5, 0.46, 0.42, 0.38, 0.3].map((w, i) => {
    const a = i * 2.4 + R() * 0.9, d = i === 0 ? 0.12 : 0.42 + R() * 0.2;
    return { w: w + R() * 0.08, x: Math.cos(a) * d, z: Math.sin(a) * d };
  });
  return merge(crowns.map(({ w, x, z }) => {
    const g = base.clone(), h = (0.7 + R() * 0.4) * (0.75 + 0.5 * w);
    g.translate(-cx, 0, -cz); g.scale(w, h, w); g.translate(cx + x * r, 0, cz + z * r);
    const col = g.attributes.aCol, k = 0.78 + R() * 0.38, warm = (R() - 0.5) * 0.12;
    for (let j = 0; j < col.count; j++) col.setXYZ(j, col.getX(j) * k * (1 + warm), col.getY(j) * k, col.getZ(j) * k * (1 - warm));
    return g;
  }));
}
const ring = (n, fn) => Array.from({ length: n }, (_, i) => fn(i, (i / n) * Math.PI * 2));

// One ellipsoid around a set of clusters: the mid and far crown.
function envelope(clusters) {
  let w = 0, cx = 0, cz = 0, lo = Infinity, hi = -Infinity, rh = 0;
  for (const c of clusters) {
    const m = c.r ** 3, x = c.x || 0, z = c.z || 0, y = c.y || 0, sy = c.sy ?? 1;
    w += m; cx += x * m; cz += z * m;
    lo = Math.min(lo, y - c.r * sy); hi = Math.max(hi, y + c.r * sy);
  }
  cx /= w; cz /= w;
  for (const c of clusters) rh = Math.max(rh, Math.hypot((c.x || 0) - cx, (c.z || 0) - cz) + c.r * 0.9);
  const ry = (hi - lo) / 2 * 0.95;
  return { x: cx, y: (hi + lo) / 2, z: cz, r: rh, sy: ry / rh, color: clusters[0].color };
}

// Broadleaf-type species: trunks (near) + leaf clusters. near: a dark core and leaf cards per cluster; mid: the envelope's
// core with a few large cards; far: the envelope as a solid crown.
// skirt: a lower ring of clusters (relative size), so the crown is deep and rounded instead of a plate on a stem.
function leafy({ trunks, midTrunk, clusters: cl0, cell = CELL.broad, coreR = 0.62, density = 1.1, grow = 1.25, skirt = 0 }) {
  const clusters = cl0.map(c => ({ ...c, r: c.r * grow, x: (c.x || 0) * (1 + (grow - 1) * 0.6), z: (c.z || 0) * (1 + (grow - 1) * 0.6) }));
  if (skirt) {
    const e0 = envelope(clusters), mr = clusters.reduce((a, c) => a + c.r, 0) / clusters.length;
    clusters.push(...ring(5, (i, a) => ({ x: e0.x + Math.cos(a + 0.6) * e0.r * 0.52, y: e0.y - e0.r * e0.sy * 0.5, z: e0.z + Math.sin(a + 0.6) * e0.r * 0.52,
      r: mr * skirt, sy: 0.8, core: false, color: '#' + C(clusters[i % clusters.length].color).multiplyScalar(0.85).getHexString() })));
  }
  const env = envelope(clusters);
  return {
    near: () => merge([
      ...trunks(),
      ...clusters.filter(c => c.core !== false).map((c, i) => clump({ ...c, y: c.y + c.r * (c.sy ?? 1) * 0.18, r: c.r * coreR, detail: 0, rough: 0.55, dark: 0.72, seed: i + 3 })),
      // skirt clusters are cards only (a solid core seen from the side reads as a dark slab)
      ...clusters.map((c, i) => leafCards({ ...c, n: clampN(c.r * c.r * density * (c.core === false ? 1.5 : 1), 6, 30), size: c.r * 1.2, cell, seed: i + 1 })),
    ]),
    mid: () => merge([
      midTrunk(),
      clump({ ...env, r: env.r * 0.86, detail: 0, rough: 0.34, dark: 0.62, seed: 5 }),
      leafCards({ ...env, n: 18, size: env.r * 0.95, cell, seed: 9 }),
    ]),
    far: () => clump({ ...env, detail: 0, rough: 0.3, seed: 7, dark: 0.9 }),
    dist: () => clump({ ...env, detail: 0, rough: 0.2, seed: 7, dark: 0.9 }),
  };
}

// Conifers grown as real ones are: whorls of branches up the stem, each branch carrying needle sprays.
// A spray is a card along the branch, folded along its stem (a shallow tent) so it never vanishes edge-on; its normal
// leans 65 % toward the crown's outward normal so the tree shades as one volume, and baked AO darkens branch bases
// and the lower crown. A dark core cone fills the gaps between sprays. near: 2 folded cards per branch;
// mid: every 2nd whorl, one flat card per branch; far: a cone.
const UP = new THREE.Vector3(0, 1, 0);
function whorls({ H, crownBase, crownR, seed, profile = 0.95, round = 0, pitch = [0.05, 0.45], droop = [0.62, 0.2], spacing = 1 }) {
  const R = rng(seed), out = [];
  for (let y = crownBase; y < H - 0.6;) {
    const t = (y - crownBase) / (H - crownBase);
    const prof = (1 - t) ** profile * (0.75 + 0.25 * Math.sin(t * Math.PI)) + round * Math.sin(t * Math.PI) * 0.35 * (1 - t);
    const n = t > 0.85 ? 4 : 5 + Math.floor(R() * 3), az0 = R() * Math.PI * 2, br = [];
    for (let i = 0; i < n; i++) br.push({
      az: az0 + (i / n) * Math.PI * 2 + (R() - 0.5) * 0.7,
      len: Math.max(0.5, crownR * prof * (0.75 + 0.4 * R()) + 0.4),
      pitch: pitch[0] + (pitch[1] - pitch[0]) * t + (R() - 0.5) * 0.16,
      droop: droop[0] + (droop[1] - droop[0]) * t + (R() - 0.5) * 0.2,
      roll: (R() - 0.5) * 0.5, tone: 0.9 + 0.2 * R(),
    });
    out.push({ y, t, br });
    y += (1.25 - 0.7 * t) * spacing * (0.8 + 0.4 * R());
  }
  return out;
}
const branchAt = (w, b, u, r0, v) => v.set(Math.cos(b.az) * (r0 + b.len * u), w.y + b.len * (b.pitch * u - b.droop * u * u), Math.sin(b.az) * (r0 + b.len * u));

// Spray cards: `cards` = [{ m, d, h, w, roll, fold, aoA, aoB, color }] -> one non-indexed geometry (aPart 2).
function sprayCards(cards, cell) {
  const n = cards.length, folded = cards.some(c => c.fold), tv = folded ? 12 : 6;
  const pos = new Float32Array(n * tv * 3), nor = new Float32Array(n * tv * 3), uv = new Float32Array(n * tv * 2), col = new Float32Array(n * tv * 3);
  const u0 = (cell % 2) * 0.5, v0 = Math.floor(cell / 2) * 0.5, e = 0.01;
  const side = new THREE.Vector3(), f = new THREE.Vector3(), p = new THREE.Vector3(), q = new THREE.Vector3(), out = new THREE.Vector3(), nn = new THREE.Vector3(), P = new THREE.Vector3();
  let o = 0;
  for (const c of cards) {
    side.crossVectors(UP, c.d); if (side.lengthSq() < 1e-4) side.set(1, 0, 0); side.normalize();
    f.crossVectors(c.d, side).normalize();
    const cr = Math.cos(c.roll), sr = Math.sin(c.roll);
    p.copy(side).multiplyScalar(cr).addScaledVector(f, sr);
    q.copy(f).multiplyScalar(cr).addScaledVector(side, -sr);
    out.set(c.m.x, 0, c.m.z); if (out.lengthSq() < 1e-6) out.set(1, 0, 0);
    out.normalize().multiplyScalar(0.9).add(new THREE.Vector3(0, 0.45, 0)).normalize();
    nn.copy(q).multiplyScalar(0.35).addScaledVector(out, 0.65).normalize();
    const b = Math.cos(c.fold || 0) * c.w / 2, y = Math.sin(c.fold || 0) * c.w / 2;
    const vert = (end, r) => {
      P.copy(c.m).addScaledVector(c.d, (end - 0.5) * c.h).addScaledVector(p, r * b).addScaledVector(q, r === 0 ? 0 : -y);
      pos[o * 3] = P.x; pos[o * 3 + 1] = P.y; pos[o * 3 + 2] = P.z;
      nor[o * 3] = nn.x; nor[o * 3 + 1] = nn.y; nor[o * 3 + 2] = nn.z;
      uv[o * 2] = u0 + e + end * (0.5 - 2 * e); uv[o * 2 + 1] = v0 + e + (r + 1) / 2 * (0.5 - 2 * e);
      const k = (end ? c.aoB : c.aoA) * (r === 0 ? 1 : 0.92);
      col[o * 3] = c.color.r * k; col[o * 3 + 1] = c.color.g * k; col[o * 3 + 2] = c.color.b * k;
      o++;
    };
    const quad = (ra, rb) => { vert(0, ra); vert(1, ra); vert(0, rb); vert(0, rb); vert(1, ra); vert(1, rb); };
    if (folded) { quad(-1, 0); quad(0, 1); } else quad(-1, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n * tv).fill(2), 1));
  return g;
}

function conifer({ H, crownBase, crownR, trunkR, seed, color, alt, bark = '#5b4c40', ...shape }) {
  const W = whorls({ H, crownBase, crownR, seed, ...shape }), cA = C(color), cB = C(alt);
  const ao = (w, u) => 0.35 + 0.65 * u ** 0.7 * (0.55 + 0.45 * w.t);
  const tint = (w, b) => (w.br.indexOf(b) % 2 ? cB : cA).clone().multiplyScalar(b.tone);
  const a = new THREE.Vector3(), z = new THREE.Vector3();
  function cards(lod) {
    const list = [], segs = lod === 0 ? 2 : 1;
    W.forEach((w, wi) => {
      if (lod === 1 && wi % 2) return;
      for (const b of w.br) {
        const r0 = trunkR * (1 - w.y / H) * 0.8;
        for (let s = 0; s < segs; s++) {
          const ua = 0.1 + (s / segs) * 0.9, ub = 0.1 + ((s + 1) / segs) * 0.9, um = (ua + ub) / 2;
          branchAt(w, b, ua, r0, a); branchAt(w, b, ub, r0, z);
          const h = a.distanceTo(z) * (lod === 0 ? 1.4 : 1.25);
          const wid = Math.min(h * 0.95, b.len * 0.62 * (1.1 - um * 0.45)) * (lod === 0 ? 1.1 : 1.55);
          list.push({ m: a.clone().add(z).multiplyScalar(0.5), d: z.clone().sub(a).normalize(), h, w: wid, roll: b.roll, fold: lod === 0 ? 0.42 : 0, aoA: ao(w, ua), aoB: ao(w, ub), color: tint(w, b) });
        }
      }
    });
    for (let i = 0; i < 2; i++) {                                  // leader
      const ang = i * Math.PI / 2;
      list.push({ m: new THREE.Vector3(0, H - 0.9, 0), d: new THREE.Vector3(Math.cos(ang) * 0.05, 1, Math.sin(ang) * 0.05).normalize(), h: 2.2, w: 0.9, roll: ang, fold: lod === 0 ? 0.1 : 0, aoA: 0.8, aoB: 1, color: cA });
    }
    return sprayCards(list, CELL.needle);
  }
  const coreH = H - crownBase;
  return {
    near: () => merge([
      trunk({ h: H * 0.92, r0: trunkR, r1: trunkR * 0.12, segs: 7, hseg: 3, color: bark }),
      cone({ y: crownBase, r: crownR * 0.5, h: coreH, segs: 7, rough: 0.12, seed, color: alt, dark: 0.42 }),
      cards(0),
    ]),
    mid: () => merge([
      trunk({ h: crownBase + 1, r0: trunkR, r1: trunkR * 0.6, segs: 5, hseg: 1, color: bark }),
      cone({ y: crownBase, r: crownR * 0.62, h: coreH, segs: 6, rough: 0.1, seed, color: alt, dark: 0.5 }),
      cards(1),
    ]),
    far: () => merge([
      trunk({ h: crownBase + 1, r0: trunkR, r1: trunkR * 0.6, segs: 3, hseg: 1, color: bark }),
      cone({ y: crownBase - 0.5, r: crownR * 0.95, h: coreH + 0.5, segs: 6, rough: 0.12, color, dark: 0.72 }),
    ]),
    dist: () => cone({ y: crownBase * 0.5, r: crownR * 0.95, h: H - crownBase * 0.5, segs: 4, rough: 0, color, dark: 0.72 }),
  };
}

// ---------- species ----------
// Sizes in metres at scale 1 (crowns are further widened by CLOSURE when placed).
const R11 = rng(11), R12 = rng(12), R13 = rng(13), R14 = rng(14), R15 = rng(15), R16 = rng(16);
const SPECIES = [
  { key: 'banyan', name: '榕樹', size: [0.85, 1.2], ...leafy({
    trunks: () => [...ring(3, (i, a) => trunk({ x: Math.cos(a) * 0.5, z: Math.sin(a) * 0.5, h: 6.5, r0: 0.55, r1: 0.35, lean: [Math.cos(a) * 0.35, Math.sin(a) * 0.35], color: '#6f665b' })),
                   ...ring(9, (i, a) => trunk({ x: Math.cos(a) * (3 + (i % 3)), z: Math.sin(a) * (3 + (i % 3)), h: 6.6, r0: 0.07, r1: 0.05, segs: 3, hseg: 1, color: '#77705f' }))],
    midTrunk: () => trunk({ h: 6.5, r0: 0.7, r1: 0.45, segs: 5, hseg: 1 }),
    clusters: [{ y: 9.2, r: 4.6, sy: 0.55, color: '#3f6d36' },
               ...ring(6, (i, a) => ({ x: Math.cos(a) * 5.4, y: 7.6 + R11() * 1.2, z: Math.sin(a) * 5.4, r: 3.6 + R11(), sy: 0.55, color: i % 3 ? '#3b6834' : '#46763a' }))],
  }) },
  { key: 'camphor', name: '樟樹', size: [0.85, 1.2], ...leafy({ skirt: 0.85,
    trunks: () => [trunk({ h: 5.5, r0: 0.5, r1: 0.32, lean: [0.08, 0.05], color: '#6b5e4f' }),
                   ...ring(3, (i, a) => trunk({ h: 4, r0: 0.18, r1: 0.1, segs: 4, hseg: 1, y0: 4.0, lean: [Math.cos(a) * 0.6, Math.sin(a) * 0.6], color: '#6b5e4f' }))],
    midTrunk: () => trunk({ h: 5.5, segs: 5, hseg: 1, color: '#6b5e4f' }),
    clusters: [{ y: 9.8, r: 3.8, sy: 0.85, color: '#6f9a3e' },
               ...ring(5, (i, a) => ({ x: Math.cos(a) * 3.1, y: 7.6 + R12() * 1.5, z: Math.sin(a) * 3.1, r: 3.0 + R12() * 0.8, sy: 0.8, color: i % 2 ? '#6a9540' : '#78a346' }))],
  }) },
  { key: 'broadleaf', name: '常綠闊葉樹（楠、殼斗科）', size: [0.8, 1.25], ...leafy({ skirt: 0.9,
    trunks: () => [trunk({ h: 6, r0: 0.45, r1: 0.28, lean: [-0.06, 0.04], color: '#6a5f52' })],
    midTrunk: () => trunk({ h: 6, segs: 5, hseg: 1, color: '#6a5f52' }),
    clusters: [{ y: 11.4, r: 3.0, sy: 0.9, color: '#4d7a3a' },
               ...ring(7, (i, a) => ({ x: Math.cos(a) * (2.4 + R13() * 1.2), y: 7.8 + R13() * 3.4, z: Math.sin(a) * (2.4 + R13() * 1.2), r: 2.1 + R13() * 0.9, sy: 0.85, color: ['#4d7a3a', '#3f6c35', '#5b8840'][i % 3] }))],
  }) },
  { key: 'acacia', name: '相思樹', size: [0.8, 1.15], ...leafy({
    cell: CELL.acacia, density: 1.3,
    trunks: () => [trunk({ h: 6, r0: 0.28, r1: 0.16, lean: [0.35, 0.1], segs: 5, color: '#4e4337' }),
                   trunk({ h: 5.2, r0: 0.22, r1: 0.12, lean: [-0.3, -0.25], segs: 5, color: '#4e4337' })],
    midTrunk: () => trunk({ h: 6, r0: 0.3, r1: 0.18, segs: 4, hseg: 1 }),
    clusters: ring(6, (i, a) => ({ x: Math.cos(a) * (2.2 + R14() * 1.6), y: 6.8 + R14() * 1.8, z: Math.sin(a) * (2.2 + R14() * 1.6), r: 1.9 + R14() * 0.7, sy: 0.5, rough: 0.45, color: '#6b7d45' })),
  }) },
  { key: 'treefern', name: '筆筒樹（樹蕨）', size: [0.8, 1.2],
    near: () => merge([
      trunk({ h: 6.4, r0: 0.24, r1: 0.18, segs: 5, lean: [0.1, 0], color: '#3e3228' }),
      clump({ x: 0.64, y: 5.8, r: 0.45, detail: 0, color: '#4a3b2c' }),
      ...ring(11, (i, a) => frond({ base: [0.64, 5.9, 0], ang: a + (i % 2) * 0.2, len: 3.4 + (i % 3) * 0.3, width: 0.7, lift: 0.55, droop: 1.3, color: '#79a445' })),
    ]),
    mid: () => merge([trunk({ h: 6.4, r0: 0.25, r1: 0.2, segs: 4, hseg: 1 }), ...ring(6, (i, a) => frond({ base: [0, 5.9, 0], ang: a, len: 3.4, width: 0.8, segs: 2, lift: 0.5, droop: 1.3 }))]),
    far: () => clump({ y: 5.6, r: 3.2, sy: 0.35, detail: 0, color: '#79a445', dark: 0.85 }) },
  { key: 'bamboo', name: '竹叢', size: [0.85, 1.2], ...leafy({
    cell: CELL.bamboo, density: 1.4, coreR: 0.7,
    trunks: () => ring(12, (i, a) => { const d = 0.5 + R15() * 0.8; return trunk({ x: Math.cos(a) * d, z: Math.sin(a) * d, h: 10 + R15() * 3, r0: 0.08, r1: 0.05, segs: 3, hseg: 2, lean: [Math.cos(a) * 0.28, Math.sin(a) * 0.28], color: '#8fa55a' }); }),
    midTrunk: () => merge(ring(4, (i, a) => trunk({ x: Math.cos(a) * 0.7, z: Math.sin(a) * 0.7, h: 11, r0: 0.1, r1: 0.06, segs: 3, hseg: 1, lean: [Math.cos(a) * 0.25, Math.sin(a) * 0.25], color: '#8fa55a' }))),
    clusters: ring(8, (i, a) => ({ x: Math.cos(a) * (2.2 + R15()), y: 8.5 + R15() * 3, z: Math.sin(a) * (2.2 + R15()), r: 1.6 + R15() * 0.5, sy: 1.4, rough: 0.5, color: '#7a9e45' })),
  }) },
  { key: 'royalpalm', name: '大王椰子', size: [0.9, 1.15],
    near: () => merge([
      trunk({ h: 15, r0: 0.42, r1: 0.3, segs: 8, hseg: 4, color: '#b9b4a8' }),
      trunk({ h: 2.6, r0: 0.3, r1: 0.26, segs: 8, hseg: 1, y0: 14.1, color: '#6f8f3e' }),
      ...ring(10, (i, a) => frond({ base: [0, 16.6, 0], ang: a, len: 4.6, width: 0.75, lift: 0.4, droop: 1.6, segs: 6, color: '#6b9443' })),
    ]),
    mid: () => merge([trunk({ h: 16, r0: 0.42, r1: 0.3, segs: 5, hseg: 1, color: '#b9b4a8' }), ...ring(6, (i, a) => frond({ base: [0, 16.4, 0], ang: a, len: 4.4, width: 0.8, segs: 2, droop: 1.6, color: '#6b9443' }))]),
    far: () => merge([trunk({ h: 16, r0: 0.4, r1: 0.3, segs: 3, hseg: 1, color: '#b9b4a8' }), clump({ y: 16.2, r: 3.6, sy: 0.4, detail: 0, color: '#6b9443', dark: 0.85 })]) },
  { key: 'goldenrain', name: '台灣欒樹', size: [0.85, 1.15], ...leafy({ skirt: 0.8,
    trunks: () => [trunk({ h: 5.5, r0: 0.4, r1: 0.26, color: '#6a5e52' })],
    midTrunk: () => trunk({ h: 5.5, segs: 5, hseg: 1, color: '#6a5e52' }),
    clusters: [{ y: 10, r: 3, sy: 0.8, color: '#5f8a3c' },
               ...ring(6, (i, a) => ({ x: Math.cos(a) * 2.8, y: 8 + R16() * 1.6, z: Math.sin(a) * 2.8, r: 2.7 + R16() * 0.6, sy: 0.8, color: ['#5f8a3c', '#c7a53a', '#5f8a3c', '#b8795a', '#6a933f', '#c7a53a'][i] }))],
  }) },
  // Understorey of dense forest (shrubs, saplings, ferns): not a tree of the fraction, it fills the floor between
  // trunks so a closed forest reads as one mass. Near and mid only.
  { key: 'understorey', name: '林下灌木', size: [0.9, 1.4], under: true,
    near: () => merge(ring(3, (i, a) => [
      clump({ x: Math.cos(a) * 1.8, y: 1.6 + 0.7 * i, z: Math.sin(a) * 1.8, r: 2.0 + 0.3 * i, sy: 0.75, detail: 0, rough: 0.5, dark: 0.62, seed: 60 + i, color: '#3a5e2e' }),
      leafCards({ x: Math.cos(a) * 1.8, y: 1.7 + 0.7 * i, z: Math.sin(a) * 1.8, r: 2.0 + 0.3 * i, sy: 0.75, n: 9, size: 2.1, cell: CELL.broad, seed: 70 + i, color: '#41672f' }),
    ]).flat()),
    mid: () => merge([clump({ x: 0.6, y: 2.0, r: 3.0, sy: 0.7, detail: 0, rough: 0.5, dark: 0.6, seed: 63, color: '#3a5e2e' }),
                      clump({ x: -1.2, y: 1.6, z: 1.0, r: 2.3, sy: 0.7, detail: 0, rough: 0.5, dark: 0.55, seed: 64, color: '#355a2c' })]),
    far: () => clump({ y: 1.2, r: 2.6, sy: 0.5, detail: 0, color: '#3a5e2e', dark: 0.6 }) },
  // Chamaecyparis: tall, broad irregular crown of flat, drooping sprays
  { key: 'cypress', name: '紅檜／扁柏', size: [0.85, 1.25], ...conifer({
    H: 28, crownBase: 9, crownR: 5.6, trunkR: 0.95, seed: 31, color: '#3d6c48', alt: '#2f5a3e', bark: '#6a5243',
    profile: 0.7, round: 0.6, pitch: [0.0, 0.35], droop: [0.55, 0.2], spacing: 1.45 }) },
  // Tsuga: layered, horizontal branches with drooping tips, a broad flattish top
  { key: 'hemlock', name: '鐵杉', size: [0.85, 1.2], ...conifer({
    H: 24, crownBase: 7, crownR: 4.9, trunkR: 0.72, seed: 37, color: '#355c3c', alt: '#2c5034', bark: '#55483e',
    profile: 0.55, round: 0.8, pitch: [-0.05, 0.2], droop: [0.7, 0.3], spacing: 1.4 }) },
  // Abies kawakamii: a narrow, dense spire, branches angled up
  { key: 'fir', name: '冷杉', size: [0.85, 1.15], ...conifer({
    H: 20, crownBase: 3.5, crownR: 3.3, trunkR: 0.5, seed: 41, color: '#2b4d35', alt: '#24432e', bark: '#4f4640',
    profile: 1.0, pitch: [0.12, 0.5], droop: [0.28, 0.1], spacing: 1.15 }) },
];

// Species mix by elevation (Su 1984 zones) and context. urban: the pixel never gets much canopy (street/park trees).
function speciesWeights(z, urban, bambooPatch, acaciaStand) {
  if (z < 500) {
    if (urban) return { banyan: 0.3, camphor: 0.22, goldenrain: 0.17, broadleaf: 0.12, royalpalm: z < 40 ? 0.07 : 0, acacia: 0.04, bamboo: 0.03, treefern: 0.02 };
    return { broadleaf: 0.38, acacia: 0.1 + 0.35 * acaciaStand, bamboo: 0.06 + 0.5 * bambooPatch, treefern: z > 120 ? 0.14 : 0.05,
             camphor: 0.08, banyan: z < 200 ? 0.06 : 0.02, goldenrain: 0.04 };
  }
  if (z < 1500) return { broadleaf: 0.6, treefern: 0.14, bamboo: 0.04 + 0.3 * bambooPatch, camphor: 0.05, cypress: z > 1200 ? 0.2 : 0.02 };
  if (z < 2500) return { cypress: 0.55, broadleaf: 0.33, hemlock: 0.12 };
  if (z < 3100) return { hemlock: 0.6, fir: 0.25, cypress: 0.15 };
  return { fir: 0.85, hemlock: 0.15 };
}
function pick(weights, u) {
  let total = 0; for (const k in weights) total += weights[k];
  let acc = 0; for (const k in weights) { acc += weights[k] / total; if (u <= acc) return k; }
  return Object.keys(weights)[0];
}

// ---------- materials ----------
const GEOM_DECL = /* glsl */`
attribute float aPart; attribute vec3 aCol; attribute vec3 aTint; attribute float aThr; attribute vec2 aUv;
attribute float aFa; attribute float aFb; attribute float aNd;
uniform float uT; uniform float uTime; uniform float uWindS;
varying vec2 vLeafUv; varying float vPart;`;
const GEOM_BODY = /* glsl */`
  float fT = mix(aFa, aFb, uT) / 100.0;
  float sT = smoothstep(aThr - 0.1, aThr + 0.1, fT);
  transformed *= max(sT, 0.0);
  vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  float hh = max(position.y, 0.0);
  float gust = 0.75 + 0.25 * sin(uTime * 0.37 + ip.x * 0.004);
  float sway = sin(uTime * (1.0 + 0.9 * uWindS) + ip.x * 0.043 + ip.z * 0.061) * 0.0006 * (0.3 + 1.4 * uWindS) * gust * hh * hh * step(0.5, aPart);
  // leaf cards also flutter a little on their own
  float flut = step(1.5, aPart) * sin(uTime * (3.0 + 2.0 * uWindS) + dot(position, vec3(1.7, 2.3, 1.1)) + ip.x) * 0.05 * (0.4 + uWindS);
  transformed.x += sway + flut; transformed.z += sway * 0.7; transformed.y += flut * 0.6;
  vLeafUv = aUv; vPart = aPart;`;
const NOISE = /* glsl */`
float h13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vn3(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h13(i), h13(i + vec3(1,0,0)), f.x), mix(h13(i + vec3(0,1,0)), h13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h13(i + vec3(0,0,1)), h13(i + vec3(1,0,1)), f.x), mix(h13(i + vec3(0,1,1)), h13(i + vec3(1,1,1)), f.x), f.y), f.z);
}`;

// Cards are double-sided but keep the crown normal on both faces (a leaf lit from behind still belongs to a lit crown).
function makeMaterial(uniforms, leafTex) {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uT: uniforms.uT, uTime: uniforms.uTime, uSunView: uniforms.uSunView, uLeaf: { value: leafTex } });
    shareUniforms(sh, uniforms, ['uWindS', 'uCloud', 'uCloudOff', 'uSunDir', 'uCloudH', 'uDay']);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${GEOM_DECL}\nvarying vec3 vTreeCol; varying vec3 vLeafPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${GEOM_BODY}
        float fading = (1.0 - sT) * step(aFb + 0.5, aFa);
        vec3 base = aCol * mix(vec3(1.0), aTint, step(0.5, aPart));
        base = mix(base, vec3(0.42, 0.27, 0.13), clamp(fading * 1.6, 0.0, 1.0) * step(0.5, aPart));
        base = mix(base, vec3(dot(base, vec3(0.3, 0.59, 0.11))), 0.6 * aNd);
        vTreeCol = base;
        vLeafPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vTreeCol; varying vec3 vLeafPos; varying vec2 vLeafUv; varying float vPart;
        uniform vec3 uSunView; uniform sampler2D uLeaf;\n${NOISE}\n${CLOUD_GLSL}`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `
        float card = step(1.5, vPart);
        vec4 lt = card > 0.5 ? texture2D(uLeaf, vLeafUv) : vec4(1.0);
        if (lt.a < 0.42) discard;               // plain cut-out (alpha-to-coverage speckled at night)
        float dap = card > 0.5 ? 0.55 : vn3(vLeafPos * 0.85) * 0.6 + vn3(vLeafPos * 2.6) * 0.4;   // cards: the texture varies
        vec3 tc = vTreeCol * mix(0.95 + 0.1 * dap, 0.72 + 0.5 * dap, step(0.5, vPart)) * mix(vec3(1.0), lt.rgb * 1.25, card) * cloudShadow(vLeafPos);
        vec4 diffuseColor = vec4(tc, 1.0);`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        if (vPart > 1.5) normal = normalize(vNormal);`)
      .replace('#include <opaque_fragment>', `
        // light through leaves when looking toward the sun
        float aoL = clamp(dot(vTreeCol, vec3(0.3, 0.59, 0.11)) * 3.2, 0.0, 1.0);
        float trans = pow(max(dot(-normalize(vViewPosition), uSunView), 0.0), 5.0) * (0.35 + 0.9 * card) * aoL * aoL * step(0.5, vPart);
        outgoingLight += diffuseColor.rgb * trans * vec3(1.0, 0.93, 0.62);
        // sky and bounce light through the canopy: crown undersides and trunks in shade are dim, not black
        outgoingLight += diffuseColor.rgb * mix(0.03, 0.2, uDay) * mix(0.6, 1.0, step(0.5, vPart));
        #include <opaque_fragment>`);
  };
  return m;
}

function makeDepthMaterial(uniforms, leafTex) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uT: uniforms.uT, uTime: uniforms.uTime, uWindS: uniforms.uWindS, uLeaf: { value: leafTex } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${GEOM_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${GEOM_BODY}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vLeafUv; varying float vPart; uniform sampler2D uLeaf;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (vPart > 1.5 && texture2D(uLeaf, vLeafUv).a < 0.4) discard;`);
  };
  return m;
}

// Mean gap-filled cover of each aligned st x st block per year (pixels of the other zone and water count as 0, so the
// widened crowns spread over the block keep its cover) and its maximum over the years; cached on the tile.
function blockCover(tile, st, years) {
  tile.blk ??= {};
  const c = tile.blk[st];
  if (c && c.years === years) return c;
  const P = tile.P ?? Math.round(Math.sqrt(tile.z.length)), bw = P / st, nb = bw * bw, inv = 1 / (st * st);
  const ok = new Uint8Array(P * P), bi = new Int32Array(P * P);
  for (let k = 0; k < P * P; k++) {
    ok[k] = (!tile.own || tile.own[k]) && (tile.land ? tile.land[k] : tile.z[k] * EXAG >= 1.2) ? 1 : 0;
    bi[k] = ((k / P | 0) / st | 0) * bw + ((k % P) / st | 0);
  }
  const filled = {}, maxF = new Uint8Array(nb), sum = new Float32Array(nb);
  for (const y of years) {
    const a = tile.filled[y], out = new Uint8Array(nb);
    sum.fill(0);
    for (let k = 0; k < a.length; k++) if (ok[k]) sum[bi[k]] += a[k];
    for (let b = 0; b < nb; b++) { out[b] = Math.round(sum[b] * inv); if (out[b] > maxF[b]) maxF[b] = out[b]; }
    filled[y] = out;
  }
  tile.blkP = P;
  return (tile.blk[st] = { years, filled, maxF });
}

// ---------- forest ----------
export class Forest {
  constructor(scene, uniforms) {
    this.scene = scene;
    this.buckets = new Map();
    const leafTex = leafAtlas();
    const mat = makeMaterial(uniforms, leafTex), depth = makeDepthMaterial(uniforms, leafTex);
    SPECIES.forEach((sp, si) => {
      for (const lod of LODS) {
        this.buckets.set(`${sp.key}:${lod}`, { sp, lod, template: lod === 'grove' ? grove(sp.dist ?? sp.far, si) : (sp[lod] ?? sp.far)(), mat, depth, mesh: null, cap: 0, n: 0, refs: null });
      }
    });
    this.tileList = [];
    this.visible = true;
  }

  get triangles() {
    let t = 0;
    for (const b of this.buckets.values()) t += b.n * b.template.attributes.position.count / 3;
    return t;
  }

  set visible(v) { this._visible = v; for (const b of this.buckets.values()) if (b.mesh) b.mesh.visible = v; }
  get visible() { return this._visible; }

  ensure(b, n) {
    if (n <= b.cap) return;
    const cap = Math.max(256, 2 ** Math.ceil(Math.log2(n)));
    if (b.mesh) { this.scene.remove(b.mesh); b.mesh.geometry.dispose(); b.mesh.dispose(); }
    const g = b.template.clone();
    for (const [name, size] of INST_ATTRS) g.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size));
    const mesh = new THREE.InstancedMesh(g, b.mat, cap);
    Object.assign(mesh, { customDepthMaterial: b.depth, castShadow: b.lod === 'near' || b.lod === 'mid', receiveShadow: b.lod === 'near', frustumCulled: false, visible: this._visible });
    // casters come first: the shadow pass draws only them (trees inside the shadow box), the view draws all
    mesh.onBeforeShadow = () => { mesh.count = b.nCast; };
    mesh.onAfterShadow = () => { mesh.count = b.n; };
    this.scene.add(mesh);
    Object.assign(b, { mesh, cap, refs: new Int32Array(cap * 2) });
  }

  // Rebuild instances for pixels within `radius` of `focus` that lie inside the view cone (horizontal half-angle
  // `half` around `camDir`; everything near the focus is kept regardless); detail level by distance to the camera,
  // relative to the tree's size. Near/mid trees within `shadowR` of the focus cast shadows.
  // Far away, crowns are a few screen pixels: beyond `thin` from the camera only every 2nd/4th/8th pixel (power-of-two
  // grids, so a coarser ring is a subset of a finer one) carries trees, spread over its block and widened by the
  // stride so canopy cover is unchanged; the instance count then grows with log(radius) instead of radius². The outer
  // 20 % of the radius is thinned out pixel by pixel, so the trees dissolve into the terrain's canopy instead of
  // ending in a line.
  // `pixAng`: the angle of one screen pixel (radians); it caps the stride so widened crowns never read as blobs.
  build(ds, frame, focus, radius, years, camPos, camDir = null, half = Math.PI, nearDist = NEAR_DIST, shadowR = Infinity, thin = Infinity, pixAng = 0.001) {
    // scratch output per bucket and caster/non-caster (typed arrays, grown as needed and reused across builds)
    if (!this.lists) {
      this.bucketArr = [...this.buckets.values()];
      this.lists = this.bucketArr.flatMap(() => [0, 1].map(() => ({ n: 0, cap: 0, m: null, tint: null, thr: null, refs: null })));
      this.spIndex = Object.fromEntries(SPECIES.map((sp, i) => [sp.key, i]));
    }
    const lists = this.lists, nL = LODS.length;
    for (const L of lists) L.n = 0;
    const sh2 = shadowR * shadowR;
    // one instance: rotation about y, then scale, then translation (column-major); casters into the first list
    const emit = (si, lod, px, py, pz, cs, sn, sx, sy, sz, rand, thr, ti, k) => {
      const cast = lod < 2 && (px - focus.x) ** 2 + (pz - focus.z) ** 2 < sh2;
      const L = lists[(si * nL + lod) * 2 + (cast ? 0 : 1)];
      const n = push(L), m = L.m, o = n * 16;
      m[o] = cs * sx; m[o + 1] = 0; m[o + 2] = -sn * sx; m[o + 3] = 0;
      m[o + 4] = 0; m[o + 5] = sy; m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = sn * sz; m[o + 9] = 0; m[o + 10] = cs * sz; m[o + 11] = 0;
      m[o + 12] = px; m[o + 13] = py; m[o + 14] = pz; m[o + 15] = 1;
      const hue = rand(), val = 0.86 + rand() * 0.26;
      L.tint[n * 3] = val * (0.94 + hue * 0.1); L.tint[n * 3 + 1] = val * (0.97 + hue * 0.06); L.tint[n * 3 + 2] = val * (0.9 + (1 - hue) * 0.12);
      L.thr[n] = thr;
      L.refs[n * 2] = ti | (sl << 24); L.refs[n * 2 + 1] = k;
    };
    let sl = 0;                                                // log2 of the current block's stride (for refs)
    const push = (L) => {
      if (L.n === L.cap) {
        const cap = Math.max(1024, L.cap * 2), grow = (a, k, T) => { const b = new T(cap * k); if (a) b.set(a); return b; };
        L.m = grow(L.m, 16, Float32Array); L.tint = grow(L.tint, 3, Float32Array); L.thr = grow(L.thr, 1, Float32Array); L.refs = grow(L.refs, 2, Int32Array); L.cap = cap;
      }
      return L.n++;
    };
    this.tileList = [...ds.tiles.values()];
    const P = ds.tilePx, res = ds.res, r2 = radius * radius, near2 = nearDist * nearDist, mid2 = MID_DIST * MID_DIST, far2 = FAR_DIST * FAR_DIST;
    const edgeR = radius * 0.8, edge2 = edgeR * edgeR, thin2 = thin * thin;
    const cosHalf = Math.cos(Math.min(Math.PI, half));
    let dirX = 0, dirZ = 0;
    if (camDir) { const l = Math.hypot(camDir.x, camDir.z) || 1; dirX = camDir.x / l; dirZ = camDir.z / l; }
    const keepR2 = (0.45 * Math.hypot(camPos.x - focus.x, camPos.z - focus.z) + 150) ** 2;
    const cull = camDir && half < Math.PI;
    this.tileList.forEach((tile, ti) => {
      if (!tile.maxF || tile.maxF.years !== years) {             // max tree fraction over the timeline, once per tile
        const mf = new Uint8Array(P * P);
        for (const y of years) { const a = tile.filled[y]; for (let k = 0; k < mf.length; k++) if (a[k] > mf[k]) mf[k] = a[k]; }
        tile.maxF = mf; mf.years = years;
      }
      const [cx, , cz] = toWorld(frame, tile.zone, tile.x0 + ds.tileM / 2, tile.y0 + ds.tileM / 2, 0);
      if (Math.hypot(cx - focus.x, cz - focus.z) > radius + ds.tileM) return;
      if (cull) {                                               // whole tile behind the camera?
        const tx = cx - camPos.x, tz = cz - camPos.z, tl = Math.hypot(tx, tz);
        if (tl > ds.tileM && (tx * dirX + tz * dirZ) / tl < Math.cos(Math.min(Math.PI, half + Math.asin(Math.min(1, ds.tileM * 0.72 / tl))))) return;
      }
      // display-zone tiles map straight to world x/z, so only the rows and columns inside the radius are visited
      let r0 = 0, r1 = P - 1, c0 = 0, c1 = P - 1;
      if (tile.zone === DISPLAY_ZONE) {
        const X0 = focus.x + frame.ox, Y0 = frame.oy - focus.z;
        c0 = Math.max(0, Math.floor((X0 - radius - tile.x0) / res)); c1 = Math.min(P - 1, Math.ceil((X0 + radius - tile.x0) / res));
        r0 = Math.max(0, Math.floor((tile.y0 + ds.tileM - (Y0 + radius)) / res)); r1 = Math.min(P - 1, Math.ceil((tile.y0 + ds.tileM - (Y0 - radius)) / res));
      }
      const maxFs = tile.maxF, B = 8, bHalf = B * res * 0.71;
      // 8x8-pixel blocks: radius, view cone and stride are decided once per block (from its centre), and a block
      // at stride st only visits every st-th pixel of it
      for (let br = r0 - (r0 % B); br <= r1; br += B) for (let bcol = c0 - (c0 % B); bcol <= c1; bcol += B) {
        const kc = Math.min(P - 1, br + B / 2) * P + Math.min(P - 1, bcol + B / 2);
        const [bx, , bz] = toWorld(frame, tile.zone, tile.x[kc], tile.y[kc], 0);
        const bdx = bx - focus.x, bdz = bz - focus.z, bd2 = bdx * bdx + bdz * bdz;
        if (bd2 > (radius + bHalf) ** 2) continue;
        if (cull && bd2 > keepR2) {
          const vx = bx - camPos.x, vz = bz - camPos.z, vl = Math.hypot(vx, vz);
          if (vl > 120 + bHalf && (vx * dirX + vz * dirZ) / vl < Math.cos(Math.min(Math.PI, half + bHalf / vl))) continue;
        }
        const cdx = bx - camPos.x, cdy = tile.z[kc] * EXAG - camPos.y, cdz = bz - camPos.z, dc2 = cdx * cdx + cdy * cdy + cdz * cdz;
        let st = dc2 <= thin2 ? 1 : dc2 > 16 * thin2 ? 8 : dc2 > 4 * thin2 ? 4 : 2;     // stride by distance to the camera
        while (st > 1 && (st * 15) ** 2 > dc2 * (STRIDE_PX * pixAng) ** 2) st >>= 1;    // ... capped by on-screen size
        sl = 31 - Math.clz32(st);
        // a thinned pixel's trees follow its block's mean cover, not its own noisy value (else whole blocks blink)
        const blk = st > 1 ? blockCover(tile, st, years) : null, bw = P / st;
        for (let row = br; row < Math.min(br + B, r1 + 1); row += st) for (let col = bcol; col < Math.min(bcol + B, c1 + 1); col += st) {
          if (row < r0 || col < c0) continue;
          const k = row * P + col;
          const maxF = blk ? blk.maxF[(row / st) * bw + col / st] : maxFs[k];
          if (maxF < 8) continue;                                   // never enough cover for a tree
          if ((tile.own && !tile.own[k]) || (tile.land && !tile.land[k])) continue;   // other zone's pixel, or water
          if (!tile.land && tile.z[k] * EXAG < 1.2) continue;                    // no water mask: DEM ~0 m is drawn as water
          const [wx, , wz] = toWorld(frame, tile.zone, tile.x[k], tile.y[k], 0);
          const dx = wx - focus.x, dz = wz - focus.z, d2 = dx * dx + dz * dz;
          if (d2 > r2) continue;
          if (cull && d2 > keepR2) {
            const vx = wx - camPos.x, vz = wz - camPos.z, vl = Math.hypot(vx, vz);
            if (vl > 120 && (vx * dirX + vz * dirZ) / vl < cosHalf) continue;
          }
          const X = tile.x[k], Y = tile.y[k], z = tile.z[k];
          if (d2 > edge2 && ihash(X + 7, Y - 3) < (Math.sqrt(d2) - edgeR) / (radius - edgeR)) continue;
          const rand = rng(X * 73856093 ^ Y * 19349663);
          const bambooPatch = z < 1500 ? smooth(0.62, 0.78, vnoise2(X / 260 + 3.1, Y / 260)) : 0;
          const acaciaStand = z < 500 ? smooth(0.55, 0.75, vnoise2(X / 420 + 7.7, Y / 420)) : 0;
          const weights = speciesWeights(z, maxF < 45, bambooPatch, acaciaStand);
          const order = PERMS[Math.floor(rand() * 24)];
          for (let s = 0; s < SLOTS; s++) {
            const thr = (order[s] + 0.5) / SLOTS + (rand() - 0.5) * 0.18;
            if (thr * 100 > maxF + 8) { rand(); rand(); continue; }
            const sp = pick(weights, rand());
            // 2x2 sub-cells with strong jitter, so rows of the 30 m grid don't show at a distance
            // (a stride block spans st x st pixels from this one: its centre is (st - 1) / 2 pixels down and right)
            const bc = (st - 1) / 2 * res;
            const ox = bc + (((s % 2) - 0.5) * res * 0.46 + (rand() - 0.5) * res * 0.62) * st;
            const oz = bc + (((s >> 1) - 0.5) * res * 0.46 + (rand() - 0.5) * res * 0.62) * st;
            const cc = Math.min(P - 1, Math.max(0, col + Math.round(ox / res))), rr = Math.min(P - 1, Math.max(0, row + Math.round(oz / res)));
            const zz = st > 1 ? tile.z[rr * P + cc] : 0.5 * (z + tile.z[rr * P + cc]);
            const px = wx + ox, py = zz * EXAG - 0.4, pz = wz + oz;
            const si = this.spIndex[sp], spec = SPECIES[si];
            const ang = rand() * Math.PI * 2, cs = Math.cos(ang), sn = Math.sin(ang);
            const size = spec.size[0] + rand() * (spec.size[1] - spec.size[0]);
            const ddx = px - camPos.x, ddy = py - camPos.y, ddz = pz - camPos.z, c2 = (ddx * ddx + ddy * ddy + ddz * ddz) / (size * size);
            const lod = st > 1 ? 4 : c2 < near2 ? 0 : c2 < mid2 ? 1 : c2 < far2 ? 2 : 3;
            // widen crowns where the canopy is dense (street trees in sparse pixels stay slimmer); a stride block's
            // crowns are st x wider (same cover) and somewhat taller
            const wide = size * (1 + (CLOSURE - 1) * smooth(30, 80, maxF)) * st;
            const tall = size * (1 + (CLOSURE - 1) * 0.45 * smooth(30, 80, maxF)) * st ** 0.4;
            emit(si, lod, px, py, pz, cs, sn, wide * (0.9 + rand() * 0.2), tall * (0.84 + rand() * 0.32), wide * (0.9 + rand() * 0.2), rand, thr, ti, k);
          }
          // understorey in dense, non-urban forest: one clump per pixel, appears with the canopy
          if (maxF >= 55 && z < 3000 && st === 1) {
            const ru = rng((X * 83492791) ^ (Y * 2654435761) ^ 0x5bd1e995), th = 0.5 + ru() * 0.25;
            const ox = (ru() - 0.5) * res * 0.8, oz = (ru() - 0.5) * res * 0.8, px = wx + ox, pz = wz + oz;
            const sz = 0.9 + ru() * 0.5, ddx = px - camPos.x, ddz = pz - camPos.z, ddy = z * EXAG - camPos.y;
            const c2 = (ddx * ddx + ddy * ddy + ddz * ddz) / (sz * sz);
            if (c2 < mid2) {
              const ang = ru() * Math.PI * 2;
              emit(this.spIndex.understorey, c2 < near2 ? 0 : 1, px, z * EXAG - 0.3, pz, Math.cos(ang), Math.sin(ang), sz * 1.3, sz * (0.8 + ru() * 0.5), sz * 1.3, ru, th, ti, k);
            }
          }
        }
      }
    });
    this.bucketArr.forEach((b, i) => {
      const A = lists[i * 2], B = lists[i * 2 + 1], n = A.n + B.n;
      b.n = n; b.nCast = A.n;
      if (!n && !b.mesh) return;
      this.ensure(b, n);
      b.mesh.count = n;
      if (!n) return;
      const g = b.mesh.geometry.attributes;
      let o = 0;
      for (const L of [A, B]) {
        if (!L.n) continue;
        b.mesh.instanceMatrix.array.set(L.m.subarray(0, L.n * 16), o * 16);
        g.aTint.array.set(L.tint.subarray(0, L.n * 3), o * 3); g.aThr.array.set(L.thr.subarray(0, L.n), o);
        b.refs.set(L.refs.subarray(0, L.n * 2), o * 2);
        o += L.n;
      }
      b.mesh.instanceMatrix.needsUpdate = true;
      g.aTint.needsUpdate = g.aThr.needsUpdate = true;
    });
  }

  setYears(yA, yB) {
    for (const b of this.buckets.values()) {
      if (!b.mesh || !b.n) continue;
      const g = b.mesh.geometry.attributes;
      for (let i = 0; i < b.n; i++) {
        const r = b.refs[i * 2], t = this.tileList[r & 0xffffff], k = b.refs[i * 2 + 1], sl = r >>> 24;
        if (sl) {
          const P = t.blkP, bk = ((k / P | 0) >> sl) * (P >> sl) + ((k % P) >> sl), f = t.blk[1 << sl].filled;
          g.aFa.array[i] = f[yA][bk]; g.aFb.array[i] = f[yB][bk];
        } else {
          g.aFa.array[i] = t.filled[yA][k];
          g.aFb.array[i] = t.filled[yB][k];
        }
        g.aNd.array[i] = t.nodata[yA][k] | t.nodata[yB][k];
      }
      g.aFa.needsUpdate = g.aFb.needsUpdate = g.aNd.needsUpdate = true;
    }
  }

  get count() { let n = 0; for (const b of this.buckets.values()) n += b.n; return n; }
  get stats() {
    const out = {};
    for (const b of this.buckets.values()) if (b.n) out[`${b.sp.key}:${b.lod}`] = b.n;
    return out;
  }
}

export const SPECIES_INFO = SPECIES.map(s => ({ key: s.key, name: s.name }));

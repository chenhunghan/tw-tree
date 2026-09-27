// Procedural Taiwanese trees, instanced. Each 30 m pixel has SLOTS candidate trees; slot k appears when the pixel's
// tree fraction passes its threshold, so visible trees ~ fraction x SLOTS (illustrative, not individual trees).
// Species follow Taiwan's elevation zones (Su 1984) plus urban planting; two levels of detail keep triangle counts low.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EXAG, toWorld } from './terrain.js';

const SLOTS = 4;
export const NEAR_DIST = 850;          // metres from the camera: detailed geometry inside, simple outside
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
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const C = (hex) => new THREE.Color(hex);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---------- geometry parts: every part carries position, normal, aCol (colour x baked AO), aPart (0 wood, 1 foliage) ----------
function finish(geo, part, colorAt) {
  if (geo.index) geo = geo.toNonIndexed();
  if (geo.attributes.uv) geo.deleteAttribute('uv');
  const p = geo.attributes.position, n = p.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const c = colorAt(i, p.getX(i), p.getY(i), p.getZ(i)); col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2]; }
  geo.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n).fill(part), 1));
  return geo;
}

// A lumpy foliage cluster: displaced icosphere, normals blended toward the sphere for a soft, volumetric look.
function clump({ x = 0, y = 0, z = 0, r = 3, sy = 1, detail = 1, rough = 0.32, seed = 0, color, ao = 0.5 }) {
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
    const k = (ao + (1 - ao) * smooth(-0.9, 0.85, uy)) * (0.86 + 0.28 * hash3(ux * 9 + seed, uy * 9, uz * 9));
    return [c.r * k, c.g * k, c.b * k];
  });
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

function cone({ y = 0, r = 3, h = 5, segs = 8, rough = 0.18, seed = 0, color }) {
  const g = new THREE.ConeGeometry(r, h, segs, 2, true).translate(0, y + h / 2, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const d = 1 + rough * (hash3(p.getX(i) * 3 + seed, p.getY(i), p.getZ(i) * 3) - 0.5) * 2;
    p.setXYZ(i, p.getX(i) * d, p.getY(i) - (1 - (p.getY(i) - y) / h) * rough * 0.8, p.getZ(i) * d);   // droopy rim
  }
  g.computeVertexNormals();
  const c = C(color);
  return finish(g, 1, (i, px, py) => { const k = 0.55 + 0.45 * smooth(y, y + h, py); return [c.r * k, c.g * k, c.b * k]; });
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
const ring = (n, fn) => Array.from({ length: n }, (_, i) => fn(i, (i / n) * Math.PI * 2));

// ---------- species ----------
// near: detailed (inside NEAR_DIST); mid: ~40 triangles. Sizes in metres at scale 1.
const SPECIES = [
  { key: 'banyan', name: '榕樹', size: [0.85, 1.2],
    near: () => { const r = rng(11); return merge([
      ...ring(3, (i, a) => trunk({ x: Math.cos(a) * 0.5, z: Math.sin(a) * 0.5, h: 6.5, r0: 0.55, r1: 0.35, lean: [Math.cos(a) * 0.35, Math.sin(a) * 0.35], color: '#6f665b' })),
      ...ring(9, (i, a) => trunk({ x: Math.cos(a) * (3 + r() * 2.5), z: Math.sin(a) * (3 + r() * 2.5), h: 6.6, r0: 0.07, r1: 0.05, segs: 3, hseg: 1, color: '#77705f' })),
      clump({ y: 9.2, r: 4.6, sy: 0.55, seed: 1, color: '#3f6d36' }),
      ...ring(6, (i, a) => clump({ x: Math.cos(a) * 5.4, y: 7.6 + r() * 1.2, z: Math.sin(a) * 5.4, r: 3.6 + r(), sy: 0.55, seed: i + 2, detail: i % 2, color: i % 3 ? '#3b6834' : '#46763a' })),
    ]); },
    mid: () => merge([trunk({ h: 6.5, r0: 0.7, r1: 0.45, segs: 5, hseg: 1 }), clump({ y: 8.4, r: 7.2, sy: 0.5, detail: 0, color: '#3f6d36' })]) },

  { key: 'camphor', name: '樟樹', size: [0.85, 1.2],
    near: () => { const r = rng(12); return merge([
      trunk({ h: 7, r0: 0.5, r1: 0.32, lean: [0.08, 0.05], color: '#5f5244' }),
      ...ring(3, (i, a) => trunk({ x: 0, z: 0, h: 4, r0: 0.18, r1: 0.1, segs: 4, hseg: 1, y0: 5.4, lean: [Math.cos(a) * 0.6, Math.sin(a) * 0.6], color: '#5f5244' })),
      clump({ y: 11.5, r: 3.8, sy: 0.85, seed: 3, color: '#6f9a3e' }),
      ...ring(5, (i, a) => clump({ x: Math.cos(a) * 3.1, y: 9.3 + r() * 1.5, z: Math.sin(a) * 3.1, r: 3.0 + r() * 0.8, sy: 0.8, seed: i + 7, detail: 1, color: i % 2 ? '#6a9540' : '#78a346' })),
    ]); },
    mid: () => merge([trunk({ h: 7, segs: 5, hseg: 1 }), clump({ y: 10.5, r: 5.4, sy: 0.8, detail: 0, color: '#6f9a3e' })]) },

  { key: 'broadleaf', name: '常綠闊葉樹（楠、殼斗科）', size: [0.8, 1.25],
    near: () => { const r = rng(13); return merge([
      trunk({ h: 8, r0: 0.45, r1: 0.28, lean: [-0.06, 0.04], color: '#5a4d40' }),
      clump({ y: 12.6, r: 3.0, sy: 0.9, seed: 5, color: '#4d7a3a' }),
      ...ring(7, (i, a) => clump({ x: Math.cos(a) * (2.4 + r() * 1.2), y: 9.5 + r() * 3, z: Math.sin(a) * (2.4 + r() * 1.2), r: 2.1 + r() * 0.9, sy: 0.85, seed: i + 13, detail: i % 3 ? 0 : 1, color: ['#4d7a3a', '#3f6c35', '#5b8840'][i % 3] })),
    ]); },
    mid: () => merge([trunk({ h: 8, segs: 5, hseg: 1 }), clump({ y: 11.3, r: 4.6, sy: 0.85, detail: 0, color: '#4a7639' })]) },

  { key: 'acacia', name: '相思樹', size: [0.8, 1.15],
    near: () => { const r = rng(14); return merge([
      trunk({ h: 6, r0: 0.28, r1: 0.16, lean: [0.35, 0.1], segs: 5, color: '#4e4337' }),
      trunk({ h: 5.2, r0: 0.22, r1: 0.12, lean: [-0.3, -0.25], segs: 5, color: '#4e4337' }),
      ...ring(6, (i, a) => clump({ x: Math.cos(a) * (2.2 + r() * 1.6), y: 6.8 + r() * 1.8, z: Math.sin(a) * (2.2 + r() * 1.6), r: 1.8 + r() * 0.7, sy: 0.45, rough: 0.45, seed: i + 21, detail: 0, color: '#6b7d45' })),
    ]); },
    mid: () => merge([trunk({ h: 6, r0: 0.3, r1: 0.18, segs: 4, hseg: 1 }), clump({ y: 7.6, r: 4.4, sy: 0.42, detail: 0, rough: 0.4, color: '#6b7d45' })]) },

  { key: 'treefern', name: '筆筒樹（樹蕨）', size: [0.8, 1.2], doubleSide: true,
    near: () => merge([
      trunk({ h: 6.4, r0: 0.24, r1: 0.18, segs: 5, lean: [0.1, 0], color: '#3e3228' }),
      clump({ x: 0.64, y: 5.8, r: 0.45, detail: 0, color: '#4a3b2c' }),
      ...ring(11, (i, a) => frond({ base: [0.64, 5.9, 0], ang: a + (i % 2) * 0.2, len: 3.4 + (i % 3) * 0.3, width: 0.7, lift: 0.55, droop: 1.3, color: '#79a445' })),
    ]),
    mid: () => merge([trunk({ h: 6.4, r0: 0.25, r1: 0.2, segs: 4, hseg: 1 }), ...ring(6, (i, a) => frond({ base: [0, 5.9, 0], ang: a, len: 3.4, width: 0.8, segs: 2, lift: 0.5, droop: 1.3 }))]) },

  { key: 'bamboo', name: '竹叢', size: [0.85, 1.2],
    near: () => { const r = rng(15); return merge([
      ...ring(12, (i, a) => { const d = 0.5 + r() * 0.8; return trunk({ x: Math.cos(a) * d, z: Math.sin(a) * d, h: 10 + r() * 3, r0: 0.08, r1: 0.05, segs: 3, hseg: 2, lean: [Math.cos(a) * 0.28, Math.sin(a) * 0.28], color: '#8fa55a' }); }),
      ...ring(8, (i, a) => clump({ x: Math.cos(a) * (2.2 + r()), y: 8.5 + r() * 3, z: Math.sin(a) * (2.2 + r()), r: 1.4 + r() * 0.5, sy: 1.5, rough: 0.5, seed: i + 31, detail: 0, color: '#7a9e45' })),
    ]); },
    mid: () => merge([...ring(5, (i, a) => trunk({ x: Math.cos(a) * 0.7, z: Math.sin(a) * 0.7, h: 11, r0: 0.1, r1: 0.06, segs: 3, hseg: 1, lean: [Math.cos(a) * 0.25, Math.sin(a) * 0.25], color: '#8fa55a' })),
                      clump({ y: 9.5, r: 3.2, sy: 1.1, rough: 0.5, detail: 0, color: '#7a9e45' })]) },

  { key: 'royalpalm', name: '大王椰子', size: [0.9, 1.15], doubleSide: true,
    near: () => merge([
      trunk({ h: 15, r0: 0.42, r1: 0.3, segs: 8, hseg: 4, color: '#b9b4a8' }),
      trunk({ h: 2.6, r0: 0.3, r1: 0.26, segs: 8, hseg: 1, y0: 14.1, color: '#6f8f3e' }),
      ...ring(10, (i, a) => frond({ base: [0, 16.6, 0], ang: a, len: 4.6, width: 0.75, lift: 0.4, droop: 1.6, segs: 6, color: '#6b9443' })),
    ]),
    mid: () => merge([trunk({ h: 16, r0: 0.42, r1: 0.3, segs: 5, hseg: 1, color: '#b9b4a8' }), ...ring(6, (i, a) => frond({ base: [0, 16.4, 0], ang: a, len: 4.4, width: 0.8, segs: 2, droop: 1.6, color: '#6b9443' }))]) },

  { key: 'goldenrain', name: '台灣欒樹', size: [0.85, 1.15],
    near: () => { const r = rng(16); return merge([
      trunk({ h: 6.5, r0: 0.4, r1: 0.26, color: '#5d5146' }),
      ...ring(6, (i, a) => clump({ x: Math.cos(a) * 2.8, y: 9 + r() * 1.6, z: Math.sin(a) * 2.8, r: 2.7 + r() * 0.6, sy: 0.8, seed: i + 41, detail: 1, color: ['#5f8a3c', '#c7a53a', '#5f8a3c', '#b8795a', '#6a933f', '#c7a53a'][i] })),
      clump({ y: 11, r: 3, sy: 0.8, seed: 47, color: '#5f8a3c' }),
    ]); },
    mid: () => merge([trunk({ h: 6.5, segs: 5, hseg: 1 }), clump({ y: 9.8, r: 4.8, sy: 0.8, detail: 0, color: '#8a9440' })]) },

  { key: 'cypress', name: '紅檜／扁柏', size: [0.85, 1.25],
    near: () => merge([
      trunk({ h: 14, r0: 0.9, r1: 0.5, segs: 7, color: '#7a4b35' }),
      ...[0, 1, 2, 3, 4].map(i => cone({ y: 9 + i * 3.6, r: 5.2 - i * 0.85, h: 6.2 - i * 0.5, seed: i, color: i % 2 ? '#2f5a3e' : '#35644a' })),
    ]),
    mid: () => merge([trunk({ h: 12, r0: 0.9, r1: 0.5, segs: 5, hseg: 1, color: '#7a4b35' }), cone({ y: 8, r: 5, h: 20, segs: 6, color: '#2f5a3e' })]) },

  { key: 'hemlock', name: '鐵杉', size: [0.85, 1.2],
    near: () => merge([
      trunk({ h: 12, r0: 0.7, r1: 0.4, segs: 6, color: '#5b4636' }),
      ...[0, 1, 2, 3, 4].map(i => clump({ y: 9 + i * 3, r: 4.4 - i * 0.6, sy: 0.35, rough: 0.4, seed: i + 51, detail: 1, color: '#2e5238' })),
    ]),
    mid: () => merge([trunk({ h: 12, r0: 0.7, r1: 0.4, segs: 5, hseg: 1 }), cone({ y: 8, r: 4.2, h: 16, segs: 6, color: '#2e5238' })]) },

  { key: 'fir', name: '冷杉', size: [0.85, 1.15],
    near: () => merge([
      trunk({ h: 8, r0: 0.5, r1: 0.3, segs: 6, color: '#4c3d31' }),
      ...[0, 1, 2, 3, 4, 5].map(i => cone({ y: 4 + i * 2.6, r: 3.2 - i * 0.45, h: 4.2, seed: i + 61, color: '#25452f' })),
    ]),
    mid: () => merge([trunk({ h: 6, r0: 0.5, r1: 0.3, segs: 4, hseg: 1 }), cone({ y: 3.5, r: 3.2, h: 16, segs: 6, color: '#25452f' })]) },
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
attribute float aPart; attribute vec3 aCol; attribute vec3 aTint; attribute float aThr;
attribute float aFa; attribute float aFb; attribute float aNd;
uniform float uT; uniform float uTime;`;
const GEOM_BODY = /* glsl */`
  float fT = mix(aFa, aFb, uT) / 100.0;
  float sT = smoothstep(aThr - 0.07, aThr + 0.07, fT);
  transformed *= max(sT, 0.0);
  vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  float hh = max(position.y, 0.0);
  float sway = sin(uTime * 1.3 + ip.x * 0.043 + ip.z * 0.061) * 0.0006 * hh * hh * step(0.5, aPart);
  transformed.x += sway; transformed.z += sway * 0.7;`;
const NOISE = /* glsl */`
float h13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vn3(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h13(i), h13(i + vec3(1,0,0)), f.x), mix(h13(i + vec3(0,1,0)), h13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h13(i + vec3(0,0,1)), h13(i + vec3(1,0,1)), f.x), mix(h13(i + vec3(0,1,1)), h13(i + vec3(1,1,1)), f.x), f.y), f.z);
}`;

function makeMaterial(uniforms, doubleSide) {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff, side: doubleSide ? THREE.DoubleSide : THREE.FrontSide });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uT: uniforms.uT, uTime: uniforms.uTime, uSunView: uniforms.uSunView });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${GEOM_DECL}\nvarying vec3 vTreeCol; varying vec3 vLeafPos; varying float vPart;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${GEOM_BODY}
        float fading = (1.0 - sT) * step(aFb + 0.5, aFa);
        vec3 base = aCol * mix(vec3(1.0), aTint, step(0.5, aPart));
        base = mix(base, vec3(0.42, 0.27, 0.13), clamp(fading * 1.6, 0.0, 1.0) * step(0.5, aPart));
        base = mix(base, vec3(dot(base, vec3(0.3, 0.59, 0.11))), 0.6 * aNd);
        vTreeCol = base; vPart = aPart;
        vLeafPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vTreeCol; varying vec3 vLeafPos; varying float vPart; uniform vec3 uSunView;\n${NOISE}`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `
        float dap = vn3(vLeafPos * 0.85) * 0.6 + vn3(vLeafPos * 2.6) * 0.4;
        vec3 tc = vTreeCol * mix(0.95 + 0.1 * dap, 0.7 + 0.55 * dap, step(0.5, vPart));
        vec4 diffuseColor = vec4(tc, opacity);`)
      .replace('#include <opaque_fragment>', `
        // light through leaves when looking toward the sun
        float trans = pow(max(dot(-normalize(vViewPosition), uSunView), 0.0), 5.0) * 0.5 * step(0.5, vPart);
        outgoingLight += diffuseColor.rgb * trans * vec3(1.0, 0.93, 0.62);
        #include <opaque_fragment>`);
  };
  return m;
}

function makeDepthMaterial(uniforms) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uT: uniforms.uT, uTime: uniforms.uTime });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${GEOM_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${GEOM_BODY}`);
  };
  return m;
}

// ---------- forest ----------
export class Forest {
  constructor(scene, uniforms) {
    this.scene = scene;
    this.buckets = new Map();
    for (const sp of SPECIES) {
      const mat = makeMaterial(uniforms, sp.doubleSide), depth = makeDepthMaterial(uniforms);
      for (const lod of ['near', 'mid']) {
        this.buckets.set(`${sp.key}:${lod}`, { sp, lod, template: sp[lod](), mat, depth, mesh: null, cap: 0, n: 0, refs: null });
      }
    }
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
    Object.assign(mesh, { customDepthMaterial: b.depth, castShadow: true, receiveShadow: true, frustumCulled: false, visible: this._visible });
    this.scene.add(mesh);
    Object.assign(b, { mesh, cap, refs: new Int32Array(cap * 2) });
  }

  // Rebuild instances for pixels within `radius` of `focus`; detail level by distance to the camera.
  build(ds, frame, focus, radius, years, camPos) {
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), sc = new THREE.Vector3();
    const lists = new Map([...this.buckets.keys()].map(k => [k, { m: [], tint: [], thr: [], refs: [] }]));
    this.tileList = [...ds.tiles.values()];
    const P = ds.tilePx, res = ds.res, r2 = radius * radius, near2 = NEAR_DIST * NEAR_DIST;
    this.tileList.forEach((tile, ti) => {
      const [cx, , cz] = toWorld(frame, tile.zone, tile.x0 + ds.tileM / 2, tile.y0 + ds.tileM / 2, 0);
      if (Math.hypot(cx - focus.x, cz - focus.z) > radius + ds.tileM) return;
      for (let row = 0; row < P; row++) for (let col = 0; col < P; col++) {
        const k = row * P + col;
        if (tile.own && !tile.own[k]) continue;                   // drawn by the zone-51 tile instead
        const [wx, , wz] = toWorld(frame, tile.zone, tile.x[k], tile.y[k], 0);
        const dx = wx - focus.x, dz = wz - focus.z;
        if (dx * dx + dz * dz > r2) continue;
        let maxF = 0;
        for (const y of years) { const v = tile.filled[y][k]; if (v > maxF) maxF = v; }
        if (maxF < 8) continue;                                   // never enough cover for a tree
        const X = tile.x[k], Y = tile.y[k], z = tile.z[k];
        const rand = rng(X * 73856093 ^ Y * 19349663);
        const bambooPatch = smooth(0.62, 0.78, vnoise(X / 260, Y / 260, 3.1));
        const acaciaStand = smooth(0.55, 0.75, vnoise(X / 420, Y / 420, 7.7));
        const weights = speciesWeights(z, maxF < 45, bambooPatch, acaciaStand);
        const order = [0, 1, 2, 3].sort(() => rand() - 0.5);
        for (let s = 0; s < SLOTS; s++) {
          const thr = (order[s] + 0.5) / SLOTS + (rand() - 0.5) * 0.18;
          if (thr * 100 > maxF + 8) { rand(); rand(); continue; }
          const sp = pick(weights, rand());
          // 2x2 sub-cells with strong jitter, so rows of the 30 m grid don't show at a distance
          const ox = ((s % 2) - 0.5) * res * 0.46 + (rand() - 0.5) * res * 0.62;
          const oz = ((s >> 1) - 0.5) * res * 0.46 + (rand() - 0.5) * res * 0.62;
          const cc = Math.min(P - 1, Math.max(0, col + Math.round(ox / res))), rr = Math.min(P - 1, Math.max(0, row + Math.round(oz / res)));
          const zz = 0.5 * (z + tile.z[rr * P + cc]);
          p.set(wx + ox, zz * EXAG - 0.4, wz + oz);
          const ddx = p.x - camPos.x, ddy = p.y - camPos.y, ddz = p.z - camPos.z;
          const lod = ddx * ddx + ddy * ddy + ddz * ddz < near2 ? 'near' : 'mid';
          const L = lists.get(`${sp}:${lod}`), spec = this.buckets.get(`${sp}:${lod}`).sp;
          q.setFromAxisAngle(up, rand() * Math.PI * 2);
          const size = spec.size[0] + rand() * (spec.size[1] - spec.size[0]);
          sc.set(size * (0.9 + rand() * 0.2), size * (0.88 + rand() * 0.24), size * (0.9 + rand() * 0.2));
          m4.compose(p, q, sc);
          for (let e = 0; e < 16; e++) L.m.push(m4.elements[e]);
          const hue = rand(), val = 0.86 + rand() * 0.26;
          L.tint.push(val * (0.94 + hue * 0.1), val * (0.97 + hue * 0.06), val * (0.9 + (1 - hue) * 0.12));
          L.thr.push(thr);
          L.refs.push(ti, k);
        }
      }
    });
    for (const [key, b] of this.buckets) {
      const L = lists.get(key), n = L.thr.length;
      b.n = n;
      if (!n && !b.mesh) continue;
      this.ensure(b, n);
      b.mesh.count = n;
      b.mesh.instanceMatrix.array.set(L.m);
      b.mesh.instanceMatrix.needsUpdate = true;
      const g = b.mesh.geometry.attributes;
      g.aTint.array.set(L.tint); g.aThr.array.set(L.thr);
      g.aTint.needsUpdate = g.aThr.needsUpdate = true;
      b.refs.set(L.refs);
    }
  }

  setYears(yA, yB) {
    for (const b of this.buckets.values()) {
      if (!b.mesh || !b.n) continue;
      const g = b.mesh.geometry.attributes;
      for (let i = 0; i < b.n; i++) {
        const t = this.tileList[b.refs[i * 2]], k = b.refs[i * 2 + 1];
        g.aFa.array[i] = t.filled[yA][k];
        g.aFb.array[i] = t.filled[yB][k];
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

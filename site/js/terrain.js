// Terrain meshes: one per tile, vertices at the exact pixel centres, shaded by tree fraction.
// Year blending happens on the GPU: attributes hold years A and B, uniform uT mixes them.
import * as THREE from 'three';
import { NODATA_F } from './data.js';
import { lonLatToUtm, utmToLonLat } from './geo.js';

export const EXAG = 1.5;                 // vertical exaggeration (display only)
export const DISPLAY_ZONE = 51;          // common display frame; zone-50 tiles are reprojected for display only

// Carry-forward fill for display: a pixel with no clear observation in a year shows its last observed value
// and is flagged, so gaps render greyed-out instead of looking like loss. Stored data is untouched.
export function prepareFilled(tile, years) {
  const nPx = tile.z.length;
  tile.filled = {};
  tile.nodata = {};
  let prev = new Uint8Array(nPx).fill(NODATA_F);
  for (const y of years) {
    const src = tile.f[y], out = new Uint8Array(nPx), nd = new Uint8Array(nPx);
    for (let k = 0; k < nPx; k++) {
      const v = src[k];
      if (v === NODATA_F) { out[k] = prev[k]; nd[k] = 1; } else out[k] = v;
    }
    tile.filled[y] = out; tile.nodata[y] = nd; prev = out;
  }
  // back-fill leading gaps with the first observed value
  for (let idx = years.length - 2; idx >= 0; idx--) {
    const cur = tile.filled[years[idx]], nxt = tile.filled[years[idx + 1]];
    for (let k = 0; k < nPx; k++) if (cur[k] === NODATA_F) cur[k] = nxt[k];
  }
  // never observed in any year: show as bare, flagged no-data
  for (const y of years) { const a = tile.filled[y]; for (let k = 0; k < nPx; k++) if (a[k] === NODATA_F) a[k] = 0; }
}

export function toWorld(frame, zone, x, y, z) {
  let X = x, Y = y;
  if (zone !== DISPLAY_ZONE) { const [lon, lat] = utmToLonLat(x, y, zone); [X, Y] = lonLatToUtm(lon, lat, DISPLAY_ZONE); }
  return [X - frame.ox, z * EXAG, -(Y - frame.oy)];
}

export function worldToDisplayUtm(frame, wx, wz) { return [wx + frame.ox, frame.oy - wz]; }

const vertexDecl = /* glsl */`
attribute float aFa; attribute float aFb; attribute float aNa; attribute float aNb; attribute float aOwn;
uniform float uT; varying float vF; varying float vNd; varying float vOwn; varying vec3 vWorld;`;
const fragDecl = /* glsl */`
varying float vF; varying float vNd; varying float vOwn; varying vec3 vWorld;
float th12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float tvn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(th12(i), th12(i + vec2(1, 0)), f.x), mix(th12(i + vec2(0, 1)), th12(i + vec2(1, 1)), f.x), f.y); }
vec3 treeRamp(float f) {
  vec3 bare = vec3(0.60, 0.57, 0.51), grass = vec3(0.42, 0.52, 0.30), forest = vec3(0.12, 0.28, 0.14);
  return f < 0.5 ? mix(bare, grass, f * 2.0) : mix(grass, forest, (f - 0.5) * 2.0);
}`;

export function makeTerrainMaterial(uniforms) {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uT = uniforms.uT;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexDecl}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vF = mix(aFa, aFb, uT) / 100.0;
        vNd = mix(aNa, aNb, uT);
        vOwn = aOwn;
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragDecl}`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `
        if (vOwn < 0.5) discard;                                    // another tile (zone 51) owns this location
        vec3 c = treeRamp(clamp(vF, 0.0, 1.0));
        c *= 0.9 + 0.12 * tvn(vWorld.xz / 14.0) + 0.06 * tvn(vWorld.xz / 3.0);
        float stripe = step(0.5, fract((vWorld.x + vWorld.z) / 60.0));
        vec3 grey = vec3(dot(c, vec3(0.3, 0.59, 0.11)));
        c = mix(c, mix(grey, grey * 0.8, stripe), 0.75 * vNd);
        c = mix(c, vec3(0.55, 0.71, 0.79), step(vWorld.y, 0.75));   // DEM <= 0 m: water
        vec4 diffuseColor = vec4(c, opacity);`);
  };
  return m;
}

// Build a (P+1)x(P+1) grid: the extra column/row come from the east/south neighbours so tiles join seamlessly.
// Works for full tiles (P = 256, 30 m) and coarse overview tiles (P = 16, 480 m); `lookup(zone, i, j)` finds neighbours.
export function buildTerrain(tile, lookup, frame, material) {
  const P = tile.P, N = P + 1, res = tile.res, tileM = P * res;
  const east = lookup(tile.zone, tile.i + 1, tile.j);
  const south = lookup(tile.zone, tile.i, tile.j - 1);
  const se = lookup(tile.zone, tile.i + 1, tile.j - 1);
  const srcK = new Uint32Array(N * N), srcRef = new Uint8Array(N * N);
  const refs = [tile, east, south, se];
  const pos = new Float32Array(N * N * 3), own = new Float32Array(N * N);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const v = r * N + c;
    let ref = 0, rr = r, cc = c;
    if (c === P && r === P) { ref = se ? 3 : 0; rr = se ? 0 : P - 1; cc = se ? 0 : P - 1; }
    else if (c === P) { ref = east ? 1 : 0; cc = east ? 0 : P - 1; }
    else if (r === P) { ref = south ? 2 : 0; rr = south ? 0 : P - 1; }
    const t = refs[ref], k = rr * P + cc;
    srcRef[v] = ref; srcK[v] = k;
    own[v] = t.own ? t.own[k] : 1;
    const x = tile.x0 + res * c + res / 2, y = tile.y0 + tileM - res * r - res / 2;
    const [wx, wy, wz] = toWorld(frame, tile.zone, x, y, t.z[k]);
    pos[v * 3] = wx; pos[v * 3 + 1] = wy; pos[v * 3 + 2] = wz;
  }
  const idx = new Uint32Array(P * P * 6);
  let q = 0;
  for (let r = 0; r < P; r++) for (let c = 0; c < P; c++) {
    const a = r * N + c, b = a + 1, d = a + N, e = d + 1;
    idx.set([a, d, b, b, d, e], q); q += 6;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  for (const name of ['aFa', 'aFb', 'aNa', 'aNb']) geo.setAttribute(name, new THREE.BufferAttribute(new Float32Array(N * N), 1));
  geo.setAttribute('aOwn', new THREE.BufferAttribute(own, 1));
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.userData = { tile, refs, srcRef, srcK };
  return mesh;
}

export function setTerrainYears(mesh, yA, yB) {
  const { refs, srcRef, srcK } = mesh.userData, g = mesh.geometry;
  const fa = g.attributes.aFa.array, fb = g.attributes.aFb.array, na = g.attributes.aNa.array, nb = g.attributes.aNb.array;
  const R = refs.map(t => t && [t.filled[yA], t.filled[yB], t.nodata[yA], t.nodata[yB]]);
  for (let v = 0; v < srcK.length; v++) {
    const s = R[srcRef[v]], k = srcK[v];
    fa[v] = s[0][k]; fb[v] = s[1][k]; na[v] = s[2][k]; nb[v] = s[3][k];
  }
  for (const n of ['aFa', 'aFb', 'aNa', 'aNb']) g.attributes[n].needsUpdate = true;
}

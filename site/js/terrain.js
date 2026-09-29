// Terrain meshes: one per tile, vertices at the exact pixel centres, shaded by tree fraction.
// Year blending happens on the GPU: attributes hold years A and B, uniform uT mixes them.
import * as THREE from 'three';
import { NODATA_F } from './data.js';
import { lonLatToUtm, utmToLonLat } from './geo.js';
import { CLOUD_GLSL, WATER_GLSL } from './weather.js';

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
attribute float aFa; attribute float aFb; attribute float aNa; attribute float aNb; attribute float aOwn; attribute float aLand; attribute float aBuilt; attribute float aBs;
uniform float uT; varying float vF; varying float vNd; varying float vOwn; varying float vLand; varying float vH; varying vec3 vWorld; varying vec3 vNw;
varying float vBuilt; varying float vBs;`;
const fragDecl = /* glsl */`
varying float vF; varying float vNd; varying float vOwn; varying float vLand; varying float vH; varying vec3 vWorld; varying vec3 vNw;
varying float vBuilt; varying float vBs; uniform float uYearF; uniform float uNight;
${CLOUD_GLSL}
${WATER_GLSL}
float th12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float tvn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(th12(i), th12(i + vec2(1, 0)), f.x), mix(th12(i + vec2(0, 1)), th12(i + vec2(1, 1)), f.x), f.y); }
// Lightness follows tree fraction (the legend ramp); hue varies with terrain so the land reads like Taiwan:
// a field/town mosaic in the lowlands, rock on steep slopes, alpine grass above ~2,800 m, darker montane conifers.
vec3 treeRamp(float f, float elev, float slope, vec2 xz) {
  float parcel = th12(floor(xz / vec2(70.0, 110.0)) + floor(xz.yx / 420.0) * 0.37);
  vec3 bare = mix(vec3(0.63, 0.59, 0.51), vec3(0.53, 0.56, 0.40), step(0.58, parcel));
  bare = mix(bare, vec3(0.68, 0.64, 0.55), step(0.86, parcel));
  bare = mix(bare, vec3(0.60, 0.57, 0.51), smoothstep(120.0, 500.0, elev));
  bare = mix(bare, vec3(0.49, 0.46, 0.42), smoothstep(0.22, 0.48, slope));
  bare = mix(bare, vec3(0.62, 0.60, 0.43), smoothstep(2600.0, 3100.0, elev) * (1.0 - smoothstep(0.3, 0.55, slope)));
  vec3 grass = mix(vec3(0.42, 0.52, 0.30), vec3(0.45, 0.50, 0.33), smoothstep(1500.0, 3000.0, elev));
  vec3 forest = mix(vec3(0.13, 0.30, 0.13), vec3(0.08, 0.21, 0.15), smoothstep(1200.0, 2600.0, elev));
  return f < 0.5 ? mix(bare, grass, f * 2.0) : mix(grass, forest, (f - 0.5) * 2.0);
}
// Nearest crown centre on a jittered grid: xy = offset from the centre, z = cell id, w = distance to the cell edge.
vec4 crownCell(vec2 p) {
  vec2 i = floor(p), f = fract(p); float d1 = 9.0, d2 = 9.0; vec2 o1 = vec2(0.0); float id = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y)), c = g + 0.15 + 0.7 * vec2(th12(i + g), th12(i + g + 17.3)) - f;
    float d = dot(c, c);
    if (d < d1) { d2 = d1; d1 = d; o1 = c; id = th12(i + g + 5.1); } else if (d < d2) d2 = d;
  }
  return vec4(-o1, id, sqrt(d2) - sqrt(d1));
}
// Dense forest as a canopy, by on-screen scale (fw = crown cells per screen pixel):
//  far (crowns < 1 px): the flat ramp colour; mid (crowns ~1-12 px, i.e. beyond the instanced trees): lit crowns
//  (~9 m) where the pixel's tree fraction says there are trees, shade between; near (crowns larger, where the
//  instanced trees stand): soft shaded understorey, no cell pattern. Means stay close to the flat ramp colour.
vec3 canopy(vec3 c, float f, vec2 xz) {
  float cov = smoothstep(0.2, 0.75, f);
  if (cov <= 0.0) return c;
  vec2 cp = xz / 8.5;
  float fw = length(fwidth(cp));
  float wFar = smoothstep(0.7, 1.3, fw), wNear = 1.0 - smoothstep(0.05, 0.11, fw);
  vec3 under = c * (0.62 + 0.3 * tvn(xz / 2.2) + 0.18 * tvn(xz / 7.0)) * mix(vec3(1.0), vec3(0.92, 1.02, 0.95), 0.5);
  vec3 crownsC = c;
  if (wFar < 1.0 && wNear < 1.0) {
    vec4 cc = crownCell(cp);
    float r = length(cc.xy) / 0.62, dome = sqrt(max(0.0, 1.0 - r * r));
    vec3 n = normalize(vec3(cc.x, dome * 0.9 + 0.1, cc.y));
    float lit = 0.62 + 0.55 * max(dot(n, normalize(uSunDir)), 0.0) * (0.4 + 0.6 * uDay);
    float treed = step(cc.z, f * 1.08);
    float crown = treed * smoothstep(1.05, 0.6, r);
    float tone = 0.86 + 0.3 * th12(vec2(cc.z * 91.0, 3.7));
    vec3 crownC = c * lit * tone * mix(vec3(1.0), vec3(1.08, 1.06, 0.9), 0.5 * dome);   // sunlit tops a little yellower
    crownsC = mix(c * 0.55, crownC, crown) / mix(0.55, 1.0, f * 0.95);
  }
  vec3 detailC = mix(mix(crownsC, under, wNear), c, wFar);
  return mix(c, detailC, cov);
}`;

const WEATHER_UNIFORMS = ['uCloud', 'uCloudOff', 'uSunDir', 'uCloudH', 'uDay', 'uSkyTop', 'uSkyHor', 'uSunCol', 'uWindS', 'uWaterT', 'uNight', 'uYearF'];
export const shareUniforms = (sh, uniforms, names = WEATHER_UNIFORMS) => { for (const n of names) sh.uniforms[n] = uniforms[n]; };

export function makeTerrainMaterial(uniforms) {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uT = uniforms.uT;
    shareUniforms(sh, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexDecl}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vF = mix(aFa, aFb, uT) / 100.0;
        vNd = mix(aNa, aNb, uT);
        vOwn = aOwn; vLand = aLand; vH = position.y; vNw = objectNormal; vBuilt = aBuilt; vBs = aBs;
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragDecl}`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `
        if (vOwn < 0.5) discard;                                    // another tile (zone 51) owns this location
        if (vLand < 0.18 && vH < 6.0) discard;                      // sea-level water (DEM < 4 m): the sea plane draws it
        vec3 c = treeRamp(clamp(vF, 0.0, 1.0), vH / ${EXAG.toFixed(2)}, 1.0 - normalize(vNw).y, vWorld.xz);
        c = canopy(c, clamp(vF, 0.0, 1.0), vWorld.xz);
        c *= 0.9 + 0.12 * tvn(vWorld.xz / 14.0) + 0.06 * tvn(vWorld.xz / 3.0);
        float stripe = step(0.5, fract((vWorld.x + vWorld.z) / 60.0));
        vec3 grey = vec3(dot(c, vec3(0.3, 0.59, 0.11)));
        c = mix(c, mix(grey, grey * 0.8, stripe), 0.75 * vNd);
        // built-up ground (GISA first-built year reached by the timeline): concrete tint where trees are few
        float isB = step(0.5, vBuilt) * step(1900.0 + vBuilt, uYearF + 0.5);
        float urb = isB * clamp(0.3 + 0.7 * vBs / 100.0, 0.0, 1.0) * (1.0 - clamp(vF * 1.4, 0.0, 1.0));
        c = mix(c, vec3(0.64, 0.63, 0.61) * (0.92 + 0.12 * tvn(vWorld.xz / 40.0)), urb * 0.8);
        // beaches: low-lying land right at the coast (only where the tile has a water mask)
        float coast = smoothstep(0.98, 0.6, vLand) * step(0.3, vLand) * (1.0 - smoothstep(3.0, 9.0, vH));
        c = mix(c, vec3(0.80, 0.75, 0.62) * (0.94 + 0.1 * tvn(vWorld.xz / 6.0)), coast * (1.0 - vF) * 0.85);
        float shade = cloudShadow(vWorld);
        c *= shade;
        vec4 diffuseColor = vec4(c, opacity);`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        // water: DEM <= 0 m (soft edge) or WorldCover water
        float wm = max(1.0 - smoothstep(0.3, 1.2, vH), smoothstep(0.65, 0.35, vLand));
        vec3 wcol = waterShade(vWorld, 0.35 + 0.65 * uDay) * shade;
        // a moving foam line where the sea meets land
        float surf = tvn(vWorld.xz / 5.0 + vec2(uWaterT * 0.6, uWaterT * 0.2)) * tvn(vWorld.xz / 13.0 - uWaterT * 0.15);
        float foam = smoothstep(0.32, 0.5, vLand) * (1.0 - smoothstep(0.5, 0.62, vLand)) * smoothstep(0.12, 0.35, surf);
        wcol = mix(wcol, vec3(0.92, 0.95, 0.96) * (0.35 + 0.65 * uDay), foam * 0.85 * (1.0 - smoothstep(1500.0, 5000.0, length(cameraPosition - vWorld))));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, wcol, wm);
        // city lights at night: warm, flickering speckle scaled by built-up share
        // near: sparse street lamps (the 3D buildings carry the windows); far: a warm glow of the whole built-up area
        float camD = length(cameraPosition - vWorld);
        float far = smoothstep(4000.0, 20000.0, camD);
        float lamp = mix(step(0.88, th12(floor(vWorld.xz / 9.0))) * 1.6, 0.4 + 1.0 * pow(th12(floor(vWorld.xz / 60.0)), 2.0), far);
        gl_FragColor.rgb += vec3(1.0, 0.7, 0.36) * isB * (vBs / 100.0) * uNight * lamp * mix(0.35, 1.3, far) * (1.0 - wm);`);
  };
  return m;
}

// The sea: same water shading as rivers and lakes on the terrain, so coasts join without a seam.
export function makeWaterMaterial(uniforms) {
  const m = new THREE.MeshLambertMaterial({ color: 0x8fb6c8 });
  m.onBeforeCompile = (sh) => {
    shareUniforms(sh, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorld = (modelMatrix * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWorld;\n${CLOUD_GLSL}\n${WATER_GLSL}`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        gl_FragColor.rgb = waterShade(vWorld, 0.35 + 0.65 * uDay) * cloudShadow(vWorld);`);
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
  const pos = new Float32Array(N * N * 3), own = new Float32Array(N * N), land = new Float32Array(N * N);
  const built = new Float32Array(N * N), bs = new Float32Array(N * N);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const v = r * N + c;
    let ref = 0, rr = r, cc = c;
    if (c === P && r === P) { ref = se ? 3 : 0; rr = se ? 0 : P - 1; cc = se ? 0 : P - 1; }
    else if (c === P) { ref = east ? 1 : 0; cc = east ? 0 : P - 1; }
    else if (r === P) { ref = south ? 2 : 0; rr = south ? 0 : P - 1; }
    const t = refs[ref], k = rr * P + cc;
    srcRef[v] = ref; srcK[v] = k;
    own[v] = t.own ? t.own[k] : 1;
    land[v] = t.land ? t.land[k] : 1;
    built[v] = t.built ? t.built[k] : 0; bs[v] = t.bs ? t.bs[k] : 0;
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
  geo.setAttribute('aLand', new THREE.BufferAttribute(land, 1));
  geo.setAttribute('aBuilt', new THREE.BufferAttribute(built, 1));
  geo.setAttribute('aBs', new THREE.BufferAttribute(bs, 1));
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

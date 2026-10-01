// Illustrative buildings from open built-up data, like the trees: a pixel that GISA marks as impervious gets 1-3
// instanced boxes (count from the GHSL built-up share, height from GHSL building height) that rise in the year the pixel
// first became built-up. Positions and shapes are procedural; they are not real building footprints.
import * as THREE from 'three';
import { EXAG, toWorld } from './terrain.js';

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function hash2(x, y) { const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return h - Math.floor(h); }

const DECL = /* glsl */`
attribute float aYear; attribute vec3 aSize; attribute vec3 aTint; attribute float aSeed;
uniform float uYearF;`;
const GROW = /* glsl */`
  float grow = smoothstep(aYear - 0.6, aYear + 0.4, uYearF);
  transformed.y *= grow;
  transformed.xz *= step(0.001, grow);`;

function makeMaterial(uniforms) {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
  m.onBeforeCompile = (sh) => {
    for (const n of ['uYearF', 'uNight', 'uDay']) sh.uniforms[n] = uniforms[n];
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${DECL}\nvarying vec3 vLocal; varying vec3 vSize; varying vec3 vTint; varying float vSeed; varying vec3 vObjN;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${GROW}\nvLocal = position; vSize = aSize; vTint = aTint; vSeed = aSeed; vObjN = normal;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vLocal; varying vec3 vSize; varying vec3 vTint; varying float vSeed; varying vec3 vObjN;
        uniform float uNight; uniform float uDay;
        float bh1(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `
        // walls get a window grid in metres (3.3 m floors, ~3 m bays); roofs are plain and a little darker
        float wall = 1.0 - step(0.5, abs(vObjN.y));
        vec2 m = vec2((abs(vObjN.x) > 0.5 ? vLocal.z * vSize.z : vLocal.x * vSize.x), vLocal.y * vSize.y);
        vec2 cell = floor(m / vec2(3.0, 3.3)), f = fract(m / vec2(3.0, 3.3));
        float win = wall * step(0.2, f.x) * step(f.x, 0.8) * step(0.3, f.y) * step(f.y, 0.85) * step(1.2, m.y);
        vec3 base = mix(vTint * 0.82, vTint, wall);
        vec3 glass = mix(vec3(0.20, 0.26, 0.31), vec3(0.42, 0.5, 0.56), 0.4 * uDay);
        vec4 diffuseColor = vec4(mix(base, glass, win * 0.75), opacity);
        float lit = win * step(0.78, bh1(cell + vSeed * 91.0)) * uNight;`)
      .replace('#include <opaque_fragment>', `
        outgoingLight += vec3(1.0, 0.78, 0.48) * lit * 1.2;
        #include <opaque_fragment>`);
  };
  return m;
}

function makeDepthMaterial(uniforms) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uYearF = uniforms.uYearF;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${GROW}`);
  };
  return m;
}

const PALETTE = [[0.78, 0.77, 0.74], [0.86, 0.85, 0.82], [0.72, 0.70, 0.66], [0.80, 0.76, 0.70], [0.66, 0.68, 0.70], [0.88, 0.87, 0.86]];

export class City {
  constructor(scene, uniforms) {
    this.scene = scene;
    this.geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.mat = makeMaterial(uniforms);
    this.depth = makeDepthMaterial(uniforms);
    this.mesh = null; this.cap = 0; this.n = 0; this._visible = true;
  }

  set visible(v) { this._visible = v; if (this.mesh) this.mesh.visible = v; }

  #ensure(n) {
    if (this.mesh && n <= this.cap) return;
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.dispose(); }
    const cap = Math.max(1024, Math.ceil(n * 1.5));
    const g = this.geo.clone();
    g.setAttribute('aYear', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
    g.setAttribute('aSize', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3));
    g.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3));
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
    const mesh = new THREE.InstancedMesh(g, this.mat, cap);
    Object.assign(mesh, { customDepthMaterial: this.depth, castShadow: true, receiveShadow: true, frustumCulled: false, visible: this._visible });
    this.scene.add(mesh);
    this.mesh = mesh; this.cap = cap;
  }

  // Rebuild for built-up pixels within `radius` of `focus` (loaded full-resolution tiles only), except where
  // `skip(x, z)` (world) says real footprints are drawn instead.
  build(ds, frame, focus, radius, skip = null) {
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), sc = new THREE.Vector3();
    const M = [], Y = [], S = [], T = [], D = [];
    const r2 = radius * radius;
    for (const tile of ds.tiles.values()) {
      if (!tile.built) continue;
      const P = tile.P, res = tile.res;
      const [cx, , cz] = toWorld(frame, tile.zone, tile.x0 + ds.tileM / 2, tile.y0 + ds.tileM / 2, 0);
      if (Math.hypot(cx - focus.x, cz - focus.z) > radius + ds.tileM) continue;
      for (let k = 0; k < P * P; k++) {
        const b = tile.built[k], share = tile.bs[k];
        if (!b || share < 6 || (tile.own && !tile.own[k]) || (tile.land && !tile.land[k])) continue;
        const [wx, , wz] = toWorld(frame, tile.zone, tile.x[k], tile.y[k], 0);
        const dx = wx - focus.x, dz = wz - focus.z;
        if (dx * dx + dz * dz > r2 || skip?.(wx, wz)) continue;
        const X = tile.x[k], Yu = tile.y[k], rand = rng(X * 92837111 ^ Yu * 689287499);
        const n = share < 22 ? 1 : share < 50 ? 2 : 3;
        const area = (share / 100) * res * res / n;
        // streets run on a local grid: one angle per ~400 m block
        const ang = (hash2(Math.floor(X / 400), Math.floor(Yu / 400)) - 0.5) * 0.9;
        const ground = tile.z[k] * EXAG - 0.3;
        const hBase = tile.bh[k] > 0 ? tile.bh[k] : 7;
        for (let s = 0; s < n; s++) {
          const aspect = 0.6 + rand() * 0.9;
          const w = Math.min(26, Math.max(5, Math.sqrt(area * aspect))), d = Math.min(26, Math.max(5, area / w));
          let h = hBase * (0.5 + rand() * 1.0);
          if (hBase > 25 && rand() < 0.12) h *= 1.8 + rand() * 1.4;      // the odd tower in high-rise districts
          if (share < 20) h = Math.min(h, 4 + rand() * 6);              // sparse built-up: low houses
          h = Math.max(3.5, h);
          const ox = (n === 1 ? 0 : ((s % 2) - 0.5) * res * 0.45) + (rand() - 0.5) * res * 0.25;
          const oz = (n < 3 ? (rand() - 0.5) * res * 0.3 : ((s >> 1) - 0.5) * res * 0.45);
          p.set(wx + ox, ground, wz + oz);
          q.setFromAxisAngle(up, ang + (rand() < 0.15 ? Math.PI / 2 : 0));
          sc.set(w, h, d);
          m4.compose(p, q, sc);
          for (let e = 0; e < 16; e++) M.push(m4.elements[e]);
          Y.push(1900 + b + (b === 72 || b === 78 ? -20 : 0));             // "by 1972/1978": standing from the start
          S.push(w, h, d);
          const c = PALETTE[Math.floor(rand() * PALETTE.length)], v = 0.92 + rand() * 0.12;
          T.push(c[0] * v, c[1] * v, c[2] * v);
          D.push(rand());
        }
      }
    }
    const n = Y.length;
    this.n = n;
    if (!n && !this.mesh) return;
    this.#ensure(n);
    const mesh = this.mesh, g = mesh.geometry.attributes;
    mesh.count = n;
    mesh.instanceMatrix.array.set(M); mesh.instanceMatrix.needsUpdate = true;
    g.aYear.array.set(Y); g.aSize.array.set(S); g.aTint.array.set(T); g.aSeed.array.set(D);
    for (const a of ['aYear', 'aSize', 'aTint', 'aSeed']) g[a].needsUpdate = true;
  }
}

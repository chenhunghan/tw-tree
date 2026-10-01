// Story unicorns: one flies up out of the fab each time the site's estimated cumulative revenue passes another
// US$1 bn (story.js). Procedural like the trees: a body of scaled spheres and cylinders with vertex colours (white
// coat, gold horn, rainbow mane and tail), four legs and two feathered wings that are animated per instance.
// Three instanced meshes (body, legs, wings) carry every unicorn, and one ribbon mesh all their rainbow trails (six
// bands along the flight path behind each one, facing the camera, tapering and fading), so a swarm is four draw calls.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const MAX = 240, SOFT = 200;      // unicorns in the air at once (more crossings are still counted); beyond SOFT the oldest fade
const FADE = 0.6;               // seconds of the fade-out at the end of a flight
const LIFE = 7;                 // seconds in the air (long enough to leave the window before fading)
const TRAIL = 1.7, SEG = 28;    // rainbow trail: seconds of flight behind each unicorn, segments along it
const COAT = '#f7f4fb', HOOF = '#8a7f8e', GOLD = '#f1c453';
const RAINBOW = ['#ff6b8b', '#ffa94d', '#ffe066', '#69db7c', '#4dabf7', '#9775fa'];

function paint(g, color) {
  if (g.index) g = g.toNonIndexed();
  const c = new THREE.Color(color), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}
const ball = (r, x, y, z, sx = 1, sy = 1, sz = 1, color = COAT, rz = 0) =>
  paint(new THREE.SphereGeometry(r, 14, 10).scale(sx, sy, sz).rotateZ(rz).translate(x, y, z), color);
const rod = (r0, r1, h, x, y, z, rz, color = COAT) =>
  paint(new THREE.CylinderGeometry(r1, r0, h, 10, 1).rotateZ(rz).translate(x, y, z), color);

// Facing +x, hooves at y = 0, about 2.4 units nose to tail.
function bodyGeometry() {
  const parts = [
    ball(1, 0, 1.5, 0, 0.95, 0.5, 0.46),                       // barrel
    ball(0.5, 0.62, 1.62, 0, 1, 1.05, 0.95),                     // chest
    ball(0.48, -0.66, 1.58, 0, 1, 1, 0.98),                      // rump
    rod(0.34, 0.2, 0.95, 1.0, 2.05, 0, -0.62),                    // neck
    ball(0.5, 1.42, 2.46, 0, 0.88, 0.48, 0.5, COAT, -0.5),        // head
    ball(0.2, 1.74, 2.24, 0, 1.1, 0.9, 1.05, '#f3e6ee'),          // muzzle
    ball(0.045, 1.55, 2.58, 0.2, 1, 1, 1, '#2b2233'), ball(0.045, 1.55, 2.58, -0.2, 1, 1, 1, '#2b2233'),   // eyes
    paint(new THREE.ConeGeometry(0.07, 0.22, 6).translate(1.28, 2.8, 0.13), COAT),
    paint(new THREE.ConeGeometry(0.07, 0.22, 6).translate(1.28, 2.8, -0.13), COAT),   // ears
  ];
  // horn: a twisted gold cone, banded lighter and darker
  const horn = paint(new THREE.ConeGeometry(0.075, 0.72, 10, 6).rotateZ(-0.55).translate(1.66, 2.95, 0), GOLD);
  const hp = horn.attributes.position, hc = horn.attributes.color;
  for (let i = 0; i < hp.count; i++) { const k = 0.82 + 0.25 * (Math.sin(hp.getY(i) * 40) > 0); hc.setXYZ(i, hc.getX(i) * k, hc.getY(i) * k, hc.getZ(i) * k); }
  parts.push(horn);
  // rainbow mane down the neck, and a flowing tail
  for (let i = 0; i < 6; i++) {
    const t = i / 5;
    parts.push(ball(0.17 - 0.03 * t, 1.22 - 0.5 * t, 2.62 - 0.62 * t, 0, 1.25, 0.85, 0.7, RAINBOW[i], 0.6));
  }
  for (let i = 0; i < 6; i++) {
    const t = i / 5;
    parts.push(ball(0.2 - 0.02 * i, -1.08 - 0.42 * t, 1.72 - 0.42 * t * t, 0, 1.5, 0.8, 0.8, RAINBOW[5 - i], 0.9 - t));
  }
  return mergeGeometries(parts);
}
// a leg hanging from its hip at the origin
function legGeometry() {
  return mergeGeometries([rod(0.09, 0.13, 0.95, 0, -0.47, 0, 0), rod(0.11, 0.1, 0.16, 0, -1.02, 0, 0, HOOF)]);
}
// a wing from its shoulder at the origin, spread along +z: three rows of feathers, pastel toward the tips
function wingGeometry() {
  const parts = [];
  const rows = [['#ffffff', 1.0, 0.0], ['#f3eaff', 1.25, -0.12], ['#e3f2ff', 1.5, -0.24]];
  rows.forEach(([col, len, dx], r) => {
    for (let i = 0; i < 6; i++) {
      const a = 0.25 + i * 0.13, l = len * (0.55 + 0.45 * Math.sin(Math.PI * (i + 1) / 7));
      const g = new THREE.PlaneGeometry(0.22, l).translate(0, l / 2, 0).rotateX(Math.PI / 2).rotateY(-a + 0.9);
      g.translate(dx - i * 0.09, 0.02 * r, 0.12 + i * 0.12);
      parts.push(paint(g, col));
    }
  });
  return mergeGeometries(parts);
}

export class Unicorns {
  constructor(scene) {
    // top layer: in the transparent pass (still opaque, depth-written) with a render order after the site outline (11),
    // which is drawn without depth test; story.js fades the HTML labels a unicorn passes over
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, emissive: 0x2a2433, transparent: true });
    this.body = new THREE.InstancedMesh(bodyGeometry(), mat, MAX);
    this.legs = new THREE.InstancedMesh(legGeometry(), mat, MAX * 4);
    // feathers are thin cards that often face away from the sun: lit mostly by their own glow
    this.wings = new THREE.InstancedMesh(wingGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, emissive: 0x8a8296, transparent: true }), MAX * 2);
    for (const m of [this.body, this.legs, this.wings]) {
      m.count = 0; m.frustumCulled = false; m.castShadow = false; m.renderOrder = 13;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m);
    }
    // trails: per unicorn 6 bands x 2 edges x (SEG + 1) vertices; colours fixed, positions and alpha per frame
    const nv = 6 * 2 * (SEG + 1), pos = new Float32Array(MAX * nv * 3), col = new Float32Array(MAX * nv * 4), idx = [];
    for (let u = 0; u < MAX; u++) for (let b = 0; b < 6; b++) {
      const c = new THREE.Color(RAINBOW[b]), o = u * nv + b * 2 * (SEG + 1);
      for (let i = 0; i <= SEG; i++) for (let e = 0; e < 2; e++) { const k = (o + i * 2 + e) * 4; col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b; }
      for (let i = 0; i < SEG; i++) { const a = o + i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    tg.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    tg.setIndex(idx);
    this.trail = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    this.trail.frustumCulled = false; this.trail.renderOrder = 12; this.nv = nv;
    scene.add(this.trail);
    this.list = [];
    this.m = new THREE.Matrix4(); this.p = new THREE.Matrix4(); this.q = new THREE.Quaternion();
    this.e = new THREE.Euler(); this.v = new THREE.Vector3(); this.s = new THREE.Vector3();
  }

  get flying() { return this.list.length; }

  // Screen circles [x, y, r] (CSS px) around each unicorn in view, for hiding labels underneath.
  screenCircles(camera, w, h) {
    const out = [], v = new THREE.Vector3(), e = new THREE.Vector3();
    for (const u of this.list) {
      this.#at(u, u.t, v); v.y += 1.5 * u.size;
      const d = v.distanceTo(camera.position);
      v.project(camera);
      if (v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) continue;
      // ~2 unicorn units across (wings spread), in pixels at that distance
      const r = 2.2 * u.size / (d * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) * h / 2;
      out.push([(v.x + 1) / 2 * w, (1 - v.y) / 2 * h, r]);
    }
    return out;
  }
  clear() { this.list.length = 0; this.#draw(); }

  // origin: THREE.Vector3 (a roof); size: world units per unicorn unit (scaled to stay readable from the camera)
  spawn(origin, size) {
    // a crowded sky (Fab 18 earns ~70 a second at playback speed): the oldest fade out early instead of popping
    if (this.list.length >= SOFT) for (const u of this.list) if (u.t < LIFE - FADE) { u.t = LIFE - FADE; break; }
    if (this.list.length >= MAX) this.list.shift();
    this.list.push({ o: origin.clone(), size, t: 0, th: Math.random() * Math.PI * 2, turn: (Math.random() < 0.5 ? -1 : 1) * (0.35 + Math.random() * 0.4),
      climb: 0.8 + Math.random() * 0.5, ph: Math.random() * 6.28 });
  }

  // position along the flight at time t: up out of the roof, then outward on a gently curving, accelerating path to
  // ~1.3 camera distances (size is ~1.6 % of it), past the edges of the window before the fade
  #at(u, t, out) {
    const k = t / LIFE, r = u.size * (1.5 + 82 * k ** 1.35), a = u.th + u.turn * 0.3 * t;
    return out.set(u.o.x + Math.cos(a) * r, u.o.y + u.size * u.climb * (1.2 + 6 * k ** 0.8 + 10 * k ** 2), u.o.z + Math.sin(a) * r);
  }

  update(dt, camPos) {
    if (!this.list.length && !this.body.count) return;
    this.cam = camPos;
    for (const u of this.list) u.t += dt;
    this.list = this.list.filter(u => u.t < LIFE);
    this.#draw();
  }

  // the ribbon behind unicorn u (slot n): from TRAIL seconds back (or the roof) to just behind its rump, across the
  // path toward the camera, widest at the unicorn
  #trail(u, n, grow) {
    const P = this.trail.geometry.attributes.position.array, C = this.trail.geometry.attributes.color.array;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), side = new THREE.Vector3(), view = new THREE.Vector3(), cam = this.cam;
    const t0 = Math.max(0, u.t - TRAIL), lift = 1.45 * u.size;
    for (let i = 0; i <= SEG; i++) {
      const k = i / SEG, t = t0 + (u.t - 0.12 - t0) * k;
      this.#at(u, t, a); this.#at(u, t + 0.03, b); a.y += lift; b.y += lift;
      b.sub(a);
      if (cam) view.subVectors(cam, a); else view.set(0, 1, 0);
      side.crossVectors(b, view).normalize();
      if (!Number.isFinite(side.x)) side.set(0, 0, 1);
      const w = u.size * 0.2 * grow * (0.25 + 0.75 * k), al = 0.85 * k ** 0.7 * grow;
      for (let band = 0; band < 6; band++) for (let e = 0; e < 2; e++) {
        const off = (band + e - 3) * w, vi = n * this.nv + band * 2 * (SEG + 1) + i * 2 + e;
        P[vi * 3] = a.x + side.x * off; P[vi * 3 + 1] = a.y + side.y * off; P[vi * 3 + 2] = a.z + side.z * off;
        C[vi * 4 + 3] = al;
      }
    }
  }

  #draw() {
    const { m, p, q, e, v, s } = this, nxt = new THREE.Vector3(), pos = new THREE.Vector3();
    let n = 0;
    for (const u of this.list) {
      this.#at(u, u.t, pos); this.#at(u, u.t + 0.05, nxt);
      const dx = nxt.x - pos.x, dy = nxt.y - pos.y, dz = nxt.z - pos.z;
      const yaw = Math.atan2(-dz, dx), pitch = Math.min(0.28, Math.atan2(dy, Math.hypot(dx, dz)) * 0.4);   // a gentle climb, galloping on air
      const grow = Math.min(1, u.t / 0.35) * Math.min(1, (LIFE - u.t) / FADE), sz = u.size * grow;
      const ph = u.ph + u.t * 9, bob = Math.sin(ph * 2) * 0.12 * sz;
      q.setFromEuler(e.set(0, yaw, pitch + Math.sin(ph) * 0.06, 'YXZ'));
      p.compose(v.set(pos.x, pos.y + bob, pos.z), q, s.set(sz || 1e-6, sz || 1e-6, sz || 1e-6));
      this.body.setMatrixAt(n, p);
      // gallop: front and hind pairs swing in opposition, left and right slightly apart
      [[0.62, 1.25, 0.22, 0], [0.62, 1.25, -0.22, 0.5], [-0.66, 1.25, 0.22, Math.PI], [-0.66, 1.25, -0.22, Math.PI + 0.5]].forEach(([x, y, z, o], i) => {
        m.makeRotationZ(Math.sin(ph + o) * 0.7 - 0.15).setPosition(x, y, z);
        this.legs.setMatrixAt(n * 4 + i, m.premultiply(p));
      });
      // wings flap from the shoulders (the right one is the left mirrored across z)
      const flap = Math.sin(ph * 0.75) * 0.75 + 0.15;
      for (let w = 0; w < 2; w++) {
        m.makeRotationX(w ? -flap : flap);
        if (w) m.premultiply(new THREE.Matrix4().makeScale(1, 1, -1));
        m.setPosition(0.35, 1.95, w ? -0.3 : 0.3);
        this.wings.setMatrixAt(n * 2 + w, m.premultiply(p));
      }
      this.#trail(u, n, grow);
      n++;
    }
    this.trail.geometry.setDrawRange(0, n * 6 * SEG * 6);
    this.trail.geometry.attributes.position.needsUpdate = this.trail.geometry.attributes.color.needsUpdate = true;
    this.body.count = n; this.legs.count = n * 4; this.wings.count = n * 2;
    for (const x of [this.body, this.legs, this.wings]) x.instanceMatrix.needsUpdate = true;
  }
}

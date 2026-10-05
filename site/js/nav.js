// Map navigation in the style of Google Maps (replaces three's MapControls; same small API: target, update(),
// getAzimuthalAngle(), getPolarAngle(), min/maxDistance, maxPolarAngle, autoRotate(Speed), 'start'/'change'/'end').
//  - left drag / one finger: grab the ground under the pointer and keep it under the pointer; a fling coasts
//  - right or middle drag, or Ctrl/⌘/Shift + drag: horizontal rotates, vertical tilts, around the view centre
//  - wheel / pinch: zoom toward the ground point under the pointer (pinch midpoint); double-click / double-tap: zoom in
//  - two fingers: twist rotates, moving both up or down together tilts
// The camera never goes below the ground (plus clearance for the canopy), and the pivot stays on the ground.
// Cooperative mode (embedded in a page): the page keeps one-finger scrolling and the wheel, the map takes two fingers
// (pinch, twist, tilt and pan by their midpoint) and the wheel only while `engaged` (after a click on the map, until the
// mouse leaves) or with Ctrl/⌘ held (also a trackpad pinch); `onHint(kind)` is called when a gesture went to the page.
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const CLEAR = 45;                        // metres above the (displayed) ground: tall conifers reach ~40 m, plus the far-canopy lift

export class MapNav extends THREE.EventDispatcher {
  // groundAt(x, z) -> world y of the displayed ground (exaggerated DEM)
  constructor(camera, dom, groundAt) {
    super();
    Object.assign(this, { camera, dom, groundAt });
    this.target = new THREE.Vector3();
    this.minDistance = 120; this.maxDistance = 420000; this.maxPolarAngle = Math.PI * 0.44; this.minPolarAngle = 0.02;
    this.autoRotate = false; this.autoRotateSpeed = 2;
    this.enabled = true;
    this.cooperative = false; this.engaged = true; this.onHint = null;
    this.pointers = new Map(); this.mode = null; this.vel = new THREE.Vector2(); this.zoomGoal = null;
    this.ray = new THREE.Raycaster(); this.sph = new THREE.Spherical(); this.tmp = new THREE.Vector3();
    dom.style.touchAction = 'none';
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('pointerdown', (e) => this.#down(e));
    dom.addEventListener('pointermove', (e) => this.#move(e));
    dom.addEventListener('pointerup', (e) => this.#up(e));
    dom.addEventListener('pointercancel', (e) => this.#up(e));
    dom.addEventListener('wheel', (e) => this.#wheel(e), { passive: false });
    dom.addEventListener('dblclick', (e) => this.#zoomAt(e.clientX, e.clientY, 0.45));
    dom.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') this.engaged = false; });
    // two or more fingers belong to the map: keep the page from scrolling or zooming (cancelable until it scrolls)
    dom.addEventListener('touchmove', (e) => { if (this.cooperative && e.touches.length >= 2 && e.cancelable) e.preventDefault(); }, { passive: false });
  }

  setCooperative(on) {
    this.cooperative = on;
    this.dom.style.touchAction = on ? 'pan-x pan-y' : 'none';
  }

  getAzimuthalAngle() { this.sph.setFromVector3(this.tmp.copy(this.camera.position).sub(this.target)); return this.sph.theta; }
  getPolarAngle() { this.sph.setFromVector3(this.tmp.copy(this.camera.position).sub(this.target)); return this.sph.phi; }

  // ---------- picking: march along the pointer ray over the height data (no mesh raycast) ----------
  #rayAt(cx, cy) {
    const r = this.dom.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), this.camera);
    return this.ray.ray;
  }
  pick(cx, cy) {
    const { origin: o, direction: d } = this.#rayAt(cx, cy);
    if (d.y > -0.002) return null;
    const far = Math.min(this.maxDistance * 2, 3 * this.camera.position.distanceTo(this.target) / Math.max(0.05, -d.y) + 2000);
    let t0 = 0, t = Math.max(2, this.camera.position.distanceTo(this.target) * 0.01);
    while (t < far) {
      const p = this.tmp.copy(o).addScaledVector(d, t);
      if (p.y <= this.groundAt(p.x, p.z)) {                       // crossed the ground: bisect
        let a = t0, b = t;
        for (let i = 0; i < 12; i++) { const m = (a + b) / 2; const q = this.tmp.copy(o).addScaledVector(d, m); if (q.y <= this.groundAt(q.x, q.z)) b = m; else a = m; }
        return o.clone().addScaledVector(d, b);
      }
      t0 = t; t *= 1.06; t += 4;
    }
    // no ground within reach (sea, horizon): the plane through the target
    const k = (this.target.y - o.y) / d.y;
    return k > 0 ? o.clone().addScaledVector(d, k) : null;
  }
  #planeHit(cx, cy, y) {
    const { origin: o, direction: d } = this.#rayAt(cx, cy);
    if (d.y > -0.01) return null;
    return o.clone().addScaledVector(d, (y - o.y) / d.y);
  }

  // ---------- pointer input ----------
  #down(e) {
    if (!this.enabled) return;
    if (e.pointerType === 'mouse') this.engaged = true;
    const coopTouch = this.cooperative && e.pointerType === 'touch';
    if (!coopTouch) try { this.dom.setPointerCapture(e.pointerId); } catch {}
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    this.vel.set(0, 0); this.zoomGoal = null;
    if (this.pointers.size === 1 && coopTouch) {
      this.mode = 'page';                                           // one finger scrolls the page (we may get pointercancel)
    } else if (this.pointers.size === 1) {
      const rot = e.pointerType === 'mouse' && (e.button === 2 || e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey);
      this.mode = rot ? 'rotate' : 'pan';
      if (!rot) this.grab = this.pick(e.clientX, e.clientY);
      if (e.pointerType === 'touch') {                             // double tap
        const now = performance.now();
        if (this.lastTap && now - this.lastTap.t < 300 && Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < 30) { this.#zoomAt(e.clientX, e.clientY, 0.45); this.lastTap = null; }
        else this.lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
      this.dispatchEvent({ type: 'start' });
    } else if (this.pointers.size === 2) {
      this.mode = 'two'; this.two = this.#twoState();
      if (this.cooperative) { this.grab = this.pick(this.two.mx, this.two.my); this.dispatchEvent({ type: 'start' }); }
    }
    this.lastT = performance.now();
  }

  #twoState() {
    const [a, b] = [...this.pointers.values()];
    return { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x), ay: a.y, by: b.y };
  }

  #move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.enabled) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY; p.dx = dx; p.dy = dy; p.t = performance.now();
    const now = performance.now(), dt = Math.max(1, now - this.lastT); this.lastT = now;
    if (this.mode === 'page') {
      if (!p.hinted && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > 12) { p.hinted = true; this.onHint?.('touch'); }
      return;
    }
    if (this.mode === 'pan' && this.pointers.size === 1) {
      const before = this.target.clone();
      this.#panTo(e.clientX, e.clientY);
      const mv = this.target.clone().sub(before), k = Math.max(8, dt);   // world metres per ms, for the fling:
      this.vel.lerp(new THREE.Vector2(mv.x / k, mv.z / k), 0.5);          // smoothed, at most 2 view distances / s
      const vmax = this.camera.position.distanceTo(this.target) * 2 / 1000;
      if (this.vel.length() > vmax) this.vel.setLength(vmax);
    } else if (this.mode === 'rotate') {
      const h = this.dom.clientHeight || innerHeight, w = this.dom.clientWidth || innerWidth;
      this.#orbit(-dx / w * Math.PI * 1.2, -dy / h * Math.PI * 0.7);
    } else if (this.mode === 'two' && this.pointers.size === 2) {
      const s = this.#twoState(), o = this.two; this.two = s;
      // events arrive one finger at a time: it is a tilt when this finger and the other one (moved within the last
      // 100 ms) both go mostly vertically, the same way
      const other = [...this.pointers.values()].find(q => q !== p);
      const vert = (ddx, ddy) => Math.abs(ddy) > 0.8 && Math.abs(ddy) > Math.abs(ddx) * 1.5;
      if (other?.t && p.t - other.t < 100 && vert(dx, dy) && vert(other.dx, other.dy) && Math.sign(dy) === Math.sign(other.dy)) {
        this.#orbit(0, -dy / 2 / (this.dom.clientHeight || innerHeight) * Math.PI * 0.7);
      } else {
        const twist = Math.atan2(Math.sin(s.ang - o.ang), Math.cos(s.ang - o.ang));
        if (Math.abs(twist) > 0.002) this.#orbit(twist, 0);
        if (o.dist > 0 && s.dist > 0) this.#zoomToward(s.mx, s.my, o.dist / s.dist);
        if (this.cooperative) this.#panTo(s.mx, s.my);           // two fingers also drag the map (one finger is the page's)
      }
    }
    this.dispatchEvent({ type: 'change' });
  }

  #up(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 1 && this.mode === 'two' && this.cooperative) { this.mode = 'page'; this.grab = null; this.dispatchEvent({ type: 'end' }); return; }
    if (this.pointers.size === 1 && this.mode === 'two') {         // lifting one finger of two: continue panning
      const [q] = this.pointers.values(); this.mode = 'pan'; this.grab = this.pick(q.x, q.y); this.vel.set(0, 0); return;
    }
    if (this.pointers.size === 0) {
      if (this.mode === 'page') { this.mode = null; return; }
      if (this.mode !== 'pan' || performance.now() - this.lastT > 80) this.vel.set(0, 0);
      this.mode = null; this.grab = null;
      this.dispatchEvent({ type: 'end' });
    }
  }

  #wheel(e) {
    if (!this.enabled) return;
    if (this.cooperative && !this.engaged && !e.ctrlKey && !e.metaKey) { this.onHint?.('wheel'); return; }   // the page scrolls
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const f = Math.exp(THREE.MathUtils.clamp(px, -200, 200) * 0.0022);
    this.vel.set(0, 0);
    const at = this.pick(e.clientX, e.clientY);
    if (!at) return;
    const g = this.zoomGoal;                                      // accumulate while the last zoom is still easing
    this.zoomGoal = { at, f: (g && g.at.distanceTo(at) < this.camera.position.distanceTo(this.target) * 0.05 ? g.f : 1) * f };
    this.dispatchEvent({ type: 'start' }); this.dispatchEvent({ type: 'change' });
    clearTimeout(this.wheelEnd); this.wheelEnd = setTimeout(() => this.dispatchEvent({ type: 'end' }), 250);
  }
  #zoomAt(cx, cy, f) {
    const at = this.pick(cx, cy);
    if (at) { this.zoomGoal = { at, f }; this.dispatchEvent({ type: 'change' }); }
  }

  // ---------- moves ----------
  // Keep the grabbed ground point under the pointer: move by the difference where the pointer ray meets the
  // grabbed point's height.
  #panTo(cx, cy) {
    if (!this.grab) return;
    const hit = this.#planeHit(cx, cy, this.grab.y);
    if (!hit) return;
    const d = this.camera.position.distanceTo(this.target);
    const mv = this.grab.clone().sub(hit); mv.y = 0;
    if (mv.length() > d * 4) mv.setLength(d * 4);                  // near-horizon rays: no wild jumps
    this.target.add(mv); this.camera.position.add(mv);
  }
  #orbit(dTheta, dPhi) {
    const off = this.tmp.copy(this.camera.position).sub(this.target);
    this.sph.setFromVector3(off);
    this.sph.theta += dTheta;
    this.sph.phi = THREE.MathUtils.clamp(this.sph.phi + dPhi, this.minPolarAngle, this.maxPolarAngle);
    this.camera.position.copy(this.target).add(off.setFromSpherical(this.sph));
  }
  // Scale the camera and the target about a ground point (f < 1: in).
  #zoomToward(cx, cy, f) {
    const at = this.pick(cx, cy);
    if (at) this.#scaleAbout(at, f);
  }
  #scaleAbout(at, f) {
    const d = this.camera.position.distanceTo(this.target);
    f = THREE.MathUtils.clamp(d * f, this.minDistance, this.maxDistance) / d;
    this.camera.position.sub(at).multiplyScalar(f).add(at);
    this.target.sub(at).multiplyScalar(f).add(at);
  }

  // Each frame: eased zoom, fling, autorotation, then keep the pivot on the ground and the camera above it.
  update(dt = 1 / 60) {
    if (this.zoomGoal) {
      const k = 1 - Math.exp(-dt * 12), step = Math.pow(this.zoomGoal.f, k);
      this.#scaleAbout(this.zoomGoal.at, step);
      this.zoomGoal.f /= step;
      if (Math.abs(Math.log(this.zoomGoal.f)) < 0.002) this.zoomGoal = null;
      this.dispatchEvent({ type: 'change' });
    }
    if (!this.pointers.size && this.vel.lengthSq() > 1e-8) {
      const mv = this.tmp.set(this.vel.x, 0, this.vel.y).multiplyScalar(dt * 1000);
      this.target.add(mv); this.camera.position.add(mv);
      this.vel.multiplyScalar(Math.exp(-dt * 4));
      if (this.vel.lengthSq() < 1e-8) this.vel.set(0, 0);
      this.dispatchEvent({ type: 'change' });
    }
    if (this.autoRotate && !this.pointers.size) this.#orbit(-2 * Math.PI / 60 * this.autoRotateSpeed * dt, 0);
    // pivot follows the ground (eased, so panning across a ridge doesn't jolt); the camera moves with it
    const gy = this.groundAt(this.target.x, this.target.z);
    if (Number.isFinite(gy)) {
      const dy = (gy - this.target.y) * (1 - Math.exp(-dt * 6));
      if (!this.pointers.size || this.mode !== 'pan') { this.target.y += dy; this.camera.position.y += dy; }
    }
    const off = this.tmp.copy(this.camera.position).sub(this.target);
    const d = THREE.MathUtils.clamp(off.length(), this.minDistance, this.maxDistance);
    this.sph.setFromVector3(off); this.sph.radius = d;
    this.sph.phi = THREE.MathUtils.clamp(this.sph.phi, this.minPolarAngle, this.maxPolarAngle);
    this.camera.position.copy(this.target).add(off.setFromSpherical(this.sph));
    // never under the ground: lift the camera (it stays aimed at the target)
    const cg = this.groundAt(this.camera.position.x, this.camera.position.z);
    const floor = (Number.isFinite(cg) ? cg : 0) + CLEAR;
    if (this.camera.position.y < floor) this.camera.position.y = floor;
    this.camera.up.copy(UP);
    this.camera.lookAt(this.target);
  }
}

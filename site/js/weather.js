// Decorative sky and weather: time of day (sun, moon, stars), a drifting cloud layer with matching cloud shadows,
// wind, rain streaks and a shared water shader. Nothing here comes from data; it only sets the mood of the map.
import * as THREE from 'three';

// ---------- shared GLSL ----------
// Cloud density in world XZ; also used by terrain, trees and water to cast the clouds' shadows.
export const CLOUD_GLSL = /* glsl */`
uniform float uCloud; uniform vec2 uCloudOff; uniform vec3 uSunDir; uniform float uCloudH; uniform float uDay;
float cH(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float cN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cH(i), cH(i + vec2(1, 0)), f.x), mix(cH(i + vec2(0, 1)), cH(i + vec2(1, 1)), f.x), f.y); }
float cloudFbm(vec2 p) { float a = 0.5, s = 0.0; for (int k = 0; k < 5; k++) { s += a * cN(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; } return s; }
float cloudDensity(vec2 xz) { float n = cloudFbm((xz + uCloudOff) / 2600.0);
  return smoothstep(1.0 - uCloud - 0.12, 1.0 - uCloud + 0.22, n); }
float cloudShadow(vec3 w) {           // 1 = open sky, lower under a cloud (projected along the sun)
  vec3 L = normalize(uSunDir); float t = (uCloudH - w.y) / max(L.y, 0.12);
  return 1.0 - 0.5 * uDay * cloudDensity(w.xz + L.xz * t);
}`;

// Water: ripples from scrolling noise (flattened with distance so thin rivers do not sparkle), Fresnel sky reflection,
// sun/moon glint. Needs CLOUD_GLSL first (noise + uSunDir).
export const WATER_GLSL = /* glsl */`
uniform vec3 uSkyTop; uniform vec3 uSkyHor; uniform vec3 uSunCol; uniform float uWindS; uniform float uWaterT;
vec3 waterShade(vec3 w, float ambient) {
  vec3 V = normalize(cameraPosition - w);
  float dist = length(cameraPosition - w);
  float fade = 1.0 - smoothstep(250.0, 2500.0, dist);   // far water turns into a calm mirror
  vec2 p = w.xz; float t = uWaterT;
  vec2 d1 = vec2(cN(p / 26.0 + vec2(t * 0.35, t * 0.12)), cN(p / 26.0 + vec2(5.2, 1.3) + vec2(-t * 0.16, t * 0.3)));
  vec2 d2 = vec2(cN(p / 8.5 + vec2(t * 0.7, -t * 0.5)), cN(p / 8.5 + vec2(3.1, 7.7) + vec2(t * 0.55, t * 0.3)));
  vec2 slope = ((d1 - 0.5) * 0.8 + (d2 - 0.5) * 0.45) * (0.16 + 0.32 * uWindS) * fade;
  vec3 N = normalize(vec3(slope.x, 1.0, slope.y));
  float fr = 0.03 + 0.97 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  vec3 R = reflect(-V, N);
  vec3 sky = mix(uSkyHor, uSkyTop, pow(clamp(R.y, 0.0, 1.0), 0.5));
  vec3 body = mix(vec3(0.020, 0.075, 0.095), vec3(0.045, 0.16, 0.17), 0.5 + 0.5 * fade) * ambient;
  vec3 col = mix(body, sky, clamp(fr, 0.0, 1.0));
  vec3 L = normalize(uSunDir);
  float spec = pow(max(dot(R, L), 0.0), mix(60.0, 320.0, fade)) * mix(0.25, 2.0, fade);
  return col + uSunCol * spec * smoothstep(-0.02, 0.05, L.y);
}`;

// ---------- palettes ----------
const col = (h) => new THREE.Color(h);
const SKY = {
  day: { top: col(0x5f95c4), hor: col(0xd3e2e8) },
  dusk: { top: col(0x44578a), hor: col(0xf0a86e) },
  night: { top: col(0x040816), hor: col(0x16203a) },
  grey: { top: col(0x8a959c), hor: col(0xb9c1c4) },
};
export const PRESETS = {
  clear: { cloud: 0.28, rain: 0, wind: 0.45, label: '晴' },
  cloudy: { cloud: 0.6, rain: 0, wind: 0.8, label: '多雲' },
  rain: { cloud: 0.9, rain: 1, wind: 1.3, label: '雨' },
};
const WIND_DIR = new THREE.Vector2(-0.72, 0.69);   // blowing toward the south-west (x = east, z = south)

export class Weather {
  constructor(scene) {
    this.scene = scene;
    this.hour = 7.5; this.auto = true; this.hoursPerSec = 24 / 420;   // daylight hours pass in ~3.5 min; night goes twice as fast
    this.preset = 'clear';
    this.cur = { ...PRESETS.clear };
    this.sunDir = new THREE.Vector3(); this.moonDir = new THREE.Vector3(); this.lightDir = new THREE.Vector3();
    this.uniforms = {
      uCloud: { value: 0.3 }, uCloudOff: { value: new THREE.Vector2(3000, -1200) }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uCloudH: { value: 2400 }, uDay: { value: 1 }, uSkyTop: { value: new THREE.Color() }, uSkyHor: { value: new THREE.Color() },
      uSunCol: { value: new THREE.Color() }, uWindS: { value: 0.5 }, uWaterT: { value: 0 }, uNight: { value: 0 },
      uMoonDir: { value: new THREE.Vector3() }, uRain: { value: 0 },
    };
    this.sky = this.#makeSky();
    this.clouds = this.#makeClouds();
    this.rain = this.#makeRain();
    scene.add(this.sky, this.clouds, this.rain);
  }

  setPreset(name) { this.preset = name; }
  setHour(h) { this.hour = ((h % 24) + 24) % 24; }

  // Advance and apply to lights, fog and sky. `dist` = camera-to-focus distance.
  update(dt, camera, target, dist, { sun, hemi, fog }) {
    const U = this.uniforms, P = PRESETS[this.preset], k = 1 - Math.exp(-dt * 0.8);
    for (const key of ['cloud', 'rain', 'wind']) this.cur[key] += (P[key] - this.cur[key]) * k;
    const nightNow = this.sunDir.y < -0.05 ? 2.2 : 1;
    if (this.auto) this.hour = (this.hour + dt * this.hoursPerSec * nightNow) % 24;
    // Sun: rises in the east (6 h), culminates ~65° to the south, sets in the west; the moon is opposite.
    const a = Math.PI * (this.hour - 6) / 12, tilt = THREE.MathUtils.degToRad(65);
    this.sunDir.set(Math.cos(a), Math.sin(a) * Math.sin(tilt), Math.sin(a) * Math.cos(tilt)).normalize();
    this.moonDir.copy(this.sunDir).negate(); this.moonDir.y = Math.abs(this.moonDir.y) * 0.8 + 0.1; this.moonDir.normalize();
    const sy = this.sunDir.y;
    const day = THREE.MathUtils.smoothstep(sy, -0.1, 0.18);
    const night = 1 - THREE.MathUtils.smoothstep(sy, -0.22, 0.02);
    const dusk = (1 - THREE.MathUtils.smoothstep(Math.abs(sy + 0.02), 0.0, 0.32)) * (1 - 0.6 * night);
    const cloud = this.cur.cloud, grey = THREE.MathUtils.smoothstep(cloud, 0.45, 0.95);
    // sky colours
    const top = SKY.day.top.clone().lerp(SKY.night.top, night).lerp(SKY.dusk.top, dusk * 0.7);
    const hor = SKY.day.hor.clone().lerp(SKY.night.hor, night).lerp(SKY.dusk.hor, dusk * 0.8);
    top.lerp(SKY.grey.top.clone().multiplyScalar(0.15 + 0.85 * day), grey * 0.85);
    hor.lerp(SKY.grey.hor.clone().multiplyScalar(0.15 + 0.85 * day), grey * 0.85);
    U.uSkyTop.value.copy(top); U.uSkyHor.value.copy(hor);
    const sunCol = col(0xfff0d8).lerp(col(0xffa060), dusk);
    U.uSunCol.value.copy(sunCol).multiplyScalar((1 - 0.85 * grey) * day);
    U.uSunDir.value.copy(day > 0.02 ? this.sunDir : this.moonDir);
    U.uMoonDir.value.copy(this.moonDir);
    U.uDay.value = day; U.uNight.value = night; U.uCloud.value = cloud; U.uRain.value = this.cur.rain;
    U.uWindS.value = this.cur.wind;
    U.uCloudOff.value.addScaledVector(WIND_DIR, -dt * 22 * (0.3 + this.cur.wind));
    U.uWaterT.value += dt * (0.35 + 0.5 * this.cur.wind);
    // lights: the sun by day, a cool moon at night
    const moonOn = day < 0.02;
    this.lightDir.copy(moonOn ? this.moonDir : this.sunDir);
    sun.color.copy(moonOn ? col(0x9fb2e8) : sunCol);
    sun.intensity = moonOn ? 0.9 * (1 - 0.6 * cloud) * night : 2.7 * day * (1 - 0.72 * grey);
    hemi.color.copy(col(0xd4e6f5).lerp(col(0x4a5a8c), night).lerp(col(0xc9ced1), grey * 0.6));
    hemi.groundColor.copy(col(0x4d5a3c).lerp(col(0x1a2030), night));
    hemi.intensity = (0.5 + 0.58 * day) * (1 + 0.35 * grey);
    fog.color.copy(hor);
    fog.density *= 1 + 1.6 * this.cur.rain;
    // sky dome follows the camera; clouds and rain follow the focus
    this.sky.position.copy(camera.position);
    const cs = Math.max(90000, dist * 5);
    this.clouds.position.set(target.x, U.uCloudH.value, target.z); this.clouds.scale.set(cs, cs, 1);
    this.clouds.material.uniforms.uSpan.value = cs;
    this.rain.visible = this.cur.rain > 0.02 && dist < 9000;
    if (this.rain.visible) {
      const B = THREE.MathUtils.clamp(dist * 0.7, 180, 2600);
      this.rain.material.uniforms.uBox.value = B;
      this.rain.material.uniforms.uCenter.value.copy(target);
      this.rain.material.uniforms.uWindV.value.copy(WIND_DIR).multiplyScalar(0.35 * this.cur.wind);
    }
  }

  get label() { const h = Math.floor(this.hour), m = Math.floor((this.hour - h) * 60); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; }

  #makeSky() {
    const m = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uSkyTop: this.uniforms.uSkyTop, uSkyHor: this.uniforms.uSkyHor, uSunCol: this.uniforms.uSunCol,
        uSun: this.uniforms.uSunDir, uMoon: this.uniforms.uMoonDir, uNight: this.uniforms.uNight, uCloud: this.uniforms.uCloud },
      vertexShader: `varying vec3 vDir;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `varying vec3 vDir; uniform vec3 uSkyTop, uSkyHor, uSunCol, uSun, uMoon; uniform float uNight, uCloud;
        #include <logdepthbuf_pars_fragment>
        float hs(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main(){
          #include <logdepthbuf_fragment>
          vec3 d = normalize(vDir); float h = max(d.y, 0.0);
          vec3 c = mix(uSkyHor, uSkyTop, pow(h, 0.55));
          float s = max(dot(d, normalize(uSun)), 0.0);
          c += uSunCol * (pow(s, 1200.0) * 6.0 + pow(s, 90.0) * 0.5 + pow(s, 8.0) * 0.1);
          // stars and moon at night, hidden by cloud
          vec2 q = vec2(atan(d.z, d.x), asin(clamp(d.y, -1.0, 1.0))) * 160.0;
          vec2 i = floor(q); float r = hs(i);
          float star = step(0.9972, r) * smoothstep(0.45, 0.0, length(fract(q) - 0.5)) * (0.6 + 0.4 * sin(r * 800.0));
          float clear = 1.0 - smoothstep(0.35, 0.8, uCloud);
          c += vec3(0.9, 0.93, 1.0) * star * uNight * clear * smoothstep(0.0, 0.2, d.y);
          float mo = max(dot(d, normalize(uMoon)), 0.0);
          c += vec3(0.85, 0.88, 1.0) * (smoothstep(0.99985, 0.99992, mo) * 1.4 + pow(mo, 60.0) * 0.12) * uNight * (0.3 + 0.7 * clear);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(800000, 48, 24), m);
    sky.renderOrder = -1; sky.frustumCulled = false;
    return sky;
  }

  #makeClouds() {
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
      uniforms: { ...this.uniforms, uSpan: { value: 90000 } },
      vertexShader: `varying vec3 vW; varying vec2 vUv;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `varying vec3 vW; varying vec2 vUv; uniform float uSpan, uNight; uniform vec3 uSkyHor, uSunCol;
        #include <logdepthbuf_pars_fragment>
        ${CLOUD_GLSL}
        void main(){
          #include <logdepthbuf_fragment>
          float d = cloudDensity(vW.xz);
          float edge = 1.0 - smoothstep(0.3, 0.5, length(vUv - 0.5));            // hide the plane's edge
          float camGap = smoothstep(80.0, 600.0, abs(cameraPosition.y - vW.y));    // fade when flying through
          camGap *= mix(1.0, 0.18, smoothstep(5000.0, 40000.0, cameraPosition.y - vW.y));   // keep the map readable from far above
          float lit = 0.35 + 0.65 * uDay;
          float thick = cloudFbm((vW.xz + uCloudOff) / 900.0 + 3.0);
          vec3 c = mix(uSkyHor * 0.55, vec3(1.0), 0.55 + 0.45 * thick) * lit + uSunCol * 0.18;
          c = mix(c, uSkyHor * 0.35, uNight * 0.6);
          gl_FragColor = vec4(c, d * edge * camGap * mix(0.85, 0.95, uCloud));
        }`,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);   // scaled in X/Y, then laid flat
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 5; mesh.frustumCulled = false;
    return mesh;
  }

  #makeRain(n = 9000) {
    const seeds = new Float32Array(n * 2 * 4), ends = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const s = [Math.random(), Math.random(), Math.random(), Math.random()];
      for (let e = 0; e < 2; e++) { seeds.set(s, (i * 2 + e) * 4); ends[i * 2 + e] = e; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    g.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      uniforms: { uTime: { value: 0 }, uBox: { value: 600 }, uCenter: { value: new THREE.Vector3() }, uWindV: { value: new THREE.Vector2() },
        uRain: this.uniforms.uRain, uDay: this.uniforms.uDay },
      vertexShader: `attribute vec4 aSeed; attribute float aEnd; uniform float uTime, uBox; uniform vec3 uCenter; uniform vec2 uWindV;
        varying float vA;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main(){
          float B = uBox, H = uBox * 1.3;
          vec2 xz = mod(aSeed.xz * 2.0 * B - uCenter.xz, 2.0 * B) + uCenter.xz - B;   // wraps in world space
          float y = uCenter.y - 0.3 * H + mod(aSeed.y * H - uTime * B * (0.9 + 0.3 * aSeed.w), H);
          vec3 dir = normalize(vec3(uWindV.x, -1.0, uWindV.y));
          vec3 w = vec3(xz.x, y, xz.y) + dir * B * 0.035 * aEnd;
          vA = aEnd;
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `varying float vA; uniform float uRain, uDay;
        #include <logdepthbuf_pars_fragment>
        void main(){
          #include <logdepthbuf_fragment>
          gl_FragColor = vec4(vec3(0.75, 0.8, 0.88) * (0.35 + 0.65 * uDay), 0.28 * uRain * (0.3 + 0.7 * vA));
        }`,
    });
    const lines = new THREE.LineSegments(g, m);
    lines.frustumCulled = false; lines.renderOrder = 6;
    lines.onBeforeRender = () => { m.uniforms.uTime.value = performance.now() / 1000; };
    return lines;
  }
}

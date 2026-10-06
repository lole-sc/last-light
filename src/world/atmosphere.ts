// Sky, sun/moon, fog, cloud sea, floating rock underside, birds — and the
// time-of-day palette that the game advances each time a beacon is lit.
import * as THREE from 'three';
import { Builder, M, MAT, blob, uniforms } from './assets';
import { ISLET, islandRadius, isletRadius } from './layout';
import { mulberry32, smoothstep } from '../utils/math';

interface Key {
  t: number;
  top: number; horizon: number; sun: number; sunInt: number; elev: number; az: number;
  hemiSky: number; hemiGround: number; hemiInt: number; fog: number; cloudLit: number; cloudShadow: number;
  exposure: number;
}
const KEYS: Key[] = [
  { t: 0.0, top: 0x5f86d0, horizon: 0xffc596, sun: 0xffd29a, sunInt: 3.3, elev: 0.36, az: 2.55,
    hemiSky: 0xa6b9ff, hemiGround: 0xb08a92, hemiInt: 1.25, fog: 0xe8a891, cloudLit: 0xf4a882, cloudShadow: 0x9a76b6, exposure: 1.0 },
  { t: 0.42, top: 0x4b5cb0, horizon: 0xff9c7c, sun: 0xffa874, sunInt: 2.8, elev: 0.22, az: 2.75,
    hemiSky: 0x9aa2ff, hemiGround: 0xa06d90, hemiInt: 1.15, fog: 0xdb8a86, cloudLit: 0xf0927e, cloudShadow: 0x8a63aa, exposure: 1.02 },
  { t: 0.72, top: 0x2c3274, horizon: 0xd47798, sun: 0xff8f86, sunInt: 1.7, elev: 0.1, az: 2.95,
    hemiSky: 0x7d86e6, hemiGround: 0x6a4f86, hemiInt: 1.05, fog: 0x8c5f93, cloudLit: 0xc97aa0, cloudShadow: 0x54468a, exposure: 1.1 },
  { t: 1.0, top: 0x0e1640, horizon: 0x3b4590, sun: 0xa9bcff, sunInt: 1.05, elev: 0.75, az: -0.9,
    hemiSky: 0x5b6fd0, hemiGround: 0x30295a, hemiInt: 1.0, fog: 0x283070, cloudLit: 0x5d68b4, cloudShadow: 0x1f2558, exposure: 1.2 },
];

const col = (h: number) => new THREE.Color(h);

export class Atmosphere {
  group = new THREE.Group();
  sun = new THREE.DirectionalLight(0xffffff, 3);
  hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
  fog = new THREE.Fog(0xffffff, 150, 720);
  skyMat!: THREE.ShaderMaterial;
  cloudSeaMat!: THREE.ShaderMaterial;
  puffMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x000000, flatShading: true });
  stars!: THREE.Points;
  puffs: THREE.Object3D[] = [];
  floaters: { o: THREE.Object3D; base: THREE.Vector3; ph: number }[] = [];
  birds: { o: THREE.Group; wl: THREE.Mesh; wr: THREE.Mesh; r: number; h: number; ph: number; sp: number }[] = [];
  sunDir = new THREE.Vector3();
  time = 0; // 0 = golden hour, 1 = night
  exposure = 1;
  current = {
    top: new THREE.Color(), horizon: new THREE.Color(), sun: new THREE.Color(), fog: new THREE.Color(),
    cloudLit: new THREE.Color(), cloudShadow: new THREE.Color(), hemiSky: new THREE.Color(), hemiGround: new THREE.Color(),
  };

  constructor(private scene: THREE.Scene) {}

  build() {
    this.scene.fog = this.fog;
    this.group.add(this.hemi);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.group.add(this.sun, this.sun.target);
    this.buildSky();
    this.buildStars();
    this.buildCloudSea();
    this.buildPuffs();
    this.buildUnderside();
    this.buildBirds();
    this.setTime(0);
    return this.group;
  }

  private buildSky() {
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uBelow: { value: new THREE.Color() },
        uSun: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3() }, uNight: uniforms.uNight, uTime: uniforms.uTime,
      },
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w * 0.9999; }`,
      fragmentShader: /* glsl */`
        uniform vec3 uTop, uHorizon, uBelow, uSun, uSunDir; uniform float uNight, uTime;
        varying vec3 vDir;
        void main(){
          vec3 d = normalize(vDir);
          float y = d.y;
          vec3 c = mix(uHorizon, uTop, pow(clamp(y, 0.0, 1.0), 0.55));
          c = mix(c, uBelow, smoothstep(0.0, -0.25, y));
          float s = max(dot(d, normalize(uSunDir)), 0.0);
          float sunVis = 1.0 - uNight * 0.85;
          c += uSun * (pow(s, 8.0) * 0.35 + pow(s, 64.0) * 0.6) * sunVis;
          c += uSun * smoothstep(0.9975, 0.999, s) * 2.5 * sunVis;
          // soft horizon glow band
          c += uHorizon * 0.18 * exp(-abs(y) * 9.0);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1400, 32, 16), this.skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    this.group.add(sky);
  }

  private buildStars() {
    const n = 1400;
    const pos = new Float32Array(n * 3), size = new Float32Array(n);
    const r = mulberry32(5);
    for (let i = 0; i < n; i++) {
      const u = r() * 2 - 1, a = r() * Math.PI * 2;
      const y = Math.abs(u) * 0.95 + 0.03;
      const s = Math.sqrt(1 - y * y);
      pos[i * 3] = Math.cos(a) * s * 1200; pos[i * 3 + 1] = y * 1200; pos[i * 3 + 2] = Math.sin(a) * s * 1200;
      size[i] = r() < 0.08 ? 3.2 : 1.2 + r() * 1.4;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('size', new THREE.BufferAttribute(size, 1));
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
      uniforms: { uNight: uniforms.uNight, uTime: uniforms.uTime },
      vertexShader: `attribute float size; varying float vTw; uniform float uTime;
        void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv;
          vTw = 0.6 + 0.4 * sin(uTime * 2.0 + position.x * 0.13 + position.z * 0.07);
          gl_PointSize = size * (window_dpr); }`.replace('window_dpr', Math.min(window.devicePixelRatio, 2).toFixed(1)),
      fragmentShader: `uniform float uNight; varying float vTw;
        void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vec3(1.0, 0.95, 0.88) * a * vTw * smoothstep(0.45, 1.0, uNight) * 1.6, 1.0); }`,
    });
    this.stars = new THREE.Points(g, m);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -9;
    this.group.add(this.stars);
  }

  private buildCloudSea() {
    this.cloudSeaMat = new THREE.ShaderMaterial({
      transparent: false, depthWrite: false, fog: false,
      uniforms: {
        uTime: uniforms.uTime, uLit: { value: new THREE.Color() }, uShadow: { value: new THREE.Color() },
        uFog: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3() },
      },
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */`
        uniform float uTime; uniform vec3 uLit, uShadow, uFog, uSunDir; varying vec3 vW;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
          return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
        float fbm(vec2 p){ float s=0., a=.5; for(int i=0;i<5;i++){ s+=a*n(p); p*=2.03; a*=.5; } return s; }
        void main(){
          vec2 p = vW.xz * 0.0085 + vec2(uTime * 0.008, uTime * 0.004);
          float c = fbm(p);
          float c2 = fbm(p * 2.7 + 4.0 - vec2(uTime * 0.015, 0.0));
          float m = c * 0.75 + c2 * 0.35;
          float dens = smoothstep(0.38, 0.62, m);
          // fake lighting: sample the field offset towards the sun
          vec2 sd = normalize(uSunDir.xz + 1e-4);
          float cl = fbm(p + sd * 0.05) * 0.75 + fbm((p + sd * 0.05) * 2.7 + 4.0 - vec2(uTime * 0.015, 0.0)) * 0.35;
          float lit = clamp(0.5 + (m - cl) * 7.0, 0.0, 1.0);
          vec3 deep = uShadow * 0.55;
          vec3 col = mix(deep, uShadow, smoothstep(0.25, 0.5, m));
          col = mix(col, uLit, dens * (0.45 + lit * 0.55));
          col += uLit * pow(lit, 3.0) * dens * 0.25;
          float dist = length(vW.xz);
          float fade = smoothstep(220.0, 900.0, dist);
          col = mix(col, uFog, fade * 0.85);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const sea = new THREE.Mesh(new THREE.CircleGeometry(1300, 64), this.cloudSeaMat);
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = -36;
    sea.renderOrder = -5;
    this.group.add(sea);
  }

  private buildPuffs() {
    const r = mulberry32(31);
    const mk = (seed: number) => {
      const b = new Builder();
      const n = 5 + Math.floor(r() * 4);
      for (let i = 0; i < n; i++) {
        const x = (i - n / 2) * 2.2 + r() * 1.5, s = 2.4 + r() * 2.2 - Math.abs(i - n / 2) * 0.35;
        b.add(blob(Math.max(1.2, s), 1, 0.08, seed + i, 0.8), 0xffffff, M(x, r() * 1.2, r() * 2 - 1), {
          gradient: [0x9a90b4, 0xffffff, -2, 2.5],
        });
      }
      return b.build();
    };
    const geos = [mk(1), mk(2), mk(3)];
    this.puffMat.vertexColors = true;
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + r() * 0.2;
      const rr = 110 + r() * 120;
      const y = -30 + r() * 26 - (rr > 170 ? 0 : 6);
      const m = new THREE.Mesh(geos[i % 3], this.puffMat);
      const s = 1.2 + r() * 1.8;
      m.position.set(Math.cos(a) * rr, y, Math.sin(a) * rr);
      m.scale.set(s, s * 0.8, s);
      m.rotation.y = r() * 6.28;
      m.userData.a = a; m.userData.r = rr; m.userData.sp = 0.004 + r() * 0.006;
      this.puffs.push(m);
      this.group.add(m);
    }
    // a few small puffs drifting just under the island lip
    for (let i = 0; i < 10; i++) {
      const a = r() * Math.PI * 2;
      const rr = islandRadius(a) * (0.7 + r() * 0.25);
      const m = new THREE.Mesh(geos[i % 3], this.puffMat);
      const s = 0.8 + r();
      m.position.set(Math.cos(a) * rr, -16 - r() * 10, Math.sin(a) * rr);
      m.scale.setScalar(s);
      m.userData.a = a; m.userData.r = rr; m.userData.sp = 0.01;
      this.puffs.push(m);
      this.group.add(m);
    }
  }

  private buildUnderside() {
    const mk = (cx: number, cz: number, Rf: (t: number) => number, segs: number, scaleY: number, seed: number) => {
      const r = mulberry32(seed);
      const rings: [number, number][] = [
        [0, 0.8], [-3, 1.6], [-7, 0.9], [-13, 0.72], [-20, 0.5], [-27, 0.3], [-33, 0.12],
      ];
      const pos: number[] = [];
      const ringPts: THREE.Vector3[][] = [];
      for (let k = 0; k < rings.length; k++) {
        const [dy, rf] = rings[k];
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i < segs; i++) {
          const th = (i / segs) * Math.PI * 2;
          const R = Rf(th);
          const rad = k < 2 ? R + rf : R * rf + (r() - 0.5) * R * 0.08;
          const y = -5 + dy * scaleY + (k > 1 ? (r() - 0.5) * 2.5 * scaleY : 0);
          pts.push(new THREE.Vector3(cx + Math.cos(th) * rad, y, cz + Math.sin(th) * rad));
        }
        ringPts.push(pts);
      }
      const tip = new THREE.Vector3(cx + (r() - 0.5) * 3, -5 - 40 * scaleY, cz + (r() - 0.5) * 3);
      const colors: number[] = [];
      const band = [col(0x7a4f3e), col(0x6b4638), col(0x8b7ba6), col(0x6c5c8c), col(0x8f7fa8), col(0x5a4a7a), col(0x4b3d68)];
      const push = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, k: number) => {
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
        const cc = band[Math.min(k, band.length - 1)].clone().multiplyScalar(0.9 + r() * 0.2);
        for (let i = 0; i < 3; i++) colors.push(cc.r, cc.g, cc.b);
      };
      for (let k = 0; k < ringPts.length - 1; k++) {
        const A = ringPts[k], B = ringPts[k + 1];
        for (let i = 0; i < segs; i++) {
          const j = (i + 1) % segs;
          push(A[i], A[j], B[i], k);
          push(A[j], B[j], B[i], k);
        }
      }
      const last = ringPts[ringPts.length - 1];
      for (let i = 0; i < segs; i++) push(last[i], last[(i + 1) % segs], tip, 6);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, MAT.std);
      mesh.receiveShadow = true;
      return mesh;
    };
    // vertex winding: we built it so faces point outward; make it double sided to be safe
    const mat = MAT.std.clone();
    mat.side = THREE.DoubleSide;
    const main = mk(0, 0, islandRadius, 120, 1, 9);
    main.material = mat;
    const islet = mk(ISLET.x, ISLET.z, isletRadius, 28, 0.45, 10);
    islet.material = mat;
    this.group.add(main, islet);

    // floating rock shards around the isle
    const r = mulberry32(12);
    for (let i = 0; i < 18; i++) {
      const b = new Builder();
      const s = 0.8 + r() * 2.2;
      b.add(blob(s, 0, 0.25, 40 + i, 0.9), 0x8b7ba6, undefined, { topColor: 0x6fa060, topAmount: 0.85, ao: 0.5 });
      b.add(new THREE.ConeGeometry(s * 0.8, s * 2.2, 5), 0x6c5c8c, M(0, -s * 1.3, 0, Math.PI, 0, 0));
      const m = new THREE.Mesh(b.build(), MAT.std);
      const a = r() * Math.PI * 2;
      const rr = islandRadius(a) + 6 + r() * 26;
      m.position.set(Math.cos(a) * rr, -4 - r() * 18, Math.sin(a) * rr);
      m.rotation.y = r() * 6;
      m.castShadow = true;
      this.floaters.push({ o: m, base: m.position.clone(), ph: r() * 10 });
      this.group.add(m);
    }
  }

  private buildBirds() {
    const wing = new THREE.BufferGeometry();
    wing.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.18, 0, 0, 0.22, 0.75, 0, 0.05], 3));
    wing.computeVertexNormals();
    const m = new THREE.MeshBasicMaterial({ color: 0x3a2f4e, side: THREE.DoubleSide });
    const r = mulberry32(8);
    for (let i = 0; i < 9; i++) {
      const g = new THREE.Group();
      const wl = new THREE.Mesh(wing, m), wr = new THREE.Mesh(wing, m);
      wr.scale.x = -1;
      const body = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.5, 4), m);
      body.rotation.x = Math.PI / 2;
      g.add(wl, wr, body);
      g.scale.setScalar(1.6);
      this.birds.push({ o: g, wl, wr, r: 40 + r() * 50, h: 22 + r() * 16, ph: r() * Math.PI * 2, sp: 0.07 + r() * 0.05 });
      this.group.add(g);
    }
  }

  /** t: 0 golden hour → 1 night */
  setTime(t: number) {
    this.time = t;
    let i = 0;
    while (i < KEYS.length - 2 && t > KEYS[i + 1].t) i++;
    const a = KEYS[i], b = KEYS[i + 1];
    const k = smoothstep(a.t, b.t, t);
    const L = (x: number, y: number) => x + (y - x) * k;
    const C = (x: number, y: number, out: THREE.Color) => out.copy(col(x)).lerp(col(y), k);
    const cur = this.current;
    C(a.top, b.top, cur.top); C(a.horizon, b.horizon, cur.horizon); C(a.sun, b.sun, cur.sun);
    C(a.fog, b.fog, cur.fog); C(a.cloudLit, b.cloudLit, cur.cloudLit); C(a.cloudShadow, b.cloudShadow, cur.cloudShadow);
    C(a.hemiSky, b.hemiSky, cur.hemiSky); C(a.hemiGround, b.hemiGround, cur.hemiGround);
    // the sun sinks, then the moon rises from the other side
    let elev = L(a.elev, b.elev), az = L(a.az, b.az);
    if (i === 2) { // dusk -> night: swap to moon smoothly through a low elevation
      elev = k < 0.5 ? L(a.elev, 0.05) : 0.05 + (b.elev - 0.05) * smoothstep(0.5, 1, k);
      az = k < 0.5 ? a.az : b.az;
    }
    this.sunDir.set(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev)).normalize();
    this.sun.color.copy(cur.sun);
    let sunInt = L(a.sunInt, b.sunInt);
    if (i === 2) sunInt *= 0.35 + 0.65 * Math.abs(k - 0.5) * 2;
    this.sun.intensity = sunInt;
    this.hemi.color.copy(cur.hemiSky);
    this.hemi.groundColor.copy(cur.hemiGround);
    this.hemi.intensity = L(a.hemiInt, b.hemiInt);
    this.fog.color.copy(cur.fog);
    this.exposure = L(a.exposure, b.exposure);

    const s = this.skyMat.uniforms;
    s.uTop.value.copy(cur.top); s.uHorizon.value.copy(cur.horizon); s.uSun.value.copy(cur.sun);
    s.uBelow.value.copy(cur.cloudShadow).lerp(cur.fog, 0.5);
    s.uSunDir.value.copy(this.sunDir);
    const c = this.cloudSeaMat.uniforms;
    c.uLit.value.copy(cur.cloudLit); c.uShadow.value.copy(cur.cloudShadow); c.uFog.value.copy(cur.fog).lerp(cur.horizon, 0.4);
    c.uSunDir.value.copy(this.sunDir);
    this.puffMat.color.copy(cur.cloudLit);
    this.puffMat.emissive.copy(cur.cloudShadow).multiplyScalar(0.55);
    uniforms.uNight.value = smoothstep(0.55, 1.0, t);
  }

  update(dt: number, time: number, focus: THREE.Vector3, shadowSize: number) {
    // shadow camera follows the focus point (snapped to texels to avoid shimmering)
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    if (sc.right !== shadowSize) {
      sc.left = -shadowSize; sc.right = shadowSize; sc.top = shadowSize; sc.bottom = -shadowSize;
      sc.near = 1; sc.far = 400;
      sc.updateProjectionMatrix();
    }
    const texel = (shadowSize * 2) / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx + this.sunDir.x * 150, focus.y + this.sunDir.y * 150, fz + this.sunDir.z * 150);

    for (const p of this.puffs) {
      p.userData.a += p.userData.sp * dt;
      p.position.x = Math.cos(p.userData.a) * p.userData.r;
      p.position.z = Math.sin(p.userData.a) * p.userData.r;
    }
    for (const f of this.floaters) {
      f.o.position.y = f.base.y + Math.sin(time * 0.6 + f.ph) * 0.8;
      f.o.rotation.y += dt * 0.05;
    }
    const birdVis = 1 - smoothstep(0.6, 0.9, this.time);
    for (const b of this.birds) {
      b.ph += dt * b.sp;
      const a = b.ph;
      b.o.position.set(Math.cos(a) * b.r + 10, b.h + Math.sin(a * 3) * 2, Math.sin(a) * b.r * 0.8 - 6);
      b.o.rotation.y = -a;
      const flap = Math.sin(time * 9 + b.r) * 0.6;
      b.wl.rotation.z = flap; b.wr.rotation.z = -flap;
      b.o.visible = birdVis > 0.05;
    }
  }
}

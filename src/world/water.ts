// Pond + river surface (depth-aware foam from the heightmap), waterfall sheet
// pouring off the island edge, lily pads and pooled ripple rings.
import * as THREE from 'three';
import { Builder, M, uniforms } from './assets';
import { FALLS, POND, WATER_LEVEL } from './layout';
import { HALF, groundHeight, isWater, pondFactor, roadDist } from './terrain';
import { mulberry32 } from '../utils/math';

export class Water {
  group = new THREE.Group();
  mat!: THREE.ShaderMaterial;
  fallMat!: THREE.ShaderMaterial;
  ripples: { m: THREE.Mesh; t: number; s: number }[] = [];
  rippleIdx = 0;
  pads: { m: THREE.Object3D; ph: number; y: number }[] = [];

  constructor(private heightTex: THREE.DataTexture) {}

  build() {
    const fogU = THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
    this.mat = new THREE.ShaderMaterial({
      transparent: true, fog: true,
      uniforms: {
        ...fogU,
        uTime: uniforms.uTime,
        uHeight: { value: this.heightTex },
        uHalf: { value: HALF },
        uLevel: { value: WATER_LEVEL },
        uShallow: { value: new THREE.Color(0x3fbcb2) },
        uDeep: { value: new THREE.Color(0x14506e) },
        uSky: { value: new THREE.Color(0xffc596) },
        uSun: { value: new THREE.Color(0xffd29a) },
        uNight: uniforms.uNight,
        uPlayer: uniforms.uPlayer,
      },
      vertexShader: /* glsl */`
        #include <fog_pars_vertex>
        uniform float uTime;
        varying vec3 vW;
        void main(){
          vec3 p = position;
          vec4 w = modelMatrix * vec4(p, 1.0);
          w.y += sin(w.x * 0.6 + uTime * 1.4) * 0.025 + cos(w.z * 0.5 + uTime * 1.1) * 0.025;
          vW = w.xyz;
          vec4 mvPosition = viewMatrix * w;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        #include <common>
        #include <fog_pars_fragment>
        uniform float uTime, uHalf, uLevel, uNight; uniform sampler2D uHeight;
        uniform vec3 uShallow, uDeep, uSky, uSun, uPlayer;
        varying vec3 vW;
        float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
          return mix(mix(h2(i),h2(i+vec2(1,0)),f.x), mix(h2(i+vec2(0,1)),h2(i+vec2(1,1)),f.x), f.y); }
        void main(){
          vec2 uv = (vW.xz + uHalf) / (2.0 * uHalf);
          vec4 hm = texture2D(uHeight, uv);
          if (hm.g < 0.5) discard;
          float depth = uLevel - hm.r;
          if (depth < -0.05) discard;
          // river flows west
          float river = smoothstep(-46.0, -52.0, vW.x);
          vec2 flow = vec2(-uTime * 1.6 * river, 0.0);
          vec2 p = vW.xz * 0.55 + flow;
          float n1 = vn(p + uTime * 0.15), n2 = vn(p * 2.1 - uTime * 0.2);
          float ripple = smoothstep(0.42, 0.5, abs(fract((n1 * 0.6 + n2 * 0.4) * 4.0) - 0.5));
          vec3 col = mix(uShallow, uDeep, smoothstep(0.05, 1.2, depth));
          // caustic-ish highlights
          col += vec3(0.85, 1.0, 0.95) * ripple * 0.12;
          // sky reflection via view fresnel
          vec3 V = normalize(cameraPosition - vW);
          float fres = pow(1.0 - clamp(V.y, 0.0, 1.0), 3.0);
          col = mix(col, uSky, 0.06 + fres * 0.3);
          // sun glints
          float gl = smoothstep(0.86, 0.95, vn(vW.xz * 3.0 + uTime * vec2(0.4, -0.3)) * vn(vW.xz * 2.3 - uTime * 0.5));
          col += uSun * gl * 1.4 * (1.0 - uNight * 0.7);
          // shore foam: animated bands that lap at the edge
          float wave = sin(depth * 22.0 - uTime * 2.4 + n1 * 3.0) * 0.5 + 0.5;
          float foam = smoothstep(0.14, 0.02, depth) + smoothstep(0.42, 0.18, depth) * smoothstep(0.8, 0.96, wave) * 0.7;
          foam += river * smoothstep(0.78, 0.92, vn(vec2(vW.x * 0.5 + uTime * 3.0, vW.z * 2.5))) * 0.45;
          // wake around the player
          float pd = length(vW.xz - uPlayer.xz);
          foam += smoothstep(2.4, 1.2, pd) * smoothstep(0.4, 0.8, sin(pd * 9.0 - uTime * 10.0) * 0.5 + 0.5) * step(abs(uPlayer.y - uLevel), 1.6) * 0.8;
          col = mix(col, vec3(1.0, 0.98, 0.94), clamp(foam, 0.0, 1.0) * 0.85);
          float alpha = mix(0.86, 0.98, smoothstep(0.0, 0.8, depth));
          alpha = max(alpha, clamp(foam, 0.0, 1.0));
          gl_FragColor = vec4(col, alpha);
          #include <fog_fragment>
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(72, 40, 72, 40), this.mat);
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(-48, WATER_LEVEL, 9);
    plane.renderOrder = 2;
    this.group.add(plane);

    this.buildFalls();
    this.buildLilies();
    this.buildRipples();
    return this.group;
  }

  private buildFalls() {
    const segs = 44, wseg = 8, width = 5.0, drop = 38;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    const dx = FALLS.dirX, dz = FALLS.dirZ;
    const px = -dz, pz = dx; // perpendicular
    for (let i = 0; i <= segs; i++) {
      const s = i / segs;
      const fall = s * s * drop;
      const out = -0.4 + 2.3 * Math.sqrt(fall) + s * 1.2;
      const y = WATER_LEVEL - fall;
      const wid = width * (1 + s * 0.9);
      for (let j = 0; j <= wseg; j++) {
        const t = j / wseg - 0.5;
        pos.push(FALLS.x + dx * out + px * t * wid, y, FALLS.z + dz * out + pz * t * wid);
        uv.push(j / wseg, s);
      }
    }
    for (let i = 0; i < segs; i++) for (let j = 0; j < wseg; j++) {
      const a = i * (wseg + 1) + j, b = a + 1, c = a + wseg + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    const fogU = THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
    this.fallMat = new THREE.ShaderMaterial({
      transparent: true, side: THREE.DoubleSide, depthWrite: false, fog: true,
      uniforms: { ...fogU, uTime: uniforms.uTime, uA: { value: new THREE.Color(0x66d6c6) }, uB: { value: new THREE.Color(0xf4fffb) } },
      vertexShader: `#include <fog_pars_vertex>
        varying vec2 vUv; void main(){ vUv = uv; vec4 mvPosition = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        #include <common>
        #include <fog_pars_fragment>
        uniform float uTime; uniform vec3 uA, uB; varying vec2 vUv;
        float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
          return mix(mix(h2(i),h2(i+vec2(1,0)),f.x), mix(h2(i+vec2(0,1)),h2(i+vec2(1,1)),f.x), f.y); }
        void main(){
          float s = vUv.y;
          float streak = vn(vec2(vUv.x * 14.0, s * 3.0 - uTime * 2.6)) * 0.6 + vn(vec2(vUv.x * 31.0, s * 6.0 - uTime * 4.1)) * 0.4;
          vec3 col = mix(uA, uB, smoothstep(0.35, 0.8, streak) * 0.8 + smoothstep(0.0, 0.08, 0.08 - s) * 0.6);
          float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
          float a = edge * (0.75 + streak * 0.25) * (1.0 - smoothstep(0.55, 1.0, s));
          a *= 0.55 + 0.45 * smoothstep(0.2, 0.6, streak + (1.0 - s) * 0.3);
          gl_FragColor = vec4(col, a);
          #include <fog_fragment>
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const falls = new THREE.Mesh(g, this.fallMat);
    falls.renderOrder = 3;
    falls.frustumCulled = false;
    this.group.add(falls);
  }

  private buildLilies() {
    const r = mulberry32(55);
    const b = new Builder();
    const disc = new THREE.CircleGeometry(0.55, 9, 0.3, Math.PI * 2 - 0.6);
    b.add(disc, 0x4f9a5a, M(0, 0, 0, -Math.PI / 2, 0, 0), { vary: 0.15 });
    const pad = b.build();
    const fb = new Builder();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      fb.add(new THREE.ConeGeometry(0.09, 0.25, 4), 0xffc2d6, M(Math.cos(a) * 0.08, 0.1, Math.sin(a) * 0.08, Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6));
    }
    fb.add(new THREE.IcosahedronGeometry(0.06, 0), 0xffe07a, M(0, 0.12, 0));
    const flower = fb.build();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, flatShading: true, side: THREE.DoubleSide });
    for (let i = 0; i < 26; i++) {
      const a = r() * Math.PI * 2, d = 0.35 + r() * 0.6;
      const x = POND.x + Math.cos(a) * POND.rx * d, z = POND.z + Math.sin(a) * POND.rz * d;
      if (!isWater(x, z) || roadDist(x, z) < 2) continue;
      const m = new THREE.Mesh(pad, mat);
      m.position.set(x, WATER_LEVEL + 0.03, z);
      m.rotation.y = r() * 6.28;
      m.scale.setScalar(0.7 + r() * 0.8);
      if (r() < 0.35) {
        const f = new THREE.Mesh(flower, mat);
        m.add(f);
      }
      this.pads.push({ m, ph: r() * 10, y: m.position.y });
      this.group.add(m);
    }
  }

  private buildRipples() {
    const geo = new THREE.RingGeometry(0.8, 1, 32);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
      m.visible = false;
      m.renderOrder = 4;
      this.ripples.push({ m, t: 99, s: 1 });
      this.group.add(m);
    }
  }

  ripple(x: number, z: number, size = 1) {
    const r = this.ripples[this.rippleIdx++ % this.ripples.length];
    r.t = 0; r.s = size;
    r.m.position.set(x, WATER_LEVEL + 0.04, z);
    r.m.visible = true;
  }

  setColors(sky: THREE.Color, sun: THREE.Color, night: number) {
    this.mat.uniforms.uSky.value.copy(sky);
    this.mat.uniforms.uSun.value.copy(sun);
    this.mat.uniforms.uShallow.value.setHex(0x3fbcb2).lerp(new THREE.Color(0x2a6a96), night * 0.7);
    this.mat.uniforms.uDeep.value.setHex(0x14506e).lerp(new THREE.Color(0x0c2448), night * 0.7);
  }

  update(dt: number, time: number) {
    for (const r of this.ripples) {
      if (r.t > 1.4) { r.m.visible = false; continue; }
      r.t += dt;
      const k = r.t / 1.4;
      r.m.scale.setScalar(r.s * (0.4 + k * 3.2));
      (r.m.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.55;
    }
    for (const p of this.pads) p.m.position.y = p.y + Math.sin(time * 1.3 + p.ph) * 0.03;
  }

  /** Is (x,z) on water and is a point at height y submerged? */
  depthAt(x: number, z: number, y: number) {
    if (!(pondFactor(x, z) < 1.3 || isWater(x, z))) return 0;
    const g = groundHeight(x, z);
    if (g > WATER_LEVEL) return 0;
    return WATER_LEVEL - y;
  }
}

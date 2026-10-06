// Pooled CPU particles rendered as soft point sprites, plus shader-only
// ambient fields (dust motes by day, fireflies by night).
import * as THREE from 'three';
import { uniforms } from '../world/assets';

export interface EmitOpts {
  pos: THREE.Vector3;
  vel?: THREE.Vector3;
  spread?: number; // velocity randomness
  posSpread?: number;
  count?: number;
  life?: number;
  size?: number;
  sizeEnd?: number;
  color?: THREE.ColorRepresentation;
  color2?: THREE.ColorRepresentation;
  alpha?: number;
  gravity?: number;
  drag?: number;
  shape?: number; // 0 soft round, 1 leaf, 2 star
}

const _c = new THREE.Color();
const _c2 = new THREE.Color();

export class ParticleSystem {
  points: THREE.Points;
  private max: number;
  private n = 0;
  private cursor = 0;
  private p: Float32Array; private v: Float32Array;
  private life: Float32Array; private maxLife: Float32Array;
  private s0: Float32Array; private s1: Float32Array;
  private a0: Float32Array; private grav: Float32Array; private drag: Float32Array;
  private posAttr: THREE.BufferAttribute; private colAttr: THREE.BufferAttribute;
  private sizeAttr: THREE.BufferAttribute; private alphaAttr: THREE.BufferAttribute; private shapeAttr: THREE.BufferAttribute;
  private col: Float32Array; private col2: Float32Array;
  mat: THREE.ShaderMaterial;

  constructor(max: number, additive: boolean) {
    this.max = max;
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3);
    this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max); this.grav = new Float32Array(max); this.drag = new Float32Array(max);
    this.col = new Float32Array(max * 3); this.col2 = new Float32Array(max * 3);
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.shapeAttr = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('color', this.colAttr);
    g.setAttribute('size', this.sizeAttr);
    g.setAttribute('alpha', this.alphaAttr);
    g.setAttribute('shape', this.shapeAttr);
    g.setDrawRange(0, 0);
    const fogU = THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { ...fogU, uScale: { value: 500 } },
      vertexShader: /* glsl */`
        #include <fog_pars_vertex>
        attribute float size; attribute float alpha; attribute float shape; attribute vec3 color;
        uniform float uScale;
        varying vec3 vCol; varying float vA; varying float vShape; varying float vRot;
        void main(){
          vCol = color; vA = alpha; vShape = shape;
          vRot = position.x * 3.7 + position.y * 1.3;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = size * uScale / max(0.1, -mvPosition.z);
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        #include <common>
        #include <fog_pars_fragment>
        varying vec3 vCol; varying float vA; varying float vShape; varying float vRot;
        void main(){
          vec2 uv = gl_PointCoord - 0.5;
          float a;
          if (vShape < 0.5) {
            a = smoothstep(0.5, 0.15, length(uv));
          } else if (vShape < 1.5) {
            float c = cos(vRot), s = sin(vRot);
            uv = mat2(c, -s, s, c) * uv;
            a = smoothstep(0.5, 0.42, length(uv * vec2(1.0, 2.2)));
          } else {
            float d = length(uv);
            float st = max(1.0 - abs(uv.x * uv.y) * 60.0, 0.0) * smoothstep(0.5, 0.0, d);
            a = smoothstep(0.25, 0.0, d) + st * 0.8;
          }
          gl_FragColor = vec4(vCol, a * vA);
          if (gl_FragColor.a < 0.01) discard;
          #include <fog_fragment>
        }`,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
  }

  emit(o: EmitOpts) {
    const count = o.count ?? 1;
    _c.set(o.color ?? 0xffffff);
    _c2.set(o.color2 ?? o.color ?? 0xffffff);
    for (let k = 0; k < count; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      if (this.n < this.max) this.n++;
      const ps = o.posSpread ?? 0;
      this.p[i * 3] = o.pos.x + (Math.random() - 0.5) * ps;
      this.p[i * 3 + 1] = o.pos.y + (Math.random() - 0.5) * ps * 0.5;
      this.p[i * 3 + 2] = o.pos.z + (Math.random() - 0.5) * ps;
      const sp = o.spread ?? 0;
      this.v[i * 3] = (o.vel?.x ?? 0) + (Math.random() - 0.5) * sp;
      this.v[i * 3 + 1] = (o.vel?.y ?? 0) + (Math.random() - 0.5) * sp;
      this.v[i * 3 + 2] = (o.vel?.z ?? 0) + (Math.random() - 0.5) * sp;
      const l = (o.life ?? 1) * (0.75 + Math.random() * 0.5);
      this.life[i] = l; this.maxLife[i] = l;
      this.s0[i] = (o.size ?? 0.5) * (0.8 + Math.random() * 0.4);
      this.s1[i] = o.sizeEnd ?? this.s0[i];
      this.a0[i] = o.alpha ?? 1;
      this.grav[i] = o.gravity ?? 0;
      this.drag[i] = o.drag ?? 0;
      const m = Math.random();
      this.col[i * 3] = _c.r + (_c2.r - _c.r) * m; this.col[i * 3 + 1] = _c.g + (_c2.g - _c.g) * m; this.col[i * 3 + 2] = _c.b + (_c2.b - _c.b) * m;
      (this.shapeAttr.array as Float32Array)[i] = o.shape ?? 0;
    }
  }

  update(dt: number) {
    const pa = this.posAttr.array as Float32Array, ca = this.colAttr.array as Float32Array;
    const sa = this.sizeAttr.array as Float32Array, aa = this.alphaAttr.array as Float32Array;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) { aa[i] = 0; continue; }
      this.life[i] -= dt;
      const t = 1 - Math.max(0, this.life[i]) / this.maxLife[i];
      const dr = Math.exp(-this.drag[i] * dt);
      this.v[i * 3] *= dr; this.v[i * 3 + 1] = this.v[i * 3 + 1] * dr - this.grav[i] * dt; this.v[i * 3 + 2] *= dr;
      this.p[i * 3] += this.v[i * 3] * dt; this.p[i * 3 + 1] += this.v[i * 3 + 1] * dt; this.p[i * 3 + 2] += this.v[i * 3 + 2] * dt;
      pa[i * 3] = this.p[i * 3]; pa[i * 3 + 1] = this.p[i * 3 + 1]; pa[i * 3 + 2] = this.p[i * 3 + 2];
      ca[i * 3] = this.col[i * 3]; ca[i * 3 + 1] = this.col[i * 3 + 1]; ca[i * 3 + 2] = this.col[i * 3 + 2];
      sa[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      aa[i] = this.a0[i] * Math.min(1, t * 8) * (1 - t * t);
    }
    this.points.geometry.setDrawRange(0, this.n);
    this.posAttr.needsUpdate = true; this.colAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true; this.alphaAttr.needsUpdate = true; this.shapeAttr.needsUpdate = true;
  }

  setScale(s: number) { this.mat.uniforms.uScale.value = s; }
}

/** Shader-only floating motes around the player (day) and fireflies (night). */
export function makeAmbientField(count: number, box: number, fireflies: boolean) {
  const pos = new Float32Array(count * 3), seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = Math.random() * box; pos[i * 3 + 1] = Math.random() * (fireflies ? 3 : 7); pos[i * 3 + 2] = Math.random() * box;
    seed[i] = Math.random() * 100;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: uniforms.uTime, uNight: uniforms.uNight, uCenter: { value: new THREE.Vector3() }, uBox: { value: box },
      uScale: { value: 500 }, uGround: { value: 0 },
    },
    vertexShader: /* glsl */`
      attribute float seed; uniform float uTime, uBox, uScale, uNight, uGround; uniform vec3 uCenter;
      varying float vA;
      void main(){
        vec3 p = position;
        p.x += sin(uTime * 0.3 + seed) * 1.5 + uTime * 0.25;
        p.z += cos(uTime * 0.23 + seed * 1.3) * 1.5;
        p.y += sin(uTime * 0.5 + seed * 2.0) * 0.6;
        vec3 w = vec3(mod(p.x - uCenter.x + uBox * 0.5, uBox) - uBox * 0.5 + uCenter.x,
                      uGround + p.y + 0.3,
                      mod(p.z - uCenter.z + uBox * 0.5, uBox) - uBox * 0.5 + uCenter.z);
        vec4 mv = viewMatrix * vec4(w, 1.0);
        gl_Position = projectionMatrix * mv;
        float edge = 1.0 - smoothstep(uBox * 0.3, uBox * 0.5, length(w.xz - uCenter.xz));
        ${fireflies
          ? 'vA = edge * uNight * (0.5 + 0.5 * sin(uTime * 2.5 + seed * 7.0)); gl_PointSize = 0.16 * uScale / -mv.z;'
          : 'vA = edge * (1.0 - uNight) * 0.45 * (0.6 + 0.4 * sin(uTime + seed)); gl_PointSize = 0.07 * uScale / -mv.z;'}
      }`,
    fragmentShader: /* glsl */`
      varying float vA;
      void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(${fireflies ? 'vec3(0.85, 1.0, 0.45) * 1.6' : 'vec3(1.0, 0.92, 0.75)'} * a * vA, 1.0); }`,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  return pts;
}

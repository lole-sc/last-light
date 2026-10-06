// Procedural asset kit: a geometry "builder" that bakes colour, AO and a
// hand-made wobble into vertex colours, plus shared materials and shader hooks.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../utils/math';

export const uniforms = {
  uTime: { value: 0 },
  uPlayer: { value: new THREE.Vector3(0, -100, 0) },
  uShake: { value: new THREE.Vector4(0, 0, 0, -10) }, // x, z, strength, startTime
  uNight: { value: 0 },
};

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();

export function M(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  tmpE.set(rx, ry, rz);
  tmpQ.setFromEuler(tmpE);
  return new THREE.Matrix4().compose(tmpV.set(x, y, z), tmpQ, tmpS.set(sx, sy, sz));
}

function hash3(x: number, y: number, z: number) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

export interface PartOpts {
  jitter?: number; // positional wobble in metres
  ao?: number; // how much to darken the bottom of the part (0..1)
  aoRange?: [number, number]; // local y range for the ao gradient
  vary?: number; // per-vertex colour variation
  topColor?: THREE.ColorRepresentation; // colour blended on upward faces (moss, snow...)
  topAmount?: number;
  gradient?: [THREE.ColorRepresentation, THREE.ColorRepresentation, number, number]; // bottom col, top col, y0, y1
}

/** Collects coloured parts and merges them into a single flat-shaded geometry. */
export class Builder {
  parts: THREE.BufferGeometry[] = [];

  add(src: THREE.BufferGeometry, color: THREE.ColorRepresentation, matrix?: THREE.Matrix4, o: PartOpts = {}) {
    let g = src.index ? src.toNonIndexed() : src.clone();
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    // ao uses local (pre-transform) heights
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < pos.count; i++) { const y = pos.getY(i); if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (o.aoRange) [y0, y1] = o.aoRange;
    const localY = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) localY[i] = pos.getY(i);
    if (matrix) g.applyMatrix4(matrix);
    const base = new THREE.Color(color);
    const top = o.topColor !== undefined ? new THREE.Color(o.topColor) : null;
    const gb = o.gradient ? new THREE.Color(o.gradient[0]) : null;
    const gt = o.gradient ? new THREE.Color(o.gradient[1]) : null;
    const col = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    const jit = o.jitter ?? 0;
    // jitter: deterministic per world-position so coincident vertices stay welded
    if (jit > 0) {
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const kx = Math.round(x * 1000) / 1000, ky = Math.round(y * 1000) / 1000, kz = Math.round(z * 1000) / 1000;
        pos.setXYZ(i,
          x + (hash3(kx, ky, kz) - 0.5) * 2 * jit,
          y + (hash3(ky, kz, kx) - 0.5) * 2 * jit,
          z + (hash3(kz, kx, ky) - 0.5) * 2 * jit);
      }
    }
    g.computeVertexNormals();
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      c.copy(base);
      if (gb && gt && o.gradient) {
        const t = THREE.MathUtils.smoothstep(localY[i], o.gradient[2], o.gradient[3]);
        c.copy(gb).lerp(gt, t);
      }
      if (top) c.lerp(top, THREE.MathUtils.smoothstep(nrm.getY(i), 0.45, 0.85) * (o.topAmount ?? 1));
      if (o.ao) {
        const t = y1 > y0 ? (localY[i] - y0) / (y1 - y0) : 1;
        c.multiplyScalar(1 - o.ao * (1 - THREE.MathUtils.clamp(t, 0, 1)) ** 2);
      }
      if (o.vary) {
        const f = 1 + (hash3(i * 0.37, pos.getX(i), pos.getZ(i)) - 0.5) * o.vary;
        c.multiplyScalar(f);
      }
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.parts.push(g);
    return this;
  }

  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.parts, false)!;
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ---------- Primitive helpers ----------
export const box = (w: number, h: number, d: number, sx = 1, sy = 1, sz = 1) => new THREE.BoxGeometry(w, h, d, sx, sy, sz);
export const cyl = (rt: number, rb: number, h: number, seg = 8, hs = 1, open = false) =>
  new THREE.CylinderGeometry(rt, rb, h, seg, hs, open);
export const cone = (r: number, h: number, seg = 8) => new THREE.ConeGeometry(r, h, seg);
export const ico = (r: number, d = 0) => new THREE.IcosahedronGeometry(r, d);
export const dodeca = (r: number) => new THREE.DodecahedronGeometry(r, 0);
export const sphere = (r: number, ws = 10, hs = 8) => new THREE.SphereGeometry(r, ws, hs);
export const torus = (r: number, t: number, rs = 6, ts = 16, arc = Math.PI * 2) => new THREE.TorusGeometry(r, t, rs, ts, arc);
export function lathe(profile: [number, number][], seg = 16) {
  return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), seg);
}
/** Triangular prism (roof) along Z, base width w, height h, length l. */
export function prism(w: number, h: number, l: number) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(0, h); s.lineTo(-w / 2, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: l, bevelEnabled: false });
  g.translate(0, 0, -l / 2);
  return g;
}
/** Displace an icosphere with noise for organic blobs and rocks. */
export function blob(r: number, detail: number, amount: number, seed: number, squash = 1) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const rnd = mulberry32(seed);
  const ox = rnd() * 100, oy = rnd() * 100, oz = rnd() * 100;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const k = Math.round(v.x * 997 + ox) * 0.13 + Math.round(v.y * 991 + oy) * 0.17 + Math.round(v.z * 983 + oz) * 0.11;
    const n = Math.sin(k) * 0.5 + Math.sin(k * 2.3 + 1.7) * 0.5;
    v.multiplyScalar(1 + n * amount);
    v.y *= squash;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  return g;
}

// ---------- Materials ----------
export const MAT = {
  std: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0, flatShading: true }),
  stdSmooth: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 }),
  metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.6, flatShading: true }),
  // Window glass / lamp bulbs: emissive that fades in as night falls.
  lamp: new THREE.MeshStandardMaterial({ color: 0x3a2e2a, emissive: new THREE.Color(0xffb35c), emissiveIntensity: 0.15, roughness: 0.4 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x9fd6e0, roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.55 }),
};

/** Wind sway for instanced foliage (canopies) + "hit shake" + bend near the player. */
export function addFoliageSway(mat: THREE.Material, strength = 1, pivotY = 1.2) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uShake = uniforms.uShake;
    shader.uniforms.uPlayer = uniforms.uPlayer;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uPlayer; varying vec3 vWP;`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
  // x-ray dither: foliage between the camera and Wick dissolves so the car is never lost
  {
    vec3 a = cameraPosition, b = uPlayer + vec3(0.0, 0.8, 0.0);
    vec3 ab = b - a;
    float t = dot(vWP - a, ab) / dot(ab, ab);
    if (t > 0.02 && t < 0.94) {
      float d = length(vWP - (a + ab * t));
      float keep = smoothstep(1.7, 3.6, d);
      vec2 q = floor(gl_FragCoord.xy);
      float bayer = fract(dot(q, vec2(0.5, 0.25)) + fract(q.y * 0.5) * 0.5);
      if (bayer > keep * 0.98 + 0.01) discard;
    }
  }`);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
uniform float uTime; uniform vec4 uShake; varying vec3 vWP;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 iPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
#else
  vec3 iPos = vec3(0.0);
#endif
  float hgt = max(position.y - ${pivotY.toFixed(2)}, 0.0);
  float ph = iPos.x * 0.21 + iPos.z * 0.17;
  float sw = ${strength.toFixed(2)};
  vec2 wind = vec2(sin(uTime * 1.1 + ph) + 0.5 * sin(uTime * 2.3 + ph * 1.9), cos(uTime * 0.9 + ph * 1.3)) * 0.022 * sw;
  transformed.xz += wind * hgt;
  transformed += vec3(sin(uTime * 3.1 + position.y * 2.0 + ph), 0.0, cos(uTime * 2.7 + position.x * 2.0 + ph)) * 0.025 * sw * min(hgt, 1.0);
  float sd = distance(iPos.xz, uShake.xy);
  float st = uTime - uShake.w;
  if (sd < 0.75 && st < 1.6) {
    float a = uShake.z * exp(-st * 3.0) * sin(st * 22.0);
    transformed.x += a * hgt * 0.12;
    transformed.z += a * hgt * 0.08;
  }
  {
    vec4 wp4 = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    wp4 = instanceMatrix * wp4;
  #endif
    vWP = (modelMatrix * wp4).xyz;
  }`);
  };
  mat.needsUpdate = true;
  return mat;
}

/** Instanced mesh helper: list of matrices (+ optional colours). */
export function instanced(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  items: { m: THREE.Matrix4; c?: THREE.Color }[],
  shadows = true,
) {
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, items.length));
  mesh.count = items.length;
  items.forEach((it, i) => {
    mesh.setMatrixAt(i, it.m);
    if (it.c) mesh.setColorAt(i, it.c);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = shadows;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  return mesh;
}

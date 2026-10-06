// Terrain: analytic, hand-shaped height function -> mesh, physics trimesh,
// heightmap texture (for water foam, grass, map) and vertex-painted ground.
import * as THREE from 'three';
import {
  BRIDGES, CLEARINGS, HILL, ISLETS, PADS, POND, ROADS, RUINS, STREAM, WATER_LEVEL, WINDHILL,
  islandRadius, isletRadiusOf, PLAZA, type BridgeDef,
} from './layout';
import { clamp, fbm, lerp, noise2, noise2b, polylineDist, smoothstep } from '../utils/math';

export const HALF = 150;
export const GRID = 340; // cells per side
const STEP = (HALF * 2) / GRID;

// ---------- Road distance field (stamped once) ----------
const RD_RES = 1; // metres per cell
const RD_N = Math.ceil((HALF * 2) / RD_RES) + 1;
const roadDistGrid = new Float32Array(RD_N * RD_N).fill(99);
const roadWidthGrid = new Float32Array(RD_N * RD_N).fill(3);
(() => {
  for (const road of ROADS) {
    const p = road.pts;
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1];
      const minX = Math.floor((Math.min(ax, bx) - 8 + HALF) / RD_RES), maxX = Math.ceil((Math.max(ax, bx) + 8 + HALF) / RD_RES);
      const minZ = Math.floor((Math.min(az, bz) - 8 + HALF) / RD_RES), maxZ = Math.ceil((Math.max(az, bz) + 8 + HALF) / RD_RES);
      for (let gz = Math.max(0, minZ); gz <= Math.min(RD_N - 1, maxZ); gz++) {
        for (let gx = Math.max(0, minX); gx <= Math.min(RD_N - 1, maxX); gx++) {
          const x = gx * RD_RES - HALF, z = gz * RD_RES - HALF;
          const dx = bx - ax, dz = bz - az;
          const l2 = dx * dx + dz * dz || 1e-9;
          const t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
          // normalise distance by half-width so wider roads paint wider
          const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t)) - road.width * 0.5;
          const k = gz * RD_N + gx;
          if (d < roadDistGrid[k]) { roadDistGrid[k] = d; roadWidthGrid[k] = road.width; }
        }
      }
    }
  }
})();

/** Signed distance to the nearest road edge (negative = on the road). */
export function roadDist(x: number, z: number) {
  const fx = clamp((x + HALF) / RD_RES, 0, RD_N - 1.001), fz = clamp((z + HALF) / RD_RES, 0, RD_N - 1.001);
  const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
  const k = iz * RD_N + ix;
  const a = lerp(roadDistGrid[k], roadDistGrid[k + 1], tx);
  const b = lerp(roadDistGrid[k + RD_N], roadDistGrid[k + RD_N + 1], tx);
  return lerp(a, b, tz);
}

const bump = (t: number) => (t >= 1 ? 0 : (1 - t * t) * (1 - t * t));
const MOUNDS = [
  [-10, 60, 11, 1.3], [30, 52, 9, 1.0], [-58, 40, 11, 1.6], [66, -6, 10, 1.4], [-20, -62, 13, 1.8],
  [24, -70, 10, 1.4], [70, 26, 8, 1.0], [-66, -40, 9, 1.4], [-6, 72, 7, 0.8], [58, 58, 6, 0.8],
];

export function isInsideIsland(x: number, z: number, margin = 0) {
  const r = Math.hypot(x, z);
  if (r < islandRadius(Math.atan2(z, x)) - margin) return true;
  for (const isl of ISLETS) {
    const ix = x - isl.x, iz = z - isl.z;
    if (Math.hypot(ix, iz) < isletRadiusOf(isl, Math.atan2(iz, ix)) - margin) return true;
  }
  return false;
}

export function pondFactor(x: number, z: number) {
  const ex = (x - POND.x) / POND.rx, ez = (z - POND.z) / POND.rz;
  return Math.sqrt(ex * ex + ez * ez);
}
export function streamDist(x: number, z: number) {
  return polylineDist(x, z, STREAM);
}

function rawHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const th = Math.atan2(z, x);
  const R = islandRadius(th);
  const rd = roadDist(x, z);
  const roadK = 1 - smoothstep(-0.5, 2.5, rd);

  let h = 1.0 + fbm(x * 0.018 + 3.1, z * 0.018 - 1.7, 3) * 1.3;
  h += noise2b(x * 0.09, z * 0.09) * 0.22 * (1 - roadK); // small lumps, flattened on roads
  h += smoothstep(R - 14, R - 3, r) * 0.7; // raised rim lip

  // Lighthouse hill, flattened summit
  {
    const d = Math.hypot(x - HILL.x, z - HILL.z) / HILL.r;
    h += bump(Math.max(0, d - 0.2) / 0.8) * HILL.h;
  }
  {
    const d = Math.hypot(x - WINDHILL.x, z - WINDHILL.z) / WINDHILL.r;
    h += bump(Math.max(0, d - 0.18) / 0.82) * WINDHILL.h;
  }
  h += bump(Math.hypot(x - RUINS.x, z - RUINS.z) / 22) * 1.4;
  for (const m of MOUNDS) h += bump(Math.hypot(x - m[0], z - m[1]) / m[2]) * m[3];

  // Pond basin
  const pf = pondFactor(x, z);
  if (pf < 1.45) {
    const bottom = WATER_LEVEL - 2.1 + noise2(x * 0.15, z * 0.15) * 0.2;
    h = lerp(bottom, h, smoothstep(0.45, 1.35, pf));
  }
  // River channel
  const sd = streamDist(x, z);
  if (sd < 5) {
    const chan = WATER_LEVEL - 0.85;
    const k = smoothstep(1.5, 4.2, sd);
    h = Math.min(h, lerp(chan, h, k));
  }
  // Roads sit a hair lower: reads as worn-in
  h -= roadK * 0.06;

  // Falloff into the void
  const hMain = lerp(h, -7, smoothstep(R - 2.4, R + 1.2, r));

  // Islets
  let best = hMain;
  for (const isl of ISLETS) {
    const ix = x - isl.x, iz = z - isl.z;
    const dI = Math.hypot(ix, iz);
    if (dI > isl.r + 4) continue;
    const RI = isletRadiusOf(isl, Math.atan2(iz, ix));
    const lump = isl.id === 'windward' ? 2.2 : isl.id === 'observatory' ? 1.8 : 1.4;
    let hi = 1.2 + bump(dI / (RI * 0.9)) * lump + noise2b(x * 0.12, z * 0.12) * 0.15;
    hi = lerp(hi, -7, smoothstep(RI - 2.2, RI + 1.2, dI));
    if (hi > best) best = hi;
  }
  return best;
}

const padTargets = PADS.map((p) => rawHeight(p.x, p.z));

export function heightAt(x: number, z: number): number {
  let h = rawHeight(x, z);
  for (let i = 0; i < PADS.length; i++) {
    const p = PADS[i];
    const d = Math.hypot(x - p.x, z - p.z);
    if (d < p.r) h = lerp(padTargets[i], h, smoothstep(p.r * 0.55, p.r, d));
  }
  return h;
}

// ---------- Mesh-accurate sampling (bilinear on the built grid) ----------
const N1 = GRID + 1;
export const heights = new Float32Array(N1 * N1);
for (let j = 0; j < N1; j++) for (let i = 0; i < N1; i++) heights[j * N1 + i] = heightAt(i * STEP - HALF, j * STEP - HALF);

export function groundHeight(x: number, z: number) {
  const fx = clamp((x + HALF) / STEP, 0, GRID - 0.001), fz = clamp((z + HALF) / STEP, 0, GRID - 0.001);
  const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
  const k = iz * N1 + ix;
  // match the triangle split used in the mesh (a-b-d / b-c-d)
  const h00 = heights[k], h10 = heights[k + 1], h01 = heights[k + N1], h11 = heights[k + N1 + 1];
  if (tx + tz <= 1) return h00 + (h10 - h00) * tx + (h01 - h00) * tz;
  return h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
}

export function groundNormal(x: number, z: number, out = new THREE.Vector3()) {
  const e = 0.6;
  const hx = groundHeight(x + e, z) - groundHeight(x - e, z);
  const hz = groundHeight(x, z + e) - groundHeight(x, z - e);
  return out.set(-hx, 2 * e, -hz).normalize();
}

export function inClearing(x: number, z: number, pad = 0) {
  for (const c of CLEARINGS) if (Math.hypot(x - c.x, z - c.z) < c.r + pad) return true;
  return false;
}

export function isWater(x: number, z: number) {
  if (pondFactor(x, z) < 1.12) return true;
  return streamDist(x, z) < 3.2 && groundHeight(x, z) < WATER_LEVEL + 0.1;
}

// ---------- Palette ----------
const C = (hex: number) => new THREE.Color(hex);
export const PAL = {
  grassA: C(0x5f9a52),
  grassB: C(0x3b7a5c),
  grassC: C(0x9fb85a),
  grassD: C(0x76a35a),
  path: C(0xe6c393),
  pathEdge: C(0xc9a77a),
  plaza: C(0xd8bf9a),
  sand: C(0xe5cf9c),
  wetSand: C(0xa89a72),
  bottom: C(0x3f6f68),
  rock: C(0x8b7d9f),
  rockDark: C(0x655a82),
  earth: C(0x80533f),
  ruins: C(0xb7a9a0),
};

/** Ground colour at a point (shared by terrain painting and grass tint). */
export function groundColor(x: number, z: number, h: number, ny: number, out = new THREE.Color()) {
  const n1 = fbm(x * 0.03 + 11, z * 0.03 - 4, 3);
  const n2 = noise2(x * 0.11 + 5, z * 0.11 + 9);
  out.copy(PAL.grassA).lerp(PAL.grassB, smoothstep(-0.25, 0.35, n1));
  out.lerp(PAL.grassC, smoothstep(0.25, 0.6, n2) * 0.55);
  out.lerp(PAL.grassD, smoothstep(0.1, 0.5, -n1) * 0.4);

  // Ruins floor
  const dr = Math.hypot(x - RUINS.x, z - RUINS.z);
  if (dr < 11.5) out.lerp(PAL.ruins, (1 - smoothstep(9.5, 11.5, dr)) * (0.55 + 0.25 * smoothstep(0, 0.6, n2)));

  // Plaza disc
  const dp = Math.hypot(x - PLAZA.x, z - PLAZA.z);
  if (dp < 10) out.lerp(PAL.plaza, 1 - smoothstep(8.6, 10, dp));

  // Roads
  const rd = roadDist(x, z) + noise2(x * 0.4, z * 0.4) * 0.25;
  if (rd < 1.2) {
    const k = 1 - smoothstep(-0.2, 0.9, rd);
    out.lerp(PAL.pathEdge, smoothstep(1.2, 0.3, rd) * 0.6);
    out.lerp(PAL.path, k);
  }

  // Water edges
  const wl = WATER_LEVEL;
  if (h < wl + 0.6) {
    out.lerp(PAL.sand, smoothstep(wl + 0.6, wl + 0.15, h) * 0.9);
    out.lerp(PAL.wetSand, smoothstep(wl + 0.1, wl - 0.25, h));
    out.lerp(PAL.bottom, smoothstep(wl - 0.3, wl - 1.6, h));
  }

  // Slopes and cliffs
  const steep = smoothstep(0.86, 0.62, ny);
  if (steep > 0) out.lerp(n2 > 0 ? PAL.rock : PAL.rockDark, steep);
  if (h < -0.4 && ny < 0.75) {
    // the cut earth below the island lip
    const band = Math.sin(h * 2.2 + n1 * 2) > 0.2;
    out.lerp(h > -2 ? PAL.earth : band ? PAL.rock : PAL.rockDark, smoothstep(-0.4, -1.4, h));
  }
  return out;
}

// ---------- Build ----------
export interface TerrainBuild {
  mesh: THREE.Mesh;
  vertices: Float32Array;
  indices: Uint32Array;
  heightTex: THREE.DataTexture;
}

export function buildTerrain(): TerrainBuild {
  const pos = new Float32Array(N1 * N1 * 3);
  for (let j = 0; j < N1; j++) {
    for (let i = 0; i < N1; i++) {
      const k = j * N1 + i;
      pos[k * 3] = i * STEP - HALF;
      pos[k * 3 + 1] = heights[k];
      pos[k * 3 + 2] = j * STEP - HALF;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const a = j * N1 + i, b = a + 1, d = a + N1, c = d + 1;
      const ha = heights[a], hb = heights[b], hc = heights[c], hd = heights[d];
      const cut = -6.6;
      if (!(ha < cut && hb < cut && hd < cut)) idx.push(a, d, b);
      if (!(hb < cut && hc < cut && hd < cut)) idx.push(b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const indices = new Uint32Array(idx);
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();

  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const col = new Float32Array(N1 * N1 * 3);
  const c = new THREE.Color();
  for (let k = 0; k < N1 * N1; k++) {
    const x = pos[k * 3], h = pos[k * 3 + 1], z = pos[k * 3 + 2];
    groundColor(x, z, h, nrm.getY(k), c);
    col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeBoundingSphere();

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWPos;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),f.x),mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),f.x),f.y); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
      float gN = vnoise(vWPos.xz * 1.7) * 0.6 + vnoise(vWPos.xz * 5.3) * 0.4;
      diffuseColor.rgb *= 0.9 + gN * 0.2;`);
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';

  // Heightmap texture: R = height, G = water mask
  const TN = 320;
  const data = new Float32Array(TN * TN * 4);
  for (let j = 0; j < TN; j++) {
    for (let i = 0; i < TN; i++) {
      const x = (i / (TN - 1)) * HALF * 2 - HALF, z = (j / (TN - 1)) * HALF * 2 - HALF;
      const k = (j * TN + i) * 4;
      data[k] = groundHeight(x, z);
      const inIsle = Math.hypot(x, z) < islandRadius(Math.atan2(z, x)) - 1.5;
      const w = inIsle && (pondFactor(x, z) < 1.4 || streamDist(x, z) < 4.6) ? 1 : 0;
      data[k + 1] = w;
      data[k + 3] = 1;
    }
  }
  const heightTex = new THREE.DataTexture(data, TN, TN, THREE.RGBAFormat, THREE.FloatType);
  heightTex.magFilter = THREE.LinearFilter;
  heightTex.minFilter = THREE.LinearFilter;
  heightTex.needsUpdate = true;

  return { mesh, vertices: pos, indices, heightTex };
}

/** Bridge deck heights at both heads (terrain is flattened there by PADS). */
export function bridgeY(b: BridgeDef) {
  return { a: heightAt(b.a.x, b.a.z) + 0.12, b: heightAt(b.b.x, b.b.z) + 0.12 };
}
export const BRIDGE_Y = bridgeY(BRIDGES[0]);

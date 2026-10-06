// Hand-modelled (in code) architecture & set dressing.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  Builder, M, MAT, blob, box, cone, cyl, ico, lathe, prism, torus, uniforms,
} from './assets';
import {
  BRIDGES, CAMP, FALLS, GEYSERS, HUT, ISLET, LIGHTHOUSE, MUSHROOMS, NOTES, OBSERVATORY, ORIEL, PLAZA, RAMPS, ROADS, RUINS,
  STREAM_BRIDGE, WINDMILL, WINDWARD, islandRadius,
} from './layout';
import { groundHeight, groundNormal, inClearing, isInsideIsland, roadDist, pondFactor, streamDist } from './terrain';
import { mulberry32 } from '../utils/math';
import { RopeBridge } from './ropebridge';
import type { Physics } from '../core/physics';

const WOOD = 0xa96f4b, WOOD_D = 0x77493a, STONE = 0xc2b5bd, STONE_D = 0x948aa5, IRON = 0x3a3346;
const CREAM = 0xf5e6cc, CORAL = 0xe8634e, TEAL = 0x2f7f86, PLUM = 0x7c4a5e, MOSS = 0x76a35a;

export interface Lamp { bulb: THREE.Mesh; pool: THREE.Mesh; x: number; z: number; on: number; target: number; }
export interface Mushroom { cap: THREE.Object3D; x: number; z: number; top: number; r: number; squash: number; }

function lightPoolTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
export const POOL_TEX = lightPoolTexture();

export function makeLightPool(x: number, z: number, size: number, color = 0xffa850) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({ map: POOL_TEX, color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: true }),
  );
  const n = groundNormal(x, z);
  m.position.set(x, groundHeight(x, z) + 0.08, z);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  m.renderOrder = 5;
  return m;
}

function signTexture(lines: string[], w = 512, h = 128, bg = '#f3e2c0', fg = '#4a2f3a') {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(0,0,0,0.08)';
  for (let i = 0; i < 6; i++) g.fillRect(0, (i * h) / 6 + 6, w, 2);
  g.fillStyle = fg;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `600 ${Math.floor(h * 0.42)}px Fraunces, Georgia, serif`;
  lines.forEach((l, i) => g.fillText(l, w / 2, h / 2 + (i - (lines.length - 1) / 2) * h * 0.45));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class Structures {
  group = new THREE.Group();
  windmillBlades = new THREE.Group();
  lighthouseLamp!: THREE.Mesh;
  lighthouseBeam = new THREE.Group();
  lighthouseTop = new THREE.Vector3();
  lamps: Lamp[] = [];
  mushrooms: Mushroom[] = [];
  notePosts: { x: number; z: number; y: number; icon: THREE.Object3D; idx: number }[] = [];
  smokePoints: THREE.Vector3[] = [];
  fireflies: THREE.Vector3[] = [];
  campfire = new THREE.Vector3();
  bellLink: { body: RAPIER.RigidBody; mesh: THREE.Object3D } | null = null;
  bellPos = new THREE.Vector3();
  windows: THREE.Mesh[] = [];
  bridges: RopeBridge[] = [];
  pinwheels: THREE.Object3D[] = [];
  geyserCols: THREE.Mesh[] = [];
  observatoryLamp!: THREE.Mesh;
  observatoryWindows: THREE.Mesh[] = [];
  private stat = new Builder(); // merged static geometry
  private glow = new Builder(); // merged always-glowing bits

  constructor(private physics: Physics) {}

  build() {
    this.hut();
    this.lighthouse();
    this.windmill();
    this.ruins();
    this.streamBridge();
    this.ropeBridges();
    this.observatory();
    this.windward();
    this.geysers();
    this.lampPosts();
    this.fences();
    this.notes();
    this.signpost();
    this.ramps();
    this.mushroomsBuild();
    this.camp();
    this.plazaDressing();
    this.fallsDressing();

    const statMesh = new THREE.Mesh(this.stat.build(), MAT.std);
    statMesh.castShadow = true;
    statMesh.receiveShadow = true;
    this.group.add(statMesh);
    return this.group;
  }

  private place(geo: THREE.BufferGeometry, color: number, x: number, y: number, z: number, yaw: number, local: THREE.Matrix4, o = {}) {
    const world = M(x, y, z, 0, yaw, 0).multiply(local);
    this.stat.add(geo, color, world, o);
  }

  // ---------------------------------------------------------------- hut
  private hut() {
    const { x, z } = HUT;
    const yaw = Math.atan2(PLAZA.x - x, PLAZA.z - z);
    const y = groundHeight(x, z);
    const P = (g: THREE.BufferGeometry, c: number, m: THREE.Matrix4, o = {}) => this.place(g, c, x, y, z, yaw, m, o);
    P(box(5.8, 0.6, 4.8), STONE_D, M(0, 0.1, 0), { jitter: 0.05, vary: 0.1 });
    P(box(5, 2.7, 4), CREAM, M(0, 1.75, 0), { ao: 0.35, aoRange: [-1.35, 1.35] });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) P(box(0.32, 2.8, 0.32), WOOD_D, M(sx * 2.45, 1.8, sz * 1.95));
    P(box(5.2, 0.3, 0.3), WOOD_D, M(0, 3.05, 2.0));
    P(box(5.2, 0.3, 0.3), WOOD_D, M(0, 3.05, -2.0));
    P(prism(5.0, 2.0, 5.6), CREAM, M(0, 3.1, 0, 0, Math.PI / 2, 0));
    // roof slabs
    const slope = Math.atan2(2.1, 2.9);
    for (const s of [-1, 1]) {
      P(box(3.75, 0.25, 6.4), TEAL, M(s * 1.45, 4.25, 0, 0, 0, -s * slope), { jitter: 0.03, vary: 0.08 });
      for (let i = 0; i < 4; i++) P(box(3.8, 0.08, 0.12), 0x24646a, M(s * 1.45 + 0, 4.4, -2.4 + i * 1.6, 0, 0, -s * slope));
    }
    P(box(0.8, 2.4, 0.8), STONE_D, M(1.5, 4.6, -1.0), { jitter: 0.04 });
    P(box(1.0, 0.2, 1.0), STONE, M(1.5, 5.8, -1.0));
    this.smokePoints.push(new THREE.Vector3(x, y + 6.2, z).add(new THREE.Vector3(1.5, 0, -1.0).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw)));
    // door + porch
    P(box(1.1, 1.9, 0.12), PLUM, M(-0.9, 1.35, 2.03));
    P(box(0.12, 0.12, 0.1), 0xf2c14e, M(-0.5, 1.35, 2.1));
    P(box(2.2, 0.15, 1.2), WOOD, M(-0.9, 0.42, 2.6));
    P(box(2.4, 0.12, 1.5), TEAL, M(-0.9, 2.65, 2.55, 0.25, 0, 0));
    // flower box
    P(box(1.4, 0.3, 0.35), WOOD, M(1.2, 1.35, 2.2));
    for (let i = 0; i < 5; i++) P(ico(0.13, 0), [0xff8fb0, 0xffd36b, 0xfff4e6][i % 3], M(0.7 + i * 0.25, 1.6, 2.2));
    // glowing windows (front round + side)
    const win = new THREE.Mesh(new THREE.CircleGeometry(0.45, 16), MAT.lamp);
    const wm = M(x, y, z, 0, yaw, 0).multiply(M(1.2, 2.0, 2.02));
    win.applyMatrix4(wm);
    const win2 = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.8), MAT.lamp);
    win2.applyMatrix4(M(x, y, z, 0, yaw, 0).multiply(M(2.52, 1.9, 0, 0, Math.PI / 2, 0)));
    this.group.add(win, win2);
    P(torus(0.47, 0.07, 4, 16), WOOD_D, M(1.2, 2.0, 2.04));
    this.physics.boxFixed(x, y + 1.6, z, 2.6, 1.8, 2.15, yaw, 'building');
    // porch lamp
    this.addLamp(x + Math.sin(yaw) * 2.4 + Math.cos(yaw) * 0.6, z + Math.cos(yaw) * 2.4 - Math.sin(yaw) * 0.6, 0, true);
  }

  // ---------------------------------------------------------- lighthouse
  private lighthouse() {
    const { x, z } = LIGHTHOUSE;
    const y = groundHeight(x, z) - 0.2;
    const P = (g: THREE.BufferGeometry, c: number, m: THREE.Matrix4, o = {}) => this.place(g, c, x, y, z, 0, m, o);
    P(cyl(4.2, 4.6, 1.0, 12), STONE_D, M(0, 0.4, 0), { jitter: 0.06, vary: 0.1 });
    P(cyl(3.7, 4.0, 0.7, 12), STONE, M(0, 1.1, 0), { jitter: 0.05 });
    const H = 15, bands = 5;
    for (let i = 0; i < bands; i++) {
      const y0 = 1.4 + (i * H) / bands, y1 = 1.4 + ((i + 1) * H) / bands;
      const r0 = 3.1 - (i / bands) * 1.0, r1 = 3.1 - ((i + 1) / bands) * 1.0;
      P(cyl(r1, r0, y1 - y0, 20), i % 2 ? CORAL : CREAM, M(0, (y0 + y1) / 2, 0), { vary: 0.03 });
    }
    // windows & door
    P(box(1.2, 2.0, 0.4), PLUM, M(0, 2.4, 3.0));
    P(box(1.6, 0.25, 0.6), STONE, M(0, 3.5, 3.05));
    for (let i = 0; i < 3; i++) {
      const a = 0.6 + i * 2.2, yy = 5.5 + i * 3.4, rr = 3.1 - ((yy - 1.4) / H) * 1.0;
      P(box(0.5, 0.9, 0.2), IRON, M(Math.sin(a) * rr, yy, Math.cos(a) * rr, 0, a, 0));
    }
    // gallery
    const gy = 1.4 + H;
    P(cyl(2.9, 2.3, 0.45, 20), IRON, M(0, gy + 0.1, 0));
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      P(box(0.07, 0.9, 0.07), IRON, M(Math.cos(a) * 2.75, gy + 0.75, Math.sin(a) * 2.75));
    }
    P(torus(2.75, 0.06, 4, 28), IRON, M(0, gy + 1.2, 0, Math.PI / 2, 0, 0));
    P(cyl(1.6, 1.7, 0.4, 12), CREAM, M(0, gy + 0.5, 0));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      P(box(0.1, 2.2, 0.1), IRON, M(Math.cos(a) * 1.55, gy + 1.8, Math.sin(a) * 1.55));
    }
    P(cone(2.0, 1.7, 12), CORAL, M(0, gy + 3.7, 0), { vary: 0.04 });
    P(ico(0.3, 1), IRON, M(0, gy + 4.7, 0));
    P(box(0.05, 1.0, 0.05), IRON, M(0, gy + 5.2, 0));
    P(box(0.8, 0.25, 0.04), IRON, M(0.3, gy + 5.5, 0));
    // the lamp core (lit at the finale)
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 2.1, 12, 1, true), MAT.glass);
    glass.position.set(x, y + gy + 1.8, z);
    this.group.add(glass);
    this.lighthouseLamp = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.7, 1),
      new THREE.MeshStandardMaterial({ color: 0x302820, emissive: 0xfff0c0, emissiveIntensity: 0.05, flatShading: true }),
    );
    this.lighthouseLamp.position.set(x, y + gy + 1.8, z);
    this.group.add(this.lighthouseLamp);
    this.lighthouseTop.set(x, y + gy + 1.8, z);
    // rotating beams (hidden until the finale)
    const beamMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uOpacity: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform float uOpacity; varying vec2 vUv;
        void main(){ float a = pow(clamp(1.0 - vUv.y, 0.0, 1.0), 2.2) * (0.35 + 0.65 * smoothstep(0.0, 0.5, sin(vUv.x * 3.14159))); gl_FragColor = vec4(vec3(1.0, 0.9, 0.65) * a * uOpacity, 1.0); }`,
    });
    const beamGeo = new THREE.CylinderGeometry(6, 0.35, 110, 16, 1, true);
    beamGeo.translate(0, 55, 0);
    beamGeo.rotateZ(Math.PI / 2 - 0.06);
    for (const s of [1, -1]) {
      const b = new THREE.Mesh(beamGeo, beamMat);
      b.rotation.y = s > 0 ? 0 : Math.PI;
      this.lighthouseBeam.add(b);
    }
    this.lighthouseBeam.position.copy(this.lighthouseTop);
    this.lighthouseBeam.visible = false;
    this.group.add(this.lighthouseBeam);
    this.physics.cylFixed(x, y + 8, z, 3.4, 8.2, 'building');
    this.physics.cylFixed(x, y + 0.45, z, 4.5, 0.5, 'stone');
  }

  // ------------------------------------------------------------ windmill
  private windmill() {
    const { x, z } = WINDMILL;
    const y = groundHeight(x, z) - 0.2;
    const P = (g: THREE.BufferGeometry, c: number, m: THREE.Matrix4, o = {}) => this.place(g, c, x, y, z, 0, m, o);
    P(lathe([[0, 0], [3.4, 0], [3.3, 0.6], [2.9, 1], [2.3, 8.5], [0, 8.5]], 10), 0xe9d8bd, M(0, 0, 0), { jitter: 0.05, ao: 0.3 });
    P(cyl(3.5, 3.6, 0.6, 10), STONE_D, M(0, 0.2, 0), { jitter: 0.05 });
    for (let i = 0; i < 4; i++) P(box(4.9 - i * 0.5, 0.18, 0.1), WOOD_D, M(0, 2 + i * 2, 0, 0, i * 0.8, 0));
    // cap
    const yaw = Math.atan2(-x + 5, -z + 20); // face back towards the island centre
    const capM = M(0, 8.4, 0, 0, yaw, 0);
    P(cyl(2.6, 2.6, 0.5, 10), WOOD_D, capM);
    P(lathe([[2.7, 0], [2.4, 1.2], [1.2, 2.3], [0, 2.6]], 10), 0x9b4a3f, M(0, 8.6, 0, 0, yaw, 0), { vary: 0.05 });
    P(box(1.1, 1.8, 0.2), PLUM, M(Math.sin(yaw + 0.5) * 3.1, 1.2, Math.cos(yaw + 0.5) * 3.1, 0, yaw + 0.5, 0));
    for (const a of [1.6, 3.4]) P(box(0.6, 0.8, 0.25), IRON, M(Math.sin(yaw + a) * 2.6, 5.2, Math.cos(yaw + a) * 2.6, 0, yaw + a, 0));
    // blades
    const bb = new Builder();
    bb.add(cyl(0.45, 0.45, 0.9, 8), IRON, M(0, 0, 0, Math.PI / 2, 0, 0));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const rot = (m: THREE.Matrix4) => M(0, 0, 0, 0, 0, a).multiply(m);
      bb.add(box(0.22, 7.4, 0.18), WOOD_D, rot(M(0, 3.9, 0.3)));
      bb.add(box(1.7, 5.6, 0.06), 0xf6ead6, rot(M(0.95, 4.4, 0.36)), { vary: 0.05 });
      for (let k = 0; k < 6; k++) bb.add(box(1.8, 0.07, 0.08), WOOD, rot(M(0.95, 1.8 + k * 1.05, 0.42)));
    }
    const blades = new THREE.Mesh(bb.build(), MAT.std);
    blades.castShadow = true;
    this.windmillBlades.add(blades);
    this.windmillBlades.position.set(x + Math.sin(yaw) * 2.9, y + 8.6, z + Math.cos(yaw) * 2.9);
    this.windmillBlades.rotation.y = yaw;
    this.group.add(this.windmillBlades);
    this.physics.cylFixed(x, y + 4.5, z, 3.2, 4.5, 'building');
    // sacks around
    for (let i = 0; i < 3; i++) P(blob(0.5, 1, 0.08, 70 + i, 0.75), 0xd9c08f, M(2.9 + i * 0.6, 0.35, -2.4 + i * 0.4));
  }

  // --------------------------------------------------------------- ruins
  private ruins() {
    const { x, z } = RUINS;
    const r = mulberry32(17);
    const n = 11;
    const tops: (THREE.Vector3 | null)[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.2;
      const rr = 9;
      const sx = x + Math.cos(a) * rr, sz = z + Math.sin(a) * rr;
      if (i === 3) { tops.push(null); continue; } // a gap to drive through
      const fallen = i === 7;
      const h = fallen ? 1.0 : 2.6 + r() * 1.3;
      const gy = groundHeight(sx, sz);
      const tilt = fallen ? 0 : (r() - 0.5) * 0.12;
      const m = fallen ? M(sx, gy + 0.45, sz, Math.PI / 2, -a, 0.2) : M(sx, gy + h / 2 - 0.2, sz, tilt, -a + Math.PI / 2, tilt);
      this.stat.add(box(1.5, h, 1.0, 2, 3, 1), STONE, m, { jitter: 0.09, topColor: MOSS, topAmount: 0.8, ao: 0.3, vary: 0.12 });
      if (!fallen) this.physics.boxFixed(sx, gy + h / 2, sz, 0.75, h / 2, 0.5, -a + Math.PI / 2, 'stone');
      else this.physics.boxFixed(sx, gy + 0.45, sz, 0.5, 0.5, 1.3, -a, 'stone');
      tops.push(fallen ? null : new THREE.Vector3(sx, gy + h - 0.2, sz));
    }
    // lintels on a couple of neighbouring pairs
    for (const i of [0, 5, 9]) {
      const a = tops[i], b = tops[(i + 1) % n];
      if (!a || !b) continue;
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const len = a.distanceTo(b) + 1.2;
      const yaw = Math.atan2(b.x - a.x, b.z - a.z);
      const y = Math.max(a.y, b.y) + 0.35;
      this.stat.add(box(1.0, 0.7, len, 1, 1, 3), STONE, M(mid.x, y, mid.z, 0, yaw, 0), { jitter: 0.08, topColor: MOSS, topAmount: 0.9, vary: 0.1 });
    }
    // bell frame
    const bx = x + 1, bz = z - 6.2;
    const gy = groundHeight(bx, bz);
    for (const s of [-1, 1]) {
      this.stat.add(box(0.35, 3.2, 0.35), WOOD_D, M(bx + s * 2.2, gy + 1.5, bz, 0, 0, s * -0.05));
      this.stat.add(box(0.9, 0.25, 0.9), STONE_D, M(bx + s * 2.2, gy + 0.05, bz), { jitter: 0.04 });
      this.physics.boxFixed(bx + s * 2.2, gy + 1.5, bz, 0.18, 1.6, 0.18, 0, 'building');
    }
    this.stat.add(box(5.2, 0.35, 0.4), WOOD_D, M(bx, gy + 3.05, bz));
    this.stat.add(prism(1.2, 0.6, 5.6), TEAL, M(bx, gy + 3.2, bz, 0, Math.PI / 2, 0));
    // the bell is a real pendulum
    const bellGeo = new Builder()
      .add(lathe([[0.05, 0], [0.55, -0.15], [0.7, -0.9], [0.95, -1.45], [0.98, -1.6], [0, -1.6]], 14), 0xc99a3f, M(0, 0, 0), { vary: 0.05 })
      .add(ico(0.18, 0), 0x6b4a2a, M(0, -1.55, 0))
      .add(box(0.12, 0.4, 0.12), IRON, M(0, 0.15, 0))
      .build();
    const bell = new THREE.Mesh(bellGeo, MAT.metal);
    bell.castShadow = true;
    const pivot = new THREE.Vector3(bx, gy + 2.55, bz);
    bell.position.copy(pivot);
    this.group.add(bell);
    const anchor = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(pivot.x, pivot.y, pivot.z));
    const link = this.physics.addDynamic(bell, [RAPIER.ColliderDesc.cylinder(0.75, 0.8).setTranslation(0, -0.85, 0)], { kind: 'bell', angDamping: 0.25, damping: 0.05 });
    link.body.setAdditionalMass(2, true);
    const joint = RAPIER.JointData.spherical({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    this.physics.world.createImpulseJoint(joint, anchor, link.body, true);
    this.bellLink = { body: link.body, mesh: bell };
    this.bellPos.copy(pivot);
  }

  // ------------------------------------------------------ stream bridge
  private streamBridge() {
    const { x, z, yaw } = STREAM_BRIDGE;
    const len = 10, w = 3.4;
    const yA = groundHeight(x + Math.sin(yaw) * -len / 2, z + Math.cos(yaw) * -len / 2);
    const yB = groundHeight(x + Math.sin(yaw) * len / 2, z + Math.cos(yaw) * len / 2);
    const arch = 0.75;
    const planks = 16;
    const deckY = (t: number) => yA + (yB - yA) * t + Math.sin(t * Math.PI) * arch;
    for (let i = 0; i < planks; i++) {
      const t = (i + 0.5) / planks;
      const lz = -len / 2 + t * len;
      const slope = Math.atan2((deckY(t + 0.01) - deckY(t - 0.01)), len * 0.02);
      this.place(box(w, 0.16, len / planks - 0.05), i % 2 ? WOOD : 0xb27a55, x, 0, z, yaw, M(0, deckY(t), lz, -slope, 0, 0), { vary: 0.1 });
    }
    for (const s of [-1, 1]) {
      this.place(box(0.22, 0.4, len + 0.4), WOOD_D, x, 0, z, yaw, M(s * (w / 2 + 0.05), (yA + yB) / 2 + 0.1, 0));
      for (let i = 0; i <= 4; i++) {
        const t = i / 4;
        this.place(box(0.18, 1.1, 0.18), WOOD_D, x, 0, z, yaw, M(s * (w / 2 + 0.05), deckY(t) + 0.5, -len / 2 + t * len));
      }
      for (let i = 0; i < 8; i++) {
        const t0 = i / 8, t1 = (i + 1) / 8;
        const y0 = deckY(t0) + 1.0, y1 = deckY(t1) + 1.0;
        const seg = len / 8;
        this.place(box(0.12, 0.12, seg + 0.05), WOOD, x, 0, z, yaw, M(s * (w / 2 + 0.05), (y0 + y1) / 2, -len / 2 + (t0 + t1) / 2 * len, -Math.atan2(y1 - y0, seg), 0, 0));
      }
      this.physics.boxFixed(x + Math.cos(yaw) * s * (w / 2 + 0.15), (yA + yB) / 2 + 0.9, z - Math.sin(yaw) * s * (w / 2 + 0.15), 0.12, 0.7, len / 2, yaw, 'fence');
    }
    // deck colliders: 4 tilted slabs following the arch
    const q = new THREE.Quaternion();
    for (let i = 0; i < 4; i++) {
      const t0 = i / 4, t1 = (i + 1) / 4;
      const y0 = deckY(t0), y1 = deckY(t1);
      const seg = len / 4;
      const pitch = -Math.atan2(y1 - y0, seg);
      q.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
      const lz = -len / 2 + ((t0 + t1) / 2) * len;
      const cx = x + Math.sin(yaw) * lz, cz = z + Math.cos(yaw) * lz;
      this.physics.fixed(RAPIER.ColliderDesc.cuboid(w / 2, 0.12, seg / 2 + 0.15).setFriction(0.9), cx, (y0 + y1) / 2, cz, q, 'bridge');
    }
  }

  // --------------------------------------------------------- rope bridges
  private ropeBridges() {
    for (const def of BRIDGES) {
      const br = new RopeBridge(def, this.physics, this.group, this.stat);
      this.bridges.push(br);
      for (const l of br.lampSpots) this.addLamp(l.x, l.z, 0);
    }
  }

  updateBridge(dt: number, time: number, carPos: THREE.Vector3 | null) {
    for (const b of this.bridges) b.update(dt, time, carPos);
  }

  // ---------------------------------------------------------- observatory
  private observatory() {
    const { x, z } = OBSERVATORY;
    const y = groundHeight(x, z) - 0.15;
    const P = (g: THREE.BufferGeometry, c: number, m: THREE.Matrix4, o = {}) => this.place(g, c, x, y, z, 0, m, o);
    P(cyl(4.9, 5.3, 0.6, 14), STONE_D, M(0, 0.2, 0), { jitter: 0.05, vary: 0.1 });
    P(cyl(4.2, 4.5, 3.4, 14), 0xe9dcc6, M(0, 2.1, 0), { ao: 0.35, vary: 0.04 });
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      P(box(0.35, 3.5, 0.3), STONE, M(Math.cos(a) * 4.42, 2.1, Math.sin(a) * 4.42, 0, -a, 0), { jitter: 0.02 });
    }
    P(cyl(4.6, 4.6, 0.35, 16), STONE, M(0, 3.9, 0));
    // ribbed copper dome with an open slit facing north-east
    const dome = new Builder();
    const segs = 16;
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      if (i === 2 || i === 3) continue; // the slit
      const g = new THREE.SphereGeometry(4.25, 2, 8, a0, (Math.PI * 2) / segs, 0, Math.PI / 2);
      dome.add(g, i % 2 ? 0x3f9a8f : 0x358a80, M(0, 0, 0), { vary: 0.04 });
    }
    dome.add(new THREE.SphereGeometry(0.45, 8, 6), 0xc99a3f, M(0, 4.25, 0));
    const domeMesh = new THREE.Mesh(dome.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.35, flatShading: true, side: THREE.DoubleSide }));
    domeMesh.position.set(x, y + 4.05, z);
    domeMesh.castShadow = true;
    this.group.add(domeMesh);
    // the telescope pokes out of the slit
    const aT = ((2.5 / segs) * Math.PI * 2);
    const tel = new Builder()
      .add(cyl(0.45, 0.6, 5.2, 12), 0xc99a3f, M(0, 2.6, 0), { vary: 0.05 })
      .add(cyl(0.65, 0.65, 0.4, 12), 0x3a3346, M(0, 5.1, 0))
      .add(cyl(0.62, 0.62, 0.3, 12), 0x3a3346, M(0, 0.6, 0))
      .build();
    const telMesh = new THREE.Mesh(tel, MAT.metal);
    telMesh.position.set(x + Math.cos(aT) * 1.2, y + 4.4, z + Math.sin(aT) * 1.2);
    telMesh.rotation.set(Math.sin(aT) * 0.75, 0, -Math.cos(aT) * 0.75);
    telMesh.castShadow = true;
    this.group.add(telMesh);
    // door, steps, windows
    const doorA = Math.atan2(ORIEL.z - z, ORIEL.x - x);
    const dx = Math.cos(doorA), dz = Math.sin(doorA);
    const yawD = Math.atan2(dx, dz);
    this.stat.add(box(1.4, 2.3, 0.4), PLUM, M(x + dx * 4.4, y + 1.55, z + dz * 4.4, 0, yawD, 0));
    this.stat.add(box(2.2, 0.25, 1.2), STONE, M(x + dx * 5.0, y + 0.3, z + dz * 5.0, 0, yawD, 0));
    for (const off of [-1.1, 1.1, 2.4]) {
      const a = doorA + off;
      const w = new THREE.Mesh(new THREE.CircleGeometry(0.38, 12), MAT.lamp.clone());
      w.position.set(x + Math.cos(a) * 4.62, y + 2.6, z + Math.sin(a) * 4.62);
      w.rotation.y = Math.atan2(Math.cos(a), Math.sin(a));
      this.group.add(w);
      this.observatoryWindows.push(w);
    }
    // the answering lantern on the dome's finial
    this.observatoryLamp = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 1), new THREE.MeshStandardMaterial({ color: 0x40301c, emissive: 0xffc46b, emissiveIntensity: 0.0 }));
    this.observatoryLamp.position.set(x, y + 9.0, z);
    this.group.add(this.observatoryLamp);
    this.stat.add(box(0.08, 0.6, 0.08), IRON, M(x, y + 8.55, z));
    this.physics.cylFixed(x, y + 2.5, z, 4.7, 2.6, 'building');
    this.physics.fixed(RAPIER.ColliderDesc.ball(4.3), x, y + 4.05, z, undefined, 'building');
    // a star-chart table and a bench outside
    const tx = x + dx * 7 + dz * 2.5, tz = z + dz * 7 - dx * 2.5;
    const ty = groundHeight(tx, tz);
    this.stat.add(box(1.6, 0.1, 1.0), WOOD, M(tx, ty + 0.85, tz, 0, yawD + 0.4, 0));
    this.stat.add(box(1.4, 0.02, 0.8), 0x2f3a6e, M(tx, ty + 0.91, tz, 0, yawD + 0.4, 0));
    for (const [sx, sz] of [[-0.65, -0.35], [0.65, -0.35], [-0.65, 0.35], [0.65, 0.35]]) {
      this.stat.add(box(0.08, 0.85, 0.08), WOOD_D, M(tx, ty + 0.42, tz, 0, yawD + 0.4, 0).multiply(M(sx, 0, sz)));
    }
    this.physics.boxFixed(tx, ty + 0.5, tz, 0.8, 0.5, 0.5, yawD + 0.4, 'bench');
  }

  // ------------------------------------------------------- windward isle
  private windward() {
    const { x, z } = WINDWARD;
    const cols = [0xe8634e, 0xffc23d, 0x5fb3c9, 0xff8fb0, 0xfff1d8];
    const r = mulberry32(44);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + r() * 0.4;
      const d = 4 + r() * 4.5;
      const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
      if (GEYSERS.some((g) => Math.hypot(px - g.x, pz - g.z) < 3.5 || Math.hypot(px - g.tx, pz - g.tz) < 4)) continue;
      const gy = groundHeight(px, pz);
      const h = 1.6 + r() * 1.4;
      this.stat.add(cyl(0.04, 0.05, h, 4), 0xe9e0d0, M(px, gy + h / 2, pz));
      const wheel = new THREE.Group();
      const b = new Builder();
      for (let k = 0; k < 4; k++) {
        const s = new THREE.Shape();
        s.moveTo(0, 0); s.lineTo(0.42, 0.06); s.lineTo(0.08, 0.38); s.lineTo(0, 0);
        b.add(new THREE.ShapeGeometry(s), cols[(i + k) % cols.length], M(0, 0, 0, 0, 0, (k / 4) * Math.PI * 2));
      }
      b.add(new THREE.SphereGeometry(0.05, 6, 4), 0x3a3346, M(0, 0, 0.02));
      const m = new THREE.Mesh(b.build(), new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.6 }));
      wheel.add(m);
      wheel.position.set(px, gy + h, pz);
      wheel.rotation.y = r() * Math.PI * 2;
      wheel.userData.speed = 2 + r() * 4;
      this.group.add(wheel);
      this.pinwheels.push(wheel);
    }
    // a little stone arch framing the garden
    const ax = x + 5.5, az = z + 5.5;
    const ag = groundHeight(ax, az);
    for (const s of [-1, 1]) this.stat.add(box(0.6, 2.8, 0.6), STONE, M(ax + s * 1.6, ag + 1.3, az - s * 1.6, 0, Math.PI / 4, 0), { jitter: 0.05, topColor: MOSS, topAmount: 0.6 });
    this.stat.add(box(4.6, 0.5, 0.7), STONE, M(ax, ag + 2.9, az, 0, -Math.PI / 4, 0), { jitter: 0.05, topColor: MOSS, topAmount: 0.8 });
    for (const s of [-1, 1]) this.physics.boxFixed(ax + s * 1.6, ag + 1.3, az - s * 1.6, 0.3, 1.4, 0.3, Math.PI / 4, 'stone');
  }

  // ------------------------------------------------------------- geysers
  private geysers() {
    const colMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uTime: uniforms.uTime },
      vertexShader: `varying vec2 vUv; varying float vY; void main(){ vUv = uv; vY = position.y; vec3 p = position; p.xz *= 1.0 + uv.y * 0.6; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
      fragmentShader: /* glsl */`uniform float uTime; varying vec2 vUv;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
        void main(){
          float s = n(vec2(vUv.x * 10.0 + vUv.y * 3.0, vUv.y * 4.0 - uTime * 2.4)) * 0.6 + n(vec2(vUv.x * 22.0 - vUv.y * 5.0, vUv.y * 8.0 - uTime * 3.6)) * 0.4;
          float streak = smoothstep(0.55, 0.85, s);
          float a = streak * (1.0 - vUv.y) * smoothstep(0.0, 0.08, vUv.y) * 0.55;
          gl_FragColor = vec4(vec3(0.85, 0.95, 1.0) * a, 1.0);
        }`,
    });
    const colGeo = new THREE.CylinderGeometry(1.3, 1.0, 7, 20, 6, true);
    colGeo.translate(0, 3.5, 0);
    for (const g of GEYSERS) {
      const y = groundHeight(g.x, g.z);
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        this.stat.add(blob(0.5, 0, 0.2, 800 + i, 0.7), STONE, M(g.x + Math.cos(a) * 2.2, y + 0.1, g.z + Math.sin(a) * 2.2), { topColor: MOSS, topAmount: 0.5 });
      }
      this.stat.add(cyl(1.9, 2.1, 0.18, 16), STONE_D, M(g.x, y + 0.02, g.z));
      for (let i = 0; i < 6; i++) this.stat.add(box(3.4, 0.06, 0.12), IRON, M(g.x, y + 0.14, g.z, 0, (i / 6) * Math.PI, 0));
      const col = new THREE.Mesh(colGeo, colMat);
      col.position.set(g.x, y, g.z);
      col.renderOrder = 6;
      this.group.add(col);
      this.geyserCols.push(col);
      const pool = makeLightPool(g.x, g.z, 7, 0x9fd8ff);
      (pool.material as THREE.MeshBasicMaterial).opacity = 0.5;
      this.group.add(pool);
    }
  }

  // ---------------------------------------------------------- lamp posts
  addLamp(x: number, z: number, yaw: number, porch = false) {
    const y = groundHeight(x, z);
    if (!porch) {
      this.stat.add(cyl(0.09, 0.13, 3.0, 6), IRON, M(x, y + 1.5, z));
      this.stat.add(cyl(0.22, 0.3, 0.35, 6), STONE_D, M(x, y + 0.15, z));
      this.stat.add(box(0.5, 0.08, 0.5), IRON, M(x, y + 3.05, z, 0, yaw, 0));
      this.stat.add(cone(0.42, 0.35, 4), IRON, M(x, y + 3.85, z, 0, yaw + Math.PI / 4, 0));
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) this.stat.add(box(0.05, 0.62, 0.05), IRON, M(x + sx * 0.2, y + 3.38, z + sz * 0.2));
      this.physics.cylFixed(x, y + 1.5, z, 0.14, 1.5, 'lamp');
    }
    if (porch) {
      this.stat.add(cyl(0.07, 0.09, 2.1, 5), WOOD_D, M(x, y + 1.0, z));
      this.stat.add(cone(0.32, 0.3, 4), IRON, M(x, y + 2.72, z, 0, Math.PI / 4, 0));
      this.physics.cylFixed(x, y + 1.0, z, 0.1, 1.0, 'lamp');
    }
    const bulb = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.5, 0.34), MAT.lamp.clone());
    bulb.position.set(x, y + (porch ? 2.3 : 3.36), z);
    this.group.add(bulb);
    const pool = makeLightPool(x, z, porch ? 5 : 7.5);
    this.group.add(pool);
    this.lamps.push({ bulb, pool, x, z, on: 0, target: 0 });
  }

  private lampPosts() {
    // along every road, alternating sides, ~every 19m
    for (const road of ROADS) {
      let acc = 6, side = 1;
      for (let i = 1; i < road.pts.length; i++) {
        const [ax, az] = road.pts[i - 1], [bx, bz] = road.pts[i];
        const d = Math.hypot(bx - ax, bz - az);
        acc += d;
        if (acc < 19) continue;
        acc = 0;
        const nx = -(bz - az) / d, nz = (bx - ax) / d;
        const x = bx + nx * side * (road.width / 2 + 1.0), z = bz + nz * side * (road.width / 2 + 1.0);
        side *= -1;
        if (!isInsideIsland(x, z, 3) || pondFactor(x, z) < 1.3 || streamDist(x, z) < 3.5) continue;
        if (this.lamps.some((l) => Math.hypot(l.x - x, l.z - z) < 9)) continue;
        if (Math.hypot(x - LIGHTHOUSE.x, z - LIGHTHOUSE.z) < 5.5) continue;
        if (inClearing(x, z, -3) && Math.hypot(x - PLAZA.x, z - PLAZA.z) > 12) continue;
        this.addLamp(x, z, Math.atan2(nx, nz));
      }
    }
  }

  // --------------------------------------------------------------- fences
  private fenceLine(pts: number[][], height = 1.0) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.round(len / 2.2));
      const yaw = Math.atan2(bx - ax, bz - az);
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        const y = groundHeight(x, z);
        this.stat.add(box(0.2, height + 0.3, 0.2), WOOD_D, M(x, y + (height + 0.3) / 2 - 0.15, z, 0, yaw, (Math.sin(x * 7) * 0.05)), { ao: 0.3 });
        if (k < n) {
          const t2 = (k + 1) / n;
          const x2 = ax + (bx - ax) * t2, z2 = az + (bz - az) * t2;
          const y2 = groundHeight(x2, z2);
          const mx = (x + x2) / 2, mz = (z + z2) / 2, my = (y + y2) / 2;
          const seg = Math.hypot(x2 - x, z2 - z);
          const pitch = -Math.atan2(y2 - y, seg);
          for (const hh of [0.45, 0.85]) this.stat.add(box(0.1, 0.14, seg + 0.1), WOOD, M(mx, my + hh * height, mz, pitch, yaw, 0), { vary: 0.08 });
        }
      }
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      this.physics.boxFixed(mx, groundHeight(mx, mz) + 0.5, mz, 0.12, 0.7, len / 2, yaw, 'fence');
    }
  }

  private fences() {
    // waterfall overlook (leaves the river mouth open)
    const fx = FALLS.x, fz = FALLS.z, dx = FALLS.dirX, dz = FALLS.dirZ;
    const px = -dz, pz = dx;
    const back = 2.5;
    this.fenceLine([[fx - dx * back + px * 4.5, fz - dz * back + pz * 4.5], [fx - dx * back + px * 11, fz - dz * back + pz * 11]]);
    this.fenceLine([[fx - dx * back - px * 4.5, fz - dz * back - pz * 4.5], [fx - dx * back - px * 10, fz - dz * back - pz * 10]]);
    // pasture fence around the orchard's east edge
    this.fenceLine([[56, 6], [60, 14], [60, 24], [55, 30]]);
    // camp
    this.fenceLine([[CAMP.x - 5, CAMP.z - 4], [CAMP.x + 4, CAMP.z - 5]]);
  }

  // ----------------------------------------------------------- notes
  private notes() {
    NOTES.forEach((n, idx) => {
      const y = groundHeight(n.x, n.z);
      this.stat.add(box(0.16, 1.5, 0.16), WOOD_D, M(n.x, y + 0.65, n.z, 0, n.yaw, 0));
      this.stat.add(box(1.1, 0.75, 0.1), WOOD, M(n.x, y + 1.35, n.z, -0.25, n.yaw, 0), { vary: 0.1 });
      this.stat.add(box(0.75, 0.5, 0.02), 0xf8f0dc, M(n.x + Math.sin(n.yaw) * 0.07, y + 1.37, n.z + Math.cos(n.yaw) * 0.07, -0.25, n.yaw, 0));
      this.physics.cylFixed(n.x, y + 0.7, n.z, 0.15, 0.7, 'sign');
      // floating marker
      const icon = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.05, 6, 20), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff1c9).multiplyScalar(2) }));
      const dot = new THREE.Mesh(new THREE.OctahedronGeometry(0.14, 0), ring.material);
      icon.add(ring, dot);
      icon.position.set(n.x, y + 2.4, n.z);
      this.group.add(icon);
      this.notePosts.push({ x: n.x, z: n.z, y, icon, idx });
    });
  }

  private signpost() {
    const x = PLAZA.x - 4.2, z = PLAZA.z - 5.5;
    const y = groundHeight(x, z);
    this.stat.add(cyl(0.13, 0.16, 3.4, 6), WOOD_D, M(x, y + 1.6, z));
    this.physics.cylFixed(x, y + 1.6, z, 0.16, 1.6, 'sign');
    const arrows: [string, number, number][] = [
      ['LIGHTHOUSE', Math.atan2(0 - x, -8 - z), 2.8],
      ['THE POND', Math.atan2(-36 - x, 8 - z), 2.3],
      ['ORCHARD', Math.atan2(42 - x, 18 - z), 1.8],
    ];
    for (const [label, yaw, hh] of arrows) {
      const tex = signTexture([label]);
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 });
      const g = new THREE.Group();
      const board = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.42, 0.08), [MAT.std, MAT.std, MAT.std, MAT.std, mat, mat]);
      // box faces need vertex colours for MAT.std: give them a flat colour attribute
      const cnt = (board.geometry.getAttribute('position') as THREE.BufferAttribute).count;
      const cols = new Float32Array(cnt * 3).fill(0.62);
      board.geometry.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      board.position.x = 1.0;
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.29, 0.4, 3), new THREE.MeshStandardMaterial({ color: 0xf3e2c0, flatShading: true }));
      tip.rotation.z = -Math.PI / 2;
      tip.position.x = 2.18;
      tip.scale.z = 0.25;
      g.add(board, tip);
      g.position.set(x, y + hh, z);
      g.rotation.y = yaw - Math.PI / 2;
      board.castShadow = true;
      this.group.add(g);
    }
  }

  // ------------------------------------------------------------- ramps
  private ramps() {
    for (const r of RAMPS) {
      const len = 6.5, w = 3.6, h = 1.7;
      const y = groundHeight(r.x, r.z) - 0.05;
      const s = new THREE.Shape();
      s.moveTo(0, 0); s.lineTo(len, 0); s.lineTo(len, h); s.lineTo(0, 0);
      const g = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false });
      g.translate(-len / 2, 0, -w / 2);
      g.rotateY(-Math.PI / 2); // length along +Z
      const world = M(r.x, y, r.z, 0, r.yaw, 0);
      this.stat.add(g, WOOD, world, { vary: 0.08 });
      // planks + painted chevrons
      const slope = Math.atan2(h, len);
      for (let i = 0; i < 9; i++) {
        const t = (i + 0.5) / 9;
        const lz = -len / 2 + t * len;
        this.stat.add(box(w + 0.1, 0.06, len / 9 - 0.08), i % 2 ? 0xb27a55 : WOOD, world.clone().multiply(M(0, t * h + 0.04, lz, -slope, 0, 0)));
      }
      for (let i = 0; i < 3; i++) {
        const t = 0.25 + i * 0.25;
        for (const sd of [-1, 1]) {
          this.stat.add(box(0.85, 0.03, 0.22), 0xf2c14e, world.clone().multiply(M(sd * 0.32, t * h + 0.09, -len / 2 + t * len, -slope, sd * 0.7, 0)));
        }
      }
      // collider: convex hull of the wedge
      const pts = new Float32Array([
        -w / 2, 0, -len / 2, w / 2, 0, -len / 2, -w / 2, 0, len / 2, w / 2, 0, len / 2, -w / 2, h, len / 2, w / 2, h, len / 2,
      ]);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.yaw);
      const desc = RAPIER.ColliderDesc.convexHull(pts)!;
      desc.setFriction(0.9);
      this.physics.fixed(desc, r.x, y, r.z, q, 'ramp');
    }
  }

  // ---------------------------------------------------------- mushrooms
  private mushroomsBuild() {
    for (const m of MUSHROOMS) {
      const y = groundHeight(m.x, m.z) - 0.1;
      const s = m.s;
      this.stat.add(lathe([[0.55, 0], [0.45, 0.8], [0.4, 1.8], [0.5, 2.3], [0, 2.3]], 10), 0xf3e8d6, M(m.x, y, m.z, 0, 0, 0, s), { ao: 0.4 });
      const cb = new Builder();
      cb.add(lathe([[0, 0.95], [1.2, 0.85], [2.0, 0.35], [2.25, -0.05], [1.9, -0.15], [0.4, 0], [0, 0]], 14), 0xe8504f, M(), { vary: 0.05 });
      const rr = mulberry32(Math.floor(m.x * 10));
      for (let i = 0; i < 9; i++) {
        const a = rr() * 6.28, d = 0.4 + rr() * 1.4;
        const hy = 0.95 - (d / 2.25) ** 2 * 0.95;
        cb.add(new THREE.SphereGeometry(0.2 + rr() * 0.12, 6, 4), 0xfff4e6, M(Math.cos(a) * d, hy + 0.02, Math.sin(a) * d, 0, 0, 0, 1, 0.35, 1));
      }
      const cap = new THREE.Mesh(cb.build(), MAT.std);
      cap.castShadow = true;
      cap.position.set(m.x, y + 2.25 * s, m.z);
      cap.scale.setScalar(s);
      cap.userData.base = s;
      this.group.add(cap);
      this.physics.cylFixed(m.x, y + 1.1 * s, m.z, 0.5 * s, 1.15 * s, 'mushroom');
      this.physics.cylFixed(m.x, y + 2.8 * s, m.z, 2.1 * s, 0.35 * s, 'mushroom');
      this.mushrooms.push({ cap, x: m.x, z: m.z, top: y + 3.15 * s, r: 2.1 * s, squash: 0 });
    }
  }

  // ---------------------------------------------------------------- camp
  private camp() {
    const { x, z } = CAMP;
    const y = groundHeight(x, z);
    this.stat.add(prism(3.2, 2.2, 3.4), 0xd99a4e, M(x - 2, y, z - 1, 0, 0.4, 0), { ao: 0.3, vary: 0.04 });
    this.stat.add(prism(0.9, 0.7, 3.5), 0x9b4a3f, M(x - 2, y + 1.55, z - 1, 0, 0.4, 0));
    this.physics.boxFixed(x - 2, y + 0.9, z - 1, 1.5, 0.9, 1.7, 0.4, 'building');
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      this.stat.add(blob(0.22, 0, 0.2, 500 + i), STONE_D, M(x + 1.5 + Math.cos(a) * 0.7, y + 0.1, z + 1 + Math.sin(a) * 0.7));
    }
    for (let i = 0; i < 3; i++) this.stat.add(cyl(0.08, 0.08, 1.0, 5), WOOD_D, M(x + 1.5, y + 0.25, z + 1, 1.2, i * 2.1, 0));
    this.campfire.set(x + 1.5, y + 0.3, z + 1);
    this.stat.add(cyl(0.3, 0.3, 2.2, 7), WOOD_D, M(x + 1.5, y + 0.3, z + 3.2, 0, 0, Math.PI / 2), { vary: 0.1 });
    this.stat.add(cyl(0.3, 0.3, 2.0, 7), WOOD_D, M(x + 3.6, y + 0.3, z + 1.2, Math.PI / 2, 0, 0), { vary: 0.1 });
    // telescope pointed at the sky
    this.stat.add(cyl(0.03, 0.03, 1.3, 4), IRON, M(x - 0.4, y + 0.6, z + 2.5, 0.3, 0, 0.2));
    this.stat.add(cyl(0.03, 0.03, 1.3, 4), IRON, M(x - 0.1, y + 0.6, z + 2.7, -0.2, 0, -0.25));
    this.stat.add(cyl(0.12, 0.08, 1.4, 8), 0xc99a3f, M(x - 0.25, y + 1.35, z + 2.6, -0.6, 0.5, 0));
    this.addLamp(x + 3.6, z - 1.2, 0, true);
  }

  // -------------------------------------------------------- plaza
  private plazaDressing() {
    const { x, z } = PLAZA;
    const y = groundHeight(x, z);
    // stone ring + sundial dais
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      if (Math.abs(Math.sin(a)) > 0.93 || Math.abs(Math.cos(a - 0.3)) > 0.985) continue; // openings for the roads
      this.stat.add(box(1.4, 0.22, 0.5), STONE, M(x + Math.cos(a) * 9.4, y + 0.02, z + Math.sin(a) * 9.4, 0, -a + Math.PI / 2, 0), { jitter: 0.03, vary: 0.12 });
    }
    this.stat.add(cyl(1.6, 1.8, 0.4, 10), STONE_D, M(x + 3, y + 0.15, z + 1.5), { jitter: 0.04 });
    this.stat.add(cyl(1.2, 1.3, 0.3, 10), STONE, M(x + 3, y + 0.45, z + 1.5));
    this.stat.add(prism(0.08, 0.7, 0.9), IRON, M(x + 3, y + 0.6, z + 1.5, 0, 0.5, 0));
    this.physics.cylFixed(x + 3, y + 0.35, z + 1.5, 1.7, 0.35, 'stone');
    // benches
    for (const [bx, bz, yaw] of [[x - 6.5, z + 3.5, 1.1], [x + 6.8, z - 4.5, -2.2]]) {
      const by = groundHeight(bx, bz);
      this.stat.add(box(2.2, 0.12, 0.6), WOOD, M(bx, by + 0.5, bz, 0, yaw, 0));
      this.stat.add(box(2.2, 0.5, 0.08), WOOD, M(bx - Math.sin(yaw) * 0.3, by + 0.85, bz - Math.cos(yaw) * 0.3, 0.15, yaw, 0));
      for (const s of [-1, 1]) this.stat.add(box(0.1, 0.5, 0.5), IRON, M(bx + Math.cos(yaw) * s * 0.9, by + 0.25, bz - Math.sin(yaw) * s * 0.9, 0, yaw, 0));
      this.physics.boxFixed(bx, by + 0.5, bz, 1.1, 0.4, 0.35, yaw, 'bench');
    }
    // windsock
    const wx = x + 8.5, wz = z + 4;
    const wy = groundHeight(wx, wz);
    this.stat.add(cyl(0.07, 0.09, 5, 5), 0xe9e0d0, M(wx, wy + 2.5, wz));
    this.physics.cylFixed(wx, wy + 2.5, wz, 0.1, 2.5, 'lamp');
    const sock = new Builder();
    for (let i = 0; i < 4; i++) sock.add(cyl(0.32 - i * 0.05, 0.36 - i * 0.05, 0.55, 8, 1, true), i % 2 ? 0xffffff : CORAL, M(0, 0, 0.3 + i * 0.55, Math.PI / 2, 0, 0));
    const sm = new THREE.Mesh(sock.build(), new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, flatShading: true, roughness: 0.9 }));
    sm.position.set(wx, wy + 4.8, wz);
    sm.name = 'windsock';
    sm.castShadow = true;
    this.group.add(sm);
    // plaza lamps
    for (let i = 0; i < 4; i++) {
      const a = 0.8 + (i / 4) * Math.PI * 2;
      this.addLamp(x + Math.cos(a) * 10.6, z + Math.sin(a) * 10.6, -a);
    }
  }

  private fallsDressing() {
    // a stack of mossy boulders flanking the river mouth
    for (const s of [-1, 1]) {
      const px = -FALLS.dirZ * s, pz = FALLS.dirX * s;
      for (let i = 0; i < 3; i++) {
        const x = FALLS.x + px * (3.4 + i * 1.2) - FALLS.dirX * (i * 1.4), z = FALLS.z + pz * (3.4 + i * 1.2) - FALLS.dirZ * (i * 1.4);
        const sc = 1.4 - i * 0.3;
        this.stat.add(blob(sc, 1, 0.18, 600 + i + s * 10, 0.8), 0x8d7fa2, M(x, groundHeight(x, z), z), { topColor: MOSS, topAmount: 0.85, jitter: 0.05 });
        this.physics.fixed(RAPIER.ColliderDesc.ball(sc * 0.9), x, groundHeight(x, z), z, undefined, 'rock');
      }
    }
    void islandRadius; void ISLET; void roadDist;
  }

  /** windows & lamps react to the night amount and lit beacons */
  updateLights(dt: number, night: number) {
    MAT.lamp.emissiveIntensity = 0.15 + night * 2.6;
    for (const p of this.pinwheels) p.children[0].rotation.z += dt * p.userData.speed;
    for (const l of this.lamps) {
      const target = Math.max(l.target, smooth01(night));
      l.on += (target - l.on) * Math.min(1, dt * 2.5);
      const flick = 1 + Math.sin(performance.now() * 0.013 + l.x) * 0.03;
      (l.bulb.material as THREE.MeshStandardMaterial).emissiveIntensity = (0.15 + l.on * 3.2) * flick;
      (l.pool.material as THREE.MeshBasicMaterial).opacity = l.on * 0.55 * flick;
    }
  }
}

function smooth01(x: number) {
  const t = Math.min(1, Math.max(0, (x - 0.05) / 0.6));
  return t * t * (3 - 2 * t);
}

// Physical, knock-about props: crates, barrels, hay bales, pumpkins, cairns,
// and a giant beach ball. All share a handful of generated geometries.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Builder, M, MAT, blob, box, cyl, lathe } from '../world/assets';
import { HUT, ISLET, ORCHARD, PLAZA, POND, RUINS, WINDMILL, WINDWARD } from '../world/layout';
import { groundHeight, roadDist } from '../world/terrain';
import { mulberry32 } from '../utils/math';
import type { DynamicLink, Physics } from '../core/physics';

const rnd = mulberry32(99);

function crateGeo() {
  const b = new Builder();
  const s = 0.9;
  b.add(box(s, s, s), 0xc48a5a, M(), { vary: 0.06 });
  const e = 0.12;
  for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    b.add(box(e, s + 0.02, e), 0x8a5a3e, M(x * (s / 2 - e / 2 + 0.01), 0, y * (s / 2 - e / 2 + 0.01)));
    b.add(box(s + 0.02, e, e), 0x8a5a3e, M(0, x * (s / 2 - e / 2 + 0.01), y * (s / 2 - e / 2 + 0.01)));
    b.add(box(e, e, s + 0.02), 0x8a5a3e, M(x * (s / 2 - e / 2 + 0.01), y * (s / 2 - e / 2 + 0.01), 0));
  }
  b.add(box(0.1, s * 1.25, 0.02), 0x8a5a3e, M(0, 0, s / 2 + 0.01, 0, 0, Math.PI / 4));
  b.add(box(0.1, s * 1.25, 0.02), 0x8a5a3e, M(0, 0, -s / 2 - 0.01, 0, 0, -Math.PI / 4));
  return b.build();
}
function barrelGeo() {
  const b = new Builder();
  b.add(lathe([[0, -0.55], [0.4, -0.55], [0.47, -0.25], [0.5, 0], [0.47, 0.25], [0.4, 0.55], [0, 0.55]], 10), 0x6f8fb0, M(), { vary: 0.05 });
  for (const y of [-0.38, 0.38]) b.add(cyl(0.47, 0.47, 0.07, 10), 0x3a3346, M(0, y, 0));
  return b.build();
}
function hayGeo() {
  const b = new Builder();
  b.add(cyl(0.72, 0.72, 1.3, 12), 0xeec46a, M(0, 0, 0, 0, 0, Math.PI / 2), { jitter: 0.03, vary: 0.08 });
  for (const x of [-0.3, 0.3]) b.add(cyl(0.735, 0.735, 0.06, 12), 0xb88a3a, M(x, 0, 0, 0, 0, Math.PI / 2));
  return b.build();
}
function pumpkinGeo() {
  const b = new Builder();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    b.add(new THREE.SphereGeometry(0.32, 7, 6), 0xff8a2a, M(Math.cos(a) * 0.17, 0, Math.sin(a) * 0.17, 0, -a, 0, 0.7, 0.8, 1), { vary: 0.05 });
  }
  b.add(cyl(0.04, 0.06, 0.22, 5), 0x5a7a3a, M(0, 0.3, 0, 0.2, 0, 0.1));
  return b.build();
}
function ballGeo() {
  const g = new THREE.SphereGeometry(1.1, 24, 16);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const cols = [new THREE.Color(0xe8634e), new THREE.Color(0xfff1d8), new THREE.Color(0x2f7f86), new THREE.Color(0xfff1d8), new THREE.Color(0xffc23d), new THREE.Color(0xfff1d8)];
  for (let i = 0; i < pos.count; i++) {
    const a = Math.atan2(pos.getZ(i), pos.getX(i));
    const k = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 6) % 6;
    const c = Math.abs(pos.getY(i)) > 1.0 ? cols[1] : cols[k];
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

export class Props {
  group = new THREE.Group();
  links: DynamicLink[] = [];

  constructor(private physics: Physics) {}

  build() {
    const crate = crateGeo(), barrel = barrelGeo(), hay = hayGeo(), pumpkin = pumpkinGeo();
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, yaw = 0, roll = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true; m.receiveShadow = true;
      m.position.set(x, y, z);
      m.rotation.set(0, yaw, roll);
      this.group.add(m);
      return m;
    };
    const addCrate = (x: number, y: number, z: number, yaw: number) => {
      const m = mk(crate, MAT.std, x, y, z, yaw);
      this.links.push(this.physics.addDynamic(m, [RAPIER.ColliderDesc.cuboid(0.45, 0.45, 0.45).setFriction(0.7).setRestitution(0.15)], { mass: 0.9, kind: 'crate', sleep: true }));
    };
    const pyramid = (cx: number, cz: number, yaw: number, rows = 3) => {
      const gy = groundHeight(cx, cz);
      for (let r = 0; r < rows; r++) {
        for (let i = 0; i < rows - r; i++) {
          const off = (i - (rows - r - 1) / 2) * 0.95;
          addCrate(cx + Math.cos(yaw) * off, gy + 0.46 + r * 0.92, cz - Math.sin(yaw) * off, yaw);
        }
      }
    };
    pyramid(-1.5, 35.5, 0.2, 3);
    pyramid(PLAZA.x + 7, PLAZA.z + 4.5, -0.6, 2);
    pyramid(WINDMILL.x - 5, WINDMILL.z + 5, 0.8, 2);
    pyramid(RUINS.x + 14, RUINS.z + 10, 0, 3);

    const addBarrel = (x: number, z: number, upright = true) => {
      const gy = groundHeight(x, z);
      const m = mk(barrel, MAT.std, x, gy + (upright ? 0.56 : 0.5), z, rnd() * 6, upright ? 0 : Math.PI / 2);
      this.links.push(this.physics.addDynamic(m, [RAPIER.ColliderDesc.cylinder(0.55, 0.47).setFriction(0.6).setRestitution(0.2)], { mass: 1.4, kind: 'barrel', sleep: true }));
    };
    const hx = HUT.x, hz = HUT.z;
    addBarrel(hx + 3.6, hz - 1.5); addBarrel(hx + 4.4, hz - 0.6); addBarrel(hx + 3.8, hz + 0.4);
    addBarrel(WINDMILL.x + 4, WINDMILL.z + 1); addBarrel(WINDMILL.x + 4.8, WINDMILL.z + 2); addBarrel(WINDMILL.x + 3.6, WINDMILL.z + 2.6, false);
    addBarrel(POND.x + 12, POND.z + 12); addBarrel(ISLET.x + 4.5, ISLET.z + 2.5); addBarrel(WINDWARD.x + 6, WINDWARD.z - 3);
    pyramid(WINDWARD.x + 2, WINDWARD.z + 8, 1.2, 2);

    // orchard: hay bales and a pumpkin patch
    for (let i = 0; i < 6; i++) {
      const x = ORCHARD.x - 8 + (i % 3) * 2.2 + rnd(), z = ORCHARD.z + 12 + Math.floor(i / 3) * 3;
      if (roadDist(x, z) < 1.5) continue;
      const gy = groundHeight(x, z);
      const m = mk(hay, MAT.std, x, gy + 0.74, z, rnd() * 3);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
      this.links.push(this.physics.addDynamic(m, [RAPIER.ColliderDesc.cylinder(0.65, 0.72).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setFriction(0.8)], { mass: 2.2, kind: 'hay', sleep: true }));
    }
    const pumpMat = MAT.std;
    for (let i = 0; i < 14; i++) {
      const a = rnd() * 6.28, d = rnd() * 5;
      const x = ORCHARD.x - 6 + Math.cos(a) * d, z = ORCHARD.z - 10 + Math.sin(a) * d * 0.7;
      if (roadDist(x, z) < 1) continue;
      const s = 0.8 + rnd() * 0.7;
      const m = mk(pumpkin, pumpMat, x, groundHeight(x, z) + 0.3 * s, z, rnd() * 6);
      m.scale.setScalar(s);
      this.links.push(this.physics.addDynamic(m, [RAPIER.ColliderDesc.ball(0.36 * s).setFriction(0.8).setRestitution(0.3)], { mass: 0.5 * s, kind: 'pumpkin', sleep: true, angDamping: 1.5 }));
    }

    // cairns at the ruins — stacked stones that topple
    const cairn = (cx: number, cz: number, n: number) => {
      let y = groundHeight(cx, cz);
      for (let i = 0; i < n; i++) {
        const s = 0.55 - i * 0.08;
        const g = new Builder().add(blob(s, 1, 0.12, 700 + i + Math.floor(cx), 0.55), 0xb7aac0, M(), { topColor: 0x7aa865, topAmount: 0.4, vary: 0.1 }).build();
        const m = mk(g, MAT.std, cx + (rnd() - 0.5) * 0.06, y + s * 0.55, cz, rnd() * 6);
        this.links.push(this.physics.addDynamic(m, [RAPIER.ColliderDesc.cylinder(s * 0.5, s * 0.92).setFriction(0.9)], { mass: 1.2, kind: 'stone', sleep: true }));
        y += s * 1.08;
      }
    };
    cairn(RUINS.x - 4, RUINS.z + 4, 4);
    cairn(RUINS.x + 4.5, RUINS.z - 2.5, 3);
    cairn(-60, 4, 4);
    cairn(26, -62, 3);

    // the giant beach ball
    const ball = new THREE.Mesh(ballGeo(), MAT.stdSmooth);
    ball.castShadow = true;
    ball.position.set(PLAZA.x - 5, groundHeight(PLAZA.x - 5, PLAZA.z - 1) + 1.15, PLAZA.z - 1);
    this.group.add(ball);
    this.links.push(this.physics.addDynamic(ball, [RAPIER.ColliderDesc.ball(1.1).setRestitution(0.75).setFriction(0.6).setDensity(0.12)], { kind: 'ball', angDamping: 0.3, damping: 0.25 }));

    return this.group;
  }

  /** Put anything that fell off the island back home. */
  recover() {
    for (const l of this.links) {
      if (l.body.translation().y < -30) this.physics.resetLink(l);
    }
  }
}

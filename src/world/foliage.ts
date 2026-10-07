// Trees, bushes, rocks, flowers and the wind-blown grass field.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  Builder, M, MAT, addFoliageSway, blob, cone, cyl, ico, instanced, uniforms,
} from './assets';
import {
  BRIDGES, CAMP, FALLS, GEYSERS, ISLET, ISLETS, LIGHTHOUSE, ORCHARD, PLAZA, RUINS, WINDMILL, islandRadius, isletRadiusOf,
} from './layout';
import {
  PAL, groundHeight, groundNormal, inClearing, isInsideIsland, pondFactor, roadDist, streamDist,
} from './terrain';
import { fbm, mulberry32, noise2, smoothstep, wrapAngle } from '../utils/math';
import type { Physics } from '../core/physics';

const rnd = mulberry32(2026);
const R = (a: number, b: number) => a + (b - a) * rnd();
const pick = <T>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];

/** Grass-only ground tint (ignores roads, so tufts at road edges stay green). */
function grassTint(x: number, z: number, out: THREE.Color) {
  const n1 = fbm(x * 0.03 + 11, z * 0.03 - 4, 3);
  const n2 = noise2(x * 0.11 + 5, z * 0.11 + 9);
  out.copy(PAL.grassA).lerp(PAL.grassB, smoothstep(-0.25, 0.35, n1));
  out.lerp(PAL.grassC, smoothstep(0.25, 0.6, n2) * 0.55);
  out.lerp(PAL.grassD, smoothstep(0.1, 0.5, -n1) * 0.4);
  return out;
}

// ---------- Tree geometry variants ----------
type TreeKind = 'puff' | 'pine' | 'fruit' | 'birch';

function trunkGeo(h: number, r: number, bend: number, seed: number, branches = 1) {
  const b = new Builder();
  const r2 = mulberry32(seed);
  const segs = 3;
  let x = 0, z = 0;
  for (let i = 0; i < segs; i++) {
    const y0 = (i / segs) * h, y1 = ((i + 1) / segs) * h;
    const nx = x + (r2() - 0.5) * bend, nz = z + (r2() - 0.5) * bend;
    const rr0 = r * (1 - (i / segs) * 0.45), rr1 = r * (1 - ((i + 1) / segs) * 0.45);
    const g = cyl(rr1, rr0, y1 - y0 + 0.05, 6);
    const dx = nx - x, dz = nz - z;
    const len = y1 - y0;
    b.add(g, 0x6e4a3a, M((x + nx) / 2, (y0 + y1) / 2, (z + nz) / 2, Math.atan2(dz, len), 0, -Math.atan2(dx, len)), { ao: 0.35, vary: 0.1 });
    x = nx; z = nz;
  }
  for (let i = 0; i < branches; i++) {
    const a = r2() * Math.PI * 2;
    const y = h * (0.55 + r2() * 0.25);
    b.add(cyl(r * 0.18, r * 0.35, h * 0.45, 5), 0x6e4a3a, M(Math.cos(a) * 0.35, y + 0.4, Math.sin(a) * 0.35, Math.sin(a) * 0.8, 0, -Math.cos(a) * 0.8));
  }
  // root flare
  b.add(cyl(r * 0.9, r * 1.6, 0.35, 6), 0x5c3d31, M(0, 0.1, 0), { ao: 0.4 });
  return b.build();
}

function canopyGeo(kind: TreeKind, seed: number, h: number) {
  const b = new Builder();
  const r2 = mulberry32(seed);
  const white = 0xffffff;
  if (kind === 'puff' || kind === 'fruit') {
    const n = kind === 'fruit' ? 3 : 5;
    const scale = kind === 'fruit' ? 0.8 : 1;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r2();
      const rr = i === 0 ? 0 : R(0.8, 1.3) * scale;
      const s = (i === 0 ? 1.9 : R(1.15, 1.55)) * scale;
      const y = h + (i === 0 ? 0.7 : R(-0.2, 0.5)) * scale;
      b.add(blob(s, 1, 0.12, seed + i, 0.86), white, M(Math.cos(a) * rr, y, Math.sin(a) * rr, r2(), r2(), r2()), {
        gradient: [0x8a8a9c, 0xffffff, -s * 0.9, s * 0.9], jitter: 0.06, vary: 0.08,
      });
    }
    if (kind === 'fruit') {
      for (let i = 0; i < 9; i++) {
        const a = r2() * Math.PI * 2, e = R(-0.2, 0.9);
        const rr = 1.75;
        b.add(ico(0.16, 0), 0xffd2b8, M(Math.cos(a) * rr * Math.cos(e), h + 0.4 + Math.sin(e) * rr, Math.sin(a) * rr * Math.cos(e)));
      }
    }
  } else if (kind === 'pine') {
    const tiers = 4;
    for (let i = 0; i < tiers; i++) {
      const t = i / tiers;
      const rr = 2.0 * (1 - t * 0.62);
      const y = h * 0.55 + i * 1.25;
      b.add(cone(rr, 2.2, 7), white, M(R(-0.1, 0.1), y, R(-0.1, 0.1), R(-0.06, 0.06), r2() * 3, R(-0.06, 0.06)), {
        gradient: [0x7d7f95, 0xffffff, -1.1, 1.1], jitter: 0.08, vary: 0.06,
      });
    }
  } else {
    // birch: tall narrow lollipop clusters
    for (let i = 0; i < 3; i++) {
      const s = R(0.95, 1.25);
      b.add(blob(s, 1, 0.1, seed + i * 7, 1.25), white, M(R(-0.5, 0.5), h + i * 0.9, R(-0.5, 0.5)), {
        gradient: [0x8a8a9c, 0xffffff, -s, s], jitter: 0.05,
      });
    }
  }
  return b.build();
}

// Autumn-dusk palette for canopies (multiplied with the baked gradient)
const CANOPY: Record<TreeKind, number[]> = {
  puff: [0xff8c5a, 0xffb052, 0xf2607a, 0xff9e6e, 0xe8774f, 0x8fbf6b],
  pine: [0x2f7564, 0x3b8a6c, 0x28665d],
  fruit: [0x8cc46a, 0x7bb85f, 0x9ccf70],
  birch: [0xf6c453, 0xffd56b, 0xf0a94a],
};

interface TreeSpot { x: number; z: number; kind: TreeKind; s: number; }

export class Foliage {
  group = new THREE.Group();
  grassMeshes: THREE.Mesh[] = [];
  treeSpots: TreeSpot[] = [];
  trunkColliders = new Map<number, { x: number; z: number; h: number }>();

  constructor(private physics: Physics, private quality: { grass: number }) {}

  build() {
    this.placeTrees();
    this.buildTrees();
    this.buildRocksAndBushes();
    this.buildFlowers();
    this.buildGrass();
    // all foliage is static: bake the transforms once
    this.group.traverse((o) => { o.matrixAutoUpdate = false; o.updateMatrix(); });
    return this.group;
  }

  // ---------------------------------------------------------------- trees
  private canPlaceTree(x: number, z: number, minD = 2.6) {
    if (!isInsideIsland(x, z, 4.5)) return false;
    if (roadDist(x, z) < 1.8) return false;
    if (pondFactor(x, z) < 1.5 || streamDist(x, z) < 5.5) return false;
    if (inClearing(x, z, 1.5)) return false;
    if (Math.hypot(x - LIGHTHOUSE.x, z - LIGHTHOUSE.z) < 9) return false;
    if (groundNormal(x, z).y < 0.8) return false;
    for (const t of this.treeSpots) if ((t.x - x) ** 2 + (t.z - z) ** 2 < minD * minD) return false;
    return true;
  }

  private placeTrees() {
    const regions: { x: number; z: number; r: number; n: number; kinds: TreeKind[] }[] = [
      { x: -58, z: -22, r: 15, n: 22, kinds: ['pine', 'pine', 'puff', 'puff', 'birch'] },
      { x: -8, z: -46, r: 15, n: 16, kinds: ['puff', 'birch', 'puff', 'pine'] },
      { x: 22, z: -36, r: 10, n: 9, kinds: ['birch', 'puff', 'pine'] },
      { x: -52, z: 40, r: 13, n: 13, kinds: ['puff', 'puff', 'birch'] },
      { x: 68, z: -6, r: 12, n: 11, kinds: ['pine', 'birch', 'pine', 'puff'] },
      { x: -28, z: 60, r: 12, n: 9, kinds: ['puff', 'birch'] },
      { x: 34, z: 62, r: 10, n: 7, kinds: ['puff', 'pine'] },
      { x: -70, z: -48, r: 10, n: 8, kinds: ['pine', 'puff'] },
      { x: 26, z: -72, r: 11, n: 9, kinds: ['pine', 'birch', 'puff'] },
      { x: -22, z: -70, r: 9, n: 8, kinds: ['pine', 'puff'] }, // hides the secret camp
      { x: CAMP.x - 7, z: CAMP.z + 1, r: 9, n: 7, kinds: ['pine'] },
      { x: 0, z: -8, r: 33, n: 16, kinds: ['birch', 'puff', 'pine'] },
      { x: 62, z: -40, r: 9, n: 6, kinds: ['pine', 'birch'] },
      { x: -18, z: 42, r: 9, n: 5, kinds: ['puff', 'birch'] },
      { x: 18, z: 18, r: 10, n: 6, kinds: ['puff', 'birch'] },
      { x: ISLET.x, z: ISLET.z, r: 7, n: 5, kinds: ['pine', 'puff', 'birch'] },
      { x: ISLETS[1].x, z: ISLETS[1].z, r: 10, n: 7, kinds: ['pine', 'pine', 'birch'] },
      { x: ISLETS[2].x, z: ISLETS[2].z, r: 9, n: 5, kinds: ['puff', 'birch', 'puff'] },
    ];
    for (const g of regions) {
      let placed = 0;
      for (let tries = 0; tries < g.n * 25 && placed < g.n; tries++) {
        const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * g.r;
        const x = g.x + Math.cos(a) * d, z = g.z + Math.sin(a) * d;
        if (!this.canPlaceTree(x, z, 3.2)) continue;
        this.treeSpots.push({ x, z, kind: pick(g.kinds), s: R(0.8, 1.25) });
        placed++;
      }
    }
    // Orchard rows
    for (let ix = 0; ix < 5; ix++) {
      for (let iz = 0; iz < 4; iz++) {
        const x = ORCHARD.x - 10 + ix * 5.2 + (iz % 2) * 1.2, z = ORCHARD.z - 9 + iz * 5.8;
        if (!this.canPlaceTree(x, z, 2.5)) continue;
        this.treeSpots.push({ x, z, kind: 'fruit', s: R(0.85, 1.05) });
      }
    }
    // Sparse filler everywhere else
    for (let tries = 0; tries < 900 && this.treeSpots.length < 230; tries++) {
      const x = R(-90, 90), z = R(-90, 90);
      if (fbm(x * 0.02, z * 0.02, 2) < 0.05) continue;
      if (!this.canPlaceTree(x, z, 7)) continue;
      this.treeSpots.push({ x, z, kind: pick(['puff', 'puff', 'birch', 'pine'] as TreeKind[]), s: R(0.8, 1.15) });
    }
  }

  private buildTrees() {
    const kinds: TreeKind[] = ['puff', 'pine', 'fruit', 'birch'];
    const trunkMat = MAT.std;
    for (const kind of kinds) {
      const variants = kind === 'fruit' ? 2 : 3;
      for (let v = 0; v < variants; v++) {
        const spots = this.treeSpots.filter((t, i) => t.kind === kind && i % variants === v);
        if (!spots.length) continue;
        const h = kind === 'pine' ? 1.6 : kind === 'birch' ? 3.6 : kind === 'fruit' ? 1.8 : 2.8;
        const seed = 100 + v * 31 + kind.length * 7;
        const tGeo = trunkGeo(kind === 'pine' ? 2.2 : h + 0.6, kind === 'birch' ? 0.17 : 0.26, kind === 'birch' ? 0.25 : 0.4, seed, kind === 'pine' ? 0 : 1);
        if (kind === 'birch') {
          // pale trunk
          const col = tGeo.getAttribute('color') as THREE.BufferAttribute;
          for (let i = 0; i < col.count; i++) col.setXYZ(i, 0.92, 0.88, 0.84);
        }
        const cGeo = canopyGeo(kind, seed, h);
        const tItems: { m: THREE.Matrix4; c?: THREE.Color }[] = [];
        const cItems: { m: THREE.Matrix4; c?: THREE.Color }[] = [];
        for (const s of spots) {
          const y = groundHeight(s.x, s.z) - 0.1;
          const yaw = rnd() * Math.PI * 2;
          const m = M(s.x, y, s.z, 0, yaw, 0, s.s);
          tItems.push({ m });
          const c = new THREE.Color(pick(CANOPY[kind]));
          c.offsetHSL(R(-0.02, 0.02), R(-0.05, 0.05), R(-0.04, 0.04));
          cItems.push({ m, c });
          // trunk collider
          const col = this.physics.cylFixed(s.x, y + 1.5, s.z, 0.32 * s.s, 1.5, 'tree');
          this.trunkColliders.set(col.handle, { x: s.x, z: s.z, h: h * s.s });
        }
        const trunks = instanced(tGeo, trunkMat, tItems);
        const canopyMat = addFoliageSway(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }), 1, 1.5);
        const canopies = instanced(cGeo, canopyMat, cItems);
        this.group.add(trunks, canopies);
      }
    }
  }

  // ------------------------------------------------------- rocks & bushes
  private buildRocksAndBushes() {
    const rockGeos = [0, 1, 2, 3].map((i) => {
      const b = new Builder();
      b.add(blob(1, i % 2, 0.22, 900 + i * 13, 0.7 + (i % 3) * 0.12), 0x8d7fa2, undefined, {
        topColor: 0x7aa865, topAmount: 0.75, jitter: 0.05, vary: 0.12, ao: 0.4,
      });
      return b.build();
    });
    const bushGeos = [0, 1].map((i) => {
      const b = new Builder();
      for (let k = 0; k < 3; k++) {
        const a = k * 2.1 + i;
        b.add(blob(R(0.6, 0.85), 1, 0.12, 300 + i * 7 + k, 0.8), 0xffffff, M(Math.cos(a) * 0.55, 0.45, Math.sin(a) * 0.55), {
          gradient: [0x7d7f94, 0xffffff, -0.6, 0.7], jitter: 0.05,
        });
      }
      return b.build();
    });
    const rocks: { m: THREE.Matrix4; c?: THREE.Color }[][] = [[], [], [], []];
    const bushes: { m: THREE.Matrix4; c?: THREE.Color }[][] = [[], []];
    const bushCols = [0x4f8f5c, 0x5b9a58, 0x3e7d63, 0xe0708c, 0xf09a5b];

    const addRock = (x: number, z: number, s: number, collide = s > 0.9) => {
      const y = groundHeight(x, z);
      const m = M(x, y - s * 0.25, z, R(-0.2, 0.2), rnd() * 6.28, R(-0.2, 0.2), s * R(0.9, 1.4), s, s * R(0.9, 1.3));
      const c = new THREE.Color(0xffffff).offsetHSL(R(-0.03, 0.03), 0, R(-0.06, 0.04));
      rocks[Math.floor(rnd() * 4)].push({ m, c });
      if (collide) this.physics.fixed(RAPIER.ColliderDesc.ball(s * 0.85), x, y + s * 0.1, z, undefined, 'rock');
    };
    const addBush = (x: number, z: number, s: number) => {
      const y = groundHeight(x, z) - 0.15;
      const c = new THREE.Color(pick(bushCols)).offsetHSL(R(-0.02, 0.02), 0, R(-0.04, 0.04));
      bushes[Math.floor(rnd() * 2)].push({ m: M(x, y, z, 0, rnd() * 6.28, 0, s), c });
    };

    // Rim: a broken ring of rocks and shrubs that frames the island edge.
    const rimRing = (radiusFn: (th: number) => number, cx: number, cz: number, inset: number, step: number) => {
      const RR = radiusFn(0);
      for (let th = 0; th < Math.PI * 2; th += step / RR) {
        const r = radiusFn(th) - inset - rnd() * 1.4;
        const x = cx + Math.cos(th) * r, z = cz + Math.sin(th) * r;
        if (cx === 0 && BRIDGES.some((b) => Math.abs(wrapAngle(th - b.angle)) < 0.07)) continue; // bridge heads
        if (cx !== 0 && BRIDGES.some((b) => Math.hypot(x - b.b.x, z - b.b.z) < 5)) continue;
        if (GEYSERS.some((g) => Math.hypot(x - g.x, z - g.z) < 6 || Math.hypot(x - g.tx, z - g.tz) < 7)) continue;
        if (Math.hypot(x - FALLS.x, z - FALLS.z) < 7) continue;
        if (roadDist(x, z) < 1) continue;
        const n = noise2(th * 3, cx * 0.1);
        if (n > 0.45) continue; // viewpoints / gaps
        if (n < -0.1) addRock(x, z, R(0.6, 1.5));
        else addBush(x, z, R(0.8, 1.3));
      }
    };
    rimRing(islandRadius, 0, 0, 3.2, 2.6);
    for (const isl of ISLETS) rimRing((th) => isletRadiusOf(isl, th), isl.x, isl.z, 2.6, 2.2);

    // Rock clusters at chosen spots
    const clusters = [
      [RUINS.x + 13, RUINS.z + 4, 5, 6], [RUINS.x - 6, RUINS.z - 13, 4, 5], [-46, 2, 4, 5], [-24, -2, 3, 3],
      [WINDMILL.x + 9, WINDMILL.z + 8, 4, 4], [10, 2, 4, 4], [-14, -26, 5, 5], [58, 32, 4, 4], [-68, 24, 4, 5],
      [FALLS.x + 4, FALLS.z - 6, 3, 4], [FALLS.x + 3, FALLS.z + 6, 3, 4], [24, 48, 3, 3], [-4, 58, 3, 3], [-34, 40, 3, 3],
    ];
    for (const [cx, cz, r, n] of clusters) {
      for (let i = 0; i < n; i++) {
        const a = rnd() * 6.28, d = rnd() * r;
        const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
        if (roadDist(x, z) < 0.8 || inClearing(x, z)) continue;
        addRock(x, z, i === 0 ? R(1.2, 1.8) : R(0.35, 1.0));
      }
    }
    // Scatter pebbles and bushes
    for (let i = 0; i < 520; i++) {
      const x = R(-88, 88), z = R(-88, 88);
      if (!isInsideIsland(x, z, 5) || roadDist(x, z) < 0.6 || inClearing(x, z)) continue;
      if (pondFactor(x, z) < 1.2) continue;
      const k = rnd();
      if (k < 0.45) addRock(x, z, R(0.2, 0.5), false);
      else if (k < 0.85 && pondFactor(x, z) > 1.5 && streamDist(x, z) > 4) addBush(x, z, R(0.6, 1.1));
    }
    // Shrubs lining the roads
    for (let i = 0; i < 600; i++) {
      const x = R(-88, 88), z = R(-88, 88);
      const rd = roadDist(x, z);
      if (rd < 1.2 || rd > 2.4 || !isInsideIsland(x, z, 4) || inClearing(x, z, 1)) continue;
      if (pondFactor(x, z) < 1.4 || streamDist(x, z) < 4.5) continue;
      if (noise2(x * 0.08, z * 0.08) < 0.15) continue;
      addBush(x, z, R(0.55, 0.9));
    }
    // Pond reeds as darker bushes along the shore
    for (let i = 0; i < 26; i++) {
      const a = rnd() * 6.28;
      const x = -36 + Math.cos(a) * 15 * 1.25, z = 8 + Math.sin(a) * 11 * 1.25;
      if (roadDist(x, z) < 1 || inClearing(x, z)) continue;
      addBush(x, z, R(0.4, 0.7));
    }

    rocks.forEach((items, i) => items.length && this.group.add(instanced(rockGeos[i], MAT.std, items)));
    const bushMat = addFoliageSway(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }), 0.6, 0.1);
    bushes.forEach((items, i) => items.length && this.group.add(instanced(bushGeos[i], bushMat, items)));
  }

  // -------------------------------------------------------------- flowers
  private buildFlowers() {
    const b = new Builder();
    // little five-petal blossom
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      b.add(new THREE.CircleGeometry(0.075, 5), 0xffffff, M(Math.cos(a) * 0.07, 0.3, Math.sin(a) * 0.07, -Math.PI / 2 + 0.25, 0, a));
    }
    b.add(ico(0.045, 0), 0xffd36b, M(0, 0.32, 0));
    b.add(cyl(0.012, 0.012, 0.3, 3), 0x4f8a50, M(0, 0.15, 0));
    const geo = b.build();
    const cols = [0xfff4e6, 0xffd36b, 0xff8fb0, 0xc9a2ff, 0xffffff, 0xff9966];
    const items: { m: THREE.Matrix4; c?: THREE.Color }[] = [];
    const patches = [
      [PLAZA.x - 12, PLAZA.z + 4, 7], [PLAZA.x + 14, PLAZA.z - 8, 6], [-30, 24, 6], [-44, -30, 7], [RUINS.x, RUINS.z + 14, 6],
      [ISLET.x, ISLET.z, 7], [ISLETS[1].x + 4, ISLETS[1].z + 5, 6], [ISLETS[2].x, ISLETS[2].z, 8], [ISLETS[2].x + 4, ISLETS[2].z - 4, 5], [30, 40, 7], [-10, 20, 6], [56, 2, 6], [10, -60, 7], [-60, 30, 7], [44, 30, 5],
      [-14, -40, 6], [70, 30, 5], [-4, 64, 6],
    ];
    for (const [px, pz, pr] of patches) {
      const pc = pick(cols);
      for (let i = 0; i < 80; i++) {
        const a = rnd() * 6.28, d = Math.sqrt(rnd()) * pr;
        const x = px + Math.cos(a) * d, z = pz + Math.sin(a) * d;
        if (!isInsideIsland(x, z, 3) || roadDist(x, z) < 0.4 || pondFactor(x, z) < 1.15) continue;
        const y = groundHeight(x, z);
        const s = R(0.8, 1.5);
        items.push({ m: M(x, y, z, R(-0.2, 0.2), rnd() * 6.28, R(-0.2, 0.2), s), c: new THREE.Color(rnd() < 0.75 ? pc : pick(cols)) });
      }
    }
    for (let i = 0; i < 700; i++) {
      const x = R(-85, 85), z = R(-85, 85);
      if (!isInsideIsland(x, z, 3) || roadDist(x, z) < 0.5 || pondFactor(x, z) < 1.2 || streamDist(x, z) < 3.5) continue;
      items.push({ m: M(x, groundHeight(x, z), z, 0, rnd() * 6.28, 0, R(0.7, 1.2)), c: new THREE.Color(pick(cols)) });
    }
    const mat = addFoliageSway(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide }), 2.5, 0.0);
    const mesh = instanced(geo, mat, items, false);
    this.group.add(mesh);
  }

  // ---------------------------------------------------------------- grass
  private buildGrass() {
    // One clump = 5 tapered blades fanned around the origin.
    const blades = 4;
    const segs = 2;
    const vPerBlade = (segs + 1) * 2 - 1;
    const posArr: number[] = [], colArr: number[] = [], idxArr: number[] = [];
    const r2 = mulberry32(77);
    for (let b = 0; b < blades; b++) {
      const a = (b / blades) * Math.PI * 2 + r2() * 0.8;
      const ox = Math.cos(a) * 0.14, oz = Math.sin(a) * 0.14;
      const h = 0.36 + r2() * 0.3;
      const w = 0.13 + r2() * 0.05;
      const lean = 0.12 + r2() * 0.16;
      const rot = a + Math.PI / 2 + (r2() - 0.5);
      const base = posArr.length / 3;
      const tx = Math.cos(rot), tz = Math.sin(rot);
      for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        const ww = w * (1 - t);
        const y = h * t;
        const lx = ox + Math.cos(a) * lean * t * t, lz = oz + Math.sin(a) * lean * t * t;
        if (s < segs) {
          posArr.push(lx - tx * ww, y, lz - tz * ww, lx + tx * ww, y, lz + tz * ww);
          colArr.push(t, t, t, t, t, t);
        } else {
          posArr.push(lx, y, lz);
          colArr.push(1, 1, 1);
        }
      }
      for (let s = 0; s < segs; s++) {
        const i0 = base + s * 2;
        if (s < segs - 1) {
          idxArr.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2);
        } else {
          idxArr.push(i0, i0 + 1, i0 + 2);
        }
      }
      void vPerBlade;
    }
    const nrm = new Float32Array(posArr.length);
    for (let i = 0; i < nrm.length; i += 3) nrm[i + 1] = 1;

    // Scatter clumps, bucketed into spatial chunks for frustum culling.
    const CH = 12; // chunks per side
    const span = 300 / CH;
    const buckets: number[][] = Array.from({ length: CH * CH }, () => []);
    const total = Math.floor(95000 * this.quality.grass);
    const c = new THREE.Color();
    let placed = 0;
    for (let tries = 0; tries < total * 9 && placed < total; tries++) {
      const x = R(-145, 145), z = R(-145, 145);
      if (!isInsideIsland(x, z, 2.2)) continue;
      // meadows: denser in noisy patches, sparse elsewhere
      const meadow = smoothstep(-0.35, 0.35, fbm(x * 0.04 + 7, z * 0.04 - 3, 2));
      if (rnd() > 0.25 + meadow * 0.75) continue;
      const rd = roadDist(x, z);
      if (rd < 0.2 + rnd() * 0.9) continue;
      const pf = pondFactor(x, z);
      if (pf < 1.1 || streamDist(x, z) < 2.6) continue;
      if (Math.hypot(x - PLAZA.x, z - PLAZA.z) < 9.5) continue;
      if (Math.hypot(x - RUINS.x, z - RUINS.z) < 9.5 && rnd() < 0.85) continue;
      if (Math.hypot(x - LIGHTHOUSE.x, z - LIGHTHOUSE.z) < 5) continue;
      if (inClearing(x, z, -2) && rnd() < 0.7) continue;
      const nrmY = groundNormal(x, z).y;
      if (nrmY < 0.8) continue;
      const y = groundHeight(x, z);
      grassTint(x, z, c);
      const gi = Math.min(CH - 1, Math.floor((x + 150) / span)) + Math.min(CH - 1, Math.floor((z + 150) / span)) * CH;
      const sc = (0.7 + rnd() * 0.6) * (0.75 + meadow * 0.45) * (rd < 2 ? 0.7 : 1);
      buckets[gi].push(x, y - 0.03, z, sc, rnd() * Math.PI * 2, c.r, c.g, c.b);
      placed++;
    }

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uniforms.uTime;
      shader.uniforms.uPlayer = uniforms.uPlayer;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec4 aOffset; attribute float aYaw; attribute vec3 aTint;
uniform float uTime; uniform vec3 uPlayer;
varying float vTip;`)
        .replace('#include <color_vertex>', `#include <color_vertex>
  vTip = color.r;
  vColor.rgb = mix(aTint * 0.72, aTint * 1.18 + vec3(0.05, 0.05, 0.0), color.r);`)
        .replace('#include <begin_vertex>', `
  float cs = cos(aYaw), sn = sin(aYaw);
  vec3 p = position * aOffset.w;
  vec3 transformed = vec3(p.x * cs - p.z * sn, p.y, p.x * sn + p.z * cs) + aOffset.xyz;
  float t = position.y / 0.6;
  float k = t * t;
  // wind: big rolling gusts + flutter
  float gust = sin(aOffset.x * 0.08 + uTime * 1.3) * 0.5 + sin(aOffset.z * 0.11 - uTime * 0.9 + 1.7) * 0.5;
  vec2 wdir = normalize(vec2(1.0, 0.45));
  transformed.xz += wdir * (0.12 + gust * 0.16) * k * aOffset.w;
  transformed.x += sin(uTime * 4.0 + aOffset.x * 1.7 + aOffset.z) * 0.035 * k;
  // pushed aside by the car
  vec2 dp = transformed.xz - uPlayer.xz;
  float d = length(dp);
  float push = (1.0 - smoothstep(0.6, 2.4, d)) * step(abs(uPlayer.y - aOffset.y), 2.0);
  transformed.xz += normalize(dp + 1e-4) * push * 0.45 * k;
  transformed.y -= push * 0.25 * k * aOffset.w;`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vTip;');
    };

    for (let i = 0; i < buckets.length; i++) {
      const data = buckets[i];
      const n = data.length / 8;
      if (!n) continue;
      const geo = new THREE.InstancedBufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3));
      geo.setIndex(idxArr);
      const off = new Float32Array(n * 4), yaw = new Float32Array(n), tint = new Float32Array(n * 3);
      let minY = Infinity, maxY = -Infinity;
      for (let k = 0; k < n; k++) {
        const o = k * 8;
        off[k * 4] = data[o]; off[k * 4 + 1] = data[o + 1]; off[k * 4 + 2] = data[o + 2]; off[k * 4 + 3] = data[o + 3];
        yaw[k] = data[o + 4];
        tint[k * 3] = data[o + 5]; tint[k * 3 + 1] = data[o + 6]; tint[k * 3 + 2] = data[o + 7];
        minY = Math.min(minY, data[o + 1]); maxY = Math.max(maxY, data[o + 1]);
      }
      geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 4));
      geo.setAttribute('aYaw', new THREE.InstancedBufferAttribute(yaw, 1));
      geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
      geo.instanceCount = n;
      const cx = -150 + ((i % CH) + 0.5) * span, cz = -150 + (Math.floor(i / CH) + 0.5) * span;
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, (minY + maxY) / 2, cz), span * 0.75 + (maxY - minY));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      this.grassMeshes.push(mesh);
      this.group.add(mesh);
    }
  }
}

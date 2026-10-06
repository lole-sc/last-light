// Rope bridges between islands. Planks are kinematic bodies that sag under
// the car; the physical deck only moves vertically (so wheels never snag),
// while the visual planks also sway and roll.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Builder, M, MAT, box, cyl, ico } from './assets';
import { groundHeight, bridgeY } from './terrain';
import type { BridgeDef } from './layout';
import type { Physics } from '../core/physics';
import { mulberry32 } from '../utils/math';

const WOOD = 0xa96f4b, WOOD_D = 0x77493a;

interface Plank { body: RAPIER.RigidBody; mesh: THREE.Object3D; t: number; base: THREE.Vector3; }

export class RopeBridge {
  planks: Plank[] = [];
  ropes!: THREE.InstancedMesh;
  load = 0;
  loadT = -1;
  wobble = 0;
  a: THREE.Vector3;
  b: THREE.Vector3;
  yaw: number;
  side: THREE.Vector3;
  mid: THREE.Vector3;
  width: number;
  lampSpots: { x: number; z: number }[] = [];

  constructor(private def: BridgeDef, private physics: Physics, group: THREE.Group, stat: Builder) {
    const y = bridgeY(def);
    this.width = def.width;
    this.a = new THREE.Vector3(def.a.x, y.a, def.a.z);
    this.b = new THREE.Vector3(def.b.x, y.b, def.b.z);
    this.mid = this.a.clone().lerp(this.b, 0.5);
    const len = this.a.distanceTo(this.b);
    this.yaw = Math.atan2(this.b.x - this.a.x, this.b.z - this.a.z);
    this.side = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const n = Math.floor(len / 0.6);
    const r = mulberry32(def.id.length * 7 + 3);
    // two plank variants, merged with their iron cleats
    const plankGeo = (k: number) => new Builder()
      .add(box(this.width, 0.12, 0.5), k ? WOOD : 0xb27a55, M(), { vary: 0.12, jitter: 0.015 })
      .add(box(0.12, 0.05, 0.52), 0x3a3346, M(this.width / 2 - 0.25, 0.07, 0))
      .add(box(0.12, 0.05, 0.52), 0x3a3346, M(-this.width / 2 + 0.25, 0.07, 0))
      .build();
    const geos = [plankGeo(0), plankGeo(1)];
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const p = this.a.clone().lerp(this.b, t);
      p.y -= Math.sin(t * Math.PI) * 0.45;
      const m = new THREE.Mesh(geos[i % 3 ? 1 : 0], MAT.std);
      m.castShadow = true; m.receiveShadow = true;
      m.position.copy(p);
      m.rotation.set(0, this.yaw + (r() - 0.5) * 0.03, 0);
      group.add(m);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
      const body = physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.y, p.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
      );
      const c = physics.world.createCollider(RAPIER.ColliderDesc.cuboid(this.width / 2, 0.08, 0.36).setFriction(1.0), body);
      physics.tag(c, 'plank');
      this.planks.push({ body, mesh: m, t, base: p.clone() });
    }
    // end posts + lanterns
    for (const [p, sgn] of [[this.a, 1], [this.b, -1]] as [THREE.Vector3, number][]) {
      for (const s of [-1, 1]) {
        const px = p.x + this.side.x * s * (this.width / 2 + 0.35) - Math.sin(this.yaw) * 0.6 * sgn;
        const pz = p.z + this.side.z * s * (this.width / 2 + 0.35) - Math.cos(this.yaw) * 0.6 * sgn;
        const gy = groundHeight(px, pz);
        stat.add(cyl(0.18, 0.24, 2.6, 6), WOOD_D, M(px, gy + 1.1, pz), { ao: 0.3 });
        stat.add(ico(0.26, 0), WOOD_D, M(px, gy + 2.45, pz));
        physics.cylFixed(px, gy + 1.2, pz, 0.24, 1.2, 'fence');
      }
      this.lampSpots.push({
        x: p.x + this.side.x * (this.width / 2 + 1.3) - Math.sin(this.yaw) * 0.9 * sgn,
        z: p.z + this.side.z * (this.width / 2 + 1.3) - Math.cos(this.yaw) * 0.9 * sgn,
      });
    }
    // ropes: instanced segments updated each frame
    const segGeo = new THREE.CylinderGeometry(0.035, 0.035, 1, 4);
    segGeo.translate(0, 0.5, 0);
    segGeo.rotateX(Math.PI / 2);
    this.ropes = new THREE.InstancedMesh(segGeo, new THREE.MeshStandardMaterial({ color: 0xd8c39a, roughness: 1 }), (n + 2) * 4);
    this.ropes.frustumCulled = false;
    this.ropes.castShadow = true;
    group.add(this.ropes);
    // side rails: start at deck level (never below), follow the resting sag
    const segs = 6;
    for (const s of [-1, 1]) {
      for (let k = 0; k < segs; k++) {
        const t = (k + 0.5) / segs;
        const p = this.a.clone().lerp(this.b, t);
        p.y -= Math.sin(t * Math.PI) * 0.45;
        const o = this.side.clone().multiplyScalar(s * (this.width / 2 + 0.3));
        // a smooth, frictionless wall from well below the (sagging) deck to rope height
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
        physics.fixed(RAPIER.ColliderDesc.cuboid(0.08, 1.25, len / (segs * 2) + 0.2).setFriction(0).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min).setRestitution(0), p.x + o.x, p.y + 0.15, p.z + o.z, q, 'rope');
      }
    }
    void def;
  }

  /** Is the point on this bridge's deck? Returns 0..1 along it, or -1. */
  project(p: THREE.Vector3) {
    const ab = this.b.clone().sub(this.a);
    const t = p.clone().sub(this.a).dot(ab) / ab.lengthSq();
    const lateral = p.clone().sub(this.a.clone().addScaledVector(ab, t));
    lateral.y = 0;
    if (t > -0.05 && t < 1.05 && lateral.length() < this.width * 0.8 && Math.abs(p.y - (this.a.y + (this.b.y - this.a.y) * t)) < 2.5) return t;
    return -1;
  }

  update(dt: number, time: number, carPos: THREE.Vector3 | null) {
    const target = carPos ? this.project(carPos) : -1;
    if (target >= 0) {
      if (this.loadT < 0 || this.load < 0.05) this.wobble = 1;
      this.loadT = target;
      this.load = Math.min(1, this.load + dt * 3);
    } else this.load = Math.max(0, this.load - dt * 1.5);
    this.wobble = Math.max(0, this.wobble - dt * 0.35);
    const pts: THREE.Vector3[] = [];
    const q = new THREE.Quaternion(), e = new THREE.Euler();
    for (const p of this.planks) {
      const t = p.t;
      const env = Math.sin(t * Math.PI);
      const sag = this.load * 0.7 * Math.exp(-(((t - this.loadT) / 0.22) ** 2)) * env;
      const y = p.base.y - sag + Math.sin(time * 1.2 + t * 4) * 0.02 * env;
      // physics: vertical only
      p.body.setNextKinematicTranslation({ x: p.base.x, y, z: p.base.z });
      // visuals: plus sway and roll
      const sway = Math.sin(time * 1.6 + t * 2) * 0.05 * env + Math.sin(time * 7 - t * 9) * 0.1 * this.wobble * env;
      const roll = Math.cos(time * 1.6 + t * 2) * 0.03 * env + Math.sin(time * 6 - t * 8) * 0.07 * this.wobble * env;
      const pos = p.base.clone().addScaledVector(this.side, sway);
      pos.y = y;
      e.set(0, this.yaw, roll, 'YXZ');
      q.setFromEuler(e);
      p.mesh.position.copy(pos);
      p.mesh.quaternion.copy(q);
      pts.push(pos);
    }
    const m = new THREE.Matrix4(), fwd = new THREE.Vector3(0, 0, 1), rq = new THREE.Quaternion(), sc = new THREE.Vector3();
    let k = 0;
    const seg = (p0: THREE.Vector3, p1: THREE.Vector3) => {
      const d = p1.clone().sub(p0);
      const l = d.length();
      rq.setFromUnitVectors(fwd, d.normalize());
      m.compose(p0, rq, sc.set(1, 1, l));
      this.ropes.setMatrixAt(k++, m);
    };
    for (const s of [-1, 1]) {
      let prev: THREE.Vector3 | null = null;
      for (let i = 0; i < pts.length; i++) {
        const deck = pts[i].clone().addScaledVector(this.side, s * (this.width / 2 + 0.05));
        const rail = deck.clone();
        rail.y += 1.05 + Math.sin((i / pts.length) * Math.PI) * 0.25;
        if (prev) seg(prev, rail);
        if (i % 2 === 0) seg(deck, rail);
        prev = rail;
      }
    }
    this.ropes.count = k;
    this.ropes.instanceMatrix.needsUpdate = true;
  }
}

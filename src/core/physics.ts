// Rapier glue: fixed-step world, static collider helpers and interpolated
// dynamic bodies (so 120/144Hz displays stay perfectly smooth).
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { GRAVITY } from '../world/layout';

export { RAPIER };

export interface DynamicLink {
  body: RAPIER.RigidBody;
  obj: THREE.Object3D;
  prevP: THREE.Vector3;
  prevQ: THREE.Quaternion;
  curP: THREE.Vector3;
  curQ: THREE.Quaternion;
  offset?: THREE.Vector3; // visual offset in body space
  home: { p: THREE.Vector3; q: THREE.Quaternion };
  kind: string;
  sleepingVisual?: boolean;
}

export type ImpactHandler = (a: RAPIER.Collider, b: RAPIER.Collider, force: number, point: THREE.Vector3) => void;

export class Physics {
  world!: RAPIER.World;
  events!: RAPIER.EventQueue;
  links: DynamicLink[] = [];
  step = 1 / 60;
  acc = 0;
  alpha = 0;
  onImpact: ImpactHandler | null = null;
  beforeStep: ((dt: number) => void)[] = [];
  afterStep: ((dt: number) => void)[] = [];
  colliderKind = new Map<number, string>();

  async init() {
    await RAPIER.init();
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.world.timestep = this.step;
    this.events = new RAPIER.EventQueue(true);
  }

  tag(c: RAPIER.Collider, kind: string) {
    this.colliderKind.set(c.handle, kind);
    return c;
  }
  kindOf(c: RAPIER.Collider | null | undefined) {
    return c ? this.colliderKind.get(c.handle) ?? 'world' : 'world';
  }

  fixed(desc: RAPIER.ColliderDesc, x: number, y: number, z: number, q?: THREE.Quaternion, kind = 'static') {
    desc.setTranslation(x, y, z);
    if (q) desc.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    const c = this.world.createCollider(desc);
    return this.tag(c, kind);
  }

  boxFixed(x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw = 0, kind = 'static') {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    return this.fixed(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.6), x, y, z, q, kind);
  }

  cylFixed(x: number, y: number, z: number, r: number, hh: number, kind = 'static') {
    return this.fixed(RAPIER.ColliderDesc.cylinder(hh, r).setFriction(0.6), x, y, z, undefined, kind);
  }

  addDynamic(
    obj: THREE.Object3D,
    colliders: RAPIER.ColliderDesc[],
    opts: { mass?: number; damping?: number; angDamping?: number; kind?: string; ccd?: boolean; sleep?: boolean } = {},
  ): DynamicLink {
    const p = obj.position, q = obj.quaternion;
    const bd = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(p.x, p.y, p.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinearDamping(opts.damping ?? 0.15)
      .setAngularDamping(opts.angDamping ?? 0.4)
      .setCcdEnabled(!!opts.ccd);
    if (opts.sleep) bd.setSleeping(true);
    const body = this.world.createRigidBody(bd);
    for (const cd of colliders) {
      cd.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
      cd.setContactForceEventThreshold(40);
      const c = this.world.createCollider(cd, body);
      this.tag(c, opts.kind ?? 'prop');
    }
    if (opts.mass) {
      // scale density so total mass matches
      const m = body.mass();
      if (m > 0) for (let i = 0; i < body.numColliders(); i++) {
        const c = body.collider(i);
        c.setDensity(c.density() * (opts.mass / m));
      }
    }
    const link: DynamicLink = {
      body, obj,
      prevP: p.clone(), prevQ: q.clone(), curP: p.clone(), curQ: q.clone(),
      home: { p: p.clone(), q: q.clone() },
      kind: opts.kind ?? 'prop',
    };
    this.links.push(link);
    return link;
  }

  update(dt: number) {
    this.acc += Math.min(dt, 0.1);
    let steps = 0;
    while (this.acc >= this.step && steps < 5) {
      for (const l of this.links) {
        l.prevP.copy(l.curP);
        l.prevQ.copy(l.curQ);
      }
      for (const f of this.beforeStep) f(this.step);
      this.world.step(this.events);
      this.events.drainContactForceEvents((e) => {
        if (!this.onImpact) return;
        const c1 = this.world.getCollider(e.collider1());
        const c2 = this.world.getCollider(e.collider2());
        const b = c1.parent();
        const t = b ? b.translation() : c1.translation();
        this.onImpact(c1, c2, e.maxForceMagnitude(), new THREE.Vector3(t.x, t.y, t.z));
      });
      for (const f of this.afterStep) f(this.step);
      for (const l of this.links) {
        const t = l.body.translation(), r = l.body.rotation();
        l.curP.set(t.x, t.y, t.z);
        l.curQ.set(r.x, r.y, r.z, r.w);
      }
      this.acc -= this.step;
      steps++;
    }
    if (steps === 5) this.acc = 0;
    this.alpha = this.acc / this.step;
    for (const l of this.links) {
      l.obj.position.lerpVectors(l.prevP, l.curP, this.alpha);
      l.obj.quaternion.slerpQuaternions(l.prevQ, l.curQ, this.alpha);
    }
  }

  resetLink(l: DynamicLink) {
    l.body.setTranslation({ x: l.home.p.x, y: l.home.p.y, z: l.home.p.z }, true);
    l.body.setRotation({ x: l.home.q.x, y: l.home.q.y, z: l.home.q.z, w: l.home.q.w }, true);
    l.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    l.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    l.prevP.copy(l.home.p); l.curP.copy(l.home.p);
    l.prevQ.copy(l.home.q); l.curQ.copy(l.home.q);
  }
}

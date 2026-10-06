// "Wick" — the little lantern buggy. Rapier ray-cast vehicle + a lot of
// purely visual springs (body roll/pitch, squash, lantern antenna).
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Builder, M, MAT, box, cyl, ico, lathe, torus } from '../world/assets';
import type { Physics } from '../core/physics';
import type { Input } from '../core/input';
import { WATER_LEVEL } from '../world/layout';
import { clamp, damp, lerp } from '../utils/math';

const YELLOW = 0xffc23d, CREAM = 0xfff1d8, NAVY = 0x25233f, DARK = 0x2b2635, CORAL = 0xe8634e;

export interface WheelState { contact: boolean; point: THREE.Vector3; skid: number; }

export class Vehicle {
  root = new THREE.Group(); // interpolated chassis transform
  body = new THREE.Group(); // visual body (roll/pitch/squash springs)
  wheels: THREE.Group[] = [];
  lanternTip = new THREE.Group();
  lanternLight = new THREE.PointLight(0xffb05a, 0, 14, 1.6);
  headMat = new THREE.MeshStandardMaterial({ color: 0x40382e, emissive: 0xfff0c8, emissiveIntensity: 0.6 });
  tailMat = new THREE.MeshStandardMaterial({ color: 0x401010, emissive: 0xff3030, emissiveIntensity: 0.5 });
  lanternMat = new THREE.MeshStandardMaterial({ color: 0x40301c, emissive: 0xffb347, emissiveIntensity: 2.2 });
  rod: THREE.Mesh[] = [];
  chassis!: RAPIER.RigidBody;
  collider!: RAPIER.Collider;
  ctrl!: RAPIER.DynamicRayCastVehicleController;

  // tuning
  readonly wheelR = 0.42;
  readonly rest = 0.42;
  readonly wheelPos = [
    new THREE.Vector3(0.82, -0.05, 0.92), new THREE.Vector3(-0.82, -0.05, 0.92),
    new THREE.Vector3(0.82, -0.05, -0.88), new THREE.Vector3(-0.82, -0.05, -0.88),
  ];
  // state
  steer = 0;
  speed = 0; // signed forward speed m/s
  throttle = 0;
  boosting = false;
  grounded = 0; // number of wheels on the ground
  airTime = 0;
  landImpact = 0; // set on landing, consumed by game
  jumpCooldown = 0;
  inWater = 0;
  upsideTimer = 0;
  slip = 0;
  justJumped = false;
  enabled = false;
  wheelStates: WheelState[] = [];
  prevVel = new THREE.Vector3();
  accelLocal = new THREE.Vector3();
  private bodyRoll = 0; private bodyRollV = 0;
  private bodyPitch = 0; private bodyPitchV = 0;
  private squash = 0; private squashV = 0;
  private tip = new THREE.Vector2(); private tipV = new THREE.Vector2();
  private tmpQ = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private wheelSpin = [0, 0, 0, 0];

  constructor(private physics: Physics, private input: Input) {
    for (let i = 0; i < 4; i++) this.wheelStates.push({ contact: false, point: new THREE.Vector3(), skid: 0 });
  }

  build(x: number, y: number, z: number, yaw: number) {
    this.buildVisual();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const mass = 10;
    const bd = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setAdditionalMassProperties(mass, { x: 0, y: -0.32, z: 0.05 }, { x: 9, y: 11, z: 5 }, { x: 0, y: 0, z: 0, w: 1 })
      .setLinearDamping(0.05)
      .setAngularDamping(0.6)
      .setCcdEnabled(true);
    this.chassis = this.physics.world.createRigidBody(bd);
    const cd = RAPIER.ColliderDesc.roundCuboid(0.72, 0.2, 1.12, 0.12)
      .setTranslation(0, 0.08, 0)
      .setDensity(0)
      .setFriction(0.3)
      .setRestitution(0.1)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(60);
    this.collider = this.physics.world.createCollider(cd, this.chassis);
    this.physics.tag(this.collider, 'car');
    // cabin collider so the roof bumps into things too
    const cab = this.physics.world.createCollider(
      RAPIER.ColliderDesc.roundCuboid(0.55, 0.18, 0.55, 0.1).setTranslation(0, 0.55, -0.2).setDensity(0).setFriction(0.3), this.chassis);
    this.physics.tag(cab, 'car');

    this.ctrl = this.physics.world.createVehicleController(this.chassis);
    (this.ctrl as unknown as { setIndexForwardAxis: number }).setIndexForwardAxis = 2;
    for (const p of this.wheelPos) {
      this.ctrl.addWheel({ x: p.x, y: p.y, z: p.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, this.rest, this.wheelR);
    }
    for (let i = 0; i < 4; i++) {
      this.ctrl.setWheelSuspensionStiffness(i, 34);
      this.ctrl.setWheelSuspensionCompression(i, 3.2);
      this.ctrl.setWheelSuspensionRelaxation(i, 4.2);
      this.ctrl.setWheelMaxSuspensionTravel(i, 0.36);
      this.ctrl.setWheelMaxSuspensionForce(i, 3000);
      this.ctrl.setWheelFrictionSlip(i, 3.2);
      this.ctrl.setWheelSideFrictionStiffness(i, 1.0);
    }
    this.root.position.set(x, y, z);
    this.root.quaternion.copy(q);
    this.physics.beforeStep.push((dt) => this.fixedUpdate(dt));
    this.physics.afterStep.push(() => this.capture());
    this.prevP.set(x, y, z); this.curP.set(x, y, z); this.prevQ.copy(q); this.curQ.copy(q);
  }

  private buildVisual() {
    const bodyB = new Builder();
    const rb = (w: number, h: number, d: number, r: number) => new RoundedBoxGeometry(w, h, d, 2, r);
    bodyB.add(rb(1.66, 0.52, 2.45, 0.2), YELLOW, M(0, 0.0, 0), { ao: 0.3, vary: 0.02 });
    bodyB.add(rb(1.5, 0.22, 1.0, 0.1), YELLOW, M(0, 0.3, 0.72, 0.08, 0, 0));
    // cabin + window band
    bodyB.add(rb(1.34, 0.62, 1.25, 0.16), CREAM, M(0, 0.52, -0.25));
    bodyB.add(rb(1.38, 0.3, 1.18, 0.1), NAVY, M(0, 0.58, -0.22));
    bodyB.add(rb(1.42, 0.1, 1.32, 0.05), CREAM, M(0, 0.86, -0.25));
    // stripes
    bodyB.add(box(0.22, 0.02, 1.0), CORAL, M(0.25, 0.42, 0.72, 0.08, 0, 0));
    bodyB.add(box(0.22, 0.02, 1.0), CORAL, M(-0.25, 0.42, 0.72, 0.08, 0, 0));
    // bumpers
    bodyB.add(rb(1.55, 0.24, 0.3, 0.08), DARK, M(0, -0.22, 1.26));
    bodyB.add(rb(1.55, 0.24, 0.3, 0.08), DARK, M(0, -0.22, -1.24));
    // fenders
    for (const p of this.wheelPos) {
      bodyB.add(torus(0.5, 0.1, 4, 10, Math.PI), DARK, M(Math.sign(p.x) * 0.84, p.y + 0.02, p.z, 0, Math.PI / 2, 0));
    }
    // roof rack
    bodyB.add(box(1.2, 0.05, 0.08), DARK, M(0, 0.97, 0.1));
    bodyB.add(box(1.2, 0.05, 0.08), DARK, M(0, 0.97, -0.6));
    bodyB.add(box(0.5, 0.3, 0.4), 0xb27a55, M(0.25, 1.1, -0.3, 0, 0.2, 0));
    // exhaust
    bodyB.add(cyl(0.08, 0.1, 0.35, 6), 0x8a8a9a, M(0.5, -0.25, -1.4, Math.PI / 2, 0, 0));
    // lantern antenna base
    bodyB.add(cyl(0.08, 0.1, 0.12, 6), DARK, M(-0.42, 0.98, -0.65));
    const bodyMesh = new THREE.Mesh(bodyB.build(), MAT.stdSmooth.clone());
    (bodyMesh.material as THREE.MeshStandardMaterial).roughness = 0.45;
    (bodyMesh.material as THREE.MeshStandardMaterial).metalness = 0.05;
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    this.body.add(bodyMesh);

    // lights
    for (const s of [-1, 1]) {
      const h = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.08, 12), this.headMat);
      h.rotation.x = Math.PI / 2;
      h.position.set(s * 0.52, 0.08, 1.24);
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.12, 0.05), this.tailMat);
      t.position.set(s * 0.58, 0.08, -1.23);
      this.body.add(h, t);
    }

    // lantern antenna: 3 rod segments + lantern at the tip
    const rodGeo = new THREE.CylinderGeometry(0.025, 0.03, 0.42, 5);
    rodGeo.translate(0, 0.21, 0);
    let parent: THREE.Object3D = this.body;
    const rodBase = new THREE.Group();
    rodBase.position.set(-0.42, 1.04, -0.65);
    this.body.add(rodBase);
    parent = rodBase;
    for (let i = 0; i < 3; i++) {
      const seg = new THREE.Mesh(rodGeo, new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.5 }));
      if (i > 0) seg.position.y = 0.42;
      parent.add(seg);
      this.rod.push(seg);
      parent = seg;
    }
    this.lanternTip.position.y = 0.42;
    parent.add(this.lanternTip);
    const lb = new Builder();
    lb.add(cyl(0.16, 0.2, 0.06, 6), DARK, M(0, 0.0, 0));
    lb.add(cyl(0.06, 0.2, 0.12, 6), DARK, M(0, 0.4, 0));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      lb.add(box(0.03, 0.36, 0.03), DARK, M(Math.cos(a) * 0.16, 0.2, Math.sin(a) * 0.16));
    }
    lb.add(torus(0.08, 0.02, 4, 8), DARK, M(0, 0.5, 0));
    const frame = new THREE.Mesh(lb.build(), MAT.std);
    frame.castShadow = true;
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.14, 1), this.lanternMat);
    core.position.y = 0.2;
    this.lanternTip.add(frame, core);
    this.lanternLight.position.y = 0.2;
    this.lanternTip.add(this.lanternLight);

    // wheels
    const tireB = new Builder();
    tireB.add(lathe([[0.22, -0.19], [0.36, -0.2], [0.42, -0.15], [0.43, 0.0], [0.42, 0.15], [0.36, 0.2], [0.22, 0.19]], 14), DARK, M(0, 0, 0, 0, 0, Math.PI / 2), { vary: 0.05 });
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      tireB.add(box(0.36, 0.07, 0.1), 0x221e2b, M(0, Math.cos(a) * 0.425, Math.sin(a) * 0.425, a, 0, 0));
    }
    tireB.add(cyl(0.23, 0.23, 0.3, 10), CREAM, M(0, 0, 0, 0, 0, Math.PI / 2));
    tireB.add(cyl(0.09, 0.09, 0.34, 6), CORAL, M(0, 0, 0, 0, 0, Math.PI / 2));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      tireB.add(ico(0.035, 0), DARK, M(0.17, Math.cos(a) * 0.14, Math.sin(a) * 0.14));
      tireB.add(ico(0.035, 0), DARK, M(-0.17, Math.cos(a) * 0.14, Math.sin(a) * 0.14));
    }
    const tireGeo = tireB.build();
    for (let i = 0; i < 4; i++) {
      const g = new THREE.Group();
      const spin = new THREE.Mesh(tireGeo, MAT.std);
      spin.castShadow = true;
      g.add(spin);
      g.position.copy(this.wheelPos[i]);
      this.wheels.push(g);
      this.root.add(g);
    }
    this.root.add(this.body);
  }

  get position() { return this.root.position; }

  respawn(x: number, y: number, z: number, yaw: number) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.chassis.setTranslation({ x, y, z }, true);
    this.chassis.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.prevP.set(x, y, z); this.curP.set(x, y, z);
    this.prevQ.copy(q); this.curQ.copy(q);
    this.squash = -0.4;
    this.steer = 0;
  }

  prevP = new THREE.Vector3(); curP = new THREE.Vector3();
  prevQ = new THREE.Quaternion(); curQ = new THREE.Quaternion();

  private fixedUpdate(dt: number) {
    const c = this.chassis;
    this.prevP.copy(this.curP); this.prevQ.copy(this.curQ);
    const inp = this.input;
    const fwdIn = this.enabled ? inp.axisY : 0;
    const steerIn = this.enabled ? inp.axisX : 0;
    this.boosting = this.enabled && inp.boost && fwdIn > 0;

    const rot = c.rotation();
    this.tmpQ.set(rot.x, rot.y, rot.z, rot.w);
    const up = this.tmpV.set(0, 1, 0).applyQuaternion(this.tmpQ).clone();
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.tmpQ);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.tmpQ);
    const lv = c.linvel();
    const vel = new THREE.Vector3(lv.x, lv.y, lv.z);
    this.speed = vel.dot(fwd);
    const lateral = vel.dot(right);
    const absV = Math.abs(this.speed);

    // ---- steering: quick, speed-sensitive, self-centering
    const maxSteer = lerp(0.62, 0.24, clamp(absV / 28, 0, 1));
    this.steer = damp(this.steer, steerIn * maxSteer, steerIn !== 0 ? 9 : 12, dt);
    this.ctrl.setWheelSteering(0, this.steer);
    this.ctrl.setWheelSteering(1, this.steer);

    // ---- engine & brakes
    const maxFwd = this.boosting ? 31 : 21;
    let engine = 0, brake = 0;
    if (fwdIn > 0) {
      if (this.speed < -1.5) brake = 0.6;
      else engine = (this.boosting ? 125 : 88) * Math.max(0, 1 - Math.pow(Math.max(0, this.speed) / maxFwd, 2.2));
    } else if (fwdIn < 0) {
      if (this.speed > 1.5) brake = 0.75;
      else engine = -55 * Math.max(0, 1 - Math.pow(Math.max(0, -this.speed) / 10, 2));
    } else {
      // coast gently at speed, hold firm on slopes when nearly stopped
      brake = lerp(1.4, 0.07, clamp(absV / 5, 0, 1));
    }
    this.throttle = fwdIn;
    for (let i = 0; i < 4; i++) {
      this.ctrl.setWheelEngineForce(i, engine * (i < 2 ? 0.45 : 0.55));
      this.ctrl.setWheelBrake(i, brake);
    }

    // ---- grip: the rear lets go a little when cornering hard at speed (drift)
    const corner = Math.abs(steerIn) * clamp((absV - 9) / 12, 0, 1);
    const rearGrip = lerp(1.0, 0.42, corner * (this.boosting ? 1 : 0.8));
    for (let i = 2; i < 4; i++) {
      this.ctrl.setWheelSideFrictionStiffness(i, rearGrip);
      this.ctrl.setWheelFrictionSlip(i, lerp(3.2, 1.8, corner));
    }

    this.ctrl.updateVehicle(dt);

    // ---- contacts
    let g = 0;
    for (let i = 0; i < 4; i++) {
      const ws = this.wheelStates[i];
      ws.contact = this.ctrl.wheelIsInContact(i);
      if (ws.contact) {
        g++;
        const p = this.ctrl.wheelContactPoint(i);
        if (p) ws.point.set(p.x, p.y, p.z);
      }
      ws.skid = ws.contact ? Math.abs(lateral) : 0;
    }
    const wasAir = this.grounded === 0;
    this.grounded = g;
    this.slip = g > 0 ? Math.abs(lateral) : 0;

    if (g === 0) {
      this.airTime += dt;
      // air control + gentle self-righting
      const av = c.angvel();
      const yawT = steerIn * 6;
      const align = new THREE.Vector3().crossVectors(up, new THREE.Vector3(0, 1, 0)).multiplyScalar(14);
      c.applyTorqueImpulse({
        x: (align.x + right.x * fwdIn * 2.5 - av.x * 1.2) * dt,
        y: (yawT - av.y * 1.5) * dt,
        z: (align.z + right.z * fwdIn * 2.5 - av.z * 1.2) * dt,
      }, true);
    } else {
      if (wasAir && this.airTime > 0.25) {
        this.landImpact = Math.min(1.5, this.airTime * 0.9 + Math.abs(this.prevVel.y) * 0.05);
        this.squashV -= this.landImpact * 6;
      }
      this.airTime = 0;
      // downforce keeps it planted at speed
      const df = absV * absV * 0.012 * 10;
      c.applyImpulse({ x: -up.x * df * dt, y: -up.y * df * dt, z: -up.z * df * dt }, true);
      // mild extra yaw authority at low speed so it feels nimble
      if (absV > 0.5 && absV < 10) {
        const av = c.angvel();
        const want = this.steer * Math.sign(this.speed) * 1.2 * clamp(absV / 4, 0, 1);
        c.applyTorqueImpulse({ x: 0, y: (want - av.y) * 2.2 * dt, z: 0 }, true);
      }
    }

    // ---- jump
    this.jumpCooldown -= dt;
    this.justJumped = false;
    if (this.enabled && inp.consumeJump() && g >= 2 && this.jumpCooldown <= 0) {
      c.applyImpulse({ x: 0, y: 78, z: 0 }, true);
      c.applyTorqueImpulse({ x: right.x * -3, y: 0, z: right.z * -3 }, true);
      this.jumpCooldown = 0.6;
      this.squashV += 7;
      this.justJumped = true;
    }

    // ---- water: drag + buoyancy
    const t = c.translation();
    const sub = WATER_LEVEL - (t.y - 0.4);
    this.inWater = sub > 0 && this.waterQuery(t.x, t.z) ? Math.min(1, sub / 1.0) : 0;
    if (this.inWater > 0) {
      const k = this.inWater;
      c.applyImpulse({ x: -vel.x * 4.5 * k * dt, y: (25 * 10 * 0.95 * k - vel.y * 8 * k) * dt, z: -vel.z * 4.5 * k * dt }, true);
    }

    // ---- stuck upside down? flip back after a moment
    if (up.y < 0.25 && absV < 3) this.upsideTimer += dt; else this.upsideTimer = 0;
    if (this.upsideTimer > 1.3) {
      this.upsideTimer = 0;
      const yaw = Math.atan2(fwd.x, fwd.z);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      c.setTranslation({ x: t.x, y: t.y + 1.6, z: t.z }, true);
      c.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      c.setAngvel({ x: 0, y: 0, z: 0 }, true);
      c.setLinvel({ x: 0, y: 3, z: 0 }, true);
      this.squash = -0.5;
    }

    // local acceleration for the visual springs
    const acc = vel.clone().sub(this.prevVel).divideScalar(dt);
    this.prevVel.copy(vel);
    this.accelLocal.set(acc.dot(right), acc.dot(up), acc.dot(fwd));

  }

  private capture() {
    const tt = this.chassis.translation(), rr = this.chassis.rotation();
    this.curP.set(tt.x, tt.y, tt.z);
    this.curQ.set(rr.x, rr.y, rr.z, rr.w);
  }

  waterQuery: (x: number, z: number) => boolean = () => false;

  /** Per-frame visual update (interpolation + springs). */
  update(dt: number, alpha: number, night: number) {
    this.root.position.lerpVectors(this.prevP, this.curP, alpha);
    this.root.quaternion.slerpQuaternions(this.prevQ, this.curQ, alpha);

    // wheels
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const len = this.ctrl.wheelSuspensionLength(i) ?? this.rest;
      w.position.set(this.wheelPos[i].x, this.wheelPos[i].y - len, this.wheelPos[i].z);
      w.rotation.set(0, i < 2 ? this.steer : 0, 0);
      const spinTarget = this.ctrl.wheelRotation(i) ?? 0;
      this.wheelSpin[i] = spinTarget;
      (w.children[0] as THREE.Object3D).rotation.x = spinTarget;
      w.scale.x = i % 2 === 0 ? 1 : -1;
    }

    // body springs: roll from lateral accel, pitch from longitudinal accel, squash
    const a = this.accelLocal;
    const targetRoll = clamp(-a.x * 0.006, -0.12, 0.12);
    const targetPitch = clamp(a.z * 0.005, -0.1, 0.1);
    const spring = (x: number, v: number, target: number, k: number, d: number) => {
      const f = (target - x) * k - v * d;
      v += f * dt;
      x += v * dt;
      return [x, v];
    };
    [this.bodyRoll, this.bodyRollV] = spring(this.bodyRoll, this.bodyRollV, targetRoll, 120, 9);
    [this.bodyPitch, this.bodyPitchV] = spring(this.bodyPitch, this.bodyPitchV, targetPitch, 120, 9);
    [this.squash, this.squashV] = spring(this.squash, this.squashV, 0, 180, 11);
    this.body.rotation.set(this.bodyPitch, 0, this.bodyRoll);
    const sq = clamp(this.squash, -0.35, 0.35);
    this.body.scale.set(1 - sq * 0.35, 1 + sq, 1 - sq * 0.25);
    this.body.position.y = sq * 0.3;

    // lantern antenna spring (driven by acceleration, wobbles after bumps)
    const fx = -a.x * 0.0035 + Math.sin(performance.now() * 0.004) * 0.002 * Math.abs(this.speed) * 0.1;
    const fz = -a.z * 0.0035;
    const k = 70, d = 4.5;
    this.tipV.x += ((fx - this.tip.x) * k - this.tipV.x * d) * dt;
    this.tipV.y += ((fz - this.tip.y) * k - this.tipV.y * d) * dt;
    this.tipV.y += -this.squashV * 0.02 * dt;
    this.tip.x += this.tipV.x * dt;
    this.tip.y += this.tipV.y * dt;
    this.tip.x = clamp(this.tip.x, -0.5, 0.5);
    this.tip.y = clamp(this.tip.y, -0.5, 0.5);
    for (let i = 0; i < 3; i++) this.rod[i].rotation.set(this.tip.y * (0.5 + i * 0.4), 0, -this.tip.x * (0.5 + i * 0.4));
    this.lanternTip.rotation.set(-this.tip.y * 1.4, 0, this.tip.x * 1.4);

    // lights get stronger as night falls
    this.headMat.emissiveIntensity = 0.6 + night * 3.5;
    this.tailMat.emissiveIntensity = (this.throttle < 0 && this.speed > 0.5 ? 3 : 0.5) + night * 1.2;
    this.lanternMat.emissiveIntensity = 2.0 + night * 2.5 + Math.sin(performance.now() * 0.01) * 0.15;
    this.lanternLight.intensity = 2 + night * 26;
  }

  forward(out = new THREE.Vector3()) {
    return out.set(0, 0, 1).applyQuaternion(this.root.quaternion);
  }
  velocity(out = new THREE.Vector3()) {
    const v = this.chassis.linvel();
    return out.set(v.x, v.y, v.z);
  }
}

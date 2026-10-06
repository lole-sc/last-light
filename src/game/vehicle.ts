// "Wick" — the little lantern buggy. Rapier ray-cast vehicle + a lot of
// purely visual springs (body roll/pitch, squash, lantern antenna) and the
// lantern-balloon that rescues you when you fall off the world.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Builder, M, MAT, blob, box, cyl, ico, lathe, torus } from '../world/assets';
import type { Physics } from '../core/physics';
import type { Input } from '../core/input';
import { GRAVITY, WATER_LEVEL } from '../world/layout';
import { clamp, damp, lerp } from '../utils/math';

const YELLOW = 0xffbf2e, CREAM = 0xfff1d8, NAVY = 0x25233f, DARK = 0x2b2635, CORAL = 0xe8634e, CHROME = 0xd9d6e6, TEAL = 0x2f8f8a;

export interface WheelState { contact: boolean; point: THREE.Vector3; skid: number; }

function decalTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff1d8';
  g.beginPath(); g.arc(64, 64, 60, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#e8634e'; g.lineWidth = 8;
  g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.stroke();
  // a little flame
  g.fillStyle = '#e8634e';
  g.beginPath();
  g.moveTo(64, 22); g.bezierCurveTo(90, 52, 92, 70, 84, 86); g.bezierCurveTo(78, 100, 50, 102, 44, 86);
  g.bezierCurveTo(38, 70, 48, 58, 54, 50); g.bezierCurveTo(56, 62, 60, 66, 66, 64); g.bezierCurveTo(70, 50, 62, 36, 64, 22);
  g.fill();
  g.fillStyle = '#ffbf2e';
  g.beginPath(); g.ellipse(64, 82, 10, 14, 0, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Vehicle {
  root = new THREE.Group(); // interpolated chassis transform
  body = new THREE.Group(); // visual body (roll/pitch/squash springs)
  wheels: THREE.Group[] = [];
  lanternTip = new THREE.Group();
  lanternLight = new THREE.PointLight(0xffb05a, 0, 14, 1.6);
  headLight = new THREE.SpotLight(0xfff0d0, 0, 24, 0.6, 0.85, 1.4);
  headMat = new THREE.MeshStandardMaterial({ color: 0x40382e, emissive: 0xfff0c8, emissiveIntensity: 0.6 });
  tailMat = new THREE.MeshStandardMaterial({ color: 0x401010, emissive: 0xff3030, emissiveIntensity: 0.5 });
  lanternMat = new THREE.MeshStandardMaterial({ color: 0x40301c, emissive: 0xffb347, emissiveIntensity: 2.2 });
  bodyMat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.0, clearcoat: 0.8, clearcoatRoughness: 0.3, envMapIntensity: 0.6 });
  glassMat = new THREE.MeshPhysicalMaterial({ color: 0x1d2440, roughness: 0.08, metalness: 0.1, clearcoat: 1, transparent: true, opacity: 0.88, envMapIntensity: 1.2 });
  chromeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.22, metalness: 0.9, envMapIntensity: 1.1 });
  balloon = new THREE.Group();
  rod: THREE.Mesh[] = [];
  chassis!: RAPIER.RigidBody;
  collider!: RAPIER.Collider;
  ctrl!: RAPIER.DynamicRayCastVehicleController;

  // tuning
  readonly mass = 10;
  readonly wheelR = 0.44;
  readonly rest = 0.42;
  readonly wheelPos = [
    new THREE.Vector3(0.84, -0.05, 0.94), new THREE.Vector3(-0.84, -0.05, 0.94),
    new THREE.Vector3(0.84, -0.05, -0.9), new THREE.Vector3(-0.84, -0.05, -0.9),
  ];
  // state
  steer = 0;
  speed = 0; // signed forward speed m/s
  throttle = 0;
  boosting = false;
  boostKick = 0; // > 0 for a moment after the boost is engaged (for FX)
  grounded = 0;
  airTime = 0;
  landImpact = 0;
  jumpCooldown = 0;
  inWater = 0;
  upsideTimer = 0;
  stuckTime = 0;
  wiggleCooldown = 0;
  wiggles = 0;
  /** set when the car auto-freed itself (for a puff of FX) */
  unstuck = false;
  slip = 0;
  justJumped = false;
  enabled = false;
  launched = 0; // seconds of protected geyser flight remaining
  balloonActive = false;
  balloonT = 0;
  balloonPopped = false;
  wheelStates: WheelState[] = [];
  prevVel = new THREE.Vector3();
  accelLocal = new THREE.Vector3();
  private wasBoost = false;
  private bodyRoll = 0; private bodyRollV = 0;
  private bodyPitch = 0; private bodyPitchV = 0;
  private squash = 0; private squashV = 0;
  private tip = new THREE.Vector2(); private tipV = new THREE.Vector2();
  private tmpQ = new THREE.Quaternion();

  constructor(private physics: Physics, private input: Input) {
    for (let i = 0; i < 4; i++) this.wheelStates.push({ contact: false, point: new THREE.Vector3(), skid: 0 });
  }

  build(x: number, y: number, z: number, yaw: number) {
    this.buildVisual();
    this.buildBalloon();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const bd = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setAdditionalMassProperties(this.mass, { x: 0, y: -0.34, z: 0.05 }, { x: 9, y: 11, z: 5 }, { x: 0, y: 0, z: 0, w: 1 })
      .setLinearDamping(0.05)
      .setAngularDamping(0.6)
      .setCcdEnabled(true);
    this.chassis = this.physics.world.createRigidBody(bd);
    const cd = RAPIER.ColliderDesc.roundCuboid(0.72, 0.18, 1.12, 0.14)
      .setTranslation(0, 0.08, 0)
      .setDensity(0)
      .setFriction(0.15)
      .setRestitution(0.1)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(60);
    this.collider = this.physics.world.createCollider(cd, this.chassis);
    this.physics.tag(this.collider, 'car');
    const cab = this.physics.world.createCollider(
      RAPIER.ColliderDesc.roundCuboid(0.55, 0.18, 0.55, 0.12).setTranslation(0, 0.56, -0.2).setDensity(0).setFriction(0.15), this.chassis);
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
    this.prevP.set(x, y, z); this.curP.set(x, y, z); this.prevQ.copy(q); this.curQ.copy(q);
    this.physics.beforeStep.push((dt) => this.fixedUpdate(dt));
    this.physics.afterStep.push(() => this.capture());
  }

  setEnvironment(env: THREE.Texture) {
    for (const m of [this.bodyMat, this.glassMat, this.chromeMat]) { m.envMap = env; m.needsUpdate = true; }
  }

  // ------------------------------------------------------------------ look
  private buildVisual() {
    const rb = (w: number, h: number, d: number, r: number) => new RoundedBoxGeometry(w, h, d, 3, r);
    // painted body (clear-coated)
    const paint = new Builder();
    paint.add(rb(1.7, 0.5, 2.5, 0.22), YELLOW, M(0, 0.02, 0), { ao: 0.25 });
    paint.add(rb(1.52, 0.26, 1.02, 0.12), YELLOW, M(0, 0.33, 0.74, 0.07, 0, 0));
    paint.add(rb(1.5, 0.2, 0.62, 0.1), YELLOW, M(0, 0.3, -1.0));
    // cream cabin shell + roof
    paint.add(rb(1.38, 0.18, 1.3, 0.08), CREAM, M(0, 0.9, -0.25));
    for (const [sx, sz] of [[-0.62, 0.32], [0.62, 0.32], [-0.62, -0.82], [0.62, -0.82]]) paint.add(box(0.1, 0.5, 0.1), CREAM, M(sx, 0.6, sz, sz > 0 ? -0.18 : 0.1, 0, 0));
    // coral racing stripes over the hood and roof
    for (const sx of [-0.2, 0.2]) {
      paint.add(box(0.16, 0.02, 1.0), CORAL, M(sx, 0.47, 0.74, 0.07, 0, 0));
      paint.add(box(0.16, 0.02, 1.28), CORAL, M(sx, 1.0, -0.25));
      paint.add(box(0.16, 0.02, 0.6), CORAL, M(sx, 0.41, -1.0));
    }
    // side swoosh
    for (const s of [-1, 1]) paint.add(box(0.02, 0.07, 2.0), CORAL, M(s * 0.856, -0.05, 0.05));
    const bodyMesh = new THREE.Mesh(paint.build(), this.bodyMat);
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    this.body.add(bodyMesh);

    // matte parts: bumpers, skirt, fenders, rack, spare tyre
    const matte = new Builder();
    matte.add(rb(1.78, 0.16, 2.56, 0.07), DARK, M(0, -0.25, 0));
    matte.add(rb(1.62, 0.26, 0.32, 0.1), DARK, M(0, -0.18, 1.3));
    matte.add(rb(1.62, 0.26, 0.32, 0.1), DARK, M(0, -0.18, -1.28));
    for (const p of this.wheelPos) {
      const s = Math.sign(p.x);
      matte.add(torus(0.56, 0.085, 5, 14, Math.PI), DARK, M(s * 0.86, p.y + 0.02, p.z, 0, Math.PI / 2, 0));
      if (p.z < 0) matte.add(box(0.04, 0.32, 0.26), CORAL, M(s * 0.86, -0.32, p.z - 0.5)); // mud flaps
    }
    // grille
    matte.add(rb(1.0, 0.24, 0.1, 0.04), NAVY, M(0, 0.06, 1.26));
    // roof rack rails and luggage
    for (const sx of [-0.55, 0.55]) matte.add(cyl(0.03, 0.03, 1.25, 5), DARK, M(sx, 1.08, -0.25, Math.PI / 2, 0, 0));
    for (const sz of [0.25, -0.75]) matte.add(cyl(0.03, 0.03, 1.1, 5), DARK, M(0, 1.08, sz, 0, 0, Math.PI / 2));
    matte.add(blob(0.32, 1, 0.08, 31, 0.6), 0x6f7d4a, M(0.18, 1.22, -0.05, 0, 0.3, 0)); // canvas bag
    matte.add(box(0.42, 0.28, 0.36), 0xb27a55, M(0.22, 1.24, -0.55, 0, -0.2, 0), { vary: 0.08 });
    matte.add(cyl(0.035, 0.035, 0.44, 4), 0x6b4a2a, M(0.18, 1.39, -0.05, 0, 0, Math.PI / 2));
    // spare tyre on the tail
    matte.add(torus(0.3, 0.13, 6, 14), DARK, M(0, 0.32, -1.36));
    matte.add(cyl(0.18, 0.18, 0.1, 10), CORAL, M(0, 0.32, -1.36, Math.PI / 2, 0, 0));
    // lantern mast base
    matte.add(cyl(0.08, 0.11, 0.14, 6), DARK, M(-0.45, 1.06, -0.72));
    const matteMesh = new THREE.Mesh(matte.build(), MAT.std);
    matteMesh.castShadow = true;
    this.body.add(matteMesh);

    // glass bubble
    const glass = new THREE.Mesh(rb(1.3, 0.48, 1.18, 0.12), this.glassMat);
    glass.position.set(0, 0.62, -0.25);
    this.body.add(glass);

    // chrome: grille bars, bug-eye rims, exhaust, bumper guards
    const chrome = new Builder();
    for (let i = -2; i <= 2; i++) chrome.add(box(0.05, 0.2, 0.05), CHROME, M(i * 0.17, 0.06, 1.32));
    for (const s of [-1, 1]) {
      chrome.add(torus(0.2, 0.04, 6, 18), CHROME, M(s * 0.52, 0.5, 1.06));
      chrome.add(cyl(0.2, 0.17, 0.2, 14), DARK, M(s * 0.52, 0.5, 0.96, Math.PI / 2, 0, 0));
      chrome.add(box(0.06, 0.3, 0.06), CHROME, M(s * 0.6, -0.1, 1.47, 0.3, 0, 0));
      chrome.add(ico(0.06, 1), CHROME, M(s * 0.74, 0.62, 0.42)); // mirrors
    }
    chrome.add(cyl(0.08, 0.1, 0.4, 8), CHROME, M(0.55, -0.24, -1.45, Math.PI / 2, 0, 0));
    const chromeMesh = new THREE.Mesh(chrome.build(), this.chromeMat);
    chromeMesh.castShadow = true;
    this.body.add(chromeMesh);

    // bug-eye headlights + tail lights
    for (const s of [-1, 1]) {
      const h = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), this.headMat);
      h.rotation.x = Math.PI / 2;
      h.position.set(s * 0.52, 0.5, 1.06);
      const fog = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.05, 10), this.headMat);
      fog.rotation.x = Math.PI / 2;
      fog.position.set(s * 0.42, -0.16, 1.47);
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.05), this.tailMat);
      t.position.set(s * 0.6, 0.1, -1.27);
      this.body.add(h, fog, t);
    }
    // roundel decals on the doors
    const decal = new THREE.MeshStandardMaterial({ map: decalTexture(), transparent: true, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -2 });
    for (const s of [-1, 1]) {
      const d = new THREE.Mesh(new THREE.CircleGeometry(0.2, 24), decal);
      d.position.set(s * 0.862, 0.06, -0.05);
      d.rotation.y = s * Math.PI / 2;
      this.body.add(d);
    }
    // headlight beam (night)
    this.headLight.position.set(0, 0.5, 1.2);
    this.headLight.target.position.set(0, -1.6, 9);
    this.body.add(this.headLight, this.headLight.target);

    // lantern antenna: 3 rod segments + lantern at the tip
    const rodGeo = new THREE.CylinderGeometry(0.022, 0.03, 0.42, 5);
    rodGeo.translate(0, 0.21, 0);
    const rodBase = new THREE.Group();
    rodBase.position.set(-0.45, 1.12, -0.72);
    this.body.add(rodBase);
    let parent: THREE.Object3D = rodBase;
    const rodMat = new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.5 });
    for (let i = 0; i < 3; i++) {
      const seg = new THREE.Mesh(rodGeo, rodMat);
      if (i > 0) seg.position.y = 0.42;
      parent.add(seg);
      this.rod.push(seg);
      parent = seg;
    }
    this.lanternTip.position.y = 0.42;
    parent.add(this.lanternTip);
    const lb = new Builder();
    lb.add(cyl(0.17, 0.21, 0.07, 8), 0xc99a3f, M(0, 0.0, 0));
    lb.add(lathe([[0.21, 0], [0.16, 0.12], [0.05, 0.2], [0, 0.22]], 8), 0xc99a3f, M(0, 0.4, 0));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      lb.add(box(0.025, 0.38, 0.025), DARK, M(Math.cos(a) * 0.17, 0.2, Math.sin(a) * 0.17));
    }
    lb.add(torus(0.09, 0.022, 5, 10), 0xc99a3f, M(0, 0.66, 0));
    const frame = new THREE.Mesh(lb.build(), this.chromeMat);
    frame.castShadow = true;
    const glassL = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.36, 10, 1, true), new THREE.MeshStandardMaterial({ color: 0xffe2a8, transparent: true, opacity: 0.25, roughness: 0.1 }));
    glassL.position.y = 0.2;
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.11, 1), this.lanternMat);
    core.position.y = 0.17;
    core.scale.set(0.8, 1.3, 0.8);
    core.name = 'flame';
    this.lanternTip.add(frame, glassL, core);
    this.lanternLight.position.y = 0.2;
    this.lanternTip.add(this.lanternLight);

    // wheels: chunky tyres, coral 5-spoke rims, chrome caps
    const tire = new Builder();
    tire.add(lathe([[0.24, -0.21], [0.38, -0.22], [0.44, -0.16], [0.45, 0.0], [0.44, 0.16], [0.38, 0.22], [0.24, 0.21]], 16), DARK, M(0, 0, 0, 0, 0, Math.PI / 2), { vary: 0.04 });
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      tire.add(box(0.4, 0.07, 0.11), 0x221e2b, M(0, Math.cos(a) * 0.445, Math.sin(a) * 0.445, a, 0, 0));
    }
    tire.add(cyl(0.25, 0.25, 0.32, 12), CORAL, M(0, 0, 0, 0, 0, Math.PI / 2));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      for (const sx of [-0.17, 0.17]) tire.add(box(0.03, 0.06, 0.2), CREAM, M(sx, Math.cos(a) * 0.12, Math.sin(a) * 0.12, a, 0, 0));
    }
    const tireGeo = tire.build();
    const cap = new THREE.CylinderGeometry(0.08, 0.08, 0.36, 10);
    cap.rotateZ(Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      const g = new THREE.Group();
      const spin = new THREE.Group();
      const t = new THREE.Mesh(tireGeo, MAT.std);
      t.castShadow = true;
      const c = new THREE.Mesh(cap, this.chromeMat);
      const cc = new Float32Array((cap.getAttribute('position') as THREE.BufferAttribute).count * 3).fill(0.85);
      cap.setAttribute('color', new THREE.BufferAttribute(cc, 3));
      spin.add(t, c);
      g.add(spin);
      g.position.copy(this.wheelPos[i]);
      this.wheels.push(g);
      this.root.add(g);
    }
    this.root.add(this.body);
  }

  private buildBalloon() {
    // the lantern puffs itself up into a little hot-air balloon
    const b = new Builder();
    const segs = 12;
    for (let i = 0; i < segs; i++) {
      const g = new THREE.SphereGeometry(1.6, 2, 12, (i / segs) * Math.PI * 2, (Math.PI * 2) / segs, 0, Math.PI * 0.82);
      b.add(g, i % 2 ? CORAL : CREAM, M(0, 0, 0, 0, 0, 0, 1, 1.18, 1));
    }
    b.add(lathe([[0.55, -1.25], [0.3, -1.6], [0.0, -1.62]], 10), CORAL, M());
    const envelope = new THREE.Mesh(b.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide }));
    envelope.castShadow = true;
    envelope.position.y = 3.6;
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffb347).multiplyScalar(3) }));
    glow.position.y = 2.1;
    const ropes = new Builder();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const top = new THREE.Vector3(Math.cos(a) * 1.05, 2.5, Math.sin(a) * 1.05);
      const bot = new THREE.Vector3(Math.cos(a) * 0.62, 0.95, Math.sin(a) * 1.0);
      const mid = top.clone().add(bot).multiplyScalar(0.5);
      const len = top.distanceTo(bot);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), top.clone().sub(bot).normalize());
      const e = new THREE.Euler().setFromQuaternion(q);
      ropes.add(cyl(0.015, 0.015, len, 3), 0xd8c39a, M(mid.x, mid.y, mid.z, e.x, e.y, e.z));
    }
    const ropeMesh = new THREE.Mesh(ropes.build(), MAT.std);
    this.balloon.add(envelope, glow, ropeMesh);
    this.balloon.visible = false;
    this.root.add(this.balloon);
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
    this.root.position.set(x, y, z);
    this.root.quaternion.copy(q);
    this.squash = -0.4;
    this.steer = 0;
    this.stuckTime = 0;
    this.launched = 0;
  }

  /** Put the car back on its wheels right where it is. */
  resetInPlace() {
    const t = this.chassis.translation();
    const f = this.forward();
    this.respawn(t.x, t.y + 1.8, t.z, Math.atan2(f.x, f.z));
  }

  startBalloon() {
    this.balloonActive = true;
    this.balloonT = 0;
    this.balloonPopped = false;
    this.balloon.visible = true;
    this.balloon.scale.setScalar(0.01);
  }

  prevP = new THREE.Vector3(); curP = new THREE.Vector3();
  prevQ = new THREE.Quaternion(); curQ = new THREE.Quaternion();

  private fixedUpdate(dt: number) {
    const c = this.chassis;
    const inp = this.input;
    const fwdIn = this.enabled ? inp.axisY : 0;
    const steerIn = this.enabled ? inp.axisX : 0;
    this.boosting = this.enabled && inp.boost && fwdIn > 0;

    const rot = c.rotation();
    this.tmpQ.set(rot.x, rot.y, rot.z, rot.w);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.tmpQ);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.tmpQ);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.tmpQ);
    const lv = c.linvel();
    const vel = new THREE.Vector3(lv.x, lv.y, lv.z);
    this.speed = vel.dot(fwd);
    const lateral = vel.dot(right);
    const absV = Math.abs(this.speed);

    // ---- steering: quick, speed-sensitive, self-centering
    const maxSteer = lerp(0.62, 0.22, clamp(absV / 30, 0, 1));
    this.steer = damp(this.steer, steerIn * maxSteer, steerIn !== 0 ? 9 : 12, dt);
    this.ctrl.setWheelSteering(0, this.steer);
    this.ctrl.setWheelSteering(1, this.steer);

    // ---- engine & brakes
    const maxFwd = this.boosting ? 38 : 22;
    let engine = 0, brake = 0;
    if (fwdIn > 0) {
      if (this.speed < -1.5) brake = 0.6;
      else engine = (this.boosting ? 215 : 95) * Math.max(0, 1 - Math.pow(Math.max(0, this.speed) / maxFwd, 2.4));
    } else if (fwdIn < 0) {
      if (this.speed > 1.5) brake = 0.8;
      else engine = -(inp.boost ? 110 : 60) * Math.max(0, 1 - Math.pow(Math.max(0, -this.speed) / (inp.boost ? 16 : 10), 2));
    } else {
      // coast gently at speed, hold firm on slopes when nearly stopped
      brake = lerp(1.4, 0.07, clamp(absV / 5, 0, 1));
    }
    if (this.balloonActive) { engine *= 0.3; brake = 0; }
    this.throttle = fwdIn;
    for (let i = 0; i < 4; i++) {
      this.ctrl.setWheelEngineForce(i, engine * (i < 2 ? 0.45 : 0.55));
      this.ctrl.setWheelBrake(i, brake);
    }

    // boost kick: a satisfying shove the moment you hit it
    this.boostKick = Math.max(0, this.boostKick - dt);
    if (this.boosting && !this.wasBoost && this.grounded >= 2) {
      c.applyImpulse({ x: fwd.x * 42, y: 6, z: fwd.z * 42 }, true);
      this.boostKick = 0.6;
      this.squashV -= 3;
    }
    this.wasBoost = this.boosting;

    // ---- grip: the rear lets go a little when cornering hard at speed (drift)
    const corner = Math.abs(steerIn) * clamp((absV - 9) / 12, 0, 1);
    const rearGrip = lerp(1.0, 0.42, corner * (this.boosting ? 1 : 0.8));
    for (let i = 2; i < 4; i++) {
      this.ctrl.setWheelSideFrictionStiffness(i, rearGrip);
      this.ctrl.setWheelFrictionSlip(i, lerp(3.2, 1.8, corner));
    }

    // wheels never "stand" on rope rails or on the car itself
    this.ctrl.updateVehicle(dt, undefined, undefined, (col) => {
      const k = this.physics.kindOf(col);
      return k !== 'rope' && k !== 'car';
    });

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
      const av = c.angvel();
      const yawT = steerIn * 6;
      const align = new THREE.Vector3().crossVectors(up, new THREE.Vector3(0, 1, 0)).multiplyScalar(this.launched > 0 || this.balloonActive ? 40 : 14);
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
      const df = absV * absV * 0.12;
      c.applyImpulse({ x: -up.x * df * dt, y: -up.y * df * dt, z: -up.z * df * dt }, true);
      if (absV > 0.5 && absV < 10) {
        const av = c.angvel();
        const want = this.steer * Math.sign(this.speed) * 1.2 * clamp(absV / 4, 0, 1);
        c.applyTorqueImpulse({ x: 0, y: (want - av.y) * 2.2 * dt, z: 0 }, true);
      }
    }
    this.launched = Math.max(0, this.launched - dt);

    // ---- unstick: wheels in the air but not falling, or pushing against something
    this.wiggleCooldown -= dt;
    const pushing = fwdIn !== 0 && absV < 0.9 && Math.abs(vel.y) < 1.2;
    const beached = g < 2 && Math.abs(vel.y) < 0.8 && vel.length() < 1.2;
    if (this.enabled && (pushing || beached) && !this.balloonActive) this.stuckTime += dt;
    else this.stuckTime = Math.max(0, this.stuckTime - dt * 2);
    if (absV > 3) this.wiggles = 0;
    if (this.stuckTime > 0.9 && this.wiggleCooldown <= 0) {
      this.wiggles++;
      if (this.wiggles >= 3) {
        // still wedged: hop up and back out of whatever we're caught on, wheels down
        const t0 = c.translation();
        const yaw = Math.atan2(fwd.x, fwd.z);
        const back = fwdIn < 0 ? 1 : -1;
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw + (Math.random() - 0.5) * 0.5);
        c.setTranslation({ x: t0.x + fwd.x * 1.6 * back, y: t0.y + 1.4, z: t0.z + fwd.z * 1.6 * back }, true);
        c.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
        c.setLinvel({ x: fwd.x * 3 * back, y: 2, z: fwd.z * 3 * back }, true);
        c.setAngvel({ x: 0, y: 0, z: 0 }, true);
        this.wiggles = 0;
        this.stuckTime = 0;
        this.unstuck = true;
      } else {
        const dirSign = fwdIn !== 0 ? fwdIn : 1;
        const k = 1 + this.wiggles * 0.5;
        c.applyImpulse({ x: fwd.x * 26 * dirSign * k, y: 48 * k, z: fwd.z * 26 * dirSign * k }, true);
        c.applyTorqueImpulse({ x: (Math.random() - 0.5) * 3, y: steerIn * 4 + (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 3 }, true);
        this.squashV += 5;
      }
      this.wiggleCooldown = 0.9;
    }

    // ---- jump
    this.jumpCooldown -= dt;
    this.justJumped = false;
    if (this.enabled && inp.consumeJump() && g >= 2 && this.jumpCooldown <= 0) {
      c.applyImpulse({ x: 0, y: 80, z: 0 }, true);
      c.applyTorqueImpulse({ x: right.x * -3, y: 0, z: right.z * -3 }, true);
      this.jumpCooldown = 0.6;
      this.squashV += 7;
      this.justJumped = true;
    }

    // ---- balloon: lift against gravity, settle into a gentle descent
    if (this.balloonActive) {
      this.balloonT += dt;
      const targetVy = -3.2;
      const lift = -GRAVITY * this.mass + (targetVy - vel.y) * this.mass * 2.5;
      c.applyImpulse({ x: -vel.x * this.mass * 0.8 * dt, y: lift * dt, z: -vel.z * this.mass * 0.8 * dt }, true);
      if (g >= 2 && this.balloonT > 0.4) { this.balloonActive = false; this.balloonPopped = true; }
    }

    // ---- water: drag + buoyancy
    const t = c.translation();
    const sub = WATER_LEVEL - (t.y - 0.4);
    this.inWater = sub > 0 && this.waterQuery(t.x, t.z) ? Math.min(1, sub / 1.0) : 0;
    if (this.inWater > 0) {
      const k = this.inWater;
      c.applyImpulse({ x: -vel.x * 4.5 * k * dt, y: (-GRAVITY * this.mass * 0.95 * k - vel.y * 8 * k) * dt, z: -vel.z * 4.5 * k * dt }, true);
    }

    // ---- stuck upside down? flip back after a moment
    if (up.y < 0.25 && absV < 3) this.upsideTimer += dt; else this.upsideTimer = 0;
    if (this.upsideTimer > 1.1) {
      this.upsideTimer = 0;
      const yaw = Math.atan2(fwd.x, fwd.z);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      c.setTranslation({ x: t.x, y: t.y + 1.6, z: t.z }, true);
      c.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      c.setAngvel({ x: 0, y: 0, z: 0 }, true);
      c.setLinvel({ x: 0, y: 3, z: 0 }, true);
      this.squash = -0.5;
    }

    const acc = vel.clone().sub(this.prevVel).divideScalar(dt);
    this.prevVel.copy(vel);
    this.accelLocal.set(acc.dot(right), acc.dot(up), acc.dot(fwd));
  }

  private capture() {
    this.prevP.copy(this.curP); this.prevQ.copy(this.curQ);
    const tt = this.chassis.translation(), rr = this.chassis.rotation();
    this.curP.set(tt.x, tt.y, tt.z);
    this.curQ.set(rr.x, rr.y, rr.z, rr.w);
  }

  waterQuery: (x: number, z: number) => boolean = () => false;

  /** Per-frame visual update (interpolation + springs). */
  update(dt: number, alpha: number, night: number) {
    this.root.position.lerpVectors(this.prevP, this.curP, alpha);
    this.root.quaternion.slerpQuaternions(this.prevQ, this.curQ, alpha);

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const len = this.ctrl.wheelSuspensionLength(i) ?? this.rest;
      w.position.set(this.wheelPos[i].x, this.wheelPos[i].y - len, this.wheelPos[i].z);
      w.rotation.set(0, i < 2 ? this.steer : 0, 0);
      (w.children[0] as THREE.Object3D).rotation.x = this.ctrl.wheelRotation(i) ?? 0;
      w.scale.x = i % 2 === 0 ? 1 : -1;
    }

    const a = this.accelLocal;
    const targetRoll = clamp(-a.x * 0.006, -0.12, 0.12);
    const targetPitch = clamp(a.z * 0.005, -0.1, 0.1);
    const spring = (x: number, v: number, target: number, k: number, d: number) => {
      v += ((target - x) * k - v * d) * dt;
      return [x + v * dt, v];
    };
    [this.bodyRoll, this.bodyRollV] = spring(this.bodyRoll, this.bodyRollV, targetRoll, 120, 9);
    [this.bodyPitch, this.bodyPitchV] = spring(this.bodyPitch, this.bodyPitchV, targetPitch, 120, 9);
    [this.squash, this.squashV] = spring(this.squash, this.squashV, 0, 180, 11);
    this.body.rotation.set(this.bodyPitch, 0, this.bodyRoll);
    const sq = clamp(this.squash, -0.35, 0.35);
    this.body.scale.set(1 - sq * 0.35, 1 + sq, 1 - sq * 0.25);
    this.body.position.y = sq * 0.3;

    // lantern antenna spring
    const now = performance.now();
    const fx = -a.x * 0.0035;
    const fz = -a.z * 0.0035;
    const k = 70, d = 4.5;
    this.tipV.x += ((fx - this.tip.x) * k - this.tipV.x * d) * dt;
    this.tipV.y += ((fz - this.tip.y) * k - this.tipV.y * d) * dt;
    this.tipV.y += -this.squashV * 0.02 * dt;
    this.tip.x = clamp(this.tip.x + this.tipV.x * dt, -0.5, 0.5);
    this.tip.y = clamp(this.tip.y + this.tipV.y * dt, -0.5, 0.5);
    for (let i = 0; i < 3; i++) this.rod[i].rotation.set(this.tip.y * (0.5 + i * 0.4), 0, -this.tip.x * (0.5 + i * 0.4));
    this.lanternTip.rotation.set(-this.tip.y * 1.4, 0, this.tip.x * 1.4);
    const flame = this.lanternTip.getObjectByName('flame');
    if (flame) flame.scale.set(0.8, 1.25 + Math.sin(now * 0.021) * 0.12 + Math.sin(now * 0.037) * 0.06, 0.8);

    // balloon
    if (this.balloon.visible) {
      if (this.balloonActive) {
        const s = Math.min(1, this.balloonT * 2.2);
        const e = 1 + Math.sin(this.balloonT * 9) * 0.06 * (1 - s);
        this.balloon.scale.setScalar(Math.max(0.01, s * e));
        this.balloon.rotation.z = Math.sin(now * 0.002) * 0.05;
        this.balloon.rotation.y += dt * 0.4;
      } else {
        const s = this.balloon.scale.x * (1 + dt * 6) ;
        this.balloon.scale.setScalar(s);
        if (s > 1.6) { this.balloon.visible = false; this.balloon.scale.setScalar(1); }
      }
    }

    this.headMat.emissiveIntensity = 0.6 + night * 3.5;
    this.headLight.intensity = night * 22;
    this.tailMat.emissiveIntensity = (this.throttle < 0 && this.speed > 0.5 ? 3 : 0.5) + night * 1.2;
    this.lanternMat.emissiveIntensity = 2.0 + night * 2.5 + Math.sin(now * 0.01) * 0.15;
    this.lanternLight.intensity = 2 + night * 26;
    this.bodyMat.envMapIntensity = 0.6 - night * 0.4;
  }

  forward(out = new THREE.Vector3()) {
    return out.set(0, 0, 1).applyQuaternion(this.root.quaternion);
  }
  velocity(out = new THREE.Vector3()) {
    const v = this.chassis.linvel();
    return out.set(v.x, v.y, v.z);
  }
}

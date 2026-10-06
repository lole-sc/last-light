// Camera rig: damped follow with look-ahead, lazy yaw that follows travel
// direction, mouse orbit, wheel zoom, dynamic FOV, impulses & cinematic shots.
import * as THREE from 'three';
import { clamp, damp, dampAngle, easeInOutCubic, lerp } from '../utils/math';
import { groundHeight } from '../world/terrain';

export class CameraRig {
  camera: THREE.PerspectiveCamera;
  target = new THREE.Vector3();
  private look = new THREE.Vector3();
  private lookVel = new THREE.Vector3();
  yaw = 0; // camera sits south of the car, looking north
  pitch = 0.72;
  dist = 26;
  private zoom = 1;
  private userYawHold = 0;
  private shake = 0;
  private impulse = new THREE.Vector3();
  private impulseV = new THREE.Vector3();
  baseFov = 42;
  mode: 'intro' | 'transition' | 'follow' | 'cinematic' | 'shot' | 'fall' = 'intro';
  shotPos = new THREE.Vector3();
  shotLook = new THREE.Vector3();
  shotSpeed = 1.2;
  /** extra distance while flying (geysers) */
  flight = 0;
  private flightK = 0;
  private trans = 0;
  private transFromPos = new THREE.Vector3();
  private transFromLook = new THREE.Vector3();
  cinematic: { center: THREE.Vector3; radius: number; height: number; t: number; speed: number } | null = null;
  /** Authored camera hints: near these spots the camera eases into a better angle. */
  hints: { x: number; z: number; r: number; yaw: number; pitch: number; dist: number; through?: number; focus?: THREE.Vector3; focusW?: number }[] = [];
  private focusBlend = new THREE.Vector3();
  private focusW = 0;
  basePitch = 0.72;
  private hintDist = 1;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(this.baseFov, aspect, 0.3, 3200);
  }

  addShake(a: number) { this.shake = Math.min(1.2, this.shake + a); }
  kick(dir: THREE.Vector3, amount: number) { this.impulseV.addScaledVector(dir, amount); }

  startTransition() {
    this.mode = 'transition';
    this.trans = 0;
    this.transFromPos.copy(this.camera.position);
    this.transFromLook.copy(this.look);
  }

  startCinematic(center: THREE.Vector3, radius: number, height: number, speed = 0.18) {
    this.mode = 'cinematic';
    const a = Math.atan2(this.camera.position.z - center.z, this.camera.position.x - center.x);
    this.cinematic = { center: center.clone(), radius, height, t: a, speed };
  }

  endCinematic() {
    this.startTransition();
  }

  /** Ease towards a fixed authored shot. */
  setShot(pos: THREE.Vector3, look: THREE.Vector3, speed = 1.2) {
    this.mode = 'shot';
    this.shotPos.copy(pos);
    this.shotLook.copy(look);
    this.shotSpeed = speed;
  }

  /** Falling off the world: hold height, track the car as it drops through the clouds. */
  startFall() { this.mode = 'fall'; }

  private followPose(carPos: THREE.Vector3, vel: THREE.Vector3, outPos: THREE.Vector3, outLook: THREE.Vector3) {
    const speed = Math.hypot(vel.x, vel.z);
    // look a little ahead of where the car is heading
    const ahead = new THREE.Vector3(vel.x, 0, vel.z).multiplyScalar(0.32);
    if (ahead.length() > 7) ahead.setLength(7);
    outLook.copy(carPos).add(ahead);
    outLook.y += 0.8;
    if (this.focusW > 0.001) outLook.lerp(this.focusBlend, this.focusW);
    const d = this.dist * this.zoom * this.hintDist * (1 + clamp(speed / 30, 0, 1) * 0.18 + this.flightK * 0.45);
    const p = this.pitch;
    outPos.set(
      outLook.x + Math.sin(this.yaw) * Math.cos(p) * d,
      outLook.y + Math.sin(p) * d,
      outLook.z + Math.cos(this.yaw) * Math.cos(p) * d,
    );
  }

  update(dt: number, carPos: THREE.Vector3, vel: THREE.Vector3, forward: THREE.Vector3, drag: number[], wheel: number, introT: number) {
    const cam = this.camera;
    this.flightK = damp(this.flightK, this.flight > 0 ? 1 : 0, this.flight > 0 ? 2.5 : 1.2, dt);
    // user input
    if (drag[0] !== 0 || drag[1] !== 0) {
      this.yaw -= drag[0] * 0.006;
      this.pitch = clamp(this.pitch + drag[1] * 0.004, 0.22, 1.25);
      this.userYawHold = 2.5;
    }
    if (wheel) this.zoom = clamp(this.zoom * (1 + wheel * 0.09), 0.55, 1.7);
    this.userYawHold = Math.max(0, this.userYawHold - dt);

    const speed = Math.hypot(vel.x, vel.z);
    // authored hints
    let hw = 0, hint: (typeof this.hints)[number] | null = null;
    for (const h of this.hints) {
      const w = 1 - clamp((Math.hypot(carPos.x - h.x, carPos.z - h.z) - h.r * 0.45) / (h.r * 0.55), 0, 1);
      if (w > hw) { hw = w; hint = h; }
    }
    if (this.mode === 'follow' && hint && hw > 0 && this.userYawHold <= 0) {
      let hy = hint.yaw;
      if (hint.through !== undefined) {
        // put the camera beyond the hint point, looking back at the car through it
        const vx = hint.x - carPos.x, vz = hint.z - carPos.z;
        const l = Math.hypot(vx, vz);
        const a = l > 4 ? Math.atan2(vz, vx) + hint.through : Math.atan2(Math.cos(hint.yaw), Math.sin(hint.yaw));
        hy = Math.atan2(Math.cos(a), Math.sin(a));
      }
      this.yaw = dampAngle(this.yaw, hy, 1.6 * hw, dt);
      this.pitch = damp(this.pitch, this.basePitch + (hint.pitch - this.basePitch) * hw, 1.5, dt);
      this.hintDist = damp(this.hintDist, 1 + (hint.dist - 1) * hw, 1.5, dt);
      if (hint.focus) { this.focusBlend.copy(hint.focus); this.focusW = damp(this.focusW, (hint.focusW ?? 0.5) * hw, 1.5, dt); }
      else this.focusW = damp(this.focusW, 0, 1.5, dt);
    } else if (this.userYawHold <= 0) {
      this.focusW = damp(this.focusW, 0, 1.5, dt);
      this.pitch = damp(this.pitch, this.basePitch, 0.8, dt);
      this.hintDist = damp(this.hintDist, 1, 1, dt);
    }
    if (this.mode === 'follow' && this.userYawHold <= 0 && speed > 3 && hw < 0.3) {
      // lazily swing behind the direction of travel (only when moving forward)
      const travelYaw = Math.atan2(-vel.x, -vel.z);
      const facing = new THREE.Vector3(vel.x, 0, vel.z).normalize().dot(new THREE.Vector3(forward.x, 0, forward.z).normalize());
      if (facing > 0.2) this.yaw = dampAngle(this.yaw, travelYaw, 0.55 * clamp((speed - 3) / 10, 0, 1), dt);
    }

    const pos = new THREE.Vector3(), look = new THREE.Vector3();
    if (this.mode === 'intro') {
      const a = introT * 0.07 + 0.6;
      // frame the isle right-of-centre so the title card has room on the left
      const shift = Math.min(1, window.innerWidth / 1100) * 30;
      look.set(-Math.sin(a) * shift, -2, Math.cos(a) * shift);
      pos.set(Math.cos(a) * 150, 72 + Math.sin(introT * 0.15) * 6, Math.sin(a) * 150);
      cam.position.copy(pos);
      this.look.copy(look);
    } else if (this.mode === 'shot') {
      cam.position.lerp(this.shotPos, 1 - Math.exp(-dt * this.shotSpeed));
      this.look.lerp(this.shotLook, 1 - Math.exp(-dt * this.shotSpeed * 1.6));
    } else if (this.mode === 'fall') {
      // stay roughly where we are, slowly sinking, always looking at Wick
      const want = new THREE.Vector3(cam.position.x, Math.max(carPos.y + 12, cam.position.y - dt * 14), cam.position.z);
      cam.position.lerp(want, 1 - Math.exp(-dt * 3));
      this.look.lerp(carPos, 1 - Math.exp(-dt * 8));
    } else if (this.mode === 'cinematic' && this.cinematic) {
      const c = this.cinematic;
      c.t += dt * c.speed;
      pos.set(c.center.x + Math.cos(c.t) * c.radius, c.center.y + c.height, c.center.z + Math.sin(c.t) * c.radius);
      cam.position.lerp(pos, 1 - Math.exp(-dt * 2));
      this.look.lerp(c.center, 1 - Math.exp(-dt * 3));
    } else {
      this.followPose(carPos, vel, pos, look);
      if (this.mode === 'transition') {
        this.trans = Math.min(1, this.trans + dt / 2.6);
        const k = easeInOutCubic(this.trans);
        cam.position.lerpVectors(this.transFromPos, pos, k);
        // arc the move upward a little so it feels like a crane shot
        cam.position.y += Math.sin(k * Math.PI) * 12;
        this.look.lerpVectors(this.transFromLook, look, easeInOutCubic(Math.min(1, this.trans * 1.15)));
        if (this.trans >= 1) this.mode = 'follow';
      } else {
        // critically-damped follow on both position and look target
        const kPos = 1 - Math.exp(-dt * 6.5);
        cam.position.lerp(pos, kPos);
        this.lookVel.subVectors(look, this.look);
        this.look.lerp(look, 1 - Math.exp(-dt * 9));
      }
      // never sink below the terrain
      const gh = groundHeight(cam.position.x, cam.position.z) + 2.0;
      if (cam.position.y < gh) cam.position.y = gh;
    }

    // impulses (spring) + shake
    this.impulseV.addScaledVector(this.impulse, -90 * dt);
    this.impulseV.multiplyScalar(Math.exp(-dt * 9));
    this.impulse.addScaledVector(this.impulseV, dt);
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const t = performance.now() * 0.001;
    const sh = this.shake * this.shake * 0.35;
    const shakeV = new THREE.Vector3(Math.sin(t * 47) * sh, Math.sin(t * 59 + 1) * sh, Math.sin(t * 41 + 2) * sh);

    cam.position.add(this.impulse).add(shakeV);
    cam.lookAt(this.look.clone().add(this.impulse.clone().multiplyScalar(0.5)));
    cam.position.sub(this.impulse).sub(shakeV);
    this.target.copy(this.look);

    const fovTarget = this.mode === 'follow' ? this.baseFov + clamp(speed / 30, 0, 1) * 9 : this.baseFov;
    cam.fov = damp(cam.fov, fovTarget, 3, dt);
    cam.updateProjectionMatrix();
    void lerp;
  }
}

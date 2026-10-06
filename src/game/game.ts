// The game: boots the world, runs the loop, and wires every system together.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Physics } from '../core/physics';
import { Input } from '../core/input';
import { Renderer, detectQuality, type QualityName } from '../core/renderer';
import { CameraRig } from '../core/camera';
import { uniforms } from '../world/assets';
import { buildTerrain, groundColor, groundHeight, groundNormal } from '../world/terrain';
import { Foliage } from '../world/foliage';
import { Atmosphere } from '../world/atmosphere';
import { Water } from '../world/water';
import { Structures } from '../world/structures';
import { BEACONS, BRIDGE, BRIDGE_ANGLE, FALLS, GLIMMERS, NOTES, RUINS, SPAWN, WATER_LEVEL, PLAZA } from '../world/layout';
import { Vehicle } from './vehicle';
import { Props } from './props';
import { Objectives, type Beacon } from './objectives';
import { ParticleSystem, makeAmbientField } from '../fx/particles';
import { Tracks } from '../fx/tracks';
import { AudioEngine } from '../audio/audio';
import { UI } from '../ui/ui';
import { clamp, smoothstep } from '../utils/math';

type State = 'loading' | 'intro' | 'play' | 'paused' | 'note' | 'map' | 'finale' | 'end';
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const LEAF_COLORS = [0xff8c5a, 0xffb052, 0xf2607a, 0xf6c453];
const RUINS_SECRET = GLIMMERS.findIndex((g) => g[0] === -46 && g[1] === -40);

export class Game {
  canvas = document.getElementById('game') as HTMLCanvasElement;
  scene = new THREE.Scene();
  physics = new Physics();
  input = new Input(this.canvas);
  renderer = new Renderer(this.canvas);
  rig = new CameraRig(window.innerWidth / window.innerHeight);
  audio = new AudioEngine();
  ui = new UI();
  atmo = new Atmosphere(this.scene);
  water!: Water;
  foliage!: Foliage;
  structures!: Structures;
  vehicle!: Vehicle;
  props!: Props;
  obj!: Objectives;
  soft = new ParticleSystem(2600, false);
  glow = new ParticleSystem(2200, true);
  tracks = new Tracks(900);
  motes = makeAmbientField(260, 50, false);
  fireflies = makeAmbientField(180, 46, true);
  shock!: THREE.Mesh;

  state: State = 'loading';
  time = 0;
  playTime = 0;
  introT = 0;
  tod = 0;
  todTarget = 0;
  checkpoint = { x: SPAWN.x, z: SPAWN.z, yaw: SPAWN.yaw };
  glimmerCount = 0;
  combo = 0;
  lastGlimmerAt = -10;
  notesRead: boolean[] = NOTES.map(() => false);
  nearNote = -1;
  respawning = false;
  bellRings: number[] = [];
  bellCooldown = 0;
  secretRevealed = false;
  impactCooldown = new Map<string, number>();
  trackDist = [0, 0];
  lastWheelPos = [new THREE.Vector3(), new THREE.Vector3()];
  wasInWater = 0;
  emitTimers = { smoke: 0, fire: 0, mist: 0, wake: 0, embers: 0, leaves: 0 };
  mushroomCooldown = 0;
  finaleT = 0;
  finished = false;
  quality: QualityName = 'high';
  fpsAcc = 0; fpsFrames = 0; lowFpsTime = 0; downgraded = false;
  last = performance.now();
  startGame: () => void = () => {};
  private tmp = new THREE.Vector3();

  async boot() {
    const step = async (p: number, s: string) => { this.ui.loader(p, s); await nextFrame(); };
    await step(0.04, 'waking the physics…');
    await this.physics.init();
    try { await Promise.race([document.fonts.load('600 40px Fraunces'), new Promise((r) => setTimeout(r, 1500))]); } catch { /* fonts optional */ }

    this.quality = detectQuality(this.renderer.renderer.getContext());
    this.renderer.setup(this.scene, this.rig.camera, this.quality);

    await step(0.14, 'raising the island out of the clouds…');
    const terrain = buildTerrain();
    this.scene.add(terrain.mesh);
    this.physics.fixed(RAPIER.ColliderDesc.trimesh(terrain.vertices, terrain.indices).setFriction(0.9), 0, 0, 0, undefined, 'ground');

    await step(0.3, 'painting the sky at golden hour…');
    this.scene.add(this.atmo.build());

    await step(0.42, 'filling the pond, tipping the waterfall…');
    this.water = new Water(terrain.heightTex);
    this.scene.add(this.water.build());

    await step(0.52, 'planting trees and teaching the grass to sway…');
    this.foliage = new Foliage(this.physics, { grass: 1 });
    this.scene.add(this.foliage.build());

    await step(0.7, 'building the lighthouse, the mill and the bridges…');
    this.structures = new Structures(this.physics);
    this.scene.add(this.structures.build());

    await step(0.8, 'stacking crates (for knocking over)…');
    this.props = new Props(this.physics);
    this.scene.add(this.props.build());
    this.obj = new Objectives(this.physics);
    this.scene.add(this.obj.build());
    this.hideSecretGlimmer();

    await step(0.88, 'polishing Wick’s lantern…');
    this.vehicle = new Vehicle(this.physics, this.input);
    this.vehicle.build(SPAWN.x, groundHeight(SPAWN.x, SPAWN.z) + 1.2, SPAWN.z, SPAWN.yaw);
    this.vehicle.waterQuery = (x, z) => this.water.depthAt(x, z, WATER_LEVEL - 0.1) > 0;
    this.scene.add(this.vehicle.root);

    this.scene.add(this.soft.points, this.glow.points, this.tracks.mesh, this.motes, this.fireflies);
    this.shock = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffc56b, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.shock.rotation.x = -Math.PI / 2;
    this.scene.add(this.shock);

    this.physics.onImpact = (a, b, f, p) => this.onImpact(a, b, f, p);
    // camera hints: side-on views of the waterfall and the rope bridge
    {
      // camera swings out over the void to the south of the falls and frames the cascade + the car
      const fa = Math.atan2(FALLS.dirZ, FALLS.dirX) - 1.15;
      const focus = new THREE.Vector3(FALLS.x + FALLS.dirX * 5, -7, FALLS.z + FALLS.dirZ * 5);
      this.rig.hints.push({ x: FALLS.x, z: FALLS.z, r: 24, yaw: Math.atan2(Math.cos(fa), Math.sin(fa)), pitch: 0.3, dist: 1.25, focus, focusW: 0.55 });
      const ba = BRIDGE_ANGLE + Math.PI / 2;
      this.rig.hints.push({ x: (BRIDGE.a.x + BRIDGE.b.x) / 2, z: (BRIDGE.a.z + BRIDGE.b.z) / 2, r: 22, yaw: Math.atan2(Math.cos(ba), Math.sin(ba)), pitch: 0.5, dist: 1.2 });
    }
    this.applyQuality(this.quality, false);

    await step(0.95, 'compiling shaders…');
    this.rig.update(0, this.vehicle.position, new THREE.Vector3(), new THREE.Vector3(0, 0, -1), [0, 0], 0, 0);
    this.atmo.update(0, 0, new THREE.Vector3(), 120);
    this.renderer.renderer.compile(this.scene, this.rig.camera);
    // warm a few frames so the first visible frame is smooth
    for (let i = 0; i < 3; i++) { this.physics.update(1 / 60); this.renderer.render(1 / 60); await nextFrame(); }

    this.bindUI();
    this.updateHud();
    this.ui.loader(1, 'ready');
    await new Promise((r) => setTimeout(r, 250));
    this.ui.hideLoader();
    this.ui.showTitle(true, this.quality);
    this.state = 'intro';
    // ?play skips the title screen (handy for testing and for embedding)
    if (new URLSearchParams(location.search).has('play')) setTimeout(() => this.startGame(), 50);
    window.addEventListener('resize', () => this.resize());
    this.resize();
    requestAnimationFrame((t) => this.loop(t));
  }

  // ------------------------------------------------------------------ UI
  private bindUI() {
    const start = () => {
      if (this.state !== 'intro') return;
      this.audio.start();
      this.audio.uiOpen();
      this.ui.showTitle(false);
      this.rig.startTransition();
      this.state = 'play';
      this.vehicle.enabled = false;
      setTimeout(() => {
        this.vehicle.enabled = true;
        this.ui.showHud(true);
        this.ui.toast('Find the first beacon — follow the glowing marker', 4200);
      }, 1700);
    };
    this.input.anyKeyListeners.push((code) => {
      if (this.state === 'intro') { start(); return; }
      this.audio.start(); // (re)unlock audio on any user gesture
      this.onKey(code);
    });
    this.canvas.addEventListener('pointerdown', () => { if (this.state === 'intro') start(); else this.audio.start(); });
    document.getElementById('title')!.addEventListener('click', start);

    document.getElementById('btn-sound')!.addEventListener('click', () => this.toggleSound());
    document.getElementById('btn-map')!.addEventListener('click', () => this.toggleMap());
    document.getElementById('btn-menu')!.addEventListener('click', () => this.togglePause());
    document.querySelectorAll<HTMLButtonElement>('#seg-quality button').forEach((b) => b.addEventListener('click', () => {
      this.applyQuality(b.dataset.q as QualityName, true); this.renderer.persist(this.quality); this.audio.click();
    }));
    document.querySelectorAll<HTMLButtonElement>('#seg-sound button').forEach((b) => b.addEventListener('click', () => {
      this.audio.setMuted(b.dataset.s === 'off'); this.syncSoundUI(); this.audio.click();
    }));
    document.querySelectorAll<HTMLButtonElement>('#seg-music button').forEach((b) => b.addEventListener('click', () => {
      this.audio.musicOn = b.dataset.m === 'on'; this.syncSoundUI(); this.audio.click();
    }));
    document.querySelectorAll<HTMLButtonElement>('#pause .menu-btn').forEach((b) => b.addEventListener('click', () => {
      const act = b.dataset.act;
      this.audio.click();
      if (act === 'resume') this.togglePause();
      if (act === 'respawn') { this.togglePause(); this.respawn(); }
      if (act === 'restart') { this.togglePause(); this.restart(); }
    }));
    document.getElementById('end-continue')!.addEventListener('click', () => {
      this.ui.show('end', false);
      this.state = 'play';
      this.vehicle.enabled = true;
      this.rig.endCinematic();
      this.audio.uiClose();
    });
    this.syncSoundUI();
    this.ui.setQualityButtons(this.quality);
    this.startGame = start;
  }

  private onKey(code: string) {
    if (this.state === 'note') {
      if (code === 'KeyE' || code === 'Escape' || code === 'Enter' || code === 'Space') this.closeNote();
      return;
    }
    if (this.state === 'map') { if (code === 'KeyM' || code === 'Escape') this.toggleMap(); return; }
    if (this.state === 'paused') { if (code === 'Escape' || code === 'KeyP') this.togglePause(); return; }
    if (this.state === 'end') return;
    if (code === 'Escape' || code === 'KeyP') this.togglePause();
    else if (code === 'KeyM') this.toggleMap();
    else if (code === 'KeyR' && this.state === 'play') this.respawn();
    else if (code === 'KeyH') this.ui.toggleControls();
    else if (code === 'KeyN') this.toggleSound();
    else if ((code === 'KeyE' || code === 'Enter') && this.state === 'play' && this.nearNote >= 0) this.openNote(this.nearNote);
  }

  private toggleSound() {
    this.audio.setMuted(!this.audio.muted);
    this.syncSoundUI();
  }
  private syncSoundUI() {
    this.ui.setSound(!this.audio.muted);
    this.ui.setSoundButtons(!this.audio.muted, this.audio.musicOn);
  }
  private togglePause() {
    if (this.state === 'play') { this.state = 'paused'; this.ui.show('pause', true); this.audio.uiOpen(); }
    else if (this.state === 'paused') { this.state = 'play'; this.ui.show('pause', false); this.audio.uiClose(); }
  }
  private toggleMap() {
    if (this.state === 'play') {
      this.state = 'map';
      const f = this.vehicle.forward();
      this.ui.drawMap(this.vehicle.position, Math.atan2(f.x, f.z), this.obj.beacons.map((b) => b.lit), this.obj.litCount === 5, this.obj.finale.lit, this.notesRead);
      this.ui.show('map', true);
      this.audio.uiOpen();
    } else if (this.state === 'map') {
      this.state = 'play'; this.ui.show('map', false); this.audio.uiClose();
    }
  }
  private openNote(i: number) {
    this.state = 'note';
    this.ui.showNote(i);
    this.ui.setPrompt(null);
    if (!this.notesRead[i]) this.notesRead[i] = true;
    this.audio.uiOpen();
  }
  private closeNote() {
    this.state = 'play';
    this.ui.hideNote();
    this.audio.uiClose();
  }

  applyQuality(q: QualityName, announce: boolean) {
    this.quality = q;
    this.renderer.applyQuality(q);
    const p = this.renderer.preset;
    const sun = this.atmo.sun;
    if (sun.shadow.mapSize.x !== p.shadow) {
      sun.shadow.mapSize.set(p.shadow, p.shadow);
      sun.shadow.map?.dispose();
      (sun.shadow as unknown as { map: null }).map = null;
    }
    sun.shadow.radius = p.shadowRadius;
    for (const m of this.foliage.grassMeshes) {
      const g = m.geometry as THREE.InstancedBufferGeometry;
      if (g.userData.full === undefined) g.userData.full = g.instanceCount;
      g.instanceCount = Math.floor(g.userData.full * p.grass);
    }
    this.ui.setQualityButtons(q);
    if (announce) this.ui.toast(`Quality: ${q}`);
  }

  private resize() {
    this.rig.camera.aspect = window.innerWidth / window.innerHeight;
    this.rig.camera.updateProjectionMatrix();
    this.renderer.resize();
  }

  // ---------------------------------------------------------------- loop
  private loop(now: number) {
    requestAnimationFrame((t) => this.loop(t));
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    uniforms.uTime.value = this.time;

    const running = this.state === 'play' || this.state === 'intro' || this.state === 'finale' || this.state === 'end';
    if (running) {
      this.physics.update(dt);
      this.vehicle.update(dt, this.physics.alpha, uniforms.uNight.value);
      if (this.state === 'intro') this.introT += dt;
      if (this.state === 'play' && this.vehicle.enabled && !this.finished) this.playTime += dt;
      this.gameplay(dt);
    }

    // camera
    const drag = this.state === 'play' || this.state === 'finale' ? this.input.takeDrag() : (this.input.takeDrag(), [0, 0]);
    const wheel = this.state === 'play' ? this.input.takeWheel() : (this.input.takeWheel(), 0);
    const vel = this.vehicle.velocity(this.tmp);
    this.rig.update(dt, this.vehicle.position, vel, this.vehicle.forward(), drag, wheel, this.introT);

    // world animation that runs even while paused looks odd; keep it with `running`
    if (running) this.animateWorld(dt);
    const focus = this.state === 'intro' ? new THREE.Vector3(0, 0, 0) : this.vehicle.position;
    this.atmo.update(dt, this.time, focus, this.state === 'intro' || this.rig.mode === 'transition' || this.rig.mode === 'cinematic' ? 110 : 42);
    this.renderer.setExposure(this.atmo.exposure);

    const scale = this.renderer.renderer.domElement.height / (2 * Math.tan((this.rig.camera.fov * Math.PI) / 360));
    this.soft.setScale(scale); this.glow.setScale(scale);
    (this.motes.material as THREE.ShaderMaterial).uniforms.uScale.value = scale;
    (this.fireflies.material as THREE.ShaderMaterial).uniforms.uScale.value = scale;

    this.grassLod();
    this.renderer.render(dt);
    this.input.endFrame();
    this.monitorPerf(dt);
  }

  private monitorPerf(dt: number) {
    if (this.state !== 'play' && this.state !== 'intro') return;
    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc < 1) return;
    const avgMs = (this.fpsAcc / this.fpsFrames) * 1000;
    this.fpsAcc = 0; this.fpsFrames = 0;
    if (this.time < 4) return; // ignore the first seconds (shader warm-up)
    // 1) dynamic resolution keeps the look and holds the frame rate
    this.renderer.adaptResolution(avgMs);
    // 2) only if we are already at the resolution floor and still slow, drop a preset
    this.lowFpsTime = avgMs > 30 && this.renderer.dynScale <= 0.56 ? this.lowFpsTime + 1 : Math.max(0, this.lowFpsTime - 1);
    if (this.lowFpsTime >= 4 && this.quality !== 'low' && !this.downgraded) {
      this.downgraded = true;
      this.applyQuality(this.quality === 'high' ? 'medium' : 'low', false);
      this.ui.toast(`Switched to ${this.quality} quality for smoother play`);
    }
  }

  /** Thin out grass in chunks far from the camera's focus. */
  private grassLod() {
    const f = this.rig.target;
    const q = this.renderer.preset.grass;
    for (const m of this.foliage.grassMeshes) {
      const g = m.geometry as THREE.InstancedBufferGeometry;
      const c = g.boundingSphere!.center;
      const d = Math.hypot(c.x - f.x, c.z - f.z);
      const lod = d < 45 ? 1 : d < 110 ? 1 - ((d - 45) / 65) * 0.7 : 0.3;
      g.instanceCount = Math.floor((g.userData.full as number) * q * lod);
    }
  }

  // ------------------------------------------------------------ gameplay
  private gameplay(dt: number) {
    const v = this.vehicle;
    const p = v.position;
    uniforms.uPlayer.value.copy(p);

    // time of day eases towards the progress target
    this.tod += (this.todTarget - this.tod) * Math.min(1, dt * 0.45);
    if (Math.abs(this.todTarget - this.tod) > 0.0005) this.applyTimeOfDay();

    if (this.state === 'finale') this.updateFinale(dt);
    if (this.state !== 'play') return;

    // ---- beacons
    let kindling = false;
    const list: Beacon[] = this.obj.litCount === 5 ? [...this.obj.beacons, this.obj.finale] : this.obj.beacons;
    for (const b of list) {
      if (b.lit) continue;
      const d = Math.hypot(p.x - b.pos.x, p.z - b.pos.z);
      const inside = d < 3.4 && Math.abs(p.y - b.pos.y) < 3.5;
      if (inside) {
        const before = b.progress;
        b.progress = Math.min(1, b.progress + dt / 1.15);
        kindling = true;
        if (Math.floor(before * 8) !== Math.floor(b.progress * 8)) this.audio.kindleTick(b.progress);
        if (Math.random() < 0.6) this.glow.emit({ pos: b.pos.clone().add(new THREE.Vector3(0, 2.9, 0)), vel: new THREE.Vector3(0, 2, 0), spread: 1.5, life: 0.8, size: 0.14, color: 0xffb347, gravity: -1 });
        if (b.progress >= 1) this.lightBeacon(b);
      } else {
        b.progress = Math.max(0, b.progress - dt * 1.2);
      }
    }
    this.ui.setKindle(kindling);

    // ---- glimmers
    for (let i = 0; i < this.obj.glimmers.length; i++) {
      const g = this.obj.glimmers[i];
      if (g.taken || (i === RUINS_SECRET && !this.secretRevealed)) continue;
      if (g.pos.distanceTo(p) < 2.1) this.takeGlimmer(i);
    }

    // ---- notes
    let near = -1;
    for (const n of this.structures.notePosts) {
      const d = Math.hypot(p.x - n.x, p.z - n.z);
      if (d < 3.6) near = n.idx;
    }
    this.nearNote = near;
    this.ui.setPrompt(near >= 0 ? (this.notesRead[near] ? 'Read again' : "Read the keeper's note") : null);

    // ---- mushrooms
    this.mushroomCooldown -= dt;
    for (const m of this.structures.mushrooms) {
      const d = Math.hypot(p.x - m.x, p.z - m.z);
      const vy = v.chassis.linvel().y;
      if (d < m.r + 0.4 && p.y > m.top - 0.9 && p.y < m.top + 1.6 && vy < 3 && this.mushroomCooldown <= 0) {
        const lv = v.chassis.linvel();
        v.chassis.setLinvel({ x: lv.x * 1.05, y: 18, z: lv.z * 1.05 }, true);
        v.chassis.applyTorqueImpulse({ x: (Math.random() - 0.5) * 6, y: 0, z: (Math.random() - 0.5) * 6 }, true);
        m.squash = 1;
        this.mushroomCooldown = 0.45;
        this.audio.boing();
        this.rig.addShake(0.3);
        this.soft.emit({ pos: new THREE.Vector3(m.x, m.top, m.z), vel: new THREE.Vector3(0, 2, 0), spread: 6, count: 26, life: 1.2, size: 0.25, sizeEnd: 0.1, color: 0xfff4e6, color2: 0xffc2d6, gravity: 3, drag: 1.5 });
      }
    }

    // ---- fell off the island?
    if (p.y < -14 && !this.respawning) this.respawn(true);
    this.props.recover();

    // ---- landing
    if (v.landImpact > 0) {
      const k = v.landImpact;
      v.landImpact = 0;
      this.audio.thud(k);
      this.rig.addShake(k * 0.35);
      this.rig.kick(new THREE.Vector3(0, -1, 0), k * 4);
      for (const w of v.wheelStates) if (w.contact) this.dust(w.point, 6 * k, 1.4);
    }
    if (v.justJumped) { this.audio.jump(); for (const w of v.wheelStates) if (w.contact) this.dust(w.point, 4, 1.0); }

    // ---- water entry
    if (v.inWater > 0 && this.wasInWater === 0) {
      const vy = Math.abs(Math.min(0, v.chassis.linvel().y));
      const k = clamp(0.4 + vy * 0.08 + Math.abs(v.speed) * 0.03, 0, 1.5);
      this.audio.splash(k);
      this.splash(p, k);
      this.water.ripple(p.x, p.z, 1.6);
    }
    this.wasInWater = v.inWater;

    this.updateHud();
  }

  private lightBeacon(b: Beacon) {
    b.lit = true;
    b.litAt = this.time;
    b.progress = 1;
    const isFinale = b === this.obj.finale;
    this.checkpoint = { x: b.pos.x, z: b.pos.z + 5, yaw: Math.PI };
    const top = b.pos.clone().add(new THREE.Vector3(0, 3.0, 0));
    this.glow.emit({ pos: top, vel: new THREE.Vector3(0, 9, 0), spread: 9, count: 140, life: 1.8, size: 0.22, sizeEnd: 0.05, color: 0xffd27a, color2: 0xff7a3a, gravity: 6, drag: 1.2 });
    this.glow.emit({ pos: top, vel: new THREE.Vector3(0, 3, 0), spread: 3, count: 40, life: 3, size: 0.12, color: 0xffb347, gravity: -1.5, drag: 0.5 });
    this.soft.emit({ pos: b.pos.clone().add(new THREE.Vector3(0, 0.4, 0)), spread: 10, vel: new THREE.Vector3(0, 1, 0), count: 30, life: 1.2, size: 0.8, sizeEnd: 2.4, color: 0xe9d6b8, alpha: 0.5, drag: 3 });
    this.shock.position.set(b.pos.x, b.pos.y + 0.25, b.pos.z);
    this.shock.userData.t = 0;
    this.rig.addShake(0.6);
    this.rig.kick(new THREE.Vector3(0, 1, 0), 3);
    this.audio.ignite(this.obj.litCount);
    this.audio.intensity = this.obj.litCount / 5;
    for (const l of this.structures.lamps) if (Math.hypot(l.x - b.pos.x, l.z - b.pos.z) < 48) l.target = 1;

    if (isFinale) {
      this.startFinale();
      return;
    }
    const n = this.obj.litCount;
    this.todTarget = (n / 5) * 0.9;
    const place = b.def.name.replace(' Beacon', '');
    const lines = ['burns again', 'is awake', 'remembers the light', 'is glowing', 'answers'];
    this.ui.banner(`Beacon ${n} of 5`, `The ${place} ${lines[(n - 1) % lines.length]}`);
    if (n === 5) {
      this.obj.finale.ring.visible = true;
      this.obj.finale.marker.visible = true;
      setTimeout(() => this.ui.banner('All five are burning', 'Now, the lighthouse', 4200), 3900);
    }
  }

  private startFinale() {
    this.state = 'finale';
    this.ui.setKindle(false);
    this.ui.setPrompt(null);
    this.finished = true;
    this.finaleT = 0;
    this.vehicle.enabled = false;
    this.todTarget = 1;
    this.audio.finale();
    this.ui.banner('the lighthouse answers', 'Last Light', 5200);
    this.structures.lighthouseBeam.visible = true;
    this.rig.startCinematic(this.structures.lighthouseTop.clone().add(new THREE.Vector3(0, -6, 0)), 34, 14, 0.22);
    for (const l of this.structures.lamps) l.target = 1;
  }

  private updateFinale(dt: number) {
    this.finaleT += dt;
    const t = this.finaleT;
    const lamp = this.structures.lighthouseLamp.material as THREE.MeshStandardMaterial;
    lamp.emissiveIntensity = Math.min(9, t * 3);
    const beamMat = (this.structures.lighthouseBeam.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;
    beamMat.uniforms.uOpacity.value = Math.min(0.55, t * 0.3);
    // fireworks of embers over the isle
    if (t < 9 && Math.random() < dt * 3) {
      const a = Math.random() * Math.PI * 2, r = 10 + Math.random() * 40;
      const pos = new THREE.Vector3(Math.cos(a) * r, 26 + Math.random() * 14, -8 + Math.sin(a) * r);
      const cols = [[0xffd27a, 0xff7a3a], [0xffc2d6, 0xff6a8a], [0xbfe8ff, 0x8fb0ff], [0xfff4c0, 0xffd27a]][Math.floor(Math.random() * 4)];
      this.glow.emit({ pos, spread: 16, count: 90, life: 1.6, size: 0.35, sizeEnd: 0.05, color: cols[0], color2: cols[1], gravity: 4, drag: 1.4 });
      this.audio.noise({ dur: 0.5, vol: 0.12, freq: 900, sweep: 200 });
    }
    if (t > 8.5 && this.state === 'finale') {
      this.state = 'end';
      this.ui.showEnd(this.playTime, `${this.glimmerCount}/${GLIMMERS.length}`, `${this.notesRead.filter(Boolean).length}/${NOTES.length}`);
    }
  }

  private takeGlimmer(i: number) {
    const g = this.obj.glimmers[i];
    g.taken = true; g.t = 0;
    this.glimmerCount++;
    this.combo = this.time - this.lastGlimmerAt < 3.5 ? this.combo + 1 : 0;
    this.lastGlimmerAt = this.time;
    this.audio.glimmer(this.combo);
    this.glow.emit({ pos: g.pos, spread: 7, count: 36, life: 0.9, size: 0.3, sizeEnd: 0.02, color: 0xffe9a0, color2: 0xffb347, gravity: 2, drag: 2, shape: 2 });
    this.ui.setGlimmers(this.glimmerCount, GLIMMERS.length, true);
    if (this.glimmerCount === GLIMMERS.length) this.ui.toast('Every glimmer on the isle — you found them all ✦', 4000);
    else if (this.glimmerCount % 5 === 0) this.ui.toast(`${this.glimmerCount} glimmers found`);
  }

  private hideSecretGlimmer() {
    if (RUINS_SECRET >= 0) this.obj.glimmers[RUINS_SECRET].pos.y -= 100;
  }
  private revealSecret() {
    if (this.secretRevealed || RUINS_SECRET < 0) return;
    this.secretRevealed = true;
    const g = this.obj.glimmers[RUINS_SECRET];
    g.pos.y += 100;
    this.ui.toast('The stones remember you.', 3500);
    this.glow.emit({ pos: g.pos, spread: 4, count: 60, life: 1.5, size: 0.25, color: 0xfff4c0, color2: 0xc9a2ff, gravity: -1, shape: 2 });
    this.audio.glimmer(5);
  }

  /** Debug helper (also handy from the console): teleport Wick. */
  teleport(x: number, z: number, yaw = Math.PI) {
    this.vehicle.respawn(x, groundHeight(x, z) + 1.5, z, yaw);
  }

  respawn(fell = false) {
    if (this.respawning) return;
    this.respawning = true;
    if (fell) this.audio.fail();
    this.ui.fade(true);
    setTimeout(() => {
      const c = this.checkpoint;
      this.vehicle.respawn(c.x, groundHeight(c.x, c.z) + 1.4, c.z, c.yaw);
      this.rig.camera.position.set(c.x, groundHeight(c.x, c.z) + 14, c.z + 14);
      this.audio.respawn();
      this.ui.fade(false);
      this.soft.emit({ pos: new THREE.Vector3(c.x, groundHeight(c.x, c.z) + 0.5, c.z), spread: 6, count: 30, life: 1, size: 0.6, sizeEnd: 1.8, color: 0xfff1d8, alpha: 0.6, drag: 3 });
      this.respawning = false;
    }, fell ? 650 : 350);
  }

  restart() {
    for (const b of [...this.obj.beacons, this.obj.finale]) { b.lit = false; b.progress = 0; b.litAt = -1; }
    this.obj.finale.ring.visible = false; this.obj.finale.marker.visible = false;
    for (const g of this.obj.glimmers) { g.taken = false; g.t = 0; }
    if (this.secretRevealed) { this.secretRevealed = false; this.hideSecretGlimmer(); }
    for (const l of this.physics.links) if (l.kind !== 'bell') this.physics.resetLink(l);
    for (const l of this.structures.lamps) l.target = 0;
    this.structures.lighthouseBeam.visible = false;
    (this.structures.lighthouseLamp.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.05;
    this.glimmerCount = 0; this.playTime = 0; this.finished = false;
    this.notesRead = NOTES.map(() => false);
    this.todTarget = 0;
    this.audio.intensity = 0;
    this.checkpoint = { x: SPAWN.x, z: SPAWN.z, yaw: SPAWN.yaw };
    this.respawn();
    this.ui.setGlimmers(0, GLIMMERS.length);
    this.ui.toast('A new evening begins');
  }

  private applyTimeOfDay() {
    this.atmo.setTime(this.tod);
    this.water.setColors(this.atmo.current.horizon, this.atmo.current.sun, uniforms.uNight.value);
  }

  // -------------------------------------------------------------- impacts
  private onImpact(a: RAPIER.Collider, b: RAPIER.Collider, force: number, point: THREE.Vector3) {
    const ka = this.physics.kindOf(a), kb = this.physics.kindOf(b);
    const key = a.handle < b.handle ? `${a.handle}-${b.handle}` : `${b.handle}-${a.handle}`;
    const lastT = this.impactCooldown.get(key) ?? -1;
    if (this.time - lastT < 0.18) return;
    this.impactCooldown.set(key, this.time);
    if (this.impactCooldown.size > 400) this.impactCooldown.clear();

    const car = ka === 'car' || kb === 'car';
    const other = ka === 'car' ? kb : ka;
    const otherCol = ka === 'car' ? b : a;
    const strength = clamp(force / (car ? 2600 : 700), 0, 1.4);

    if (ka === 'bell' || kb === 'bell') {
      if (this.bellCooldown < this.time - 0.35 && strength > 0.06) {
        this.bellCooldown = this.time;
        this.audio.bell(Math.min(1, 0.3 + strength));
        this.rig.addShake(0.15);
        this.bellRings = this.bellRings.filter((t) => this.time - t < 6);
        this.bellRings.push(this.time);
        if (this.bellRings.length >= 2) this.revealSecret();
        this.glow.emit({ pos: this.structures.bellPos.clone().add(new THREE.Vector3(0, -1, 0)), spread: 4, count: 16, life: 1, size: 0.12, color: 0xfff1c0, gravity: -1, shape: 2 });
      }
      return;
    }
    if (strength < 0.04) return;
    const soundKind = (k: string) => k === 'stone' || k === 'building' || k === 'rock' || k === 'beacon' ? 'stone'
      : k === 'lamp' || k === 'rope' ? 'metal' : k === 'hay' || k === 'pumpkin' || k === 'ball' || k === 'mushroom' ? 'soft' : 'wood';
    if (car) {
      this.audio.impact(strength, soundKind(other));
      this.rig.addShake(Math.min(0.7, strength * 0.6));
      if (strength > 0.25) {
        this.glow.emit({ pos: point.clone().setY(this.vehicle.position.y + 0.3), spread: 6, count: Math.floor(10 * strength), life: 0.45, size: 0.09, color: 0xffe0a0, gravity: 12 });
      }
      if (other === 'tree') {
        const t = this.foliage.trunkColliders.get(otherCol.handle);
        if (t) {
          uniforms.uShake.value.set(t.x, t.z, Math.min(1.5, 0.4 + strength * 1.5), this.time);
          for (let i = 0; i < 8 + strength * 20; i++) {
            this.soft.emit({ pos: new THREE.Vector3(t.x, groundHeight(t.x, t.z) + t.h + 0.5, t.z), posSpread: 3, vel: new THREE.Vector3(0.8, -0.5, 0.3), spread: 2.5, life: 3, size: 0.32, color: LEAF_COLORS[i % 4], gravity: 1.2, drag: 1.8, shape: 1 });
          }
        }
      }
      if (other === 'ball') this.audio.boing();
    } else {
      this.audio.impact(strength * 0.6, soundKind(ka === 'ground' ? kb : ka));
      if (strength > 0.3) this.dust(point, 3, 0.8);
    }
  }

  // --------------------------------------------------------------- effects
  private dust(at: THREE.Vector3, count: number, size = 1) {
    const c = groundColor(at.x, at.z, at.y, 1, new THREE.Color()).lerp(new THREE.Color(0xfff1dc), 0.45);
    this.soft.emit({ pos: at, vel: new THREE.Vector3(0, 1.2, 0), spread: 3.5, posSpread: 0.6, count: Math.ceil(count), life: 0.9, size: 0.5 * size, sizeEnd: 1.6 * size, color: c, alpha: 0.55, drag: 2.5, gravity: -0.4 });
  }
  private splash(p: THREE.Vector3, k: number) {
    const at = new THREE.Vector3(p.x, WATER_LEVEL + 0.1, p.z);
    this.soft.emit({ pos: at, vel: new THREE.Vector3(0, 6 * k, 0), spread: 7 * k, posSpread: 1.4, count: Math.floor(50 * k), life: 0.9, size: 0.3, sizeEnd: 0.15, color: 0xeafffb, color2: 0x9fe7dd, gravity: 16, drag: 0.6 });
    this.soft.emit({ pos: at, spread: 3, posSpread: 2, count: 12, life: 1.2, size: 1.2, sizeEnd: 2.6, color: 0xffffff, alpha: 0.35, drag: 2 });
  }

  private animateWorld(dt: number) {
    const v = this.vehicle;
    const t = this.time;
    // windmill & windsock
    this.structures.windmillBlades.rotateZ(dt * 0.55);
    const sock = this.structures.group.getObjectByName('windsock');
    if (sock) { sock.rotation.y = 0.6 + Math.sin(t * 0.4) * 0.3; sock.rotation.x = 0.25 + Math.sin(t * 3.1) * 0.06; }
    // lighthouse beam rotation
    if (this.structures.lighthouseBeam.visible) this.structures.lighthouseBeam.rotation.y += dt * 0.9;
    // mushrooms squash recovery
    for (const m of this.structures.mushrooms) {
      m.squash = Math.max(0, m.squash - dt * 3);
      const s = m.squash;
      const wob = Math.sin((1 - s) * 18) * s;
      m.cap.scale.set(1 + wob * 0.25, 1 - wob * 0.35, 1 + wob * 0.25).multiplyScalar(m.cap.userData.base as number);
    }
    // note markers
    for (const n of this.structures.notePosts) {
      const read = this.notesRead[n.idx];
      const target = read ? 0.0 : 1;
      const s = n.icon.scale.x + (target - n.icon.scale.x) * Math.min(1, dt * 5);
      n.icon.scale.setScalar(Math.max(0.0001, s));
      n.icon.position.y = n.y + 2.4 + Math.sin(t * 2 + n.idx) * 0.12;
      n.icon.rotation.y += dt * 1.5;
    }
    // shockwave ring
    if (this.shock.userData.t !== undefined && this.shock.userData.t < 1.2) {
      this.shock.userData.t += dt;
      const k = this.shock.userData.t / 1.2;
      this.shock.scale.setScalar(1 + k * 22);
      (this.shock.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.9;
    } else (this.shock.material as THREE.MeshBasicMaterial).opacity = 0;

    this.structures.updateBridge(dt, t, v.position);
    this.structures.updateLights(dt, uniforms.uNight.value);
    this.water.update(dt, t);
    this.obj.update(dt, t, this.rig.camera);

    // ambient emitters
    const e = this.emitTimers;
    e.smoke -= dt;
    if (e.smoke <= 0) {
      e.smoke = 0.35;
      for (const sp of this.structures.smokePoints) this.soft.emit({ pos: sp, vel: new THREE.Vector3(0.4, 1.3, 0.1), spread: 0.3, life: 4.5, size: 0.5, sizeEnd: 2.6, color: 0xd9cde0, alpha: 0.45, drag: 0.3 });
    }
    e.fire -= dt;
    if (e.fire <= 0) {
      e.fire = 0.08;
      this.glow.emit({ pos: this.structures.campfire, vel: new THREE.Vector3(0, 1.8, 0), spread: 0.6, posSpread: 0.4, life: 1.2, size: 0.12, color: 0xffb347, color2: 0xff6a3a, gravity: -0.5 });
      if (Math.random() < 0.5) this.glow.emit({ pos: this.structures.campfire, vel: new THREE.Vector3(0, 0.6, 0), spread: 0.2, life: 0.5, size: 0.9, sizeEnd: 0.3, color: 0xff9a40, alpha: 0.5 });
      for (const b of [...this.obj.beacons, this.obj.finale]) {
        if (!b.lit || Math.random() > 0.6) continue;
        const pos = b === this.obj.finale ? this.structures.lighthouseTop : b.pos.clone().add(new THREE.Vector3(0, 3.6, 0));
        this.glow.emit({ pos, vel: new THREE.Vector3(0, 2.4, 0), spread: 0.9, posSpread: 0.5, life: 1.6, size: 0.1, color: 0xffd27a, color2: 0xff7a3a, gravity: -0.6 });
      }
    }
    e.mist -= dt;
    if (e.mist <= 0) {
      e.mist = 0.12;
      const lip = new THREE.Vector3(FALLS.x + FALLS.dirX * 2.5, WATER_LEVEL - 1, FALLS.z + FALLS.dirZ * 2.5);
      this.soft.emit({ pos: lip, vel: new THREE.Vector3(FALLS.dirX * 1.5, -1.5, FALLS.dirZ * 1.5), spread: 1.2, posSpread: 3, life: 2.2, size: 1.0, sizeEnd: 3.2, color: 0xffffff, alpha: 0.28, drag: 0.6 });
      const bottom = new THREE.Vector3(FALLS.x + FALLS.dirX * 14, -33, FALLS.z + FALLS.dirZ * 14);
      this.soft.emit({ pos: bottom, vel: new THREE.Vector3(0, 2.5, 0), spread: 2.5, posSpread: 6, life: 3, size: 4, sizeEnd: 9, color: 0xffffff, alpha: 0.3, drag: 0.4 });
    }
    // falling leaves near the player
    e.leaves -= dt;
    if (e.leaves <= 0) {
      e.leaves = 0.12;
      for (const tr of this.foliage.treeSpots) {
        if (tr.kind === 'pine') continue;
        const dx = tr.x - v.position.x, dz = tr.z - v.position.z;
        if (dx * dx + dz * dz > 900 || Math.random() > 0.08) continue;
        this.soft.emit({ pos: new THREE.Vector3(tr.x, groundHeight(tr.x, tr.z) + 3.2 * tr.s, tr.z), posSpread: 3, vel: new THREE.Vector3(0.7, -0.6, 0.3), spread: 0.6, life: 4.5, size: 0.28, color: LEAF_COLORS[Math.floor(Math.random() * 4)], gravity: 0.25, drag: 1.2, shape: 1 });
      }
    }

    // ---- vehicle-driven effects
    if (this.state === 'play' || this.state === 'intro') {
      const speed = Math.abs(v.speed);
      for (let i = 0; i < 4; i++) {
        const w = v.wheelStates[i];
        if (!w.contact) continue;
        const onWater = this.water.depthAt(w.point.x, w.point.z, w.point.y) > -0.2 && w.point.y < WATER_LEVEL + 0.2;
        if (onWater) {
          if (speed > 2 && Math.random() < 0.5) this.soft.emit({ pos: w.point.clone().setY(WATER_LEVEL + 0.1), vel: new THREE.Vector3(0, 3, 0), spread: 3, life: 0.6, size: 0.25, color: 0xeafffb, gravity: 14 });
          continue;
        }
        if (i >= 2) {
          const k = i - 2;
          const d = w.point.distanceTo(this.lastWheelPos[k]);
          if (d > 0.42) {
            if (d < 3) {
              const n = groundNormal(w.point.x, w.point.z);
              const f = v.forward();
              this.tracks.add(w.point, n, Math.atan2(f.x, f.z), clamp(0.45 + w.skid * 0.12, 0, 1), t);
            }
            this.lastWheelPos[k].copy(w.point);
          }
          if ((w.skid > 4.5 && speed > 4) || (speed > 14 && Math.random() < 0.25) || (v.throttle !== 0 && speed < 4 && Math.random() < 0.15)) {
            this.dust(w.point, 1, 0.6 + Math.min(1, w.skid * 0.08));
          }
        }
      }
      if (v.boosting) {
        const f = v.forward();
        const ex = v.position.clone().addScaledVector(f, -1.5).add(new THREE.Vector3(0, 0.1, 0));
        this.glow.emit({ pos: ex, vel: f.clone().multiplyScalar(-4).add(new THREE.Vector3(0, 0.8, 0)), spread: 0.8, count: 2, life: 0.35, size: 0.3, sizeEnd: 0.05, color: 0xffd27a, color2: 0xff6a3a, drag: 2 });
      }
      if (v.inWater > 0 && speed > 1.5) {
        e.wake -= dt;
        if (e.wake <= 0) { e.wake = 0.22; this.water.ripple(v.position.x, v.position.z, 0.9); }
      }
      // ambient fields follow the car
      const mu = (this.motes.material as THREE.ShaderMaterial).uniforms;
      mu.uCenter.value.copy(v.position); mu.uGround.value = v.position.y;
      const fu = (this.fireflies.material as THREE.ShaderMaterial).uniforms;
      fu.uCenter.value.copy(v.position); fu.uGround.value = v.position.y - 0.6;
    }

    this.soft.update(dt);
    this.glow.update(dt);

    // audio
    const fallsD = Math.hypot(v.position.x - FALLS.x, v.position.z - FALLS.z);
    const pondD = Math.hypot(v.position.x + 36, v.position.z - 8);
    this.audio.night = uniforms.uNight.value;
    this.audio.update({
      speed: v.speed, throttle: v.enabled ? v.throttle : 0, boost: v.boosting, grounded: v.grounded > 0, slip: v.slip,
      waterNear: Math.max(1 - smoothstep(6, 40, fallsD), (1 - smoothstep(10, 30, pondD)) * 0.35), height: v.position.y, inWater: v.inWater,
    });
  }

  // ------------------------------------------------------------------ HUD
  private updateHud() {
    const lit = this.obj.beacons.map((b) => b.lit);
    const n = this.obj.litCount;
    const target = this.obj.nearestUnlit(this.vehicle.position);
    let title = `Relight the beacons · ${n}/5`;
    let hint = '';
    if (n === 5 && !this.obj.finale.lit) title = 'Light the lighthouse';
    if (this.obj.finale.lit) title = 'The isle is safe · explore freely';
    if (target) {
      const d = Math.round(target.pos.distanceTo(this.vehicle.position));
      hint = target === this.obj.finale ? `drive into the ring at its door — ${d} m` : `${target.def.name} — ${d} m · ${target.def.hint}`;
    } else hint = `${this.glimmerCount}/${GLIMMERS.length} glimmers · ${this.notesRead.filter(Boolean).length}/${NOTES.length} notes`;
    this.ui.setBeacons(lit, this.obj.finale.lit, title, hint);
    this.ui.setGlimmers(this.glimmerCount, GLIMMERS.length);
    this.ui.setTimer(this.playTime);
    if (performance.now() - this.ui.controlsShownAt > 14000 && this.ui.controlsShownAt > 0) {
      this.ui.toggleControls(false);
      this.ui.controlsShownAt = -1;
    }

    // off-screen pointer to the current target
    if (target && this.state === 'play') {
      const cam = this.rig.camera;
      const p = target.pos.clone().add(new THREE.Vector3(0, 2, 0)).project(cam);
      const behind = p.z > 1;
      const w = window.innerWidth, h = window.innerHeight;
      const onScreen = !behind && Math.abs(p.x) < 0.92 && Math.abs(p.y) < 0.88;
      const dist = target.pos.distanceTo(this.vehicle.position);
      if (onScreen || dist < 12) this.ui.pointer(null);
      else {
        let x = p.x, y = p.y;
        if (behind) { x = -x; y = -y; }
        const ang = Math.atan2(y, x);
        const ex = Math.cos(ang), ey = Math.sin(ang);
        const s = Math.min(0.86 / Math.abs(ex || 1e-6), 0.8 / Math.abs(ey || 1e-6));
        const sx = (ex * s * 0.5 + 0.5) * w, sy = (-ey * s * 0.5 + 0.5) * h;
        this.ui.pointer({ x: sx, y: sy, angle: -ang + Math.PI / 2 }, dist);
      }
    } else this.ui.pointer(null);
    void PLAZA; void BEACONS; void RUINS;
  }
}

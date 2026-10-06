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
import { BEACONS, BRIDGES, FALLS, GEYSERS, GLIMMERS, NOTES, OBSERVATORY, ORIEL, SPAWN, WATER_LEVEL, GRAVITY, type GeyserDef } from '../world/layout';
import { isInsideIsland } from '../world/terrain';
import { Dialogue, LINES } from './story';
import { Oriel } from './oriel';
import { Vehicle } from './vehicle';
import { Props } from './props';
import { Objectives, type Beacon } from './objectives';
import { ParticleSystem, makeAmbientField } from '../fx/particles';
import { Tracks } from '../fx/tracks';
import { AudioEngine } from '../audio/audio';
import { UI } from '../ui/ui';
import { clamp, smoothstep } from '../utils/math';

type State = 'loading' | 'intro' | 'play' | 'paused' | 'note' | 'map' | 'finale' | 'end';
type Chapter = 'beacons' | 'lighthouse' | 'oriel' | 'done';
type Sky = 'story' | 'golden' | 'dusk' | 'night';
const SKY_TOD: Record<Exclude<Sky, 'story'>, number> = { golden: 0, dusk: 0.62, night: 1 };
const NB = BEACONS.length;
const ARC_GLIMMERS = GLIMMERS.map((g, i) => (g[0] === 95 || g[0] === 105 ? i : -1)).filter((i) => i >= 0);

/** Position along a geyser's ballistic arc at fraction s of the flight. */
function geyserArc(g: GeyserDef, s: number, out = new THREE.Vector3()) {
  const y0 = groundHeight(g.x, g.z) + 1.1, y1 = groundHeight(g.tx, g.tz) + 1.1;
  const T = g.flight, t = s * T;
  const vy = (y1 - y0) / T - 0.5 * GRAVITY * T;
  return out.set(g.x + (g.tx - g.x) * s, y0 + vy * t + 0.5 * GRAVITY * t * t, g.z + (g.tz - g.z) * s);
}
// rAF, but never stall if the tab is in the background while loading
const nextFrame = () => new Promise((r) => { requestAnimationFrame(() => r(null)); setTimeout(() => r(null), 60); });
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
  dialogue!: Dialogue;
  oriel!: Oriel;
  chapter: Chapter = 'beacons';
  sky: Sky = 'story';
  finaleKind: 'lighthouse' | 'meet' | 'rise' = 'lighthouse';
  safeSpot = { x: SPAWN.x, z: SPAWN.z, yaw: SPAWN.yaw };
  safeTimer = 0;
  falling = false;
  fallT = 0;
  geyserCooldown = 0;
  lastProgressAt = 0;

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
  emitTimers = { smoke: 0, fire: 0, mist: 0, wake: 0, embers: 0, leaves: 0, geyser: 0 };
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
    this.vehicle.setEnvironment(this.makeEnvironment());
    this.oriel = new Oriel(ORIEL.x, ORIEL.z);
    this.scene.add(this.oriel.root);
    this.dialogue = new Dialogue();
    this.dialogue.onBlip = (who) => this.audio.blip(who);
    // glimmers that hang in the geyser's flight path
    ARC_GLIMMERS.forEach((gi, k) => geyserArc(GEYSERS[0], 0.36 + k * 0.28, this.obj.glimmers[gi].pos));

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
      for (const br of BRIDGES) {
        const ba = br.angle + Math.PI / 2;
        this.rig.hints.push({ x: (br.a.x + br.b.x) / 2, z: (br.a.z + br.b.z) / 2, r: 22, yaw: Math.atan2(Math.cos(ba), Math.sin(ba)), pitch: 0.5, dist: 1.2 });
      }
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
        this.lastProgressAt = this.time;
        this.dialogue.say(LINES.intro, 'intro');
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
    document.querySelectorAll<HTMLButtonElement>('#seg-sky button').forEach((b) => b.addEventListener('click', () => {
      this.setSky(b.dataset.sky as Sky); this.audio.click();
    }));
    this.syncSoundUI();
    this.ui.setQualityButtons(this.quality);
    this.ui.setSkyButtons(this.sky);
    this.startGame = start;
  }

  private onKey(code: string) {
    if (code === 'Enter' && (this.state === 'finale' || this.nearNote < 0)) this.dialogue.skip();
    if (this.state === 'note') {
      if (code === 'KeyE' || code === 'Escape' || code === 'Enter' || code === 'Space') this.closeNote();
      return;
    }
    if (this.state === 'map') { if (code === 'KeyM' || code === 'Escape') this.toggleMap(); return; }
    if (this.state === 'paused') { if (code === 'Escape' || code === 'KeyP') this.togglePause(); return; }
    if (this.state === 'end') return;
    if (code === 'Escape' || code === 'KeyP') this.togglePause();
    else if (code === 'KeyM') this.toggleMap();
    else if (code === 'KeyR' && this.state === 'play') this.resetCar();
    else if (code === 'KeyT') { const order: Sky[] = ['story', 'golden', 'dusk', 'night']; this.setSky(order[(order.indexOf(this.sky) + 1) % 4], true); }
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
      this.ui.drawMap(this.vehicle.position, Math.atan2(f.x, f.z), this.obj.beacons.map((b) => b.lit), this.obj.litCount === NB, this.obj.finale.lit, this.notesRead, this.chapter === 'oriel' || this.chapter === 'done');
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

  setSky(sky: Sky, announce = false) {
    this.sky = sky;
    this.ui.setSkyButtons(sky);
    if (announce) this.ui.toast(sky === 'story' ? 'Sky follows the story' : `Sky: ${sky}`);
  }
  private skyTarget() { return this.sky === 'story' ? this.todTarget : SKY_TOD[this.sky]; }

  /** A tiny gradient environment so Wick's clear-coat has something to reflect. */
  private makeEnvironment() {
    const pm = new THREE.PMREMGenerator(this.renderer.renderer);
    const s = new THREE.Scene();
    s.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `varying vec3 vP; void main(){ float y = normalize(vP).y;
        vec3 top = vec3(0.32, 0.42, 0.8), hor = vec3(1.0, 0.62, 0.42), bot = vec3(0.22, 0.2, 0.28);
        vec3 c = y > 0.0 ? mix(hor, top, pow(y, 0.6)) : mix(hor * 0.6, bot, pow(-y, 0.5));
        c += vec3(1.0, 0.8, 0.5) * pow(max(dot(normalize(vP), normalize(vec3(-0.8, 0.35, 0.45))), 0.0), 40.0) * 3.0;
        gl_FragColor = vec4(c, 1.0); }`,
    })));
    const tex = pm.fromScene(s, 0.02).texture;
    pm.dispose();
    return tex;
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
    this.dialogue.update(dt);

    // time of day eases towards the story progress (or the player's chosen sky)
    const target = this.skyTarget();
    this.tod += (target - this.tod) * Math.min(1, dt * (this.sky === 'story' ? 0.45 : 1.6));
    if (Math.abs(target - this.tod) > 0.0005) this.applyTimeOfDay();

    if (this.state === 'finale') this.updateFinale(dt);
    if (this.oriel.root.visible) this.oriel.update(dt, p, uniforms.uNight.value);
    if (this.state !== 'play') return;

    if (this.falling) { this.updateFall(dt); this.updateHud(); return; }

    // ---- beacons (+ the lighthouse ring once all six burn)
    let kindling = false;
    const list: Beacon[] = this.chapter === 'lighthouse' ? [this.obj.finale] : this.chapter === 'beacons' ? this.obj.beacons : [];
    for (const b of list) {
      if (b.lit) continue;
      const d = Math.hypot(p.x - b.pos.x, p.z - b.pos.z);
      const inside = d < 3.4 && Math.abs(p.y - b.pos.y) < 3.5;
      if (inside) {
        const before = b.progress;
        b.progress = Math.min(1, b.progress + dt / 1.15);
        kindling = true;
        this.dialogue.say(LINES.kindleFirst, 'kindle');
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
      if (g.pos.distanceTo(p) < 2.3) this.takeGlimmer(i);
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

    // ---- wind geysers
    this.geyserCooldown -= dt;
    for (const g of GEYSERS) {
      const d = Math.hypot(p.x - g.x, p.z - g.z);
      if (d < 16) this.dialogue.say(LINES.geyserFirst, 'geyser');
      if (d < 2.5 && p.y < groundHeight(g.x, g.z) + 2.6 && this.geyserCooldown <= 0 && v.launched <= 0) this.launch(g);
    }
    this.rig.flight = v.launched;

    // ---- story triggers
    if (this.structures.bridges.some((b) => b.project(p) >= 0)) this.dialogue.say(LINES.bridgeFirst, 'bridge');
    const dObs = Math.hypot(p.x - OBSERVATORY.x, p.z - OBSERVATORY.z);
    if (this.chapter === 'beacons' && dObs < 16) this.dialogue.say(LINES.observatoryEarly, 'obs-early');
    if (this.chapter === 'oriel' && Math.hypot(p.x - ORIEL.x, p.z - ORIEL.z) < 6) this.startMeet();
    if (v.stuckTime > 2.5) this.dialogue.say(LINES.stuck, 'stuck');
    if (v.unstuck) {
      v.unstuck = false;
      this.audio.respawn();
      this.soft.emit({ pos: p.clone(), spread: 5, count: 20, life: 0.8, size: 0.6, sizeEnd: 1.5, color: 0xfff1d8, alpha: 0.6, drag: 3 });
    }
    if (this.chapter === 'beacons' && this.time - this.lastProgressAt > 80 && !this.dialogue.busy) this.dialogue.say(LINES.idle, 'idle');
    if (v.balloonPopped) {
      v.balloonPopped = false;
      this.audio.pop();
      this.glow.emit({ pos: p.clone().add(new THREE.Vector3(0, 3.6, 0)), spread: 8, count: 40, life: 1.2, size: 0.2, color: 0xffe0a0, color2: 0xe8634e, gravity: 6, shape: 2 });
      this.soft.emit({ pos: p.clone().add(new THREE.Vector3(0, 3.6, 0)), spread: 6, count: 30, life: 2, size: 0.25, color: 0xe8634e, color2: 0xfff1d8, gravity: 4, drag: 1.5, shape: 1 });
      this.dialogue.say(LINES.rescued, 'rescued');
    }

    // ---- remember the last safe spot (for rescues)
    this.safeTimer -= dt;
    if (this.safeTimer <= 0) {
      this.safeTimer = 0.5;
      if (v.grounded === 4 && v.inWater === 0 && v.launched <= 0 && isInsideIsland(p.x, p.z, 5) && !GEYSERS.some((g) => Math.hypot(p.x - g.x, p.z - g.z) < 7) && !this.structures.bridges.some((b) => b.project(p) >= 0)) {
        const f = v.forward();
        this.safeSpot = { x: p.x, z: p.z, yaw: Math.atan2(f.x, f.z) };
      }
    }

    // ---- fell off the world?
    if (p.y < -8 && v.launched <= 0 && !v.balloonActive && !this.respawning) this.startFall();
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
    if (v.boostKick > 0.55) { this.audio.boost(); this.rig.kick(v.forward().multiplyScalar(-1), 2.5); this.rig.addShake(0.15); }

    // ---- water entry
    if (v.inWater > 0 && this.wasInWater === 0) {
      const vy = Math.abs(Math.min(0, v.chassis.linvel().y));
      const k = clamp(0.4 + vy * 0.08 + Math.abs(v.speed) * 0.03, 0, 1.5);
      this.audio.splash(k);
      this.splash(p, k);
      this.water.ripple(p.x, p.z, 1.6);
    }
    this.wasInWater = v.inWater;

    this.ui.setSpeedLines((v.boosting && Math.abs(v.speed) > 25) || v.launched > 0.3);
    this.updateHud();
  }

  // ---------------------------------------------------------- geysers
  private launch(g: GeyserDef) {
    const v = this.vehicle;
    const c = v.chassis;
    const t = c.translation();
    const y1 = groundHeight(g.tx, g.tz) + 1.1;
    const T = g.flight;
    const vx = ((g.tx - t.x) / T) * 1.035, vz = ((g.tz - t.z) / T) * 1.035;
    const vy = (y1 - t.y) / T - 0.5 * GRAVITY * T;
    const yaw = Math.atan2(vx, vz);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    c.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    c.setAngvel({ x: 0, y: 0, z: 0 }, true);
    c.setLinvel({ x: vx, y: vy, z: vz }, true);
    v.launched = T + 0.25;
    this.geyserCooldown = 1.6;
    this.audio.geyser();
    this.rig.addShake(0.4);
    const base = new THREE.Vector3(g.x, groundHeight(g.x, g.z) + 0.3, g.z);
    this.soft.emit({ pos: base, vel: new THREE.Vector3(0, 14, 0), spread: 5, posSpread: 2.5, count: 60, life: 1.1, size: 0.7, sizeEnd: 2.2, color: 0xffffff, color2: 0xcfe9ff, alpha: 0.55, drag: 1.6 });
    this.glow.emit({ pos: base, vel: new THREE.Vector3(0, 10, 0), spread: 6, count: 30, life: 0.8, size: 0.12, color: 0xbfe8ff, gravity: 2 });
  }

  // ----------------------------------------------------------- falling
  private startFall() {
    this.falling = true;
    this.fallT = 0;
    this.vehicle.enabled = false;
    this.rig.startFall();
    this.audio.fallWind();
    this.dialogue.say(LINES.fallFirst, 'fall', true);
  }

  private updateFall(dt: number) {
    this.fallT += dt;
    const p = this.vehicle.position;
    // punching through the cloud sea
    if (p.y < -26 && Math.random() < 0.7) {
      this.soft.emit({ pos: p, posSpread: 5, vel: new THREE.Vector3(0, 6, 0), spread: 4, count: 3, life: 1.6, size: 2.2, sizeEnd: 5, color: 0xffffff, color2: this.atmo.current.cloudLit, alpha: 0.6, drag: 1 });
    }
    if ((p.y < -40 || this.fallT > 3.2) && !this.respawning) {
      this.respawning = true;
      this.ui.fade(true);
      setTimeout(() => this.rescue(), 500);
    }
  }

  /** The lantern inflates into a balloon and floats Wick back down onto solid ground. */
  private rescue() {
    const s = this.safeSpot;
    const gy = groundHeight(s.x, s.z);
    this.vehicle.respawn(s.x, gy + 12, s.z, s.yaw);
    this.vehicle.startBalloon();
    this.vehicle.enabled = true;
    this.falling = false;
    this.rig.mode = 'follow';
    this.rig.camera.position.set(s.x - Math.sin(s.yaw) * 26, gy + 26, s.z - Math.cos(s.yaw) * 26);
    this.rig.yaw = Math.atan2(-Math.sin(s.yaw), -Math.cos(s.yaw));
    this.audio.inflate();
    this.ui.fade(false);
    this.respawning = false;
  }

  /** R: back on the wheels where you are (or a rescue if you're nowhere). */
  private resetCar() {
    if (this.falling || this.respawning) return;
    const p = this.vehicle.position;
    if (isInsideIsland(p.x, p.z, -0.5) && p.y > -4) {
      this.vehicle.resetInPlace();
      this.audio.respawn();
      this.soft.emit({ pos: p.clone(), spread: 5, count: 24, life: 0.9, size: 0.6, sizeEnd: 1.6, color: 0xfff1d8, alpha: 0.6, drag: 3 });
    } else this.startFall();
  }

  // ----------------------------------------------------------- beacons
  private lightBeacon(b: Beacon) {
    b.lit = true;
    b.litAt = this.time;
    b.progress = 1;
    this.lastProgressAt = this.time;
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
    this.audio.intensity = Math.min(1, this.obj.litCount / NB);
    for (const l of this.structures.lamps) if (Math.hypot(l.x - b.pos.x, l.z - b.pos.z) < 48) l.target = 1;

    if (isFinale) { this.startLighthouse(); return; }
    const n = this.obj.litCount;
    this.todTarget = (n / NB) * 0.9;
    const place = b.def.name.replace(' Beacon', '');
    const verbs = ['burns again', 'is awake', 'remembers the light', 'is glowing', 'answers', 'sings in the wind'];
    this.ui.banner(`Beacon ${n} of ${NB}`, `The ${place} ${verbs[(n - 1) % verbs.length]}`);
    this.dialogue.say(LINES.lit[Math.min(n, NB) - 1], undefined, true);
    if (n === NB) {
      this.chapter = 'lighthouse';
      this.obj.finale.ring.visible = true;
      this.obj.finale.marker.visible = true;
      setTimeout(() => this.ui.banner('All six are burning', 'Now, the lighthouse', 4200), 3900);
    }
  }

  // ----------------------------------------------------------- finales
  private startLighthouse() {
    this.state = 'finale';
    this.finaleKind = 'lighthouse';
    this.ui.setKindle(false);
    this.ui.setPrompt(null);
    this.finaleT = 0;
    this.vehicle.enabled = false;
    this.todTarget = 0.97;
    this.audio.finale();
    this.ui.banner('the lighthouse is lit', 'Last Light', 4600);
    this.structures.lighthouseBeam.visible = true;
    this.rig.startCinematic(this.structures.lighthouseTop.clone().add(new THREE.Vector3(0, -6, 0)), 34, 14, 0.22);
    for (const l of this.structures.lamps) l.target = 1;
    this.dialogue.say(LINES.lighthouse, 'lighthouse', true);
  }

  private startMeet() {
    this.state = 'finale';
    this.finaleKind = 'meet';
    this.finaleT = 0;
    this.vehicle.enabled = false;
    this.ui.setPrompt(null);
    const o = new THREE.Vector3(ORIEL.x, groundHeight(ORIEL.x, ORIEL.z), ORIEL.z);
    const car = this.vehicle.position.clone();
    const mid = o.clone().lerp(car, 0.45).add(new THREE.Vector3(0, 1.3, 0));
    const away = car.clone().sub(o).setY(0).normalize();
    const side = new THREE.Vector3(-away.z, 0, away.x);
    // frame both of them from the open side of the islet, a little above
    const isl = new THREE.Vector3(OBSERVATORY.x, 0, OBSERVATORY.z);
    const outward = mid.clone().setY(0).sub(isl).normalize();
    const camDir = side.clone().multiplyScalar(Math.sign(side.dot(outward)) || 1).add(outward.multiplyScalar(0.6)).normalize();
    this.rig.setShot(mid.clone().addScaledVector(camDir, 13).add(new THREE.Vector3(0, 5.5, 0)), mid.clone().add(new THREE.Vector3(0, -0.4, 0)), 1.2);
    this.dialogue.say(LINES.meet, 'meet', true);
  }

  private updateFinale(dt: number) {
    this.finaleT += dt;
    const t = this.finaleT;
    if (this.finaleKind === 'lighthouse') {
      const lamp = this.structures.lighthouseLamp.material as THREE.MeshStandardMaterial;
      lamp.emissiveIntensity = Math.min(9, t * 3);
      const beamMat = (this.structures.lighthouseBeam.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;
      beamMat.uniforms.uOpacity.value = Math.min(0.55, t * 0.3);
      if (t < 5) this.fireworks(dt, new THREE.Vector3(0, 0, -8), 40);
      if (t > 4.6 && this.rig.mode !== 'shot') {
        // the answer: a lantern blinks on the Observatory isle
        this.oriel.root.visible = true;
        this.audio.reveal();
        const obs = new THREE.Vector3(OBSERVATORY.x, groundHeight(OBSERVATORY.x, OBSERVATORY.z) + 6, OBSERVATORY.z);
        const from = this.structures.lighthouseTop.clone().lerp(obs, 0.42).add(new THREE.Vector3(0, 10, 0));
        const toObs = obs.clone().sub(from).setY(0).normalize();
        this.rig.setShot(from.addScaledVector(new THREE.Vector3(-toObs.z, 0, toObs.x), 14), obs, 0.9);
      }
      if (t > 12.5) {
        this.state = 'play';
        this.chapter = 'oriel';
        this.vehicle.enabled = true;
        this.rig.endCinematic();
        this.ui.banner('a light answered', 'Find Oriel', 3800);
      }
    } else if (this.finaleKind === 'meet') {
      if (t > 1.5 && !this.dialogue.busy) {
        this.finaleKind = 'rise';
        this.finaleT = 0;
        this.chapter = 'done';
        this.finished = true;
        this.audio.finale();
        this.ui.banner('epilogue', 'The isle rises', 5000);
        this.rig.startCinematic(new THREE.Vector3(0, -6, 0), 150, 48, 0.1);
      }
    } else {
      this.atmo.rise = Math.min(1, t / 9);
      this.fireworks(dt, new THREE.Vector3(0, 0, 0), 70);
      if (t > 10.5 && this.state === 'finale') {
        this.state = 'end';
        this.ui.showEnd(this.playTime, `${this.glimmerCount}/${GLIMMERS.length}`, `${this.notesRead.filter(Boolean).length}/${NOTES.length}`);
      }
    }
  }

  private fireworks(dt: number, center: THREE.Vector3, spread: number) {
    if (Math.random() > dt * 3) return;
    const a = Math.random() * Math.PI * 2, r = 10 + Math.random() * spread;
    const pos = new THREE.Vector3(center.x + Math.cos(a) * r, 26 + Math.random() * 16, center.z + Math.sin(a) * r);
    const cols = [[0xffd27a, 0xff7a3a], [0xffc2d6, 0xff6a8a], [0xbfe8ff, 0x8fb0ff], [0xfff4c0, 0xffd27a]][Math.floor(Math.random() * 4)];
    this.glow.emit({ pos, spread: 16, count: 90, life: 1.6, size: 0.35, sizeEnd: 0.05, color: cols[0], color2: cols[1], gravity: 4, drag: 1.4 });
    this.audio.noise({ dur: 0.5, vol: 0.12, freq: 900, sweep: 200 });
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
    this.dialogue.say(LINES.glimmerFirst, 'glimmer');
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

  /** Back to the last lit beacon (pause menu). */
  respawn() {
    if (this.respawning) return;
    this.respawning = true;
    this.ui.fade(true);
    setTimeout(() => {
      const c = this.checkpoint;
      this.falling = false;
      this.vehicle.enabled = this.state === 'play';
      this.vehicle.respawn(c.x, groundHeight(c.x, c.z) + 1.4, c.z, c.yaw);
      this.rig.mode = 'follow';
      this.rig.camera.position.set(c.x, groundHeight(c.x, c.z) + 14, c.z + 14);
      this.audio.respawn();
      this.ui.fade(false);
      this.soft.emit({ pos: new THREE.Vector3(c.x, groundHeight(c.x, c.z) + 0.5, c.z), spread: 6, count: 30, life: 1, size: 0.6, sizeEnd: 1.8, color: 0xfff1d8, alpha: 0.6, drag: 3 });
      this.respawning = false;
    }, 350);
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
    this.chapter = 'beacons';
    this.oriel.root.visible = false;
    this.atmo.rise = 0;
    (this.structures.observatoryLamp.material as THREE.MeshStandardMaterial).emissiveIntensity = 0;
    this.dialogue.reset();
    this.checkpoint = { x: SPAWN.x, z: SPAWN.z, yaw: SPAWN.yaw };
    this.safeSpot = { ...this.checkpoint };
    this.lastProgressAt = this.time;
    this.respawn();
    this.ui.setGlimmers(0, GLIMMERS.length);
    this.ui.toast('A new evening begins');
    setTimeout(() => this.dialogue.say(LINES.intro, 'intro'), 900);
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

    // geysers breathe; the observatory answers once Oriel is home
    e.geyser -= dt;
    if (e.geyser <= 0) {
      e.geyser = 0.09;
      for (const g of GEYSERS) {
        this.soft.emit({ pos: new THREE.Vector3(g.x, groundHeight(g.x, g.z) + 0.3, g.z), posSpread: 2.2, vel: new THREE.Vector3(0, 7, 0), spread: 1.2, life: 1.0, size: 0.5, sizeEnd: 1.6, color: 0xffffff, color2: 0xd8ecff, alpha: 0.32, drag: 1.2 });
      }
    }
    if (this.oriel.root.visible) {
      const blink = this.chapter === 'oriel' ? (Math.sin(t * 5) > 0.2 ? 6 : 0.6) : 4;
      (this.structures.observatoryLamp.material as THREE.MeshStandardMaterial).emissiveIntensity = blink;
      for (const w of this.structures.observatoryWindows) (w.material as THREE.MeshStandardMaterial).emissiveIntensity = 3;
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
    const p = this.vehicle.position;
    let title = '', hint = '';
    let target: THREE.Vector3 | null = null;
    if (this.chapter === 'beacons') {
      const b = this.obj.nearestUnlit(p);
      title = `Relight the beacons · ${n}/${NB}`;
      if (b) { target = b.pos; hint = `${b.def.name} — ${Math.round(b.pos.distanceTo(p))} m · ${b.def.hint}`; }
    } else if (this.chapter === 'lighthouse') {
      target = this.obj.finale.pos;
      title = 'Light the lighthouse';
      hint = `drive into the ring at its door — ${Math.round(target.distanceTo(p))} m`;
    } else if (this.chapter === 'oriel') {
      target = new THREE.Vector3(ORIEL.x, groundHeight(ORIEL.x, ORIEL.z), ORIEL.z);
      title = 'Find Oriel on the Observatory isle';
      hint = `${Math.round(target.distanceTo(p))} m · across the bridge past the stone circle`;
    } else {
      title = 'The isle is safe · explore freely';
      hint = `${this.glimmerCount}/${GLIMMERS.length} glimmers · ${this.notesRead.filter(Boolean).length}/${NOTES.length} notes`;
    }
    this.ui.setBeacons(lit, this.obj.finale.lit, title, hint);
    this.ui.setGlimmers(this.glimmerCount, GLIMMERS.length);
    this.ui.setTimer(this.playTime);
    if (performance.now() - this.ui.controlsShownAt > 14000 && this.ui.controlsShownAt > 0) {
      this.ui.toggleControls(false);
      this.ui.controlsShownAt = -1;
    }

    // off-screen pointer to the current target
    if (target && this.state === 'play' && !this.falling) {
      const cam = this.rig.camera;
      const pr = target.clone().add(new THREE.Vector3(0, 2, 0)).project(cam);
      const behind = pr.z > 1;
      const w = window.innerWidth, h = window.innerHeight;
      const onScreen = !behind && Math.abs(pr.x) < 0.92 && Math.abs(pr.y) < 0.88;
      const dist = target.distanceTo(p);
      if (onScreen || dist < 12) this.ui.pointer(null);
      else {
        let x = pr.x, y = pr.y;
        if (behind) { x = -x; y = -y; }
        const ang = Math.atan2(y, x);
        const ex = Math.cos(ang), ey = Math.sin(ang);
        const k = Math.min(0.86 / Math.abs(ex || 1e-6), 0.8 / Math.abs(ey || 1e-6));
        this.ui.pointer({ x: (ex * k * 0.5 + 0.5) * w, y: (-ey * k * 0.5 + 0.5) * h, angle: -ang + Math.PI / 2 }, dist);
      }
    } else this.ui.pointer(null);
  }
}

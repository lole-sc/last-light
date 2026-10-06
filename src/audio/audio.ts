// Fully procedural sound: engine, wind, water, birds/crickets, impacts,
// chimes and a soft generative score. No audio files, nothing to license.
const PENTA = [0, 2, 4, 7, 9];

export class AudioEngine {
  ctx: AudioContext | null = null;
  master!: GainNode;
  sfx!: GainNode;
  music!: GainNode;
  private engineOsc!: OscillatorNode; private engineSub!: OscillatorNode;
  private engineGain!: GainNode; private engineFilter!: BiquadFilterNode;
  private roll!: GainNode; private rollFilter!: BiquadFilterNode;
  private wind!: GainNode; private windFilter!: BiquadFilterNode;
  private water!: GainNode;
  private skid!: GainNode;
  private noiseBuf!: AudioBuffer;
  muted = false;
  musicOn = true;
  private nextNote = 0;
  private chordIdx = 0;
  private nextAmbient = 0;
  night = 0;
  intensity = 0; // music intensity 0..1 (beacons lit)

  async start() {
    if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume(); return; }
    const ctx = new AudioContext();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain(); this.sfx.gain.value = 0.9; this.sfx.connect(this.master);
    this.music = ctx.createGain(); this.music.gain.value = 0.32; this.music.connect(this.master);

    // shared noise buffer
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b = (b + 0.02 * w) / 1.02; d[i] = b * 3.5 * 0.6 + w * 0.4; }

    // engine: detuned saws through a low-pass, "toy motor"
    this.engineFilter = ctx.createBiquadFilter(); this.engineFilter.type = 'lowpass'; this.engineFilter.frequency.value = 500; this.engineFilter.Q.value = 3;
    this.engineGain = ctx.createGain(); this.engineGain.gain.value = 0;
    this.engineOsc = ctx.createOscillator(); this.engineOsc.type = 'sawtooth'; this.engineOsc.frequency.value = 60;
    this.engineSub = ctx.createOscillator(); this.engineSub.type = 'square'; this.engineSub.frequency.value = 30;
    const subG = ctx.createGain(); subG.gain.value = 0.35;
    this.engineOsc.connect(this.engineFilter);
    this.engineSub.connect(subG).connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain).connect(this.sfx);
    this.engineOsc.start(); this.engineSub.start();

    const loopNoise = (type: BiquadFilterType, freq: number, q = 0.7) => {
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(f).connect(g).connect(this.sfx);
      src.start(0, Math.random() * 2);
      return { g, f };
    };
    ({ g: this.roll, f: this.rollFilter } = loopNoise('lowpass', 300));
    ({ g: this.wind, f: this.windFilter } = loopNoise('bandpass', 500, 0.6));
    ({ g: this.water } = loopNoise('lowpass', 1400));
    ({ g: this.skid } = loopNoise('bandpass', 1800, 2.5));
    this.nextNote = ctx.currentTime + 1;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.1);
  }

  /** Continuous parameters, called every frame. */
  update(p: { speed: number; throttle: number; boost: boolean; grounded: boolean; slip: number; waterNear: number; height: number; inWater: number }) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const s = Math.min(1, Math.abs(p.speed) / 28);
    const rpm = 55 + s * 110 + Math.max(0, p.throttle) * 18 + (p.boost ? 30 : 0) + (!p.grounded ? 25 * Math.max(0, p.throttle) : 0);
    this.engineOsc.frequency.setTargetAtTime(rpm, t, 0.08);
    this.engineSub.frequency.setTargetAtTime(rpm * 0.5, t, 0.08);
    this.engineFilter.frequency.setTargetAtTime(300 + s * 900 + (p.boost ? 600 : 0), t, 0.1);
    this.engineGain.gain.setTargetAtTime(0.035 + s * 0.06 + Math.abs(p.throttle) * 0.03, t, 0.1);
    this.roll.gain.setTargetAtTime(p.grounded ? s * 0.25 : 0, t, 0.05);
    this.rollFilter.frequency.setTargetAtTime(200 + s * 500, t, 0.1);
    this.skid.gain.setTargetAtTime(p.grounded && p.slip > 4 ? Math.min(0.12, (p.slip - 4) * 0.02) : 0, t, 0.05);
    const windAmt = 0.05 + Math.min(1, Math.max(0, p.height) / 14) * 0.08 + s * 0.06;
    this.wind.gain.setTargetAtTime(windAmt, t, 0.5);
    this.windFilter.frequency.setTargetAtTime(380 + Math.sin(t * 0.3) * 120 + s * 300, t, 0.3);
    this.water.gain.setTargetAtTime(p.waterNear * 0.22 + p.inWater * 0.12, t, 0.3);
    this.scheduleMusic();
    this.ambience();
  }

  private env(g: GainNode, t: number, a: number, peak: number, dcy: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + dcy);
  }

  tone(freq: number, opts: { type?: OscillatorType; dur?: number; vol?: number; attack?: number; when?: number; out?: AudioNode; glide?: number } = {}) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + (opts.when ?? 0);
    const o = ctx.createOscillator(); o.type = opts.type ?? 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (opts.glide) o.frequency.exponentialRampToValueAtTime(freq * opts.glide, t + (opts.dur ?? 0.5));
    const g = ctx.createGain();
    this.env(g, t, opts.attack ?? 0.005, opts.vol ?? 0.2, opts.dur ?? 0.5);
    o.connect(g).connect(opts.out ?? this.sfx);
    o.start(t); o.stop(t + (opts.attack ?? 0.005) + (opts.dur ?? 0.5) + 0.05);
  }

  noise(opts: { dur?: number; vol?: number; freq?: number; type?: BiquadFilterType; q?: number; when?: number; sweep?: number }) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + (opts.when ?? 0);
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = opts.type ?? 'lowpass'; f.frequency.setValueAtTime(opts.freq ?? 800, t); f.Q.value = opts.q ?? 0.8;
    if (opts.sweep) f.frequency.exponentialRampToValueAtTime(opts.sweep, t + (opts.dur ?? 0.3));
    const g = ctx.createGain();
    this.env(g, t, 0.004, opts.vol ?? 0.3, opts.dur ?? 0.3);
    src.connect(f).connect(g).connect(this.sfx);
    src.start(t, Math.random()); src.stop(t + (opts.dur ?? 0.3) + 0.05);
  }

  // ---------- one-shots ----------
  impact(strength: number, kind = 'wood') {
    const v = Math.min(1, strength);
    if (kind === 'stone') { this.noise({ dur: 0.18, vol: 0.25 * v, freq: 900, q: 1.5 }); this.tone(110, { dur: 0.15, vol: 0.2 * v, type: 'triangle', glide: 0.6 }); }
    else if (kind === 'soft') { this.noise({ dur: 0.2, vol: 0.18 * v, freq: 400 }); }
    else if (kind === 'metal') { this.tone(520 + Math.random() * 200, { dur: 0.5, vol: 0.08 * v, type: 'triangle' }); this.noise({ dur: 0.08, vol: 0.15 * v, freq: 3000, type: 'highpass' }); }
    else { this.noise({ dur: 0.12, vol: 0.28 * v, freq: 1400, q: 2 }); this.tone(180 + Math.random() * 60, { dur: 0.1, vol: 0.18 * v, type: 'triangle', glide: 0.5 }); }
  }
  thud(v: number) { this.tone(70, { dur: 0.25, vol: 0.35 * Math.min(1, v), type: 'sine', glide: 0.5 }); this.noise({ dur: 0.15, vol: 0.2 * Math.min(1, v), freq: 300 }); }
  jump() { this.tone(260, { dur: 0.25, vol: 0.12, type: 'sine', glide: 1.8 }); this.noise({ dur: 0.15, vol: 0.08, freq: 600 }); }
  boing() { this.tone(180, { dur: 0.5, vol: 0.22, type: 'sine', glide: 2.6 }); this.tone(360, { dur: 0.4, vol: 0.08, type: 'triangle', glide: 2.2 }); }
  splash(v: number) { this.noise({ dur: 0.6, vol: 0.35 * Math.min(1, v), freq: 2200, sweep: 400 }); }
  bell(v = 1) {
    const base = 196;
    [1, 2.0, 2.4, 3.0, 4.2, 5.4].forEach((r, i) => this.tone(base * r, { dur: 3.5 - i * 0.4, vol: (0.2 / (i + 1)) * v, type: 'sine', attack: 0.002 }));
  }
  click() { this.tone(880, { dur: 0.06, vol: 0.06, type: 'triangle' }); }
  uiOpen() { this.tone(660, { dur: 0.15, vol: 0.06 }); this.tone(990, { dur: 0.2, vol: 0.05, when: 0.06 }); }
  uiClose() { this.tone(880, { dur: 0.12, vol: 0.05 }); this.tone(587, { dur: 0.18, vol: 0.05, when: 0.05 }); }
  glimmer(combo: number) {
    const n = PENTA[combo % 5] + 12 * Math.floor(combo / 5);
    const f = 880 * Math.pow(2, n / 12);
    this.tone(f, { dur: 0.35, vol: 0.12, type: 'sine' });
    this.tone(f * 1.5, { dur: 0.5, vol: 0.06, type: 'sine', when: 0.07 });
    this.tone(f * 2, { dur: 0.6, vol: 0.04, type: 'triangle', when: 0.12 });
  }
  kindleTick(p: number) { this.tone(300 + p * 500, { dur: 0.08, vol: 0.04, type: 'triangle' }); }
  ignite(step: number) {
    this.noise({ dur: 1.2, vol: 0.35, freq: 300, sweep: 3000, type: 'bandpass', q: 0.6 });
    this.tone(55, { dur: 1.2, vol: 0.3, type: 'sine', glide: 0.7 });
    const root = 261.6 * Math.pow(2, [0, 2, 4, 7, 9][step % 5] / 12);
    [1, 1.25, 1.5, 2, 2.5].forEach((r, i) => this.tone(root * r, { dur: 2.8, vol: 0.09, type: i % 2 ? 'triangle' : 'sine', when: 0.15 + i * 0.09, attack: 0.02 }));
  }
  finale() {
    const notes = [0, 4, 7, 12, 16, 19, 24];
    notes.forEach((n, i) => this.tone(196 * Math.pow(2, n / 12), { dur: 4, vol: 0.1, type: 'sine', when: i * 0.18, attack: 0.05 }));
    this.noise({ dur: 2.5, vol: 0.3, freq: 200, sweep: 5000, type: 'bandpass', q: 0.5 });
    this.bell(0.7);
  }
  respawn() { this.tone(400, { dur: 0.4, vol: 0.1, glide: 2 }); this.noise({ dur: 0.4, vol: 0.1, freq: 3000, sweep: 600, type: 'bandpass' }); }
  fail() { this.tone(300, { dur: 0.8, vol: 0.12, type: 'triangle', glide: 0.4 }); }

  // ---------- generative score ----------
  private scheduleMusic() {
    const ctx = this.ctx!;
    if (!this.musicOn) return;
    // slow chord pad + sparse pentatonic plucks; denser/brighter as beacons are lit
    const chords = [[0, 4, 7, 11], [9, 12, 16, 19], [5, 9, 12, 16], [7, 11, 14, 17]];
    const root = 130.8; // C3
    while (this.nextNote < ctx.currentTime + 0.5) {
      const t0 = this.nextNote - ctx.currentTime;
      const ch = chords[this.chordIdx % chords.length];
      const barLen = 6.4;
      ch.forEach((n, i) => {
        this.tone(root * Math.pow(2, n / 12), { dur: barLen, vol: 0.05 - i * 0.006, type: i === 0 ? 'triangle' : 'sine', attack: 1.6, when: t0, out: this.music });
      });
      const plucks = 3 + Math.floor(this.intensity * 6);
      for (let k = 0; k < plucks; k++) {
        if (Math.random() < 0.3) continue;
        const n = PENTA[Math.floor(Math.random() * 5)] + 24 + (Math.random() < 0.3 ? 12 : 0);
        this.tone(root * Math.pow(2, n / 12), { dur: 1.6, vol: 0.035 + this.intensity * 0.02, type: 'sine', when: t0 + (k * barLen) / plucks + Math.random() * 0.2, out: this.music });
      }
      this.chordIdx++;
      this.nextNote += barLen;
    }
  }

  private ambience() {
    const ctx = this.ctx!;
    if (ctx.currentTime < this.nextAmbient) return;
    this.nextAmbient = ctx.currentTime + 1.5 + Math.random() * 4;
    if (this.night < 0.6) {
      // birds
      const f = 2200 + Math.random() * 1600;
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) this.tone(f * (1 + Math.random() * 0.2), { dur: 0.09, vol: 0.025 * (1 - this.night), type: 'sine', when: i * 0.12, glide: 1.25 });
    } else {
      // crickets
      for (let i = 0; i < 6; i++) this.tone(4200, { dur: 0.03, vol: 0.012 * this.night, type: 'square', when: i * 0.06 });
    }
  }
}

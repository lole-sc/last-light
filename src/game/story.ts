// The story: Keeper Oriel didn't come home, the isle is sinking, and Ember —
// the little flame living in Wick's lantern — talks you through the night.

export type Speaker = 'ember' | 'oriel';
export interface Line { who: Speaker; text: string; hold?: number; }

export const LINES = {
  intro: [
    { who: 'ember', text: "Wick! Wake up — the sun's going down." },
    { who: 'ember', text: "Oriel never came home tonight. Without her beacons, the isle sinks into the clouds." },
    { who: 'ember', text: "So we light them ourselves. Six beacons. Follow my glow — the first one is in the orchard." },
  ],
  kindleFirst: [{ who: 'ember', text: 'Stay inside the ring… let me catch…' }],
  lit: [
    [{ who: 'ember', text: 'One! Feel that? The whole isle just lifted a hair.' }],
    [{ who: 'ember', text: 'Two. Look — the street lamps are waking up.' }],
    [{ who: 'ember', text: "Three. Halfway there. The sun's slipping, Wick." }],
    [{ who: 'ember', text: 'Four. I can see the first stars.' }],
    [{ who: 'ember', text: 'Five! One more, and the lighthouse will have something to answer.' }],
    [{ who: 'ember', text: 'Six! Every beacon on the isle is burning!' },
      { who: 'ember', text: "Now the lighthouse, up on the hill. If Oriel's out there, she'll see it." }],
  ] as Line[][],
  geyserFirst: [{ who: 'ember', text: "A wind geyser. Drive onto the vent and… trust it. I'm told it's safe. Mostly." }],
  bridgeFirst: [{ who: 'ember', text: 'Gently… rope bridges have opinions.' }],
  fallFirst: [{ who: 'ember', text: "WICK! Okay — okay. I can float. Hold on!" }],
  rescued: [{ who: 'ember', text: "Let's not do that again. (We're definitely doing that again.)" }],
  glimmerFirst: [{ who: 'ember', text: 'Ooh, a glimmer. Oriel keeps those in a jar by her bed.' }],
  observatoryEarly: [{ who: 'ember', text: "Oriel's observatory… all dark. Her star chart is still out on the table." }],
  stuck: [{ who: 'ember', text: "Stuck? Press R and I'll set us right." }],
  idle: [{ who: 'ember', text: 'Follow my glow, Wick — the marker at the edge of the screen points the way.' }],
  lighthouse: [
    { who: 'ember', text: "It's lit! The whole sky can see us now…" },
    { who: 'ember', text: 'Wait — out there! Something blinked back!' },
    { who: 'ember', text: "That's Oriel's lantern! She's on the Observatory isle — over the bridge past the stone circle!" },
  ],
  meet: [
    { who: 'oriel', text: 'Wick! Ember! There you are, my little lights.' },
    { who: 'oriel', text: 'I chased a falling star and completely lost track of the hour. And you lit every beacon by yourselves?' },
    { who: 'ember', text: 'We may have knocked over a few crates.' },
    { who: 'oriel', text: "Ha! Crates can be stacked again. Look — the isle is rising. That's the light doing its work." },
  ],
} satisfies Record<string, Line[] | Line[][]>;

const AVATAR: Record<Speaker, { name: string; svg: string }> = {
  ember: {
    name: 'Ember',
    svg: '<svg viewBox="0 0 40 40"><path d="M20 4c6 9 11 13 11 21a11 11 0 0 1-22 0c0-6 3-9 6-12 0 4 2 6 4 6 1-6-1-10 1-15z" fill="#ffb347"/><ellipse cx="20" cy="28" rx="5" ry="6.5" fill="#fff1c0"/><circle cx="17.5" cy="26" r="1.3" fill="#3a2030"/><circle cx="22.5" cy="26" r="1.3" fill="#3a2030"/></svg>',
  },
  oriel: {
    name: 'Keeper Oriel',
    svg: '<svg viewBox="0 0 40 40"><ellipse cx="20" cy="15" rx="15" ry="3.2" fill="#2f8f8a"/><path d="M13 15l7-11 7 11z" fill="#2f8f8a"/><circle cx="20" cy="22" r="8" fill="#f1c7a5"/><path d="M12 21c0-4 3-6 8-6s8 2 8 6c-2-2-5-3-8-3s-6 1-8 3z" fill="#f4efe6"/><circle cx="17" cy="23" r="1.1" fill="#3a2030"/><circle cx="23" cy="23" r="1.1" fill="#3a2030"/><path d="M11 31c3-2 15-2 18 0l-2 5H13z" fill="#e0a53a"/></svg>',
  },
};

/** Queue-based dialogue player rendered into the HUD's dialogue card. */
export class Dialogue {
  private queue: Line[] = [];
  private current: Line | null = null;
  private shown = 0;
  private holdT = 0;
  private el = document.getElementById('dialogue')!;
  private nameEl = document.getElementById('dlg-name')!;
  private textEl = document.getElementById('dlg-text')!;
  private avatarEl = document.getElementById('dlg-avatar')!;
  onBlip: (who: Speaker) => void = () => {};
  played = new Set<string>();

  /** Play a set of lines once per playthrough (keyed), or always if no key. */
  say(lines: Line[], key?: string, interrupt = false) {
    if (key) { if (this.played.has(key)) return; this.played.add(key); }
    if (interrupt) { this.queue = []; this.current = null; }
    this.queue.push(...lines);
  }

  get busy() { return !!this.current || this.queue.length > 0; }

  skip() {
    if (!this.current) return;
    if (this.shown < this.current.text.length) this.shown = this.current.text.length;
    else this.holdT = 0;
  }

  reset() { this.queue = []; this.current = null; this.played.clear(); this.el.classList.remove('show'); }

  update(dt: number) {
    if (!this.current) {
      const next = this.queue.shift();
      if (!next) { this.el.classList.remove('show'); return; }
      this.current = next;
      this.shown = 0;
      this.holdT = next.hold ?? 1.6 + next.text.length * 0.028;
      const a = AVATAR[next.who];
      this.nameEl.textContent = a.name;
      this.avatarEl.innerHTML = a.svg;
      this.el.dataset.who = next.who;
      this.el.classList.add('show');
    }
    const c = this.current;
    if (this.shown < c.text.length) {
      const before = Math.floor(this.shown);
      this.shown = Math.min(c.text.length, this.shown + dt * 46);
      if (Math.floor(this.shown / 3) !== Math.floor(before / 3) && c.text[Math.floor(this.shown) - 1] !== ' ') this.onBlip(c.who);
      this.textEl.textContent = c.text.slice(0, Math.floor(this.shown));
    } else {
      this.holdT -= dt;
      if (this.holdT <= 0) this.current = null;
    }
  }
}

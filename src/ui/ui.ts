// Thin DOM layer for HUD, modals, map and title screens.
import * as THREE from 'three';
import { BEACONS, GEYSERS, NOTES, ORIEL } from '../world/layout';
import { HALF, groundColor, groundHeight, groundNormal, isInsideIsland, isWater } from '../world/terrain';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class UI {
  hud = $('hud');
  private toastTimer = 0;
  private bannerTimer = 0;
  private mapBase: HTMLCanvasElement | null = null;
  controlsShownAt = 0;

  constructor() {
    const flames = $('flames');
    for (let i = 0; i < BEACONS.length; i++) flames.appendChild(document.createElement('i'));
    const fin = document.createElement('i');
    fin.className = 'final';
    flames.appendChild(fin);
  }

  loader(p: number, status: string) {
    $('loader-bar').style.width = `${Math.round(p * 100)}%`;
    $('loader-status').textContent = status;
  }
  hideLoader() { $('loader').classList.add('hidden'); }
  showTitle(show: boolean, quality = '') {
    $('title').classList.toggle('hidden', !show);
    if (quality) $('title-quality').textContent = `quality · ${quality}`;
  }
  showHud(show: boolean) {
    this.hud.classList.toggle('hidden', !show);
    if (show) this.controlsShownAt = performance.now();
  }
  toggleControls(force?: boolean) { $('controls').classList.toggle('away', force === undefined ? undefined : !force); }

  setBeacons(lit: boolean[], finaleLit: boolean, title: string, hint: string) {
    const items = $('flames').children;
    lit.forEach((l, i) => items[i].classList.toggle('lit', l));
    items[BEACONS.length].classList.toggle('lit', finaleLit);
    $('obj-title').textContent = title;
    $('obj-hint').textContent = hint;
  }
  setGlimmers(n: number, total: number, bump = false) {
    $('glimmer-count').textContent = String(n);
    $('glimmer-total').textContent = `/${total}`;
    if (bump) {
      const el = $('glimmers');
      el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    }
  }
  setTimer(s: number) { $('timer').textContent = fmtTime(s); }
  setPrompt(text: string | null) {
    const p = $('prompt');
    p.classList.toggle('show', !!text);
    if (text) $('prompt-text').textContent = text;
  }
  setKindle(on: boolean) { $('kindle').classList.toggle('show', on); }
  setSound(on: boolean) {
    $('btn-sound').classList.toggle('off', !on);
  }

  toast(msg: string, ms = 2600) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.remove('show'), ms);
  }
  banner(small: string, big: string, ms = 3600) {
    $('banner-small').textContent = small;
    $('banner-big').textContent = big;
    const b = $('banner');
    b.classList.add('show');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => b.classList.remove('show'), ms);
  }

  pointer(screen: { x: number; y: number; angle: number } | null, dist = 0) {
    const p = $('pointer');
    if (!screen) { p.classList.remove('show'); return; }
    p.classList.add('show');
    p.style.transform = `translate(${screen.x}px, ${screen.y}px)`;
    (p.firstElementChild as HTMLElement).style.transform = `rotate(${screen.angle}rad)`;
    $('pointer-dist').textContent = `${Math.round(dist)} m`;
  }

  showNote(i: number) {
    const n = NOTES[i];
    $('note-title').textContent = n.title;
    $('note-body').textContent = n.body;
    $('note-eyebrow').textContent = `Keeper's notes · ${i + 1} of ${NOTES.length}`;
    $('note').classList.remove('hidden');
  }
  hideNote() { $('note').classList.add('hidden'); }
  isOpen(id: 'note' | 'map' | 'pause' | 'end') { return !$(id).classList.contains('hidden'); }
  show(id: 'note' | 'map' | 'pause' | 'end', on: boolean) { $(id).classList.toggle('hidden', !on); }

  setQualityButtons(q: string) {
    $('seg-quality').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.q === q));
  }
  setSkyButtons(sky: string) {
    $('seg-sky').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.sky === sky));
  }
  setSpeedLines(on: boolean) { $('speedlines').classList.toggle('on', on); }
  setSoundButtons(sound: boolean, music: boolean) {
    $('seg-sound').querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b.dataset.s === 'on') === sound));
    $('seg-music').querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b.dataset.m === 'on') === music));
  }

  fade(on: boolean) { $('fade').classList.toggle('on', on); }

  showEnd(time: number, glimmers: string, notes: string) {
    $('end-time').textContent = fmtTime(time);
    $('end-glimmers').textContent = glimmers;
    $('end-notes').textContent = notes;
    this.show('end', true);
  }

  // ---------------- map ----------------
  private buildMapBase() {
    const S = 720;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d')!;
    const img = g.createImageData(S, S);
    const col = new THREE.Color();
    const scale = (HALF * 2) / S;
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        const x = i * scale - HALF, z = j * scale - HALF;
        const k = (j * S + i) * 4;
        if (!isInsideIsland(x, z, -0.5)) { img.data[k + 3] = 0; continue; }
        const h = groundHeight(x, z);
        if (isWater(x, z) && h < 0.15) col.setHex(0x4fb7b0);
        else groundColor(x, z, h, groundNormal(x, z).y, col);
        // hill shading
        const sh = (groundHeight(x - 1, z - 1) - h) * 0.12;
        const l = 1 + Math.max(-0.25, Math.min(0.25, sh)) + h * 0.012;
        img.data[k] = Math.min(255, col.r * 255 * l * 1.05 + 10);
        img.data[k + 1] = Math.min(255, col.g * 255 * l * 1.05 + 8);
        img.data[k + 2] = Math.min(255, col.b * 255 * l * 1.05 + 14);
        img.data[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    // paper-ish outline
    g.globalCompositeOperation = 'destination-over';
    g.strokeStyle = 'rgba(255,243,221,0.0)';
    this.mapBase = c;
  }

  drawMap(player: THREE.Vector3, heading: number, lit: boolean[], finaleReady: boolean, finaleLit: boolean, notesRead: boolean[], orielKnown = false) {
    if (!this.mapBase) this.buildMapBase();
    const cv = $<HTMLCanvasElement>('map-canvas');
    const g = cv.getContext('2d')!;
    const S = cv.width;
    const toPx = (x: number, z: number) => [((x + HALF) / (HALF * 2)) * S, ((z + HALF) / (HALF * 2)) * S];
    g.clearRect(0, 0, S, S);
    const grd = g.createRadialGradient(S / 2, S / 2, 40, S / 2, S / 2, S * 0.7);
    grd.addColorStop(0, 'rgba(255,190,150,0.25)');
    grd.addColorStop(1, 'rgba(120,90,170,0.15)');
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
    g.save();
    g.shadowColor = 'rgba(20,10,40,0.5)';
    g.shadowBlur = 24;
    g.shadowOffsetY = 10;
    g.drawImage(this.mapBase!, 0, 0);
    g.restore();
    // notes
    NOTES.forEach((n, i) => {
      const [x, y] = toPx(n.x, n.z);
      g.fillStyle = notesRead[i] ? 'rgba(255,243,221,0.45)' : '#fff3dd';
      g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2); g.fill();
    });
    // beacons
    const drawBeacon = (x0: number, z0: number, isLit: boolean, label: string, big = false) => {
      const [x, y] = toPx(x0, z0);
      g.beginPath(); g.arc(x, y, big ? 11 : 9, 0, Math.PI * 2);
      if (isLit) { g.fillStyle = '#ffb347'; g.shadowColor = '#ffb347'; g.shadowBlur = 18; g.fill(); g.shadowBlur = 0; }
      else { g.fillStyle = '#4b3f72'; g.fill(); g.lineWidth = 2.5; g.strokeStyle = '#ffb347'; g.stroke(); }
      g.font = '500 13px Outfit, sans-serif';
      g.textAlign = 'center';
      g.fillStyle = 'rgba(255,243,221,0.95)';
      g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 6;
      g.fillText(label, x, y - 16);
      g.shadowBlur = 0;
    };
    BEACONS.forEach((b, i) => drawBeacon(b.x, b.z, lit[i], b.name.replace(' Beacon', '')));
    if (finaleReady || finaleLit) drawBeacon(0, -8, finaleLit, 'Lighthouse', true);
    else {
      const [x, y] = toPx(0, -8);
      g.fillStyle = 'rgba(255,243,221,0.8)';
      g.font = 'italic 500 14px Fraunces, serif';
      g.textAlign = 'center';
      g.fillText('the lighthouse', x, y + 4);
    }
    // wind geysers
    for (const gz of GEYSERS) {
      const [x, y] = toPx(gz.x, gz.z);
      g.strokeStyle = 'rgba(190,230,255,0.9)'; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.stroke();
      const [tx, ty] = toPx(gz.tx, gz.tz);
      g.setLineDash([3, 5]);
      g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo((x + tx) / 2, (y + ty) / 2 - 30, tx, ty); g.stroke();
      g.setLineDash([]);
    }
    // Oriel
    if (orielKnown) {
      const [x, y] = toPx(ORIEL.x, ORIEL.z);
      g.fillStyle = '#9fdbe6'; g.shadowColor = '#9fdbe6'; g.shadowBlur = 14;
      g.beginPath(); g.arc(x, y, 8, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0;
      g.font = '500 13px Outfit, sans-serif'; g.textAlign = 'center'; g.fillStyle = '#fff3dd';
      g.fillText('Oriel', x, y - 14);
    }
    // player
    const [px, py] = toPx(player.x, player.z);
    g.save();
    g.translate(px, py);
    g.rotate(-heading);
    g.fillStyle = '#ffc23d';
    g.strokeStyle = '#2b2635';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, 11); g.lineTo(7, -7); g.lineTo(0, -3); g.lineTo(-7, -7); g.closePath();
    g.fill(); g.stroke();
    g.restore();
  }
}

export function fmtTime(s: number) {
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

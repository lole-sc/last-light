// Keyboard + mouse input with edge-triggered actions.
export class Input {
  keys = new Set<string>();
  private pressed = new Set<string>();
  private jumpQueued = 0;
  dragging = false;
  dragDX = 0;
  dragDY = 0;
  wheel = 0;
  lastActivity = 0;
  anyKeyListeners: ((code: string) => void)[] = [];

  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (e.code === 'Space' && !e.repeat) this.jumpQueued = performance.now();
      this.lastActivity = performance.now();
      if (!e.repeat) this.anyKeyListeners.forEach((f) => f(e.code));
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      this.dragging = true;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.dragDX += e.movementX;
      this.dragDY += e.movementY;
      this.lastActivity = performance.now();
    });
    const end = () => { this.dragging = false; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
  }

  private down(...codes: string[]) { return codes.some((c) => this.keys.has(c)); }

  /** +1 forward, -1 backward */
  get axisY() { return (this.down('KeyW', 'ArrowUp', 'KeyZ') ? 1 : 0) - (this.down('KeyS', 'ArrowDown') ? 1 : 0); }
  /** +1 = left, -1 = right (matches the vehicle's steering convention) */
  get axisX() { return (this.down('KeyA', 'ArrowLeft', 'KeyQ') ? 1 : 0) - (this.down('KeyD', 'ArrowRight') ? 1 : 0); }
  get boost() { return this.down('ShiftLeft', 'ShiftRight'); }

  consumeJump() {
    if (this.jumpQueued && performance.now() - this.jumpQueued < 160) { this.jumpQueued = 0; return true; }
    return false;
  }

  /** Was the key pressed since the last call to `endFrame`? */
  hit(code: string) { return this.pressed.has(code); }

  takeDrag() { const d = [this.dragDX, this.dragDY]; this.dragDX = 0; this.dragDY = 0; return d; }
  takeWheel() { const w = this.wheel; this.wheel = 0; return w; }

  endFrame() { this.pressed.clear(); }
}

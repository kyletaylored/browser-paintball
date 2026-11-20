// Keyboard + mouse with pointer lock (the browser API that captures the mouse for FPS aiming).

export class Input {
  locked = false;
  fireHeld = false;
  readonly keys = new Set<string>();
  private pressed = new Set<string>();
  private dx = 0;
  private dy = 0;

  constructor(private canvas: HTMLCanvasElement, playButton: HTMLElement) {
    playButton.addEventListener('click', () => this.lock());
    canvas.addEventListener('click', () => this.lock());

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) {
        this.keys.clear();
        this.fireHeld = false;
      }
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
    document.addEventListener('mousedown', (e) => {
      if (this.locked && e.button === 0) this.fireHeld = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fireHeld = false;
    });
    window.addEventListener('keydown', (e) => {
      if (!this.locked) return;
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.fireHeld = false;
    });
  }

  lock(): void {
    // Newer browsers return a promise that rejects if you re-lock too quickly after Esc.
    const r = this.canvas.requestPointerLock() as unknown;
    if (r instanceof Promise) r.catch(() => {});
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** true once per key press */
  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  takeLook(): { dx: number; dy: number } {
    const out = { dx: this.dx, dy: this.dy };
    this.dx = 0;
    this.dy = 0;
    return out;
  }

  endFrame(): void {
    this.pressed.clear();
  }
}

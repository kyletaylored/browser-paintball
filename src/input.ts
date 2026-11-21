// Everything the player presses, in one place: keyboard + mouse (with pointer lock, the browser API
// that captures the mouse for FPS aiming) and controllers (gamepad.ts).
//
// "Playing" means either the mouse is locked to the game, or you started with a controller or a
// touch screen, where there's no pointer lock (phones don't have it). Start on a controller, or the
// on-screen menu button on a phone, goes back to the menu.

import { Gamepads, type PadSettings } from './gamepad';

/** a phone or tablet: no mouse to lock, so Play goes straight in (made for a clip-on controller) */
export const TOUCH = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;

export type Device = 'keyboard' | 'pad';

export class Input {
  locked = false;
  /** playing without pointer lock: started from a controller or on a touch screen */
  padPlaying = false;
  /** what the player used last, for on-screen hints */
  device: Device = 'keyboard';
  readonly pad: Gamepads;
  /** called when play starts or stops, and when a controller connects or disconnects */
  onChange: () => void = () => {};
  /** the controller we were playing with went away mid-game */
  onPadLost: () => void = () => {};

  private mouseFire = false;
  /** A started the game: don't also jump until it's let go */
  private holdA = false;
  readonly keys = new Set<string>();
  private pressed = new Set<string>();
  private dx = 0;
  private dy = 0;

  constructor(private canvas: HTMLCanvasElement, playButton: HTMLElement, padSettings: PadSettings) {
    this.pad = new Gamepads(padSettings);
    this.pad.onChange = (connected) => {
      if (connected) this.device = 'pad';
      else if (this.padPlaying) {
        this.stop();
        this.onPadLost();
      }
      this.onChange();
    };

    playButton.addEventListener('click', () => this.start());
    canvas.addEventListener('click', () => {
      if (!TOUCH) this.lock();
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (this.locked) this.padPlaying = false; // the mouse took over
      else this.releaseAll();
      this.onChange();
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
      if (e.movementX || e.movementY) this.device = 'keyboard';
    });
    document.addEventListener('mousedown', (e) => {
      if (this.locked && e.button === 0) {
        this.mouseFire = true;
        this.device = 'keyboard';
      }
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseFire = false;
    });
    window.addEventListener('keydown', (e) => {
      if (!this.locked) return;
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
      this.device = 'keyboard';
      if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseFire = false;
    });
    // leaving the tab (or a phone call) pauses controller play, so you come back to the menu
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.padPlaying) this.stop();
    });
  }

  /** playing: the menu is hidden and input moves you */
  get active(): boolean {
    return this.locked || this.padPlaying;
  }

  /** the Play button (or the canvas): lock the mouse, or on a phone go fullscreen and start */
  start(): void {
    if (TOUCH || !('requestPointerLock' in this.canvas)) {
      this.padPlaying = true;
      if (TOUCH) goFullscreenLandscape();
      this.onChange();
      return;
    }
    this.lock();
  }

  /** back to the menu */
  stop(): void {
    this.padPlaying = false;
    this.pad.state.clearToggles();
    if (this.locked) document.exitPointerLock();
    this.releaseAll();
    this.onChange();
  }

  lock(): void {
    // Newer browsers return a promise that rejects if you re-lock too quickly after Esc.
    const r = this.canvas.requestPointerLock?.() as unknown;
    if (r instanceof Promise) r.catch(() => {});
  }

  /** read the controller; call once at the start of every frame */
  poll(dt: number): void {
    this.pad.update(dt);
    const p = this.pad.state;
    if (p.touched) this.device = 'pad';
    if (!p.jump) this.holdA = false;
    if (!this.active) {
      // from the menu, A or Start begins (with the controller: there's no mouse to lock without a click)
      if (p.aPressed || p.startPressed) {
        this.padPlaying = true;
        this.holdA = p.jump;
        this.onChange();
      }
    } else if (p.startPressed) {
      this.stop();
    }
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** true once per key press */
  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  // ---- actions, from whichever device ---------------------------------------------------------

  get forward(): number {
    return clamp1(+this.isDown('KeyW') - +this.isDown('KeyS') + this.padIn(this.pad.state.moveY));
  }

  get right(): number {
    return clamp1(+this.isDown('KeyD') - +this.isDown('KeyA') + this.padIn(this.pad.state.moveX));
  }

  get jump(): boolean {
    return this.isDown('Space') || (this.active && this.pad.state.jump && !this.holdA);
  }

  get sprint(): boolean {
    return this.isDown('ShiftLeft') || this.isDown('ShiftRight') || (this.active && this.pad.state.sprint);
  }

  get crouch(): boolean {
    return this.isDown('KeyC') || (this.active && this.pad.state.crouch);
  }

  get fireHeld(): boolean {
    return (this.locked && this.mouseFire) || (this.active && this.pad.state.fire);
  }

  get reloadPressed(): boolean {
    return this.wasPressed('KeyR') || (this.active && this.pad.state.reloadPressed);
  }

  get scoreboardHeld(): boolean {
    return this.isDown('Tab') || (this.active && this.pad.state.scoreboard);
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

  private padIn(v: number): number {
    return this.active ? v : 0;
  }

  private releaseAll(): void {
    this.keys.clear();
    this.mouseFire = false;
  }
}

const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

/**
 * Phones: fill the screen and turn sideways, like a console game. Fullscreen needs a tap (we're in
 * one), orientation lock needs fullscreen, and some browsers (iPhone Safari) allow neither. Then
 * the rotate prompt and "add to home screen" (manifest.webmanifest) cover it.
 */
function goFullscreenLandscape(): void {
  const el = document.documentElement;
  if (document.fullscreenElement || typeof el.requestFullscreen !== 'function') return;
  el.requestFullscreen({ navigationUI: 'hide' })
    .then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape'))
    .catch(() => {});
}

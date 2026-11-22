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

/** a quicker press than this is a tap */
const TAP_MS = 250;

/**
 * A key that works both ways: hold it and it's on while held; tap it and it stays on until you tap
 * it again (or something else, like jumping, ends it). Crouch (C) and lie down (Z).
 */
export class TapOrHold {
  /** on from a tap */
  latched = false;
  private downAt = -1;
  private wasLatched = false;

  get on(): boolean {
    return this.latched || this.downAt >= 0;
  }

  press(t: number): void {
    // pressing it while latched ends the latch: a tap stands you up, a hold keeps you down until you let go
    this.wasLatched = this.latched;
    this.latched = false;
    this.downAt = t;
  }

  release(t: number): void {
    if (this.downAt >= 0 && t - this.downAt < TAP_MS && !this.wasLatched) this.latched = true;
    this.downAt = -1;
  }

  clear(): void {
    this.latched = false;
    this.downAt = -1;
  }
}

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
  /** C: crouch, Z: lie down (tap to toggle, or hold) */
  readonly crouchKey = new TapOrHold();
  readonly proneKey = new TapOrHold();
  private pressed = new Set<string>();
  private dx = 0;
  private dy = 0;

  constructor(private canvas: HTMLCanvasElement, padSettings: PadSettings) {
    this.pad = new Gamepads(padSettings);
    this.pad.onChange = (connected) => {
      if (connected) this.device = 'pad';
      else if (this.padPlaying) {
        this.stop();
        this.onPadLost();
      }
      this.onChange();
    };

    // clicking the game while it's paused waiting for the mouse (say the lock was refused) grabs it
    canvas.addEventListener('click', () => {
      if (!TOUCH && this.wantPlay && !this.active) this.lock();
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (this.locked) this.padPlaying = false; // the mouse took over
      else this.releaseAll();
      this.onChange();
    });
    // the browser refused to lock the mouse (too soon after Esc, or not from a click): stay in the menu
    document.addEventListener('pointerlockerror', () => this.onChange());
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
      if (!e.repeat) {
        this.pressed.add(e.code);
        const t = performance.now();
        if (e.code === 'KeyC') {
          this.crouchKey.press(t);
          this.proneKey.clear(); // crouching from lying down gets you up to a crouch
        } else if (e.code === 'KeyZ') {
          this.proneKey.press(t);
          this.crouchKey.clear();
        } else if (e.code === 'Space') {
          this.crouchKey.clear(); // jumping stands you up
          this.proneKey.clear();
        }
      }
      this.keys.add(e.code);
      this.device = 'keyboard';
      if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'KeyC') this.crouchKey.release(performance.now());
      else if (e.code === 'KeyZ') this.proneKey.release(performance.now());
    });
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

  /** the menu asked to play and hasn't been told to stop: lets a canvas click grab the mouse */
  private wantPlay = false;

  /**
   * Start playing (from a menu button). With the mouse: lock it. From a controller press, or on a
   * phone: play without pointer lock (a controller press can't lock the mouse anyway: browsers only
   * allow that from a click or key). Phones also go fullscreen and sideways where allowed.
   */
  start(fromPad = false): void {
    this.wantPlay = true;
    this.pad.state.clearToggles(); // B in the menus flips crouch; start standing up
    if (fromPad || TOUCH || !('requestPointerLock' in this.canvas)) {
      this.padPlaying = true;
      this.holdA = fromPad && this.pad.state.jump;
      if (TOUCH) goFullscreenLandscape();
      this.onChange();
      return;
    }
    this.lock();
  }

  /** back to the menu */
  stop(): void {
    this.wantPlay = false;
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
    if (this.active && p.startPressed) {
      this.stop(); // Start pauses (the menu takes it from there)
      p.startPressed = false; // used up: the pause menu mustn't see it and resume straight away
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
    return this.crouchKey.on || (this.active && this.pad.state.crouch);
  }

  /** lying down (beats crouch) */
  get prone(): boolean {
    return this.proneKey.on || (this.active && this.pad.state.prone);
  }

  get fireHeld(): boolean {
    return (this.locked && this.mouseFire) || (this.active && this.pad.state.fire);
  }

  /** switch first / third person: H, or click the right stick */
  get viewPressed(): boolean {
    return this.wasPressed('KeyH') || (this.active && this.pad.state.viewPressed);
  }

  get reloadPressed(): boolean {
    return this.wasPressed('KeyR') || (this.active && this.pad.state.reloadPressed);
  }

  get scoreboardHeld(): boolean {
    return this.isDown('Tab') || (this.active && this.pad.state.scoreboard);
  }

  /** the on-screen Talk button (phones) is held */
  touchTalk = false;

  /** push-to-talk: V, d-pad up, or the Talk button */
  get talkHeld(): boolean {
    return this.active && (this.isDown('KeyV') || this.pad.state.talk || this.touchTalk);
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
    // back from the menu standing up, not crouched from a key you let go of while it was open
    this.crouchKey.clear();
    this.proneKey.clear();
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

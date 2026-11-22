// Controllers through the browser's Gamepad API: Bluetooth or USB controllers on a computer, and
// clip-on phone controllers in a phone's browser. All of them show up as "standard" gamepads.
//
// Browsers only reveal a controller after one of its buttons is pressed, so the start screen asks
// for a press. We poll every frame (the API has no input events) and use whichever controller
// was touched most recently.
//
// The maths at the top (deadzones, response curve, turn boost) has no DOM in it so
// gamepad-test.ts can run it under Node.

/** standard-mapping button indices (positions: A = bottom face button, B = right, X = left, Y = top) */
export const BTN = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, SELECT: 8, START: 9, L3: 10, R3: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
} as const;

export const MOVE_DEADZONE = 0.15;
export const LOOK_DEADZONE = 0.12;
/** a trigger counts as pressed past this */
export const TRIGGER_ON = 0.35;
/** full right-stick tilt turns this fast (rad/s) at sensitivity 1; pitch is a bit slower */
export const LOOK_YAW_SPEED = 3.0;
export const LOOK_PITCH_SPEED = 2.0;
/** response curve exponent: small tilts aim finely, big tilts turn fast */
export const LOOK_EXPONENT = 2;
/** holding the stick at the edge ramps turning up to this much faster, for turning around */
export const TURN_BOOST = 0.7;
const BOOST_DELAY = 0.2;
const BOOST_RAMP = 0.35;

/**
 * Radial deadzone: inside `dz` is zero, outside is rescaled so the output still runs 0..1 from the
 * deadzone edge (no jump in speed when you leave it). Radial, not per-axis, so diagonals stay round.
 */
export function radialDeadzone(x: number, y: number, dz: number): { x: number; y: number; mag: number } {
  const len = Math.hypot(x, y);
  if (len <= dz) return { x: 0, y: 0, mag: 0 };
  const mag = Math.min(1, (len - dz) / (1 - dz));
  return { x: (x / len) * mag, y: (y / len) * mag, mag };
}

/** stick (after the deadzone) → look speed in rad/s, with the response curve applied to its length */
export function lookRates(x: number, y: number, sensitivity: number, boost: number): { yaw: number; pitch: number } {
  const d = radialDeadzone(x, y, LOOK_DEADZONE);
  if (d.mag === 0) return { yaw: 0, pitch: 0 };
  const curved = Math.pow(d.mag, LOOK_EXPONENT) / d.mag; // scale factor keeping the direction
  const k = sensitivity * (1 + boost);
  return { yaw: d.x * curved * LOOK_YAW_SPEED * k, pitch: d.y * curved * LOOK_PITCH_SPEED * k };
}

/** turn boost (0..TURN_BOOST): kicks in after the stick has been at the edge for a moment */
export function turnBoost(edgeSeconds: number): number {
  if (edgeSeconds <= BOOST_DELAY) return 0;
  return TURN_BOOST * Math.min(1, (edgeSeconds - BOOST_DELAY) / BOOST_RAMP);
}

/** the parts of a Gamepad we read (so tests can pass plain objects) */
export interface PadLike {
  readonly index: number;
  readonly connected: boolean;
  readonly mapping: string;
  readonly timestamp: number;
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
}

export interface PadSettings {
  sensitivity: number;
  invertY: boolean;
  vibration: boolean;
}

export type NavDir = 'up' | 'down' | 'left' | 'right';
/** holding a direction in a menu repeats after this long, then this often */
const NAV_DELAY = 0.4;
const NAV_REPEAT = 0.14;

export type Rumble = 'fire' | 'hit' | 'out';
const RUMBLES: Record<Rumble, { duration: number; strongMagnitude: number; weakMagnitude: number }> = {
  fire: { duration: 40, strongMagnitude: 0, weakMagnitude: 0.35 },
  hit: { duration: 90, strongMagnitude: 0.25, weakMagnitude: 0.6 },
  out: { duration: 320, strongMagnitude: 0.9, weakMagnitude: 0.5 },
};

/** hold B this long (seconds) to lie down; a shorter press is a tap (crouch / stand) */
export const PRONE_HOLD = 0.35;

/**
 * One frame's worth of controller state, turned into game actions. Call update() once per
 * frame; the *Pressed fields are true only on the frame a button went down.
 */
export class PadState {
  connected = false;
  /** index of the controller we're reading, or -1 */
  index = -1;
  id = '';
  /** a button or stick moved this frame (used to switch on-screen hints to the controller) */
  touched = false;

  moveX = 0;
  moveY = 0; // forward is +
  yawRate = 0; // rad/s, + turns left (same sign as LocalPlayer.yaw)
  pitchRate = 0; // rad/s, + looks up

  fire = false;
  jump = false;
  sprint = false;
  crouch = false;
  /** lying down: hold B */
  prone = false;
  scoreboard = false;
  /** d-pad up held: push-to-talk */
  talk = false;
  reloadPressed = false;
  startPressed = false;
  aPressed = false;
  bPressed = false;
  /** menu navigation from the d-pad or left stick: set once per press, then repeating while held */
  nav: NavDir | null = null;

  private held: boolean[] = [];
  private prev: boolean[] = [];
  private lastStamp = -1;
  private edgeTime = 0;
  private sprintOn = false;
  /** how long B has been held (it's a tap, or a hold to lie down), -1 when up */
  private bHeld = -1;
  private navDir: NavDir | null = null;
  private navNext = 0;

  constructor(public settings: PadSettings) {}

  private down(i: number): boolean {
    return this.held[i] ?? false;
  }

  private pressed(i: number): boolean {
    return (this.held[i] ?? false) && !(this.prev[i] ?? false);
  }

  /** read `pad` (or null when there's none) for a frame lasting `dt` seconds */
  update(pad: PadLike | null, dt: number): void {
    this.touched = false;
    if (!pad || !pad.connected) {
      this.reset();
      return;
    }
    this.connected = true;
    this.index = pad.index;
    this.prev = this.held;
    this.held = pad.buttons.map((b, i) => (i === BTN.LT || i === BTN.RT ? b.value > TRIGGER_ON || b.pressed : b.pressed));
    if (pad.timestamp !== this.lastStamp && this.lastStamp >= 0) this.touched = this.anyActivity(pad);
    this.lastStamp = pad.timestamp;

    const m = radialDeadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0, MOVE_DEADZONE);
    this.moveX = m.x;
    this.moveY = -m.y; // stick up is -1

    const rx = pad.axes[2] ?? 0;
    const ry = pad.axes[3] ?? 0;
    const atEdge = Math.hypot(rx, ry) > 0.95 && Math.abs(rx) > 0.7; // boost only for turning, not looking up/down
    this.edgeTime = atEdge ? this.edgeTime + dt : 0;
    const look = lookRates(rx, ry, this.settings.sensitivity, turnBoost(this.edgeTime));
    this.yawRate = -look.yaw;
    this.pitchRate = this.settings.invertY ? look.pitch : -look.pitch;

    this.fire = this.down(BTN.RT) || this.down(BTN.RB);
    this.jump = this.down(BTN.A);
    // B: a tap crouches or stands (from lying down, a tap gets you up to a crouch); hold it to lie down
    if (this.down(BTN.B)) {
      if (this.bHeld >= 0) this.bHeld += dt;
      else if (this.pressed(BTN.B)) this.bHeld = 0;
      if (this.bHeld >= PRONE_HOLD && !this.prone) {
        this.prone = true;
        this.crouch = false;
        this.sprintOn = false;
        this.bHeld = Infinity; // used up: letting go doesn't also tap
      }
    } else if (this.bHeld >= 0) {
      if (this.bHeld < PRONE_HOLD) {
        if (this.prone) {
          this.prone = false;
          this.crouch = true;
        } else this.crouch = !this.crouch;
        if (this.crouch) this.sprintOn = false;
      }
      this.bHeld = -1;
    }
    if (this.pressed(BTN.R3)) {
      this.crouch = !this.crouch;
      this.prone = false;
      if (this.crouch) this.sprintOn = false;
    }
    // sprint: click the left stick (stays on until you stop moving) or hold LB
    if (this.pressed(BTN.L3)) {
      this.sprintOn = !this.sprintOn;
      if (this.sprintOn) this.crouch = false;
    }
    if (m.mag < 0.3) this.sprintOn = false;
    this.sprint = this.sprintOn || this.down(BTN.LB);
    if (this.sprint && this.down(BTN.LB)) this.crouch = this.prone = false;
    if (this.jump) this.crouch = this.prone = false;
    this.scoreboard = this.down(BTN.SELECT);
    this.talk = this.down(BTN.UP);
    this.reloadPressed = this.pressed(BTN.X);
    this.startPressed = this.pressed(BTN.START);
    this.aPressed = this.pressed(BTN.A);
    this.bPressed = this.pressed(BTN.B);
    this.updateNav(pad.axes[0] ?? 0, pad.axes[1] ?? 0, dt);
  }

  private updateNav(x: number, y: number, dt: number): void {
    let dir: NavDir | null = this.down(BTN.UP) ? 'up' : this.down(BTN.DOWN) ? 'down' : this.down(BTN.LEFT) ? 'left' : this.down(BTN.RIGHT) ? 'right' : null;
    if (!dir && Math.max(Math.abs(x), Math.abs(y)) > 0.6) dir = Math.abs(y) >= Math.abs(x) ? (y < 0 ? 'up' : 'down') : x < 0 ? 'left' : 'right';
    this.nav = null;
    if (dir !== this.navDir) {
      this.navDir = dir;
      this.nav = dir;
      this.navNext = NAV_DELAY;
    } else if (dir) {
      this.navNext -= dt;
      if (this.navNext <= 0) {
        this.nav = dir;
        this.navNext += NAV_REPEAT;
      }
    }
  }

  /** drop toggles (crouch, sprint) when play stops, so you don't come back crouched */
  clearToggles(): void {
    this.crouch = false;
    this.prone = false;
    this.bHeld = -1;
    this.sprintOn = false;
    this.edgeTime = 0;
  }

  private anyActivity(pad: PadLike): boolean {
    for (let i = 0; i < this.held.length; i++) if (this.held[i] !== (this.prev[i] ?? false)) return true;
    if (this.held.some(Boolean)) return true;
    return pad.axes.some((a) => Math.abs(a) > 0.3);
  }

  private reset(): void {
    this.connected = false;
    this.index = -1;
    this.id = '';
    this.moveX = this.moveY = this.yawRate = this.pitchRate = 0;
    this.fire = this.jump = this.sprint = this.crouch = this.prone = this.scoreboard = this.talk = false;
    this.bHeld = -1;
    this.reloadPressed = this.startPressed = this.aPressed = this.bPressed = false;
    this.nav = this.navDir = null;
    this.held = [];
    this.prev = [];
    this.lastStamp = -1;
    this.edgeTime = 0;
    this.sprintOn = false;
  }
}

/** the browser side: finds the controller to use each frame and plays rumble on it */
export class Gamepads {
  readonly state: PadState;
  private active = -1;
  private stamps = new Map<number, number>();
  /** called when a controller appears (true) or the one we were using goes away (false) */
  onChange: (connected: boolean, id: string) => void = () => {};

  constructor(settings: PadSettings) {
    this.state = new PadState(settings);
    const supported = typeof navigator !== 'undefined' && 'getGamepads' in navigator;
    if (!supported) return;
    window.addEventListener('gamepadconnected', (e) => {
      if (this.active < 0) this.active = e.gamepad.index;
      this.onChange(true, e.gamepad.id);
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad.index !== this.active) return;
      this.active = -1;
      this.onChange(false, e.gamepad.id);
    });
  }

  get supported(): boolean {
    return typeof navigator !== 'undefined' && 'getGamepads' in navigator;
  }

  update(dt: number): void {
    const pad = this.pick();
    this.state.update(pad, dt);
    this.state.id = pad?.id ?? '';
  }

  rumble(kind: Rumble): void {
    if (!this.state.settings.vibration || this.active < 0) return;
    const pad = this.list()[this.active] as (Gamepad & { vibrationActuator?: GamepadHapticActuator | null }) | null;
    const act = pad?.vibrationActuator;
    if (!act || typeof act.playEffect !== 'function') return; // no rumble in this browser (or controller)
    act.playEffect('dual-rumble', RUMBLES[kind]).catch(() => {});
  }

  private list(): (Gamepad | null)[] {
    if (!this.supported) return [];
    try {
      return [...navigator.getGamepads()];
    } catch {
      return []; // blocked by a permissions policy
    }
  }

  /** the controller that was used most recently (a second controller takes over once you use it) */
  private pick(): (PadLike & { id: string }) | null {
    let best: Gamepad | null = null;
    for (const p of this.list()) {
      if (!p || !p.connected) continue;
      const before = this.stamps.get(p.index);
      this.stamps.set(p.index, p.timestamp);
      if (before !== undefined && before !== p.timestamp && p.index !== this.active && hasInput(p)) this.active = p.index;
      if (p.index === this.active) best = p;
      else if (this.active < 0 && !best) best = p;
    }
    if (best && this.active < 0) this.active = best.index;
    return best;
  }
}

function hasInput(p: Gamepad): boolean {
  return p.buttons.some((b) => b.pressed) || p.axes.some((a) => Math.abs(a) > 0.3);
}

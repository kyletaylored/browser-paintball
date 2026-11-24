// On-screen controls for phones and tablets (touch screens with no mouse), shown while playing unless
// a controller is connected:
//
//  - move: a stick that appears wherever your thumb lands on the left half; push it well past its
//    ring to sprint
//  - aim: drag anywhere on the right half (or on the Fire button, so you can aim while firing)
//  - buttons: Fire (hold), Jump, Crouch and Lie down (tap to toggle or hold, like C and Z), Reload
//
// Input (src/input.ts) reads these alongside the keyboard and controller. Pointer events, so it also
// works with a mouse in a desktop browser's phone emulation.

/** the stick's ring, in CSS pixels */
export const STICK_RADIUS = 56;
/** a thumb this close to where it landed (as a fraction of the ring) doesn't move you */
export const STICK_DEADZONE = 0.12;
/** pushed this far out (as a multiple of the ring) you sprint */
export const SPRINT_PAST = 1.3;
/** a finger dragged this many pixels turns you as far as the mouse moving that many counts */
export const TOUCH_LOOK = 1.4;

/**
 * The stick's output from how far the thumb is from where it landed (dx right, dy down, pixels):
 * x right and y forward, -1..1, radial (diagonals are as fast as straight), easing in past the
 * deadzone; sprint when pushed past SPRINT_PAST.
 */
export function stickVector(dx: number, dy: number, radius = STICK_RADIUS): { x: number; y: number; sprint: boolean } {
  const d = Math.hypot(dx, dy) / radius;
  if (d <= STICK_DEADZONE) return { x: 0, y: 0, sprint: false };
  const m = Math.min(1, (d - STICK_DEADZONE) / (1 - STICK_DEADZONE));
  return { x: (dx / (d * radius)) * m, y: (-dy / (d * radius)) * m, sprint: d >= SPRINT_PAST };
}

/** keep getting a finger's moves after it slides off what it pressed (not every pointer can be captured) */
function capture(el: HTMLElement, e: PointerEvent): void {
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    // fine: it just stops at the element's edge
  }
}

export interface TouchHandlers {
  /** the Crouch button went down (true) or up (false) */
  crouch(down: boolean): void;
  prone(down: boolean): void;
}

export class TouchControls {
  moveX = 0;
  moveY = 0;
  sprint = false;
  fire = false;
  jump = false;
  /** pressed since the last frame */
  jumpPressed = false;
  reloadPressed = false;
  shown = false;

  private el: HTMLElement;
  private stick: HTMLElement;
  private knob: HTMLElement;
  private stickId = -1;
  private origin = { x: 0, y: 0 };
  /** fingers aiming: where each was last */
  private aiming = new Map<number, { x: number; y: number }>();
  private dx = 0;
  private dy = 0;
  private crouchBtn: HTMLElement;
  private proneBtn: HTMLElement;

  constructor(parent: HTMLElement, private handlers: TouchHandlers) {
    this.el = document.createElement('div');
    this.el.id = 'touch';
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="tzone move"></div>
      <div class="tzone aim"></div>
      <div class="tstick" hidden><div class="knob"></div></div>
      <button type="button" class="tbtn fire" aria-label="Fire">Fire</button>
      <button type="button" class="tbtn jump" aria-label="Jump">Jump</button>
      <button type="button" class="tbtn crouch" aria-label="Crouch">Crouch</button>
      <button type="button" class="tbtn prone" aria-label="Lie down">Lie</button>
      <button type="button" class="tbtn reload" aria-label="Reload">Reload</button>`;
    // underneath the other on-screen buttons (Menu, Talk), so they still get their taps
    parent.prepend(this.el);
    const q = (s: string) => this.el.querySelector(s) as HTMLElement;
    this.stick = q('.tstick');
    this.knob = q('.knob');
    this.crouchBtn = q('.crouch');
    this.proneBtn = q('.prone');

    // moving
    const move = q('.move');
    move.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this.stickId >= 0) return;
      this.stickId = e.pointerId;
      capture(move, e);
      this.origin = { x: e.clientX, y: e.clientY };
      this.stick.style.left = `${e.clientX}px`;
      this.stick.style.top = `${e.clientY}px`;
      this.stick.hidden = false;
      this.moveStick(e.clientX, e.clientY);
    });
    move.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickId) this.moveStick(e.clientX, e.clientY);
    });
    const endStick = (e: PointerEvent) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = -1;
      this.stick.hidden = true;
      this.moveX = this.moveY = 0;
      this.sprint = false;
    };
    move.addEventListener('pointerup', endStick);
    move.addEventListener('pointercancel', endStick);

    // aiming, on the right half and on the Fire button
    const aimFrom = (target: HTMLElement, onDown?: () => void, onUp?: () => void) => {
      target.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        capture(target, e);
        this.aiming.set(e.pointerId, { x: e.clientX, y: e.clientY });
        onDown?.();
      });
      target.addEventListener('pointermove', (e) => {
        const last = this.aiming.get(e.pointerId);
        if (!last) return;
        this.dx += (e.clientX - last.x) * TOUCH_LOOK;
        this.dy += (e.clientY - last.y) * TOUCH_LOOK;
        last.x = e.clientX;
        last.y = e.clientY;
      });
      const end = (e: PointerEvent) => {
        if (this.aiming.delete(e.pointerId)) onUp?.();
      };
      target.addEventListener('pointerup', end);
      target.addEventListener('pointercancel', end);
    };
    aimFrom(q('.aim'));
    const fire = q('.fire');
    aimFrom(fire, () => this.press(fire, () => (this.fire = true)), () => this.release(fire, () => (this.fire = false)));

    // the other buttons
    const button = (sel: string, down: () => void, up: () => void = () => {}) => {
      const b = q(sel);
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        capture(b, e);
        this.press(b, down);
      });
      const end = () => this.release(b, up);
      b.addEventListener('pointerup', end);
      b.addEventListener('pointercancel', end);
    };
    button('.jump', () => (this.jump = this.jumpPressed = true), () => (this.jump = false));
    button('.crouch', () => this.handlers.crouch(true), () => this.handlers.crouch(false));
    button('.prone', () => this.handlers.prone(true), () => this.handlers.prone(false));
    button('.reload', () => (this.reloadPressed = true));
    // no long-press menus or text selection on the controls
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** show or hide the controls (letting go of everything when they hide) */
  setVisible(v: boolean): void {
    if (v === this.shown) return;
    this.shown = v;
    this.el.hidden = !v;
    document.body.classList.toggle('touchplay', v);
    if (!v) this.reset();
  }

  /** light up Crouch and Lie while they're on (tapped on, or held) */
  showStance(crouched: boolean, prone: boolean): void {
    this.crouchBtn.classList.toggle('on', crouched && !prone);
    this.proneBtn.classList.toggle('on', prone);
  }

  /** how far the aiming fingers moved since the last call, as mouse counts */
  takeLook(): { dx: number; dy: number } {
    const out = { dx: this.dx, dy: this.dy };
    this.dx = this.dy = 0;
    return out;
  }

  endFrame(): void {
    this.jumpPressed = false;
    this.reloadPressed = false;
  }

  /** let go of everything (back to the menu) */
  reset(): void {
    this.moveX = this.moveY = 0;
    this.sprint = this.fire = this.jump = this.jumpPressed = this.reloadPressed = false;
    this.stickId = -1;
    this.stick.hidden = true;
    this.aiming.clear();
    this.dx = this.dy = 0;
    for (const b of this.el.querySelectorAll('.tbtn')) b.classList.remove('down');
  }

  private moveStick(x: number, y: number): void {
    const dx = x - this.origin.x;
    const dy = y - this.origin.y;
    const v = stickVector(dx, dy);
    this.moveX = v.x;
    this.moveY = v.y;
    this.sprint = v.sprint;
    // the knob stays on the ring however far the thumb goes
    const d = Math.hypot(dx, dy);
    const k = d > STICK_RADIUS ? STICK_RADIUS / d : 1;
    this.knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    this.stick.classList.toggle('sprint', v.sprint);
  }

  private press(b: HTMLElement, f: () => void): void {
    b.classList.add('down');
    f();
  }

  private release(b: HTMLElement, f: () => void): void {
    b.classList.remove('down');
    f();
  }
}

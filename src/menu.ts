// The menus: main menu (over a slow flight around the field), pause, settings and controls.
// Plain DOM buttons, so mouse, touch and keyboard (Tab / arrows / Enter) work as usual; on top of
// that a controller moves the focus with the d-pad or left stick, A picks, B goes back, and left /
// right nudge sliders.

import type { PadState } from './gamepad';

export type Screen = 'main' | 'pause' | 'settings' | 'controls' | 'players';
/** what the game does when a menu button is picked; viaPad = it was picked with a controller */
export type MenuAction = 'online' | 'practice' | 'resume' | 'leave';

const $ = (id: string) => document.getElementById(id)!;
const SCREENS: readonly Screen[] = ['main', 'pause', 'settings', 'controls', 'players'];
/** screens reached from main or pause, with a Back button */
const SUB: readonly Screen[] = ['settings', 'controls', 'players'];

export class Menu {
  /** the screen showing, or null while playing */
  screen: Screen | null = 'main';
  private root = $('menu');
  /** where Back goes from settings / controls */
  private parent: Screen = 'main';
  private padClick = false;

  constructor(private onAction: (action: MenuAction, viaPad: boolean) => void) {
    this.root.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!btn || (btn as HTMLButtonElement).disabled) return;
      const viaPad = this.padClick;
      this.padClick = false;
      this.act(btn.dataset.act!, viaPad);
    });
    window.addEventListener('keydown', (e) => {
      if (this.screen === null) return;
      if (e.target instanceof HTMLInputElement && e.target.type === 'text') return; // typing a name
      if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
        e.preventDefault();
        this.move(e.code === 'ArrowDown' ? 1 : -1);
      } else if (e.code === 'Escape' || e.code === 'Backspace') {
        if (this.screen && SUB.includes(this.screen)) this.show(this.parent);
      }
    });
    // show the focus ring for controller navigation; the mouse or a tap hides it again
    window.addEventListener('pointerdown', () => this.root.classList.remove('pad-nav'));
    this.show('main');
  }

  get open(): boolean {
    return this.screen !== null;
  }

  show(screen: Screen | null): void {
    if (screen && SUB.includes(screen)) {
      if (this.screen === 'main' || this.screen === 'pause') this.parent = this.screen;
    }
    this.screen = screen;
    this.root.hidden = screen === null;
    this.root.classList.toggle('at-main', screen === 'main');
    for (const s of SCREENS) $(`m-${s}`).hidden = s !== screen;
    document.body.classList.toggle('at-main', screen === 'main');
    this.focusDefault();
  }

  /** focus the screen's first button for keyboard and controller users (not on touch: it'd look selected) */
  focusDefault(): void {
    if (!this.screen || matchMedia('(pointer: coarse)').matches) return;
    const els = this.focusables();
    // main / pause: the first big button (not the name box); settings: the first control
    const first = this.screen === 'main' || this.screen === 'pause' ? els.find((e) => e.classList.contains('mbtn')) ?? els[0] : els[0];
    first?.focus({ preventScroll: true });
  }

  /** controller navigation; call every frame while a menu is open */
  pad(p: PadState): void {
    if (!this.screen || !p.connected) return;
    const el = document.activeElement as HTMLElement | null;
    const inMenu = el && this.root.contains(el) && el !== this.root;
    if (p.nav || p.aPressed) this.root.classList.add('pad-nav');
    if (p.nav === 'down' || p.nav === 'up') {
      this.move(p.nav === 'down' ? 1 : -1);
    } else if ((p.nav === 'left' || p.nav === 'right') && inMenu && el instanceof HTMLInputElement && el.type === 'range') {
      const step = Number(el.step) || 1;
      el.value = String(Number(el.value) + (p.nav === 'right' ? step : -step));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if ((p.nav === 'left' || p.nav === 'right') && inMenu && el instanceof HTMLSelectElement) {
      el.selectedIndex = Math.max(0, Math.min(el.options.length - 1, el.selectedIndex + (p.nav === 'right' ? 1 : -1)));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (p.aPressed) {
      const target = inMenu ? el : this.focusables()[0];
      if (target instanceof HTMLButtonElement || (target instanceof HTMLInputElement && target.type === 'checkbox')) {
        this.padClick = true;
        target.click();
        this.padClick = false;
      } else target?.focus();
    }
    if (p.bPressed) {
      if (this.screen && SUB.includes(this.screen)) this.show(this.parent);
      else if (this.screen === 'pause') this.onAction('resume', true);
    }
    if (p.startPressed && this.screen === 'pause') this.onAction('resume', true);
  }

  private act(name: string, viaPad: boolean): void {
    if (name === 'settings' || name === 'controls' || name === 'players') this.show(name);
    else if (name === 'back') this.show(this.parent);
    else this.onAction(name as MenuAction, viaPad);
  }

  private focusables(): HTMLElement[] {
    if (!this.screen) return [];
    const els = $(`m-${this.screen}`).querySelectorAll<HTMLElement>('button, input, select');
    // tabindex -1: mouse and touch only (the field chooser's arrows; the select beside them takes left / right)
    return [...els].filter((e) => !(e as HTMLButtonElement).disabled && e.offsetParent !== null && e.tabIndex !== -1);
  }

  private move(dir: 1 | -1): void {
    const els = this.focusables();
    if (!els.length) return;
    const i = els.indexOf(document.activeElement as HTMLElement);
    const next = i < 0 ? (dir > 0 ? 0 : els.length - 1) : (i + dir + els.length) % els.length;
    els[next].focus();
    els[next].scrollIntoView({ block: 'nearest' });
  }
}

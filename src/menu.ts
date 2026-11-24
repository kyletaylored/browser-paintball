// The menus: main menu (over a slow flight around the field), pause, settings and controls.
// Plain DOM buttons, so mouse, touch and keyboard (Tab / arrows / Enter) work as usual; on top of
// that a controller moves the focus with the d-pad or left stick, A picks, B goes back, and left /
// right nudge sliders. The pause menu has two columns online: its buttons, and the votes (a tab for
// the field and one for the marker, each a grid of cards). Left / right (arrow keys or d-pad) switch
// tabs, move along a row of cards and step between the columns; up / down move by rows.

import type { PadState } from './gamepad';

export type Screen = 'main' | 'pause' | 'settings' | 'controls' | 'players';
/** what the game does when a menu button is picked; viaPad = it was picked with a controller */
export type MenuAction = 'online' | 'practice' | 'resume' | 'leave';

const $ = (id: string) => document.getElementById(id)!;

/** show one of the pause menu's vote tabs ('field' or 'mode') in its column */
export function showTab(col: HTMLElement, name: string): void {
  col.dataset.tab = name;
  for (const t of col.querySelectorAll<HTMLElement>('[role=tab]')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
}
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
      const tab = (e.target as HTMLElement).closest<HTMLElement>('[role=tab]');
      const col = tab?.closest<HTMLElement>('.pause-votes');
      if (tab && col) {
        showTab(col, tab.dataset.tab!);
        return;
      }
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
        this.step(e.code === 'ArrowDown' ? 'down' : 'up');
      } else if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && this.across(e.code === 'ArrowRight' ? 'right' : 'left')) {
        e.preventDefault();
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
      this.step(p.nav);
    } else if ((p.nav === 'left' || p.nav === 'right') && this.across(p.nav)) {
      // moved across the pause menu (tabs, cards, columns)
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

  /**
   * Up / down: on a vote card, a row up or down the grid (off the top to its tab); down from a tab,
   * its first card; anywhere else the next or previous control.
   */
  private step(dir: 'up' | 'down'): void {
    const el = document.activeElement as HTMLElement | null;
    // down from a tab: into its cards (not across to the other tab)
    if (el?.getAttribute('role') === 'tab' && dir === 'down') {
      const card = this.visible($('pause-votes').querySelectorAll<HTMLElement>('.vcard'))[0];
      if (card) return this.focus(card);
    }
    const grid = el?.classList.contains('vcard') ? el.parentElement : null;
    if (el && grid) {
      const cards = this.visible(grid.querySelectorAll<HTMLElement>('.vcard'));
      const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length || 1;
      const i = cards.indexOf(el) + (dir === 'down' ? cols : -cols);
      if (i >= 0 && i < cards.length) return this.focus(cards[i]);
      if (i < 0) return this.focus(this.activeTab());
      // below the last row: the last card if this row is short of it, else on past the grid
      const last = cards[cards.length - 1];
      if (Math.floor(cards.indexOf(el) / cols) < Math.floor((cards.length - 1) / cols)) return this.focus(last);
      last.focus(); // the last row: on past the grid from its last card
    }
    this.move(dir === 'down' ? 1 : -1);
  }

  /**
   * Left / right in the pause menu: on a tab, the other tab (left of the first goes back to the
   * buttons); on a card, along the row (left of the first column goes back to the buttons); on a
   * button, over to the votes. False if it's none of those (sliders and selects keep the keys).
   */
  private across(dir: 'left' | 'right'): boolean {
    if (this.screen !== 'pause') return false;
    const el = document.activeElement as HTMLElement | null;
    const col = $('pause-votes');
    if (!el || !this.root.contains(el) || col.hidden) return false;
    const back = () => this.focus(this.visible($('m-pause').querySelectorAll<HTMLElement>('.pause-side .mbtn'))[0]);
    if (el.getAttribute('role') === 'tab') {
      const tabs = this.visible(col.querySelectorAll<HTMLElement>('[role=tab]'));
      const t = tabs[tabs.indexOf(el) + (dir === 'right' ? 1 : -1)];
      if (t) {
        showTab(col, t.dataset.tab!);
        this.focus(t);
      } else if (dir === 'left') back();
      return true;
    }
    if (el.classList.contains('vcard') && el.parentElement) {
      const grid = el.parentElement;
      const cards = this.visible(grid.querySelectorAll<HTMLElement>('.vcard'));
      const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length || 1;
      const i = cards.indexOf(el);
      if (dir === 'left' && i % cols === 0) back();
      else this.focus(cards[i + (dir === 'right' ? 1 : -1)] ?? el);
      return true;
    }
    if (el.classList.contains('mbtn') && el.closest('.pause-side') && dir === 'right') {
      this.focus(this.activeTab());
      return true;
    }
    return false;
  }

  /** the pause menu's vote tab that's showing */
  private activeTab(): HTMLElement | undefined {
    const col = $('pause-votes');
    return this.visible(col.querySelectorAll<HTMLElement>('[role=tab]')).find((t) => t.dataset.tab === col.dataset.tab);
  }

  private visible(els: NodeListOf<HTMLElement>): HTMLElement[] {
    return [...els].filter((e) => e.offsetParent !== null);
  }

  private focus(el: HTMLElement | undefined): void {
    if (!el) return;
    el.focus();
    el.scrollIntoView({ block: 'nearest' });
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

// The HTML overlay on top of the canvas. Plain DOM, no framework.

const $ = (id: string) => document.getElementById(id)!;

export class Hud {
  readonly playButton = $('play');
  private overlay = $('overlay');
  private status = $('status');
  private statusText = this.status.querySelector('.txt')!;
  private ammo = $('ammo');
  private score = $('score');
  private out = $('out');
  private hitmarker = $('hitmarker');
  private toastEl = $('toast');
  private flash = $('flash');
  private toastTimer = 0;
  private last = { status: '', ammo: '', score: '', out: '' };

  setLocked(locked: boolean): void {
    this.overlay.hidden = locked;
  }

  setStatus(kind: 'connecting' | 'online' | 'offline', text: string): void {
    if (this.last.status === kind + text) return;
    this.last.status = kind + text;
    this.status.className = `chip ${kind}`;
    this.statusText.textContent = text;
  }

  setAmmo(n: number, max: number, reloading: boolean): void {
    const html = reloading ? `RELOADING<small>…</small>` : `${n}<small>/ ${max}</small>`;
    if (this.last.ammo === html) return;
    this.last.ammo = html;
    this.ammo.innerHTML = html;
  }

  setScore(html: string): void {
    if (this.last.score === html) return;
    this.last.score = html;
    this.score.innerHTML = html;
  }

  showOut(secondsLeft: number | null): void {
    const html = secondsLeft === null ? '' : `YOU'RE OUT<small>back in ${secondsLeft}…</small>`;
    if (this.last.out === html) return;
    this.last.out = html;
    this.out.hidden = secondsLeft === null;
    this.out.innerHTML = html;
  }

  hitMarker(): void {
    restart(this.hitmarker, 'show');
  }

  damageFlash(): void {
    restart(this.flash, 'show');
  }

  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 1800);
  }
}

/** replay a CSS animation */
function restart(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

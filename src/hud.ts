// The HTML overlay on top of the canvas. Plain DOM, no framework.

import type { SoundSystem } from './audio';
import { TEAM_NAMES, type RosterEntry, type Team } from '../shared/protocol';

const FEED_SECONDS = 5;
const FEED_MAX = 5;

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
  private banner = $('banner');
  private feed = $('feed');
  private board = $('board');
  private boardKey = '';
  private toastTimer = 0;
  private last = { status: '', ammo: '', score: '', out: '', banner: '' };

  /** volume slider + mute checkbox on the start screen */
  bindAudio(sound: SoundSystem): void {
    const vol = $('volume') as HTMLInputElement;
    const mute = $('mute') as HTMLInputElement;
    vol.value = String(Math.round(sound.volume * 100));
    mute.checked = sound.muted;
    vol.addEventListener('input', () => {
      sound.unlock();
      sound.setVolume(Number(vol.value) / 100);
      if (sound.muted && Number(vol.value) > 0) {
        sound.setMuted(false);
        mute.checked = false;
      }
    });
    vol.addEventListener('change', () => sound.play('shot', { volume: 0.5 })); // preview the level
    mute.addEventListener('change', () => {
      sound.unlock();
      sound.setMuted(mute.checked);
    });
  }

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

  /** "YOU'RE OUT" with a line under it, or null to hide */
  showOut(sub: string | null): void {
    const html = sub === null ? '' : `YOU'RE OUT<small>${sub}</small>`;
    if (this.last.out === html) return;
    this.last.out = html;
    this.out.hidden = sub === null;
    this.out.innerHTML = html;
  }

  /** name box on the start screen: shows `initial`, calls `onChange` with what the player typed */
  bindName(initial: string, onChange: (name: string) => void): void {
    const input = $('name') as HTMLInputElement;
    input.value = initial;
    const commit = () => onChange(input.value);
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
    });
  }

  /** "shooter ✕ victim" in the corner; mine = you were involved */
  killFeed(shooter: string, shooterTeam: Team, victim: string, victimTeam: Team, mine: boolean): void {
    const row = document.createElement('div');
    row.className = mine ? 'row mine' : 'row';
    const a = document.createElement('span');
    a.className = shooterTeam === 0 ? 'r' : 'b';
    a.textContent = shooter;
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '✕';
    const b = document.createElement('span');
    b.className = victimTeam === 0 ? 'r' : 'b';
    b.textContent = victim;
    row.append(a, x, b);
    this.feed.prepend(row);
    while (this.feed.children.length > FEED_MAX) this.feed.lastElementChild!.remove();
    window.setTimeout(() => row.remove(), FEED_SECONDS * 1000);
  }

  /** hold-Tab scoreboard; null hides it */
  setScoreboard(rows: RosterEntry[] | null, myId: number, score: [number, number]): void {
    if (!rows) {
      this.board.hidden = true;
      this.boardKey = '';
      return;
    }
    const key = JSON.stringify([rows, myId, score]);
    this.board.hidden = false;
    if (key === this.boardKey) return;
    this.boardKey = key;
    this.board.replaceChildren(
      ...([0, 1] as const).map((team) => {
        const col = document.createElement('section');
        col.className = team === 0 ? 'r' : 'b';
        const h = document.createElement('h2');
        h.textContent = `${TEAM_NAMES[team]} · ${score[team]}`;
        const table = document.createElement('table');
        const head = table.insertRow();
        for (const label of ['Player', 'Elims', 'Outs', 'Ping']) {
          const th = document.createElement('th');
          th.textContent = label;
          head.appendChild(th);
        }
        const mine = rows.filter((r) => r.team === team).sort((x, y) => y.k - x.k || x.d - y.d || x.id - y.id);
        for (const r of mine) {
          const tr = table.insertRow();
          if (r.id === myId) tr.className = 'me';
          for (const v of [r.name, String(r.k), String(r.d), r.bot ? 'BOT' : String(r.ping)]) tr.insertCell().textContent = v;
        }
        if (!mine.length) {
          const td = table.insertRow().insertCell();
          td.colSpan = 4;
          td.className = 'empty';
          td.textContent = 'no players';
        }
        col.append(h, table);
        return col;
      }),
    );
  }

  /** big centre text for countdowns and point results; null hides it */
  setBanner(html: string | null, kind = ''): void {
    const key = kind + (html ?? '');
    if (this.last.banner === key) return;
    this.last.banner = key;
    this.banner.hidden = html === null;
    this.banner.className = kind;
    this.banner.innerHTML = html ?? '';
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

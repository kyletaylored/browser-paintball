// The HTML overlay on top of the canvas. Plain DOM, no framework.

import type { SoundSystem } from './audio';
import type { PadSettings } from './gamepad';
import type { Device } from './input';
import { QUALITY_KEY, savedQuality, type Quality } from './render';
import { TEAM_NAMES, type RosterEntry, type Team } from '../shared/protocol';

const FEED_SECONDS = 5;
const FEED_MAX = 5;

const $ = (id: string) => document.getElementById(id)!;

export class Hud {
  readonly playButton = $('play');
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
  private loading = $('loading');
  private loadingBar = this.loading.querySelector('.bar') as HTMLElement;
  private toastTimer = 0;
  private last = { status: '', ammo: '', score: '', out: '', banner: '', controls: '' };
  private playLabel = 'Play online';

  /** model download progress (0..1), or null when done: the play button waits for it */
  setLoading(fraction: number | null): void {
    const btn = this.playButton as HTMLButtonElement;
    if (fraction === null) {
      this.loading.hidden = true;
      btn.disabled = false;
      btn.textContent = this.playLabel;
      return;
    }
    this.loading.hidden = false;
    btn.disabled = true;
    btn.textContent = `Loading… ${Math.round(fraction * 100)}%`;
    this.loadingBar.style.width = `${(fraction * 100).toFixed(1)}%`;
  }

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

  /**
   * What you're playing with: whether a controller was found (main menu) and the on-screen pause
   * button on touch screens, which have no Esc key.
   */
  setControls(_device: Device, padId: string | null, touch: boolean, playing: boolean): void {
    const key = [padId, touch, playing].join('|');
    if (this.last.controls === key) return;
    this.last.controls = key;
    $('menubtn').hidden = !(touch && playing);
    const line = $('padline');
    line.className = padId !== null ? 'padline ok' : 'padline';
    line.textContent = padId !== null
      ? `Controller ready: ${padName(padId)}`
      : touch
        ? 'Connect a controller (Bluetooth or clip-on), then press any button on it'
        : 'Got a controller? Connect it and press any button';
  }

  /** how many are on the field (main menu); null = couldn't reach the server */
  setFieldInfo(info: { players: number; bots: number } | null | 'checking'): void {
    const el = $('field-info');
    if (info === 'checking') {
      el.className = 'info';
      el.textContent = 'Checking the field…';
    } else if (info === null) {
      el.className = 'info';
      el.textContent = "Can't reach the game server right now. Practice works offline.";
    } else if (info.players > 0) {
      el.className = 'info live';
      el.textContent = `${info.players} playing now${info.bots ? `, plus ${info.bots} bot${info.bots === 1 ? '' : 's'}` : ''}`;
    } else {
      el.className = 'info';
      el.textContent = 'Nobody on the field yet: bots fill the teams until others join';
    }
  }

  /** the pause screen's note and whether it offers "Leave match" or "Back to main menu" */
  setPause(online: boolean): void {
    $('pause-note').textContent = online ? "You're still in the match: other players can see and hit you." : 'Practice is paused.';
    $('leave').textContent = online ? 'Leave match' : 'Main menu';
  }

  /** graphics quality picker; it takes effect after a reload, so say so when it changes */
  bindQuality(): void {
    const sel = $('quality') as HTMLSelectElement;
    const note = $('quality-note');
    const start = savedQuality();
    sel.value = start;
    sel.addEventListener('change', () => {
      try {
        localStorage.setItem(QUALITY_KEY, sel.value as Quality);
      } catch {
        // storage blocked: it just won't stick
      }
      note.textContent = sel.value === start ? 'Auto is high on computers and low on phones.' : 'Reload the page to switch.';
    });
  }

  /** controller settings on the start screen; `onChange` runs after `settings` is updated */
  bindPadSettings(settings: PadSettings, onChange: () => void): void {
    const sens = $('padsens') as HTMLInputElement;
    const inv = $('padinv') as HTMLInputElement;
    const vib = $('padvib') as HTMLInputElement;
    sens.value = String(settings.sensitivity);
    inv.checked = settings.invertY;
    vib.checked = settings.vibration;
    sens.addEventListener('input', () => {
      settings.sensitivity = Number(sens.value);
      onChange();
    });
    inv.addEventListener('change', () => {
      settings.invertY = inv.checked;
      onChange();
    });
    vib.addEventListener('change', () => {
      settings.vibration = vib.checked;
      onChange();
    });
  }

  /** the on-screen pause button (touch screens, where there's no Esc key) */
  bindMenuButton(onPress: () => void): void {
    $('menubtn').addEventListener('click', onPress);
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

/** "Wireless Controller (STANDARD GAMEPAD Vendor: 045e …)" → "Wireless Controller" */
function padName(id: string): string {
  const name = id.replace(/\(.*\)/g, '').replace(/STANDARD GAMEPAD/gi, '').replace(/\s+/g, ' ').trim();
  return (name || 'gamepad').slice(0, 40);
}

/** replay a CSS animation */
function restart(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

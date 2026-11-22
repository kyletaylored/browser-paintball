// The HTML overlay on top of the canvas. Plain DOM, no framework.

import type { SoundSystem } from './audio';
import type { PadSettings } from './gamepad';
import type { Device } from './input';
import { QUALITY_KEY, savedQuality, type Quality } from './render';
import { TEAM_NAMES, type RosterEntry, type Team } from '../shared/protocol';
import { MAP_LIST, MAPS, unanimousVote, voteWinner } from '../shared/maps';
import type { Voice, VoiceSettings } from './voice';

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
  /** the main menu's field picker (practice uses it; online, the server picks) */
  /**
   * The main menu's field chooser. It shows the field behind the menu, practice plays on it, and
   * online it's your vote, but only once you've changed it: untouched, it follows the server's field.
   */
  bindMapPicker(onPick: (id: string) => void): void {
    const sel = $('mapsel') as HTMLSelectElement;
    sel.replaceChildren(...MAP_LIST.map((m) => new Option(`${m.name} · ${m.length} × ${m.width} m`, m.id)));
    sel.addEventListener('change', () => {
      this.mapTouched = true;
      this.showBlurb();
      onPick(sel.value);
    });
    // the arrows beside a picker step through it (wrapping round)
    for (const b of document.querySelectorAll<HTMLButtonElement>('.fp-arrow')) {
      b.addEventListener('click', () => {
        const s = $(b.dataset.for!) as HTMLSelectElement;
        s.selectedIndex = (s.selectedIndex + Number(b.dataset.dir) + s.options.length) % s.options.length;
        s.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    this.showBlurb();
  }

  /** the player chose a field on the main menu (so Play online votes for it) */
  mapTouched = false;

  /** the field picked on the main menu */
  pickedMap(): string {
    return ($('mapsel') as HTMLSelectElement).value;
  }

  /** the field that's on (the server changed it, or we joined one); the chooser follows it until you pick one */
  setMap(id: string): void {
    const sel = $('mapsel') as HTMLSelectElement;
    if (!this.mapTouched && MAPS[id] && sel.value !== id) {
      sel.value = id;
      this.showBlurb();
    }
  }

  /** the pause menu's vote: "No preference" or a field */
  bindVote(onVote: (id: string | null) => void): void {
    const sel = $('votesel') as HTMLSelectElement;
    sel.replaceChildren(new Option('No preference', ''), ...MAP_LIST.map((m) => new Option(m.name, m.id)));
    sel.addEventListener('change', () => onVote(sel.value || null));
  }

  private voteKey = '';

  /**
   * Show the vote in the pause menu (online, when the server lets players choose), and say what the
   * votes will do. Returns the line for the scoreboard ("Arena · next: Woods").
   */
  setVote(show: boolean, rows: RosterEntry[], myId: number, current: string): string {
    const name = MAPS[current]?.name ?? '';
    $('vote-box').hidden = !show;
    if (!show) return name;
    const humans = rows.filter((r) => !r.bot);
    const votes = humans.map((r) => r.vote ?? null);
    const mine = humans.find((r) => r.id === myId)?.vote ?? '';
    const now = unanimousVote(votes, current);
    const next = voteWinner(votes, current);
    const key = JSON.stringify([votes, mine, current]);
    if (key !== this.voteKey) {
      this.voteKey = key;
      const sel = $('votesel') as HTMLSelectElement;
      if (document.activeElement !== sel) sel.value = mine;
      const count = new Map<string, number>();
      for (const v of votes) if (v) count.set(v, (count.get(v) ?? 0) + 1);
      const tally = [...count].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${MAPS[id]?.name} ${n}`).join(', ');
      $('vote-info').textContent = now
        ? `Everyone wants ${MAPS[now].name}: switching after this point.`
        : `${tally ? `Votes: ${tally}. ` : ''}After this match: ${MAPS[next]?.name}.${humans.length > 1 ? ' If everyone votes the same field, it switches after the point.' : ''}`;
    }
    return now ? `${name} · switching to ${MAPS[now].name}` : `${name} · next: ${MAPS[next]?.name}`;
  }

  private showBlurb(): void {
    $('map-blurb').textContent = MAPS[this.pickedMap()]?.blurb ?? '';
  }

  /**
   * The line under Play online: how busy the server is and on which field, and what pressing Play
   * does about the field you picked (votes for it, or nothing if the server always plays one field).
   */
  setFieldInfo(info: { players: number; bots: number; map: string | null; vote: boolean } | null | 'checking'): void {
    const el = $('field-info');
    if (info === 'checking') {
      el.className = 'info';
      el.textContent = 'Checking the field…';
    } else if (info === null) {
      el.className = 'info';
      el.textContent = "Can't reach the game server right now. Practice works offline.";
    } else if (info.players > 0) {
      el.className = 'info live';
      el.textContent = `${info.players} playing now${info.map ? ` on ${info.map}` : ''}${info.bots ? `, plus ${info.bots} bot${info.bots === 1 ? '' : 's'}` : ''}`;
    } else {
      el.className = 'info';
      el.textContent = `Nobody on the field yet${info.map ? ` (${info.map} is up next)` : ''}: bots fill the teams until others join`;
    }
    const picked = MAPS[this.pickedMap()]?.name;
    if (!picked || !info || info === 'checking' || !info.map) return;
    if (!info.vote) el.textContent += `. This server always plays ${info.map}.`;
    else if (this.mapTouched && picked !== info.map) {
      el.textContent += info.players > 0
        ? `. Play online votes for ${picked}.`
        : `. Play online switches it to ${picked}.`;
    }
  }

  /** the pause screen's note and whether it offers "Leave match" or "Back to main menu" */
  setPause(online: boolean): void {
    $('pause-note').textContent = online ? "You're still in the match: other players can see and hit you." : 'Practice is paused.';
    $('leave').textContent = online ? 'Leave match' : 'Main menu';
    $('players-btn').hidden = !online;
  }

  /** graphics quality picker; it takes effect after a reload, so say so when it changes */
  /** Settings: first or third person; onChange also runs when the key or right stick switches it (via setView) */
  bindView(view: string, onChange: (v: string) => void): void {
    const sel = $('viewsel') as HTMLSelectElement;
    sel.value = view;
    sel.addEventListener('change', () => onChange(sel.value));
  }

  setView(view: string): void {
    ($('viewsel') as HTMLSelectElement).value = view;
  }

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

  // ---- voice ------------------------------------------------------------------------------

  /** voice settings, and the Talk button (held on phones) */
  bindVoice(settings: VoiceSettings, onChange: () => void, onTalk: (held: boolean) => void): void {
    const on = $('voiceon') as HTMLInputElement;
    const vol = $('voicevol') as HTMLInputElement;
    on.checked = settings.enabled;
    vol.value = String(Math.round(settings.volume * 100));
    on.addEventListener('change', () => {
      settings.enabled = on.checked;
      onChange();
    });
    vol.addEventListener('input', () => {
      settings.volume = Number(vol.value) / 100;
      onChange();
    });
    const btn = $('voice');
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      onTalk(true);
    });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) btn.addEventListener(ev, () => onTalk(false));
  }

  /** the server has voice: show its settings */
  setVoiceAvailable(on: boolean): void {
    $('voice-settings').hidden = !on;
  }

  private voiceKey = '';
  private playersKey = '';

  /** the talk chip at the bottom: hidden unless voice is up and you're playing */
  setVoice(v: Voice, playing: boolean, touch: boolean): void {
    const btn = $('voice');
    const show = playing && v.available && v.settings.enabled && v.state !== 'off';
    const who = v.teamOnly ? 'team' : 'everyone';
    let text: string;
    if (v.state === 'idle') text = 'Voice: nobody else here yet';
    else if (v.state === 'connecting') text = 'Voice: connecting…';
    else if (v.state === 'failed') text = "Voice: can't connect";
    else if (v.talking) text = `● Talking to ${who}`;
    else text = touch ? `Hold to talk (${who})` : `Hold V to talk (${who})`;
    const key = [show, text, v.talking, v.state].join('|');
    if (this.voiceKey === key) return;
    this.voiceKey = key;
    btn.hidden = !show;
    btn.textContent = text;
    btn.classList.toggle('talking', v.talking);
    btn.classList.toggle('failed', v.state === 'failed');
  }

  /** the pause menu's Players screen: both teams, with a mute button for each other human */
  setPlayers(rows: RosterEntry[], myId: number, voice: Voice, onMute: (id: number) => void): void {
    const key = JSON.stringify([rows, myId, [...voice.speaking], [...voice.muted], voice.available]);
    if (this.playersKey === key) return;
    this.playersKey = key;
    const root = $('players');
    const focused = (document.activeElement as HTMLElement | null)?.dataset.mute;
    root.replaceChildren(
      ...([0, 1] as const).map((team) => {
        const col = document.createElement('section');
        col.className = team === 0 ? 'r' : 'b';
        const h = document.createElement('h3');
        h.textContent = TEAM_NAMES[team];
        col.append(h);
        const mine = rows.filter((r) => r.team === team).sort((a, b) => b.k - a.k || a.id - b.id);
        for (const r of mine) {
          const row = document.createElement('div');
          row.className = 'player-row';
          const who = document.createElement('span');
          who.className = voice.speaking.has(r.id) ? 'who speaking' : 'who';
          who.textContent = r.id === myId ? `${r.name} (you)` : r.name;
          const stat = document.createElement('span');
          stat.className = 'stat';
          stat.textContent = r.bot ? 'bot' : `${r.k} / ${r.d}`;
          row.append(who, stat);
          if (voice.available && !r.bot && r.id !== myId) {
            const b = document.createElement('button');
            b.type = 'button';
            b.dataset.mute = String(r.id);
            const muted = voice.muted.has(r.id);
            b.setAttribute('aria-pressed', String(muted));
            b.textContent = muted ? 'Muted' : 'Mute';
            b.addEventListener('click', () => onMute(r.id));
            row.append(b);
          }
          col.append(row);
        }
        if (!mine.length) {
          const p = document.createElement('p');
          p.className = 'note';
          p.textContent = 'no players';
          col.append(p);
        }
        return col;
      }),
    );
    // keep the controller's place when the list redraws
    if (focused) (root.querySelector(`[data-mute="${focused}"]`) as HTMLElement | null)?.focus();
  }

  /** hold-Tab scoreboard; null hides it */
  setScoreboard(rows: RosterEntry[] | null, myId: number, score: [number, number], mapName = '', speaking: ReadonlySet<number> = new Set()): void {
    if (!rows) {
      this.board.hidden = true;
      this.boardKey = '';
      return;
    }
    const key = JSON.stringify([rows, myId, score, mapName, [...speaking]]);
    this.board.hidden = false;
    if (key === this.boardKey) return;
    this.boardKey = key;
    const title = document.createElement('p');
    title.className = 'map';
    title.textContent = mapName ? `Field: ${mapName}` : '';
    this.board.replaceChildren(
      title,
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
          if (speaking.has(r.id)) tr.cells[0].className = 'speaking';
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

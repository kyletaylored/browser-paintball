// WebSocket client. Keeps a short history of snapshots for each other player so they can be
// drawn slightly in the past, smoothly interpolated, instead of jumping 20 times a second.

import type { ClientMsg, ServerMsg, PlayerSnap, RosterEntry, RoundState, Spawn, Team, InputFrame } from '../shared/protocol';
import { decodeServer, encodeInput } from '../shared/codec';
import { FakeLink, fakeNumber } from '../shared/netsim';
import { BrowserFastLink } from './fastlink';
import { DEFAULT_FIRE_MODE, isFireMode, type FireMode } from '../shared/fire';

export interface RemotePlayer {
  id: number;
  team: Team;
  samples: { at: number; s: PlayerSnap }[];
}

export interface NetEvents {
  welcome(id: number, team: Team, spawn: Spawn, map: string): void;
  /** the server moved to another field */
  map(id: string): void;
  /** the server changed the firing mode (it's in net.mode) */
  mode(): void;
  ball(m: Extract<ServerMsg, { t: 'ball' }>): void;
  hit(m: Extract<ServerMsg, { t: 'hit' }>): void;
  /** a ball bounced off a player without breaking */
  bounce(m: Extract<ServerMsg, { t: 'bounce' }>): void;
  respawn(spawn: Spawn): void;
  /** someone (maybe us) stepped into a teammate bot */
  takeover(m: Extract<ServerMsg, { t: 'takeover' }>): void;
  ack(m: Extract<ServerMsg, { t: 'ack' }>): void;
  /** a voice server token (asked for with { t: 'voice' }) */
  voice(url: string, token: string): void;
  disconnected(): void;
}

/** idle: not trying (main menu, practice); connecting / online / offline: playing online */
export type NetStatus = 'idle' | 'connecting' | 'online' | 'offline';

/**
 * Development only: ?lag=150 fakes 150 ms of round-trip latency (half each way) and ?loss=2 loses 2% of
 * messages each way, the way TCP does: held up for about a round trip along with everything behind
 * them (see shared/netsim.ts). Use them together to see how prediction and interpolation cope.
 * Stripped from production builds.
 */
const params = import.meta.env.DEV ? new URLSearchParams(location.search) : null;
export const FAKE_LAG_MS = fakeNumber(params?.get('lag'), 2000);
export const FAKE_LOSS_PCT = fakeNumber(params?.get('loss'), 50);
/** development only: ?rtc=0 stays on the WebSocket (no data channel), to compare the two */
const USE_RTC = params?.get('rtc') !== '0';
/** input frames repeated in every data channel packet, so a lost packet loses none (15 bytes each) */
const INPUT_REDUNDANCY = 12;

/** snapshot timing since joining, for the dev network overlay (src/netstats.ts) */
export interface SnapTiming {
  /** when the last snapshot arrived (performance.now ms), 0 before the first */
  last: number;
  /** longest gap between two snapshots, ms */
  longest: number;
  /** gaps longer than 100 ms (twice the normal 50): the interpolation buffer runs dry in those */
  over100: number;
  count: number;
  since: number;
}

export class Net {
  status: NetStatus = 'idle';
  id = -1;
  team: Team = 0;
  score: [number, number] = [0, 0];
  /** the server has team voice chat */
  voice = false;
  /** players choose the field by voting (false when the server pins one) */
  votes = false;
  /** the server's firing mode, and whether players vote for it */
  mode: FireMode = DEFAULT_FIRE_MODE;
  modeVotes = false;
  /** everyone in the latest snapshot, you included (who's still in, for the score bar) */
  players: PlayerSnap[] = [];
  /** latest match state from the server, and when it arrived (performance.now ms) */
  round: RoundState | null = null;
  roundAt = 0;
  readonly remotes = new Map<number, RemotePlayer>();
  /** names and stats for everyone, including you */
  readonly roster = new Map<number, RosterEntry>();
  private ws: WebSocket | null = null;
  /** fake network each way (development only; inactive otherwise) */
  private up = new FakeLink(FAKE_LAG_MS, FAKE_LOSS_PCT);
  private down = new FakeLink(FAKE_LAG_MS, FAKE_LOSS_PCT);
  /** and on the data channel, where a lost message is just gone */
  private fastUp = new FakeLink(FAKE_LAG_MS, FAKE_LOSS_PCT, false);
  private fastDown = new FakeLink(FAKE_LAG_MS, FAKE_LOSS_PCT, false);
  /** the data channel for snapshots, acks and input frames; the WebSocket carries them until it opens */
  fast: BrowserFastLink | null = null;
  /** the last few input frames sent, repeated in each data channel packet */
  private recentInputs: InputFrame[] = [];
  /** newest snapshot and ack sequence numbers seen: older ones (out of order on the data channel) are skipped */
  private lastSnapSeq = -1;
  private lastAckSeq = -1;
  readonly timing: SnapTiming = { last: 0, longest: 0, over100: 0, count: 0, since: 0 };
  private retryTimer = 0;
  /** we want to be connected (Play online); false after stop() */
  private wanted = false;

  constructor(private url: string, private ev: NetEvents, private getName: () => string) {}

  /** join the match (and keep reconnecting if the connection drops) */
  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.retryDelay = 3000;
    this.status = 'connecting';
    this.connect();
  }

  /** leave the match: close the connection and stop retrying */
  stop(): void {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    this.reset();
    this.status = 'idle';
    ws?.close(1000, 'left');
  }

  /** tell the server our (new) name */
  sendName(): void {
    this.send({ t: 'hello', name: this.getName() });
  }

  nameOf(id: number): string {
    return this.roster.get(id)?.name ?? `Player ${id}`;
  }

  /** bytes received so far (for the dev stats) */
  bytesIn = 0;
  bytesOut = 0;

  send(m: ClientMsg): void {
    if (m.t === 'input' && this.fast?.open) {
      // data channel: each packet repeats the last few frames, so losing one loses no input (the
      // server skips frames it has already applied)
      const recent = this.recentInputs;
      recent.push(...m.i);
      if (recent.length > INPUT_REDUNDANCY) recent.splice(0, recent.length - INPUT_REDUNDANCY);
      const data = encodeInput(recent);
      const fast = this.fast;
      if (this.fastUp.active) {
        this.bytesOut += data.byteLength;
        this.fastUp.send(() => fast.send(data));
        return;
      }
      if (fast.send(data)) {
        this.bytesOut += data.byteLength;
        return;
      }
      // backed up: this batch goes over the WebSocket instead
    }
    // input frames go 60 times a second: binary; the rest is rare, so JSON
    const data = m.t === 'input' ? encodeInput(m.i) : JSON.stringify(m);
    this.bytesOut += typeof data === 'string' ? data.length : data.byteLength;
    if (this.up.active) {
      const ws = this.ws;
      this.up.send(() => ws?.readyState === WebSocket.OPEN && ws.send(data));
    } else if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  private reset(): void {
    this.fast?.close();
    this.fast = null;
    this.recentInputs = [];
    this.lastSnapSeq = -1;
    this.lastAckSeq = -1;
    this.id = -1;
    this.voice = false;
    this.votes = false;
    this.modeVotes = false;
    this.round = null;
    this.players = [];
    this.score = [0, 0];
    this.remotes.clear();
    this.roster.clear();
  }

  private connect(): void {
    if (!this.wanted) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.status = 'offline';
      this.retry();
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      let m: ServerMsg;
      try {
        if (typeof e.data === 'string') {
          this.bytesIn += e.data.length;
          m = JSON.parse(e.data);
        } else {
          this.bytesIn += (e.data as ArrayBuffer).byteLength;
          m = decodeServer(e.data as ArrayBuffer);
        }
      } catch {
        return;
      }
      if (this.down.active) this.down.send(() => this.ws === ws && this.handle(m));
      else this.handle(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // we closed it on purpose (stop())
      const wasOnline = this.status === 'online';
      this.ws = null;
      this.status = 'offline';
      this.reset();
      if (wasOnline) this.ev.disconnected();
      this.retry();
    };
  }

  private retryDelay = 3000;

  /** ask for a data channel (after joining); snapshots and acks arriving on it go through handle() too */
  private openFast(): void {
    this.fast?.close();
    this.fast = null;
    if (!USE_RTC) return;
    const ws = this.ws;
    const fast = new BrowserFastLink(
      (m) => this.send(m),
      (data) => {
        if (this.ws !== ws || this.fast !== fast) return;
        this.bytesIn += data.byteLength;
        let m: ServerMsg;
        try {
          m = decodeServer(data);
        } catch {
          return;
        }
        if (this.fastDown.active) this.fastDown.send(() => this.ws === ws && this.handle(m));
        else this.handle(m);
      },
      () => {},
    );
    this.fast = fast;
    fast.request();
  }

  /** keep trying, backing off to every 15 s so a missing server doesn't flood the console */
  private retry(): void {
    clearTimeout(this.retryTimer);
    if (!this.wanted) return;
    this.retryTimer = window.setTimeout(() => this.connect(), this.retryDelay);
    this.retryDelay = Math.min(15000, this.retryDelay * 1.5);
  }

  private handle(m: ServerMsg): void {
    if (!this.wanted) return;
    switch (m.t) {
      case 'welcome':
        this.status = 'online';
        this.retryDelay = 3000;
        this.id = m.id;
        this.team = m.team;
        this.voice = m.voice === true;
        this.votes = m.vote === true;
        this.mode = isFireMode(m.mode) ? m.mode : DEFAULT_FIRE_MODE;
        this.modeVotes = m.modeVote === true;
        this.round = m.round;
        this.roundAt = performance.now();
        Object.assign(this.timing, { last: 0, longest: 0, over100: 0, count: 0, since: this.roundAt });
        this.sendName();
        this.openFast();
        this.ev.welcome(m.id, m.team, m.spawn, m.map);
        break;
      case 'roster':
        this.roster.clear();
        for (const r of m.players) this.roster.set(r.id, r);
        break;
      case 'ping':
        this.send({ t: 'pong', s: m.s });
        break;
      case 'ack':
        if (m.seq < this.lastAckSeq) break; // older than one we've used (out of order on the data channel)
        this.lastAckSeq = m.seq;
        this.ev.ack(m);
        break;
      case 'rtc':
        if (typeof m.sdp === 'string') void this.fast?.offer(m.sdp);
        break;
      case 'ice':
        this.fast?.candidate(m.c, m.mid);
        break;
      case 'voice':
        if (typeof m.url === 'string' && typeof m.token === 'string') this.ev.voice(m.url, m.token);
        break;
      case 'snap': {
        if (m.seq <= this.lastSnapSeq) break; // older than one we have: skip it
        this.lastSnapSeq = m.seq;
        const now = performance.now();
        const t = this.timing;
        if (t.last) {
          const gap = now - t.last;
          t.longest = Math.max(t.longest, gap);
          if (gap > 100) t.over100++;
        }
        t.last = now;
        t.count++;
        this.score = m.score;
        this.round = m.round;
        this.roundAt = now;
        this.players = m.players;
        const seen = new Set<number>();
        for (const p of m.players) {
          if (p.id === this.id) continue;
          seen.add(p.id);
          let r = this.remotes.get(p.id);
          if (!r) {
            r = { id: p.id, team: p.team, samples: [] };
            this.remotes.set(p.id, r);
          }
          r.samples.push({ at: now, s: p });
          if (r.samples.length > 30) r.samples.shift();
        }
        for (const id of this.remotes.keys()) if (!seen.has(id)) this.remotes.delete(id);
        break;
      }
      case 'ball':
        this.ev.ball(m);
        break;
      case 'hit':
        this.ev.hit(m);
        break;
      case 'bounce':
        if (Array.isArray(m.p) && m.p.length === 3) this.ev.bounce(m);
        break;
      case 'respawn':
        this.ev.respawn(m.spawn);
        break;
      case 'takeover':
        if (Array.isArray(m.b) && m.b.length === 8) this.ev.takeover(m);
        break;
      case 'leave':
        this.remotes.delete(m.id);
        break;
      case 'map':
        this.remotes.clear(); // everyone's about to respawn on the new field
        this.ev.map(m.id);
        break;
      case 'mode':
        if (isFireMode(m.mode)) this.mode = m.mode;
        this.ev.mode();
        break;
    }
  }
}

/** seconds left in the current phase, counting down smoothly between snapshots */
export function phaseSecondsLeft(net: Net, now: number): number {
  if (!net.round) return 0;
  return Math.max(0, net.round.endsIn - (now - net.roundAt) / 1000);
}

/** where a remote player was at local time `at` (ms), blended between the two snapshots around it */
export function sampleRemote(r: RemotePlayer, at: number): PlayerSnap | null {
  const s = r.samples;
  if (!s.length) return null;
  if (at <= s[0].at) return s[0].s;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i].at > at) continue;
    const a = s[i];
    const b = s[i + 1];
    if (!b) return a.s;
    const k = (at - a.at) / (b.at - a.at);
    const A = a.s;
    const B = b.s;
    if (Math.hypot(B.x - A.x, B.z - A.z) > 3) return k < 0.5 ? A : B; // teleport (respawn): don't slide across the field
    let dyaw = B.yaw - A.yaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw)); // shortest way round
    return {
      ...B,
      x: A.x + (B.x - A.x) * k,
      y: A.y + (B.y - A.y) * k,
      z: A.z + (B.z - A.z) * k,
      yaw: A.yaw + dyaw * k,
      pitch: A.pitch + (B.pitch - A.pitch) * k,
    };
  }
  return s[s.length - 1].s;
}

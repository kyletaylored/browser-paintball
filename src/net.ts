// WebSocket client. Keeps a short history of snapshots for each other player so they can be
// drawn slightly in the past, smoothly interpolated, instead of jumping 20 times a second.

import type { ClientMsg, ServerMsg, PlayerSnap, RosterEntry, RoundState, Spawn, Team } from '../shared/protocol';
import { decodeServer, encodeInput } from '../shared/codec';

export interface RemotePlayer {
  id: number;
  team: Team;
  samples: { at: number; s: PlayerSnap }[];
}

export interface NetEvents {
  welcome(id: number, team: Team, spawn: Spawn): void;
  ball(m: Extract<ServerMsg, { t: 'ball' }>): void;
  hit(m: Extract<ServerMsg, { t: 'hit' }>): void;
  respawn(spawn: Spawn): void;
  ack(m: Extract<ServerMsg, { t: 'ack' }>): void;
  disconnected(): void;
}

/** idle: not trying (main menu, practice); connecting / online / offline: playing online */
export type NetStatus = 'idle' | 'connecting' | 'online' | 'offline';

/**
 * Development only: add ?lag=150 to the URL to fake 150 ms of round-trip latency (half each way),
 * to see how prediction and interpolation cope. Stripped from production builds.
 */
const FAKE_LAG_MS = import.meta.env.DEV ? Math.max(0, Number(new URLSearchParams(location.search).get('lag')) || 0) : 0;

export class Net {
  status: NetStatus = 'idle';
  id = -1;
  team: Team = 0;
  score: [number, number] = [0, 0];
  /** latest match state from the server, and when it arrived (performance.now ms) */
  round: RoundState | null = null;
  roundAt = 0;
  readonly remotes = new Map<number, RemotePlayer>();
  /** names and stats for everyone, including you */
  readonly roster = new Map<number, RosterEntry>();
  private ws: WebSocket | null = null;
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
    // input frames go 60 times a second: binary; the rest is rare, so JSON
    const data = m.t === 'input' ? encodeInput(m.i) : JSON.stringify(m);
    this.bytesOut += typeof data === 'string' ? data.length : data.byteLength;
    if (FAKE_LAG_MS) {
      const ws = this.ws;
      setTimeout(() => ws?.readyState === WebSocket.OPEN && ws.send(data), FAKE_LAG_MS / 2);
    } else if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  private reset(): void {
    this.id = -1;
    this.round = null;
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
      if (FAKE_LAG_MS) setTimeout(() => this.ws === ws && this.handle(m), FAKE_LAG_MS / 2);
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
        this.round = m.round;
        this.roundAt = performance.now();
        this.sendName();
        this.ev.welcome(m.id, m.team, m.spawn);
        break;
      case 'roster':
        this.roster.clear();
        for (const r of m.players) this.roster.set(r.id, r);
        break;
      case 'ping':
        this.send({ t: 'pong', s: m.s });
        break;
      case 'ack':
        this.ev.ack(m);
        break;
      case 'snap': {
        const now = performance.now();
        this.score = m.score;
        this.round = m.round;
        this.roundAt = now;
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
      case 'respawn':
        this.ev.respawn(m.spawn);
        break;
      case 'leave':
        this.remotes.delete(m.id);
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

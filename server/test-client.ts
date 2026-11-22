// Fake players for the server tests (server/smoke-test.ts) and the network measurement
// (server/net-measure.ts): they join over a real WebSocket, walk with real input frames, and see
// other players the way a browser does. Asked to, they open a data channel like a browser too.

import WebSocket from 'ws';
import { spawn, type ChildProcess } from 'node:child_process';
import { PeerConnection, type DataChannel } from 'node-datachannel';
import type { ClientMsg, ServerMsg, Team, InputFrame } from '../shared/protocol';
import { decodeServer, encodeInput, quantizeInput } from '../shared/codec';
import { INPUT_DT, STAND_HEIGHT, stepMovement, type Body, type MoveInput } from '../shared/sim';
import { FakeLink } from '../shared/netsim';

export type Snap = Extract<ServerMsg, { t: 'snap' }>;
export type Roster = Extract<ServerMsg, { t: 'roster' }>;
export type Hit = Extract<ServerMsg, { t: 'hit' }>;
export interface Client {
  ws: WebSocket;
  id: number;
  team: Team;
  inbox: ServerMsg[];
  /** our own prediction of where we are, run with the same code the server uses */
  body: Body;
  yaw: number;
  seq: number;
  /** snapshots with the (local) time they arrived, for drawing others like a browser does */
  snaps: { at: number; m: Snap }[];
  /** the data channel, when join() was asked for one (like the browser's src/fastlink.ts) */
  fast: FastState | null;
}
export type Ack = Extract<ServerMsg, { t: 'ack' }>;

export interface FastState {
  pc: PeerConnection | null;
  dc: DataChannel | null;
  open: boolean;
  /** the server sent an offer */
  offered: boolean;
  /** unreliable fake network each way: a lost message is just gone */
  up: FakeLink;
  down: FakeLink;
  /** the last few input frames, repeated in every packet */
  recent: InputFrame[];
  /** snapshots that arrived on the data channel / on the WebSocket */
  via: { fast: number; ws: number };
}

/** input frames repeated in every data channel packet (the browser does the same) */
const INPUT_REDUNDANCY = 12;

/** fake network per socket, each way, like the browser's ?lag= and ?loss= (shared/netsim.ts) */
const linkOf = new WeakMap<WebSocket, { up: FakeLink; down: FakeLink; fast: FastState | null }>();

/**
 * Connect a fake player. `lagMs` round trip and `lossPct` loss each way are faked on our side: TCP-style
 * on the WebSocket, dropped on the data channel. `rtc` asks the server for a data channel, like a browser.
 */
export function join(url: string, lagMs = 0, lossPct = 0, rtc = false): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const fast: FastState | null = rtc
      ? {
          pc: null, dc: null, open: false, offered: false, recent: [], via: { fast: 0, ws: 0 },
          up: new FakeLink(lagMs, lossPct, false), down: new FakeLink(lagMs, lossPct, false),
        }
      : null;
    const link = { up: new FakeLink(lagMs, lossPct), down: new FakeLink(lagMs, lossPct), fast };
    linkOf.set(ws, link);
    const inbox: ServerMsg[] = [];
    const snaps: { at: number; m: Snap }[] = [];
    let lastSnap = -1;
    let lastAck = -1;
    ws.on('error', reject);
    const handle = (m: ServerMsg, onFast: boolean) => {
      // the data channel can deliver out of order: skip anything older than what we have, like the browser
      if (m.t === 'snap') {
        if (m.seq <= lastSnap) return;
        lastSnap = m.seq;
        if (fast) fast.via[onFast ? 'fast' : 'ws']++;
      } else if (m.t === 'ack') {
        if (m.seq < lastAck) return;
        lastAck = m.seq;
      }
      inbox.push(m);
      if (m.t === 'snap') snaps.push({ at: performance.now(), m });
      if (m.t === 'ping') send(ws, { t: 'pong', s: m.s });
      if (m.t === 'rtc' && fast && !fast.pc) answerOffer(ws, fast, m.sdp, (d) => handle(d, true));
      if (m.t === 'ice') fast?.pc?.addRemoteCandidate(m.c, m.mid);
      if (m.t === 'welcome') {
        const sp = m.spawn;
        if (fast) send(ws, { t: 'rtc' });
        resolve({
          ws, id: m.id, team: m.team, inbox, snaps, yaw: sp.yaw, seq: 0, fast,
          body: { x: sp.x, y: sp.y, z: sp.z, vx: 0, vy: 0, vz: 0, height: STAND_HEIGHT, onGround: true },
        });
      }
    };
    ws.on('message', (data, isBinary) => {
      // snapshots, acks and balls arrive as binary frames, the rest as JSON, just like in the browser
      const m = isBinary ? decodeServer(data as Buffer) : (JSON.parse(data.toString()) as ServerMsg);
      if (link.down.active) link.down.send(() => handle(m, false));
      else handle(m, false);
    });
    ws.on('close', () => closeFast(fast));
  });
}

function closeFast(fast: FastState | null) {
  if (!fast) return;
  fast.open = false;
  try {
    fast.dc?.close();
    fast.pc?.close();
  } catch {
    // already closed
  }
}

/** answer the server's data channel offer, the way src/fastlink.ts does in the browser */
function answerOffer(ws: WebSocket, fast: FastState, sdp: string, deliver: (m: ServerMsg) => void) {
  fast.offered = true;
  const pc = new PeerConnection('test-client', { iceServers: [] });
  fast.pc = pc;
  pc.onLocalDescription((answer, type) => {
    if (type === 'answer') send(ws, { t: 'rtc', sdp: answer });
  });
  pc.onLocalCandidate((c, mid) => send(ws, { t: 'ice', c, mid }));
  pc.onDataChannel((dc) => {
    fast.dc = dc;
    dc.onOpen(() => (fast.open = true));
    if (dc.isOpen()) fast.open = true;
    dc.onClosed(() => (fast.open = false));
    dc.onMessage((msg) => {
      if (typeof msg === 'string') return;
      const m = decodeServer(Buffer.isBuffer(msg) ? msg : Buffer.from(msg));
      if (fast.down.active) fast.down.send(() => deliver(m));
      else deliver(m);
    });
  });
  pc.setRemoteDescription(sdp, 'offer');
}

/** wait until the client's data channel is open; false if it didn't open in time */
export async function fastOpen(c: Client, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (c.fast?.open) return true;
    await wait(20);
  }
  return false;
}

export function send(ws: WebSocket, m: ClientMsg) {
  const link = linkOf.get(ws);
  const fast = link?.fast;
  if (m.t === 'input' && fast?.open && fast.dc) {
    fast.recent.push(...m.i);
    if (fast.recent.length > INPUT_REDUNDANCY) fast.recent.splice(0, fast.recent.length - INPUT_REDUNDANCY);
    const data = encodeInput(fast.recent);
    const dc = fast.dc;
    const out = () => {
      if (dc.isOpen()) dc.sendMessageBinary(data);
    };
    if (fast.up.active) fast.up.send(out);
    else out();
    return;
  }
  const data = m.t === 'input' ? encodeInput(m.i) : JSON.stringify(m);
  if (link?.up.active) link.up.send(() => ws.readyState === ws.OPEN && ws.send(data));
  else ws.send(data);
}

/** where `c` sees player `id` at local time `at`: blended between snapshots, exactly like the browser */
export function viewOf(c: Client, id: number, at: number): { x: number; z: number } | null {
  const s = c.snaps;
  for (let i = s.length - 1; i > 0; i--) {
    if (s[i - 1].at > at) continue;
    const a = s[i - 1].m.players.find((p) => p.id === id);
    const b = s[i].m.players.find((p) => p.id === id);
    if (!a || !b) return null;
    const k = Math.min(1, (at - s[i - 1].at) / (s[i].at - s[i - 1].at));
    return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
  }
  return null;
}
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function waitFor<T extends ServerMsg>(
  inbox: ServerMsg[], pred: (m: ServerMsg) => m is T, ms: number, from = 0,
): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (let i = inbox.length - 1; i >= from; i--) if (pred(inbox[i])) return inbox[i] as T;
    await wait(20);
  }
  return null;
}
/**
 * Walk to (x, z) the way a browser would: one input frame per INPUT_DT, sent in real time, predicted
 * locally with stepMovement. Stops and settles when close.
 */
export async function walkTo(c: Client, x: number, z: number, sprint = false, prone = false): Promise<void> {
  const move: MoveInput = { forward: 0, right: 0, jump: false, sprint, crouch: false, prone, yaw: c.yaw };
  let settle = 0;
  for (let n = 0; n < 120 * 15 && settle < 40; ) {
    const batch: InputFrame[] = [];
    for (let k = 0; k < 4; k++, n++) {
      const dx = x - c.body.x;
      const dz = z - c.body.z;
      const d = Math.hypot(dx, dz);
      // world direction → forward/right for our yaw (forward = (-sin, -cos), right = (cos, -sin))
      const s = Math.sin(c.yaw);
      const co = Math.cos(c.yaw);
      const go = d > 0.12 ? Math.min(1, d / 0.6) : 0;
      // round to what the wire carries before predicting, exactly like the browser does
      const q = quantizeInput(go ? ((dx * -s + dz * -co) / d) * go : 0, go ? ((dx * co + dz * -s) / d) * go : 0, c.yaw, 0);
      move.forward = q.forward;
      move.right = q.right;
      move.yaw = q.yaw;
      if (!go) settle++;
      stepMovement(c.body, move, INPUT_DT);
      batch.push([++c.seq, move.forward, move.right, (sprint ? 2 : 0) | (prone ? 8 : 0), move.yaw, 0]);
    }
    send(c.ws, { t: 'input', i: batch });
    await wait(INPUT_DT * 4 * 1000);
  }
}
export const lastAck = (c: Client) => [...c.inbox].reverse().find((m): m is Ack => m.t === 'ack' && m.seq === c.seq);

export const snapWhere = (f: (m: Snap) => boolean) => (m: ServerMsg): m is Snap => m.t === 'snap' && f(m);
export const rosterWhere = (f: (m: Roster) => boolean) => (m: ServerMsg): m is Roster => m.t === 'roster' && f(m);

/** start server/index.ts on a spare port with extra environment variables */
export async function startServer(env: Record<string, string>): Promise<{ url: string; stop: () => void }> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    // short breaks between points, so the tests don't wait on the camera shots (a test can still set it)
    env: { ...process.env, PORT: String(port), POINT_PAUSE_SECONDS: '3', MATCH_OVER_SECONDS: '6', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout!.on('data', (d) => (log += d));
  child.stderr!.on('data', (d) => (log += d));
  const end = Date.now() + 15000;
  while (!log.includes('server on ws://')) {
    if (Date.now() > end || child.exitCode !== null) {
      child.kill();
      throw new Error(`server didn't start:\n${log}`);
    }
    await wait(50);
  }
  return { url: `ws://localhost:${port}`, stop: () => child.kill() };
}


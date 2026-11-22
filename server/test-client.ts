// Fake players for the server tests (server/smoke-test.ts) and the network measurement
// (server/net-measure.ts): they join over a real WebSocket, walk with real input frames, and see
// other players the way a browser does.

import WebSocket from 'ws';
import { spawn, type ChildProcess } from 'node:child_process';
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
}
export type Ack = Extract<ServerMsg, { t: 'ack' }>;

/** fake network per socket, each way, like the browser's ?lag= and ?loss= (shared/netsim.ts) */
const linkOf = new WeakMap<WebSocket, { up: FakeLink; down: FakeLink }>();

/** connect a fake player; `lagMs` round trip and `lossPct` TCP-style loss each way are faked on our side */
export function join(url: string, lagMs = 0, lossPct = 0): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const link = { up: new FakeLink(lagMs, lossPct), down: new FakeLink(lagMs, lossPct) };
    linkOf.set(ws, link);
    const inbox: ServerMsg[] = [];
    const snaps: { at: number; m: Snap }[] = [];
    ws.on('error', reject);
    const handle = (m: ServerMsg) => {
      inbox.push(m);
      if (m.t === 'snap') snaps.push({ at: performance.now(), m });
      if (m.t === 'ping') send(ws, { t: 'pong', s: m.s });
      if (m.t === 'welcome') {
        const sp = m.spawn;
        resolve({
          ws, id: m.id, team: m.team, inbox, snaps, yaw: sp.yaw, seq: 0,
          body: { x: sp.x, y: sp.y, z: sp.z, vx: 0, vy: 0, vz: 0, height: STAND_HEIGHT, onGround: true },
        });
      }
    };
    ws.on('message', (data, isBinary) => {
      // snapshots, acks and balls arrive as binary frames, the rest as JSON, just like in the browser
      const m = isBinary ? decodeServer(data as Buffer) : (JSON.parse(data.toString()) as ServerMsg);
      if (link.down.active) link.down.send(() => handle(m));
      else handle(m);
    });
  });
}
export function send(ws: WebSocket, m: ClientMsg) {
  const data = m.t === 'input' ? encodeInput(m.i) : JSON.stringify(m);
  const link = linkOf.get(ws);
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
export async function walkTo(c: Client, x: number, z: number, sprint = false): Promise<void> {
  const move: MoveInput = { forward: 0, right: 0, jump: false, sprint, crouch: false, yaw: c.yaw };
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
      batch.push([++c.seq, move.forward, move.right, sprint ? 2 : 0, move.yaw, 0]);
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
    env: { ...process.env, PORT: String(port), ...env },
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


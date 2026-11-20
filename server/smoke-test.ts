// Headless check that the server works end to end: two fake players join, the countdown runs,
// Red shoots Blue, the server reports the hit, Red wins the point, and the next point starts.
// Run with the server already going:  npm run test:server

import WebSocket from 'ws';
import { DEFAULT_PORT, cleanName, type ClientMsg, type ServerMsg, type Team } from '../shared/protocol';
import { STAND_HEIGHT, EYE_FROM_TOP } from '../shared/sim';

const URL = process.env.SERVER_URL ?? `ws://localhost:${DEFAULT_PORT}`;

function join(): Promise<{ ws: WebSocket; id: number; team: Team; inbox: ServerMsg[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const inbox: ServerMsg[] = [];
    ws.on('error', reject);
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as ServerMsg;
      inbox.push(m);
      if (m.t === 'welcome') resolve({ ws, id: m.id, team: m.team, inbox });
    });
  });
}
const send = (ws: WebSocket, m: ClientMsg) => ws.send(JSON.stringify(m));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T extends ServerMsg>(
  inbox: ServerMsg[], pred: (m: ServerMsg) => m is T, ms: number, from = 0,
): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = inbox.slice(from).find(pred);
    if (m) return m;
    await wait(20);
  }
  return null;
}

const a = await join();
const b = await join();
console.log(`joined: player ${a.id} team ${a.team}, player ${b.id} team ${b.team}`);
if (a.team === b.team) throw new Error('expected the two players on opposite teams (is someone else connected?)');
const [shooter, target] = a.team === 0 ? [a, b] : [b, a];

// names: one ordinary, one full of control/zero-width characters and far too long
const NASTY = '  \u0000Sh\u200booter\n\t<b>with a very long name</b>  ';
const EXPECTED = cleanName(NASTY);
send(shooter.ws, { t: 'hello', name: NASTY });
send(target.ws, { t: 'hello', name: 'Target' });

type Snap = Extract<ServerMsg, { t: 'snap' }>;
const isSnap = (m: ServerMsg): m is Snap => m.t === 'snap';
const snapWhere = (f: (m: Snap) => boolean) => (m: ServerMsg): m is Snap => isSnap(m) && f(m);

// With one player per team the server starts a countdown, then the point goes live.
const live = await waitFor(shooter.inbox, snapWhere((m) => m.round.phase === 'live'), 8000);

// Stand them 5 m apart with nothing in between.
send(shooter.ws, { t: 'state', x: -17, y: 0, z: -2.5, yaw: -Math.PI / 2, pitch: 0, c: false });
send(target.ws, { t: 'state', x: -12, y: 0, z: -2.5, yaw: Math.PI / 2, pitch: 0, c: false });
await wait(150);

const eyeY = STAND_HEIGHT - EYE_FROM_TOP;
const d = [5, 1.2 - eyeY, 0];
const len = Math.hypot(d[0], d[1], d[2]);
const dir: [number, number, number] = [d[0] / len, d[1] / len, d[2] / len];
send(shooter.ws, { t: 'fire', o: [-17 + dir[0] * 0.35, eyeY + dir[1] * 0.35, -2.5], d: dir });

const hit = await waitFor(shooter.inbox, (m): m is Extract<ServerMsg, { t: 'hit' }> => m.t === 'hit', 1000);
const sawBall = target.inbox.some((m) => m.t === 'ball');
const afterHit = target.inbox.length;
const point = await waitFor(
  shooter.inbox,
  snapWhere((m) => m.round.phase === 'point' && m.round.winner === shooter.team && m.score[shooter.team] === 1),
  1000,
);
// the next point resets everyone to their start box
const respawn = await waitFor(target.inbox, (m): m is Extract<ServerMsg, { t: 'respawn' }> => m.t === 'respawn', 6000, afterHit);
type Roster = Extract<ServerMsg, { t: 'roster' }>;
const stats = await waitFor(
  target.inbox,
  (m): m is Roster => m.t === 'roster' &&
    m.players.some((p) => p.id === shooter.id && p.name === EXPECTED && p.k === 1) &&
    m.players.some((p) => p.id === target.id && p.name === 'Target' && p.d === 1),
  1000,
);
const next = await waitFor(target.inbox, snapWhere((m) => m.round.phase === 'countdown' && m.round.round === 2), 1000, afterHit);

a.ws.close();
b.ws.close();

const checks = [
  ['countdown ran and the point went live', live !== null],
  ['target was told about the ball', sawBall],
  ['server reported the hit', hit?.victim === target.id && hit?.shooter === shooter.id],
  ["shooter's team won the point", point !== null],
  ['target respawned for the next point', respawn !== null],
  ['point 2 countdown started', next !== null],
  [`names cleaned ("${EXPECTED}") and stats counted in the roster`, stats !== null && EXPECTED === 'Shooter<b>with a'],
  ['server sent a latency probe', target.inbox.some((m) => m.t === 'ping')],
] as const;
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);

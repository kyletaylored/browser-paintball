// Headless check that the server works end to end: two fake players join, Red shoots Blue,
// and we expect the server to report the hit, then respawn Blue.
// Run with the server already going:  npm run test:server

import WebSocket from 'ws';
import { DEFAULT_PORT, type ClientMsg, type ServerMsg } from '../shared/protocol';
import { STAND_HEIGHT, EYE_FROM_TOP } from '../shared/sim';

const URL = process.env.SERVER_URL ?? `ws://localhost:${DEFAULT_PORT}`;

function join(): Promise<{ ws: WebSocket; id: number; team: number; inbox: ServerMsg[] }> {
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
async function waitFor<T extends ServerMsg>(inbox: ServerMsg[], pred: (m: ServerMsg) => m is T, ms: number): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = inbox.find(pred);
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
const respawn = await waitFor(target.inbox, (m): m is Extract<ServerMsg, { t: 'respawn' }> => m.t === 'respawn', 4500);

a.ws.close();
b.ws.close();

const checks = [
  ['target was told about the ball', sawBall],
  ['server reported the hit', hit?.victim === target.id && hit?.shooter === shooter.id],
  ['target respawned', respawn !== null],
] as const;
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);

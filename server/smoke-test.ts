// Headless end-to-end checks for the game server. Starts its own servers on spare ports, so
// nothing else needs to be running:  npm run test:server
//
//  1. Rules (bots off): two fake players join, the countdown runs, Red shoots Blue, the server
//     reports the hit, Red wins the point, the next point starts; names get cleaned; stats count.
//  2. Bots: one fake player joins, bots fill both teams, move off their start box and play the
//     point out; a second player takes a bot's place.
//
// Set SERVER_URL to run only the rules check against a server you started yourself (bots off).

import WebSocket from 'ws';
import { spawn, type ChildProcess } from 'node:child_process';
import { cleanName, type ClientMsg, type ServerMsg, type Team } from '../shared/protocol';
import { STAND_HEIGHT, EYE_FROM_TOP } from '../shared/sim';

type Snap = Extract<ServerMsg, { t: 'snap' }>;
type Roster = Extract<ServerMsg, { t: 'roster' }>;
type Hit = Extract<ServerMsg, { t: 'hit' }>;
interface Client {
  ws: WebSocket;
  id: number;
  team: Team;
  inbox: ServerMsg[];
}

const results: [string, boolean][] = [];
const check = (name: string, ok: boolean) => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
};

function join(url: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox: ServerMsg[] = [];
    ws.on('error', reject);
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as ServerMsg;
      inbox.push(m);
      if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', s: m.s }));
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
    for (let i = inbox.length - 1; i >= from; i--) if (pred(inbox[i])) return inbox[i] as T;
    await wait(20);
  }
  return null;
}
const snapWhere = (f: (m: Snap) => boolean) => (m: ServerMsg): m is Snap => m.t === 'snap' && f(m);
const rosterWhere = (f: (m: Roster) => boolean) => (m: ServerMsg): m is Roster => m.t === 'roster' && f(m);

/** start server/index.ts on a spare port with extra environment variables */
async function startServer(env: Record<string, string>): Promise<{ url: string; stop: () => void }> {
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

// ---- 1. rules ------------------------------------------------------------------------------

async function rulesTest(url: string) {
  console.log('-- rules (bots off)');
  const a = await join(url);
  const b = await join(url);
  if (a.team === b.team) throw new Error('expected the two players on opposite teams (is someone else connected?)');
  const [shooter, target] = a.team === 0 ? [a, b] : [b, a];

  // names: one ordinary, one full of control/zero-width characters and far too long
  const NASTY = '  \u0000Sh​ooter\n\t<b>with a very long name</b>  ';
  const EXPECTED = cleanName(NASTY);
  send(shooter.ws, { t: 'hello', name: NASTY });
  send(target.ws, { t: 'hello', name: 'Target' });

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

  const hit = await waitFor(shooter.inbox, (m): m is Hit => m.t === 'hit', 1000);
  const sawBall = target.inbox.some((m) => m.t === 'ball');
  const afterHit = target.inbox.length;
  const point = await waitFor(
    shooter.inbox,
    snapWhere((m) => m.round.phase === 'point' && m.round.winner === shooter.team && m.score[shooter.team] === 1),
    1000,
  );
  // the next point resets everyone to their start box
  const respawn = await waitFor(target.inbox, (m): m is Extract<ServerMsg, { t: 'respawn' }> => m.t === 'respawn', 6000, afterHit);
  const stats = await waitFor(
    target.inbox,
    rosterWhere((m) =>
      m.players.some((p) => p.id === shooter.id && p.name === EXPECTED && p.k === 1) &&
      m.players.some((p) => p.id === target.id && p.name === 'Target' && p.d === 1)),
    1000,
  );
  const next = await waitFor(target.inbox, snapWhere((m) => m.round.phase === 'countdown' && m.round.round === 2), 1000, afterHit);
  a.ws.close();
  b.ws.close();

  check('countdown ran and the point went live', live !== null);
  check('target was told about the ball', sawBall);
  check('server reported the hit', hit?.victim === target.id && hit?.shooter === shooter.id);
  check("shooter's team won the point", point !== null);
  check('target respawned for the next point', respawn !== null);
  check('point 2 countdown started', next !== null);
  check(`names cleaned ("${EXPECTED}") and stats counted in the roster`, stats !== null && EXPECTED === 'Shooter<b>with a');
  check('server sent a latency probe', target.inbox.some((m) => m.t === 'ping'));
}

// ---- 2. bots -------------------------------------------------------------------------------

async function botTest(url: string) {
  console.log('-- bots (2 per team, hard)');
  const human = await join(url);
  send(human.ws, { t: 'hello', name: 'Human' });
  // a fake player who just stands in their start box

  const filled = await waitFor(
    human.inbox,
    rosterWhere((m) => m.players.filter((p) => p.bot).length === 3 && [0, 1].every((t) => m.players.filter((p) => p.team === t).length === 2)),
    3000,
  );
  check('bots fill both teams to 2 around one human', filled !== null);

  const live = await waitFor(human.inbox, snapWhere((m) => m.round.phase === 'live'), 8000);
  check('point went live with bots', live !== null);
  const liveAt = human.inbox.length;
  const botIds = new Set(filled?.players.filter((p) => p.bot).map((p) => p.id) ?? []);
  const start = new Map(live?.players.map((p) => [p.id, p]) ?? []);

  const moved = await waitFor(
    human.inbox,
    snapWhere((m) => m.players.some((p) => botIds.has(p.id) && start.has(p.id) && Math.hypot(p.x - start.get(p.id)!.x, p.z - start.get(p.id)!.z) > 3)),
    10000,
    liveAt,
  );
  check('bots leave their start box', moved !== null);

  const botHit = await waitFor(human.inbox, (m): m is Hit => m.t === 'hit' && botIds.has(m.shooter), 60000, liveAt);
  check('a bot eliminates someone', botHit !== null);
  const decided = await waitFor(human.inbox, snapWhere((m) => m.round.phase === 'point' || m.round.phase === 'matchover'), 90000, liveAt);
  check(`the point is played out (${decided ? `winner ${decided.round.winner}` : 'timed out'})`, decided !== null);

  // a second human takes a bot's place
  const before = human.inbox.length;
  const second = await join(url);
  const replaced = await waitFor(
    human.inbox,
    rosterWhere((m) => m.players.filter((p) => p.bot).length === 2 && m.players.filter((p) => !p.bot).length === 2),
    3000,
    before,
  );
  check('a joining human replaces a bot', replaced !== null);
  second.ws.close();
  human.ws.close();
}

// ---- run -----------------------------------------------------------------------------------

try {
  if (process.env.SERVER_URL) {
    await rulesTest(process.env.SERVER_URL);
  } else {
    const rules = await startServer({ BOT_TEAM_SIZE: '0' });
    try {
      await rulesTest(rules.url);
    } finally {
      rules.stop();
    }
    const bots = await startServer({ BOT_TEAM_SIZE: '2', BOT_SKILL: 'hard' });
    try {
      await botTest(bots.url);
    } finally {
      bots.stop();
    }
  }
} catch (e) {
  console.error(e);
  check('test ran to the end', false);
}
process.exit(results.every(([, ok]) => ok) ? 0 : 1);

// Headless end-to-end checks for the game server. Starts its own servers on spare ports, so
// nothing else needs to be running:  npm run test:server
//
//  1. Rules (bots off): two fake players join, the countdown runs, Red shoots Blue, the server
//     reports the hit, Red wins the point, the next point starts; names get cleaned; stats count.
//  2. Lag compensation: a shooter with 150 ms of round trip shoots a target walking across in
//     front of them, aiming where their (interpolated, delayed) view shows it. With compensation it
//     hits; with LAG_COMPENSATION=0 the same shot misses.
//  3. Bots: one fake player joins, bots fill both teams, move off their start box and play the
//     point out; a second player takes a bot's place.
//
// Set SERVER_URL to run only the rules check against a server you started yourself (bots off).

import WebSocket from 'ws';
import { spawn, type ChildProcess } from 'node:child_process';
import { cleanName, type ClientMsg, type ServerMsg, type Team, type InputFrame } from '../shared/protocol';
import { EYE_FROM_TOP, INPUT_DT, STAND_HEIGHT, stepMovement, type Body, type MoveInput } from '../shared/sim';

type Snap = Extract<ServerMsg, { t: 'snap' }>;
type Roster = Extract<ServerMsg, { t: 'roster' }>;
type Hit = Extract<ServerMsg, { t: 'hit' }>;
interface Client {
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
type Ack = Extract<ServerMsg, { t: 'ack' }>;

const results: [string, boolean][] = [];
const check = (name: string, ok: boolean) => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
};

/** fake round-trip latency per socket (half each way), like the browser's ?lag= */
const lagOf = new WeakMap<WebSocket, number>();

function join(url: string, lagMs = 0): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    lagOf.set(ws, lagMs);
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
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as ServerMsg;
      if (lagMs) setTimeout(() => handle(m), lagMs / 2);
      else handle(m);
    });
  });
}
function send(ws: WebSocket, m: ClientMsg) {
  const data = JSON.stringify(m);
  const lag = lagOf.get(ws) ?? 0;
  if (lag) setTimeout(() => ws.readyState === ws.OPEN && ws.send(data), lag / 2);
  else ws.send(data);
}

/** where `c` sees player `id` at local time `at`: blended between snapshots, exactly like the browser */
function viewOf(c: Client, id: number, at: number): { x: number; z: number } | null {
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
/**
 * Walk to (x, z) the way a browser would: one input frame per INPUT_DT, sent in real time, predicted
 * locally with stepMovement. Stops and settles when close.
 */
async function walkTo(c: Client, x: number, z: number, sprint = false): Promise<void> {
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
      move.forward = go ? ((dx * -s + dz * -co) / d) * go : 0;
      move.right = go ? ((dx * co + dz * -s) / d) * go : 0;
      if (!go) settle++;
      stepMovement(c.body, move, INPUT_DT);
      batch.push([++c.seq, move.forward, move.right, sprint ? 2 : 0, c.yaw, 0]);
    }
    send(c.ws, { t: 'input', i: batch });
    await wait(INPUT_DT * 4 * 1000);
  }
}
const lastAck = (c: Client) => [...c.inbox].reverse().find((m): m is Ack => m.t === 'ack' && m.seq === c.seq);

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

  // An old-style "I'm over here now" message must not move anyone any more.
  const before = { x: target.body.x, z: target.body.z };
  target.ws.send(JSON.stringify({ t: 'state', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, c: false }));

  // Walk them (with real input frames, in real time) to 5 m apart with nothing in between.
  await Promise.all([walkTo(shooter, -17, -2.5), walkTo(target, -12, -2.5, true)]);
  await wait(200); // let the acks for the last frames arrive
  const sAck = lastAck(shooter);
  const tAck = lastAck(target);
  const agree = (c: Client, a: Ack | undefined) =>
    a !== undefined && Math.hypot(a.b[0] - c.body.x, a.b[1] - c.body.y, a.b[2] - c.body.z) < 1e-6;
  const teleported = tAck !== undefined && Math.hypot(tAck.b[0], tAck.b[2]) < 1; // the fake 'state' put it at 0,0
  check('server ignores an old-style position message', !teleported && Math.hypot(before.x - 21.5, before.z + 5.5) < 0.01);
  check('server-run movement matches the client prediction exactly', agree(shooter, sAck) && agree(target, tAck));

  const ex = shooter.body.x;
  const ez = shooter.body.z;
  const eyeY = shooter.body.y + shooter.body.height - EYE_FROM_TOP;
  const d = [target.body.x - ex, 1.2 - eyeY, target.body.z - ez];
  const len = Math.hypot(d[0], d[1], d[2]);
  const dir: [number, number, number] = [d[0] / len, d[1] / len, d[2] / len];
  send(shooter.ws, { t: 'fire', o: [ex + dir[0] * 0.35, eyeY + dir[1] * 0.35, ez + dir[2] * 0.35], d: dir });

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

// ---- 2. lag compensation -------------------------------------------------------------------

async function lagTest(url: string, compensated: boolean) {
  console.log(`-- 150 ms shooter vs a moving target, lag compensation ${compensated ? 'on' : 'off'}`);
  const shooter = await join(url, 150);
  const target = await join(url);
  if (shooter.team === target.team) throw new Error('expected opposite teams');
  await waitFor(shooter.inbox, snapWhere((m) => m.round.phase === 'live'), 8000);
  // shooter steps out beside their start; target runs over and lines up to cross in front of them
  await Promise.all([
    walkTo(shooter, -15, -1.5),
    (async () => {
      await walkTo(target, -10.5, -2.5, true);
      await walkTo(target, -10.5, -7);
    })(),
  ]);
  // make sure the server has measured the shooter's ping
  await waitFor(shooter.inbox, rosterWhere((m) => (m.players.find((p) => p.id === shooter.id)?.ping ?? 0) > 120), 5000);

  const crossing = walkTo(target, -10.5, 8); // 15 m at walking pace, straight across the shooter's view
  let fired = false;
  const end = performance.now() + 6000;
  while (!fired && performance.now() < end) {
    await wait(5);
    const at = performance.now() - 100; // INTERP_DELAY: what the shooter's screen shows right now
    const v = viewOf(shooter, target.id, at);
    const v0 = viewOf(shooter, target.id, at - 50);
    if (!v || !v0 || v.z < -1.2) continue;
    // aim at the chest, leading by the ball's flight time like a player would
    const eyeY = shooter.body.y + shooter.body.height - EYE_FROM_TOP;
    const dist = Math.hypot(v.x - shooter.body.x, v.z - shooter.body.z);
    const flight = dist / 85;
    const vz = (v.z - v0.z) / 0.05;
    const aim = [v.x - shooter.body.x, 1.2 - eyeY, v.z + vz * flight - shooter.body.z];
    const len = Math.hypot(aim[0], aim[1], aim[2]);
    const dir: [number, number, number] = [aim[0] / len, aim[1] / len, aim[2] / len];
    send(shooter.ws, { t: 'fire', o: [shooter.body.x + dir[0] * 0.35, eyeY + dir[1] * 0.35, shooter.body.z + dir[2] * 0.35], d: dir });
    fired = true;
  }
  const hit = await waitFor(shooter.inbox, (m): m is Hit => m.t === 'hit' && m.victim === target.id, 1500);
  await crossing;
  shooter.ws.close();
  target.ws.close();
  if (!fired) check('shooter got a shot off', false);
  else if (compensated) check('the shot that hits on the lagged screen hits on the server', hit !== null);
  else check('without compensation the same shot misses (so the test means something)', hit === null);
}

// ---- 1b. speed hack ------------------------------------------------------------------------

async function speedTest(url: string) {
  console.log('-- input rate limit');
  const a = await join(url);
  const b = await join(url);
  const [cheat] = a.team === 0 ? [a, b] : [b, a];
  await waitFor(cheat.inbox, snapWhere((m) => m.round.phase === 'live'), 8000);
  await wait(300);
  const start = { x: cheat.body.x, z: cheat.body.z };
  // 3 seconds of sprinting forward, all sent at once
  const frames: InputFrame[] = [];
  for (let i = 0; i < 360; i++) frames.push([++cheat.seq, 1, 0, 2, cheat.yaw, 0]);
  for (let i = 0; i < frames.length; i += 60) send(cheat.ws, { t: 'input', i: frames.slice(i, i + 60) });
  await wait(250);
  const ack = lastAck(cheat);
  const moved = ack ? Math.hypot(ack.b[0] - start.x, ack.b[2] - start.z) : Infinity;
  // honest: 3 s × 7.6 m/s ≈ 22 m. The server only accepts about a quarter second of backlog.
  check(`a burst of 3 s of input moves you at most a few metres (moved ${moved.toFixed(1)} m)`, moved < 3.5);
  a.ws.close();
  b.ws.close();
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
    const speed = await startServer({ BOT_TEAM_SIZE: '0' });
    try {
      await speedTest(speed.url);
    } finally {
      speed.stop();
    }
    for (const compensated of [true, false]) {
      const lag = await startServer({ BOT_TEAM_SIZE: '0', LAG_COMPENSATION: compensated ? '1' : '0' });
      try {
        await lagTest(lag.url, compensated);
      } finally {
        lag.stop();
      }
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

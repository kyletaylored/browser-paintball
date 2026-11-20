// A small authoritative game server: one room, two teams.
//
//  - Movement is trusted from the client (simple, but cheatable). The next step is to send
//    inputs instead and run shared/sim.ts stepMovement here too.
//  - Paintballs are simulated HERE. The server decides who got hit, so clients can't fake eliminations.
//  - It sends everyone a snapshot 20 times a second; clients interpolate between them.
//  - It runs the match: countdown, live point, point won, match over (see RoundPhase in shared/protocol.ts).

import { WebSocketServer, type WebSocket } from 'ws';
import { spawnPoint, HALF_L, HALF_W, NET_MARGIN } from '../shared/field';
import {
  advanceBall, traceWorld, segmentHitsCapsule, isOutOfBounds,
  BALL_SPEED, BALL_LIFETIME, FIRE_INTERVAL, STAND_HEIGHT, CROUCH_HEIGHT, EYE_FROM_TOP,
  RESPAWN_SECONDS, SERVER_TICK_HZ, SNAPSHOT_HZ, type Ball,
} from '../shared/sim';
import {
  DEFAULT_PORT, TEAM_NAMES, cleanName,
  type ClientMsg, type ServerMsg, type Team, type V3, type RoundPhase, type RoundState, type RosterEntry,
} from '../shared/protocol';

const envNum = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
const MAX_PLAYERS = 12;
const MAX_BALLS = 2000;
const POINTS_TO_WIN = envNum('POINTS_TO_WIN', 5);
const ROUND_SECONDS = envNum('ROUND_SECONDS', 120);
const COUNTDOWN_SECONDS = envNum('COUNTDOWN_SECONDS', 3);
const POINT_PAUSE_SECONDS = envNum('POINT_PAUSE_SECONDS', 3);
const MATCH_OVER_SECONDS = envNum('MATCH_OVER_SECONDS', 6);

interface Player {
  ws: WebSocket;
  id: number;
  team: Team;
  slot: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  crouch: boolean;
  alive: boolean;
  outUntil: number;
  lastFire: number;
  name: string;
  /** latest name the player asked for; applied at most once a second */
  wantName: string;
  lastRename: number;
  /** eliminations / times eliminated this match */
  k: number;
  d: number;
  /** smoothed round-trip time, ms */
  ping: number;
}

const players = new Map<number, Player>();
const balls: Ball[] = [];
const score: [number, number] = [0, 0];
let nextId = 1;

const match = { phase: 'waiting' as RoundPhase, endsAt: 0, round: 1, winner: -1 as Team | -1 };

const now = () => performance.now() / 1000;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isV3 = (v: unknown): v is V3 => Array.isArray(v) && v.length === 3 && v.every(finite);

function send(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg: ServerMsg, exceptId = -1) {
  const data = JSON.stringify(msg);
  for (const p of players.values()) if (p.id !== exceptId && p.ws.readyState === p.ws.OPEN) p.ws.send(data);
}

function pickTeam(): Team {
  let red = 0;
  let blue = 0;
  for (const p of players.values()) p.team === 0 ? red++ : blue++;
  return red <= blue ? 0 : 1;
}
function freeSlot(team: Team): number {
  const used = new Set([...players.values()].filter((p) => p.team === team).map((p) => p.slot));
  let s = 0;
  while (used.has(s)) s++;
  return s;
}

const wss = new WebSocketServer({ port: PORT, maxPayload: 4096 });

wss.on('connection', (ws) => {
  if (players.size >= MAX_PLAYERS) {
    ws.close(4004, 'server full');
    return;
  }
  const id = nextId++;
  const team = pickTeam();
  const slot = freeSlot(team);
  const sp = spawnPoint(team, slot);
  // joining while a point is being played: sit out until the next one
  const alive = match.phase !== 'live';
  const p: Player = {
    ws, id, team, slot, x: sp.x, y: sp.y, z: sp.z, yaw: sp.yaw, pitch: 0,
    crouch: false, alive, outUntil: alive ? 0 : Infinity, lastFire: 0,
    name: `Player ${id}`, wantName: `Player ${id}`, lastRename: -Infinity, k: 0, d: 0, ping: 0,
  };
  players.set(id, p);
  send(ws, { t: 'welcome', id, team, spawn: sp, round: roundState() });
  console.log(`+ player ${id} joined ${TEAM_NAMES[team]} (${players.size} online)`);
  updateMatch();
  sendRoster();

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    handle(p, msg);
  });

  ws.on('close', () => {
    players.delete(id);
    broadcast({ t: 'leave', id });
    console.log(`- player ${id} left (${players.size} online)`);
    updateMatch();
    sendRoster();
  });
});

function handle(p: Player, msg: ClientMsg) {
  if (msg.t === 'hello') {
    p.wantName = cleanName(msg.name) || `Player ${p.id}`;
    applyName(p);
  } else if (msg.t === 'pong') {
    if (!finite(msg.s)) return;
    const rtt = (now() - msg.s) * 1000;
    if (rtt < 0 || rtt > 10000) return;
    p.ping = p.ping ? p.ping * 0.7 + rtt * 0.3 : rtt;
  } else if (msg.t === 'state') {
    if (!p.alive) return; // eliminated players are frozen until they respawn
    if (match.phase === 'countdown') return; // everyone stays in their start box
    if (![msg.x, msg.y, msg.z, msg.yaw, msg.pitch].every(finite)) return;
    p.x = Math.max(-HALF_L - NET_MARGIN, Math.min(HALF_L + NET_MARGIN, msg.x));
    p.y = Math.max(0, Math.min(5, msg.y));
    p.z = Math.max(-HALF_W - NET_MARGIN, Math.min(HALF_W + NET_MARGIN, msg.z));
    p.yaw = msg.yaw;
    p.pitch = msg.pitch;
    p.crouch = msg.c === true;
  } else if (msg.t === 'fire') {
    if (!p.alive || !isV3(msg.o) || !isV3(msg.d)) return;
    if (match.phase !== 'live' && match.phase !== 'waiting') return; // no shooting during countdowns and pauses
    const t = now();
    if (t - p.lastFire < FIRE_INTERVAL * 0.75) return; // rate limit (with slack for network jitter)
    // The shot has to start near the shooter's eyes.
    const eyeY = p.y + (p.crouch ? CROUCH_HEIGHT : STAND_HEIGHT) - EYE_FROM_TOP;
    if (Math.hypot(msg.o[0] - p.x, msg.o[1] - eyeY, msg.o[2] - p.z) > 1.5) return;
    const len = Math.hypot(...msg.d);
    if (len < 0.5 || len > 1.5) return;
    p.lastFire = t;
    const v: V3 = [(msg.d[0] / len) * BALL_SPEED, (msg.d[1] / len) * BALL_SPEED, (msg.d[2] / len) * BALL_SPEED];
    if (balls.length < MAX_BALLS) {
      balls.push({ x: msg.o[0], y: msg.o[1], z: msg.o[2], vx: v[0], vy: v[1], vz: v[2], age: 0, owner: p.id, team: p.team });
    }
    // Everyone else draws the ball; the shooter already drew it the moment they clicked.
    broadcast({ t: 'ball', owner: p.id, team: p.team, o: msg.o, v }, p.id);
  }
}

function tick(dt: number) {
  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];
    const x0 = b.x;
    const y0 = b.y;
    const z0 = b.z;
    advanceBall(b, dt);
    const world = traceWorld(x0, y0, z0, b.x, b.y, b.z);
    let bestT = world ? world.t : Infinity;
    let victim: Player | null = null;
    for (const p of players.values()) {
      if (!p.alive || p.team === b.team) continue; // no friendly fire
      const s = segmentHitsCapsule(x0, y0, z0, b.x, b.y, b.z, p.x, p.y, p.z, p.crouch ? CROUCH_HEIGHT : STAND_HEIGHT);
      if (s !== null && s < bestT) {
        bestT = s;
        victim = p;
      }
    }
    if (victim) {
      const hp: V3 = [x0 + (b.x - x0) * bestT, y0 + (b.y - y0) * bestT, z0 + (b.z - z0) * bestT];
      eliminate(victim, b, hp);
      balls.splice(i, 1);
    } else if (world || b.age > BALL_LIFETIME || isOutOfBounds(b.x, b.y, b.z)) {
      balls.splice(i, 1);
    }
  }

  const t = now();
  for (const p of players.values()) {
    if (!p.alive && t >= p.outUntil) respawn(p); // warm-up only: live points use Infinity
    if (p.wantName !== p.name) applyName(p);
  }
  updateMatch();
}

/** take the player's requested name, at most once a second (the tick retries) */
function applyName(p: Player) {
  const t = now();
  if (p.wantName === p.name || t - p.lastRename < 1) return;
  p.lastRename = t;
  p.name = p.wantName;
  console.log(`  player ${p.id} is now "${p.name}"`);
  sendRoster();
}

function respawn(p: Player) {
  const sp = spawnPoint(p.team, p.slot);
  Object.assign(p, { alive: true, outUntil: 0, x: sp.x, y: sp.y, z: sp.z, yaw: sp.yaw, pitch: 0, crouch: false });
  send(p.ws, { t: 'respawn', spawn: sp });
}

function eliminate(victim: Player, ball: Ball, p: V3) {
  victim.alive = false;
  // during warm-up you come back after a few seconds; during a point you're out until it ends
  victim.outUntil = match.phase === 'waiting' ? now() + RESPAWN_SECONDS : Infinity;
  broadcast({ t: 'hit', victim: victim.id, shooter: ball.owner, team: ball.team as Team, p });
  if (match.phase !== 'waiting') {
    victim.d++;
    const shooter = players.get(ball.owner);
    if (shooter) shooter.k++;
    sendRoster();
  }
}

function roster(): RosterEntry[] {
  return [...players.values()].map((p) => ({ id: p.id, name: p.name, team: p.team, k: p.k, d: p.d, ping: Math.round(p.ping) }));
}
function sendRoster() {
  if (players.size) broadcast({ t: 'roster', players: roster() });
}

/** new match: points and per-player stats back to zero */
function resetMatch() {
  score[0] = score[1] = 0;
  match.round = 1;
  for (const p of players.values()) p.k = p.d = 0;
  sendRoster();
}

// ---- match flow ---------------------------------------------------------------------------

function teamCounts() {
  const total: [number, number] = [0, 0];
  const alive: [number, number] = [0, 0];
  for (const p of players.values()) {
    total[p.team]++;
    if (p.alive) alive[p.team]++;
  }
  return { total, alive };
}

function setPhase(phase: RoundPhase, seconds: number, winner: Team | -1 = -1) {
  match.phase = phase;
  match.endsAt = now() + seconds;
  match.winner = winner;
  const who = winner !== -1 ? ` (${TEAM_NAMES[winner]})` : '';
  console.log(`  match: ${phase}${who} · ${score[0]}-${score[1]} · point ${match.round}`);
}

/** reset everyone to their start box and start the countdown for the next point */
function startCountdown() {
  balls.length = 0;
  for (const p of players.values()) respawn(p);
  setPhase('countdown', COUNTDOWN_SECONDS);
}

function updateMatch() {
  const { total, alive } = teamCounts();
  const t = now();

  if (total[0] === 0 || total[1] === 0) {
    if (match.phase !== 'waiting') {
      setPhase('waiting', 0);
      // back to warm-up: anyone sitting out comes back shortly
      for (const p of players.values()) if (!p.alive) p.outUntil = t + RESPAWN_SECONDS;
    }
    return;
  }

  switch (match.phase) {
    case 'waiting':
      resetMatch();
      startCountdown();
      break;
    case 'countdown':
      if (t >= match.endsAt) setPhase('live', ROUND_SECONDS);
      break;
    case 'live': {
      const redOut = alive[0] === 0;
      const blueOut = alive[1] === 0;
      if (redOut || blueOut || t >= match.endsAt) {
        const winner: Team | -1 = redOut && !blueOut ? 1 : blueOut && !redOut ? 0 : -1;
        if (winner !== -1) score[winner]++;
        const over = winner !== -1 && score[winner] >= POINTS_TO_WIN;
        setPhase(over ? 'matchover' : 'point', over ? MATCH_OVER_SECONDS : POINT_PAUSE_SECONDS, winner);
      }
      break;
    }
    case 'point':
      if (t >= match.endsAt) {
        match.round++;
        startCountdown();
      }
      break;
    case 'matchover':
      if (t >= match.endsAt) {
        resetMatch();
        startCountdown();
      }
      break;
  }
}

function roundState(): RoundState {
  return {
    phase: match.phase,
    endsIn: match.phase === 'waiting' ? 0 : Math.max(0, match.endsAt - now()),
    round: match.round,
    winner: match.winner,
    toWin: POINTS_TO_WIN,
  };
}

function snapshot() {
  if (!players.size) return;
  broadcast({
    t: 'snap',
    time: now(),
    score,
    round: roundState(),
    players: [...players.values()].map((p) => ({
      id: p.id, team: p.team, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, c: p.crouch, alive: p.alive,
    })),
  });
}

let last = now();
setInterval(() => {
  const t = now();
  tick(Math.min(0.1, t - last));
  last = t;
}, 1000 / SERVER_TICK_HZ);
setInterval(snapshot, 1000 / SNAPSHOT_HZ);
// latency probes + a roster refresh so pings on the scoreboard stay current
setInterval(() => {
  broadcast({ t: 'ping', s: now() });
  sendRoster();
}, 2000);

console.log(`Splat Arena server on ws://localhost:${PORT}`);

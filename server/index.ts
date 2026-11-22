// A small authoritative game server: one room, two teams.
//
//  - Movement is decided HERE: browsers send their keys + aim as fixed-length input frames and the
//    server runs the same shared/sim.ts stepMovement on them. Each browser predicts its own movement
//    with that code and corrects itself from the 'ack' the server sends back (see src/main.ts).
//  - Paintballs are simulated HERE. The server decides who got hit, so clients can't fake eliminations.
//  - It sends everyone a snapshot 20 times a second; clients interpolate between them.
//  - It runs the match: countdown, live point, point won, match over (see RoundPhase in shared/protocol.ts).
//  - It fills empty slots with bots (server/bots.ts) so there's always someone to play against.
//  - Lag compensation: a human's paintballs are tested against where targets were on that shooter's
//    screen (their ping + the interpolation delay ago), using a short history of everyone's positions.

import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { makeHttpHandler } from './http';
import { field, setMap, spawnPoint } from '../shared/field';
import { MAPS, MAP_LIST, DEFAULT_MAP, voteWinner, unanimousVote } from '../shared/maps';
import {
  advanceBall, traceWorld, segmentHitsPlayer, stanceHeight, isOutOfBounds, stepMovement, hitWorld, hitPlayer, ballSeed, BALL_DT,
  BALL_SPEED, BALL_LIFETIME, STAND_HEIGHT, CROUCH_HEIGHT, EYE_FROM_TOP,
  RESPAWN_SECONDS, SERVER_TICK_HZ, SNAPSHOT_HZ, INPUT_DT, INTERP_DELAY, type Ball, type Body, type MoveInput,
} from '../shared/sim';
import { BotBrain, NavGrid, SKILLS, botName, type CoverSpot, type Seen } from './bots';
import { decodeClient, encodeAck, encodeBall, encodeSnap } from '../shared/codec';
import { walkOffInput } from '../shared/walkoff';
import { count, flush, tickTime, telemetryOn } from './telemetry';
import { MODE_RULES, DEFAULT_FIRE_MODE, isFireMode, modeVoteWinner, type FireMode } from '../shared/fire';
import { FastLink, type RtcOptions } from './rtc';
import { voiceConfig, voiceToken } from './voice';
import {
  DEFAULT_PORT, TEAM_NAMES, cleanName, INPUT_JUMP, INPUT_SPRINT, INPUT_CROUCH, INPUT_PRONE,
  type ClientMsg, type ServerMsg, type Team, type V3, type RoundPhase, type RoundState, type RosterEntry,
} from '../shared/protocol';

const envNum = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
/** interface to listen on (default: all) */
const HOST = process.env.HOST || undefined;
/** serve the built website from here too (one container for site + game); unset = game only */
const STATIC_DIR = process.env.STATIC_DIR || null;
/**
 * comma-separated list of web origins allowed to open a game connection, e.g.
 * https://play.example.com. Unset = any origin (fine for development).
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);

/** one line per event, with a timestamp, to stdout (container platforms collect it from there) */
const log = (...parts: unknown[]) => console.log(new Date().toISOString(), ...parts);
const MAX_PLAYERS = 12;
const MAX_BALLS = 2000;
const POINTS_TO_WIN = envNum('POINTS_TO_WIN', 5);
const ROUND_SECONDS = envNum('ROUND_SECONDS', 120);
const COUNTDOWN_SECONDS = envNum('COUNTDOWN_SECONDS', 3);
/** long enough for out players to finish walking off, and for the camera shots between points */
const POINT_PAUSE_SECONDS = envNum('POINT_PAUSE_SECONDS', 8);
/** time to vote for the next field after a match (and for the camera shots) */
const MATCH_OVER_SECONDS = envNum('MATCH_OVER_SECONDS', 12);
/** while anyone is connected, fill each team up to this many players with bots (0 turns bots off) */
const BOT_TEAM_SIZE = Math.max(0, Math.min(6, Math.floor(Number(process.env.BOT_TEAM_SIZE ?? 3) || 0)));
const BOT_SKILL = SKILLS[process.env.BOT_SKILL ?? 'normal'] ?? SKILLS.normal;
/** LAG_COMPENSATION=0 turns it off (for comparison) */
const LAG_COMPENSATION = process.env.LAG_COMPENSATION !== '0';
/** never rewind further than this: past it, high-ping players would hit people who are long behind cover */
const MAX_REWIND = envNum('MAX_REWIND_MS', 300) / 1000;
/** how much position history to keep */
const HISTORY_SECONDS = 1;
/** MAP=<id> plays one field (see shared/maps.ts); unset or MAP=rotate moves to the next field after every match */
const MAP_SETTING = (process.env.MAP ?? 'rotate').trim().toLowerCase();
const ROTATE = !MAPS[MAP_SETTING];
setMap(ROTATE ? DEFAULT_MAP : MAP_SETTING);
/** FIRE_MODE=ramp|semi|pump plays one firing mode (see shared/fire.ts); unset, players vote for it */
const MODE_SETTING = (process.env.FIRE_MODE ?? 'vote').trim().toLowerCase();
const MODE_VOTE = !isFireMode(MODE_SETTING);
let fireMode: FireMode = isFireMode(MODE_SETTING) ? MODE_SETTING : DEFAULT_FIRE_MODE;
/**
 * Datadog RUM for the browser (docs/DATADOG.md): its application id and client token are public by
 * design (they go into every page), so the server just hands them to the page. null = off
 */
const RUM = process.env.DD_RUM_APPLICATION_ID && process.env.DD_RUM_CLIENT_TOKEN
  ? {
      applicationId: process.env.DD_RUM_APPLICATION_ID,
      clientToken: process.env.DD_RUM_CLIENT_TOKEN,
      site: process.env.DD_SITE ?? 'datadoghq.com',
      service: process.env.DD_RUM_SERVICE ?? 'splat-arena-web',
      env: process.env.DD_ENV ?? 'production',
      version: process.env.DD_VERSION ?? process.env.FLY_IMAGE_REF?.split(':').pop() ?? 'dev',
      sessionSampleRate: Math.max(0, Math.min(100, Number(process.env.DD_RUM_SESSION_SAMPLE_RATE ?? 100))),
    }
  : null;
/** team voice chat through a LiveKit server (server/voice.ts); null = off */
const VOICE = voiceConfig(process.env);
/** WIRE_FORMAT=json sends snapshots, acks and balls as JSON instead of binary (for debugging / comparing) */
const BINARY = process.env.WIRE_FORMAT !== 'json';
/**
 * Data channels (server/rtc.ts): the one UDP port they all use. 0 turns them off. Unset: on, on the
 * game port + 1, in development; off in production until you open a UDP port (see docs/DEPLOY.md).
 */
const RTC_PORT = process.env.RTC_UDP_PORT !== undefined
  ? Math.max(0, Math.min(65535, Math.floor(Number(process.env.RTC_UDP_PORT) || 0)))
  : process.env.NODE_ENV === 'production' ? 0 : PORT + 1;
/** RTC_PUBLIC_IP: the address browsers send UDP to, when it isn't this machine's own (NAT, platform proxy) */
const RTC_PUBLIC_IP = process.env.RTC_PUBLIC_IP?.trim() || null;
/** RTC_BIND_ADDRESS: local address (or host name) for the UDP port, e.g. fly-global-services on Fly.io */
const RTC_BIND = process.env.RTC_BIND_ADDRESS?.trim() || null;
const rtc: RtcOptions | null = RTC_PORT && BINARY
  ? { port: RTC_PORT, publicIp: RTC_PUBLIC_IP, bindAddress: RTC_BIND && !isIP(RTC_BIND) ? (await lookup(RTC_BIND)).address : RTC_BIND }
  : null;

interface Player {
  /** null for bots */
  ws: WebSocket | null;
  /** data channel for snapshots, acks and input frames, once the browser asks for one (humans only) */
  fast: FastLink | null;
  /** walkLeft: time not yet walked off the field in INPUT_DT steps, while out */
  bot: { brain: BotBrain; walkLeft: number } | null;
  /** authoritative movement state; x/y/z below mirror it */
  body: Body;
  /** last input frame applied (humans) */
  lastSeq: number;
  /** seconds of input we'll still accept; refills in real time, so nobody can move faster than the clock */
  budget: number;
  /** where this player was over the last second (for lag compensation), oldest first */
  history: Pose[];
  id: number;
  team: Team;
  slot: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  crouch: boolean;
  /** lying down */
  prone: boolean;
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
  /** when we last handed out a voice token (rate limit) */
  lastVoiceToken: number;
  /** the field this human wants to play (null: no preference); bots don't vote */
  vote: string | null;
  /** the firing mode this human wants (null: no preference) */
  modeVote: FireMode | null;
}

interface Pose {
  t: number;
  x: number;
  y: number;
  z: number;
  height: number;
  /** which way they faced, and lying down: a lying body is hit along the ground (shared/sim.ts segmentHitsPlayer) */
  yaw: number;
  prone: boolean;
  alive: boolean;
}

/** a paintball plus how far back in time to test it against targets */
type ServerBall = Ball & { rewind: number };

const players = new Map<number, Player>();
const balls: ServerBall[] = [];
const score: [number, number] = [0, 0];
let nextId = 1;

const match = { phase: 'waiting' as RoundPhase, endsAt: 0, round: 1, winner: -1 as Team | -1 };

const now = () => performance.now() / 1000;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const MAX_INPUT_BACKLOG = 0.25;
const newBody = (x: number, y: number, z: number): Body => ({ x, y, z, vx: 0, vy: 0, vz: 0, height: STAND_HEIGHT, onGround: true });
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isV3 = (v: unknown): v is V3 => Array.isArray(v) && v.length === 3 && v.every(finite);

function send(ws: WebSocket | null, msg: ServerMsg | Uint8Array) {
  if (ws && ws.readyState === ws.OPEN) ws.send(msg instanceof Uint8Array ? msg : JSON.stringify(msg));
}
function broadcast(msg: ServerMsg | Uint8Array, exceptId = -1) {
  const data = msg instanceof Uint8Array ? msg : JSON.stringify(msg);
  for (const p of players.values()) if (p.id !== exceptId && p.ws && p.ws.readyState === p.ws.OPEN) p.ws.send(data);
}

const humans = () => [...players.values()].filter((p) => !p.bot);

/** humans go to the team with fewer humans; bots fill in around them */
function pickTeam(): Team {
  let red = 0;
  let blue = 0;
  for (const p of humans()) p.team === 0 ? red++ : blue++;
  return red <= blue ? 0 : 1;
}
function freeSlot(team: Team): number {
  const used = new Set([...players.values()].filter((p) => p.team === team).map((p) => p.slot));
  let s = 0;
  while (used.has(s)) s++;
  return s;
}

const startedAt = Date.now();
const httpServer = createServer(
  makeHttpHandler({
    staticDir: STATIC_DIR,
    clientConfig: () => ({ rum: RUM }),
    health: () => ({
      players: humans().length, bots: players.size - humans().length, phase: match.phase, map: field.map.id, vote: ROTATE, mode: fireMode, modeVote: MODE_VOTE, voice: VOICE !== null,
      uptime: Math.round((Date.now() - startedAt) / 1000),
    }),
  }),
);
const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: 4096,
  // With ALLOWED_ORIGINS set, other websites can't open game connections from their visitors' browsers.
  // Browsers always send Origin; a client without one isn't a browser (and could fake it anyway).
  verifyClient: ({ origin }: { origin?: string }) => !ALLOWED_ORIGINS.length || !origin || ALLOWED_ORIGINS.includes(origin),
});

wss.on('connection', (ws) => {
  if (humans().length >= MAX_PLAYERS) {
    ws.close(4004, 'server full');
    return;
  }
  const id = nextId++;
  const team = pickTeam();
  removeBotFrom(team); // make room: a human takes a bot's place
  const slot = freeSlot(team);
  const sp = spawnPoint(team, slot);
  // joining while a point is being played: sit out until the next one
  const alive = match.phase !== 'live';
  const p: Player = {
    ws, fast: null, bot: null, body: newBody(sp.x, sp.y, sp.z), lastSeq: -1, budget: 0.1, history: [], id, team, slot, x: sp.x, y: sp.y, z: sp.z, yaw: sp.yaw, pitch: 0,
    crouch: false, prone: false, alive, outUntil: alive ? 0 : Infinity, lastFire: 0,
    name: `Player ${id}`, wantName: `Player ${id}`, lastRename: -Infinity, k: 0, d: 0, ping: 0, lastVoiceToken: -Infinity, vote: null, modeVote: null,
  };
  players.set(id, p);
  send(ws, { t: 'welcome', id, team, spawn: sp, round: roundState(), map: field.map.id, voice: VOICE !== null, vote: ROTATE, mode: fireMode, modeVote: MODE_VOTE });
  log(`+ player ${id} joined ${TEAM_NAMES[team]} (${humans().length} online)`);
  count('joins');
  balanceBots();
  updateMatch();
  sendRoster();

  ws.on('message', (data, isBinary) => {
    let msg: ClientMsg;
    try {
      msg = isBinary ? decodeClient(data as Buffer) : JSON.parse(data.toString());
    } catch {
      return; // malformed: ignore
    }
    handle(p, msg);
  });

  ws.on('close', () => {
    p.fast?.close();
    p.fast = null;
    players.delete(id);
    broadcast({ t: 'leave', id });
    log(`- player ${id} left (${humans().length} online)`);
    balanceBots();
    updateMatch();
    checkVotes(); // the one holding out may have left
    checkModeVotes();
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
  } else if (msg.t === 'input') {
    if (!Array.isArray(msg.i) || msg.i.length > 64) return;
    for (const f of msg.i) applyInput(p, f);
  } else if (msg.t === 'rtc') {
    if (!rtc || !p.ws) return;
    if (msg.sdp === undefined) {
      if (p.fast) return; // one per connection
      p.fast = new FastLink(`p${p.id}`, rtc, (m) => send(p.ws, m), (data) => onFast(p, data), (open) => {
        log(`  player ${p.id} data channel ${open ? 'open' : 'closed'}`);
      });
    } else if (typeof msg.sdp === 'string' && msg.sdp.length < 4000) p.fast?.answer(msg.sdp);
  } else if (msg.t === 'ice') {
    if (typeof msg.c !== 'string' || typeof msg.mid !== 'string' || msg.c.length > 512 || msg.mid.length > 32) return;
    p.fast?.candidate(msg.c, msg.mid);
  } else if (msg.t === 'vote') {
    if (!ROTATE || !p.ws) return; // the server pins one field
    const v = typeof msg.map === 'string' && MAPS[msg.map] ? msg.map : null;
    if (v === p.vote) return;
    p.vote = v;
    log(`  player ${p.id} votes for ${v ? MAPS[v].name : 'no field in particular'}`);
    sendRoster();
    checkVotes();
  } else if (msg.t === 'mode') {
    if (!MODE_VOTE || !p.ws) return; // the server plays one firing mode
    const v = isFireMode(msg.mode) ? msg.mode : null;
    if (v === p.modeVote) return;
    p.modeVote = v;
    log(`  player ${p.id} votes for ${v ? MODE_RULES[v].name : 'no firing mode in particular'}`);
    sendRoster();
    checkModeVotes();
  } else if (msg.t === 'voice') {
    // a token naming this player and their team (the browser can't pick its own); at most one every 5 s
    const t = now();
    if (!VOICE || t - p.lastVoiceToken < 5) return;
    p.lastVoiceToken = t;
    send(p.ws, { t: 'voice', url: VOICE.url, token: voiceToken(VOICE, p.id, p.name, p.team) });
  } else if (msg.t === 'fire') {
    if (!p.alive || !isV3(msg.o) || !isV3(msg.d)) return;
    if (match.phase !== 'live' && match.phase !== 'waiting') return; // no shooting during countdowns and pauses
    const t = now();
    // the firing mode's rate (with slack for network jitter). Ramping, a pump's stroke: all just a
    // shortest time between balls here, as the server can't see the trigger
    if (t - p.lastFire < MODE_RULES[fireMode].interval * 0.75) return;
    // The shot has to start near the shooter's eyes (where the server has them).
    const eyeY = p.body.y + p.body.height - EYE_FROM_TOP;
    if (Math.hypot(msg.o[0] - p.x, msg.o[1] - eyeY, msg.o[2] - p.z) > 1.5) return;
    const len = Math.hypot(...msg.d);
    if (len < 0.5 || len > 1.5) return;
    p.lastFire = t;
    spawnBall(p, msg.o, [msg.d[0] / len, msg.d[1] / len, msg.d[2] / len]);
  }
}

/** a binary message on a player's data channel: only input frames are accepted there */
function onFast(p: Player, data: Buffer) {
  if (!players.has(p.id)) return;
  let msg: ClientMsg;
  try {
    msg = decodeClient(data);
  } catch {
    return;
  }
  if (msg.t === 'input') handle(p, msg);
}

const moveIn: MoveInput = { forward: 0, right: 0, jump: false, sprint: false, crouch: false, prone: false, yaw: 0 };

/** run one of a browser's input frames through the same movement code the browser predicted with */
function applyInput(p: Player, f: unknown) {
  if (!Array.isArray(f) || f.length !== 6 || !f.every(finite)) return;
  const [seq, forward, right, flags, yaw, pitch] = f as number[];
  if (seq <= p.lastSeq) return; // old or repeated
  p.lastSeq = seq;
  // More input than real time allows (a speed hack, or a burst after a stall): drop it. The browser
  // gets corrected by the next ack.
  if (p.budget < INPUT_DT * 0.5) return;
  p.budget -= INPUT_DT;
  p.yaw = yaw;
  p.pitch = clamp(pitch, -1.6, 1.6);
  // eliminated: walk off the field (the browser runs the same walk-off). Holding still for the
  // countdown: the browser steps with no keys, so do the same
  if (!p.alive && match.phase !== 'countdown') {
    walkOff(p);
    return;
  }
  const canMove = p.alive && match.phase !== 'countdown';
  moveIn.forward = canMove ? clamp(forward, -1, 1) : 0;
  moveIn.right = canMove ? clamp(right, -1, 1) : 0;
  moveIn.jump = canMove && (flags & INPUT_JUMP) !== 0;
  moveIn.sprint = canMove && (flags & INPUT_SPRINT) !== 0;
  moveIn.crouch = canMove && (flags & INPUT_CROUCH) !== 0;
  moveIn.prone = canMove && (flags & INPUT_PRONE) !== 0;
  moveIn.yaw = yaw;
  stepMovement(p.body, moveIn, INPUT_DT);
  p.x = p.body.x;
  p.y = p.body.y;
  p.z = p.body.z;
  p.crouch = moveIn.crouch;
  p.prone = moveIn.prone;
}

/** one step of an out player's walk to the side line, for humans and bots alike */
function walkOff(p: Player) {
  walkOffInput(p.body, moveIn);
  stepMovement(p.body, moveIn, INPUT_DT);
  p.x = p.body.x;
  p.y = p.body.y;
  p.z = p.body.z;
  p.yaw = moveIn.yaw;
  p.pitch = 0;
  p.crouch = p.prone = false;
}

function spawnBall(p: Player, o: V3, dir: V3) {
  const v: V3 = [dir[0] * BALL_SPEED, dir[1] * BALL_SPEED, dir[2] * BALL_SPEED];
  if (balls.length < MAX_BALLS) {
    balls.push({
      x: o[0], y: o[1], z: o[2], vx: v[0], vy: v[1], vz: v[2], age: 0, owner: p.id, team: p.team,
      seed: ballSeed(o), bounces: 0, rewind: rewindFor(p),
    });
  }
  // Everyone else draws the ball; a human shooter already drew it the moment they clicked.
  count(p.bot ? 'shots.bot' : 'shots.human');
  const ball: ServerMsg = { t: 'ball', owner: p.id, team: p.team, o, v };
  broadcast(BINARY ? encodeBall(ball) : ball, p.bot ? -1 : p.id);
}

// ---- lag compensation -----------------------------------------------------------------------
//
// A human aims at other players as their browser draws them: one snapshot trip old (half the round
// trip) plus INTERP_DELAY of blending, and their shot reaches us another half trip later. So while
// one of their balls flies, we test it against targets as they were (round trip + INTERP_DELAY) ago.
// Bots see the live server state, so their balls aren't rewound.

function rewindFor(p: Player): number {
  if (!LAG_COMPENSATION || p.bot || !p.ping) return 0;
  return Math.min(MAX_REWIND, p.ping / 1000 + INTERP_DELAY);
}

function recordHistory(t: number) {
  for (const p of players.values()) {
    const h = p.history;
    h.push({ t, x: p.x, y: p.y, z: p.z, height: stanceHeight(p.crouch, p.prone), yaw: p.yaw, prone: p.prone, alive: p.alive });
    while (h.length && h[0].t < t - HISTORY_SECONDS) h.shift();
  }
}

const livePose: Pose = { t: 0, x: 0, y: 0, z: 0, height: 0, yaw: 0, prone: false, alive: false };
/** where `p` was at time `t`, blended between the recorded ticks around it */
function poseAt(p: Player, t: number): Pose {
  const h = p.history;
  if (!h.length || t >= h[h.length - 1].t) {
    return Object.assign(livePose, { t, x: p.x, y: p.y, z: p.z, height: stanceHeight(p.crouch, p.prone), yaw: p.yaw, prone: p.prone, alive: p.alive });
  }
  if (t <= h[0].t) return h[0];
  let i = h.length - 1;
  while (i > 0 && h[i - 1].t > t) i--;
  const a = h[i - 1];
  const b = h[i];
  const k = (t - a.t) / (b.t - a.t);
  if (Math.hypot(b.x - a.x, b.z - a.z) > 3) return k < 0.5 ? a : b; // a respawn in between: don't blend across the field
  return {
    t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k,
    height: k < 0.5 ? a.height : b.height, yaw: k < 0.5 ? a.yaw : b.yaw, prone: k < 0.5 ? a.prone : b.prone, alive: a.alive && b.alive,
  };
}

// ---- bots ---------------------------------------------------------------------------------

let nav = new NavGrid();
const claimed: [Map<CoverSpot, number>, Map<CoverSpot, number>] = [new Map(), new Map()];

/**
 * Every human wants the same other field: switch now, unless a human is mid-point (then it happens
 * in the break after it). Only between matches does the vote count otherwise (see updateMatch).
 */
function checkVotes() {
  if (!ROTATE) return;
  const want = unanimousVote(humans().map((h) => h.vote), field.map.id);
  if (!want) return;
  if (match.phase === 'live' && humans().some((h) => h.alive)) return;
  if (match.phase === 'matchover') return; // the vote decides the next field in a moment anyway
  log(`  every player voted for ${MAPS[want].name}: switching now`);
  changeMap(want);
  resetMatch();
  if (match.phase === 'waiting') for (const p of players.values()) respawn(p);
  else startCountdown();
}

/**
 * A different firing mode with more than half the humans behind it takes over, straight away unless
 * a point is being played (then when it ends: nobody's marker changes mid-point).
 */
function checkModeVotes() {
  if (!MODE_VOTE) return;
  const want = modeVoteWinner(humans().map((h) => h.modeVote), fireMode);
  if (want === fireMode || match.phase === 'live') return;
  fireMode = want;
  log(`  firing mode: ${MODE_RULES[want].name}`);
  for (const p of players.values()) if (p.bot) p.bot.brain.fireMode = want;
  broadcast({ t: 'mode', mode: want });
}

/** move everyone to another field: new bot navigation, bots replaced, browsers told to rebuild */
function changeMap(id: string) {
  if (!setMap(id)) return;
  nav = new NavGrid();
  claimed[0].clear();
  claimed[1].clear();
  for (const p of [...players.values()]) {
    if (!p.bot) continue;
    players.delete(p.id);
    broadcast({ t: 'leave', id: p.id });
  }
  broadcast({ t: 'map', id });
  balanceBots(); // fresh bots, thinking about the new field
  log(`  map: ${field.map.name}`);
}
let botCount = 0;

function addBot(team: Team) {
  const id = nextId++;
  const slot = freeSlot(team);
  const sp = spawnPoint(team, slot);
  const name = botName(botCount++);
  const brain = new BotBrain(nav, BOT_SKILL, claimed[team]);
  brain.fireMode = fireMode;
  brain.reset(sp.yaw);
  const alive = match.phase !== 'live';
  players.set(id, {
    ws: null, fast: null, bot: { brain, walkLeft: 0 }, body: newBody(sp.x, sp.y, sp.z), lastSeq: -1, budget: 0, history: [], id, team, slot, x: sp.x, y: sp.y, z: sp.z, yaw: sp.yaw, pitch: 0,
    crouch: false, prone: false, alive, outUntil: alive ? 0 : Infinity, lastFire: 0,
    name, wantName: name, lastRename: 0, k: 0, d: 0, ping: 0, lastVoiceToken: -Infinity, vote: null, modeVote: null,
  });
}

function removeBotFrom(team: Team): boolean {
  // prefer one that's already out, so a live point isn't decided by a bot vanishing
  const bots = [...players.values()].filter((p) => p.bot && p.team === team).sort((a, b) => +a.alive - +b.alive);
  const b = bots[0];
  if (!b) return false;
  players.delete(b.id);
  broadcast({ t: 'leave', id: b.id });
  return true;
}

/** keep each team at BOT_TEAM_SIZE (or level with the bigger human team) while anyone is connected */
function balanceBots() {
  const hs = humans();
  const human: [number, number] = [0, 0];
  for (const p of hs) human[p.team]++;
  // no humans → no bots (nobody to watch); otherwise level both teams up to the bigger of the two
  const size = hs.length && BOT_TEAM_SIZE ? Math.max(BOT_TEAM_SIZE, ...human) : 0;
  for (const team of [0, 1] as const) {
    const bots = [...players.values()].filter((p) => p.bot && p.team === team).length;
    const want = Math.max(0, size - human[team]);
    for (let i = bots; i < want; i++) addBot(team);
    for (let i = bots; i > want; i--) removeBotFrom(team);
  }
  sendRoster();
}

function updateBots(dt: number) {
  const t = now();
  const canMove = match.phase === 'live' || match.phase === 'waiting';
  const seen: Seen[] = [];
  for (const p of players.values()) seen.push({ id: p.id, team: p.team, x: p.x, y: p.y, z: p.z, crouch: p.crouch, prone: p.prone, alive: p.alive });
  for (const p of players.values()) {
    if (!p.bot) continue;
    if (!p.alive) {
      // out: walk off the field (between points too, like humans). The bot runs at the server
      // tick, not in input steps, so take as many walk-off steps as fit
      if (match.phase === 'countdown') continue;
      p.bot.walkLeft += dt;
      for (; p.bot.walkLeft >= INPUT_DT; p.bot.walkLeft -= INPUT_DT) walkOff(p);
      continue;
    }
    if (!canMove) continue;
    const { brain } = p.bot;
    const body = p.body;
    const out = brain.update(t, dt, { id: p.id, team: p.team, x: body.x, y: body.y, z: body.z, height: body.height, speed: Math.hypot(body.vx, body.vz) }, seen, canMove);
    stepMovement(body, out.move, dt);
    p.x = body.x;
    p.y = body.y;
    p.z = body.z;
    p.yaw = out.yaw;
    p.pitch = out.pitch;
    p.crouch = out.move.crouch;
    p.prone = out.move.prone;
    if (out.fire && t - p.lastFire >= MODE_RULES[fireMode].interval * 0.95) {
      p.lastFire = t;
      const eyeY = body.y + body.height - EYE_FROM_TOP;
      const d = out.fire;
      spawnBall(p, [body.x + d[0] * 0.35, eyeY + d[1] * 0.35 - 0.04, body.z + d[2] * 0.35], d);
    }
  }
}

let ballTime = 0;

function tick(dt: number) {
  for (const p of players.values()) if (!p.bot) p.budget = Math.min(MAX_INPUT_BACKLOG, p.budget + dt);
  updateBots(dt);
  recordHistory(now());
  // balls fly in the same fixed steps as in the browsers (shared/sim.ts), so they take the same path
  ballTime += dt;
  while (ballTime >= BALL_DT) {
    stepBalls(BALL_DT);
    ballTime -= BALL_DT;
  }

  const t = now();
  for (const p of players.values()) {
    if (!p.alive && t >= p.outUntil) respawn(p); // warm-up only: live points use Infinity
    if (p.wantName !== p.name) applyName(p);
  }
  updateMatch();
}

function stepBalls(dt: number) {
  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];
    const x0 = b.x;
    const y0 = b.y;
    const z0 = b.z;
    advanceBall(b, dt);
    const world = traceWorld(x0, y0, z0, b.x, b.y, b.z);
    let bestT = world ? world.t : Infinity;
    let victim: Player | null = null;
    let victimPose: Pose | null = null;
    const tNow = now();
    for (const p of players.values()) {
      if (!p.alive || p.team === b.team) continue; // no friendly fire; already out can't be hit again
      // where this target was on the shooter's screen (just "now" for bots and with compensation off)
      const pose = b.rewind ? poseAt(p, tNow - b.rewind) : poseAt(p, Infinity);
      if (!pose.alive) continue;
      const s = segmentHitsPlayer(x0, y0, z0, b.x, b.y, b.z, pose.x, pose.y, pose.z, pose.height, pose.yaw, pose.prone);
      if (s !== null && s < bestT) {
        bestT = s;
        victim = p;
        victimPose = { ...pose };
      }
    }
    // paint whizzing past makes bots duck
    for (const p of players.values()) {
      if (!p.bot || !p.alive || p.team === b.team) continue;
      if (Math.hypot(b.x - p.x, b.y - (p.y + 1), b.z - p.z) < 1.4) p.bot.brain.underFire(now());
    }
    if (victim) {
      const hp: V3 = [x0 + (b.x - x0) * bestT, y0 + (b.y - y0) * bestT, z0 + (b.z - z0) * bestT];
      const vp = victimPose!;
      const bouncedBefore = b.bounces > 0;
      const c = hitPlayer(b, hp[0], hp[1], hp[2], vp.x, vp.y, vp.z, vp.height, vp.yaw, vp.prone);
      if (c === 'break') {
        eliminate(victim, b, hp, vp, bouncedBefore);
        balls.splice(i, 1);
      } else {
        // it skipped off them: they play on, and the ball carries on (unless it's spent)
        broadcast({ t: 'bounce', victim: victim.id, shooter: b.owner, p: hp });
        count('bounces.player');
        if (c === 'stop') balls.splice(i, 1);
      }
    } else if (world) {
      // breaks, or bounces on (and can still eliminate someone)
      if (hitWorld(b, world) !== 'bounce') balls.splice(i, 1);
    } else if (b.age > BALL_LIFETIME || isOutOfBounds(b.x, b.y, b.z)) {
      balls.splice(i, 1);
    }
  }
}

/** take the player's requested name, at most once a second (the tick retries) */
function applyName(p: Player) {
  const t = now();
  if (p.wantName === p.name || t - p.lastRename < 1) return;
  p.lastRename = t;
  p.name = p.wantName;
  log(`  player ${p.id} is now "${p.name}"`);
  sendRoster();
}

function respawn(p: Player) {
  const sp = spawnPoint(p.team, p.slot);
  Object.assign(p, { alive: true, outUntil: 0, x: sp.x, y: sp.y, z: sp.z, yaw: sp.yaw, pitch: 0, crouch: false, prone: false });
  p.body = newBody(sp.x, sp.y, sp.z);
  p.bot?.brain.reset(sp.yaw);
  send(p.ws, { t: 'respawn', spawn: sp });
}

function eliminate(victim: Player, ball: Ball, p: V3, pose: Pose, bounced: boolean) {
  victim.alive = false;
  count('eliminations');
  // during warm-up you come back after a few seconds; during a point you're out until it ends
  victim.outUntil = match.phase === 'waiting' ? now() + RESPAWN_SECONDS : Infinity;
  broadcast({ t: 'hit', victim: victim.id, shooter: ball.owner, team: ball.team as Team, p, tp: [pose.x, pose.y, pose.z, pose.height], ...(bounced ? { bounced } : {}) });
  if (match.phase !== 'waiting') {
    victim.d++;
    const shooter = players.get(ball.owner);
    if (shooter) shooter.k++;
    sendRoster();
  }
}

function roster(): RosterEntry[] {
  return [...players.values()].map((p) => ({
    id: p.id, name: p.name, team: p.team, k: p.k, d: p.d, ping: Math.round(p.ping), bot: p.bot !== null,
    ...(p.vote ? { vote: p.vote } : {}),
    ...(p.modeVote ? { modeVote: p.modeVote } : {}),
  }));
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
  log(`  match: ${phase}${who} · ${score[0]}-${score[1]} · point ${match.round}`);
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
        if (!over) checkVotes(); // a switch everyone asked for waits for the break between points
        checkModeVotes();
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
        if (ROTATE) changeMap(voteWinner(humans().map((h) => h.vote), field.map.id));
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

let snapSeq = 0;
function snapshot() {
  if (!players.size) return;
  const snap: Extract<ServerMsg, { t: 'snap' }> = {
    t: 'snap',
    seq: ++snapSeq,
    score,
    round: roundState(),
    players: [...players.values()].map((p) => ({
      id: p.id, team: p.team, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, c: p.crouch, pr: p.prone, alive: p.alive,
    })),
  };
  const data = BINARY ? encodeSnap(snap) : JSON.stringify(snap);
  for (const p of players.values()) {
    if (!p.ws) continue;
    // and tell each browser where the server has *them*, so it can correct its prediction
    const b = p.body;
    const ack: Extract<ServerMsg, { t: 'ack' }> = { t: 'ack', seq: p.lastSeq, b: [b.x, b.y, b.z, b.vx, b.vy, b.vz, b.height, b.onGround ? 1 : 0] };
    if (data instanceof Uint8Array && p.fast?.send(data)) {
      // over the data channel; if the ack can't go that way, the WebSocket still gets it there
      const a = encodeAck(ack);
      if (!p.fast.send(a)) send(p.ws, a);
      continue;
    }
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(data);
    send(p.ws, BINARY ? encodeAck(ack) : ack);
  }
}

let last = now();
setInterval(() => {
  const t = now();
  tick(Math.min(0.1, t - last));
  last = t;
  tickTime((now() - t) * 1000);
}, 1000 / SERVER_TICK_HZ);
// game metrics for Datadog, every 10 s (only when tracing is on: server/telemetry.ts)
if (telemetryOn()) {
  setInterval(() => {
    const hs = humans();
    flush(
      {
        players: hs.length, bots: players.size - hs.length, balls: balls.length,
        'ping.avg_ms': hs.length ? hs.reduce((a, p) => a + p.ping, 0) / hs.length : 0,
        'ping.max_ms': hs.reduce((a, p) => Math.max(a, p.ping), 0),
      },
      { map: field.map.id, fire_mode: fireMode, phase: match.phase },
    );
  }, 10000);
}
setInterval(snapshot, 1000 / SNAPSHOT_HZ);
// latency probes + a roster refresh so pings on the scoreboard stay current
setInterval(() => {
  broadcast({ t: 'ping', s: now() });
  sendRoster();
}, 2000);

httpServer.listen(PORT, HOST, () => {
  log(`Splat Arena server on ws://localhost:${PORT}${STATIC_DIR ? ` (also serving the site from ${STATIC_DIR})` : ''}`);
});
log(`  allowed origins: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : 'any'}`);
log(`  wire format: ${BINARY ? 'binary' : 'json'}`);
log(`  data channels: ${rtc ? `UDP ${rtc.port}${rtc.publicIp ? `, advertised as ${rtc.publicIp}` : ''}${rtc.bindAddress ? `, bound to ${rtc.bindAddress}` : ''}` : 'off (WebSocket only)'}`);
log(`  map: ${ROTATE ? `${MAP_LIST.map((m) => m.name).join(' → ')}, a new one every match` : field.map.name}`);
log(`  voice: ${VOICE ? `${VOICE.url}, room ${VOICE.room}` : 'off (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET not set)'}`);
log(`  lag compensation: ${LAG_COMPENSATION ? `on, up to ${MAX_REWIND * 1000} ms` : 'off'}`);
log(`  datadog: ${telemetryOn() ? `tracing and metrics on (${process.env.DD_SERVICE ?? 'splat-arena'})` : 'off (DD_TRACE_ENABLED not set)'}${RUM ? ', RUM on for the page' : ''}`);
log(`  bots: ${BOT_TEAM_SIZE ? `fill teams to ${BOT_TEAM_SIZE}, ${process.env.BOT_SKILL ?? 'normal'} skill` : 'off'}`);

// Graceful shutdown (deploys and restarts send SIGTERM): stop taking players, tell everyone we're
// going away (their browsers reconnect on their own), then exit.
let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log(`${signal}: shutting down (${humans().length} players connected)`);
  httpServer.close();
  for (const p of players.values()) {
    p.fast?.close();
    p.ws?.close(1001, 'server restarting');
  }
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

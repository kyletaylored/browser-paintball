// Checks for every field in shared/maps.ts:  npm run test:maps
//
//  - layout: bunkers inside the field lines, clear of every start position, both halves mirrored
//  - collision: paint stops on the new shapes (upright prisms and logs) where they're drawn, and
//    players are pushed out of them
//  - bots: the navigation grid finds a way from one start line to the other
//
// With --bots it also plays one point per field on a real server, with bots on both teams, and
// checks they leave the start box and the point is won by eliminations (slow: about a minute). The
// default field's server isn't pinned to it, so it also checks the next field comes up after the match.
//
// Choosing the field: the vote rules, and a real server switching fields when players vote.
//
// Paint: glancing hits bounce and square ones break, and every machine rolls the same bounces.

import { MAP_LIST, DEFAULT_MAP, nextMap, unanimousVote, voteWinner } from '../shared/maps';
import { field, setMap, spawnPoint, footprintDistance, topOf, type Bunker } from '../shared/field';
import {
  traceWorld, stepMovement, advanceBall, hitWorld, ballSeed, bounceChance, BALL_DT, STAND_HEIGHT, PLAYER_RADIUS,
  type Ball, type Body, type MoveInput, type Contact,
} from '../shared/sim';
import { NavGrid } from './bots';
import { join, send, startServer, waitFor, snapWhere, rosterWhere, type Hit } from './test-client';
import type { ServerMsg } from '../shared/protocol';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failed++;
}

/** the same bunker on the other half */
function mirrored(b: Bunker, all: readonly Bunker[]): boolean {
  return all.some((o) => {
    if (o.kind !== b.kind || Math.abs(o.x + b.x) > 1e-6 || Math.abs(o.z - b.z) > 1e-6 || topOf(o) !== topOf(b)) return false;
    if (b.kind === 'poly' && o.kind === 'poly') {
      // same outline flipped in x (as a set of corners)
      return b.pts.every(([x, z]) => o.pts.some(([ox, oz]) => Math.abs(ox + x) < 1e-6 && Math.abs(oz - z) < 1e-6));
    }
    return true;
  });
}

for (const m of MAP_LIST) {
  console.log(`-- ${m.name}`);
  setMap(m.id);
  const bs = field.bunkers;

  // inside the lines: every footprint corner/edge within the field (sample around the outline)
  const outside = bs.filter((b, i) => {
    const r = field.bounds[i].r;
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      const x = b.x + Math.cos(a) * r;
      const z = b.z + Math.sin(a) * r;
      if (footprintDistance(b, x, z, i) <= 0 && (Math.abs(x) > field.halfL || Math.abs(z) > field.halfW)) return true;
    }
    return Math.abs(b.x) > field.halfL || Math.abs(b.z) > field.halfW;
  });
  check(`${bs.length} bunkers, all inside the field lines`, outside.length === 0, outside.map((b) => `${b.kind} at ${b.x},${b.z}`).join('; '));

  const blocked: string[] = [];
  for (const team of [0, 1] as const) {
    for (let slot = 0; slot < 6; slot++) {
      const sp = spawnPoint(team, slot);
      bs.forEach((b, i) => {
        if (footprintDistance(b, sp.x, sp.z, i) < PLAYER_RADIUS + 0.6) blocked.push(`team ${team} slot ${slot} by ${b.kind} at ${b.x},${b.z}`);
      });
    }
  }
  check('every start position is clear', blocked.length === 0, blocked.join('; '));

  const unmatched = bs.filter((b) => !mirrored(b, bs));
  check('both halves are mirror images', unmatched.length === 0, unmatched.map((b) => `${b.kind} at ${b.x},${b.z}`).join('; '));

  // paint stops on each bunker: shoot at it from 6 m away at half its height, from four sides
  let misses = 0;
  let tested = 0;
  bs.forEach((b, i) => {
    const y = Math.min(1, topOf(b) / 2);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x0 = b.x + dx * (field.bounds[i].r + 6);
      const z0 = b.z + dz * (field.bounds[i].r + 6);
      // skip shots that would hit something else on the way
      const hit = traceWorld(x0, y, z0, b.x, y, b.z);
      tested++;
      if (!hit) {
        misses++;
        continue;
      }
      // it hit *something* before the centre; if it's this bunker, the hit point is on its outline
      const onThis = Math.abs(footprintDistance(b, hit.x, hit.z, i)) < 0.02 || (b.kind === 'log' && hit.y <= topOf(b) + 0.02);
      const elsewhere = bs.some((o, j) => j !== i && footprintDistance(o, hit.x, hit.z, j) < 0.02);
      if (!onThis && !elsewhere) misses++;
    }
  });
  check(`paint stops on every bunker's surface (${tested} shots)`, misses === 0, `${misses} went through`);

  // a shot just over the top of each bunker clears it (nothing is taller than it's drawn)
  let blockedAbove = 0;
  bs.forEach((b, i) => {
    if (topOf(b) > 3) return; // trees
    const y = topOf(b) + 0.05;
    const r = field.bounds[i].r;
    const hit = traceWorld(b.x - r - 0.5, y, b.z, b.x + r + 0.5, y, b.z);
    if (hit && footprintDistance(b, hit.x, hit.z, i) < 0.05 && hit.ny !== 1) blockedAbove++;
  });
  check('paint flies over the top of every bunker', blockedAbove === 0, `${blockedAbove} blocked`);

  // walk a player straight into every bunker: they end up outside its footprint, or standing on top
  const inside: string[] = [];
  bs.forEach((b, i) => {
    if (topOf(b) < 0.5) return;
    const body: Body = { x: b.x - field.bounds[i].r - 1.2, y: 0, z: b.z + 0.05, vx: 0, vy: 0, vz: 0, height: STAND_HEIGHT, onGround: true };
    const move: MoveInput = { forward: 0, right: 1, jump: false, sprint: true, crouch: false, yaw: 0 }; // yaw 0: right is +x
    for (let s = 0; s < 240; s++) stepMovement(body, move, 1 / 120);
    if (footprintDistance(b, body.x, body.z, i) < PLAYER_RADIUS - 0.02 && body.y < topOf(b) - 0.1) inside.push(`${b.kind} at ${b.x},${b.z}`);
  });
  check('players are kept out of every bunker', inside.length === 0, inside.join('; '));

  const nav = new NavGrid();
  const a = spawnPoint(0, 2);
  const z = spawnPoint(1, 3);
  const path = nav.findPath(a.x, a.z, z.x, z.z);
  check(`bots can find a way across (${nav.cover.length} cover spots)`, path !== null && nav.cover.length > 20);
}

// ---- bots play a point on every field ------------------------------------------------------

async function botsPlay(id: string, name: string) {
  const rotating = id === DEFAULT_MAP;
  const s = await startServer({
    ...(rotating ? {} : { MAP: id }), BOT_TEAM_SIZE: '3', BOT_SKILL: 'hard', ROUND_SECONDS: '150', RTC_UDP_PORT: '0',
    POINTS_TO_WIN: '1', MATCH_OVER_SECONDS: '1', // one point is the whole match
  });
  try {
    const c = await join(s.url);
    const welcome = c.inbox.find((m): m is Extract<ServerMsg, { t: 'welcome' }> => m.t === 'welcome');
    const filled = await waitFor(c.inbox, rosterWhere((m) => m.players.filter((p) => p.bot).length === 5), 5000);
    const live = await waitFor(c.inbox, snapWhere((m) => m.round.phase === 'live'), 10000);
    const liveAt = Date.now();
    const from = c.inbox.length;
    const start = new Map(live?.players.map((p) => [p.id, p]) ?? []);
    const moved = await waitFor(c.inbox, snapWhere((m) => m.players.some((p) => {
      const s0 = start.get(p.id);
      return s0 !== undefined && p.id !== c.id && Math.hypot(p.x - s0.x, p.z - s0.z) > 5;
    })), 15000, from);
    const decided = await waitFor(c.inbox, snapWhere((m) => m.round.phase === 'point' || m.round.phase === 'matchover'), 160000, from);
    const decidedAt = Date.now();
    const hits = c.inbox.slice(from).filter((m): m is Hit => m.t === 'hit').length;
    check(`${name}: the server plays it (welcome says "${welcome?.map}")`, welcome?.map === id);
    check(`${name}: bots fill both teams and leave the start box`, filled !== null && moved !== null);
    // decided by eliminations, not the clock: a team (or both, trading paint on the same tick) is all out
    const standing = [0, 1].map((t) => decided?.players.filter((p) => p.team === t && p.alive).length ?? -1);
    const secs = Math.round((decidedAt - liveAt) / 1000);
    check(`${name}: the point is played out by eliminations in ${secs} s (${hits} hits, left standing ${standing.join('-')})`,
      decided !== null && standing.includes(0));
    if (rotating) {
      const next = nextMap(id);
      const changed = await waitFor(c.inbox, (m): m is Extract<ServerMsg, { t: 'map' }> => m.t === 'map', 5000, from);
      const after = c.inbox.indexOf(changed!);
      const respawn = changed && (await waitFor(c.inbox, (m): m is Extract<ServerMsg, { t: 'respawn' }> => m.t === 'respawn', 3000, after));
      check(`after the match the server moves on to "${next}" and respawns everyone there`, changed?.id === next && !!respawn);
    }
    c.ws.close();
  } finally {
    s.stop();
  }
}

// ---- choosing the field ----------------------------------------------------------------------

type MapMsg = Extract<ServerMsg, { t: 'map' }>;
type Welcome = Extract<ServerMsg, { t: 'welcome' }>;
const isMap = (m: ServerMsg): m is MapMsg => m.t === 'map';

function voteRules() {
  console.log('-- vote rules');
  check('nobody votes: the next field in the rotation', voteWinner([null, null], 'arena') === nextMap('arena'));
  check('most votes wins', voteWinner(['woods', 'beach', 'woods'], 'arena') === 'woods');
  check('a tie goes to the one that comes first after the current field', voteWinner(['woods', 'tournament'], 'beach') === 'woods');
  check('a tie with the current field moves on', voteWinner(['arena', 'beach'], 'arena') === 'beach');
  check('everyone wants the same other field: switch now', unanimousVote(['woods', 'woods'], 'arena') === 'woods');
  check('not if one player wants something else, or has no preference',
    unanimousVote(['woods', 'beach'], 'arena') === null && unanimousVote(['woods', null], 'arena') === null);
  check('not if they all want the field that is on', unanimousVote(['arena'], 'arena') === null);
}

async function voting() {
  console.log('-- voting on a real server');
  // short points, so a switch that waits for the break comes quickly
  const s = await startServer({ BOT_TEAM_SIZE: '2', ROUND_SECONDS: '6', RTC_UDP_PORT: '0' });
  try {
    const a = await join(s.url);
    check('the welcome says players choose the field', a.inbox.find((m): m is Welcome => m.t === 'welcome')?.vote === true);
    let from = a.inbox.length;
    send(a.ws, { t: 'vote', map: 'woods' });
    const toWoods = await waitFor(a.inbox, isMap, 4000, from);
    const respawn = toWoods && (await waitFor(a.inbox, (m): m is Extract<ServerMsg, { t: 'respawn' }> => m.t === 'respawn', 3000, a.inbox.indexOf(toWoods)));
    check('alone with bots, voting for Woods switches to it straight away', toWoods?.id === 'woods' && !!respawn);

    const b = await join(s.url);
    check('a player who joins gets the field that is on', b.inbox.find((m): m is Welcome => m.t === 'welcome')?.map === 'woods');
    from = a.inbox.length;
    send(b.ws, { t: 'vote', map: 'beach' });
    const votes = await waitFor(a.inbox, rosterWhere((m) => m.players.filter((p) => p.vote).length === 2), 2000, from);
    check('everyone sees both votes', votes !== null && votes.players.find((p) => p.id === b.id)?.vote === 'beach');
    check('a split vote changes nothing yet', (await waitFor(a.inbox, isMap, 1500, from)) === null);
    send(a.ws, { t: 'vote', map: 'beach' });
    const toBeach = await waitFor(a.inbox, isMap, 15000, from);
    check('once both want Beach it switches, at the latest after the point', toBeach?.id === 'beach');
    a.ws.close();
    b.ws.close();
  } finally {
    s.stop();
  }

  const pinned = await startServer({ BOT_TEAM_SIZE: '2', MAP: 'tournament', RTC_UDP_PORT: '0' });
  try {
    const c = await join(pinned.url);
    check('a server pinned to one field says there is no vote', c.inbox.find((m): m is Welcome => m.t === 'welcome')?.vote === false);
    const from = c.inbox.length;
    send(c.ws, { t: 'vote', map: 'woods' });
    check('and ignores votes', (await waitFor(c.inbox, isMap, 1500, from)) === null);
    c.ws.close();
  } finally {
    pinned.stop();
  }
}

// ---- paint bounces ----------------------------------------------------------------------------

/** fly a ball from o with velocity v until it touches something; what happened there */
function firstContact(o: [number, number, number], v: [number, number, number], seed: number): { c: Contact; ball: Ball } | null {
  const b: Ball = { x: o[0], y: o[1], z: o[2], vx: v[0], vy: v[1], vz: v[2], age: 0, owner: 0, team: 0, seed, bounces: 0 };
  for (let i = 0; i < 400; i++) {
    const x0 = b.x;
    const y0 = b.y;
    const z0 = b.z;
    advanceBall(b, BALL_DT);
    const w = traceWorld(x0, y0, z0, b.x, b.y, b.z);
    if (w) return { c: hitWorld(b, w), ball: b };
  }
  return null;
}

function paintRules() {
  console.log('-- paint bounces');
  setMap(DEFAULT_MAP);
  // out past the side line, where only the ground is in the way
  const z = field.halfW + field.margin / 2;
  let glancing = 0;
  let square = 0;
  let after: Ball | null = null;
  for (let s = 1; s <= 400; s++) {
    const g = firstContact([-10, 0.3, z], [80, -3, 0], s * 2654435761);
    if (g?.c === 'bounce') {
      glancing++;
      after ??= g.ball;
    }
    if (firstContact([0, 1.5, z], [0, -60, 0], s * 2654435761)?.c !== 'break') square++;
  }
  check(`a glancing hit usually bounces (${glancing} of 400)`, glancing > 280 && glancing < 400);
  check(`a square hit never does (${square} of 400 didn't break)`, square === 0);
  check('a bounced ball flies on, slower, away from the surface',
    after !== null && after.vy > 0 && Math.hypot(after.vx, after.vy, after.vz) < 80 && after.bounces === 1);
  check('slow paint bounces more easily than fast paint at the same angle', bounceChance(0.4, 20) > bounceChance(0.4, 80));
  // the seed is the firing point rounded the way the wire sends it, so the server and every browser agree
  const o: [number, number, number] = [3.14159265, 1.23456789, -7.7777777];
  const sent = Array.from(new Float32Array(o));
  check('the shooter, the server and everyone else get the same seed', ballSeed(o) === ballSeed(sent) && ballSeed(o) !== ballSeed([o[0] + 0.01, o[1], o[2]]));
  const a = firstContact([-10, 0.3, z], [80, -3, 0], ballSeed(o));
  const b = firstContact([-10, 0.3, z], [80, -3, 0], ballSeed(sent));
  check('so the same ball bounces the same way on every machine', a !== null && b !== null && a.c === b.c && a.ball.vx === b.ball.vx && a.ball.vy === b.ball.vy);
}

paintRules();
voteRules();
await voting();

if (process.argv.includes('--bots')) {
  console.log('-- bots, one point per field (in parallel)');
  await Promise.all(MAP_LIST.map((m) => botsPlay(m.id, m.name)));
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall map checks passed');
process.exit(0);

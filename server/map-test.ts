// Checks for every field in shared/maps.ts:  npm run test:maps
//
//  - layout: bunkers inside the field lines, clear of every start position, both halves mirrored
//  - collision: paint stops on every shape (upright prisms, logs, tapering shapes and shaped walls)
//    where it's drawn, and players are pushed out of them
//  - bots: the navigation grid finds a way from one start line to the other
//
// With --bots it also plays one point per field on a real server, with bots on both teams, and
// checks they leave the start box and the point is won by eliminations (slow: about a minute). The
// default field's server isn't pinned to it, so it also checks the next field comes up after the match.
//
// Choosing the field: the vote rules, and a real server switching fields when players vote.
//
// Paint: glancing hits bounce and square ones break, and every machine rolls the same bounces.
// Paint off players: most hits break, glancing ones often skip off (and the player plays on).
// Lying down: the body is hit along the ground, not as a short upright stub.
// Out: from anywhere on every field, an eliminated player walks off past the side line.
// Shaped tops: paint follows a pyramid's slope and a wall's top line (over a dip, through a notch).
// Planets: paint hits a ball where it's round, a sunk dome only above the ground, and nobody stands on one.

import { MAP_LIST, DEFAULT_MAP, nextMap, unanimousVote, voteWinner } from '../shared/maps';
import { field, setMap, useBunkers, spawnPoint, footprintDistance, taperHeight, topOf, type Bunker } from '../shared/field';
import {
  traceWorld, stepMovement, advanceBall, hitWorld, hitPlayer, ballSeed, bounceChance, groundBounceChance, ballFlightTime, ballDrop, playerBounceChance, segmentHitsPlayer, BALL_DT, STAND_HEIGHT,
  PRONE_HEIGHT, PLAYER_RADIUS, INPUT_DT,
  type Ball, type Body, type MoveInput, type Contact,
} from '../shared/sim';
import { NavGrid } from './bots';
import { walkOffInput, walkOffMap, offField, waitLine } from '../shared/walkoff';
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
    const flipped = (a: [number, number][], c: [number, number][]) =>
      a.length === c.length && a.every(([x, z]) => c.some(([ox, oz]) => Math.abs(ox + x) < 1e-6 && Math.abs(oz - z) < 1e-6));
    if ((b.kind === 'poly' && o.kind === 'poly') || (b.kind === 'taper' && o.kind === 'taper')) {
      // same outline flipped in x (as a set of corners)
      if (!flipped(b.pts, o.pts)) return false;
      if (b.kind === 'taper' && o.kind === 'taper') {
        const [ax, az] = b.apex ?? [0, 0];
        const [bx, bz] = o.apex ?? [0, 0];
        return b.top === o.top && Math.abs(ax + bx) < 1e-6 && Math.abs(az - bz) < 1e-6;
      }
      return true;
    }
    if (b.kind === 'orb' && o.kind === 'orb') return b.r === o.r;
    if (b.kind === 'profile' && o.kind === 'profile') {
      if (b.axis !== o.axis || b.d !== o.d) return false;
      // a wall along x runs the other way on the other half; one along z is the same wall
      const want = b.axis === 'z' ? b.line : b.line.map(([u, y]) => [-u, y]).reverse();
      return JSON.stringify(want) === JSON.stringify(o.line);
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
      // (a sloped or shaped top is hit inside its footprint, not on its outline)
      const fd = footprintDistance(b, hit.x, hit.z, i);
      const onThis = Math.abs(fd) < 0.02 || (b.kind === 'log' && hit.y <= topOf(b) + 0.02) ||
        ((b.kind === 'taper' || b.kind === 'profile' || b.kind === 'orb') && fd < 0.02);
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
    const move: MoveInput = { forward: 0, right: 1, jump: false, sprint: true, crouch: false, prone: false, yaw: 0 }; // yaw 0: right is +x
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

// ---- shaped tops: paint follows the slope of a pyramid and the top line of a wall ------------

{
  console.log('-- shaped bunkers');
  const near = (a: number, b: number, eps = 0.02) => Math.abs(a - b) < eps;
  const sq: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const wLine: [number, number][] = [[-1.5, 1.0], [-1.1, 1.65], [-0.55, 1.12], [0, 1.35], [0.55, 1.12], [1.1, 1.65], [1.5, 1.0]];
  const notch: [number, number][] = [[-1.1, 1.5], [-0.45, 1.5], [-0.3, 1.0], [0.3, 1.0], [0.45, 1.5], [1.1, 1.5]];
  useBunkers([
    { kind: 'taper', x: 0, z: 0, pts: sq, h: 2, top: 0, color: 0 }, // a square pyramid
    { kind: 'taper', x: 0, z: 10, pts: sq, h: 2, top: 0.2, apex: [-1, 0], color: 0 }, // a wedge, upright at its -x side
    { kind: 'profile', x: 10, z: 0, axis: 'x', d: 0.9, line: wLine, color: 0 }, // an M wall along x
    { kind: 'profile', x: 10, z: 10, axis: 'z', d: 0.9, line: notch, color: 0 }, // a notched wall along z
  ]);

  // pyramid: at half height it's half as wide, and its sides face out and up
  let h = traceWorld(-5, 1, 0, 5, 1, 0);
  check('a shot at a pyramid hits its sloped side where it is', !!h && h.bunker === 0 && near(h.x, -0.5) && h.nx < 0 && h.ny > 0, JSON.stringify(h));
  h = traceWorld(-5, 1.9, 0.5, 5, 1.9, 0.5);
  check('a shot past the narrow top of a pyramid flies by', !h, JSON.stringify(h));
  h = traceWorld(0.3, 3, 0.3, 0.3, -0.5, 0.3);
  check('paint dropping on a pyramid lands on its slope', !!h && h.bunker === 0 && near(h.y, 1.4) && h.ny > 0.4, JSON.stringify(h));
  check('a pyramid is as tall as it says, at its point', near(taperHeight(0, 0, 0), 2) && near(taperHeight(0, 0.5, 0), 1) && taperHeight(0, 1.5, 0) < 0);

  // wedge: its back is upright, its front slopes up to the narrow top over the back
  h = traceWorld(-5, 1.5, 10, 5, 1.5, 10);
  check('a wedge stops paint on its upright back', !!h && h.bunker === 1 && near(h.x, -1) && near(h.nx, -1), JSON.stringify(h));
  h = traceWorld(5, 1.5, 10, -5, 1.5, 10);
  check('a wedge stops paint on its sloped front, further back', !!h && h.bunker === 1 && near(h.x, -0.2) && h.nx > 0 && h.ny > 0, JSON.stringify(h));

  // M wall along x (x 8.5 to 11.5, z -0.45 to 0.45)
  h = traceWorld(10.55, 1.3, -5, 10.55, 1.3, 5);
  check('a shot over a dip in an M wall clears it', !h, JSON.stringify(h));
  h = traceWorld(11.1, 1.3, -5, 11.1, 1.3, 5);
  check('a shot at a peak of an M wall hits its face', !!h && h.bunker === 2 && near(h.z, -0.45) && near(h.nz, -1), JSON.stringify(h));
  h = traceWorld(3, 1.3, 0, 17, 1.3, 0);
  check('a shot along an M wall clears its low end and hits the rise to the peak', !!h && h.bunker === 2 && near(h.x, 10 - 1.3154, 0.01) && h.nx < 0 && h.ny > 0, JSON.stringify(h));
  h = traceWorld(3, 0.6, 0, 17, 0.6, 0);
  check('lower down, the same shot hits the end of the wall', !!h && h.bunker === 2 && near(h.x, 8.5) && near(h.nx, -1), JSON.stringify(h));

  // notched wall along z (z 8.9 to 11.1, x 9.55 to 10.45)
  h = traceWorld(5, 1.25, 10, 15, 1.25, 10);
  check('a shot through the notch of a wall goes through', !h, JSON.stringify(h));
  h = traceWorld(5, 0.8, 10, 15, 0.8, 10);
  check('a shot under the notch hits the wall', !!h && h.bunker === 3 && near(h.x, 9.55) && near(h.nx, -1), JSON.stringify(h));
  h = traceWorld(5, 1.25, 9.2, 15, 1.25, 9.2);
  check('a shot beside the notch hits the wall', !!h && h.bunker === 3 && near(h.x, 9.55), JSON.stringify(h));

  // players can't walk in, and slide off if they land on top
  const walk = (x: number, z: number, right: number, fwd: number, y = 0) => {
    const body: Body = { x, y, z, vx: 0, vy: 0, vz: 0, height: STAND_HEIGHT, onGround: y === 0 };
    const move: MoveInput = { forward: fwd, right, jump: false, sprint: true, crouch: false, prone: false, yaw: 0 };
    for (let s = 0; s < 240; s++) stepMovement(body, move, 1 / 120);
    return body;
  };
  let body = walk(-3, 0.05, 1, 0);
  check('players are kept out of a pyramid', footprintDistance(field.bunkers[0], body.x, body.z, 0) > PLAYER_RADIUS - 0.02, JSON.stringify(body));
  body = walk(10.2, -3, 0, -1);
  check('players are kept out of an M wall, even at a dip', footprintDistance(field.bunkers[2], body.x, body.z, 2) > PLAYER_RADIUS - 0.02, JSON.stringify(body));
  body = walk(0.1, 0.1, 0, 0, 2.6);
  check('a player dropped on a pyramid slides off it', footprintDistance(field.bunkers[0], body.x, body.z, 0) > PLAYER_RADIUS - 0.02 && body.y < 0.05, JSON.stringify(body));

  // planets: a ball resting on the ground (centre 1 m up) and a dome sunk to 0.3 m
  useBunkers([
    { kind: 'orb', x: 0, z: 0, r: 1, color: 0 },
    { kind: 'orb', x: 0, z: 10, r: 1.4, y: 0.3, color: 0 },
  ]);
  h = traceWorld(-5, 1, 0, 5, 1, 0);
  check('a shot at the middle of a planet hits it square on', !!h && h.bunker === 0 && near(h.x, -1) && near(h.nx, -1), JSON.stringify(h));
  h = traceWorld(-5, 1.6, 0, 5, 1.6, 0);
  check('higher up it hits the curve, further back, facing up', !!h && h.bunker === 0 && near(h.x, -0.8) && h.ny > 0.5, JSON.stringify(h));
  h = traceWorld(-5, 1, 1.05, 5, 1, 1.05);
  check('a shot just past a planet flies by', !h, JSON.stringify(h));
  h = traceWorld(-5, 1.0, 10, 5, 1.0, 10);
  check('a dome is hit on its slope, above the ground', !!h && h.bunker === 1 && near(h.x, -Math.sqrt(1.4 * 1.4 - 0.7 * 0.7)) && h.ny > 0, JSON.stringify(h));
  h = traceWorld(-5, 1.8, 10, 5, 1.8, 10);
  check('a shot over a dome clears it', !h && near(topOf(field.bunkers[1]), 1.7), JSON.stringify(h));
  body = walk(-3, 0.05, 1, 0);
  check('players are kept out of a planet', footprintDistance(field.bunkers[0], body.x, body.z, 0) > PLAYER_RADIUS - 0.02, JSON.stringify(body));
  body = walk(0.1, 0.1, 0, 0, 2.2);
  check('a player dropped on a planet slides off it', footprintDistance(field.bunkers[0], body.x, body.z, 0) > PLAYER_RADIUS - 0.02 && body.y < 0.05, JSON.stringify(body));
  const sunk = MAP_LIST.flatMap((m) => m.bunkers).filter((b) => b.kind === 'orb' && ((b.y ?? b.r) > b.r + 1e-9 || (b.y ?? b.r) < 0));
  check('no planet floats above the ground or sits under it', sunk.length === 0, sunk.map((b) => `${b.x},${b.z}`).join('; '));

  useBunkers(field.map.bunkers);
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
    const g = firstContact([-10, 0.3, z], [55, -3, 0], s * 2654435761);
    if (g?.c === 'bounce') {
      glancing++;
      after ??= g.ball;
    }
    if (firstContact([0, 1.5, z], [0, -50, 0], s * 2654435761)?.c === 'bounce') square++;
  }
  check(`paint skimming the ground nearly always bounces (${glancing} of 400)`, glancing > 340 && glancing < 400);
  check(`even straight down, the ground bounces about half (${square} of 400)`, square > 140 && square < 300);
  check('a bounced ball flies on, slower, away from the surface',
    after !== null && after.vy > 0 && Math.hypot(after.vx, after.vy, after.vz) < 55 && after.bounces === 1);
  // the arena's centre bunker: a box 2 m across at the origin
  let squareBunker = 0;
  let angledBunker = 0;
  let glancingBunker = 0;
  for (let s = 1; s <= 400; s++) {
    if (firstContact([-5, 1, 0.3], [55, 0, 0], s * 2654435761)?.c !== 'break') squareBunker++;
    if (firstContact([-5, 1, -3.5], [40, 0, 40], s * 2654435761)?.c !== 'break') angledBunker++;
    if (firstContact([-6, 1, -2], [55, 0, 8], s * 2654435761)?.c === 'bounce') glancingBunker++;
  }
  check(`a square hit on a bunker always breaks (${squareBunker} of 400 didn't)`, squareBunker === 0);
  check(`so does one at 45° (${angledBunker} of 400 didn't)`, angledBunker === 0);
  check(`a shallow hit on a bunker usually bounces (${glancingBunker} of 400)`, glancingBunker > 260 && glancingBunker < 400);
  check('the ground bounces more than a bunker at the same angle', groundBounceChance(0.4) > bounceChance(0.4) && bounceChance(0.6) === 0);
  // what bots aim with matches how the ball really flies
  {
    const b: Ball = { x: 0, y: 10, z: z, vx: 55, vy: 0, vz: 0, age: 0, owner: 0, team: 0, seed: 1, bounces: 0 };
    while (b.x < 30) advanceBall(b, BALL_DT);
    const t = ballFlightTime(30);
    check(`flight time to 30 m is close (${t.toFixed(3)} s, really ${b.age.toFixed(3)} s)`, Math.abs(t - b.age) < 0.03);
    check(`and so is the drop (${ballDrop(t).toFixed(2)} m, really ${(10 - b.y).toFixed(2)} m)`, Math.abs(ballDrop(t) - (10 - b.y)) < 0.12);
  }
  // the seed is the firing point rounded the way the wire sends it, so the server and every browser agree
  const o: [number, number, number] = [3.14159265, 1.23456789, -7.7777777];
  const sent = Array.from(new Float32Array(o));
  check('the shooter, the server and everyone else get the same seed', ballSeed(o) === ballSeed(sent) && ballSeed(o) !== ballSeed([o[0] + 0.01, o[1], o[2]]));
  const a = firstContact([-10, 0.3, z], [55, -3, 0], ballSeed(o));
  const b = firstContact([-10, 0.3, z], [55, -3, 0], ballSeed(sent));
  check('so the same ball bounces the same way on every machine', a !== null && b !== null && a.c === b.c && a.ball.vx === b.ball.vx && a.ball.vy === b.ball.vy);
}

/** a ball fired along +x at a standing player at the origin, `off` metres to the side of their middle */
function atPlayer(off: number, seed: number, prone = false): { c: Contact; ball: Ball } | null {
  const ball: Ball = { x: -3, y: prone ? 0.2 : 1.2, z: off, vx: 85, vy: 0, vz: 0, age: 0, owner: 1, team: 0, seed, bounces: 0 };
  const h = prone ? PRONE_HEIGHT : STAND_HEIGHT;
  const t = segmentHitsPlayer(ball.x, ball.y, ball.z, 3, ball.y, ball.z, 0, 0, 0, h, 0, prone);
  if (t === null) return null;
  const x = ball.x + 6 * t;
  return { c: hitPlayer(ball, x, ball.y, ball.z, 0, 0, 0, h, 0, prone), ball };
}

function playerBounces() {
  console.log('-- paint bouncing off players');
  let square = 0;
  let glancing = 0;
  let away = true;
  let same = true;
  for (let s = 1; s <= 1000; s++) {
    const seed = s * 2654435761;
    if (atPlayer(0, seed)?.c !== 'break') square++;
    const g = atPlayer(PLAYER_RADIUS * 0.97, seed);
    if (g && g.c !== 'break') {
      glancing++;
      away &&= g.ball.vz > 0; // pushed out to the side it skimmed
    }
    same &&= atPlayer(0.2, seed)?.c === atPlayer(0.2, seed)?.c;
  }
  check(`a square hit on a player almost always breaks (${square} of 1000 bounced)`, square > 5 && square < 70);
  check(`a glancing one often skips off (${glancing} of 1000)`, glancing > 200 && glancing < 450);
  // shots spread evenly across the body: a few in a hundred bounce, like real paint
  let any = 0;
  for (let s = 1; s <= 2000; s++) if (atPlayer(((s % 200) / 200) * (PLAYER_RADIUS + 0.008), s * 2246822519)?.c !== 'break') any++;
  check(`across the whole body, a few hits in a hundred bounce (${(any / 20).toFixed(1)}%)`, any > 60 && any < 260);
  check('a ball skipping off flies on away from the body', away);
  check('the same ball does the same thing on every machine', same);
  check('slow paint bounces off players more easily', playerBounceChance(0.9, 20) > playerBounceChance(0.9, 80));
  let proneOk = 0;
  for (let s = 1; s <= 200; s++) if (atPlayer(0.5, s * 2654435761, true) !== null) proneOk++;
  check('someone lying down can be hit and bounced off along their body', proneOk === 200);
}

function lyingDown() {
  console.log('-- lying down');
  // a player at the origin facing -z (yaw 0): head toward -z, legs out toward +z
  const across = (y: number, z: number, prone: boolean) =>
    segmentHitsPlayer(-3, y, z, 3, y, z, 0, 0, 0, prone ? PRONE_HEIGHT : STAND_HEIGHT, 0, prone) !== null;
  check('a ball at chest height over someone lying down misses them', !across(1.0, 0, true) && across(1.0, 0, false));
  check('one along the ground at their legs, a metre behind, hits', across(0.15, 1.0, true) && !across(0.15, 1.0, false));
  check('one at their head, just ahead of where they stand, hits', across(0.25, -0.3, true));
  check('one past their feet misses', !across(0.15, 1.8, true));
  // facing +x (yaw -π/2) the legs go out toward -x
  check('the body turns with where they face',
    segmentHitsPlayer(-1, 0.15, -3, -1, 0.15, 3, 0, 0, 0, PRONE_HEIGHT, -Math.PI / 2, true) !== null &&
    segmentHitsPlayer(1, 0.15, -3, 1, 0.15, 3, 0, 0, 0, PRONE_HEIGHT, -Math.PI / 2, true) === null);
}

function walkingOff() {
  console.log('-- walking off when out');
  for (const m of MAP_LIST) {
    setMap(m.id);
    const t0 = performance.now();
    walkOffMap();
    const built = performance.now() - t0;
    let starts = 0;
    let slowest = 0;
    const stuck: string[] = [];
    const move: MoveInput = { forward: 0, right: 0, jump: false, sprint: false, crouch: false, prone: false, yaw: 0 };
    // starts every 2 m over the whole field, wherever a player can stand
    for (let x = -field.halfL + 0.5; x <= field.halfL - 0.5; x += 2) {
      for (let z = -field.halfW + 0.5; z <= field.halfW - 0.5; z += 2) {
        if (field.bunkers.some((b, i) => footprintDistance(b, x, z, i) < PLAYER_RADIUS)) continue;
        starts++;
        const body: Body = { x, y: 0, z, vx: 0, vy: 0, vz: 0, height: STAND_HEIGHT, onGround: true };
        let t = 0;
        for (; t < 30 && walkOffInput(body, move); t += INPUT_DT) stepMovement(body, move, INPUT_DT);
        if (!offField(body.x, body.z) || Math.abs(body.z) < waitLine() - 0.1) stuck.push(`(${x.toFixed(1)}, ${z.toFixed(1)})`);
        else slowest = Math.max(slowest, t);
      }
    }
    check(`${m.name}: out players walk off from all ${starts} starts (slowest ${slowest.toFixed(1)} s)`, !stuck.length, `stuck from ${stuck.slice(0, 5).join(' ')}`);
    check(`${m.name}: the way off is worked out quickly (${built.toFixed(0)} ms)`, built < 300);
  }
  setMap(DEFAULT_MAP);
}

paintRules();
playerBounces();
lyingDown();
walkingOff();
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

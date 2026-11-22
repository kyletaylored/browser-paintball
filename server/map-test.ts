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

import { MAP_LIST, DEFAULT_MAP, nextMap } from '../shared/maps';
import { field, setMap, spawnPoint, footprintDistance, topOf, type Bunker } from '../shared/field';
import { traceWorld, stepMovement, STAND_HEIGHT, PLAYER_RADIUS, type Body, type MoveInput } from '../shared/sim';
import { NavGrid } from './bots';
import { join, startServer, waitFor, snapWhere, rosterWhere, type Hit } from './test-client';
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

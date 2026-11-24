// What wins a point. Knocking the other team out isn't enough on its own: you still have to finish it.
//
//  - buzzer (the speedball fields): each team has a buzzer at the back of its own end. Touch the
//    other team's buzzer while you're still in and your team wins the point.
//  - flag (the woods): each team has a flag at the back of its own end. Grab the other team's flag
//    and carry it back to your own end. If the carrier is eliminated the flag drops where they
//    were: the attackers can pick it up again, and a defender who touches it sends it home.
//
// Time running out gives the point to the team with more players still in (no point if level).
//
// The server runs stepObjective every tick and is the only one that decides; browsers draw the
// buzzers and flags from the same positions and the events the server sends. No DOM or Node APIs.

import { field } from './field';
import type { Team } from './protocol';

export type ObjectiveKind = 'buzzer' | 'flag';

/** how close (horizontally, m) a player's middle has to get to touch a buzzer */
export const BUZZ_RANGE = 1.0;
/** how close to grab a flag, send your own home, or reach your base with one */
export const FLAG_RANGE = 1.2;
/** how far behind the back line the buzzer / flag stand is */
const BASE_BEHIND = 0.5;

/** the field's objective (each map says; the speedball fields default to a buzzer) */
export function objectiveKind(): ObjectiveKind {
  return field.map.objective ?? 'buzzer';
}

/** a team's base: where its buzzer or flag stands, just behind the middle of its back line */
export function baseOf(team: Team): { x: number; z: number } {
  return { x: (team === 0 ? -1 : 1) * (field.halfL + BASE_BEHIND), z: 0 };
}

/** where a flag is: at its base, carried by a player, or lying where its carrier was eliminated */
export interface FlagState {
  at: 'home' | 'carried' | 'dropped';
  /** the player carrying it (when carried), else -1 */
  carrier: number;
  /** where it is now (follows the carrier) */
  x: number;
  z: number;
}

export function homeFlags(): [FlagState, FlagState] {
  return [0, 1].map((t) => ({ at: 'home', carrier: -1, ...baseOf(t as Team) })) as [FlagState, FlagState];
}

/**
 * Something that happened to an objective. `team` is whose flag or buzzer it is; `by` the player.
 * buzz and capture win the point for the other team.
 */
export type ObjectiveEvent =
  | { e: 'buzz'; team: Team; by: number }
  | { e: 'take'; team: Team; by: number }
  | { e: 'drop'; team: Team; by: number; x: number; z: number }
  | { e: 'return'; team: Team; by: number }
  | { e: 'capture'; team: Team; by: number };

export interface ObjectivePlayer {
  id: number;
  team: Team;
  x: number;
  z: number;
  alive: boolean;
}

const near = (p: ObjectivePlayer, x: number, z: number, r: number) => Math.hypot(p.x - x, p.z - z) < r;

/**
 * One tick of a live point: who touched what. Updates `flags` (flag fields only) and returns what
 * happened, in order. A buzz or capture ends the point, so nothing after it in the same tick counts.
 * `players` should include everyone, in and out: a carrier who's out (or gone) drops the flag.
 */
export function stepObjective(kind: ObjectiveKind, flags: [FlagState, FlagState], players: readonly ObjectivePlayer[]): ObjectiveEvent[] {
  const events: ObjectiveEvent[] = [];
  if (kind === 'buzzer') {
    for (const p of players) {
      if (!p.alive) continue;
      const b = baseOf((1 - p.team) as Team);
      if (near(p, b.x, b.z, BUZZ_RANGE)) return [{ e: 'buzz', team: (1 - p.team) as Team, by: p.id }];
    }
    return events;
  }
  const byId = new Map(players.map((p) => [p.id, p]));
  // carriers: follow them, or drop the flag where they went out
  for (const t of [0, 1] as const) {
    const f = flags[t];
    if (f.at !== 'carried') continue;
    const c = byId.get(f.carrier);
    if (c && c.alive) {
      f.x = c.x;
      f.z = c.z;
    } else {
      events.push({ e: 'drop', team: t, by: f.carrier, x: f.x, z: f.z });
      f.at = 'dropped';
      f.carrier = -1;
    }
  }
  for (const p of players) {
    if (!p.alive) continue;
    const mine = flags[p.team];
    const theirs = flags[1 - p.team];
    const them = (1 - p.team) as Team;
    // send our own dropped flag home
    if (mine.at === 'dropped' && near(p, mine.x, mine.z, FLAG_RANGE)) {
      Object.assign(mine, { at: 'home', carrier: -1, ...baseOf(p.team) });
      events.push({ e: 'return', team: p.team, by: p.id });
    }
    // grab theirs, from their base or off the ground
    if (theirs.at !== 'carried' && near(p, theirs.x, theirs.z, FLAG_RANGE)) {
      Object.assign(theirs, { at: 'carried', carrier: p.id, x: p.x, z: p.z });
      events.push({ e: 'take', team: them, by: p.id });
    }
    // bring it home
    const home = baseOf(p.team);
    if (theirs.at === 'carried' && theirs.carrier === p.id && near(p, home.x, home.z, FLAG_RANGE)) {
      events.push({ e: 'capture', team: them, by: p.id });
      return events;
    }
  }
  return events;
}

/** the team a buzz or capture wins the point for */
export function scorer(ev: ObjectiveEvent): Team | -1 {
  return ev.e === 'buzz' || ev.e === 'capture' ? ((1 - ev.team) as Team) : -1;
}

/** time ran out: the team with more players still in wins the point, or nobody if level */
export function timeWinner(alive: readonly [number, number]): Team | -1 {
  return alive[0] > alive[1] ? 0 : alive[1] > alive[0] ? 1 : -1;
}

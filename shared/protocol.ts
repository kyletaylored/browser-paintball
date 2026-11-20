// Messages between the browser and the game server. Both sides import this file,
// so a change here shows up as a type error on whichever side you forgot to update.
//
// Everything is JSON for readability. Packing per-tick traffic as binary
// (ArrayBuffer + DataView) is a good optimisation once this works.

export type Team = 0 | 1;
export type V3 = [number, number, number];

export interface Spawn {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface PlayerSnap {
  id: number;
  team: Team;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** crouching */
  c: boolean;
  alive: boolean;
}

/**
 * Match flow, decided by the server:
 *  waiting   – fewer than one player per team; warm-up, eliminated players respawn
 *  countdown – everyone reset to their start box and frozen
 *  live      – eliminated players stay out until the point ends
 *  point     – a team won the point (or time ran out: winner -1), short pause
 *  matchover – a team reached `toWin` points, longer pause, then the score resets
 */
export type RoundPhase = 'waiting' | 'countdown' | 'live' | 'point' | 'matchover';

export interface RoundState {
  phase: RoundPhase;
  /** seconds until the phase ends (0 while waiting) */
  endsIn: number;
  /** point number in the current match, from 1 */
  round: number;
  /** who won the point / match during 'point' and 'matchover'; -1 for a draw or not decided */
  winner: Team | -1;
  /** points needed to win the match */
  toWin: number;
}

/** browser → server */
export type ClientMsg =
  | { t: 'state'; x: number; y: number; z: number; yaw: number; pitch: number; c: boolean }
  | { t: 'fire'; o: V3; d: V3 };

/** server → browser */
export type ServerMsg =
  | { t: 'welcome'; id: number; team: Team; spawn: Spawn; round: RoundState }
  /** score is points won this match */
  | { t: 'snap'; time: number; players: PlayerSnap[]; score: [number, number]; round: RoundState }
  | { t: 'ball'; owner: number; team: Team; o: V3; v: V3 }
  | { t: 'hit'; victim: number; shooter: number; team: Team; p: V3 }
  | { t: 'respawn'; spawn: Spawn }
  | { t: 'leave'; id: number };

export const DEFAULT_PORT = 8787;
export const TEAM_COLORS: readonly [number, number] = [0xff3b3b, 0x3b8bff];
export const TEAM_NAMES: readonly [string, string] = ['Red', 'Blue'];

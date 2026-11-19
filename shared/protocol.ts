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

/** browser → server */
export type ClientMsg =
  | { t: 'state'; x: number; y: number; z: number; yaw: number; pitch: number; c: boolean }
  | { t: 'fire'; o: V3; d: V3 };

/** server → browser */
export type ServerMsg =
  | { t: 'welcome'; id: number; team: Team; spawn: Spawn }
  | { t: 'snap'; time: number; players: PlayerSnap[]; score: [number, number] }
  | { t: 'ball'; owner: number; team: Team; o: V3; v: V3 }
  | { t: 'hit'; victim: number; shooter: number; team: Team; p: V3 }
  | { t: 'respawn'; spawn: Spawn }
  | { t: 'leave'; id: number };

export const DEFAULT_PORT = 8787;
export const TEAM_COLORS: readonly [number, number] = [0xff3b3b, 0x3b8bff];
export const TEAM_NAMES: readonly [string, string] = ['Red', 'Blue'];

// Messages between the browser and the game server. Both sides import this file,
// so a change here shows up as a type error on whichever side you forgot to update.
//
// The high-frequency messages (snapshots, acks, paintballs, input frames) travel as compact binary
// frames, see shared/codec.ts; everything else is JSON. Both decode to these same shapes.
//
// Snapshots, acks and input frames go over a WebRTC data channel when one is open (unordered, never
// resent: see server/rtc.ts), and over the WebSocket otherwise. So they can arrive out of order or
// not at all: receivers skip anything older than what they already have.

import type { FireMode } from './fire';

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
  /** lying down */
  pr: boolean;
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

/** one row of the scoreboard */
export interface RosterEntry {
  id: number;
  name: string;
  team: Team;
  /** eliminations this match */
  k: number;
  /** times eliminated this match */
  d: number;
  /** round-trip time in ms */
  ping: number;
  /** played by the server */
  bot: boolean;
  /** the field this player voted for (humans; only when the server lets players choose) */
  vote?: string;
  /** the firing mode this player voted for (humans; only when the server lets players choose) */
  modeVote?: FireMode;
}

/**
 * One fixed movement step (INPUT_DT seconds) of keys + aim, as sent by the browser:
 * [sequence number, forward -1..1, right -1..1, flags, yaw, pitch]. flags: 1 jump, 2 sprint, 4 crouch, 8 lie down.
 * The server runs shared/sim.ts stepMovement on each one, exactly as the browser did when it predicted it.
 */
export type InputFrame = [seq: number, forward: number, right: number, flags: number, yaw: number, pitch: number];
export const INPUT_JUMP = 1;
export const INPUT_SPRINT = 2;
export const INPUT_CROUCH = 4;
export const INPUT_PRONE = 8;

/** a player's full movement state: [x, y, z, vx, vy, vz, height, onGround (1/0)] */
export type BodyState = [number, number, number, number, number, number, number, number];

/** browser → server */
export type ClientMsg =
  | { t: 'hello'; name: string }
  | { t: 'input'; i: InputFrame[] }
  | { t: 'fire'; o: V3; d: V3 }
  | { t: 'pong'; s: number }
  /** vote for a field (an id from shared/maps.ts), or null for no preference */
  | { t: 'vote'; map: string | null }
  /** vote for a firing mode (shared/fire.ts), or null for no preference */
  | { t: 'mode'; mode: FireMode | null }
  /**
   * Data channel signalling (server/rtc.ts). Without sdp: "please open a data channel" (the server
   * replies with an offer if it has them on); with sdp: our answer to the server's offer.
   */
  | { t: 'rtc'; sdp?: string }
  /** one of our ICE candidates */
  | { t: 'ice'; c: string; mid: string }
  /** a token for the voice server (only if the welcome said voice is on) */
  | { t: 'voice' }
  /** out during a point: play on as bot `id`, a teammate still in (it goes out in your place) */
  | { t: 'takeover'; id: number };

/** server → browser */
export type ServerMsg =
  /**
   * map: the field being played (an id from shared/maps.ts); vote: players choose the field (false
   * when the server pins one); mode / modeVote: the firing mode (shared/fire.ts), and whether players
   * choose it; voice: this server has team voice chat (ask for a token with { t: 'voice' })
   */
  | { t: 'welcome'; id: number; team: Team; spawn: Spawn; round: RoundState; map: string; voice: boolean; vote: boolean; mode: FireMode; modeVote: boolean }
  /** the firing mode changed (between points) */
  | { t: 'mode'; mode: FireMode }
  /** the field changed (between matches); a respawn on the new field follows */
  | { t: 'map'; id: string }
  /** seq counts up by one per snapshot (to skip late ones); score is points won this match */
  | { t: 'snap'; seq: number; players: PlayerSnap[]; score: [number, number]; round: RoundState }
  | { t: 'ball'; owner: number; team: Team; o: V3; v: V3 }
  /**
   * tp: where the victim's hitbox was tested [x, y, z, height] (after lag compensation); bounced: the
   * ball had bounced off something first (a bunker, the ground, another player)
   */
  | { t: 'hit'; victim: number; shooter: number; team: Team; p: V3; tp: [number, number, number, number]; bounced?: boolean }
  /** a ball bounced off a player without breaking: they play on */
  | { t: 'bounce'; victim: number; shooter: number; p: V3 }
  | { t: 'respawn'; spawn: Spawn }
  /**
   * player `id` (out) stepped into teammate bot `bot`: they're in, where the bot was (body b, facing
   * yaw / pitch), and the bot is out where they were
   */
  | { t: 'takeover'; id: number; bot: number; b: BodyState; yaw: number; pitch: number }
  | { t: 'leave'; id: number }
  /** names and stats; sent when they change and every couple of seconds (for ping) */
  | { t: 'roster'; players: RosterEntry[] }
  /** latency probe: answer with { t: 'pong', s } */
  | { t: 'ping'; s: number }
  /** to one player, with every snapshot: where the server has you after your input `seq` */
  | { t: 'ack'; seq: number; b: BodyState }
  /** data channel offer, in reply to the browser's { t: 'rtc' } */
  | { t: 'rtc'; sdp: string }
  /** one of the server's ICE candidates */
  | { t: 'ice'; c: string; mid: string }
  /** voice server address and a short-lived token for it; identities are 'p' + player id */
  | { t: 'voice'; url: string; token: string };

export const DEFAULT_PORT = 8787;
export const NAME_MAX = 16;

/**
 * Make a player-chosen name safe to show: drop control/format/invisible characters, collapse
 * whitespace, cap the length. Returns '' if nothing printable is left. Both sides use it; the
 * server's result is the one that counts. Names are always rendered with textContent, never HTML.
 */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const s = raw
    .slice(0, 200)
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(s).slice(0, NAME_MAX).join('').trim();
}
export const TEAM_COLORS: readonly [number, number] = [0xff3b3b, 0x3b8bff];
export const TEAM_NAMES: readonly [string, string] = ['Red', 'Blue'];

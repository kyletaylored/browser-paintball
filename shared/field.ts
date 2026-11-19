// The field layout, shared by the client (to draw it) and the server (to collide paintballs with it).
// Coordinates are metres. x runs end to end (Red starts at -x, Blue at +x), z runs side to side, y is up.

import type { Spawn, Team } from './protocol';

export type BoxBunker = { kind: 'box'; x: number; z: number; w: number; d: number; h: number; color: number };
export type CanBunker = { kind: 'can'; x: number; z: number; r: number; h: number; color: number };
export type Bunker = BoxBunker | CanBunker;

export const FIELD_LENGTH = 46;
export const FIELD_WIDTH = 30;
export const HALF_L = FIELD_LENGTH / 2;
export const HALF_W = FIELD_WIDTH / 2;
/** distance from the field lines to the netting */
export const NET_MARGIN = 1.5;

const YELLOW = 0xffc93c;
const TEAL = 0x2ec4b6;
const WHITE = 0xeeeeee;
const LIME = 0x9be564;

const center: Bunker[] = [
  { kind: 'box', x: 0, z: 0, w: 2, d: 2, h: 2.2, color: YELLOW },
  { kind: 'can', x: 0, z: 8.5, r: 0.7, h: 1.7, color: TEAL },
  { kind: 'can', x: 0, z: -8.5, r: 0.7, h: 1.7, color: TEAL },
];

// One half of the field. The other half is the mirror image, so neither team has an advantage.
const redHalf: Bunker[] = [
  { kind: 'box', x: -19, z: 0, w: 1.2, d: 2.4, h: 1.5, color: WHITE }, // home bunker
  { kind: 'can', x: -15, z: 6, r: 0.6, h: 1.8, color: TEAL },
  { kind: 'can', x: -15, z: -6, r: 0.6, h: 1.8, color: TEAL },
  { kind: 'box', x: -12, z: 11, w: 3.2, d: 1.1, h: 1.0, color: LIME }, // low wall you can jump onto
  { kind: 'box', x: -12, z: -11, w: 3.2, d: 1.1, h: 1.0, color: LIME },
  { kind: 'box', x: -9, z: 0, w: 1.4, d: 1.4, h: 1.9, color: YELLOW },
  { kind: 'can', x: -6, z: 4, r: 0.5, h: 1.2, color: WHITE },
  { kind: 'can', x: -6, z: -4, r: 0.5, h: 1.2, color: WHITE },
  { kind: 'box', x: -4.5, z: 12, w: 2.6, d: 1.2, h: 1.5, color: YELLOW },
  { kind: 'box', x: -4.5, z: -12, w: 2.6, d: 1.2, h: 1.5, color: YELLOW },
];

export const BUNKERS: readonly Bunker[] = [...center, ...redHalf, ...redHalf.map((b) => ({ ...b, x: -b.x }))];

export function spawnPoint(team: Team, slot: number): Spawn {
  const x = team === 0 ? -HALF_L + 1.5 : HALF_L - 1.5;
  const z = ((slot % 6) - 2.5) * 2.2;
  return { x, y: 0, z, yaw: team === 0 ? -Math.PI / 2 : Math.PI / 2 };
}

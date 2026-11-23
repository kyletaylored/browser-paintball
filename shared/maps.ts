// Every field the game can be played on. Each is laid out for Red's half (-x) and mirrored for
// Blue's, so neither team has an advantage. Only numbers here: the server collides with them and the
// browser draws them (src/world.ts), so both see exactly the same field.
//
// Shapes are in shared/field.ts. Keep bunkers inside the field lines and off the start lines; the
// map checks (server/map-test.ts) make sure of that.

import type { Bunker, BoxBunker, CanBunker, LogBunker, Look, PolyBunker, ProfileBunker, TaperBunker } from './field';

export interface MapTheme {
  /** what the field is drawn on */
  ground: 'turf' | 'sand' | 'forest';
  /** around the field: grass, grass with stands, the sea along one side, or more forest */
  surround: 'grass' | 'stands' | 'sea' | 'forest';
  /** netting all round (speedball), or a low rope line (beach, woods) */
  boundary: 'net' | 'rope';
  sky: number;
  fog: [near: number, far: number];
  sun: { color: number; intensity: number };
  hemi: { sky: number; ground: number; intensity: number };
}

export interface GameMap {
  id: string;
  name: string;
  /** one line for the menu */
  blurb: string;
  /** field size inside the lines, metres: x end to end, z side to side */
  length: number;
  width: number;
  /** from the field lines to the boundary */
  margin: number;
  bunkers: readonly Bunker[];
  theme: MapTheme;
  /** practice targets, on Blue's half */
  targets: readonly [number, number][];
}

// ---- helpers --------------------------------------------------------------------------------

const box = (x: number, z: number, w: number, d: number, h: number, color: number, look?: Look): BoxBunker =>
  ({ kind: 'box', x, z, w, d, h, color, ...(look ? { look } : {}) });
const can = (x: number, z: number, r: number, h: number, color: number, look?: Look): CanBunker =>
  ({ kind: 'can', x, z, r, h, color, ...(look ? { look } : {}) });
const poly = (x: number, z: number, pts: [number, number][], h: number, color: number, look?: Look): PolyBunker =>
  ({ kind: 'poly', x, z, pts, h, color, ...(look ? { look } : {}) });
const log = (x: number, z: number, len: number, r: number, axis: 'x' | 'z', color: number, look: Look = 'log'): LogBunker =>
  ({ kind: 'log', x, z, len, r, axis, color, look });
const taper = (x: number, z: number, s: Shape, color: number): TaperBunker =>
  ({ kind: 'taper', x, z, pts: s.pts, h: s.h, top: s.top, ...(s.apex ? { apex: s.apex } : {}), color });
const profile = (x: number, z: number, axis: 'x' | 'z', w: Wall, color: number): ProfileBunker =>
  ({ kind: 'profile', x, z, axis, d: w.d, line: w.line, color });

/** Blue's copy of one of Red's bunkers: mirrored across the centre line */
function mirror(b: Bunker): Bunker {
  const flip = (pts: [number, number][]) => pts.map(([px, pz]) => [-px, pz] as [number, number]).reverse();
  if (b.kind === 'poly') return { ...b, x: -b.x, pts: flip(b.pts) };
  if (b.kind === 'taper') return { ...b, x: -b.x, pts: flip(b.pts), ...(b.apex ? { apex: [-b.apex[0], b.apex[1]] as [number, number] } : {}) };
  // a wall along x runs the other way; one along z is only moved (it's the same both sides of its middle)
  if (b.kind === 'profile' && b.axis === 'x') return { ...b, x: -b.x, line: b.line.map(([u, y]) => [-u, y] as [number, number]).reverse() };
  return { ...b, x: -b.x };
}
const layout = (centre: Bunker[], redHalf: Bunker[]): Bunker[] => [...centre, ...redHalf, ...redHalf.map(mirror)];

/** a small, fast random number generator with a fixed seed, so both sides generate the same woods */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// a triangle pointing +z (or -z), for the tournament field
const TRI_UP: [number, number][] = [[-0.95, -0.55], [0.95, -0.55], [0, 1.0]];
const TRI_DOWN: [number, number][] = TRI_UP.map(([x, z]) => [x, -z] as [number, number]).reverse();
// a square turned 45°
const diamond = (s: number): [number, number][] => [[0, -s], [s, 0], [0, s], [-s, 0]];
// an upturned boat's outline, long along x
const HULL: [number, number][] = [[-2.1, 0], [-1.5, -0.75], [1.5, -0.75], [2.2, 0], [1.5, 0.75], [-1.5, 0.75]];
// boulder outlines (convex), scaled per rock
const ROCKS: [number, number][][] = [
  [[-1, -0.6], [0.2, -0.95], [1, -0.35], [0.85, 0.6], [-0.3, 0.9], [-1, 0.3]],
  [[-0.9, -0.8], [0.7, -0.75], [1, 0.25], [0.2, 0.95], [-0.95, 0.45]],
  [[-0.7, -0.95], [0.9, -0.6], [0.95, 0.55], [-0.2, 1], [-1, 0.1]],
];
const scaled = (pts: [number, number][], sx: number, sz: number): [number, number][] => pts.map(([x, z]) => [x * sx, z * sz]);

// shapes that narrow toward the top (TaperBunker): the base, how tall, how much of the base is left at
// the top, and where they narrow to
type Shape = { pts: [number, number][]; h: number; top: number; apex?: [number, number] };
const square = (s: number): [number, number][] => [[-s, -s], [s, -s], [s, s], [-s, s]];
/** a three-sided pyramid, about 1.5 m tall, pointing +z (or -z) */
const DORITO: Shape = { pts: TRI_UP, h: 1.5, top: 0 };
const DORITO_DOWN: Shape = { pts: TRI_DOWN, h: 1.5, top: 0 };
/** a tall square tower narrowing to a small flat top */
const TEMPLE: Shape = { pts: square(0.85), h: 2.2, top: 0.35 };
/** tall, thin and nearly pointed */
const SPIKE: Shape = { pts: square(0.5), h: 2.1, top: 0.14 };
/** a pyramid on the centre line: a diamond that narrows to a small top */
const CENTRE_PYRAMID: Shape = { pts: diamond(1.6), h: 2.1, top: 0.3 };

// walls with a shaped top (ProfileBunker): how thick, and the top line along the wall
type Wall = { d: number; line: [number, number][] };
/** an M: tall at both ends and in the middle, with dips you can shoot over standing up */
const M_WALL: Wall = { d: 0.9, line: [[-1.5, 1.0], [-1.1, 1.65], [-0.55, 1.12], [0, 1.35], [0.55, 1.12], [1.1, 1.65], [1.5, 1.0]] };
/** a wall with a notch in the middle of its top, to shoot through */
const NOTCH_WALL: Wall = { d: 0.9, line: [[-1.1, 1.5], [-0.45, 1.5], [-0.3, 1.0], [0.3, 1.0], [0.45, 1.5], [1.1, 1.5]] };
/** a tall slab with a rounded top */
const TOMBSTONE: Wall = {
  d: 0.8,
  line: Array.from({ length: 9 }, (_, i) => {
    const a = Math.PI - (i / 8) * Math.PI;
    return [Math.round(Math.cos(a) * 0.65 * 1000) / 1000, Math.round((1.45 + Math.sin(a) * 0.45) * 1000) / 1000] as [number, number];
  }),
};

// ---- Arena: the original speedball field ----------------------------------------------------

const YELLOW = 0xffc93c;
const TEAL = 0x2ec4b6;
const WHITE = 0xeeeeee;
const LIME = 0x9be564;

const ARENA: GameMap = {
  id: 'arena',
  name: 'Arena',
  blurb: 'Compact speedball field. Fast points, lots of angles.',
  length: 46,
  width: 30,
  margin: 1.5,
  bunkers: layout(
    [
      box(0, 0, 2, 2, 2.2, YELLOW),
      can(0, 8.5, 0.7, 1.7, TEAL),
      can(0, -8.5, 0.7, 1.7, TEAL),
    ],
    [
      box(-19, 0, 1.2, 2.4, 1.5, WHITE), // home bunker
      can(-15, 6, 0.6, 1.8, TEAL),
      can(-15, -6, 0.6, 1.8, TEAL),
      box(-12, 11, 3.2, 1.1, 1.0, LIME), // low wall you can jump onto
      box(-12, -11, 3.2, 1.1, 1.0, LIME),
      box(-9, 0, 1.4, 1.4, 1.9, YELLOW),
      can(-6, 4, 0.5, 1.2, WHITE),
      can(-6, -4, 0.5, 1.2, WHITE),
      box(-4.5, 12, 2.6, 1.2, 1.5, YELLOW),
      box(-4.5, -12, 2.6, 1.2, 1.5, YELLOW),
    ],
  ),
  theme: {
    ground: 'turf', surround: 'grass', boundary: 'net', sky: 0x8cc2f2, fog: [70, 190],
    sun: { color: 0xfff2dd, intensity: 2.6 }, hemi: { sky: 0xcfe4ff, ground: 0x56703f, intensity: 1.1 },
  },
  targets: [[7.5, 2.5], [13.8, -6], [11, 8]],
};

// ---- Tournament: a bigger, symmetrical inflatable layout ------------------------------------

const RED_I = 0xe8434b;
const NAVY = 0x2b3a67;
const ORANGE = 0xff8c32;
const SKY = 0x58b4e8;
const SILVER = 0xd7dde4;

const TOURNAMENT: GameMap = {
  id: 'tournament',
  name: 'Tournament',
  blurb: 'Big symmetrical inflatable field: snake side, dorito side, a pyramid in the middle.',
  length: 54,
  width: 36,
  margin: 2,
  bunkers: layout(
    [
      taper(0, 0, CENTRE_PYRAMID, SILVER),
      can(0, 14, 0.75, 1.6, ORANGE),
      taper(0, -13.5, DORITO, NAVY),
    ],
    [
      // snake side (+z): a long low wall in three kinked segments, crouch to hide
      box(-14, 13.2, 4.4, 1.1, 1.2, SKY),
      box(-9.8, 14, 4.4, 1.1, 1.2, SKY),
      box(-5.6, 13.2, 4.4, 1.1, 1.2, SKY),
      // dorito side (-z): pyramids, so paint slides over their shoulders
      taper(-19, -12.5, DORITO, NAVY),
      taper(-12.5, -14, DORITO, NAVY),
      taper(-6, -12, DORITO_DOWN, NAVY),
      // back: tombstones and the home can
      profile(-23, 6, 'z', TOMBSTONE, RED_I),
      profile(-23, -6, 'z', TOMBSTONE, RED_I),
      can(-21, 0, 0.8, 1.9, ORANGE),
      // middle: cakes, a temple and mini cans
      box(-16, 4, 1.9, 1.9, 1.25, SILVER),
      box(-16, -5, 1.9, 1.9, 1.25, SILVER),
      taper(-11, 0, TEMPLE, RED_I),
      can(-7.5, 6.5, 0.55, 1.45, ORANGE),
      can(-7.5, -6, 0.55, 1.45, ORANGE),
      // near the centre: an M wall (shoot over its dips) and a notched wall (shoot through it)
      profile(-4, 2.8, 'z', M_WALL, NAVY),
      profile(-4, -3, 'z', NOTCH_WALL, NAVY),
      taper(-18, 10, SPIKE, RED_I),
    ],
  ),
  theme: {
    ground: 'turf', surround: 'stands', boundary: 'net', sky: 0x86bdf0, fog: [80, 220],
    sun: { color: 0xfff4e2, intensity: 2.7 }, hemi: { sky: 0xd0e6ff, ground: 0x4f6a3a, intensity: 1.1 },
  },
  targets: [[9, 3], [14, -7], [17, 9]],
};

// ---- Beach: sand, sea along one side, driftwood and huts ------------------------------------

const DRIFT = 0x9b8467;
const SAND = 0xe3cf9c;
const CORAL = 0xff7a6b;
const AQUA = 0x4cc9c0;
const BUTTER = 0xf7d65c;
const HULL_C = 0x2f5d8a;

const BEACH: GameMap = {
  id: 'beach',
  name: 'Beach',
  blurb: 'Sand, surf and driftwood. Huts, dunes and an upturned boat.',
  length: 52,
  width: 32,
  margin: 2.5,
  bunkers: layout(
    [
      box(0, 0, 3.2, 2.4, 2.5, BUTTER, 'hut'), // snack shack
      log(0, 11.5, 3.6, 0.45, 'x', DRIFT),
      log(0, -11, 3.2, 0.42, 'x', DRIFT),
    ],
    [
      box(-22, 0, 2.2, 2.2, 2.7, WHITE, 'tower'), // lifeguard tower
      box(-17, 9, 2.6, 2, 2.3, CORAL, 'hut'),
      box(-13, -9.5, 2.6, 2, 2.3, AQUA, 'hut'),
      log(-18.5, -4.5, 4.2, 0.42, 'x', DRIFT),
      log(-8.5, 3.5, 3.8, 0.45, 'z', DRIFT),
      log(-5, -12.5, 4.6, 0.4, 'x', DRIFT),
      can(-11.5, 1.5, 1.9, 1.2, SAND, 'dune'),
      can(-20, 11.5, 1.6, 1.15, SAND, 'dune'),
      poly(-6, 9, HULL, 1.05, HULL_C, 'boat'),
      box(-3, -5, 3.2, 0.8, 1.2, 0xc9b37f, 'sandbag'),
      can(-15, -2, 0.35, 1, 0x3c6e91, 'barrel'),
      can(-14.3, -1.5, 0.35, 1, 0xb5483a, 'barrel'),
    ],
  ),
  theme: {
    ground: 'sand', surround: 'sea', boundary: 'rope', sky: 0x9fd6f7, fog: [90, 260],
    sun: { color: 0xfff1d6, intensity: 3.0 }, hemi: { sky: 0xd8efff, ground: 0xc9b98a, intensity: 1.25 },
  },
  targets: [[8, 3], [12.5, -7], [15, 8]],
};

// ---- Woods: a big forest field ------------------------------------------------------------

const BARK = 0x5a4632;
const MOSS_ROCK = 0x7d8279;
const PALLET = 0xa77b4f;
const SPOOL = 0x8a6440;

function woods(): Bunker[] {
  const L = 90;
  const W = 60;
  const r = rng(20261121);
  const red: Bunker[] = [
    // a few hand-placed pieces so each half has clear cover lanes
    box(-40, 6, 1.2, 1, 1.4, PALLET, 'wood'),
    box(-40, -6, 1.2, 1, 1.4, PALLET, 'wood'),
    can(-33, 0, 0.8, 1.2, SPOOL, 'spool'),
    log(-28, 14, 6, 0.45, 'x', BARK),
    log(-24, -15, 6.5, 0.5, 'x', BARK),
    log(-12, 4, 5, 0.45, 'z', BARK),
    box(-18, 22, 1.2, 1, 1.4, PALLET, 'wood'),
    box(-18, -22, 1.2, 1, 1.4, PALLET, 'wood'),
    can(-9, -18, 0.8, 1.2, SPOOL, 'spool'),
    poly(-20, 2, scaled(ROCKS[0], 1.6, 1.3), 1.7, MOSS_ROCK, 'rock'),
    poly(-34, -18, scaled(ROCKS[1], 1.4, 1.2), 1.5, MOSS_ROCK, 'rock'),
    poly(-6, 22, scaled(ROCKS[2], 1.5, 1.4), 1.6, MOSS_ROCK, 'rock'),
  ];
  // trees: scattered over Red's half, kept off the start line, the centre line and each other
  const clear = (x: number, z: number, gap: number) =>
    red.every((b) => Math.hypot(b.x - x, b.z - z) > gap + (b.kind === 'log' ? b.len / 2 : 1.6));
  for (let tries = 0; red.length < 12 + 46 && tries < 3000; tries++) {
    const x = -L / 2 + 6 + r() * (L / 2 - 8.5);
    const z = -W / 2 + 2 + r() * (W - 4);
    if (x < -L / 2 + 8 && Math.abs(z) < 9) continue; // the start area
    if (!clear(x, z, 2.6)) continue;
    const trunk = 0.22 + r() * 0.24;
    red.push(can(Math.round(x * 10) / 10, Math.round(z * 10) / 10, Math.round(trunk * 100) / 100, 9, BARK, 'tree'));
  }
  return layout(
    [
      // centre outcrop: on the centre line, so its outline has to be symmetric too
      poly(0, 0, scaled([[-1, -0.55], [-0.35, -1], [0.35, -1], [1, -0.55], [1, 0.5], [0.4, 1], [-0.4, 1], [-1, 0.5]], 2.6, 2), 2, MOSS_ROCK, 'rock'),
      log(0, 18, 5, 0.5, 'x', BARK),
      log(0, -18, 5, 0.5, 'x', BARK),
      can(0, 9, 0.4, 9, BARK, 'tree'),
      can(0, -9, 0.35, 9, BARK, 'tree'),
    ],
    red,
  );
}

const WOODS: GameMap = {
  id: 'woods',
  name: 'Woods',
  blurb: 'A big forest field: trees, boulders and fallen logs. Slow, sneaky points.',
  length: 90,
  width: 60,
  margin: 3,
  bunkers: woods(),
  theme: {
    ground: 'forest', surround: 'forest', boundary: 'rope', sky: 0xa9c4c9, fog: [25, 120],
    sun: { color: 0xffe6c2, intensity: 2.1 }, hemi: { sky: 0xb9d3c2, ground: 0x3b4a2a, intensity: 1.0 },
  },
  targets: [[12, 4], [20, -8], [26, 10]],
};

// ---- the list -------------------------------------------------------------------------------

/** in rotation order */
export const MAP_LIST: readonly GameMap[] = [ARENA, TOURNAMENT, BEACH, WOODS];
export const MAPS: Readonly<Record<string, GameMap>> = Object.fromEntries(MAP_LIST.map((m) => [m.id, m]));
export const DEFAULT_MAP = 'arena';

/** the map after `id` in the rotation */
export function nextMap(id: string): string {
  const i = MAP_LIST.findIndex((m) => m.id === id);
  return MAP_LIST[(i + 1) % MAP_LIST.length].id;
}

// ---- choosing the field online ----------------------------------------------------------------
// Each human on the server can vote for a field (or not vote). The server and the menus use the same
// two rules, so what the menu says will happen is what happens.

/** every human wants the same other field: switch to it at the next break */
export function unanimousVote(votes: readonly (string | null)[], current: string): string | null {
  if (!votes.length) return null;
  const first = votes[0];
  if (!first || !MAPS[first] || first === current) return null;
  return votes.every((v) => v === first) ? first : null;
}

/**
 * The field for the next match: the one with the most votes, ties going to whichever comes first
 * in the rotation after the current field; the next in the rotation if nobody voted.
 */
export function voteWinner(votes: readonly (string | null)[], current: string): string {
  const count = new Map<string, number>();
  for (const v of votes) if (v && MAPS[v]) count.set(v, (count.get(v) ?? 0) + 1);
  if (!count.size) return nextMap(current);
  const start = MAP_LIST.findIndex((m) => m.id === current);
  let best = '';
  let bestN = 0;
  for (let k = 1; k <= MAP_LIST.length; k++) {
    const id = MAP_LIST[(start + k) % MAP_LIST.length].id;
    const n = count.get(id) ?? 0;
    if (n > bestN) {
      best = id;
      bestN = n;
    }
  }
  return best;
}

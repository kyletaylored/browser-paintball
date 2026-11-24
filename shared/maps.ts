// Every field the game can be played on. Each is laid out for Red's half (-x) and mirrored for
// Blue's, so neither team has an advantage. Only numbers here: the server collides with them and the
// browser draws them (src/world.ts), so both see exactly the same field.
//
// Shapes are in shared/field.ts. Keep bunkers inside the field lines and off the start lines; the
// map checks (server/map-test.ts) make sure of that.

import type { ObjectiveKind } from './objective';
import type { Bunker, BoxBunker, CanBunker, LogBunker, Look, OrbBunker, PolyBunker, ProfileBunker, TaperBunker } from './field';

/**
 * Bright paint fills, the colours real paint comes in (and the accents on the player art). Each field
 * gives each team one of these, never the team's own colour, so splats read as paint, not as markers.
 * Look only: who shot a ball is in the ball itself.
 */
export const PAINT = {
  yellow: 0xffe01a,
  lime: 0x8cff2e,
  pink: 0xff3fa8,
  orange: 0xff8a1f,
  cyan: 0x2ee6ff,
  purple: 0xb45cff,
} as const;

export interface MapTheme {
  /** what the field is drawn on (the holiday ones: dead grass, snow, autumn grass, paving) */
  ground: 'turf' | 'sand' | 'forest' | 'moon' | 'patch' | 'snow' | 'farm' | 'stone';
  /**
   * around the field: grass, grass with stands, the sea along one side, more forest, or the moon under
   * a starry sky; and the holiday ones (src/holidays.ts): a graveyard at night, a snowy village, a
   * farm, a park under fireworks, and a lantern festival
   */
  surround: 'grass' | 'stands' | 'sea' | 'forest' | 'space' | 'graveyard' | 'winter' | 'farm' | 'fireworks' | 'festival';
  /**
   * netting all round (speedball), a low rope line (beach, woods), a glowing line on posts (space); or
   * an iron fence, candy-striped posts, a rail fence, or a rope hung with lanterns
   */
  boundary: 'net' | 'rope' | 'glow' | 'iron' | 'candy' | 'fence' | 'lanterns';
  sky: number;
  fog: [near: number, far: number];
  /** each team's paint (Red's, Blue's): two different PAINT colours */
  paint: [red: number, blue: number];
  sun: { color: number; intensity: number };
  hemi: { sky: number; ground: number; intensity: number };
  /** how shots are drawn: paintballs, or little moons with comet tails (look only: they fly the same) */
  shots?: 'paint' | 'moon';
  /** what players wear: the jersey, or a space suit and helmet */
  outfit?: 'jersey' | 'astronaut';
  /** an elimination pops a burst where it happened: stars, bats, snowflakes, leaves, fireworks or firecrackers */
  outFx?: OutFx;
}

export type OutFx = 'stars' | 'bats' | 'snowflakes' | 'leaves' | 'fireworks' | 'firecrackers';

export interface GameMap {
  id: string;
  name: string;
  /** one line for the menu */
  blurb: string;
  /** what wins a point (shared/objective.ts): a buzzer, unless it says otherwise */
  objective?: ObjectiveKind;
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
/** a planet: resting on the ground, or sunk into it (centre y above the ground) */
const orb = (x: number, z: number, r: number, color: number, look: Look, y?: number): OrbBunker =>
  ({ kind: 'orb', x, z, r, color, look, ...(y !== undefined ? { y } : {}) });
const taper = (x: number, z: number, s: Shape, color: number, look?: Look): TaperBunker =>
  ({ kind: 'taper', x, z, pts: s.pts, h: s.h, top: s.top, ...(s.apex ? { apex: s.apex } : {}), color, ...(look ? { look } : {}) });
const profile = (x: number, z: number, axis: 'x' | 'z', w: Wall, color: number, look?: Look): ProfileBunker =>
  ({ kind: 'profile', x, z, axis, d: w.d, line: w.line, color, ...(look ? { look } : {}) });
/** a regular polygon round the middle, a flat side to each axis: a near-round base for cones */
const ngon = (r: number, n = 8): [number, number][] =>
  Array.from({ length: n }, (_, i) => {
    const a = ((i + 0.5) / n) * Math.PI * 2;
    return [Math.round(Math.cos(a) * r * 1000) / 1000, Math.round(Math.sin(a) * r * 1000) / 1000] as [number, number];
  });
/**
 * A sand dune: a round mound r across the base and h tall, its top 0.72 as wide. A taper (24 sides),
 * so paint hits the slope where it's drawn (src/world.ts draws it on the same corners).
 */
const dune = (x: number, z: number, r: number, h: number, color: number): TaperBunker =>
  ({ kind: 'taper', x, z, pts: ngon(r, 24), h, top: 0.72, color, look: 'dune' });

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
    ground: 'turf', surround: 'grass', boundary: 'net', sky: 0x8cc2f2, fog: [70, 190], paint: [PAINT.yellow, PAINT.pink],
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
    ground: 'turf', surround: 'stands', boundary: 'net', sky: 0x86bdf0, fog: [80, 220], paint: [PAINT.lime, PAINT.orange],
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
      dune(-11.5, 1.5, 1.9, 1.2, SAND),
      dune(-20, 11.5, 1.6, 1.15, SAND),
      poly(-6, 9, HULL, 1.05, HULL_C, 'boat'),
      box(-3, -5, 3.2, 0.8, 1.2, 0xc9b37f, 'sandbag'),
      can(-15, -2, 0.35, 1, 0x3c6e91, 'barrel'),
      can(-14.3, -1.5, 0.35, 1, 0xb5483a, 'barrel'),
    ],
  ),
  theme: {
    ground: 'sand', surround: 'sea', boundary: 'rope', sky: 0x9fd6f7, fog: [90, 260], paint: [PAINT.cyan, PAINT.pink],
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
  blurb: 'A big forest field: trees, boulders and fallen logs. Capture the flag.',
  objective: 'flag',
  length: 90,
  width: 60,
  margin: 3,
  bunkers: woods(),
  theme: {
    ground: 'forest', surround: 'forest', boundary: 'rope', sky: 0xa9c4c9, fog: [25, 120], paint: [PAINT.yellow, PAINT.pink],
    sun: { color: 0xffe6c2, intensity: 2.1 }, hemi: { sky: 0xb9d3c2, ground: 0x3b4a2a, intensity: 1.0 },
  },
  targets: [[12, 4], [20, -8], [26, 10]],
};

// ---- the moon ---------------------------------------------------------------------------------

const MOON_GREY = 0xc9c6bd;
const SATURN_GOLD = 0xe3b25a;
const DEEP_BLUE = 0x4f86d9;
const NEBULA_PURPLE = 0x9b6ad8;
const MINT = 0x67d6a4;
const EMBER = 0xe0713f;
const CRATER_TEAL = 0x7fb8b6;

const SPACE: GameMap = {
  id: 'space',
  name: 'Moonbase',
  blurb: 'A field on the moon: planets for bunkers, moonballs with comet tails and a star for every out.',
  length: 48,
  width: 30,
  margin: 2,
  bunkers: layout(
    [
      orb(0, 0, 1.3, NEBULA_PURPLE, 'ringed'), // the big one in the middle
      orb(0, 9, 0.65, MOON_GREY, 'moon'),
      orb(0, -9, 0.65, MOON_GREY, 'moon'),
    ],
    [
      orb(-19, 0, 1.0, EMBER, 'planet'), // home planet
      orb(-15, 6, 0.7, MOON_GREY, 'moon'),
      orb(-15, -6, 0.7, MOON_GREY, 'moon'),
      orb(-12, 11, 1.4, CRATER_TEAL, 'moon', 0.3), // half-sunk domes: low cover you slide off
      orb(-12, -11, 1.4, CRATER_TEAL, 'moon', 0.3),
      orb(-9, 0, 1.1, DEEP_BLUE, 'planet'),
      orb(-6, 4.5, 0.5, MOON_GREY, 'moon'), // small moons: crouch behind them
      orb(-6, -4.5, 0.5, MOON_GREY, 'moon'),
      orb(-4.5, 11.5, 0.95, MINT, 'ringed'),
      orb(-4.5, -11.5, 0.95, SATURN_GOLD, 'ringed'),
    ],
  ),
  theme: {
    ground: 'moon', surround: 'space', boundary: 'glow', sky: 0x04050c, fog: [90, 420], paint: [PAINT.lime, PAINT.purple],
    sun: { color: 0xffffff, intensity: 3.1 }, hemi: { sky: 0x8a97c8, ground: 0x34343c, intensity: 0.75 },
    shots: 'moon', outfit: 'astronaut', outFx: 'stars',
  },
  targets: [[7.5, 2.5], [13, -3], [11, 7.5]],
};

// ---- holiday fields (drawn by src/holidays.ts) ----------------------------------------------------

/** a cone (eight sides) r across the base, h tall, with `top` of it left at the top */
const cone = (r: number, h: number, top = 0): Shape => ({ pts: ngon(r), h, top });

// Halloween
const PUMPKIN = 0xf07a1a;
const GRAVESTONE = 0x8d8a93;
const COFFIN_WOOD = 0x4a2f2a;
const WITCH = 0x2a2233;
const DEAD_BARK = 0x4b3e36;

const HALLOWEEN: GameMap = {
  id: 'halloween',
  name: 'Pumpkin Patch',
  blurb: 'Halloween night in a haunted patch: pumpkins, gravestones, coffins and a witch hat, under a full moon.',
  length: 46,
  width: 30,
  margin: 2,
  bunkers: layout(
    [
      orb(0, 0, 1.25, PUMPKIN, 'jacko'), // the giant pumpkin
      profile(0, 9, 'z', TOMBSTONE, GRAVESTONE, 'grave'),
      profile(0, -9, 'z', TOMBSTONE, GRAVESTONE, 'grave'),
    ],
    [
      box(-19, 0, 1.0, 2.4, 1.3, COFFIN_WOOD, 'coffin'), // home: a coffin stood on its side
      orb(-15, 6, 0.75, PUMPKIN, 'jacko'),
      orb(-15, -6, 0.75, PUMPKIN, 'jacko'),
      profile(-12.5, 10, 'z', TOMBSTONE, GRAVESTONE, 'grave'),
      profile(-12.5, -10, 'z', TOMBSTONE, GRAVESTONE, 'grave'),
      profile(-10.5, 12.5, 'z', TOMBSTONE, GRAVESTONE, 'grave'),
      profile(-10.5, -12.5, 'z', TOMBSTONE, GRAVESTONE, 'grave'),
      taper(-9, 0, cone(0.95, 2.3), WITCH, 'witchhat'),
      orb(-6, 4.5, 0.5, PUMPKIN, 'jacko'), // little pumpkins: crouch behind them
      orb(-6, -4.5, 0.5, PUMPKIN, 'jacko'),
      box(-4.5, 11.5, 2.4, 0.9, 0.75, COFFIN_WOOD, 'coffin'), // coffins lying down: low cover
      box(-4.5, -11.5, 2.4, 0.9, 0.75, COFFIN_WOOD, 'coffin'),
      can(-17, 12.5, 0.3, 7, DEAD_BARK, 'deadtree'),
      can(-17, -12.5, 0.3, 7, DEAD_BARK, 'deadtree'),
    ],
  ),
  theme: {
    ground: 'patch', surround: 'graveyard', boundary: 'iron', sky: 0x1d1436, fog: [35, 140], paint: [PAINT.lime, PAINT.pink],
    sun: { color: 0xc4ccff, intensity: 1.9 }, hemi: { sky: 0x7a68b0, ground: 0x2e2420, intensity: 1.15 },
    outFx: 'bats',
  },
  targets: [[7.5, 2.5], [13.5, -6.5], [11, 8]],
};

// Christmas
const ORNAMENT_RED = 0xd8263a;
const ORNAMENT_GOLD = 0xf2c14e;
const PINE = 0x2f7a46;
const SNOW_WHITE = 0xf2f6fb;
const PRESENT_GREEN = 0x3fa45b;
const PRESENT_GOLD = 0xe8b839;
const PRESENT_PURPLE = 0x8b5cc8;
const PRESENT_TEAL = 0x2aa8a8;

const CHRISTMAS: GameMap = {
  id: 'christmas',
  name: 'Snowfall',
  blurb: 'A snowy Christmas village: presents, trees, snow forts and giant ornaments, with snow coming down.',
  length: 48,
  width: 30,
  margin: 2,
  bunkers: layout(
    [
      orb(0, 0, 1.2, ORNAMENT_RED, 'ornament'),
      taper(0, 9.5, cone(0.8, 2.4), PINE, 'xtree'),
      taper(0, -9.5, cone(0.8, 2.4), PINE, 'xtree'),
    ],
    [
      box(-20, 0, 1.4, 2.2, 1.5, PRESENT_GREEN, 'present'), // home
      taper(-15.5, 6, cone(0.95, 2.7), PINE, 'xtree'),
      taper(-15.5, -6, cone(0.95, 2.7), PINE, 'xtree'),
      box(-15, 0, 1.0, 2.6, 1.0, SNOW_WHITE, 'snowwall'),
      box(-12, 11, 3.2, 1.0, 1.1, SNOW_WHITE, 'snowwall'), // snow forts: low walls
      box(-12, -11, 3.2, 1.0, 1.1, SNOW_WHITE, 'snowwall'),
      box(-9, 0, 1.6, 1.6, 1.8, PRESENT_GOLD, 'present'),
      box(-6, 4.2, 1.0, 1.0, 0.9, PRESENT_PURPLE, 'present'),
      box(-6, -4.2, 1.0, 1.0, 0.9, PRESENT_TEAL, 'present'),
      orb(-4.5, 11.5, 0.8, ORNAMENT_GOLD, 'ornament'),
      orb(-4.5, -11.5, 0.8, ORNAMENT_GOLD, 'ornament'),
    ],
  ),
  theme: {
    ground: 'snow', surround: 'winter', boundary: 'candy', sky: 0xbcd0e4, fog: [45, 170], paint: [PAINT.lime, PAINT.purple],
    sun: { color: 0xffffff, intensity: 2.2 }, hemi: { sky: 0xeaf3ff, ground: 0xb9c8dc, intensity: 1.2 },
    outFx: 'snowflakes',
  },
  targets: [[8, 3], [13.5, -6.5], [11.5, 8.5]],
};

// Thanksgiving
const HAY = 0xd9b45a;
const CORN = 0xc9a764;
const WAGON_RED = 0xb3402e;

const THANKSGIVING: GameMap = {
  id: 'harvest',
  name: 'Harvest Farm',
  blurb: 'A Thanksgiving farm in autumn: hay bales, pumpkins, corn shocks and a wagon, with a red barn behind.',
  length: 50,
  width: 32,
  margin: 2.5,
  bunkers: layout(
    [
      log(0, 0, 1.6, 0.85, 'z', HAY, 'haybale'), // a big round bale on its side
      orb(0, 9.5, 0.8, PUMPKIN, 'pumpkin'),
      orb(0, -9.5, 0.8, PUMPKIN, 'pumpkin'),
    ],
    [
      box(-21, 0, 1.2, 2.6, 1.4, HAY, 'hay'), // home: stacked square bales
      taper(-16.5, 6.5, cone(0.85, 2.3, 0.12), CORN, 'cornshock'),
      taper(-16.5, -6.5, cone(0.85, 2.3, 0.12), CORN, 'cornshock'),
      log(-13, 11.5, 2.4, 0.7, 'x', HAY, 'haybale'),
      log(-13, -11.5, 2.4, 0.7, 'x', HAY, 'haybale'),
      taper(-11, 5.5, cone(0.7, 2.0, 0.12), CORN, 'cornshock'),
      taper(-11, -5.5, cone(0.7, 2.0, 0.12), CORN, 'cornshock'),
      box(-9.5, 0, 1.4, 2.6, 1.3, WAGON_RED, 'wagon'),
      orb(-6.5, 4.5, 0.55, PUMPKIN, 'pumpkin'),
      orb(-6.5, -4.5, 0.55, PUMPKIN, 'pumpkin'),
      box(-5, 12.5, 2.8, 1.1, 1.1, HAY, 'hay'),
      box(-5, -12.5, 2.8, 1.1, 1.1, HAY, 'hay'),
    ],
  ),
  theme: {
    ground: 'farm', surround: 'farm', boundary: 'fence', sky: 0xf3cf9e, fog: [70, 230], paint: [PAINT.cyan, PAINT.pink],
    sun: { color: 0xffcf96, intensity: 2.7 }, hemi: { sky: 0xffe4c0, ground: 0x7a5a2a, intensity: 1.15 },
    outFx: 'leaves',
  },
  targets: [[8, 3], [14, -7], [12, 9]],
};

// Fourth of July
const FLAG_RED = 0xd23a3a;
const FLAG_NAVY = 0x23356f;
const FLAG_WHITE = 0xf1f1ef;

const FOURTH: GameMap = {
  id: 'fourth',
  name: 'Fireworks Park',
  blurb: 'The Fourth of July in the park after dark: rockets, firecrackers and fireworks going off overhead.',
  length: 46,
  width: 30,
  margin: 2,
  bunkers: layout(
    [
      taper(0, 0, cone(0.95, 2.8, 0.15), FLAG_WHITE, 'rocket'),
      can(0, 8.5, 0.65, 1.5, FLAG_NAVY, 'drum'),
      can(0, -8.5, 0.65, 1.5, FLAG_NAVY, 'drum'),
    ],
    [
      box(-19, 0, 1.2, 2.4, 1.5, FLAG_NAVY, 'starbox'), // home
      can(-15, 6, 0.6, 1.8, FLAG_RED, 'firecracker'),
      can(-15, -6, 0.6, 1.8, FLAG_RED, 'firecracker'),
      box(-12, 11, 3.2, 1.1, 1.0, FLAG_WHITE, 'stripes'),
      box(-12, -11, 3.2, 1.1, 1.0, FLAG_WHITE, 'stripes'),
      box(-9, 0, 1.5, 1.5, 1.9, FLAG_NAVY, 'starbox'),
      can(-6, 4, 0.5, 1.2, FLAG_WHITE, 'firecracker'),
      can(-6, -4, 0.5, 1.2, FLAG_WHITE, 'firecracker'),
      taper(-4.5, 12, cone(0.6, 2.2, 0.15), FLAG_RED, 'rocket'),
      taper(-4.5, -12, cone(0.6, 2.2, 0.15), FLAG_RED, 'rocket'),
    ],
  ),
  theme: {
    ground: 'turf', surround: 'fireworks', boundary: 'net', sky: 0x161d42, fog: [60, 260], paint: [PAINT.yellow, PAINT.lime],
    sun: { color: 0xc8d2ff, intensity: 1.5 }, hemi: { sky: 0x6a78c0, ground: 0x24301e, intensity: 1.0 },
    outFx: 'fireworks',
  },
  targets: [[7.5, 2.5], [13.8, -6], [11, 8]],
};

// Chinese New Year
const LANTERN_RED = 0xd8282e;
const LANTERN_GOLD = 0xf0b43a;
const DRUM_RED = 0xb52025;
const DRAGON_GREEN = 0x2f9a5a;
const TEMPLE_RED = 0xc23028;
/** a red wall with a roof that turns up at both ends */
const PAGODA_WALL: Wall = { d: 1.0, line: [[-1.25, 1.85], [-1.0, 1.55], [-0.5, 1.45], [0.5, 1.45], [1.0, 1.55], [1.25, 1.85]] };

const LUNAR: GameMap = {
  id: 'lunar',
  name: 'Lantern Square',
  blurb: 'Chinese New Year at night: giant lanterns, drums, a dragon and firecrackers in a temple square.',
  length: 48,
  width: 30,
  margin: 2,
  bunkers: layout(
    [
      can(0, 0, 1.0, 2.3, LANTERN_RED, 'lantern'), // the giant lantern
      log(0, 10, 4.2, 0.5, 'x', DRAGON_GREEN, 'dragon'),
      log(0, -10, 4.2, 0.5, 'x', DRAGON_GREEN, 'dragon'),
    ],
    [
      profile(-20, 0, 'z', PAGODA_WALL, TEMPLE_RED, 'pagoda'), // home
      can(-15.5, 6, 0.65, 1.8, LANTERN_RED, 'lantern'),
      can(-15.5, -6, 0.65, 1.8, LANTERN_RED, 'lantern'),
      can(-12, 11, 1.0, 1.15, DRUM_RED, 'drum'),
      can(-12, -11, 1.0, 1.15, DRUM_RED, 'drum'),
      log(-9, 0, 4.4, 0.5, 'z', DRAGON_GREEN, 'dragon'),
      can(-6, 4.2, 0.45, 1.3, LANTERN_RED, 'firecracker'),
      can(-6, -4.2, 0.45, 1.3, LANTERN_RED, 'firecracker'),
      can(-4.5, 12, 0.6, 1.5, LANTERN_GOLD, 'lantern'),
      can(-4.5, -12, 0.6, 1.5, LANTERN_GOLD, 'lantern'),
    ],
  ),
  theme: {
    ground: 'stone', surround: 'festival', boundary: 'lanterns', sky: 0x2a1022, fog: [50, 210], paint: [PAINT.cyan, PAINT.lime],
    sun: { color: 0xffdcb4, intensity: 2.0 }, hemi: { sky: 0xb06a78, ground: 0x3a2222, intensity: 1.2 },
    outFx: 'firecrackers',
  },
  targets: [[8, 3], [13.5, -6.5], [11.5, 8.5]],
};

// ---- the list -------------------------------------------------------------------------------

/** in rotation order */
export const MAP_LIST: readonly GameMap[] = [ARENA, TOURNAMENT, BEACH, WOODS, SPACE, HALLOWEEN, CHRISTMAS, THANKSGIVING, FOURTH, LUNAR];
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

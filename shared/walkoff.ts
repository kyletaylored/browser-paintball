// Eliminated players walk off the field, marker up, like real players do: to the nearer side line by
// the shortest way round the bunkers, then they wait just past the line. Nobody steers an out player.
// The browser (predicting you) and the server (moving you, and bots) run this same code on the same
// body, so prediction keeps matching.
//
// The way off comes from a distance map, worked out once per field: the field is cut into small
// squares, squares a player can't stand in (bunkers, with room for the player) are blocked, and each
// other square holds how far it is from the waiting area past the side lines. From wherever you are,
// you head for the nearby square that's closest to the line. There's no state to carry, so every
// step only needs the body.

import { field, footprintDistance } from './field';
import { PLAYER_RADIUS, type Body, type MoveInput } from './sim';
import { quantizeInput } from './codec';

/** walking pace (share of WALK_SPEED): not a sprint, nobody's shooting at you any more */
export const WALK_OFF_PACE = 0.6;
/** where out players wait: past the side line by this share of the space between the line and the boundary */
const PAST_LINE = 0.5;
/** the size of a square in the distance map, metres */
const CELL = 0.5;
/** room kept from a bunker's edge to a square's middle */
const ROOM = PLAYER_RADIUS + 0.1;
/** how far round you (in squares) to look for the next square to head for */
const REACH = 2;

interface Flow {
  map: string;
  /** squares across (x) and down (z), and where square (0, 0)'s middle is */
  nx: number;
  nz: number;
  x0: number;
  z0: number;
  /** distance to the waiting area in squares (Infinity: blocked or no way out) */
  dist: Float64Array;
}

let flow: Flow | null = null;

/** how far past the side line out players stop */
export const waitLine = (): number => field.halfW + field.margin * PAST_LINE;

/** off the field: past a side line or an end line */
export const offField = (x: number, z: number): boolean => Math.abs(z) > field.halfW || Math.abs(x) > field.halfL;

/** the distance map for the field being played (worked out the first time it's needed) */
export function walkOffMap(): Flow {
  if (flow && flow.map === field.map.id) return flow;
  const lx = field.halfL + field.margin - PLAYER_RADIUS;
  const lz = field.halfW + field.margin - PLAYER_RADIUS;
  const nx = Math.floor((2 * lx) / CELL) + 1;
  const nz = Math.floor((2 * lz) / CELL) + 1;
  const x0 = -((nx - 1) * CELL) / 2;
  const z0 = -((nz - 1) * CELL) / 2;
  const n = nx * nz;
  const dist = new Float64Array(n).fill(Infinity);
  const open = new Uint8Array(n);
  const wait = waitLine();
  const heap = new Heap();
  const bs = field.bunkers;
  for (let k = 0; k < nz; k++) {
    const z = z0 + k * CELL;
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * CELL;
      let free = true;
      for (let j = 0; j < bs.length && free; j++) {
        const bd = field.bounds[j];
        if (Math.abs(x - bd.x) > bd.r + ROOM || Math.abs(z - bd.z) > bd.r + ROOM) continue;
        if (footprintDistance(bs[j], x, z, j) < ROOM) free = false;
      }
      if (!free) continue;
      const c = k * nx + i;
      open[c] = 1;
      if (Math.abs(z) >= wait) {
        dist[c] = 0;
        heap.push(c, 0);
      }
    }
  }
  // Dijkstra over the 8 neighbours (diagonals cost √2)
  const steps: [number, number, number][] = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  while (heap.size) {
    const [c, d] = heap.pop();
    if (d > dist[c]) continue;
    const i = c % nx;
    const k = (c - i) / nx;
    for (const [di, dk, w] of steps) {
      const a = i + di;
      const b = k + dk;
      if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
      const e = b * nx + a;
      // no cutting a bunker's corner diagonally
      if (!open[e] || (di && dk && (!open[k * nx + a] || !open[b * nx + i]))) continue;
      const nd = d + w;
      if (nd < dist[e]) {
        dist[e] = nd;
        heap.push(e, nd);
      }
    }
  }
  flow = { map: field.map.id, nx, nz, x0, z0, dist };
  return flow;
}

/**
 * Fill `out` with this step's walk-off input for an out player at `b`: head for the square within
 * REACH that's closest to the waiting area (ties: the nearest such square, so you walk straight when
 * nothing's in the way). Rounded like a wire frame, so the browser's prediction and the server's
 * replay take the same step. Returns false once you're there (standing still, facing the field).
 */
export function walkOffInput(b: Body, out: MoveInput): boolean {
  out.jump = out.sprint = out.crouch = out.prone = false;
  out.right = 0;
  if (Math.abs(b.z) >= waitLine()) {
    out.forward = 0;
    out.yaw = Math.fround(b.z > 0 ? 0 : Math.PI); // forward is (-sin yaw, -cos yaw): back toward the field
    return false;
  }
  const f = walkOffMap();
  const ci = Math.round((b.x - f.x0) / CELL);
  const ck = Math.round((b.z - f.z0) / CELL);
  let best = -1;
  let bestD = Infinity;
  let bestR = Infinity;
  for (let dk = -REACH; dk <= REACH; dk++) {
    for (let di = -REACH; di <= REACH; di++) {
      const i = ci + di;
      const k = ck + dk;
      if (i < 0 || k < 0 || i >= f.nx || k >= f.nz) continue;
      const c = k * f.nx + i;
      const d = f.dist[c];
      const r = di * di + dk * dk;
      if (d < bestD - 1e-4 || (Math.abs(d - bestD) <= 1e-4 && r < bestR)) {
        best = c;
        bestD = d;
        bestR = r;
      }
    }
  }
  let dx: number;
  let dz: number;
  if (best < 0 || bestD === Infinity) {
    // nowhere in reach leads off (boxed in): just head for the nearer side line
    dx = 0;
    dz = b.z < 0 ? -1 : 1;
  } else {
    const i = best % f.nx;
    dx = f.x0 + i * CELL - b.x;
    dz = f.z0 + ((best - i) / f.nx) * CELL - b.z;
    if (Math.hypot(dx, dz) < 0.05) dz = b.z < 0 ? -1 : 1; // on the best square already: carry on outward
  }
  const q = quantizeInput(WALK_OFF_PACE, 0, Math.atan2(-dx, -dz), 0);
  out.forward = q.forward;
  out.yaw = q.yaw;
  return true;
}

/** a small binary min-heap of (square, distance) for Dijkstra */
class Heap {
  private c: number[] = [];
  private d: number[] = [];
  get size(): number {
    return this.c.length;
  }
  push(c: number, d: number): void {
    const C = this.c;
    const D = this.d;
    let i = C.length;
    C.push(c);
    D.push(d);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (D[p] <= d) break;
      C[i] = C[p];
      D[i] = D[p];
      i = p;
    }
    C[i] = c;
    D[i] = d;
  }
  pop(): [number, number] {
    const C = this.c;
    const D = this.d;
    const top: [number, number] = [C[0], D[0]];
    const c = C.pop()!;
    const d = D.pop()!;
    const n = C.length;
    if (n) {
      let i = 0;
      for (;;) {
        let m = 2 * i + 1;
        if (m >= n) break;
        if (m + 1 < n && D[m + 1] < D[m]) m++;
        if (D[m] >= d) break;
        C[i] = C[m];
        D[i] = D[m];
        i = m;
      }
      C[i] = c;
      D[i] = d;
    }
    return top;
  }
}

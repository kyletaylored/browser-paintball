// The field being played, shared by the client (to draw it) and the server (to collide players and
// paintballs with it). The layouts themselves are in shared/maps.ts; this file holds the shapes, the
// current map and the geometry helpers both sides need.
//
// Coordinates are metres. x runs end to end (Red starts at -x, Blue at +x), z runs side to side, y is up.

import type { Spawn, Team } from './protocol';
import { MAPS, DEFAULT_MAP, type GameMap } from './maps';

/** how a bunker is drawn (src/world.ts); collision only depends on its shape */
export type Look =
  | 'inflatable' | 'wood' | 'rock' | 'tree' | 'log' | 'hut' | 'dune' | 'boat' | 'spool' | 'sandbag' | 'barrel' | 'tower';

/** upright box, axis-aligned */
export type BoxBunker = { kind: 'box'; x: number; z: number; w: number; d: number; h: number; color: number; look?: Look };
/** upright cylinder */
export type CanBunker = { kind: 'can'; x: number; z: number; r: number; h: number; color: number; look?: Look };
/** upright prism over a convex footprint (triangles, diamonds, boulders); pts are relative to x, z */
export type PolyBunker = { kind: 'poly'; x: number; z: number; pts: [number, number][]; h: number; color: number; look?: Look };
/** a cylinder lying on the ground along x or z (logs, culverts); its top is at 2r */
export type LogBunker = { kind: 'log'; x: number; z: number; len: number; r: number; axis: 'x' | 'z'; color: number; look?: Look };
export type Bunker = BoxBunker | CanBunker | PolyBunker | LogBunker;

/** a bunker's height (top surface) */
export const topOf = (b: Bunker): number => (b.kind === 'log' ? b.r * 2 : b.h);

/**
 * The map being played and its derived numbers. Both sides read this; setMap changes it. Keep the
 * object (other modules hold on to it) and replace its fields.
 */
export const field = {
  map: MAPS[DEFAULT_MAP] as GameMap,
  halfL: 0,
  halfW: 0,
  /** distance from the field lines to the boundary */
  margin: 0,
  bunkers: [] as readonly Bunker[],
  /** per bunker, a bounding circle and top, for cheap early-outs in the ray tests */
  bounds: [] as readonly { x: number; z: number; r: number; top: number }[],
  /** per poly bunker (same index), its footprint in world space with outward edge normals */
  polys: [] as readonly (PolyShape | null)[],
};

export interface PolyShape {
  /** world-space corners, counter-clockwise seen from above (+y) */
  xs: number[];
  zs: number[];
  /** outward normal and offset of each edge i → i+1: n·p <= off inside */
  nx: number[];
  nz: number[];
  off: number[];
}

function polyShape(b: PolyBunker): PolyShape {
  let pts = b.pts.map(([px, pz]) => [b.x + px, b.z + pz] as [number, number]);
  // signed area (x right, z down the screen from above): make the winding consistent
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % pts.length];
    area += ax * bz - bx * az;
  }
  if (area < 0) pts = pts.reverse();
  const s: PolyShape = { xs: [], zs: [], nx: [], nz: [], off: [] };
  for (let i = 0; i < pts.length; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % pts.length];
    const ex = bx - ax;
    const ez = bz - az;
    const len = Math.hypot(ex, ez);
    // with this winding, (ez, -ex) points out
    const nx = ez / len;
    const nz = -ex / len;
    s.xs.push(ax);
    s.zs.push(az);
    s.nx.push(nx);
    s.nz.push(nz);
    s.off.push(nx * ax + nz * az);
  }
  return s;
}

/** switch to map `id` (unknown ids are ignored); returns whether it changed */
export function setMap(id: string): boolean {
  const m = MAPS[id];
  if (!m || (m === field.map && field.bunkers.length)) return false;
  field.map = m;
  field.halfL = m.length / 2;
  field.halfW = m.width / 2;
  field.margin = m.margin;
  field.bunkers = m.bunkers;
  field.polys = m.bunkers.map((b) => (b.kind === 'poly' ? polyShape(b) : null));
  field.bounds = m.bunkers.map((b) => {
    let r: number;
    if (b.kind === 'box') r = Math.hypot(b.w, b.d) / 2;
    else if (b.kind === 'can') r = b.r;
    else if (b.kind === 'log') r = Math.hypot(b.len / 2, b.r);
    else r = Math.max(...b.pts.map(([px, pz]) => Math.hypot(px, pz)));
    return { x: b.x, z: b.z, r: r + 0.05, top: topOf(b) };
  });
  return true;
}
setMap(DEFAULT_MAP);

/** a log's footprint as a box: [half x, half z] */
export const logHalf = (b: LogBunker): [number, number] => (b.axis === 'x' ? [b.len / 2, b.r] : [b.r, b.len / 2]);

/** distance from (x, z) to a bunker's footprint, seen from above (negative inside) */
export function footprintDistance(b: Bunker, x: number, z: number, i = field.bunkers.indexOf(b)): number {
  if (b.kind === 'can') return Math.hypot(x - b.x, z - b.z) - b.r;
  if (b.kind === 'poly') {
    const s = field.polys[i] ?? polyShape(b);
    let inside = -Infinity;
    for (let k = 0; k < s.nx.length; k++) inside = Math.max(inside, s.nx[k] * x + s.nz[k] * z - s.off[k]);
    if (inside <= 0) return inside;
    let best = Infinity;
    const n = s.xs.length;
    for (let k = 0; k < n; k++) {
      const ax = s.xs[k];
      const az = s.zs[k];
      const ex = s.xs[(k + 1) % n] - ax;
      const ez = s.zs[(k + 1) % n] - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez)));
      best = Math.min(best, Math.hypot(x - (ax + ex * t), z - (az + ez * t)));
    }
    return best;
  }
  const [hx, hz] = b.kind === 'log' ? logHalf(b) : [b.w / 2, b.d / 2];
  const dx = Math.abs(x - b.x) - hx;
  const dz = Math.abs(z - b.z) - hz;
  return Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dz), 0);
}

/** name of a bunker's model in public/models/bunkers.glb (same shape + colour = same model) */
export function bunkerKey(b: Bunker): string {
  const c = b.color.toString(16).padStart(6, '0');
  if (b.kind === 'box') return `box-${b.w}x${b.d}x${b.h}-${c}`;
  if (b.kind === 'can') return `can-${b.r}x${b.h}-${c}`;
  if (b.kind === 'log') return `log-${b.len}x${b.r}-${c}`;
  // two wedges can share a corner count, height and colour but not their shape: name them by their corners
  let h = 0x811c9dc5;
  for (const [px, pz] of b.pts) for (const v of [Math.round(px * 100), Math.round(pz * 100)]) h = Math.imul(h ^ (v & 0xffff), 0x01000193) >>> 0;
  return `poly-${b.pts.length}x${b.h}-${c}-${h.toString(36)}`;
}

/** where a team's players start: a line across the back of their end */
export function spawnPoint(team: Team, slot: number): Spawn {
  const x = team === 0 ? -field.halfL + 1.5 : field.halfL - 1.5;
  const z = ((slot % 6) - 2.5) * 2.2;
  return { x, y: 0, z, yaw: team === 0 ? -Math.PI / 2 : Math.PI / 2 };
}

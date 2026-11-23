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
/**
 * A convex outline that narrows toward the top (doritos, spikes, temples, wedges). `pts` is the base,
 * relative to x, z; the top, at height h, is the base shrunk by `top` toward `apex` (relative to x, z;
 * the middle of the base if left out). top 0 comes to a point. The apex must be inside or on the base.
 */
export type TaperBunker = {
  kind: 'taper'; x: number; z: number; pts: [number, number][]; h: number; top: number; apex?: [number, number]; color: number; look?: Look;
};
/**
 * A wall seen from the side (W and M walls, notched walls, tombstones, half-moons): `line` is its top,
 * [u, height] from one end to the other with u increasing, where u runs along `axis` from x (or z). The
 * shape under that line, down to the ground, is `d` thick across the wall.
 */
export type ProfileBunker = {
  kind: 'profile'; x: number; z: number; axis: 'x' | 'z'; d: number; line: [number, number][]; color: number; look?: Look;
};
export type Bunker = BoxBunker | CanBunker | PolyBunker | LogBunker | TaperBunker | ProfileBunker;

/** a bunker's height (its highest point) */
export function topOf(b: Bunker): number {
  if (b.kind === 'log') return b.r * 2;
  if (b.kind === 'profile') return Math.max(...b.line.map(([, y]) => y));
  return b.h;
}

/** the middle of a list of points (their average) */
export function centreOf(pts: readonly [number, number][]): [number, number] {
  let x = 0;
  let z = 0;
  for (const [px, pz] of pts) {
    x += px;
    z += pz;
  }
  return [x / pts.length, z / pts.length];
}

/** a profile wall's footprint as a box: its centre and half sizes in x and z */
export function profileBox(b: ProfileBunker): { x: number; z: number; hx: number; hz: number } {
  const u0 = b.line[0][0];
  const u1 = b.line[b.line.length - 1][0];
  const mid = (u0 + u1) / 2;
  const half = (u1 - u0) / 2;
  return b.axis === 'x' ? { x: b.x + mid, z: b.z, hx: half, hz: b.d / 2 } : { x: b.x, z: b.z + mid, hx: b.d / 2, hz: half };
}

/** a profile wall's height at u (along the wall, from its x or z), or -1 past its ends */
export function profileHeight(b: ProfileBunker, u: number): number {
  const l = b.line;
  if (u < l[0][0] || u > l[l.length - 1][0]) return -1;
  for (let k = 1; k < l.length; k++) {
    const [ua, ya] = l[k - 1];
    const [ub, yb] = l[k];
    if (u <= ub) return ub - ua < 1e-9 ? Math.max(ya, yb) : ya + ((yb - ya) * (u - ua)) / (ub - ua);
  }
  return l[l.length - 1][1];
}

/** where a taper's top corners are, relative to its x, z */
export function taperTop(b: TaperBunker): [number, number][] {
  const [ax, az] = b.apex ?? centreOf(b.pts);
  return b.pts.map(([px, pz]) => [ax + (px - ax) * b.top, az + (pz - az) * b.top]);
}

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
  /** per poly or taper bunker (same index), its footprint in world space with outward edge normals */
  polys: [] as readonly (PolyShape | null)[],
  /** per taper bunker (same index), the planes that bound it */
  hulls: [] as readonly (HullShape | null)[],
};

/** a convex solid as the planes round it: n·p <= off inside every one */
export interface HullShape {
  nx: number[];
  ny: number[];
  nz: number[];
  off: number[];
}

/** the planes round a taper: the ground, the top (unless it comes to a point) and one per side */
function hullShape(b: TaperBunker, foot: PolyShape): HullShape {
  const s: HullShape = { nx: [0], ny: [-1], nz: [0], off: [0] };
  if (b.top > 0) {
    s.nx.push(0);
    s.ny.push(1);
    s.nz.push(0);
    s.off.push(b.h);
  }
  const [ax, az] = b.apex ?? centreOf(b.pts);
  const apx = b.x + ax;
  const apz = b.z + az;
  const n = foot.xs.length;
  for (let i = 0; i < n; i++) {
    const x0 = foot.xs[i];
    const z0 = foot.zs[i];
    // the base edge e (flat), and u: up from its first corner to where that corner is on the top
    const ex = foot.xs[(i + 1) % n] - x0;
    const ez = foot.zs[(i + 1) % n] - z0;
    const ux = apx + (x0 - apx) * b.top - x0;
    const uy = b.h;
    const uz = apz + (z0 - apz) * b.top - z0;
    // e × u is square to the side; the footprint's own outward normal says which way is out
    let nx = -ez * uy;
    let ny = ez * ux - ex * uz;
    let nz = ex * uy;
    if (nx * foot.nx[i] + nz * foot.nz[i] < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const len = Math.hypot(nx, ny, nz);
    nx /= len;
    ny /= len;
    nz /= len;
    s.nx.push(nx);
    s.ny.push(ny);
    s.nz.push(nz);
    s.off.push(nx * x0 + nz * z0);
  }
  return s;
}

/** a taper's height at (x, z) (world), or -1 outside its base; i is its index in field.bunkers */
export function taperHeight(i: number, x: number, z: number): number {
  const s = field.hulls[i];
  if (!s) return -1;
  let y = Infinity;
  for (let k = 0; k < s.nx.length; k++) {
    const room = s.off[k] - s.nx[k] * x - s.nz[k] * z;
    if (s.ny[k] > 1e-9) y = Math.min(y, room / s.ny[k]);
    else if (s.ny[k] > -1e-9 && room < -1e-9) return -1;
  }
  return y === Infinity || y < 0 ? -1 : y;
}

export interface PolyShape {
  /** world-space corners, counter-clockwise seen from above (+y) */
  xs: number[];
  zs: number[];
  /** outward normal and offset of each edge i → i+1: n·p <= off inside */
  nx: number[];
  nz: number[];
  off: number[];
}

function polyShape(b: { x: number; z: number; pts: [number, number][] }): PolyShape {
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
  useBunkers(m.bunkers);
  return true;
}

/** collide with these bunkers (setMap does this; tests can call it with shapes of their own) */
export function useBunkers(bunkers: readonly Bunker[]): void {
  field.bunkers = bunkers;
  field.polys = bunkers.map((b) => (b.kind === 'poly' || b.kind === 'taper' ? polyShape(b) : null));
  field.hulls = bunkers.map((b, i) => (b.kind === 'taper' ? hullShape(b, field.polys[i]!) : null));
  field.bounds = bunkers.map((b) => {
    let r: number;
    if (b.kind === 'box') r = Math.hypot(b.w, b.d) / 2;
    else if (b.kind === 'can') r = b.r;
    else if (b.kind === 'log') r = Math.hypot(b.len / 2, b.r);
    else if (b.kind === 'profile') {
      const f = profileBox(b);
      r = Math.hypot(Math.abs(f.x - b.x) + f.hx, Math.abs(f.z - b.z) + f.hz);
    } else r = Math.max(...b.pts.map(([px, pz]) => Math.hypot(px, pz)));
    return { x: b.x, z: b.z, r: r + 0.05, top: topOf(b) };
  });
}
setMap(DEFAULT_MAP);

/** a log's footprint as a box: [half x, half z] */
export const logHalf = (b: LogBunker): [number, number] => (b.axis === 'x' ? [b.len / 2, b.r] : [b.r, b.len / 2]);

/** distance from (x, z) to a bunker's footprint, seen from above (negative inside) */
export function footprintDistance(b: Bunker, x: number, z: number, i = field.bunkers.indexOf(b)): number {
  if (b.kind === 'can') return Math.hypot(x - b.x, z - b.z) - b.r;
  if (b.kind === 'poly' || b.kind === 'taper') {
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
  if (b.kind === 'profile') {
    const f = profileBox(b);
    const dx = Math.abs(x - f.x) - f.hx;
    const dz = Math.abs(z - f.z) - f.hz;
    return Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dz), 0);
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
  if (b.kind === 'profile') return `profile-${b.axis}-${b.d}-${c}-${hashPoints(b.line)}`;
  if (b.kind === 'taper') return `taper-${b.pts.length}x${b.h}-${b.top}-${c}-${hashPoints([...b.pts, b.apex ?? [99, 99]])}`;
  return `poly-${b.pts.length}x${b.h}-${c}-${hashPoints(b.pts)}`;
}

function hashPoints(pts: readonly [number, number][]): string {
  let h = 0x811c9dc5;
  for (const [px, pz] of pts) for (const v of [Math.round(px * 100), Math.round(pz * 100)]) h = Math.imul(h ^ (v & 0xffff), 0x01000193) >>> 0;
  return h.toString(36);
}

/** where a team's players start: a line across the back of their end */
export function spawnPoint(team: Team, slot: number): Spawn {
  const x = team === 0 ? -field.halfL + 1.5 : field.halfL - 1.5;
  const z = ((slot % 6) - 2.5) * 2.2;
  return { x, y: 0, z, yaw: team === 0 ? -Math.PI / 2 : Math.PI / 2 };
}

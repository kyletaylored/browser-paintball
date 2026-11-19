// Game rules and physics that must agree on both sides: player movement, paintball flight,
// and collision against the field. No three.js in here, just numbers, so the Node server can run it too.
//
// No physics engine is needed: a paintball field is boxes and cylinders, and the player is
// treated as an upright capsule.

import { BUNKERS, HALF_L, HALF_W, NET_MARGIN } from './field';

// ---- tuning -------------------------------------------------------------------------------

export const GRAVITY = 9.81;
/** ~280 fps, a typical field limit */
export const BALL_SPEED = 85;
export const BALL_DRAG = 0.35;
export const BALL_RADIUS = 0.0085;
export const BALL_LIFETIME = 2.5;
/** 10 balls per second */
export const FIRE_INTERVAL = 1 / 10;

export const PLAYER_RADIUS = 0.32;
export const STAND_HEIGHT = 1.8;
export const CROUCH_HEIGHT = 1.15;
export const EYE_FROM_TOP = 0.12;
export const WALK_SPEED = 5.2;
export const SPRINT_SPEED = 7.6;
export const CROUCH_SPEED = 2.6;
export const JUMP_SPEED = 6.4;
export const PLAYER_GRAVITY = 18;

export const RESPAWN_SECONDS = 3;
export const SERVER_TICK_HZ = 60;
export const SNAPSHOT_HZ = 20;
export const CLIENT_SEND_HZ = 20;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => clamp(v, 0, 1);

// ---- player movement ----------------------------------------------------------------------

export interface Body {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  height: number;
  onGround: boolean;
}

export interface MoveInput {
  /** -1..1, W/S */
  forward: number;
  /** -1..1, D/A */
  right: number;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
  yaw: number;
}

/**
 * One fixed step of player movement. The client runs this for its own player. To add
 * client-side prediction later, the server runs the same function on the inputs it receives.
 */
export function stepMovement(b: Body, inp: MoveInput, dt: number): void {
  const targetH = inp.crouch ? CROUCH_HEIGHT : STAND_HEIGHT;
  b.height += (targetH - b.height) * Math.min(1, dt * 12);

  // yaw 0 looks down -z. forward = (-sin, -cos), right = (cos, -sin)
  const s = Math.sin(inp.yaw);
  const c = Math.cos(inp.yaw);
  let wx = -s * inp.forward + c * inp.right;
  let wz = -c * inp.forward - s * inp.right;
  const len = Math.hypot(wx, wz);
  if (len > 1) {
    wx /= len;
    wz /= len;
  }
  const speed = inp.crouch ? CROUCH_SPEED : inp.sprint ? SPRINT_SPEED : WALK_SPEED;
  wx *= speed;
  wz *= speed;

  const k = Math.min(1, (b.onGround ? 14 : 2.5) * dt);
  b.vx += (wx - b.vx) * k;
  b.vz += (wz - b.vz) * k;

  if (inp.jump && b.onGround && !inp.crouch) {
    b.vy = JUMP_SPEED;
    b.onGround = false;
  }

  const prevY = b.y;
  b.vy -= PLAYER_GRAVITY * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt;

  const ground = groundHeightAt(b.x, b.z, prevY);
  if (b.y <= ground) {
    b.y = ground;
    b.vy = 0;
    b.onGround = true;
  } else {
    b.onGround = false;
  }

  pushOutOfBunkers(b);
}

/** Highest surface under the player whose top is at or below their feet (lets you stand on low bunkers). */
function groundHeightAt(x: number, z: number, feetY: number): number {
  let g = 0;
  const r = PLAYER_RADIUS * 0.6;
  for (const b of BUNKERS) {
    if (b.h > feetY + 0.06) continue;
    if (b.kind === 'box') {
      const dx = x - clamp(x, b.x - b.w / 2, b.x + b.w / 2);
      const dz = z - clamp(z, b.z - b.d / 2, b.z + b.d / 2);
      if (dx * dx + dz * dz < r * r) g = Math.max(g, b.h);
    } else {
      if (Math.hypot(x - b.x, z - b.z) < b.r + r) g = Math.max(g, b.h);
    }
  }
  return g;
}

function pushOutOfBunkers(p: Body): void {
  const r = PLAYER_RADIUS;
  for (const b of BUNKERS) {
    if (p.y >= b.h - 0.06) continue; // standing on top of it, or above it
    if (b.kind === 'box') {
      const hx = b.w / 2;
      const hz = b.d / 2;
      const dx = p.x - clamp(p.x, b.x - hx, b.x + hx);
      const dz = p.z - clamp(p.z, b.z - hz, b.z + hz);
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-10) {
        const d = Math.sqrt(d2);
        slide(p, dx / d, dz / d, r - d);
      } else {
        // centre ended up inside the box: leave by the shallowest side
        const px = hx - Math.abs(p.x - b.x) + r;
        const pz = hz - Math.abs(p.z - b.z) + r;
        if (px < pz) slide(p, Math.sign(p.x - b.x) || 1, 0, px);
        else slide(p, 0, Math.sign(p.z - b.z) || 1, pz);
      }
    } else {
      const dx = p.x - b.x;
      const dz = p.z - b.z;
      const d = Math.hypot(dx, dz);
      const min = b.r + r;
      if (d >= min) continue;
      if (d > 1e-6) slide(p, dx / d, dz / d, min - d);
      else slide(p, 1, 0, min);
    }
  }
  const lx = HALF_L + NET_MARGIN - r;
  const lz = HALF_W + NET_MARGIN - r;
  p.x = clamp(p.x, -lx, lx);
  p.z = clamp(p.z, -lz, lz);
}

/** Push out along a normal and remove the velocity going into the surface, so you slide along walls. */
function slide(p: Body, nx: number, nz: number, depth: number): void {
  p.x += nx * depth;
  p.z += nz * depth;
  const vn = p.vx * nx + p.vz * nz;
  if (vn < 0) {
    p.vx -= vn * nx;
    p.vz -= vn * nz;
  }
}

// ---- paintballs ---------------------------------------------------------------------------

export interface Ball {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  owner: number;
  team: number;
}

export function advanceBall(b: Ball, dt: number): void {
  b.vy -= GRAVITY * dt;
  const k = Math.max(0, 1 - BALL_DRAG * dt);
  b.vx *= k;
  b.vy *= k;
  b.vz *= k;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt;
  b.age += dt;
}

export function isOutOfBounds(x: number, y: number, z: number): boolean {
  return Math.abs(x) > HALF_L + NET_MARGIN || Math.abs(z) > HALF_W + NET_MARGIN || y < -1 || y > 40;
}

export interface WorldHit {
  /** 0..1 along the segment */
  t: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

/**
 * First thing the segment (x0,y0,z0)→(x1,y1,z1) hits: the ground or a bunker.
 * Balls move ~1.4 m per frame, so we test the whole path instead of the end point; otherwise they'd tunnel.
 */
export function traceWorld(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): WorldHit | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  let best = Infinity;
  let nx = 0;
  let ny = 0;
  let nz = 0;

  if (y0 > 0 && y1 <= 0) {
    best = y0 / (y0 - y1);
    ny = 1;
  }

  for (const b of BUNKERS) {
    if (b.kind === 'box') {
      const t = segBox(x0, y0, z0, dx, dy, dz, b.x - b.w / 2, 0, b.z - b.d / 2, b.x + b.w / 2, b.h, b.z + b.d / 2);
      if (t >= 0 && t < best) {
        best = t;
        nx = boxN[0];
        ny = boxN[1];
        nz = boxN[2];
      }
    } else {
      const fx = x0 - b.x;
      const fz = z0 - b.z;
      // side of the cylinder
      const a = dx * dx + dz * dz;
      const bb = 2 * (fx * dx + fz * dz);
      const c = fx * fx + fz * fz - b.r * b.r;
      if (a > 1e-12 && c > 0) {
        const disc = bb * bb - 4 * a * c;
        if (disc >= 0) {
          const t = (-bb - Math.sqrt(disc)) / (2 * a);
          const y = y0 + dy * t;
          if (t >= 0 && t <= 1 && y >= 0 && y <= b.h && t < best) {
            best = t;
            nx = (fx + dx * t) / b.r;
            ny = 0;
            nz = (fz + dz * t) / b.r;
          }
        }
      }
      // top cap
      if (y0 > b.h && y1 <= b.h) {
        const t = (y0 - b.h) / (y0 - y1);
        const px = fx + dx * t;
        const pz = fz + dz * t;
        if (px * px + pz * pz <= b.r * b.r && t < best) {
          best = t;
          nx = 0;
          ny = 1;
          nz = 0;
        }
      }
    }
  }

  if (best === Infinity) return null;
  return { t: best, x: x0 + dx * best, y: y0 + dy * best, z: z0 + dz * best, nx, ny, nz };
}

const boxN = [0, 0, 0];

/** Slab test. Returns entry t in 0..1 (and writes the face normal to boxN), or -1. */
function segBox(
  x0: number, y0: number, z0: number, dx: number, dy: number, dz: number,
  minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number,
): number {
  const p = [x0, y0, z0];
  const d = [dx, dy, dz];
  const lo = [minX, minY, minZ];
  const hi = [maxX, maxY, maxZ];
  let tmin = 0;
  let tmax = 1;
  let axis = -1;
  let sign = 0;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) {
      if (p[i] < lo[i] || p[i] > hi[i]) return -1;
      continue;
    }
    let t1 = (lo[i] - p[i]) / d[i];
    let t2 = (hi[i] - p[i]) / d[i];
    let s = -1; // moving +, so we enter through the low face, whose normal points -axis
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = i;
      sign = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  if (axis < 0) return -1; // started inside
  boxN[0] = axis === 0 ? sign : 0;
  boxN[1] = axis === 1 ? sign : 0;
  boxN[2] = axis === 2 ? sign : 0;
  return tmin;
}

/**
 * Does the ball's path touch an upright player capsule standing at (px,py,pz)?
 * Returns how far along the path (0..1), or null. Closest-point between two segments (Ericson, RTCD 5.1.9).
 */
export function segmentHitsCapsule(
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  px: number, py: number, pz: number, height: number, radius = PLAYER_RADIUS,
): number | null {
  const ay = py + radius;
  const by = py + Math.max(radius, height - radius);
  const d1x = x1 - x0;
  const d1y = y1 - y0;
  const d1z = z1 - z0;
  const d2y = by - ay; // the capsule axis is vertical, so d2x = d2z = 0
  const rx = x0 - px;
  const ry = y0 - ay;
  const rz = z0 - pz;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2y * d2y;
  const f = d2y * ry;
  let s: number;
  let t: number;
  if (a < 1e-12) {
    s = 0;
    t = e > 1e-12 ? clamp01(f / e) : 0;
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e < 1e-12) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = d1y * d2y;
      const denom = a * e - b * b;
      s = denom > 1e-12 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const cx = x0 + d1x * s - px;
  const cy = y0 + d1y * s - (ay + d2y * t);
  const cz = z0 + d1z * s - pz;
  const rr = radius + BALL_RADIUS;
  return cx * cx + cy * cy + cz * cz <= rr * rr ? s : null;
}

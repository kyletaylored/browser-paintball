// Game rules and physics that must agree on both sides: player movement, paintball flight,
// and collision against the field. No three.js in here, just numbers, so the Node server can run it too.
//
// No physics engine is needed: a paintball field is boxes, cylinders, upright prisms, logs, tapering
// shapes (doritos, spikes) and walls with a shaped top, and the player is treated as an upright
// capsule. Everything reads the current map from shared/field.ts.

import { field, logHalf, topOf, footprintDistance, profileBox, profileHeight, orbY, type Bunker, type OrbBunker, type ProfileBunker } from './field';

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
/** lying down: eyes just above the grass */
export const PRONE_HEIGHT = 0.55;
/** a lying body's thickness (radius), and how far its capsule reaches ahead of and behind where they are */
export const PRONE_RADIUS = 0.2;
export const PRONE_HEAD = 0.2;
export const PRONE_FEET = 1.2;
export const EYE_FROM_TOP = 0.12;
export const WALK_SPEED = 5.2;
export const SPRINT_SPEED = 7.6;
export const CROUCH_SPEED = 2.6;
export const PRONE_SPEED = 1.1;
export const JUMP_SPEED = 6.4;
export const PLAYER_GRAVITY = 18;

export const RESPAWN_SECONDS = 3;
export const SERVER_TICK_HZ = 60;
export const SNAPSHOT_HZ = 20;
export const CLIENT_SEND_HZ = 60;
/** length of one movement step; the browser predicts and the server replays in steps of exactly this */
export const INPUT_DT = 1 / 120;
/**
 * Browsers draw other players this far in the past (seconds), blending between snapshots. The server
 * uses the same number when it rewinds targets for lag compensation, so the two must agree.
 */
export const INTERP_DELAY = 0.1;

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
  /** lying down (beats crouch) */
  prone: boolean;
  yaw: number;
}

/** how tall a player is for their stance (what hits are tested against) */
export const stanceHeight = (crouch: boolean, prone: boolean): number =>
  prone ? PRONE_HEIGHT : crouch ? CROUCH_HEIGHT : STAND_HEIGHT;

/**
 * One fixed step of player movement. The browser runs it to predict its own player, and the server
 * runs it on the same input frames to decide where everyone really is. Keep it deterministic: same
 * body + same input must give the same result on both sides.
 */
export function stepMovement(b: Body, inp: MoveInput, dt: number): void {
  const targetH = stanceHeight(inp.crouch, inp.prone);
  // getting down on the ground (or up from it) takes a moment longer than crouching
  const lying = inp.prone || b.height < CROUCH_HEIGHT - 0.05;
  b.height += (targetH - b.height) * Math.min(1, dt * (lying ? 7 : 12));

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
  const speed = inp.prone ? PRONE_SPEED : inp.crouch ? CROUCH_SPEED : inp.sprint ? SPRINT_SPEED : WALK_SPEED;
  wx *= speed;
  wz *= speed;

  const k = Math.min(1, (b.onGround ? 14 : 2.5) * dt);
  b.vx += (wx - b.vx) * k;
  b.vz += (wz - b.vz) * k;

  if (inp.jump && b.onGround && !inp.crouch && !inp.prone) {
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
  const bs = field.bunkers;
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    const top = topOf(b);
    if (top > feetY + 0.06 || top <= g) continue;
    // sloped, shaped and round tops can't be stood on: you slide off them (see pushOutOfBunkers)
    if (b.kind === 'taper' || b.kind === 'profile' || b.kind === 'orb') continue;
    const bound = field.bounds[i];
    if (Math.abs(x - bound.x) > bound.r + r || Math.abs(z - bound.z) > bound.r + r) continue;
    if (b.kind === 'box') {
      const dx = x - clamp(x, b.x - b.w / 2, b.x + b.w / 2);
      const dz = z - clamp(z, b.z - b.d / 2, b.z + b.d / 2);
      if (dx * dx + dz * dz < r * r) g = top;
    } else if (b.kind === 'can') {
      if (Math.hypot(x - b.x, z - b.z) < b.r + r) g = top;
    } else if (footprintDistance(b, x, z, i) < r) {
      g = top; // poly, or a log (stood on as if its top were flat)
    }
  }
  return g;
}

function pushOutOfBunkers(p: Body): void {
  const r = PLAYER_RADIUS;
  const bs = field.bunkers;
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (p.y >= topOf(b) - 0.06) continue; // standing on top of it, or above it
    const bound = field.bounds[i];
    if (Math.abs(p.x - bound.x) > bound.r + r || Math.abs(p.z - bound.z) > bound.r + r) continue;
    if (b.kind === 'poly' || b.kind === 'taper') {
      // a taper is pushed out of by its base: it's solid all the way up for walking
      pushOutOfPoly(p, i, r);
    } else if (b.kind === 'box' || b.kind === 'log' || b.kind === 'profile') {
      // a log, or a shaped wall, is pushed out of like a box the size of its footprint
      let cx = b.x;
      let cz = b.z;
      let hx: number;
      let hz: number;
      if (b.kind === 'profile') ({ x: cx, z: cz, hx, hz } = profileBox(b));
      else [hx, hz] = b.kind === 'log' ? logHalf(b) : [b.w / 2, b.d / 2];
      const dx = p.x - clamp(p.x, cx - hx, cx + hx);
      const dz = p.z - clamp(p.z, cz - hz, cz + hz);
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-10) {
        const d = Math.sqrt(d2);
        slide(p, dx / d, dz / d, r - d);
      } else {
        // centre ended up inside the box: leave by the shallowest side
        const px = hx - Math.abs(p.x - cx) + r;
        const pz = hz - Math.abs(p.z - cz) + r;
        if (px < pz) slide(p, Math.sign(p.x - cx) || 1, 0, px);
        else slide(p, 0, Math.sign(p.z - cz) || 1, pz);
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
  const lx = field.halfL + field.margin - r;
  const lz = field.halfW + field.margin - r;
  p.x = clamp(p.x, -lx, lx);
  p.z = clamp(p.z, -lz, lz);
}

/** push a player out of an upright convex prism (bunker i) */
function pushOutOfPoly(p: Body, i: number, r: number): void {
  const s = field.polys[i]!;
  // deepest-inside edge: if even that one is more than r away, we're clear
  let best = -Infinity;
  let k = 0;
  for (let e = 0; e < s.nx.length; e++) {
    const d = s.nx[e] * p.x + s.nz[e] * p.z - s.off[e];
    if (d > best) {
      best = d;
      k = e;
    }
  }
  if (best >= r) return;
  if (best <= 0) {
    // centre inside: leave through the nearest face
    slide(p, s.nx[k], s.nz[k], r - best);
    return;
  }
  // outside but within r of some edge or corner: push away from the closest point on the outline
  const d = footprintDistance(field.bunkers[i], p.x, p.z, i);
  if (d >= r) return;
  // closest point on the outline, found again to get the direction
  let cx = 0;
  let cz = 0;
  let cd = Infinity;
  const n = s.xs.length;
  for (let e = 0; e < n; e++) {
    const ax = s.xs[e];
    const az = s.zs[e];
    const ex = s.xs[(e + 1) % n] - ax;
    const ez = s.zs[(e + 1) % n] - az;
    const t = clamp01(((p.x - ax) * ex + (p.z - az) * ez) / (ex * ex + ez * ez));
    const qx = ax + ex * t;
    const qz = az + ez * t;
    const dd = Math.hypot(p.x - qx, p.z - qz);
    if (dd < cd) {
      cd = dd;
      cx = qx;
      cz = qz;
    }
  }
  if (cd > 1e-9) slide(p, (p.x - cx) / cd, (p.z - cz) / cd, r - cd);
  else slide(p, s.nx[k], s.nz[k], r);
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

/**
 * Balls fly in fixed steps of this, on the server and in every browser, so the same ball takes the
 * same path everywhere (and bounces the same way: see hitWorld).
 */
export const BALL_DT = INPUT_DT;

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
  /** this ball's random numbers (ballSeed, then rolled on each hit); the same on every machine */
  seed: number;
  /** times it has bounced off something without breaking */
  bounces: number;
}

const f32 = new Float32Array(3);
const u32 = new Uint32Array(f32.buffer);

/**
 * Where a ball's random numbers start: a hash of the point it was fired from, rounded to float32
 * the way the wire sends it. The shooter, the server and everyone who gets the 'ball' message all
 * know that point, so they all roll the same bounces without anyone sending a seed.
 */
export function ballSeed(o: readonly number[]): number {
  f32[0] = o[0];
  f32[1] = o[1];
  f32[2] = o[2];
  let h = 0x811c9dc5;
  for (let i = 0; i < 3; i++) {
    h = Math.imul(h ^ u32[i], 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
  }
  return h >>> 0;
}

/** the ball's next random number in [0, 1) (mulberry32) */
function roll(b: Ball): number {
  let t = (b.seed = (b.seed + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const MAX_BOUNCES = 3;
/** after a bounce: what's left of the speed into the surface, and along it */
const BOUNCE_RESTITUTION = 0.3;
const BOUNCE_FRICTION = 0.72;
/** slower than this after a bounce, the ball just drops and rolls: it's out of play */
const BOUNCE_MIN_SPEED = 6;

/**
 * How likely a ball is to bounce instead of breaking. cos is how square-on it hits (1 = straight
 * at the surface, 0 = skimming along it). A glancing hit usually bounces, a square one never does,
 * and a slow ball (long range, or one that already bounced) bounces more easily.
 */
export function bounceChance(cos: number, speed: number): number {
  const angle = clamp01((0.5 - cos) / 0.38);
  const slow = clamp01((40 - speed) / 40) * 0.45;
  return Math.min(0.92, angle * 0.85 + (cos < 0.75 ? slow : 0));
}

/**
 * How likely a ball is to bounce off a player instead of breaking. Bodies are soft: most hits
 * break, but a glancing one often skips off, and then the player plays on.
 */
export function playerBounceChance(cos: number, speed: number): number {
  const angle = clamp01((0.5 - cos) / 0.38);
  const slow = clamp01((40 - speed) / 40) * 0.2;
  return Math.min(0.75, 0.03 + angle * 0.6 + slow);
}

export type Contact = 'break' | 'bounce' | 'stop';

/**
 * The ball touched the world at w (from traceWorld): it breaks (paint), bounces off (the ball is
 * moved to the contact point and its velocity reflected), or bounces and has too little speed left
 * to matter ('stop': it's gone, without paint). Rolls the ball's random number either way, so every
 * machine stays in step.
 */
export function hitWorld(b: Ball, w: WorldHit): Contact {
  return deflect(b, w.x, w.y, w.z, w.nx, w.ny, w.nz, bounceChance);
}

/**
 * The ball touched a player at (x, y, z) (where segmentHitsPlayer said): 'break' and they're out,
 * or it bounces off them ('bounce', or 'stop' if it's spent) and they play on. The same player
 * shape as the hit test, so the same answer on every machine that saw the same hit.
 */
export function hitPlayer(
  b: Ball, x: number, y: number, z: number,
  px: number, py: number, pz: number, height: number, yaw: number, prone: boolean,
): Contact {
  // the body's centre line (a0 → a1) and thickness, as in segmentHitsPlayer
  let a0x = px, a0y = py + PLAYER_RADIUS, a0z = pz;
  let a1x = px, a1y = py + Math.max(PLAYER_RADIUS, height - PLAYER_RADIUS), a1z = pz;
  let r = PLAYER_RADIUS + BALL_RADIUS;
  if (prone) {
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    a0x = px + fx * PRONE_HEAD; a0y = py + PRONE_RADIUS; a0z = pz + fz * PRONE_HEAD;
    a1x = px - fx * PRONE_FEET; a1y = a0y; a1z = pz - fz * PRONE_FEET;
    r = PRONE_RADIUS + BALL_RADIUS;
  }
  const ex = a1x - a0x;
  const ey = a1y - a0y;
  const ez = a1z - a0z;
  const ee = ex * ex + ey * ey + ez * ez;
  const near = { x: 0, y: 0, z: 0 };
  const dist = (qx: number, qy: number, qz: number): number => {
    const t = ee > 1e-12 ? clamp01(((qx - a0x) * ex + (qy - a0y) * ey + (qz - a0z) * ez) / ee) : 0;
    near.x = a0x + ex * t;
    near.y = a0y + ey * t;
    near.z = a0z + ez * t;
    return Math.hypot(qx - near.x, qy - near.y, qz - near.z);
  };
  // (x, y, z) is where the path came closest, which can be well inside the body: back up along the
  // path to where the ball first touched it (bisection), so the bounce comes off the surface it met
  const speed = Math.hypot(b.vx, b.vy, b.vz) || 1;
  const ux = b.vx / speed;
  const uy = b.vy / speed;
  const uz = b.vz / speed;
  let lo = 0; // inside (or touching)
  let hi = 2 * r + 0.05; // backed up this far: outside
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    if (dist(x - ux * m, y - uy * m, z - uz * m) < r) lo = m;
    else hi = m;
  }
  const cx = x - ux * hi;
  const cy = y - uy * hi;
  const cz = z - uz * hi;
  const d = dist(cx, cy, cz);
  let nx = -ux;
  let ny = -uy;
  let nz = -uz;
  if (d > 1e-6) {
    nx = (cx - near.x) / d;
    ny = (cy - near.y) / d;
    nz = (cz - near.z) / d;
  }
  return deflect(b, cx, cy, cz, nx, ny, nz, playerBounceChance);
}

/** break, or bounce off the surface at (x, y, z) with outward normal n; see hitWorld */
function deflect(
  b: Ball, x: number, y: number, z: number, nx: number, ny: number, nz: number,
  chance: (cos: number, speed: number) => number,
): Contact {
  const speed = Math.hypot(b.vx, b.vy, b.vz);
  const vn = b.vx * nx + b.vy * ny + b.vz * nz; // negative: into the surface
  const cos = speed > 1e-6 ? Math.max(0, -vn / speed) : 1;
  const r = roll(b);
  if (b.bounces >= MAX_BOUNCES || r >= chance(cos, speed)) return 'break';
  const tx = b.vx - nx * vn;
  const ty = b.vy - ny * vn;
  const tz = b.vz - nz * vn;
  b.vx = tx * BOUNCE_FRICTION - nx * vn * BOUNCE_RESTITUTION;
  b.vy = ty * BOUNCE_FRICTION - ny * vn * BOUNCE_RESTITUTION;
  b.vz = tz * BOUNCE_FRICTION - nz * vn * BOUNCE_RESTITUTION;
  b.x = x + nx * 0.01;
  b.y = y + ny * 0.01;
  b.z = z + nz * 0.01;
  b.bounces++;
  return Math.hypot(b.vx, b.vy, b.vz) < BOUNCE_MIN_SPEED ? 'stop' : 'bounce';
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
  return Math.abs(x) > field.halfL + field.margin || Math.abs(z) > field.halfW + field.margin || y < -1 || y > 40;
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
  /** which bunker (an index into field.bunkers), or -1 for the ground */
  bunker: number;
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
  let hitI = -1;

  if (y0 > 0 && y1 <= 0) {
    best = y0 / (y0 - y1);
    ny = 1;
  }

  const bs = field.bunkers;
  const lenXZ = Math.hypot(dx, dz);
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    // early out: the path stays above it, or never comes near it seen from above
    const bound = field.bounds[i];
    if (y0 > bound.top && y1 > bound.top) continue;
    if (!segmentNearCircle(x0, z0, dx, dz, lenXZ, bound.x, bound.z, bound.r)) continue;
    if (b.kind === 'poly' || b.kind === 'log' || b.kind === 'taper' || b.kind === 'profile' || b.kind === 'orb') {
      const t =
        b.kind === 'poly' ? segPoly(x0, y0, z0, dx, dy, dz, i, b.h)
        : b.kind === 'taper' ? segHull(x0, y0, z0, dx, dy, dz, i)
        : b.kind === 'profile' ? segProfile(x0, y0, z0, dx, dy, dz, b)
        : b.kind === 'orb' ? segOrb(x0, y0, z0, dx, dy, dz, b)
        : segLog(x0, y0, z0, dx, dy, dz, b);
      if (t >= 0 && t < best) {
        best = t;
        nx = hitN[0];
        ny = hitN[1];
        nz = hitN[2];
        hitI = i;
      }
      continue;
    }
    if (b.kind === 'box') {
      const t = segBox(x0, y0, z0, dx, dy, dz, b.x - b.w / 2, 0, b.z - b.d / 2, b.x + b.w / 2, b.h, b.z + b.d / 2);
      if (t >= 0 && t < best) {
        best = t;
        nx = boxN[0];
        ny = boxN[1];
        nz = boxN[2];
        hitI = i;
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
            hitI = i;
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
          hitI = i;
        }
      }
    }
  }

  if (best === Infinity) return null;
  return { t: best, x: x0 + dx * best, y: y0 + dy * best, z: z0 + dz * best, nx, ny, nz, bunker: hitI };
}

const boxN = [0, 0, 0];
const hitN = [0, 0, 0];

/** does the segment (seen from above) pass within r of (cx, cz)? */
function segmentNearCircle(x0: number, z0: number, dx: number, dz: number, len: number, cx: number, cz: number, r: number): boolean {
  const fx = cx - x0;
  const fz = cz - z0;
  if (len < 1e-9) return fx * fx + fz * fz <= r * r;
  const t = clamp((fx * dx + fz * dz) / (len * len), 0, 1);
  const ex = fx - dx * t;
  const ez = fz - dz * t;
  return ex * ex + ez * ez <= r * r;
}

/**
 * Segment against an upright convex prism (bunker i, from y 0 to h): clip it against every face.
 * Returns entry t in 0..1 (normal in hitN), or -1 (no hit, or it started inside).
 */
function segPoly(x0: number, y0: number, z0: number, dx: number, dy: number, dz: number, i: number, h: number): number {
  const s = field.polys[i]!;
  let tmin = 0;
  let tmax = 1;
  let face = -2; // -2: none yet, -1: the top
  // top and bottom
  if (Math.abs(dy) < 1e-12) {
    if (y0 < 0 || y0 > h) return -1;
  } else {
    let t1 = (0 - y0) / dy;
    let t2 = (h - y0) / dy;
    const top = dy < 0; // coming down, we enter through the top
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) {
      tmin = t1;
      face = top ? -1 : -3; // -3: through the bottom (can't happen above ground, but be safe)
    }
    if (t2 < tmax) tmax = t2;
  }
  for (let e = 0; e < s.nx.length; e++) {
    const denom = s.nx[e] * dx + s.nz[e] * dz;
    const dist = s.nx[e] * x0 + s.nz[e] * z0 - s.off[e]; // > 0 outside this face
    if (Math.abs(denom) < 1e-12) {
      if (dist > 0) return -1;
      continue;
    }
    const t = -dist / denom;
    if (denom < 0) {
      // heading in through this face
      if (t > tmin) {
        tmin = t;
        face = e;
      }
    } else if (t < tmax) tmax = t;
    if (tmin > tmax) return -1;
  }
  if (face === -2) return -1; // started inside
  if (face === -1) {
    hitN[0] = 0;
    hitN[1] = 1;
    hitN[2] = 0;
  } else if (face === -3) {
    hitN[0] = 0;
    hitN[1] = -1;
    hitN[2] = 0;
  } else {
    hitN[0] = s.nx[face];
    hitN[1] = 0;
    hitN[2] = s.nz[face];
  }
  return tmin;
}

/**
 * Segment against a convex solid (a taper, bunker i): clip it against every plane round it.
 * Returns entry t in 0..1 (normal in hitN), or -1 (no hit, or it started inside).
 */
function segHull(x0: number, y0: number, z0: number, dx: number, dy: number, dz: number, i: number): number {
  const s = field.hulls[i]!;
  let tmin = 0;
  let tmax = 1;
  let face = -1;
  for (let k = 0; k < s.nx.length; k++) {
    const denom = s.nx[k] * dx + s.ny[k] * dy + s.nz[k] * dz;
    const dist = s.nx[k] * x0 + s.ny[k] * y0 + s.nz[k] * z0 - s.off[k]; // > 0 outside this plane
    if (Math.abs(denom) < 1e-12) {
      if (dist > 0) return -1;
      continue;
    }
    const t = -dist / denom;
    if (denom < 0) {
      if (t > tmin) {
        tmin = t;
        face = k;
      }
    } else if (t < tmax) tmax = t;
    if (tmin > tmax) return -1;
  }
  if (face < 0) return -1; // started inside
  hitN[0] = s.nx[face];
  hitN[1] = s.ny[face];
  hitN[2] = s.nz[face];
  return tmin;
}

/**
 * Segment against a wall with a shaped top (a profile bunker). Seen from the side it's the outline
 * under its top line; across, it's a slab d thick. Clip to the slab, then: either it comes in through a
 * face of the slab where the outline is, or it crosses the outline's edge (its top or an end) later on.
 * Returns entry t in 0..1 (normal in hitN), or -1.
 */
function segProfile(x0: number, y0: number, z0: number, dx: number, dy: number, dz: number, b: ProfileBunker): number {
  // work in (u = along the wall, v = across it, y)
  const alongX = b.axis === 'x';
  const u0 = alongX ? x0 - b.x : z0 - b.z;
  const v0 = alongX ? z0 - b.z : x0 - b.x;
  const du = alongX ? dx : dz;
  const dv = alongX ? dz : dx;
  const half = b.d / 2;
  let ta = 0;
  let tb = 1;
  if (Math.abs(dv) < 1e-12) {
    if (Math.abs(v0) > half) return -1;
  } else {
    let t1 = (-half - v0) / dv;
    let t2 = (half - v0) / dv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    ta = Math.max(ta, t1);
    tb = Math.min(tb, t2);
    if (ta > tb) return -1;
  }
  const inside = (t: number) => {
    const h = profileHeight(b, u0 + du * t);
    const y = y0 + dy * t;
    return h >= 0 && y >= 0 && y <= h;
  };
  if (inside(ta)) {
    if (ta <= 0) return -1; // started inside
    // in through the front or back face of the slab
    const sv = dv > 0 ? -1 : 1;
    hitN[0] = alongX ? 0 : sv;
    hitN[1] = 0;
    hitN[2] = alongX ? sv : 0;
    return ta;
  }
  // otherwise the first place (after ta, before tb) the path crosses the outline: the top line, or an end
  const l = b.line;
  let best = Infinity;
  let nu = 0;
  let ny = 0;
  const edge = (ua: number, ya: number, ub: number, yb: number) => {
    // solve u0 + du t = ua + eu s, y0 + dy t = ya + ey s
    const eu = ub - ua;
    const ey = yb - ya;
    const den = du * ey - dy * eu;
    if (Math.abs(den) < 1e-12) return;
    const fu = ua - u0;
    const fy = ya - y0;
    const t = (fu * ey - fy * eu) / den;
    const sp = (fu * dy - fy * du) / den;
    if (t < ta || t > tb || sp < 0 || sp > 1 || t >= best) return;
    // the outline runs up the first end, along the top, then down the last end: its outside is to the
    // left of each edge, (-ey, eu)
    const len = Math.hypot(eu, ey);
    const ou = -ey / len;
    const oy = eu / len;
    if (ou * du + oy * dy >= 0) return; // leaving, not entering
    best = t;
    nu = ou;
    ny = oy;
  };
  edge(l[0][0], 0, l[0][0], l[0][1]);
  for (let k = 1; k < l.length; k++) edge(l[k - 1][0], l[k - 1][1], l[k][0], l[k][1]);
  const last = l[l.length - 1];
  edge(last[0], last[1], last[0], 0);
  if (best === Infinity) return -1;
  hitN[0] = alongX ? nu : 0;
  hitN[1] = ny;
  hitN[2] = alongX ? 0 : nu;
  return best;
}

/** Segment against a log lying on the ground (a cylinder along x or z, centre r above the ground). */
function segLog(x0: number, y0: number, z0: number, dx: number, dy: number, dz: number, b: Extract<Bunker, { kind: 'log' }>): number {
  // work in (u = along the log, v = across it, y)
  const alongX = b.axis === 'x';
  const u0 = alongX ? x0 - b.x : z0 - b.z;
  const v0 = alongX ? z0 - b.z : x0 - b.x;
  const du = alongX ? dx : dz;
  const dv = alongX ? dz : dx;
  const w0 = y0 - b.r;
  const half = b.len / 2;
  const r2 = b.r * b.r;
  let best = -1;
  // the curved side
  const a = dv * dv + dy * dy;
  const c = v0 * v0 + w0 * w0 - r2;
  if (a > 1e-12 && c > 0) {
    const bb = 2 * (v0 * dv + w0 * dy);
    const disc = bb * bb - 4 * a * c;
    if (disc >= 0) {
      const t = (-bb - Math.sqrt(disc)) / (2 * a);
      const u = u0 + du * t;
      if (t >= 0 && t <= 1 && Math.abs(u) <= half) {
        best = t;
        const v = (v0 + dv * t) / b.r;
        const w = (w0 + dy * t) / b.r;
        hitN[0] = alongX ? 0 : v;
        hitN[1] = w;
        hitN[2] = alongX ? v : 0;
      }
    }
  }
  // the flat ends
  for (const end of [-half, half]) {
    if (Math.abs(du) < 1e-12) continue;
    const outside = end < 0 ? u0 < end : u0 > end;
    if (!outside) continue;
    const t = (end - u0) / du;
    if (t < 0 || t > 1 || (best >= 0 && t >= best)) continue;
    const v = v0 + dv * t;
    const w = w0 + dy * t;
    if (v * v + w * w > r2) continue;
    best = t;
    const s = end < 0 ? -1 : 1;
    hitN[0] = alongX ? s : 0;
    hitN[1] = 0;
    hitN[2] = alongX ? 0 : s;
  }
  return best;
}

/** Segment against an orb (a ball whose bottom may be under the ground). Entry t in 0..1 (normal in hitN), or -1. */
function segOrb(x0: number, y0: number, z0: number, dx: number, dy: number, dz: number, b: OrbBunker): number {
  const fx = x0 - b.x;
  const fy = y0 - orbY(b);
  const fz = z0 - b.z;
  const c = fx * fx + fy * fy + fz * fz - b.r * b.r;
  if (c <= 0) return -1; // started inside
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-12) return -1;
  const bb = 2 * (fx * dx + fy * dy + fz * dz);
  const disc = bb * bb - 4 * a * c;
  if (disc < 0) return -1;
  const t = (-bb - Math.sqrt(disc)) / (2 * a);
  if (t < 0 || t > 1 || y0 + dy * t < 0) return -1;
  hitN[0] = (fx + dx * t) / b.r;
  hitN[1] = (fy + dy * t) / b.r;
  hitN[2] = (fz + dz * t) / b.r;
  return t;
}

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
 * Returns how far along the path (0..1), or null.
 */
export function segmentHitsCapsule(
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  px: number, py: number, pz: number, height: number, radius = PLAYER_RADIUS,
): number | null {
  return segmentHitsSegment(x0, y0, z0, x1, y1, z1, px, py + radius, pz, px, py + Math.max(radius, height - radius), pz, radius);
}

/**
 * Does the ball's path touch this player? Standing or crouched, they're an upright capsule.
 * Lying down they're one along the ground: head a little ahead of where they stand (toward where
 * they face, yaw), legs out behind. Returns how far along the path (0..1), or null.
 */
export function segmentHitsPlayer(
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  px: number, py: number, pz: number, height: number, yaw: number, prone: boolean,
): number | null {
  if (!prone) return segmentHitsCapsule(x0, y0, z0, x1, y1, z1, px, py, pz, height);
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const y = py + PRONE_RADIUS;
  return segmentHitsSegment(
    x0, y0, z0, x1, y1, z1,
    px + fx * PRONE_HEAD, y, pz + fz * PRONE_HEAD,
    px - fx * PRONE_FEET, y, pz - fz * PRONE_FEET,
    PRONE_RADIUS,
  );
}

/**
 * Does the path (x0..z1) pass within `radius` (plus a ball) of the segment a→b? Returns how far
 * along the path the closest approach is (0..1), or null. Closest points between two segments
 * (Ericson, Real-Time Collision Detection 5.1.9).
 */
function segmentHitsSegment(
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number,
): number | null {
  const d1x = x1 - x0;
  const d1y = y1 - y0;
  const d1z = z1 - z0;
  const d2x = bx - ax;
  const d2y = by - ay;
  const d2z = bz - az;
  const rx = x0 - ax;
  const ry = y0 - ay;
  const rz = z0 - az;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
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
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
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
  const cx = x0 + d1x * s - (ax + d2x * t);
  const cy = y0 + d1y * s - (ay + d2y * t);
  const cz = z0 + d1z * s - (az + d2z * t);
  const rr = radius + BALL_RADIUS;
  return cx * cx + cy * cy + cz * cz <= rr * rr ? s : null;
}

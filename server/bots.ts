// Server-side bots. A bot is an ordinary player on the server with no socket: it gets snapshots
// and eliminations like everyone else, moves with the same stepMovement as humans, and its shots
// go through the same paintball simulation. Clients can't tell the difference.
//
//  - NavGrid: a walkability grid over the current map built from its bunker layout, with A* and path
//    smoothing, plus a list of cover spots tucked in next to each bunker. Build a new one per map.
//  - BotBrain: picks a cover spot toward the enemy, runs there, crouches, peeks and shoots at enemies
//    it can see, and ducks when paint flies past. It reacts after a delay and aims with some error,
//    so it can be beaten.

import { field, footprintDistance, topOf, type Bunker } from '../shared/field';
import {
  traceWorld, BALL_SPEED, GRAVITY, FIRE_INTERVAL, PLAYER_RADIUS, STAND_HEIGHT, CROUCH_HEIGHT, EYE_FROM_TOP, type MoveInput,
} from '../shared/sim';
import type { Team } from '../shared/protocol';

// ---- skill -------------------------------------------------------------------------------------

export interface BotSkill {
  /** seconds between first seeing an enemy and starting to shoot */
  reaction: number;
  /** standard deviation of aim error, radians */
  aimError: number;
  /** how fast it can turn, radians per second */
  turnRate: number;
  /** 0..1, how well it leads moving targets */
  lead: number;
  /** how far it can spot enemies, metres */
  sight: number;
}

export const SKILLS: Record<string, BotSkill> = {
  easy: { reaction: 0.75, aimError: 0.06, turnRate: 3, lead: 0.2, sight: 34 },
  normal: { reaction: 0.45, aimError: 0.035, turnRate: 5, lead: 0.6, sight: 42 },
  hard: { reaction: 0.25, aimError: 0.018, turnRate: 8, lead: 0.9, sight: 50 },
};

const NAMES = [
  'Pebble', 'Mango', 'Rook', 'Fern', 'Comet', 'Bramble', 'Kiwi', 'Sable', 'Tango', 'Quill', 'Nimbus', 'Clover',
  'Juniper', 'Pip', 'Marble', 'Thistle', 'Biscuit', 'Wren', 'Pickle', 'Echo',
];
export function botName(i: number): string {
  return `Bot ${NAMES[i % NAMES.length]}${i >= NAMES.length ? ` ${Math.floor(i / NAMES.length) + 1}` : ''}`;
}

// ---- navigation --------------------------------------------------------------------------------

const CELL = 0.5;
const CLEARANCE = PLAYER_RADIUS + 0.15;

export interface CoverSpot {
  x: number;
  z: number;
  /** the bunker it hides behind */
  bunker: Bunker;
}


export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  private readonly x0: number;
  private readonly z0: number;
  private readonly open: Uint8Array;
  readonly cover: CoverSpot[] = [];

  constructor() {
    const ex = field.halfL + field.margin - 0.4;
    const ez = field.halfW + field.margin - 0.4;
    this.x0 = -ex;
    this.z0 = -ez;
    this.cols = Math.floor((2 * ex) / CELL) + 1;
    this.rows = Math.floor((2 * ez) / CELL) + 1;
    this.open = new Uint8Array(this.cols * this.rows);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const x = this.x0 + c * CELL;
        const z = this.z0 + r * CELL;
        let open = 1;
        for (let i = 0; i < field.bunkers.length && open; i++) {
          const bd = field.bounds[i];
          if (Math.abs(x - bd.x) > bd.r + CLEARANCE || Math.abs(z - bd.z) > bd.r + CLEARANCE) continue;
          if (footprintDistance(field.bunkers[i], x, z, i) <= CLEARANCE) open = 0;
        }
        this.open[r * this.cols + c] = open;
      }
    }
    // cover: points hugging each bunker, all the way round; whether a spot is safe depends on where the enemy is
    for (const b of field.bunkers) {
      if (topOf(b) < 1.15) continue; // too low to hide behind
      // thin trees and barrels only need a few spots round them
      const n = b.kind === 'can' && b.r < 0.5 ? 8 : 16;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        let x: number;
        let z: number;
        if (b.kind === 'can') {
          x = b.x + Math.cos(a) * (b.r + CLEARANCE + 0.12);
          z = b.z + Math.sin(a) * (b.r + CLEARANCE + 0.12);
        } else {
          // walk out from the centre until we're just clear of the box
          const dx = Math.cos(a);
          const dz = Math.sin(a);
          let t = 0;
          while (footprintDistance(b, b.x + dx * t, b.z + dz * t) < CLEARANCE + 0.12) t += 0.05;
          x = b.x + dx * t;
          z = b.z + dz * t;
        }
        if (this.walkable(x, z)) this.cover.push({ x, z, bunker: b });
      }
    }
  }

  private cellOf(x: number, z: number): [number, number] {
    const c = Math.round((x - this.x0) / CELL);
    const r = Math.round((z - this.z0) / CELL);
    return [Math.max(0, Math.min(this.cols - 1, c)), Math.max(0, Math.min(this.rows - 1, r))];
  }

  walkable(x: number, z: number): boolean {
    const c = Math.round((x - this.x0) / CELL);
    const r = Math.round((z - this.z0) / CELL);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return false;
    return this.open[r * this.cols + c] === 1;
  }

  /** straight walk from a to b stays on open cells */
  clearLine(ax: number, az: number, bx: number, bz: number): boolean {
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) / (CELL * 0.5));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (!this.walkable(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
    }
    return true;
  }

  /** A* over the grid (8-way), then string-pulled into as few straight legs as possible */
  findPath(ax: number, az: number, bx: number, bz: number): { x: number; z: number }[] | null {
    if (this.clearLine(ax, az, bx, bz)) return [{ x: bx, z: bz }];
    const [sc, sr] = this.nearestOpen(...this.cellOf(ax, az));
    const [gc, gr] = this.nearestOpen(...this.cellOf(bx, bz));
    const N = this.cols * this.rows;
    const start = sr * this.cols + sc;
    const goal = gr * this.cols + gc;
    const g = new Float32Array(N).fill(Infinity);
    const from = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const heap = new MinHeap();
    const h = (i: number) => {
      const dc = Math.abs((i % this.cols) - gc);
      const dr = Math.abs(Math.floor(i / this.cols) - gr);
      return Math.max(dc, dr) + 0.414 * Math.min(dc, dr);
    };
    g[start] = 0;
    heap.push(start, h(start));
    while (heap.size) {
      const cur = heap.pop();
      if (cur === goal) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cc = cur % this.cols;
      const cr = Math.floor(cur / this.cols);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dc && !dr) continue;
          const nc = cc + dc;
          const nr = cr + dr;
          if (nc < 0 || nr < 0 || nc >= this.cols || nr >= this.rows) continue;
          const ni = nr * this.cols + nc;
          if (!this.open[ni] || closed[ni]) continue;
          // no cutting corners past a blocked cell
          if (dc && dr && (!this.open[cr * this.cols + nc] || !this.open[nr * this.cols + cc])) continue;
          const ng = g[cur] + (dc && dr ? 1.414 : 1);
          if (ng < g[ni]) {
            g[ni] = ng;
            from[ni] = cur;
            heap.push(ni, ng + h(ni));
          }
        }
      }
    }
    if (from[goal] === -1 && goal !== start) return null;
    const cells: { x: number; z: number }[] = [];
    for (let i = goal; i !== -1 && i !== start; i = from[i]) {
      cells.push({ x: this.x0 + (i % this.cols) * CELL, z: this.z0 + Math.floor(i / this.cols) * CELL });
    }
    cells.reverse();
    cells[cells.length - 1] = { x: bx, z: bz };
    // string pulling: skip any waypoint we can walk straight past
    const out: { x: number; z: number }[] = [];
    let px = ax;
    let pz = az;
    let i = 0;
    while (i < cells.length) {
      let j = cells.length - 1;
      while (j > i && !this.clearLine(px, pz, cells[j].x, cells[j].z)) j--;
      out.push(cells[j]);
      px = cells[j].x;
      pz = cells[j].z;
      i = j + 1;
    }
    return out;
  }

  private nearestOpen(c: number, r: number): [number, number] {
    if (this.open[r * this.cols + c]) return [c, r];
    for (let rad = 1; rad < 8; rad++) {
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          const nc = c + dc;
          const nr = r + dr;
          if (nc < 0 || nr < 0 || nc >= this.cols || nr >= this.rows) continue;
          if (this.open[nr * this.cols + nc]) return [nc, nr];
        }
      }
    }
    return [c, r];
  }
}

class MinHeap {
  private items: number[] = [];
  private keys: number[] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: number, key: number): void {
    const a = this.items;
    const k = this.keys;
    a.push(item);
    k.push(key);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [a[p], a[i]] = [a[i], a[p]];
      [k[p], k[i]] = [k[i], k[p]];
      i = p;
    }
  }
  pop(): number {
    const a = this.items;
    const k = this.keys;
    const top = a[0];
    const lastA = a.pop()!;
    const lastK = k.pop()!;
    if (a.length) {
      a[0] = lastA;
      k[0] = lastK;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && k[l] < k[m]) m = l;
        if (r < a.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        [k[m], k[i]] = [k[i], k[m]];
        i = m;
      }
    }
    return top;
  }
}

// ---- brain -------------------------------------------------------------------------------------

/** what a bot knows about one other player */
export interface Seen {
  id: number;
  team: Team;
  x: number;
  y: number;
  z: number;
  crouch: boolean;
  alive: boolean;
}

export interface BotSelf {
  id: number;
  team: Team;
  x: number;
  y: number;
  z: number;
  height: number;
  /** horizontal speed, m/s */
  speed: number;
}

/** per-shot scatter, the same a human's marker gets (see SPREAD in src/main.ts) */
const SHOT_SPREAD = 0.012;
/** extra scatter per m/s of movement: shooting on the run is much less accurate */
const MOVING_SPREAD = 0.006;

export interface BotOutput {
  move: MoveInput;
  yaw: number;
  pitch: number;
  /** fire this tick, in this direction (unit vector) */
  fire: [number, number, number] | null;
}

type Mode = 'advance' | 'hold';

const gauss = () => {
  // Box–Muller, clamped so the odd wild sample doesn't send a shot sideways
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.max(-2.5, Math.min(2.5, Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)));
};
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const approach = (cur: number, target: number, maxStep: number) => {
  const d = wrap(target - cur);
  return cur + Math.max(-maxStep, Math.min(maxStep, d));
};

export class BotBrain {
  yaw = 0;
  pitch = 0;
  private mode: Mode = 'advance';
  private path: { x: number; z: number }[] = [];
  private spot: CoverSpot | null = null;
  private holdUntil = 0;
  private suppressedUntil = 0;
  private targetId = -1;
  private targetSince = 0;
  private targetSeenAt = -Infinity;
  private nextShotAt = 0;
  private aimOffset = { yaw: 0, pitch: 0 };
  private burstLeft = 0;
  private nextBurstAt = 0;
  private lastProgress = { t: 0, x: 0, z: 0 };
  private peekUntil = 0;
  private nextPeekAt = 0;
  /** heading for cover because we were caught in the open */
  private takingCover = false;
  private lastKnownEnemy: { x: number; z: number } | null = null;
  private strafe = 0;
  private strafeUntil = 0;
  private lastSeenPos = new Map<number, { x: number; z: number; t: number; vx: number; vz: number }>();
  private readonly out: BotOutput = {
    move: { forward: 0, right: 0, jump: false, sprint: false, crouch: false, yaw: 0 },
    yaw: 0,
    pitch: 0,
    fire: null,
  };

  constructor(
    private nav: NavGrid,
    private skill: BotSkill,
    /** cover spots teammates have already picked, shared across a team */
    private claimed: Map<CoverSpot, number>,
  ) {}

  /** new point: forget everything */
  reset(yaw: number): void {
    this.yaw = yaw;
    this.pitch = 0;
    this.mode = 'advance';
    this.path = [];
    this.releaseSpot();
    this.holdUntil = 0;
    this.suppressedUntil = 0;
    this.targetId = -1;
    this.burstLeft = 0;
    this.lastKnownEnemy = null;
    this.lastSeenPos.clear();
    this.takingCover = false;
  }

  /** paint flew close by */
  underFire(now: number): void {
    this.suppressedUntil = Math.max(this.suppressedUntil, now + 0.8 + Math.random() * 0.8);
  }

  update(now: number, dt: number, me: BotSelf, others: Iterable<Seen>, canShoot: boolean): BotOutput {
    const o = this.out;
    o.fire = null;
    const eyeY = me.y + me.height - EYE_FROM_TOP;
    // behind cover we "know" what's over the top (as if we'd glanced), so spot from standing height
    const spotY = me.y + (this.mode === 'hold' ? STAND_HEIGHT : me.height) - EYE_FROM_TOP;

    // --- look for enemies ---
    let target: Seen | null = null;
    let targetDist = Infinity;
    let targetPoint = { x: 0, y: 0, z: 0 };
    for (const s of others) {
      if (!s.alive || s.team === me.team) continue;
      const d = Math.hypot(s.x - me.x, s.z - me.z);
      if (d > this.skill.sight) continue;
      const h = s.crouch ? CROUCH_HEIGHT : STAND_HEIGHT;
      // try the chest, then the head (a crouched player's head can poke over a bunker)
      for (const y of [s.y + h * 0.6, s.y + h - 0.15]) {
        if (traceWorld(me.x, spotY, me.z, s.x, y, s.z)) continue;
        // track their velocity so we can lead them
        const prev = this.lastSeenPos.get(s.id);
        const vx = prev && now - prev.t < 0.5 ? (s.x - prev.x) / Math.max(1e-3, now - prev.t) : 0;
        const vz = prev && now - prev.t < 0.5 ? (s.z - prev.z) / Math.max(1e-3, now - prev.t) : 0;
        this.lastSeenPos.set(s.id, { x: s.x, z: s.z, t: now, vx: prev ? prev.vx * 0.7 + vx * 0.3 : 0, vz: prev ? prev.vz * 0.7 + vz * 0.3 : 0 });
        // stick with the current target unless someone is much closer
        const score = d * (s.id === this.targetId ? 0.6 : 1);
        if (score < targetDist) {
          targetDist = score;
          target = s;
          targetPoint = { x: s.x, y, z: s.z };
        }
        break;
      }
    }

    if (target) {
      // a new target (or one we lost sight of for a while) has to be reacted to again
      if (target.id !== this.targetId || now - this.targetSeenAt > 0.6) {
        this.targetId = target.id;
        this.targetSince = now;
        this.newAimError();
      }
      this.targetSeenAt = now;
      this.lastKnownEnemy = { x: target.x, z: target.z };
    }

    // --- decide where to be ---
    const suppressed = now < this.suppressedUntil;
    if (this.mode === 'hold' && now >= this.holdUntil && !suppressed && !target) this.mode = 'advance';
    // caught in the open with someone shooting at us: get behind the nearest thing that hides us from them
    if (this.mode === 'advance' && target && !this.takingCover && (suppressed || targetDist < 14)) this.seekCover(now, me, target);
    if (this.mode === 'advance' && !this.path.length) this.pickSpot(now, me);

    // --- movement ---
    let wantX = 0;
    let wantZ = 0;
    let sprint = false;
    let crouch = false;
    if (this.mode === 'advance' && this.path.length && (this.takingCover || !(target && targetDist < 14))) {
      const wp = this.path[0];
      const dx = wp.x - me.x;
      const dz = wp.z - me.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.35) {
        this.path.shift();
        if (!this.path.length) {
          this.mode = 'hold';
          this.takingCover = false;
          this.holdUntil = now + 1.5 + Math.random() * 3;
        }
      } else {
        wantX = dx / d;
        wantZ = dz / d;
        sprint = !target || this.takingCover;
      }
      // stuck on something? try again from here
      if (Math.hypot(me.x - this.lastProgress.x, me.z - this.lastProgress.z) > 0.5) {
        this.lastProgress = { t: now, x: me.x, z: me.z };
      } else if (now - this.lastProgress.t > 1.5) {
        this.path = [];
        this.releaseSpot();
        this.lastProgress = { t: now, x: me.x, z: me.z };
      }
    } else if (target) {
      // engaging in the open: shuffle side to side so we're not a sitting duck
      if (this.mode !== 'hold') {
        if (now >= this.strafeUntil) {
          this.strafe = Math.random() < 0.5 ? -1 : 1;
          this.strafeUntil = now + 0.5 + Math.random() * 0.8;
        }
        const ty = Math.atan2(-(target.x - me.x), -(target.z - me.z));
        wantX = Math.cos(ty) * this.strafe * 0.6;
        wantZ = -Math.sin(ty) * this.strafe * 0.6;
        if (!this.nav.walkable(me.x + wantX, me.z + wantZ)) this.strafe = -this.strafe;
      }
    }
    if (this.mode === 'hold') {
      // behind cover: stay down unless we're peeking to shoot
      // pop up for a second or so to shoot, then stay down a moment before the next peek
      if (target && !suppressed && now >= this.peekUntil && now >= this.nextPeekAt) {
        this.peekUntil = now + 0.9 + Math.random() * 0.8;
        this.nextPeekAt = this.peekUntil + 0.6 + Math.random() * 0.9;
      }
      const peeking = target !== null && now < this.peekUntil;
      crouch = suppressed || !peeking;
    }

    // --- aim ---
    let wantYaw = this.yaw;
    let wantPitch = 0;
    if (target) {
      const seen = this.lastSeenPos.get(target.id);
      const dist = Math.hypot(targetPoint.x - me.x, targetPoint.z - me.z);
      const flight = (dist / BALL_SPEED) * 1.08;
      const lx = targetPoint.x + (seen?.vx ?? 0) * flight * this.skill.lead;
      const lz = targetPoint.z + (seen?.vz ?? 0) * flight * this.skill.lead;
      const drop = 0.5 * GRAVITY * flight * flight;
      const ax = lx - me.x;
      const az = lz - me.z;
      const ay = targetPoint.y + drop - eyeY;
      wantYaw = Math.atan2(-ax, -az) + this.aimOffset.yaw;
      wantPitch = Math.atan2(ay, Math.hypot(ax, az)) + this.aimOffset.pitch;
    } else if (wantX || wantZ) {
      wantYaw = Math.atan2(-wantX, -wantZ);
    } else if (this.lastKnownEnemy) {
      wantYaw = Math.atan2(-(this.lastKnownEnemy.x - me.x), -(this.lastKnownEnemy.z - me.z));
    } else {
      wantYaw = me.team === 0 ? -Math.PI / 2 : Math.PI / 2; // face the other end
    }
    this.yaw = approach(this.yaw, wantYaw, this.skill.turnRate * dt);
    this.pitch += Math.max(-this.skill.turnRate * dt, Math.min(this.skill.turnRate * dt, wantPitch - this.pitch));

    // --- shoot ---
    const aimed = Math.abs(wrap(wantYaw - this.yaw)) < 0.05 && Math.abs(wantPitch - this.pitch) < 0.05;
    // in cover, wait until we're fully stood up so the shot clears the bunker
    const exposed = this.mode !== 'hold' || (!crouch && me.height > STAND_HEIGHT - 0.1);
    if (target && canShoot && exposed && aimed && now - this.targetSince >= this.skill.reaction && !suppressed) {
      if (this.burstLeft <= 0 && now >= this.nextBurstAt) this.burstLeft = 3 + Math.floor(Math.random() * 6);
      if (this.burstLeft > 0 && now >= this.nextShotAt) {
        this.nextShotAt = now + FIRE_INTERVAL;
        this.burstLeft--;
        if (this.burstLeft === 0) {
          this.nextBurstAt = now + 0.25 + Math.random() * 0.6;
          this.newAimError(); // re-aim between bursts, a little better each time we keep tracking
        }
        const cp = Math.cos(this.pitch);
        const spread = SHOT_SPREAD + MOVING_SPREAD * me.speed;
        const j = () => (Math.random() - 0.5) * 2 * spread;
        const fx = -Math.sin(this.yaw) * cp + j();
        const fy = Math.sin(this.pitch) + j();
        const fz = -Math.cos(this.yaw) * cp + j();
        const fl = Math.hypot(fx, fy, fz);
        o.fire = [fx / fl, fy / fl, fz / fl];
      }
    } else if (!target) {
      this.burstLeft = 0;
    }

    // world-space wish direction → forward/right relative to where we're looking
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    o.move.forward = wantX * -s + wantZ * -c;
    o.move.right = wantX * c + wantZ * -s;
    o.move.sprint = sprint && !crouch;
    o.move.crouch = crouch;
    o.move.jump = false;
    o.move.yaw = this.yaw;
    o.yaw = this.yaw;
    o.pitch = this.pitch;
    return o;
  }

  private newAimError(): void {
    const e = this.skill.aimError;
    this.aimOffset.yaw = gauss() * e;
    this.aimOffset.pitch = gauss() * e * 0.6;
  }

  private releaseSpot(): void {
    if (this.spot && this.claimed.get(this.spot) === this.id()) this.claimed.delete(this.spot);
    this.spot = null;
  }

  private myId = Math.random();
  private id(): number {
    return this.myId;
  }

  /** nearest spot within a few metres that a bunker hides from `threat` */
  private seekCover(now: number, me: BotSelf, threat: Seen): void {
    let best: CoverSpot | null = null;
    let bestScore = -Infinity;
    for (const spot of this.nav.cover) {
      const owner = this.claimed.get(spot);
      if (owner !== undefined && owner !== this.id()) continue;
      const dist = Math.hypot(spot.x - me.x, spot.z - me.z);
      if (dist > 7) continue;
      const hidden = traceWorld(threat.x, threat.y + STAND_HEIGHT - EYE_FROM_TOP, threat.z, spot.x, CROUCH_HEIGHT - 0.1, spot.z) !== null;
      if (!hidden) continue;
      const score = -dist + Math.random();
      if (score > bestScore) {
        bestScore = score;
        best = spot;
      }
    }
    if (!best) return;
    const path = this.nav.findPath(me.x, me.z, best.x, best.z);
    if (!path) return;
    this.releaseSpot();
    this.spot = best;
    this.claimed.set(best, this.id());
    this.path = path;
    this.takingCover = true;
    this.lastProgress = { t: now, x: me.x, z: me.z };
  }

  /** next cover spot: further toward the enemy, hidden from where we last saw them, not taken */
  private pickSpot(now: number, me: BotSelf): void {
    const dirX = me.team === 0 ? 1 : -1; // which way is forward
    const enemy = this.lastKnownEnemy ?? { x: dirX * field.halfL, z: 0 };
    let best: CoverSpot | null = null;
    let bestScore = -Infinity;
    for (const spot of this.nav.cover) {
      const owner = this.claimed.get(spot);
      if (owner !== undefined && owner !== this.id()) continue;
      const progress = (spot.x - me.x) * dirX;
      const dist = Math.hypot(spot.x - me.x, spot.z - me.z);
      if (dist < 2 || dist > 16 || progress < -1) continue;
      // hidden: a crouched head at the spot can't be seen from where the enemy is
      const hidden = traceWorld(enemy.x, STAND_HEIGHT - EYE_FROM_TOP, enemy.z, spot.x, CROUCH_HEIGHT - 0.1, spot.z) !== null;
      const tooDeep = spot.x * dirX > field.halfL * 0.55; // don't run into their start box
      const score = progress * 1.2 - dist * 0.35 + (hidden ? 6 : 0) - (tooDeep ? 8 : 0) + Math.random() * 3;
      if (score > bestScore) {
        bestScore = score;
        best = spot;
      }
    }
    if (!best) {
      this.mode = 'hold';
      this.holdUntil = now + 2;
      return;
    }
    const path = this.nav.findPath(me.x, me.z, best.x, best.z);
    if (!path) {
      this.mode = 'hold';
      this.holdUntil = now + 1;
      return;
    }
    this.releaseSpot();
    this.spot = best;
    this.claimed.set(best, this.id());
    this.path = path;
    this.lastProgress = { t: now, x: me.x, z: me.z };
  }
}

// Every paintball in flight, drawn with three InstancedMeshes (a head, a fading streak behind it and
// a faint glow round it), so hundreds of balls cost three draw calls. Uses the same flight, collision and bounce code as the
// server, so what you see matches what the server decides.
//
// A real paintball is a 17 mm dot moving at 85 m/s: drawn to scale you'd never see one coming. So
// each ball gets a streak along its flight, never shrinks below a few pixels on screen, and glows a
// little: a ball coming straight at you is end-on to its streak, so the glow is what you see.

import * as THREE from 'three';
import {
  advanceBall, traceWorld, segmentHitsPlayer, isOutOfBounds, hitWorld, ballSeed,
  BALL_LIFETIME, type Ball, type WorldHit,
} from '../shared/sim';
import type { V3 } from '../shared/protocol';

export interface Target {
  id: number;
  team: number;
  x: number;
  y: number;
  z: number;
  height: number;
  /** which way they face, and lying down (then they're hit along the ground) */
  yaw: number;
  prone: boolean;
  alive: boolean;
}

export interface LiveBall extends Ball {
  active: boolean;
  /** fired by this browser's player */
  local: boolean;
  color: number;
  /** already whizzed past our ears */
  whizzed: boolean;
}

export interface BallEvents {
  /** broke on the ground or a bunker (w.bunker) */
  onWorld(ball: LiveBall, w: WorldHit): void;
  /** bounced off without breaking; stopped: too slow to carry on */
  onBounce(ball: LiveBall, w: WorldHit, stopped: boolean): void;
  onTarget(ball: LiveBall, target: Target, x: number, y: number, z: number): void;
  /** someone else's ball passed within NEAR_MISS of the listener (closest point x, y, z) */
  onNearMiss(ball: LiveBall, x: number, y: number, z: number, distance: number): void;
}

const MAX = 600;
/** the head's radius at close range (3× a real ball, so it reads at all) */
const HEAD = 0.022;
/** never smaller than this many radians: about 3 px across on a 1080p screen */
const MIN_ANGLE = 0.0032;
/** the glow, as a multiple of the head */
const GLOW = 2.6;
/** streak length per m/s of speed, and the longest it gets */
const STREAK_PER_SPEED = 0.0055;
const STREAK_MAX = 0.5;
const NEAR_MISS = 1.6;

export class Paintballs {
  private heads: THREE.InstancedMesh;
  private tails: THREE.InstancedMesh;
  private glows: THREE.InstancedMesh;
  private pool: LiveBall[] = [];
  private next = 0;
  private m = new THREE.Matrix4();
  private c = new THREE.Color();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private static readonly Z = new THREE.Vector3(0, 0, 1);

  constructor(scene: THREE.Scene) {
    this.heads = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial(), MAX);
    // the streak: a cone from the head's full width down to a point, one unit long behind it (+z)
    const cone = new THREE.ConeGeometry(1, 1, 8, 1, true);
    cone.translate(0, 0.5, 0); // base (full width) at y = 0, point at y = 1
    cone.rotateX(Math.PI / 2); // y → z
    this.tails = new THREE.InstancedMesh(
      cone,
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }),
      MAX,
    );
    this.glows = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 10, 8),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending }),
      MAX,
    );
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      for (let i = 0; i < MAX; i++) mesh.setColorAt(i, this.c.setHex(0xffffff));
      mesh.count = 0;
      scene.add(mesh);
    }
    for (let i = 0; i < MAX; i++) {
      this.pool.push({
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, owner: -1, team: 0, seed: 0, bounces: 0,
        active: false, local: false, color: 0xffffff, whizzed: false,
      });
    }
  }

  private get meshes(): THREE.InstancedMesh[] {
    return [this.heads, this.tails, this.glows];
  }

  /** drop every ball in flight (the field changed) */
  clear(): void {
    for (const b of this.pool) b.active = false;
  }

  spawn(o: V3, v: V3, owner: number, team: number, color: number, local: boolean): void {
    const b = this.pool[this.next];
    this.next = (this.next + 1) % MAX;
    Object.assign(b, {
      x: o[0], y: o[1], z: o[2], vx: v[0], vy: v[1], vz: v[2], age: 0, owner, team, color, local, active: true,
      seed: ballSeed(o), bounces: 0, whizzed: local,
    });
  }

  /**
   * One fixed step (BALL_DT, like the server). ear: where we listen from, for near misses (null:
   * nobody to whizz past, e.g. in the menu).
   */
  update(dt: number, targets: readonly Target[], ev: BallEvents, ear: THREE.Vector3 | null): void {
    for (const b of this.pool) {
      if (!b.active) continue;
      const x0 = b.x;
      const y0 = b.y;
      const z0 = b.z;
      advanceBall(b, dt);
      const w = traceWorld(x0, y0, z0, b.x, b.y, b.z);
      let bestT = w ? w.t : Infinity;
      let hit: Target | null = null;
      for (const t of targets) {
        if (!t.alive || t.team === b.team || t.id === b.owner) continue;
        const s = segmentHitsPlayer(x0, y0, z0, b.x, b.y, b.z, t.x, t.y, t.z, t.height, t.yaw, t.prone);
        if (s !== null && s < bestT) {
          bestT = s;
          hit = t;
        }
      }
      if (ear && !b.whizzed) this.nearMiss(b, x0, y0, z0, Math.min(1, bestT), ear, ev);
      if (hit) {
        b.active = false;
        ev.onTarget(b, hit, x0 + (b.x - x0) * bestT, y0 + (b.y - y0) * bestT, z0 + (b.z - z0) * bestT);
      } else if (w) {
        const c = hitWorld(b, w);
        if (c === 'break') {
          b.active = false;
          ev.onWorld(b, w);
        } else {
          if (c === 'stop') b.active = false;
          ev.onBounce(b, w, c === 'stop');
        }
      } else if (b.age > BALL_LIFETIME || isOutOfBounds(b.x, b.y, b.z)) {
        b.active = false;
      }
    }
  }

  /** closest point of this step's path (up to `upTo` of it) to the ear */
  private nearMiss(b: LiveBall, x0: number, y0: number, z0: number, upTo: number, ear: THREE.Vector3, ev: BallEvents): void {
    const dx = (b.x - x0) * upTo;
    const dy = (b.y - y0) * upTo;
    const dz = (b.z - z0) * upTo;
    const len2 = dx * dx + dy * dy + dz * dz;
    if (len2 < 1e-9) return;
    const s = Math.max(0, Math.min(1, ((ear.x - x0) * dx + (ear.y - y0) * dy + (ear.z - z0) * dz) / len2));
    const cx = x0 + dx * s;
    const cy = y0 + dy * s;
    const cz = z0 + dz * s;
    const d = Math.hypot(cx - ear.x, cy - ear.y, cz - ear.z);
    if (d < NEAR_MISS) {
      b.whizzed = true;
      ev.onNearMiss(b, cx, cy, cz, d);
    }
  }

  /** copy live balls into the instance buffers, once per rendered frame */
  sync(camera: THREE.Camera): void {
    const eye = camera.position;
    let n = 0;
    for (const b of this.pool) {
      if (!b.active) continue;
      const r = Math.max(HEAD, Math.hypot(b.x - eye.x, b.y - eye.y, b.z - eye.z) * MIN_ANGLE);
      this.p.set(b.x, b.y, b.z);
      this.heads.setMatrixAt(n, this.m.compose(this.p, this.q.identity(), this.s.setScalar(r)));
      this.heads.setColorAt(n, this.c.setHex(b.color));
      this.glows.setMatrixAt(n, this.m.compose(this.p, this.q, this.s.setScalar(r * GLOW)));
      this.glows.setColorAt(n, this.c);
      // the streak points back along the flight, no longer than the ball has flown (not out of the barrel)
      const speed = Math.hypot(b.vx, b.vy, b.vz);
      const len = Math.min(STREAK_MAX, speed * STREAK_PER_SPEED, speed * b.age);
      if (speed > 1e-3) {
        this.dir.set(-b.vx / speed, -b.vy / speed, -b.vz / speed);
        this.q.setFromUnitVectors(Paintballs.Z, this.dir);
      }
      this.tails.setMatrixAt(n, this.m.compose(this.p, this.q, this.s.set(r, r, Math.max(len, 1e-3))));
      this.tails.setColorAt(n, this.c);
      n++;
    }
    for (const mesh of this.meshes) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
}

// Every paintball in flight, drawn with three InstancedMeshes (a head, a fading streak behind it and
// a faint glow round it), so hundreds of balls cost three draw calls. Uses the same flight, collision and bounce code as the
// server, so what you see matches what the server decides.
//
// A real paintball is a 17 mm dot moving at 85 m/s: drawn to scale you'd never see one coming. So
// each ball gets a streak along its flight, never shrinks below a few pixels on screen, and glows a
// little: a ball coming straight at you is end-on to its streak, so the glow is what you see.
//
// On the moon (theme.shots 'moon') the same balls are drawn as moonballs: a bigger cratered head, a
// bright glow in the team colour, a long comet tail that fades out, and sparkly dust left behind.
// Only the look changes: they fly and hit exactly the same, and the server still decides every hit.

import * as THREE from 'three';
import {
  advanceBall, traceWorld, segmentHitsPlayer, isOutOfBounds, hitWorld, hitPlayer, ballSeed,
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
  /** skipped off a player without breaking (they play on); stopped: too slow to carry on */
  onPlayerBounce(ball: LiveBall, target: Target, x: number, y: number, z: number, stopped: boolean): void;
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

/** how each kind of shot is drawn */
interface ShotLook {
  head: number;
  glow: number;
  streakPerSpeed: number;
  streakMax: number;
  /** how much of the team colour is in the head (the rest is white) */
  headTint: number;
  /** comet dust left behind per second of flight */
  dust: number;
  /** the streak's width at the head, as a multiple of the head */
  tailWidth: number;
}
const PAINT: ShotLook = { head: HEAD, glow: GLOW, streakPerSpeed: STREAK_PER_SPEED, streakMax: STREAK_MAX, headTint: 1, dust: 0, tailWidth: 1 };
const MOON: ShotLook = { head: 0.05, glow: 3.4, streakPerSpeed: 0.032, streakMax: 2.8, headTint: 0.3, dust: 70, tailWidth: 1.8 };
const DUST = 3000;
const DUST_LIFE = 0.55;

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
  private look = PAINT;
  private paintMats: { head: THREE.Material; tail: THREE.Material };
  private moonMats: { head: THREE.Material; tail: THREE.Material } | null = null;
  private white = new THREE.Color(0xffffff);
  // comet dust: points that fade to nothing (additive, so dark is invisible)
  private dust: THREE.Points;
  private dustPos = new Float32Array(DUST * 3).fill(-999);
  private dustCol = new Float32Array(DUST * 3);
  private dustBase = new Float32Array(DUST * 3);
  private dustVel = new Float32Array(DUST * 3);
  private dustLife = new Float32Array(DUST);
  private nextDust = 0;
  private lastSync = 0;

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
    this.paintMats = { head: this.heads.material as THREE.Material, tail: this.tails.material as THREE.Material };
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(this.dustPos, 3).setUsage(THREE.DynamicDrawUsage));
    dg.setAttribute('color', new THREE.BufferAttribute(this.dustCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.dust = new THREE.Points(dg, new THREE.PointsMaterial({
      size: 0.11, map: softDot(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.dust.frustumCulled = false;
    this.dust.visible = false;
    scene.add(this.dust);
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
    this.dustLife.fill(0);
    this.dustPos.fill(-999);
  }

  /** draw shots as paintballs, or as moonballs with comet tails */
  setStyle(style: 'paint' | 'moon'): void {
    this.look = style === 'moon' ? MOON : PAINT;
    if (style === 'moon' && !this.moonMats) {
      this.moonMats = {
        head: new THREE.MeshBasicMaterial({ map: moonTexture() }),
        tail: new THREE.MeshBasicMaterial({
          alphaMap: fadeTexture(), transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
        }),
      };
    }
    const mats = style === 'moon' ? this.moonMats! : this.paintMats;
    this.heads.material = mats.head;
    this.tails.material = mats.tail;
    this.dust.visible = style === 'moon';
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
      if (this.look.dust && Math.random() < this.look.dust * dt) this.puff(b);
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
        const hx = x0 + (b.x - x0) * bestT;
        const hy = y0 + (b.y - y0) * bestT;
        const hz = z0 + (b.z - z0) * bestT;
        const c = hitPlayer(b, hx, hy, hz, hit.x, hit.y, hit.z, hit.height, hit.yaw, hit.prone);
        if (c === 'break') {
          b.active = false;
          ev.onTarget(b, hit, hx, hy, hz);
        } else {
          if (c === 'stop') b.active = false;
          ev.onPlayerBounce(b, hit, hx, hy, hz, c === 'stop');
        }
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

  /** a speck of comet dust where ball b is, drifting a little and fading */
  private puff(b: LiveBall): void {
    const i = this.nextDust;
    this.nextDust = (this.nextDust + 1) % DUST;
    const j = i * 3;
    this.dustPos[j] = b.x + (Math.random() - 0.5) * 0.06;
    this.dustPos[j + 1] = b.y + (Math.random() - 0.5) * 0.06;
    this.dustPos[j + 2] = b.z + (Math.random() - 0.5) * 0.06;
    this.dustVel[j] = b.vx * 0.04 + (Math.random() - 0.5) * 0.5;
    this.dustVel[j + 1] = b.vy * 0.04 + (Math.random() - 0.5) * 0.5;
    this.dustVel[j + 2] = b.vz * 0.04 + (Math.random() - 0.5) * 0.5;
    // mostly white, some in the team colour
    this.c.setHex(b.color).lerp(this.white, Math.random() < 0.5 ? 0.75 : 0.2);
    this.dustBase[j] = this.c.r;
    this.dustBase[j + 1] = this.c.g;
    this.dustBase[j + 2] = this.c.b;
    this.dustLife[i] = DUST_LIFE * (0.6 + Math.random() * 0.4);
  }

  private moveDust(dt: number): void {
    for (let i = 0; i < DUST; i++) {
      if (this.dustLife[i] <= 0) continue;
      const j = i * 3;
      this.dustLife[i] -= dt;
      if (this.dustLife[i] <= 0) {
        this.dustPos[j + 1] = -999;
        continue;
      }
      const k = this.dustLife[i] / DUST_LIFE;
      for (let a = 0; a < 3; a++) {
        this.dustPos[j + a] += this.dustVel[j + a] * dt;
        this.dustCol[j + a] = this.dustBase[j + a] * k;
      }
    }
    const g = this.dust.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }

  /** copy live balls into the instance buffers, once per rendered frame */
  sync(camera: THREE.Camera): void {
    const now = performance.now() / 1000;
    const dt = this.lastSync ? Math.min(0.1, now - this.lastSync) : 0;
    this.lastSync = now;
    if (this.dust.visible) this.moveDust(dt);
    const L = this.look;
    const eye = camera.position;
    let n = 0;
    for (const b of this.pool) {
      if (!b.active) continue;
      const r = Math.max(L.head, Math.hypot(b.x - eye.x, b.y - eye.y, b.z - eye.z) * MIN_ANGLE);
      this.p.set(b.x, b.y, b.z);
      this.heads.setMatrixAt(n, this.m.compose(this.p, this.q.identity(), this.s.setScalar(r)));
      this.heads.setColorAt(n, this.c.setHex(b.color).lerp(this.white, 1 - L.headTint));
      this.c.setHex(b.color);
      this.glows.setMatrixAt(n, this.m.compose(this.p, this.q, this.s.setScalar(r * L.glow)));
      this.glows.setColorAt(n, this.c);
      // the streak points back along the flight, no longer than the ball has flown (not out of the barrel)
      const speed = Math.hypot(b.vx, b.vy, b.vz);
      const len = Math.min(L.streakMax, speed * L.streakPerSpeed, speed * b.age);
      if (speed > 1e-3) {
        this.dir.set(-b.vx / speed, -b.vy / speed, -b.vz / speed);
        this.q.setFromUnitVectors(Paintballs.Z, this.dir);
      }
      this.tails.setMatrixAt(n, this.m.compose(this.p, this.q, this.s.set(r * L.tailWidth, r * L.tailWidth, Math.max(len, 1e-3))));
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

/** a grey, cratered moon, wrapped round a ball's head (tinted a little by the team colour) */
function moonTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e4e2dc';
  g.fillRect(0, 0, 64, 32);
  for (let i = 0; i < 18; i++) {
    g.fillStyle = 'rgba(120,118,112,0.6)';
    g.beginPath();
    g.arc(Math.random() * 64, 4 + Math.random() * 24, 1 + Math.random() * 3.5, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** for the comet tail: solid at the head, fading to nothing at its end (alpha maps read green) */
function fadeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, '#000');
  grad.addColorStop(1, '#fff');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 64);
  return new THREE.CanvasTexture(c);
}

/** a soft round dot, for the dust */
function softDot(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

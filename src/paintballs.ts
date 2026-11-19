// Every paintball in flight, drawn with ONE InstancedMesh (one draw call for hundreds of balls).
// Uses the same flight + collision code as the server, so what you see matches what the server decides.

import * as THREE from 'three';
import { advanceBall, traceWorld, segmentHitsCapsule, isOutOfBounds, BALL_LIFETIME, type Ball } from '../shared/sim';
import type { V3 } from '../shared/protocol';

export interface Target {
  id: number;
  team: number;
  x: number;
  y: number;
  z: number;
  height: number;
  alive: boolean;
}

export interface LiveBall extends Ball {
  active: boolean;
  /** fired by this browser's player */
  local: boolean;
  color: number;
}

export interface BallEvents {
  onWorld(ball: LiveBall, x: number, y: number, z: number, nx: number, ny: number, nz: number): void;
  onTarget(ball: LiveBall, target: Target, x: number, y: number, z: number): void;
}

const MAX = 600;

export class Paintballs {
  private mesh: THREE.InstancedMesh;
  private pool: LiveBall[] = [];
  private next = 0;
  private m = new THREE.Matrix4();
  private c = new THREE.Color();

  constructor(scene: THREE.Scene) {
    this.mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.024, 10, 8), new THREE.MeshBasicMaterial(), MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < MAX; i++) {
      this.mesh.setColorAt(i, this.c.setHex(0xffffff));
      this.pool.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, owner: -1, team: 0, active: false, local: false, color: 0xffffff });
    }
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  spawn(o: V3, v: V3, owner: number, team: number, color: number, local: boolean): void {
    const b = this.pool[this.next];
    this.next = (this.next + 1) % MAX;
    Object.assign(b, { x: o[0], y: o[1], z: o[2], vx: v[0], vy: v[1], vz: v[2], age: 0, owner, team, color, local, active: true });
  }

  update(dt: number, targets: readonly Target[], ev: BallEvents): void {
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
        const s = segmentHitsCapsule(x0, y0, z0, b.x, b.y, b.z, t.x, t.y, t.z, t.height);
        if (s !== null && s < bestT) {
          bestT = s;
          hit = t;
        }
      }
      if (hit) {
        b.active = false;
        ev.onTarget(b, hit, x0 + (b.x - x0) * bestT, y0 + (b.y - y0) * bestT, z0 + (b.z - z0) * bestT);
      } else if (w) {
        b.active = false;
        ev.onWorld(b, w.x, w.y, w.z, w.nx, w.ny, w.nz);
      } else if (b.age > BALL_LIFETIME || isOutOfBounds(b.x, b.y, b.z)) {
        b.active = false;
      }
    }
  }

  /** copy live balls into the instance buffers, once per rendered frame */
  sync(): void {
    let n = 0;
    for (const b of this.pool) {
      if (!b.active) continue;
      this.mesh.setMatrixAt(n, this.m.makeTranslation(b.x, b.y, b.z));
      this.mesh.setColorAt(n, this.c.setHex(b.color));
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

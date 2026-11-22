// Between points (and after a match) the camera cuts between a few shots, like a broadcast: the
// winners where they stand, a sweep over the field, a close-up of the bunker that took the most
// paint. Each shot is a small path for the camera to move along while it looks at something.
// The countdown for the next point starts from your own view again.

import type * as THREE from 'three';
import { field, topOf } from '../shared/field';

export interface Shot {
  /** shown at the bottom of the screen */
  caption: string;
  /** seconds */
  length: number;
  /** where the camera is and what it looks at, k going 0 → 1 over the shot */
  at(k: number, pos: THREE.Vector3, look: THREE.Vector3): void;
}

/** what a break's shots are made from */
export interface BreakInfo {
  /** 'point': between points; 'match': the match is over */
  kind: 'point' | 'match';
  /** the team that won the point or match, or -1 (time ran out) */
  winner: number;
  winnerName: string;
  /** where the winning team's players still in are */
  winners: { x: number; y: number; z: number }[];
  /** per bunker, how much paint it's taken this point */
  paint: readonly number[];
  /** how long the break lasts, seconds */
  seconds: number;
}

const ease = (k: number) => k * k * (3 - 2 * k);

export class Director {
  private shots: Shot[] = [];
  private i = 0;
  private t = 0;

  get active(): boolean {
    return this.shots.length > 0;
  }

  /** the caption of the shot on screen */
  get caption(): string {
    return this.shots[this.i]?.caption ?? '';
  }

  stop(): void {
    this.shots = [];
  }

  /** plan the shots for a break */
  start(b: BreakInfo): void {
    const shots: Shot[] = [];
    const won = b.winner >= 0 ? `${b.winnerName} ${b.kind === 'match' ? 'wins the match' : 'takes the point'}` : 'Time · nobody takes the point';
    if (b.winners.length) shots.push(winnersShot(b.winners, won));
    else shots.push(sweepShot(won, 1));
    const painted = mostPainted(b.paint);
    if (painted >= 0) shots.push(bunkerShot(painted, b.paint[painted]));
    shots.push(sweepShot(`${field.map.name} · ${field.map.length} × ${field.map.width} m`, -1));
    // share the break between them, a couple of seconds at least each
    const each = Math.max(2, b.seconds / shots.length);
    for (const s of shots) s.length = each;
    this.shots = shots;
    this.i = 0;
    this.t = 0;
  }

  /** move the camera along the current shot; false once there are no more */
  update(dt: number, camera: THREE.PerspectiveCamera, pos: THREE.Vector3, look: THREE.Vector3): boolean {
    if (!this.shots.length) return false;
    this.t += dt;
    while (this.shots.length && this.t >= this.shots[this.i].length) {
      this.t -= this.shots[this.i].length;
      if (++this.i >= this.shots.length) {
        // out of shots before the break ended: hold the last one
        this.i = this.shots.length - 1;
        this.t = this.shots[this.i].length;
        break;
      }
    }
    const s = this.shots[this.i];
    s.at(Math.min(1, this.t / s.length), pos, look);
    camera.position.copy(pos);
    camera.lookAt(look);
    return true;
  }
}

/** a slow arc round the winners, low, looking at them */
function winnersShot(ps: { x: number; y: number; z: number }[], caption: string): Shot {
  let cx = 0;
  let cz = 0;
  for (const p of ps) {
    cx += p.x;
    cz += p.z;
  }
  cx /= ps.length;
  cz /= ps.length;
  const spread = Math.max(2.5, ...ps.map((p) => Math.hypot(p.x - cx, p.z - cz)));
  const r = spread + 3;
  // start on the side facing the middle of the field, so the field's behind them
  const a0 = Math.atan2(-cz, -cx);
  return {
    caption, length: 3,
    at(k, pos, look) {
      const a = a0 - 0.7 + ease(k) * 1.1;
      pos.set(cx + Math.cos(a) * r, 1.4 + k * 0.6, cz + Math.sin(a) * r);
      look.set(cx, 1.1, cz);
    },
  };
}

/** high over the field, moving along it (dir 1: from Red's end, -1: from Blue's) */
function sweepShot(caption: string, dir: number): Shot {
  const L = field.halfL;
  const W = field.halfW;
  return {
    caption, length: 3,
    at(k, pos, look) {
      const e = ease(k);
      const x = dir * (-L * 0.9 + e * L * 1.3);
      pos.set(x, Math.max(5, L * 0.22), W * 0.95);
      look.set(x + dir * L * 0.45, 0.5, 0);
    },
  };
}

/** close in on the bunker that took the most paint, circling it */
function bunkerShot(i: number, hits: number): Shot {
  const b = field.bunkers[i];
  const top = topOf(b);
  const r = Math.max(2.4, field.bounds[i].r + 1.8);
  const a0 = Math.atan2(-b.z, -b.x) + 0.6; // from the side facing the middle
  return {
    caption: `Most paint this point · ${hits} hit${hits === 1 ? '' : 's'}`, length: 3,
    at(k, pos, look) {
      const a = a0 + ease(k) * 0.9;
      const rr = r - k * 0.6;
      pos.set(b.x + Math.cos(a) * rr, Math.max(0.6, top * 0.55), b.z + Math.sin(a) * rr);
      look.set(b.x, top * 0.5, b.z);
    },
  };
}

/** the bunker with the most paint on it, or -1 if none took any */
function mostPainted(paint: readonly number[]): number {
  let best = -1;
  for (let i = 0; i < paint.length; i++) if (paint[i] > 0 && (best < 0 || paint[i] > paint[best])) best = i;
  return best;
}

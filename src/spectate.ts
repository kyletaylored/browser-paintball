// Watching someone else while you're out: once you've walked off (or after a few seconds), the camera
// goes over the shoulder of a teammate who's still in, looking where they look. Space (A on a
// controller) moves on to the next one. With no teammate left it watches an opponent. Only the
// camera moves: you're still walking off and waiting at the side line as far as the server knows.

import type * as THREE from 'three';
import { EYE_FROM_TOP } from '../shared/sim';
import { placeOverShoulder, type ShoulderCam } from './player';

/** what we need to know about a player to watch them */
export interface Watchable {
  id: number;
  team: number;
  alive: boolean;
  x: number;
  y: number;
  z: number;
  height: number;
  yaw: number;
  pitch: number;
}

/** once the one you're watching is out, move on after this long (ms), so you see them go */
const LINGER_MS = 1200;

export class Spectator {
  /** who we're watching (a player id), or -1 */
  watching = -1;
  private cam: ShoulderCam = { back: 2.6 };
  private lostAt = 0;

  /** stop watching (back in, or the point's over) */
  stop(): void {
    this.watching = -1;
  }

  /**
   * Pick who to watch: keep the current one while they're in, otherwise (or with `next`) the next
   * teammate still in, by id, then opponents. Returns the one being watched, or null if nobody is in.
   */
  choose(players: readonly Watchable[], myTeam: number, next: boolean, now: number): Watchable | null {
    const cur = players.find((p) => p.id === this.watching);
    if (cur && !cur.alive && !next) {
      if (!this.lostAt) this.lostAt = now;
      if (now - this.lostAt < LINGER_MS) return cur;
    }
    if (cur && cur.alive && !next) return cur;
    this.lostAt = 0;
    const inPlay = players.filter((p) => p.alive).sort((a, b) => a.id - b.id);
    const mates = inPlay.filter((p) => p.team === myTeam);
    const pool = mates.length ? mates : inPlay;
    if (!pool.length) {
      this.watching = -1;
      return null;
    }
    const after = pool.find((p) => p.id > this.watching) ?? pool[0];
    // a new target: start the camera close and let it ease out, rather than jumping from far away
    if (after.id !== this.watching) this.cam.back = 1.2;
    this.watching = after.id;
    return after;
  }

  /** put the camera over their right shoulder */
  view(camera: THREE.Camera, p: Watchable, dt: number): void {
    placeOverShoulder(camera, p.x, p.y + p.height - EYE_FROM_TOP, p.z, p.yaw, p.pitch, 1, this.cam, dt);
  }
}

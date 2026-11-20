// Client-side prediction + server reconciliation for your own player.
//
// Every fixed step the browser moves you immediately (so controls feel instant) and records the
// input frame it used. Frames go to the server in small batches; the server runs the same
// shared/sim.ts stepMovement on them and, with each snapshot, acks the last frame it applied
// together with where that left you. On an ack we jump to the server's state, drop the frames it
// has applied, and replay the rest on top. If the browser and server agree (the normal case: same
// code, same inputs) nothing visibly changes; if they don't (packet loss, a dropped frame, a hit
// that froze you) you're put where the server says, with small corrections smoothed out.

import { stepMovement, INPUT_DT, type Body, type MoveInput } from '../shared/sim';
import { INPUT_CROUCH, INPUT_JUMP, INPUT_SPRINT, type BodyState, type InputFrame } from '../shared/protocol';

/** corrections bigger than this snap instead of smoothing (respawns, being frozen) */
const SNAP_DISTANCE = 1.5;

export class Prediction {
  private seq = 0;
  private pending: { seq: number; move: MoveInput }[] = [];
  private outbox: InputFrame[] = [];
  /** how far the last correction moved you, for stats/debugging */
  lastError = 0;

  /** call once per fixed step, with the input you're about to apply locally */
  record(move: MoveInput, pitch: number): void {
    const seq = ++this.seq;
    this.pending.push({ seq, move: { ...move } });
    if (this.pending.length > 600) this.pending.shift(); // 5 s without an ack: something's very wrong; don't grow forever
    const flags = (move.jump ? INPUT_JUMP : 0) | (move.sprint ? INPUT_SPRINT : 0) | (move.crouch ? INPUT_CROUCH : 0);
    this.outbox.push([seq, move.forward, move.right, flags, move.yaw, pitch]);
  }

  /** frames not yet sent (and clears them) */
  takeOutbox(): InputFrame[] | null {
    if (!this.outbox.length) return null;
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  /** forget unacknowledged frames (joined a new server) */
  reset(): void {
    this.pending = [];
    this.outbox = [];
  }

  /**
   * The server applied everything up to `seq` and has you at `state`. Rewind to that, replay what it
   * hasn't seen yet, and return how far that moved you from where we'd predicted (for smoothing).
   */
  reconcile(body: Body, seq: number, state: BodyState): { dx: number; dy: number; dz: number; snap: boolean } {
    while (this.pending.length && this.pending[0].seq <= seq) this.pending.shift();
    const bx = body.x;
    const by = body.y;
    const bz = body.z;
    [body.x, body.y, body.z, body.vx, body.vy, body.vz, body.height] = state;
    body.onGround = state[7] === 1;
    for (const f of this.pending) stepMovement(body, f.move, INPUT_DT);
    const dx = bx - body.x;
    const dy = by - body.y;
    const dz = bz - body.z;
    this.lastError = Math.hypot(dx, dy, dz);
    return { dx, dy, dz, snap: this.lastError > SNAP_DISTANCE };
  }
}

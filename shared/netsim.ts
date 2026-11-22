// Development tool: a fake network for one direction of a connection, so you can see how the game
// copes with latency and packet loss without a bad Wi-Fi network. The browser uses it for ?lag= and
// ?loss= (src/net.ts) and the server tests use it for their lagged clients (server/smoke-test.ts).
//
// Loss behaves like it does on the connection the message travels over:
//  - reliable and ordered (TCP, which a WebSocket runs on): nothing is ever dropped. A lost packet is
//    sent again once the sender notices, about one round trip later, and everything sent after it
//    waits behind it, because TCP hands data over strictly in order. That's the freeze-then-burst
//    you see on a lossy connection.
//  - unreliable (a WebRTC data channel set up without retransmits): the message is just gone, and the
//    ones behind it arrive on time.

/** how long, on top of a round trip, a TCP sender takes to notice a loss: about three more packets at our rates */
export const LOSS_DETECT_MS = 60;

export interface LinkStats {
  sent: number;
  /** messages that hit a (simulated) loss */
  lost: number;
}

export class FakeLink {
  readonly stats: LinkStats = { sent: 0, lost: 0 };
  /** reliable links: nothing sent from now on can arrive before this (performance.now ms) */
  private blockedUntil = 0;
  /**
   * messages on their way, in the order they arrive. One timer delivers them: separate timers per
   * message can fire out of order (they're rounded to whole milliseconds), which a real connection
   * never does and which made the server see input frames out of order.
   */
  private queue: { at: number; deliver: () => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param rttMs   round trip to fake; each direction adds half
   * @param lossPct chance (0..100) that any one message is lost on the way
   * @param reliable true for TCP-style (resend, in order), false for unreliable (drop)
   */
  constructor(readonly rttMs: number, readonly lossPct: number, readonly reliable = true) {}

  get active(): boolean {
    return this.rttMs > 0 || this.lossPct > 0;
  }

  /** run `deliver` when the message would arrive (or never, if dropped on an unreliable link) */
  send(deliver: () => void): void {
    this.stats.sent++;
    const now = performance.now();
    let at = now + this.rttMs / 2;
    const lost = this.lossPct > 0 && Math.random() * 100 < this.lossPct;
    if (lost) this.stats.lost++;
    if (this.reliable) {
      if (lost) at += this.rttMs + LOSS_DETECT_MS; // the resend, a round trip (and a bit) later
      at = Math.max(at, this.blockedUntil); // in order: wait behind anything still held up
      this.blockedUntil = at;
    } else if (lost) {
      return;
    }
    // arrival times never go down (each message waits behind the previous), so the queue stays sorted
    at = Math.max(at, this.queue.length ? this.queue[this.queue.length - 1].at : 0);
    this.queue.push({ at, deliver });
    if (!this.timer) this.schedule();
  }

  private schedule(): void {
    const next = this.queue[0];
    if (!next) {
      this.timer = null;
      return;
    }
    this.timer = setTimeout(() => {
      const now = performance.now();
      while (this.queue.length && this.queue[0].at <= now + 0.5) this.queue.shift()!.deliver();
      this.schedule();
    }, Math.max(0, next.at - performance.now()));
  }
}

/** read ?lag= and ?loss= style numbers: a non-negative number, or 0 */
export function fakeNumber(v: string | null | undefined, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(max, n) : 0;
}

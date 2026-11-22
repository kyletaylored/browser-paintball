// Development only: a small network overlay in the top-left corner, shown with ?net, ?lag= or ?loss=.
// It answers "how does the game cope with this connection?":
//  - snapshot gaps: the server sends one every 50 ms; a gap over 100 ms means the 100 ms
//    interpolation buffer ran dry and other players froze for a moment
//  - buffer dry: the share of frames where at least one other player was drawn from a stale snapshot
//  - corrections: how often (and how far) the server moved you away from where you'd predicted
//  - link: whether snapshots come over the data channel or the WebSocket (and why)

import { FAKE_LAG_MS, FAKE_LOSS_PCT, type Net } from './net';
import type { LinkState } from './fastlink';

const LINK_NAMES: Record<LinkState, string> = {
  websocket: 'WebSocket',
  trying: 'WebSocket (opening data channel…)',
  open: 'data channel',
  failed: "WebSocket (data channel couldn't connect: UDP blocked?)",
  off: 'WebSocket (server has data channels off)',
  unsupported: 'WebSocket (no WebRTC in this browser)',
};

const SHOW = import.meta.env.DEV && (new URLSearchParams(location.search).has('net') || FAKE_LAG_MS > 0 || FAKE_LOSS_PCT > 0);

export class NetStats {
  private el: HTMLDivElement | null = null;
  private frames = 0;
  private dryFrames = 0;
  /** corrections over 5 cm, and the biggest, since joining */
  private corrections = 0;
  private maxCorrection = 0;
  private shownAt = 0;
  private joinedAt = 0;

  constructor(private net: Net) {
    if (!SHOW) return;
    const el = document.createElement('div');
    el.id = 'netstats';
    Object.assign(el.style, {
      position: 'fixed', left: '8px', top: '8px', zIndex: '50', padding: '6px 8px', borderRadius: '6px',
      font: '11px/1.35 ui-monospace, monospace', color: '#e8f0ff', background: 'rgba(10,12,20,0.72)',
      whiteSpace: 'pre', pointerEvents: 'none',
    });
    document.body.append(el);
    this.el = el;
  }

  /** joined (or rejoined) a server: start counting again */
  reset(): void {
    this.frames = this.dryFrames = this.corrections = this.maxCorrection = 0;
    this.joinedAt = performance.now();
  }

  /** once per rendered frame while online; `dry` = some other player was drawn past their newest snapshot */
  frame(dry: boolean): void {
    this.frames++;
    if (dry) this.dryFrames++;
  }

  /** the prediction was corrected by `metres` */
  correction(metres: number): void {
    if (metres > 0.05) this.corrections++;
    this.maxCorrection = Math.max(this.maxCorrection, metres);
  }

  /** redraw a few times a second */
  update(now: number): void {
    if (!this.el || now - this.shownAt < 250) return;
    this.shownAt = now;
    const n = this.net;
    const fake = `fake lag ${FAKE_LAG_MS} ms · loss ${FAKE_LOSS_PCT}%`;
    if (n.status !== 'online') {
      this.el.textContent = `${fake}\n${n.status}`;
      return;
    }
    const t = n.timing;
    const mins = Math.max(1 / 60, (now - this.joinedAt) / 60000);
    const ping = n.roster.get(n.id)?.ping ?? 0;
    this.el.textContent = [
      fake,
      `link ${LINK_NAMES[n.fast?.state ?? 'websocket']} · ping ${ping} ms`,
      `snapshot gaps >100 ms: ${t.over100} (${(t.over100 / mins).toFixed(1)}/min) · longest ${Math.round(t.longest)} ms`,
      `interp buffer dry: ${this.frames ? ((this.dryFrames / this.frames) * 100).toFixed(1) : '0.0'}% of frames`,
      `corrections >5 cm: ${this.corrections} · largest ${(this.maxCorrection * 100).toFixed(0)} cm`,
      `in ${(n.bytesIn / 1024).toFixed(0)} KB · out ${(n.bytesOut / 1024).toFixed(0)} KB`,
    ].join('\n');
  }
}

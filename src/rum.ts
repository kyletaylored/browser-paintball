// Datadog Real User Monitoring for the page (docs/DATADOG.md): load times, errors, long tasks,
// clicks, and the game's own numbers (frame rate, ping, prediction corrections) every 30 s. Off
// unless the game server hands out a RUM application id and client token (/client-config.json),
// and the SDK is only downloaded then. Nothing personal is sent: no player names, typing masked.

interface RumConfig {
  applicationId: string;
  clientToken: string;
  site: string;
  service: string;
  env: string;
  version: string;
  sessionSampleRate: number;
}

type DatadogRum = typeof import('@datadog/browser-rum').datadogRum;

let rum: DatadogRum | null = null;

/** fetch the server's settings and start RUM if it's configured; never throws */
export async function startRum(httpBase: string): Promise<void> {
  try {
    const r = await fetch(`${httpBase}/client-config.json`, { cache: 'no-store' });
    if (!r.ok) return;
    const cfg = ((await r.json()) as { rum?: RumConfig | null }).rum;
    if (!cfg?.applicationId || !cfg.clientToken) return;
    const { datadogRum } = await import('@datadog/browser-rum');
    datadogRum.init({
      applicationId: cfg.applicationId,
      clientToken: cfg.clientToken,
      site: cfg.site as 'datadoghq.com',
      service: cfg.service,
      env: cfg.env,
      version: cfg.version,
      sessionSampleRate: cfg.sessionSampleRate,
      // a replay of a WebGL canvas shows nothing useful, and it's heavy: off
      sessionReplaySampleRate: 0,
      trackUserInteractions: true,
      trackResources: true,
      trackLongTasks: true,
      defaultPrivacyLevel: 'mask-user-input',
    });
    rum = datadogRum;
  } catch {
    // blocked by an extension, offline, or not configured: play on without it
  }
}

/** what's being played, attached to everything RUM sends from now on */
export function rumContext(ctx: Record<string, string | number | boolean>): void {
  if (!rum) return;
  for (const [k, v] of Object.entries(ctx)) rum.setGlobalContextProperty(k, v);
}

/** a game event (joined a match, got eliminated, …) with some numbers about it */
export function rumEvent(name: string, ctx: Record<string, string | number | boolean> = {}): void {
  rum?.addAction(name, ctx);
}

/**
 * Frame times for the game.perf report: call once per frame with how long it was (ms). Every 30 s
 * a "game.perf" action goes out with the average frame rate, the slowest frame and the 95th
 * percentile, plus whatever `extra` returns then (ping, corrections, …).
 */
export class PerfReport {
  private frames: number[] = [];
  private since = performance.now();

  constructor(private extra: () => Record<string, number | string | boolean>) {}

  frame(ms: number, now: number): void {
    if (!rum) return;
    if (ms > 0 && ms < 1000) this.frames.push(ms);
    if (now - this.since < 30000) return;
    const f = this.frames.sort((a, b) => a - b);
    const total = f.reduce((a, b) => a + b, 0);
    if (f.length > 30) {
      rumEvent('game.perf', {
        fps: Math.round((f.length / total) * 1000 * 10) / 10,
        frame_p95_ms: Math.round(f[Math.floor(f.length * 0.95)] * 10) / 10,
        frame_max_ms: Math.round(f[f.length - 1] * 10) / 10,
        ...this.extra(),
      });
    }
    this.frames = [];
    this.since = now;
  }
}

// Game metrics for Datadog (docs/DATADOG.md): how long each server tick takes, how many players,
// bots and paintballs there are, pings, and counts of shots, hits and bounces. They go to the
// Datadog Agent over DogStatsD through dd-trace, so they're only sent when tracing is on
// (server/dd-init.mjs). Otherwise every call here does nothing.

interface StatsClient {
  gauge(name: string, value: number, tags?: Record<string, string | number>): void;
  increment(name: string, value?: number, tags?: Record<string, string | number>): void;
  distribution?(name: string, value: number, tags?: Record<string, string | number>): void;
}

const enabled = ['true', '1'].includes((process.env.DD_TRACE_ENABLED ?? '').toLowerCase());
let stats: StatsClient | null = null;
if (enabled) {
  try {
    // the tracer dd-init.mjs started; this import just hands back the same one
    const tracer = (await import('dd-trace')).default as unknown as { dogstatsd?: StatsClient };
    stats = tracer.dogstatsd ?? null;
  } catch {
    stats = null;
  }
}

/** metrics are going somewhere */
export const telemetryOn = (): boolean => stats !== null;

const counts = new Map<string, number>();
const ticks = { n: 0, total: 0, max: 0 };

/** count something that happened (sent as a total every flush) */
export function count(name: string, n = 1): void {
  if (stats) counts.set(name, (counts.get(name) ?? 0) + n);
}

/** one server tick took `ms` */
export function tickTime(ms: number): void {
  if (!stats) return;
  ticks.n++;
  ticks.total += ms;
  if (ms > ticks.max) ticks.max = ms;
}

/** send everything gathered since the last flush, plus the gauges given now; call every few seconds */
export function flush(gauges: Record<string, number>, tags: Record<string, string>): void {
  if (!stats) return;
  for (const [k, v] of Object.entries(gauges)) stats.gauge(`splat.${k}`, v, tags);
  for (const [k, v] of counts) stats.increment(`splat.${k}`, v, tags);
  counts.clear();
  if (ticks.n) {
    stats.gauge('splat.tick.avg_ms', ticks.total / ticks.n, tags);
    stats.gauge('splat.tick.max_ms', ticks.max, tags);
    ticks.n = ticks.total = ticks.max = 0;
  }
}

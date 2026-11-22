// Datadog APM for the game server, loaded before anything else with `node --import ./server/dd-init.mjs`
// (the Dockerfile does). It does nothing unless DD_TRACE_ENABLED=true, so the game runs without it.
// See docs/DATADOG.md.
//
// When on, dd-trace traces the HTTP server, the WebSocket handshake, and WebSocket messages (the `ws`
// library, dd-trace 5.82 and up). The game sends a lot of small messages (about 140 a second per
// player), so message spans are sampled hard by default; every value here can be overridden with its
// environment variable.

const on = (process.env.DD_TRACE_ENABLED ?? '').toLowerCase();
if (on === 'true' || on === '1') {
  const defaults = {
    DD_SERVICE: 'splat-arena',
    DD_ENV: 'production',
    // the version shows in Datadog's deployment tracking; Fly sets FLY_IMAGE_REF to the image deployed
    ...(process.env.FLY_IMAGE_REF ? { DD_VERSION: process.env.FLY_IMAGE_REF.split(':').pop() } : {}),
    // WebSocket messages: sample each on its own, at 1 in 500, instead of keeping every message of a
    // sampled connection (a connection lasts a whole session: tens of thousands of messages)
    DD_TRACE_WEBSOCKET_MESSAGES_INHERIT_SAMPLING: 'false',
    DD_TRACE_SAMPLING_RULES: JSON.stringify([
      { name: 'websocket.receive', sample_rate: 0.002 },
      { name: 'websocket.send', sample_rate: 0.002 },
    ]),
    DD_RUNTIME_METRICS_ENABLED: 'true',
    DD_LOGS_INJECTION: 'true',
  };
  for (const [k, v] of Object.entries(defaults)) if (process.env[k] === undefined) process.env[k] = v;
  await import('dd-trace/initialize.mjs');
}

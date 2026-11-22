# Monitoring with Datadog

The game can report to Datadog. All of it is off until it's configured, and the game plays the same either way.

- **The page (RUM):** load times, JavaScript errors, long tasks and clicks, plus the game's own numbers every 30 s as
  a `game.perf` action (frame rate, 95th-percentile and slowest frame, ping, prediction correction, players, view), and
  events: `match.join`, `player.out`, `player.elimination`. Every event carries the field, the firing mode and whether
  you're online. No player names are sent, and typing is masked. Session replay is off, since a recording of a WebGL
  canvas shows nothing useful.
- **The server (APM):** traces of the HTTP server and of the WebSocket connections (handshake, messages and close),
  using Datadog's WebSocket monitoring for the `ws` library (dd-trace 5.82 and up). Also Node runtime metrics, and the
  game's own metrics:

| metric | |
|---|---|
| `splat.tick.avg_ms`, `splat.tick.max_ms` | how long the 60 Hz server tick takes (movement, bots, paintballs, the match) |
| `splat.players`, `splat.bots`, `splat.balls` | humans connected, bots playing, paintballs in flight |
| `splat.ping.avg_ms`, `splat.ping.max_ms` | round trip to the humans |
| `splat.shots.human`, `splat.shots.bot`, `splat.eliminations`, `splat.bounces.player`, `splat.joins` | counts, every 10 s |

Every metric is tagged with `map`, `fire_mode` and `phase`.

## WebSocket message sampling

A player's browser sends about 60 input frames a second, and the server sends it 20 snapshots and acks a second. A
connection lasts a whole session, so tracing every message would be tens of thousands of spans per player. By
default `server/dd-init.mjs` samples message spans on their own at 1 in 500
(`DD_TRACE_WEBSOCKET_MESSAGES_INHERIT_SAMPLING=false`, plus `DD_TRACE_SAMPLING_RULES` for `websocket.receive` and
`websocket.send`). That's enough to see message sizes and handling times, and it keeps volume and CPU down. Set
either variable yourself to change it. `DD_TRACE_WEBSOCKET_MESSAGES_ENABLED=false` turns message spans off and keeps
the handshake.

Input frames go over the WebRTC data channel instead when one is open (`server/rtc.ts`). Those aren't WebSocket
messages, so they don't show up.

## Setting it up

### The page

1. In Datadog, create a RUM application (Digital Experience > Add an application > JavaScript, served by npm). Note
   its application ID and client token. Both are public by design: they end up in every visitor's page.
2. Give them to the game server, which hands them to the page at `/client-config.json`:

   ```
   fly secrets set DD_RUM_APPLICATION_ID=<id> DD_RUM_CLIENT_TOKEN=<token> -a splat-arena
   ```

   Optional: `DD_SITE` (default `datadoghq.com`), `DD_RUM_SERVICE` (default `splat-arena-web`), `DD_ENV` (default
   `production`), `DD_RUM_SESSION_SAMPLE_RATE` (0–100, default 100).

The page loads the RUM SDK only when the server says it's set up, so a server without it costs players nothing.

### The server

dd-trace sends traces and metrics to a Datadog Agent.

- **On a machine with an Agent** (or in Docker next to one): set `DD_TRACE_ENABLED=true`, and `DD_AGENT_HOST` if the
  Agent isn't on localhost. The Docker image already starts the server with `node --import ./dd-init.mjs`. Outside
  Docker, start it the same way: `node --import ./server/dd-init.mjs dist-server/index.js`.
- **On Fly.io:** run the Agent as a second, private app, using `deploy/datadog-agent/fly.toml` (the steps are at its
  top). It's one more always-on small machine on your Fly bill. Then:

  ```
  fly secrets set DD_TRACE_ENABLED=true DD_AGENT_HOST=splat-arena-dd-agent.internal -a splat-arena
  ```

`server/dd-init.mjs` sets `DD_SERVICE=splat-arena`, `DD_ENV=production`, the version from Fly's image tag, runtime
metrics and log injection, unless you set them. The server's startup log says whether Datadog is on.

Never commit the API key: it only goes in Fly secrets (or your shell). `.env.example` lists the variables with empty
values.

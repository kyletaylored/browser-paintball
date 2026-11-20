# Splat Arena

An original browser paintball game:
**Vite + TypeScript + three.js + pmndrs/postprocessing** in the browser, and a small **Node WebSocket server** for multiplayer.

Everything is drawn from code (no model files yet), so you can read the whole thing in an afternoon.

## Run it

Needs Node 20.19 or newer.

```powershell
npm install
npm run dev
```

Open http://localhost:5173. `npm run dev` starts both the client (Vite, port 5173) and the game server (port 8787).
Open a second browser window to play against yourself: the server puts the next player on the other team.

**How a match works:** once both teams have a player, everyone is put back in their start box for a 3-second countdown.
Then the point is live: if you're hit you're out until the point ends. Eliminate the whole other team to win the point.
First team to 5 points wins the match. While a team is empty it's warm-up: you respawn a few seconds after being hit.
Pick a name on the start screen; it shows over your head, in the kill feed and on the scoreboard.

- **Playing alone?** The server fills both teams with bots (3 a side by default), so you can play a match on your own.
  A friend who joins takes a bot's place.
- **No server running?** The game falls back to offline practice with three strafing dummies.
- **Slow machine?** Add `?low` to the URL to turn off shadows, bloom and anti-aliasing.
- **Check the server works:** `npm run test:server` starts its own servers, plays a point between two fake players,
  checks lag compensation with a fake 150 ms player, then checks that bots fill the teams, move, shoot and finish a point.

| Controls | |
|---|---|
| Mouse / click | aim / fire (hold for 10 balls a second) |
| WASD, Shift | move, sprint |
| Space, C | jump (you can jump onto the low walls), crouch |
| R | reload (200-ball hopper) |
| Tab (hold) | scoreboard |
| Esc | release the mouse |

## How it's put together

```
shared/       code BOTH sides run, so they agree
  protocol.ts   every network message, typed
  field.ts      bunker layout + spawn points
  sim.ts        movement, paintball flight, collision (no physics engine needed)
server/
  index.ts      authoritative game server: simulates paintballs, decides hits, runs the match, sends snapshots
  bots.ts       server-side bots: navigation grid + A*, cover spots, aim with reaction delay and error
  smoke-test.ts headless end-to-end checks (starts its own servers)
src/          the browser game
  main.ts       game loop (fixed 120 Hz physics step), shooting, wiring
  render.ts     WebGLRenderer + postprocessing (bloom, vignette, tone mapping, SMAA)
  world.ts      sky, lights, turf texture, nets, bunkers
  player.ts     first-person controller + the gun on screen
  paintballs.ts all balls in flight as one InstancedMesh
  fx.ts         paint splat decals + droplet bursts
  avatars.ts    other players (simple primitives for now)
  net.ts        WebSocket client + snapshot interpolation
  hud.ts        HTML overlay (no UI framework)
```

**Who decides what:**

- **Your movement:** your browser sends its keys and aim to the server as small fixed-length steps. The server runs
  the same movement code (`shared/sim.ts`) on them and decides where you are, so nobody can teleport or speed up.
  Your browser predicts the same steps locally, so moving feels instant, and quietly corrects itself if the server
  disagrees (`src/prediction.ts`).
- **Paintballs:** your browser draws them the instant you click. The server *also* flies them using the same `shared/sim.ts` code and is the only one that decides eliminations.
- **Other players:** drawn 100 ms in the past, blended between the server's snapshots, so they move smoothly instead of jumping 20 times a second.
- **Lag compensation:** because of that, and your ping, you're aiming at where people *were*. The server keeps a second
  of everyone's positions and tests your paintballs against targets as they were on your screen (your ping + 100 ms
  ago, at most 300 ms), so a shot that hits on your screen hits on the server too.

In development, `window.__game` in the browser console exposes the player, network, scene and so on, and adding
`?lag=150` to the URL fakes 150 ms of network latency so you can see how prediction copes. `?hitboxes` outlines where
the server tested each hit (after rewinding for lag).

## Where to take it next

Roughly in order of payoff:

1. **Real art.** Model bunkers, a marker and a player in Blender and export `.glb`. Compress with
   [`gltf-transform`](https://gltf-transform.dev) (`gltf-transform optimize in.glb out.glb --compress meshopt`), then load with
   `GLTFLoader` + `MeshoptDecoder`. Animate the player with `AnimationMixer`.
2. **Binary messages.** Pack snapshots into an `ArrayBuffer` with `DataView` instead of JSON (often 5–10× smaller).
3. **More modes.** Capture the flag, an attack/defend variant, and so on (rounds are already in).

## Deploying

- **Client:** `npm run build` produces static files in `dist/`. Any static host works. Set `VITE_SERVER_URL=wss://your-server.example.com` at build time.
- **Server:** it's a long-running process, so it needs a VPS or an app platform that runs containers, not shared web hosting.
  Put it behind TLS (`wss://`) so HTTPS pages can connect.
- **Server settings** (environment variables): `PORT` (default 8787), `POINTS_TO_WIN` (5), `ROUND_SECONDS` (120),
  `COUNTDOWN_SECONDS` (3), `POINT_PAUSE_SECONDS` (3), `MATCH_OVER_SECONDS` (6),
  `BOT_TEAM_SIZE` (3; fill each team to this many with bots, `0` turns bots off), `BOT_SKILL` (`easy`, `normal`, `hard`),
  `LAG_COMPENSATION` (`0` turns it off), `MAX_REWIND_MS` (300).

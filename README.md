# Splat Arena

An original browser paintball game:
**Vite + TypeScript + three.js + pmndrs/postprocessing** in the browser, and a small **Node WebSocket server** for multiplayer.

Everything is drawn from code (no model files yet), so you can read the whole thing in an afternoon.

## Run it

Needs Node 20 or newer.

```powershell
npm install
npm run dev
```

Open http://localhost:5173. `npm run dev` starts both the client (Vite, port 5173) and the game server (port 8787).
Open a second browser window to play against yourself: the server puts the next player on the other team.

- **No server running?** The game falls back to offline practice with three strafing dummies.
- **Slow machine?** Add `?low` to the URL to turn off shadows, bloom and anti-aliasing.
- **Check the server works:** with it running, `npm run test:server` connects two fake players, has one shoot the other, and checks the hit and respawn.

| Controls | |
|---|---|
| Mouse / click | aim / fire (hold for 10 balls a second) |
| WASD, Shift | move, sprint |
| Space, C | jump (you can jump onto the low walls), crouch |
| R | reload (200-ball hopper) |
| Esc | release the mouse |

## How it's put together

```
shared/       code BOTH sides run, so they agree
  protocol.ts   every network message, typed
  field.ts      bunker layout + spawn points
  sim.ts        movement, paintball flight, collision (no physics engine needed)
server/
  index.ts      authoritative game server: simulates paintballs, decides hits, sends snapshots
  smoke-test.ts headless two-player test
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

- **Your movement:** your browser simulates it and tells the server where you are 20×/s. Simple, but a cheater could teleport.
- **Paintballs:** your browser draws them the instant you click. The server *also* flies them using the same `shared/sim.ts` code and is the only one that decides eliminations.
- **Other players:** drawn 100 ms in the past, blended between the server's snapshots, so they move smoothly instead of jumping 20 times a second.

In development, `window.__game` in the browser console exposes the player, network, scene and so on.

## Where to take it next

Roughly in order of payoff:

1. **Real art.** Model bunkers, a marker and a player in Blender and export `.glb`. Compress with
   [`gltf-transform`](https://gltf-transform.dev) (`gltf-transform optimize in.glb out.glb --compress meshopt`), then load with
   `GLTFLoader` + `MeshoptDecoder`. Animate the player with `AnimationMixer`.
2. **Sound.** three's `AudioListener` + `PositionalAudio` for shots and splats.
3. **Server-side movement + prediction.** Send *inputs* (keys + aim, with a sequence number) instead of positions. The server
   runs `stepMovement` on them, the client keeps predicting locally and replays unacknowledged inputs when a snapshot corrects it.
   Search for "client-side prediction and server reconciliation" for the background.
4. **Lag compensation.** Keep a short history of player positions on the server and test hits against where the target was
   when the shooter fired.
5. **Binary messages.** Pack snapshots into an `ArrayBuffer` with `DataView` instead of JSON (often 5–10× smaller).
6. **Rounds and modes.** Eliminate the whole team to win the point, hang the flag, and so on.
7. **Bots.** A grid over the field, A* pathfinding between bunkers, and aim with a reaction delay and some error.

## Deploying

- **Client:** `npm run build` produces static files in `dist/`. Any static host works. Set `VITE_SERVER_URL=wss://your-server.example.com` at build time.
- **Server:** it's a long-running process, so it needs a VPS or an app platform that runs containers, not shared web hosting.
  Put it behind TLS (`wss://`) so HTTPS pages can connect. `PORT` sets the port.

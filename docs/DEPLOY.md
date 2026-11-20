# Deploying Splat Arena

The game is two pieces:

- **The website:** static files (`npm run build` → `dist/`).
- **The game server:** a long-running Node process that speaks WebSocket (`npm run build` → `dist-server/index.js`).
  It can't run on plain shared web hosting; it needs something that keeps a process running, such as a VPS or a
  container platform.

You can run both from **one container** (simplest), or put the website on a static host and only run the server
yourself.

## Option A: one container for everything (recommended)

The `Dockerfile` builds the website and the server into one small image. The server serves the site and accepts game
connections on the same port, so the browser just connects back to whatever address it loaded the page from. There's
nothing to configure.

```sh
docker build -t splat-arena .
docker run -p 8080:8080 splat-arena
# open http://localhost:8080
```

To put it online:

1. Run the image on a VPS or any container platform. It listens on `$PORT` (8080 in the image).
2. Put **TLS** in front of it (`https://`). Pages served over HTTPS may only open `wss://` connections, so this is required,
   not optional. Use either your platform's built-in TLS or a reverse proxy. Whichever you use must pass **WebSocket
   upgrades** through (`Upgrade` / `Connection` headers) and should allow idle connections of a few minutes.
3. Set `ALLOWED_ORIGINS=https://your-domain.example` so other websites can't open game connections from their visitors'
   browsers.
4. Point the platform's health check at `GET /healthz`. It returns `{"ok":true,"players":…,"bots":…,"phase":…,"uptime":…}`.
   The image also has a container `HEALTHCHECK` built in.

## Option B: website on a static host, server elsewhere

1. Build the website with the server's public address baked in:

   ```sh
   VITE_SERVER_URL=wss://game.example.com npm run build
   ```

   Upload `dist/` to any static host. Files under `assets/` have content hashes in their names and can be cached
   forever. `index.html` should not be cached.
2. Run the server, either the same image or `npm ci --omit=dev && node dist-server/index.js` after a build, behind TLS as
   in option A.
3. Set `ALLOWED_ORIGINS=https://your-site.example` to the website's origin.

## Settings

Everything is an environment variable. There are no config files and no secrets in the repo. `.env.example` lists them
all with their defaults. For a local run you can copy it to `.env` (git ignores it) and start with
`node --env-file=.env dist-server/index.js`.

| variable | default | |
|---|---|---|
| `PORT` | 8787 (8080 in the image) | port for HTTP, WebSocket and the website |
| `HOST` | all interfaces | interface to listen on |
| `STATIC_DIR` | unset (`/app/public` in the image) | also serve the built website from this folder |
| `ALLOWED_ORIGINS` | any | comma-separated origins allowed to connect, e.g. `https://play.example.com` |
| `POINTS_TO_WIN` | 5 | |
| `ROUND_SECONDS` | 120 | time limit per point |
| `COUNTDOWN_SECONDS` / `POINT_PAUSE_SECONDS` / `MATCH_OVER_SECONDS` | 3 / 3 / 6 | |
| `BOT_TEAM_SIZE` | 3 | fill each team to this many with bots while anyone is connected; `0` = off |
| `BOT_SKILL` | `normal` | `easy`, `normal`, `hard` |
| `LAG_COMPENSATION` | on | `0` turns it off |
| `MAX_REWIND_MS` | 300 | the furthest back lag compensation will look |
| `WIRE_FORMAT` | `binary` | `json` sends everything as readable JSON (debugging) |

Build-time only (website):

| variable | default | |
|---|---|---|
| `VITE_SERVER_URL` | same address as the page | game server address, for option B |

## Operating it

- **Logs:** one timestamped line per event (joins, leaves, renames, match phases) on stdout, which container platforms
  collect.
- **Restarts and deploys:** on `SIGTERM` the server stops accepting players, closes every connection with "server
  restarting", and exits within about 1.5 s. Browsers reconnect by themselves, backing off from 3 s up to 15 s.
  Match state lives in memory, so a restart ends the current match.
- **Size:** one process runs one room of up to 12 humans. Eleven bots use about 1% of a CPU core, and each player needs
  about 5 KB/s down and 2 KB/s up, so a small VPS has plenty of headroom.
- **Security:** messages are size-capped (4 KB), every client message is validated, and movement and hits are decided on
  the server. Names are cleaned on the server and always shown as text. The static file handler never serves
  anything outside `STATIC_DIR`.

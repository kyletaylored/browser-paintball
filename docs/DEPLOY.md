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

### On Fly.io

The live game runs this way: `fly.toml` in the repo root deploys the same image to one Fly machine.

```sh
fly auth login
fly apps create <app-name>      # once; then set app (and ALLOWED_ORIGINS) in fly.toml to match
fly deploy --ha=false           # --ha=false: one machine; two would split players into separate rooms
fly status                      # machine state and health check
fly logs                        # server log lines
```

- **TLS and WebSockets:** Fly's proxy gives you `https://<app-name>.fly.dev` and passes WebSocket upgrades through.
  The shared IPv4 address is enough; a dedicated one isn't needed.
- **Idle stop:** `auto_stop_machines = "stop"` stops the machine when nobody is connected and starts it again on the
  next visit, so an unused game costs almost nothing. The first page load after idle takes a few seconds. An open game
  connection counts as in use, so a match is never stopped halfway.
- **Health:** Fly polls `GET /healthz` every 30 s.
- **Automatic deploys:** `.github/workflows/deploy.yml` deploys every push to `main` once CI has passed on it
  (a newer push waits for the running deploy rather than cancelling it), then checks `/healthz` on the live site.
  You can also start it by hand from the Actions tab. It needs a deploy token in the repo's `FLY_API_TOKEN` secret,
  and skips with a warning until one is set:

  ```sh
  fly tokens create deploy -a splat-arena -x 8760h | gh secret set FLY_API_TOKEN
  ```

  A deploy token can only deploy this one app. It expires after a year (`-x`); make a new one the same way.
- **Deploys:** Fly stops the old machine with `SIGTERM`, which ends the current match (see "Restarts and deploys").
- **More regions:** each machine is its own 12-player room, and Fly sends each player to the nearest running machine.
  `fly scale count 1 --region <code>` adds one machine in another region. Keep one machine per region until the server
  supports several rooms: a full server turns new players away ("server full") instead of sending them elsewhere.

## Data channels (optional, UDP)

Positions go stale in 50 ms, so the game sends snapshots, acks and input frames over a WebRTC data channel when it can:
unordered and never resent, so a lost packet is just skipped instead of freezing everything behind it for a round trip
the way TCP does. Each browser connects straight to the game server (`server/rtc.ts`); there's no relay between
players, and the server still decides everything. Everything else stays on the WebSocket, and a browser that can't
reach the UDP port plays over the WebSocket exactly as before. `?net` on a development build shows which link is in use.

It's on by default in development (UDP port = game port + 1) and **off in production until you open a UDP port**:

1. Open one UDP port to the server (every player shares it) and set `RTC_UDP_PORT` to it.
2. If the server's own address isn't the one players reach (it's behind NAT, in a container, or behind a platform's
   proxy), set `RTC_PUBLIC_IP` to the public address. The server then tells browsers only that address.
3. Docker: publish the port too, e.g.
   `docker run -p 8080:8080 -p 8788:8788/udp -e RTC_UDP_PORT=8788 -e RTC_PUBLIC_IP=<host address> splat-arena`.

**No relay (TURN) server is needed.** The game server has a public address, so a browser behind any home or mobile NAT
can reach it directly. The only players who can't are on networks that block UDP outright (some offices, some hotel
Wi-Fi). A TURN relay wouldn't help them either: it would carry the channel over TCP, which brings back the stalls the
channel is there to avoid. They simply stay on the WebSocket.

**On Fly.io** (not switched on for the live game yet): Fly only forwards UDP to apps with a dedicated IPv4 address,
which is a paid add-on, and the app must answer from the `fly-global-services` address. To turn it on:

```sh
fly ips allocate-v4 -a splat-arena     # dedicated IPv4 (paid); note the address it prints
```

then add to `fly.toml`:

```toml
[env]
  RTC_UDP_PORT = "8788"
  RTC_BIND_ADDRESS = "fly-global-services"
  RTC_PUBLIC_IP = "<the dedicated IPv4>"

[[services]]
  protocol = "udp"
  internal_port = 8788
  [[services.ports]]
    port = 8788
```

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
| `MAP` | `rotate` | a field id from `shared/maps.ts` (`arena`, `tournament`, `beach`, `woods`) to play only that one; `rotate` moves to the next field after every match |
| `POINTS_TO_WIN` | 5 | |
| `ROUND_SECONDS` | 120 | time limit per point |
| `COUNTDOWN_SECONDS` / `POINT_PAUSE_SECONDS` / `MATCH_OVER_SECONDS` | 3 / 3 / 6 | |
| `BOT_TEAM_SIZE` | 3 | fill each team to this many with bots while anyone is connected; `0` = off |
| `BOT_SKILL` | `normal` | `easy`, `normal`, `hard` |
| `LAG_COMPENSATION` | on | `0` turns it off |
| `MAX_REWIND_MS` | 300 | the furthest back lag compensation will look |
| `WIRE_FORMAT` | `binary` | `json` sends everything as readable JSON (debugging; turns data channels off) |
| `RTC_UDP_PORT` | game port + 1 in development, off in production | the one UDP port for data channels; `0` = off |
| `RTC_PUBLIC_IP` | unset | address browsers send UDP to, when it isn't the server's own (NAT, containers, proxies) |
| `RTC_BIND_ADDRESS` | all interfaces | local address or host name to bind the UDP port to (`fly-global-services` on Fly.io) |

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
  about 5 KB/s down and 2 KB/s up (about 4 up on a data channel, which repeats recent input frames in every packet), so
  a small VPS has plenty of headroom.
- **Security:** messages are size-capped (4 KB), every client message is validated, and movement and hits are decided on
  the server. Names are cleaned on the server and always shown as text. The static file handler never serves
  anything outside `STATIC_DIR`.

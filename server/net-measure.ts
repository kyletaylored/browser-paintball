// How does play hold up on a lossy connection? Starts a server, joins one fake player
// that strafes back and forth near its start box with client-side prediction (src/prediction.ts),
// and fakes latency and TCP-style packet loss on its connection (shared/netsim.ts). Reports:
//
//  - snapshot gaps over 100 ms: the interpolation buffer is 100 ms deep, so other players freeze
//  - buffer dry: share of 60 fps frames where the newest snapshot is older than the draw time
//  - off by a body: share of frames where a walking player is drawn more than a body width
//    (0.32 m, 60 ms at walking pace) from where the server will test your shots
//  - corrections: how often the server's ack moved you more than 5 cm from your prediction
//
//   npm run measure:net                 → the full table (50 / 150 ms × 0, 1, 2, 5 % loss)
//   npm run measure:net -- 150 2 60     → one run: lag ms, loss %, seconds

import { Prediction } from '../src/prediction';
import { stepMovement, INPUT_DT, INTERP_DELAY, WALK_SPEED, PLAYER_RADIUS, type MoveInput } from '../shared/sim';
import { join, send, startServer, wait, type Ack, type Snap } from './test-client';

const INTERP_MS = INTERP_DELAY * 1000;
/** stale by more than this and a walking target is drawn a body width off */
const STALE_MS = (PLAYER_RADIUS / WALK_SPEED) * 1000;

interface Result {
  lag: number;
  loss: number;
  seconds: number;
  gaps: number;
  longest: number;
  dry: number;
  offByBody: number;
  corrections: number;
  maxCorrection: number;
}

async function run(url: string, lag: number, loss: number, seconds: number): Promise<Result> {
  const c = await join(url, lag, loss);
  const prediction = new Prediction();
  const move: MoveInput = { forward: 0, right: 0, jump: false, sprint: false, crouch: false, yaw: c.yaw };
  let read = 0;
  let corrections = 0;
  let maxCorrection = 0;
  const t0 = performance.now();
  const end = t0 + seconds * 1000;
  let steps = 0;
  while (performance.now() < end) {
    // real time → fixed steps, like the browser's loop
    const due = Math.floor((performance.now() - t0) / 1000 / INPUT_DT);
    for (; steps < due; steps++) {
      move.right = Math.sin(steps * INPUT_DT * 1.6) > 0 ? 1 : -1; // strafe left and right
      prediction.record(move, 0);
      stepMovement(c.body, move, INPUT_DT);
    }
    const frames = prediction.takeOutbox();
    if (frames) send(c.ws, { t: 'input', i: frames });
    for (; read < c.inbox.length; read++) {
      const m = c.inbox[read];
      if (m.t !== 'ack') continue;
      prediction.reconcile(c.body, (m as Ack).seq, (m as Ack).b);
      if (prediction.lastError > 0.05) corrections++;
      maxCorrection = Math.max(maxCorrection, prediction.lastError);
    }
    await wait(16);
  }
  c.ws.close();

  // snapshot arrivals, after the first second (joining)
  const arr = c.snaps.map((s: { at: number; m: Snap }) => s.at).filter((at) => at > t0 + 1000);
  let gaps = 0;
  let longest = 0;
  for (let i = 1; i < arr.length; i++) {
    const g = arr[i] - arr[i - 1];
    longest = Math.max(longest, g);
    if (g > 100) gaps++;
  }
  // replay 60 fps frames against the arrivals
  let frames = 0;
  let dry = 0;
  let off = 0;
  let k = 0;
  for (let T = (arr[0] ?? end) + 200; T < (arr[arr.length - 1] ?? 0); T += 1000 / 60) {
    while (k + 1 < arr.length && arr[k + 1] <= T) k++;
    const behind = T - INTERP_MS - arr[k]; // how far the draw time is past the newest snapshot
    frames++;
    if (behind > 0) dry++;
    if (behind > STALE_MS) off++;
  }
  const mins = (arr.length ? arr[arr.length - 1] - arr[0] : 1) / 60000;
  return {
    lag, loss, seconds, gaps: gaps / mins, longest, dry: (dry / Math.max(1, frames)) * 100,
    offByBody: (off / Math.max(1, frames)) * 100, corrections: corrections / mins, maxCorrection,
  };
}

const row = (r: Result) =>
  `| ${r.lag} ms | ${r.loss}% | ${r.gaps.toFixed(1)} | ${Math.round(r.longest)} ms | ${r.dry.toFixed(1)}% | ${r.offByBody.toFixed(1)}% | ${r.corrections.toFixed(1)} | ${(r.maxCorrection * 100).toFixed(0)} cm |`;

const [lagArg, lossArg, secArg] = process.argv.slice(2).map(Number);
const plan: [number, number][] = Number.isFinite(lagArg)
  ? [[lagArg, Number.isFinite(lossArg) ? lossArg : 0]]
  : [50, 150].flatMap((lag) => [0, 1, 2, 5].map((loss): [number, number] => [lag, loss]));
const seconds = Number.isFinite(secArg) ? secArg : 30;

// alone on the server: warm-up, free to move the whole time. SERVER_URL measures against your own (bots off)
const server = process.env.SERVER_URL ? { url: process.env.SERVER_URL, stop() {} } : await startServer({ BOT_TEAM_SIZE: '0' });
try {
  console.log(`${seconds} s per run, one strafing player\n`);
  console.log('| lag | loss | gaps >100 ms /min | longest gap | buffer dry | off by a body | corrections >5 cm /min | largest |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const [lag, loss] of plan) console.log(row(await run(server.url, lag, loss, seconds)));
} finally {
  server.stop();
}
process.exit(0);

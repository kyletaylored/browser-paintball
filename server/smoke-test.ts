// Headless end-to-end checks for the game server. Starts its own servers on spare ports, so
// nothing else needs to be running:  npm run test:server
//
//  1. Rules (bots off): two fake players join, the countdown runs, Red shoots Blue, the server
//     reports the hit, Red wins the point, the next point starts; names get cleaned; stats count.
//  2. Lag compensation: a shooter with 150 ms of round trip shoots a target walking across in
//     front of them, aiming where their (interpolated, delayed) view shows it. With compensation it
//     hits; with LAG_COMPENSATION=0 the same shot misses.
//  3. Bots: one fake player joins, bots fill both teams, move off their start box and play the
//     point out; a second player takes a bot's place.
//  4. Data channel: a player asks for one, snapshots and acks arrive on it, and with 5% of packets
//     lost each way its movement still matches the server exactly (inputs are sent with redundancy)
//     and no snapshot is held up. With data channels off on the server, it plays over the WebSocket.
//  5. Voice: with no media server configured the welcome says so and token requests are ignored
//     (the game is unchanged); with one configured, players get a signed, short-lived token that
//     names them and their team, at most one every few seconds.
//
// Set SERVER_URL to run only the rules check against a server you started yourself (bots off), and
// SERVER_RTC=1 as well to check a data channel opens to it.

import { createHmac } from 'node:crypto';
import { cleanName, type ServerMsg, type InputFrame } from '../shared/protocol';
import { EYE_FROM_TOP } from '../shared/sim';
import {
  join, send, viewOf, wait, waitFor, walkTo, lastAck, snapWhere, rosterWhere, startServer, fastOpen,
  type Client, type Ack, type Hit,
} from './test-client';

const results: [string, boolean][] = [];
const check = (name: string, ok: boolean) => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
};

// ---- 1. rules ------------------------------------------------------------------------------

async function rulesTest(url: string) {
  console.log('-- rules (bots off)');
  const a = await join(url);
  const b = await join(url);
  if (a.team === b.team) throw new Error('expected the two players on opposite teams (is someone else connected?)');
  const [shooter, target] = a.team === 0 ? [a, b] : [b, a];

  // names: one ordinary, one full of control/zero-width characters and far too long
  const NASTY = '  \u0000Sh​ooter\n\t<b>with a very long name</b>  ';
  const EXPECTED = cleanName(NASTY);
  send(shooter.ws, { t: 'hello', name: NASTY });
  send(target.ws, { t: 'hello', name: 'Target' });

  // With one player per team the server starts a countdown, then the point goes live.
  const live = await waitFor(shooter.inbox, snapWhere((m) => m.round.phase === 'live'), 8000);

  // An old-style "I'm over here now" message must not move anyone any more.
  const before = { x: target.body.x, z: target.body.z };
  target.ws.send(JSON.stringify({ t: 'state', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, c: false }));

  // Walk them (with real input frames, in real time) to 5 m apart with nothing in between.
  await Promise.all([walkTo(shooter, -17, -2.5), walkTo(target, -12, -2.5, true)]);
  await wait(200); // let the acks for the last frames arrive
  const sAck = lastAck(shooter);
  const tAck = lastAck(target);
  const agree = (c: Client, a: Ack | undefined) =>
    a !== undefined && Math.hypot(a.b[0] - c.body.x, a.b[1] - c.body.y, a.b[2] - c.body.z) < 1e-6;
  const teleported = tAck !== undefined && Math.hypot(tAck.b[0], tAck.b[2]) < 1; // the fake 'state' put it at 0,0
  check('server ignores an old-style position message', !teleported && Math.hypot(before.x - 21.5, before.z + 5.5) < 0.01);
  check('server-run movement matches the client prediction exactly', agree(shooter, sAck) && agree(target, tAck));

  const ex = shooter.body.x;
  const ez = shooter.body.z;
  const eyeY = shooter.body.y + shooter.body.height - EYE_FROM_TOP;
  const d = [target.body.x - ex, 1.2 - eyeY, target.body.z - ez];
  const len = Math.hypot(d[0], d[1], d[2]);
  const dir: [number, number, number] = [d[0] / len, d[1] / len, d[2] / len];
  send(shooter.ws, { t: 'fire', o: [ex + dir[0] * 0.35, eyeY + dir[1] * 0.35, ez + dir[2] * 0.35], d: dir });

  const hit = await waitFor(shooter.inbox, (m): m is Hit => m.t === 'hit', 1000);
  const sawBall = target.inbox.some((m) => m.t === 'ball');
  const afterHit = target.inbox.length;
  const point = await waitFor(
    shooter.inbox,
    snapWhere((m) => m.round.phase === 'point' && m.round.winner === shooter.team && m.score[shooter.team] === 1),
    1000,
  );
  // the next point resets everyone to their start box
  const respawn = await waitFor(target.inbox, (m): m is Extract<ServerMsg, { t: 'respawn' }> => m.t === 'respawn', 6000, afterHit);
  const stats = await waitFor(
    target.inbox,
    rosterWhere((m) =>
      m.players.some((p) => p.id === shooter.id && p.name === EXPECTED && p.k === 1) &&
      m.players.some((p) => p.id === target.id && p.name === 'Target' && p.d === 1)),
    1000,
  );
  const next = await waitFor(target.inbox, snapWhere((m) => m.round.phase === 'countdown' && m.round.round === 2), 1000, afterHit);
  a.ws.close();
  b.ws.close();

  check('countdown ran and the point went live', live !== null);
  check('target was told about the ball', sawBall);
  check('server reported the hit', hit?.victim === target.id && hit?.shooter === shooter.id);
  check("shooter's team won the point", point !== null);
  check('target respawned for the next point', respawn !== null);
  check('point 2 countdown started', next !== null);
  check(`names cleaned ("${EXPECTED}") and stats counted in the roster`, stats !== null && EXPECTED === 'Shooter<b>with a');
  check('server sent a latency probe', target.inbox.some((m) => m.t === 'ping'));
}

// ---- 2. lag compensation -------------------------------------------------------------------

async function lagTest(url: string, compensated: boolean) {
  console.log(`-- 150 ms shooter vs a moving target, lag compensation ${compensated ? 'on' : 'off'}`);
  const shooter = await join(url, 150);
  const target = await join(url);
  if (shooter.team === target.team) throw new Error('expected opposite teams');
  await waitFor(shooter.inbox, snapWhere((m) => m.round.phase === 'live'), 8000);
  // shooter steps out beside their start; target runs over and lines up to cross in front of them
  await Promise.all([
    walkTo(shooter, -15, -1.5),
    (async () => {
      await walkTo(target, -10.5, -2.5, true);
      await walkTo(target, -10.5, -7);
    })(),
  ]);
  // make sure the server has measured the shooter's ping
  await waitFor(shooter.inbox, rosterWhere((m) => (m.players.find((p) => p.id === shooter.id)?.ping ?? 0) > 120), 5000);

  const crossing = walkTo(target, -10.5, 8); // 15 m at walking pace, straight across the shooter's view
  let fired = false;
  const end = performance.now() + 6000;
  while (!fired && performance.now() < end) {
    await wait(5);
    const at = performance.now() - 100; // INTERP_DELAY: what the shooter's screen shows right now
    const v = viewOf(shooter, target.id, at);
    const v0 = viewOf(shooter, target.id, at - 50);
    if (!v || !v0 || v.z < -1.2) continue;
    // aim at the chest, leading by the ball's flight time like a player would
    const eyeY = shooter.body.y + shooter.body.height - EYE_FROM_TOP;
    const dist = Math.hypot(v.x - shooter.body.x, v.z - shooter.body.z);
    const flight = dist / 85;
    const vz = (v.z - v0.z) / 0.05;
    const aim = [v.x - shooter.body.x, 1.2 - eyeY, v.z + vz * flight - shooter.body.z];
    const len = Math.hypot(aim[0], aim[1], aim[2]);
    const dir: [number, number, number] = [aim[0] / len, aim[1] / len, aim[2] / len];
    send(shooter.ws, { t: 'fire', o: [shooter.body.x + dir[0] * 0.35, eyeY + dir[1] * 0.35, shooter.body.z + dir[2] * 0.35], d: dir });
    fired = true;
  }
  const hit = await waitFor(shooter.inbox, (m): m is Hit => m.t === 'hit' && m.victim === target.id, 1500);
  await crossing;
  shooter.ws.close();
  target.ws.close();
  if (!fired) check('shooter got a shot off', false);
  else if (compensated) check('the shot that hits on the lagged screen hits on the server', hit !== null);
  else check('without compensation the same shot misses (so the test means something)', hit === null);
}

// ---- 1b. speed hack ------------------------------------------------------------------------

async function speedTest(url: string) {
  console.log('-- input rate limit');
  const a = await join(url);
  const b = await join(url);
  const [cheat] = a.team === 0 ? [a, b] : [b, a];
  await waitFor(cheat.inbox, snapWhere((m) => m.round.phase === 'live'), 8000);
  await wait(300);
  const start = { x: cheat.body.x, z: cheat.body.z };
  // 3 seconds of sprinting forward, all sent at once
  const frames: InputFrame[] = [];
  for (let i = 0; i < 360; i++) frames.push([++cheat.seq, 1, 0, 2, cheat.yaw, 0]);
  for (let i = 0; i < frames.length; i += 60) send(cheat.ws, { t: 'input', i: frames.slice(i, i + 60) });
  await wait(250);
  const ack = lastAck(cheat);
  const moved = ack ? Math.hypot(ack.b[0] - start.x, ack.b[2] - start.z) : Infinity;
  // honest: 3 s × 7.6 m/s ≈ 22 m. The server only accepts about a quarter second of backlog.
  check(`a burst of 3 s of input moves you at most a few metres (moved ${moved.toFixed(1)} m)`, moved < 3.5);
  a.ws.close();
  b.ws.close();
}

// ---- 2. bots -------------------------------------------------------------------------------

async function botTest(url: string) {
  console.log('-- bots (2 per team, hard)');
  const human = await join(url);
  send(human.ws, { t: 'hello', name: 'Human' });
  // a fake player who just stands in their start box

  const filled = await waitFor(
    human.inbox,
    rosterWhere((m) => m.players.filter((p) => p.bot).length === 3 && [0, 1].every((t) => m.players.filter((p) => p.team === t).length === 2)),
    3000,
  );
  check('bots fill both teams to 2 around one human', filled !== null);

  const live = await waitFor(human.inbox, snapWhere((m) => m.round.phase === 'live'), 8000);
  check('point went live with bots', live !== null);
  const liveAt = human.inbox.length;
  const botIds = new Set(filled?.players.filter((p) => p.bot).map((p) => p.id) ?? []);
  const start = new Map(live?.players.map((p) => [p.id, p]) ?? []);

  const moved = await waitFor(
    human.inbox,
    snapWhere((m) => m.players.some((p) => botIds.has(p.id) && start.has(p.id) && Math.hypot(p.x - start.get(p.id)!.x, p.z - start.get(p.id)!.z) > 3)),
    10000,
    liveAt,
  );
  check('bots leave their start box', moved !== null);

  const botHit = await waitFor(human.inbox, (m): m is Hit => m.t === 'hit' && botIds.has(m.shooter), 60000, liveAt);
  check('a bot eliminates someone', botHit !== null);
  const decided = await waitFor(human.inbox, snapWhere((m) => m.round.phase === 'point' || m.round.phase === 'matchover'), 90000, liveAt);
  check(`the point is played out (${decided ? `winner ${decided.round.winner}` : 'timed out'})`, decided !== null);

  // a second human takes a bot's place
  const before = human.inbox.length;
  const second = await join(url);
  const replaced = await waitFor(
    human.inbox,
    rosterWhere((m) => m.players.filter((p) => p.bot).length === 2 && m.players.filter((p) => !p.bot).length === 2),
    3000,
    before,
  );
  check('a joining human replaces a bot', replaced !== null);
  second.ws.close();
  human.ws.close();
}

// ---- 4. data channel -----------------------------------------------------------------------

/** walk a client somewhere and back, then check the server's last ack matches its prediction */
async function walkAndAgree(c: Client): Promise<boolean> {
  await walkTo(c, c.body.x + (c.team === 0 ? 4 : -4), c.body.z + 3);
  await walkTo(c, c.body.x, c.body.z - 3);
  await wait(300);
  const a = lastAck(c);
  return a !== undefined && Math.hypot(a.b[0] - c.body.x, a.b[1] - c.body.y, a.b[2] - c.body.z) < 1e-6;
}

/** lying down: the server crawls you exactly as the browser predicted, and others see you lying down */
async function crawlTest(url: string) {
  console.log('-- crawling');
  const c = await join(url); // alone (warm-up), so nothing freezes us for a countdown
  const x0 = c.body.x;
  await walkTo(c, c.body.x + (c.team === 0 ? 2 : -2), c.body.z + 1, false, true);
  await wait(300);
  const a = lastAck(c);
  check('crawling: the server agrees exactly with the prediction',
    a !== undefined && Math.hypot(a.b[0] - c.body.x, a.b[1] - c.body.y, a.b[2] - c.body.z) < 1e-6);
  check(`crawling is slow, and keeps you low (eyes at ${(c.body.height - EYE_FROM_TOP).toFixed(2)} m)`,
    Math.abs(c.body.x - x0) > 1.5 && c.body.height < 0.6);
  // snapshots list everyone, us included: what everyone else draws
  const seen = await waitFor(c.inbox, snapWhere((m) => m.players.some((p) => p.id === c.id && p.pr && !p.c)), 1000, c.inbox.length);
  check('snapshots show you lying down, for everyone else to draw', seen !== null);
  c.ws.close();
}

/** longest gap between snapshot arrivals, ms, after the first `skip` */
function longestGap(c: Client, skip: number): number {
  let g = 0;
  for (let i = skip + 1; i < c.snaps.length; i++) g = Math.max(g, c.snaps[i].at - c.snaps[i - 1].at);
  return g;
}

async function rtcTest(url: string) {
  console.log('-- data channel');
  const c = await join(url, 0, 0, true);
  const opened = await fastOpen(c);
  check('a data channel opens to the server', opened);
  if (!opened) {
    c.ws.close();
    return;
  }
  await wait(500);
  const via = { ...c.fast!.via };
  check(`snapshots arrive on the data channel (${via.fast} of ${via.fast + via.ws})`, via.fast > 0 && via.fast >= via.ws);
  check('movement over the data channel matches the client prediction', await walkAndAgree(c));
  c.ws.close();

  // 5% of packets lost each way on the data channel: dropped, not resent
  const lossy = await join(url, 60, 5, true);
  check('a data channel opens with 5% loss', await fastOpen(lossy, 8000));
  const skip = lossy.snaps.length;
  check('with 5% loss, movement still matches exactly (redundant input frames)', await walkAndAgree(lossy));
  const gap = longestGap(lossy, skip);
  // over TCP a lost packet holds everything up for a round trip (~180 ms here); here it's one skipped snapshot
  check(`with 5% loss no snapshot is held up (longest gap ${Math.round(gap)} ms)`, gap < 160);
  lossy.ws.close();
}

async function noRtcTest(url: string) {
  console.log('-- data channels off: WebSocket only');
  const c = await join(url, 0, 0, true);
  const opened = await fastOpen(c, 1500);
  await wait(300);
  check('no data channel is offered when the server has them off', !opened && !c.fast!.offered);
  check('snapshots keep coming over the WebSocket', c.fast!.via.ws > 10 && c.fast!.via.fast === 0);
  check('movement over the WebSocket matches the client prediction', await walkAndAgree(c));
  c.ws.close();
}

// ---- 5. voice ------------------------------------------------------------------------------

type Welcome = Extract<ServerMsg, { t: 'welcome' }>;
type VoiceMsg = Extract<ServerMsg, { t: 'voice' }>;
const isWelcome = (m: ServerMsg): m is Welcome => m.t === 'welcome';
const isVoice = (m: ServerMsg): m is VoiceMsg => m.t === 'voice';

async function noVoiceTest(url: string) {
  console.log('-- voice not configured');
  const c = await join(url);
  const welcome = c.inbox.find(isWelcome);
  send(c.ws, { t: 'voice' });
  const token = await waitFor(c.inbox, isVoice, 600);
  check('the welcome says there is no voice', welcome?.voice === false);
  check('a voice token request is ignored', token === null);
  c.ws.close();
}

// test values only: nothing real is signed with these
const TEST_VOICE = { LIVEKIT_URL: 'ws://voice.test:7880', LIVEKIT_API_KEY: 'test-key', LIVEKIT_API_SECRET: 'test-secret-not-real', VOICE_ROOM: 'test-room' };

async function voiceTest(url: string) {
  console.log('-- voice configured (no media server needed: only the token is checked)');
  const c = await join(url);
  const welcome = c.inbox.find(isWelcome);
  check('the welcome says voice is on', welcome?.voice === true);
  send(c.ws, { t: 'voice' });
  const v = await waitFor(c.inbox, isVoice, 1000);
  const [h, b, sig] = (v?.token ?? '..').split('.');
  const good = createHmac('sha256', TEST_VOICE.LIVEKIT_API_SECRET).update(`${h}.${b}`).digest('base64url') === sig;
  let claims: Record<string, any> = {};
  try {
    claims = JSON.parse(Buffer.from(b, 'base64url').toString());
  } catch {
    // stays empty: the checks below fail
  }
  check('the token comes with the media server address', v?.url === TEST_VOICE.LIVEKIT_URL);
  check('the token is signed with the API secret (HS256)', good && JSON.parse(Buffer.from(h, 'base64url').toString()).alg === 'HS256');
  check(`it names the player (${claims.sub}) and their team, for the voice room only`,
    claims.iss === TEST_VOICE.LIVEKIT_API_KEY && claims.sub === `p${c.id}` && claims.attributes?.team === String(c.team) &&
    claims.video?.room === TEST_VOICE.VOICE_ROOM && claims.video?.roomJoin === true && claims.video?.canPublishData === false);
  check('it expires within a few minutes', typeof claims.exp === 'number' && claims.exp - Date.now() / 1000 <= 11 * 60 && claims.exp > Date.now() / 1000);
  const before = c.inbox.length;
  send(c.ws, { t: 'voice' });
  check('a second request straight away gets no new token', (await waitFor(c.inbox, isVoice, 500, before)) === null);
  c.ws.close();
}

// ---- run -----------------------------------------------------------------------------------

try {
  if (process.env.SERVER_URL) {
    await rulesTest(process.env.SERVER_URL);
    if (process.env.SERVER_RTC) await rtcTest(process.env.SERVER_URL);
  } else {
    const rules = await startServer({ BOT_TEAM_SIZE: '0' });
    try {
      await rulesTest(rules.url);
    } finally {
      rules.stop();
    }
    const speed = await startServer({ BOT_TEAM_SIZE: '0' });
    try {
      await speedTest(speed.url);
    } finally {
      speed.stop();
    }
    for (const compensated of [true, false]) {
      const lag = await startServer({ BOT_TEAM_SIZE: '0', LAG_COMPENSATION: compensated ? '1' : '0' });
      try {
        await lagTest(lag.url, compensated);
      } finally {
        lag.stop();
      }
    }
    const withRtc = await startServer({ BOT_TEAM_SIZE: '0' }); // data channels are on by default in development
    try {
      await rtcTest(withRtc.url);
      await crawlTest(withRtc.url);
    } finally {
      withRtc.stop();
    }
    const noRtc = await startServer({ BOT_TEAM_SIZE: '0', RTC_UDP_PORT: '0' });
    try {
      await noRtcTest(noRtc.url);
    } finally {
      noRtc.stop();
    }
    const noVoice = await startServer({ BOT_TEAM_SIZE: '0', LIVEKIT_URL: '' }); // off even if your shell has it set
    try {
      await noVoiceTest(noVoice.url);
    } finally {
      noVoice.stop();
    }
    const withVoice = await startServer({ BOT_TEAM_SIZE: '0', ...TEST_VOICE });
    try {
      await voiceTest(withVoice.url);
    } finally {
      withVoice.stop();
    }
    const bots = await startServer({ BOT_TEAM_SIZE: '2', BOT_SKILL: 'hard' });
    try {
      await botTest(bots.url);
    } finally {
      bots.stop();
    }
  }
} catch (e) {
  console.error(e);
  check('test ran to the end', false);
}
process.exit(results.every(([, ok]) => ok) ? 0 : 1);

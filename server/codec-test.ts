// Round-trip checks for the binary wire format (shared/codec.ts):  npm run test:codec

import {
  decodeClient, decodeServer, encodeAck, encodeBall, encodeInput, encodeSnap, quantizeInput,
  type AckMsg, type BallMsg, type SnapMsg,
} from '../shared/codec';
import type { InputFrame, RoundPhase, Team } from '../shared/protocol';

const results: [string, boolean][] = [];
const check = (name: string, ok: boolean) => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
};
const rnd = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const angleDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const throws = (f: () => unknown) => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};

// ---- snapshot -----------------------------------------------------------------------------------
{
  let worstPos = 0;
  let worstYaw = 0;
  let worstPitch = 0;
  let flagsOk = true;
  let headerOk = true;
  for (let trial = 0; trial < 200; trial++) {
    const phases: RoundPhase[] = ['waiting', 'countdown', 'live', 'point', 'matchover'];
    const m: SnapMsg = {
      t: 'snap',
      time: rnd(0, 1e5),
      score: [Math.floor(rnd(0, 6)), Math.floor(rnd(0, 6))],
      round: {
        phase: phases[trial % 5],
        endsIn: rnd(0, 120),
        round: Math.floor(rnd(1, 12)),
        winner: ([-1, 0, 1] as const)[trial % 3],
        toWin: 5,
      },
      players: Array.from({ length: 12 }, (_, i) => ({
        id: i * 37 + trial,
        team: (i % 2) as Team,
        x: rnd(-24.5, 24.5),
        y: rnd(0, 3),
        z: rnd(-16.5, 16.5),
        yaw: rnd(-20, 20), // any angle, including several turns
        pitch: rnd(-1.5, 1.5),
        c: Math.random() < 0.5,
        alive: Math.random() < 0.5,
      })),
    };
    const d = decodeServer(encodeSnap(m));
    if (d.t !== 'snap') throw new Error('wrong type');
    headerOk &&= d.round.phase === m.round.phase && d.round.round === m.round.round && d.round.winner === m.round.winner &&
      d.round.toWin === m.round.toWin && Math.abs(d.round.endsIn - m.round.endsIn) <= 0.005 &&
      d.score[0] === m.score[0] && d.score[1] === m.score[1] && Math.abs(d.time - m.time) <= m.time * 1e-6;
    for (let i = 0; i < m.players.length; i++) {
      const a = m.players[i];
      const b = d.players[i];
      worstPos = Math.max(worstPos, Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
      worstYaw = Math.max(worstYaw, angleDiff(a.yaw, b.yaw));
      worstPitch = Math.max(worstPitch, Math.abs(a.pitch - b.pitch));
      flagsOk &&= a.id === b.id && a.team === b.team && a.c === b.c && a.alive === b.alive;
    }
  }
  check('snapshot: ids, teams, crouch and alive flags exact', flagsOk);
  check('snapshot: round state, score and time survive', headerOk);
  check(`snapshot: positions within 5 mm (worst ${(worstPos * 1000).toFixed(2)} mm)`, worstPos <= 0.005 + 1e-9);
  check(`snapshot: yaw within 0.003° (worst ${((worstYaw * 180) / Math.PI).toFixed(4)}°)`, worstYaw <= (Math.PI * 2) / 65536);
  check(`snapshot: pitch within 0.003° (worst ${((worstPitch * 180) / Math.PI).toFixed(4)}°)`, worstPitch <= Math.PI / 2 / 32767);
}

// ---- ack (must be exact: prediction replays from it) ---------------------------------------------
{
  let exact = true;
  for (let i = 0; i < 200; i++) {
    const m: AckMsg = { t: 'ack', seq: Math.floor(rnd(0, 4e9)), b: [rnd(-24, 24), rnd(0, 3), rnd(-16, 16), rnd(-8, 8), rnd(-8, 8), rnd(-8, 8), rnd(1.1, 1.8), i % 2] };
    const d = decodeServer(encodeAck(m));
    exact &&= d.t === 'ack' && d.seq === m.seq && d.b.every((v, k) => v === m.b[k]);
  }
  check('ack: sequence number and body state are bit-exact', exact);
}

// ---- ball ------------------------------------------------------------------------------------------
{
  let worst = 0;
  let idOk = true;
  for (let i = 0; i < 200; i++) {
    const m: BallMsg = { t: 'ball', owner: Math.floor(rnd(1, 60000)), team: (i % 2) as Team, o: [rnd(-24, 24), rnd(0, 3), rnd(-16, 16)], v: [rnd(-85, 85), rnd(-85, 85), rnd(-85, 85)] };
    const d = decodeServer(encodeBall(m));
    if (d.t !== 'ball') throw new Error('wrong type');
    idOk &&= d.owner === m.owner && d.team === m.team;
    for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(d.o[k] - m.o[k]), Math.abs(d.v[k] - m.v[k]) / 85);
  }
  check('ball: owner and team exact', idOk);
  check(`ball: origin and velocity within float32 precision (worst ${worst.toExponential(1)})`, worst < 1e-5);
}

// ---- input (what the browser predicted with must be exactly what the server replays) -------------
{
  let exact = true;
  for (let i = 0; i < 200; i++) {
    const frames: InputFrame[] = [];
    for (let k = 0; k < 8; k++) {
      const q = quantizeInput(rnd(-1.3, 1.3), rnd(-1.3, 1.3), rnd(-50, 50), rnd(-1.6, 1.6));
      frames.push([i * 8 + k + 1, q.forward, q.right, k & 7, q.yaw, q.pitch]);
    }
    const d = decodeClient(encodeInput(frames));
    exact &&= d.t === 'input' && d.i.length === frames.length && d.i.every((f, k) => f.every((v, j) => v === frames[k][j]));
  }
  check('input: quantised frames round-trip bit-exactly', exact);
  const q = quantizeInput(2, -5, 0, 0);
  check('input: forward/right are clamped to -1..1', q.forward === 1 && q.right === -1);
}

// ---- malformed frames are rejected, not misread ------------------------------------------------------
{
  const snap = encodeSnap({ t: 'snap', time: 1, score: [0, 0], round: { phase: 'live', endsIn: 1, round: 1, winner: -1, toWin: 5 }, players: [{ id: 1, team: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, c: false, alive: true }] });
  const input = encodeInput([[1, 0, 0, 0, 0, 0]]);
  check('malformed: truncated snapshot throws', throws(() => decodeServer(snap.slice(0, snap.length - 3))));
  check('malformed: truncated input throws', throws(() => decodeClient(input.slice(0, input.length - 2))));
  check('malformed: unknown message types throw', throws(() => decodeServer(new Uint8Array([99, 0, 0]))) && throws(() => decodeClient(new Uint8Array([1, 0]))));
  check('malformed: empty frame throws', throws(() => decodeServer(new Uint8Array(0))) && throws(() => decodeClient(new Uint8Array(0))));
}

// ---- size ------------------------------------------------------------------------------------------
{
  const m: SnapMsg = {
    t: 'snap', time: 1234.5678, score: [2, 3], round: { phase: 'live', endsIn: 87.3, round: 6, winner: -1, toWin: 5 },
    players: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, team: (i % 2) as Team, x: rnd(-20, 20), y: 0, z: rnd(-14, 14), yaw: rnd(0, 6), pitch: rnd(-0.3, 0.3), c: false, alive: true })),
  };
  const bin = encodeSnap(m).byteLength;
  const json = JSON.stringify(m).length;
  check(`size: a 12-player snapshot is ${bin} bytes binary vs ${json} JSON (${(json / bin).toFixed(1)}× smaller)`, bin * 5 <= json);
}

process.exit(results.every(([, ok]) => ok) ? 0 : 1);

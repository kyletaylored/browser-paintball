// Binary encoding for the messages sent many times a second: snapshots, acks and paintballs from the
// server, input frames from the browser. Everything else (joins, names, hits, pings) stays JSON:
// it's rare, and readable messages are easier to debug. WebSockets carry both kinds of frame, and
// both ends decode binary frames into the same message objects as JSON ones, so the rest of the code
// doesn't care which it got.
//
// Little-endian throughout. Layouts:
//
//  snap   u8 type | f32 time | u8 phase | u16 endsIn (1/100 s) | u8 round | i8 winner | u8 toWin
//         | u8 score red | u8 score blue | u8 count | count × player
//  player u16 id | u8 flags (1 blue, 2 crouch, 4 alive, 8 lying down) | i16 x, y, z (cm) | u16 yaw | i16 pitch
//  ack    u8 type | u32 seq | 7 × f64 body | u8 onGround      (full precision: prediction replays from it)
//  ball   u8 type | u16 owner | u8 team | 3 × f32 origin | 3 × f32 velocity
//  input  u8 type | u8 count | count × (u32 seq | i8 forward | i8 right | u8 flags | f32 yaw | f32 pitch)
//
// Input frames are quantised (forward/right to 1/127, yaw/pitch to 32-bit floats) *before* the browser
// predicts with them, via quantizeInput(), so the server replays exactly what the browser simulated.

import type { ClientMsg, InputFrame, PlayerSnap, RoundPhase, ServerMsg, Team } from './protocol';

const SNAP = 1;
const ACK = 2;
const BALL = 3;
const INPUT = 4;

const PHASES: readonly RoundPhase[] = ['waiting', 'countdown', 'live', 'point', 'matchover'];
const TAU = Math.PI * 2;
const YAW_SCALE = 65536 / TAU;
const PITCH_SCALE = 32767 / (Math.PI / 2);

const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
const cm = (v: number) => clampInt(v * 100, -32768, 32767);
const wrapYaw = (a: number) => ((a % TAU) + TAU) % TAU;

export type SnapMsg = Extract<ServerMsg, { t: 'snap' }>;
export type AckMsg = Extract<ServerMsg, { t: 'ack' }>;
export type BallMsg = Extract<ServerMsg, { t: 'ball' }>;

// ---- server → browser -------------------------------------------------------------------------

export function encodeSnap(m: SnapMsg): Uint8Array<ArrayBuffer> {
  const n = Math.min(255, m.players.length);
  const buf = new ArrayBuffer(14 + n * 13);
  const v = new DataView(buf);
  v.setUint8(0, SNAP);
  v.setUint32(1, m.seq >>> 0, true);
  v.setUint8(5, Math.max(0, PHASES.indexOf(m.round.phase)));
  v.setUint16(6, clampInt(m.round.endsIn * 100, 0, 65535), true);
  v.setUint8(8, clampInt(m.round.round, 0, 255));
  v.setInt8(9, m.round.winner);
  v.setUint8(10, clampInt(m.round.toWin, 0, 255));
  v.setUint8(11, clampInt(m.score[0], 0, 255));
  v.setUint8(12, clampInt(m.score[1], 0, 255));
  v.setUint8(13, n);
  let o = 14;
  for (let i = 0; i < n; i++) {
    const p = m.players[i];
    v.setUint16(o, p.id, true);
    v.setUint8(o + 2, (p.team === 1 ? 1 : 0) | (p.c ? 2 : 0) | (p.alive ? 4 : 0) | (p.pr ? 8 : 0));
    v.setInt16(o + 3, cm(p.x), true);
    v.setInt16(o + 5, cm(p.y), true);
    v.setInt16(o + 7, cm(p.z), true);
    v.setUint16(o + 9, Math.round(wrapYaw(p.yaw) * YAW_SCALE) & 0xffff, true);
    v.setInt16(o + 11, clampInt(p.pitch * PITCH_SCALE, -32767, 32767), true);
    o += 13;
  }
  return new Uint8Array(buf);
}

export function encodeAck(m: AckMsg): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(62);
  const v = new DataView(buf);
  v.setUint8(0, ACK);
  v.setUint32(1, Math.max(0, m.seq) >>> 0, true);
  for (let i = 0; i < 7; i++) v.setFloat64(5 + i * 8, m.b[i], true);
  v.setUint8(61, m.b[7] ? 1 : 0);
  return new Uint8Array(buf);
}

export function encodeBall(m: BallMsg): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(28);
  const v = new DataView(buf);
  v.setUint8(0, BALL);
  v.setUint16(1, m.owner, true);
  v.setUint8(3, m.team);
  for (let i = 0; i < 3; i++) v.setFloat32(4 + i * 4, m.o[i], true);
  for (let i = 0; i < 3; i++) v.setFloat32(16 + i * 4, m.v[i], true);
  return new Uint8Array(buf);
}

/** a binary frame from the server; throws on anything malformed */
export function decodeServer(data: ArrayBuffer | ArrayBufferView): ServerMsg {
  const v = view(data);
  switch (v.getUint8(0)) {
    case SNAP: {
      const n = v.getUint8(13);
      if (v.byteLength < 14 + n * 13) throw new RangeError('short snapshot');
      const winner = v.getInt8(9);
      const players: PlayerSnap[] = [];
      let o = 14;
      for (let i = 0; i < n; i++) {
        const f = v.getUint8(o + 2);
        players.push({
          id: v.getUint16(o, true),
          team: (f & 1 ? 1 : 0) as Team,
          c: (f & 2) !== 0,
          pr: (f & 8) !== 0,
          alive: (f & 4) !== 0,
          x: v.getInt16(o + 3, true) / 100,
          y: v.getInt16(o + 5, true) / 100,
          z: v.getInt16(o + 7, true) / 100,
          yaw: v.getUint16(o + 9, true) / YAW_SCALE,
          pitch: v.getInt16(o + 11, true) / PITCH_SCALE,
        });
        o += 13;
      }
      return {
        t: 'snap',
        seq: v.getUint32(1, true),
        round: {
          phase: PHASES[v.getUint8(5)] ?? 'waiting',
          endsIn: v.getUint16(6, true) / 100,
          round: v.getUint8(8),
          winner: (winner === 0 || winner === 1 ? winner : -1) as Team | -1,
          toWin: v.getUint8(10),
        },
        score: [v.getUint8(11), v.getUint8(12)],
        players,
      };
    }
    case ACK: {
      const b: number[] = [];
      for (let i = 0; i < 7; i++) b.push(v.getFloat64(5 + i * 8, true));
      b.push(v.getUint8(61));
      return { t: 'ack', seq: v.getUint32(1, true), b: b as AckMsg['b'] };
    }
    case BALL:
      return {
        t: 'ball',
        owner: v.getUint16(1, true),
        team: (v.getUint8(3) === 1 ? 1 : 0) as Team,
        o: [v.getFloat32(4, true), v.getFloat32(8, true), v.getFloat32(12, true)],
        v: [v.getFloat32(16, true), v.getFloat32(20, true), v.getFloat32(24, true)],
      };
    default:
      throw new RangeError(`unknown server message ${v.getUint8(0)}`);
  }
}

// ---- browser → server -------------------------------------------------------------------------

/** round an input frame's numbers to what the wire carries; predict with the result */
export function quantizeInput(forward: number, right: number, yaw: number, pitch: number) {
  return {
    forward: clampInt(forward * 127, -127, 127) / 127,
    right: clampInt(right * 127, -127, 127) / 127,
    yaw: Math.fround(yaw),
    pitch: Math.fround(pitch),
  };
}

export function encodeInput(frames: InputFrame[]): Uint8Array<ArrayBuffer> {
  const n = Math.min(255, frames.length);
  const buf = new ArrayBuffer(2 + n * 15);
  const v = new DataView(buf);
  v.setUint8(0, INPUT);
  v.setUint8(1, n);
  let o = 2;
  for (let i = 0; i < n; i++) {
    const [seq, forward, right, flags, yaw, pitch] = frames[i];
    v.setUint32(o, seq >>> 0, true);
    v.setInt8(o + 4, clampInt(forward * 127, -127, 127));
    v.setInt8(o + 5, clampInt(right * 127, -127, 127));
    v.setUint8(o + 6, flags & 0xff);
    v.setFloat32(o + 7, yaw, true);
    v.setFloat32(o + 11, pitch, true);
    o += 15;
  }
  return new Uint8Array(buf);
}

/** a binary frame from a browser; throws on anything malformed (the server drops it) */
export function decodeClient(data: ArrayBuffer | ArrayBufferView): ClientMsg {
  const v = view(data);
  if (v.getUint8(0) !== INPUT) throw new RangeError(`unknown client message ${v.getUint8(0)}`);
  const n = v.getUint8(1);
  if (v.byteLength < 2 + n * 15) throw new RangeError('short input');
  const i: InputFrame[] = [];
  let o = 2;
  for (let k = 0; k < n; k++) {
    i.push([
      v.getUint32(o, true),
      v.getInt8(o + 4) / 127,
      v.getInt8(o + 5) / 127,
      v.getUint8(o + 6),
      v.getFloat32(o + 7, true),
      v.getFloat32(o + 11, true),
    ]);
    o += 15;
  }
  return { t: 'input', i };
}

function view(data: ArrayBuffer | ArrayBufferView): DataView {
  return data instanceof ArrayBuffer ? new DataView(data) : new DataView(data.buffer, data.byteOffset, data.byteLength);
}

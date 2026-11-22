// The browser's end of the data channel to the game server (server/rtc.ts): an unordered channel
// that never resends, for snapshots, acks and input frames. Signalling goes over the WebSocket.
// If it can't open (UDP blocked, the server has them off), the game just stays on the WebSocket.

import type { ClientMsg } from '../shared/protocol';

/**
 * websocket: not tried yet / not wanted · trying: asked the server, waiting for it to open ·
 * open: in use · failed: the server offered one but it never connected (UDP blocked?) ·
 * off: the server didn't offer one · unsupported: this browser has no WebRTC
 */
export type LinkState = 'websocket' | 'trying' | 'open' | 'failed' | 'off' | 'unsupported';

/** give up and stay on the WebSocket if the channel isn't open by then */
const OPEN_TIMEOUT_MS = 6000;
/** don't queue more than this: anything older is stale by the time it'd go out */
const MAX_BUFFERED = 16 * 1024;

export class BrowserFastLink {
  state: LinkState = 'websocket';
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private timer = 0;
  private offered = false;

  constructor(
    private signal: (m: ClientMsg) => void,
    private onData: (data: ArrayBuffer) => void,
    private onState: () => void,
  ) {}

  get open(): boolean {
    return this.state === 'open' && this.dc?.readyState === 'open';
  }

  /** ask the server for a channel */
  request(): void {
    if (typeof RTCPeerConnection === 'undefined') return this.set('unsupported');
    this.set('trying');
    this.signal({ t: 'rtc' });
    this.timer = window.setTimeout(() => {
      if (this.state !== 'trying') return;
      const offered = this.offered;
      this.close();
      this.set(offered ? 'failed' : 'off');
    }, OPEN_TIMEOUT_MS);
  }

  /** the server's offer: answer it */
  async offer(sdp: string): Promise<void> {
    if (this.state !== 'trying' || this.pc) return;
    this.offered = true;
    const pc = new RTCPeerConnection({ iceServers: [] }); // the server has a reachable address: no STUN/TURN needed
    this.pc = pc;
    pc.onicecandidate = (e) => {
      if (e.candidate?.candidate) this.signal({ t: 'ice', c: e.candidate.candidate, mid: e.candidate.sdpMid ?? '0' });
    };
    pc.ondatachannel = (e) => {
      const dc = e.channel;
      dc.binaryType = 'arraybuffer';
      this.dc = dc;
      dc.onopen = () => {
        if (this.pc !== pc) return;
        clearTimeout(this.timer);
        this.set('open');
      };
      dc.onclose = () => {
        if (this.pc === pc && this.state === 'open') this.set('failed');
      };
      dc.onmessage = (m) => {
        if (m.data instanceof ArrayBuffer) this.onData(m.data);
      };
    };
    pc.onconnectionstatechange = () => {
      if (this.pc === pc && (pc.connectionState === 'failed' || pc.connectionState === 'closed') && this.state === 'open') this.set('failed');
    };
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (this.pc === pc) this.signal({ t: 'rtc', sdp: answer.sdp ?? '' });
    } catch {
      this.close();
      this.set('failed');
    }
  }

  /** one of the server's ICE candidates */
  candidate(c: string, mid: string): void {
    this.pc?.addIceCandidate({ candidate: c, sdpMid: mid }).catch(() => {});
  }

  /** send if open and not backed up; false means use the WebSocket */
  send(data: Uint8Array<ArrayBuffer>): boolean {
    const dc = this.dc;
    if (!this.open || !dc || dc.bufferedAmount > MAX_BUFFERED) return false;
    try {
      dc.send(data);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    clearTimeout(this.timer);
    this.dc?.close();
    this.pc?.close();
    this.dc = null;
    this.pc = null;
    if (this.state === 'open' || this.state === 'trying') this.state = 'websocket';
  }

  private set(s: LinkState): void {
    this.state = s;
    this.onState();
  }
}

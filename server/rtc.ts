// A WebRTC data channel from each browser straight to this server, for the messages that go stale
// in 50 ms: snapshots and acks down, input frames up. It's unordered and never resends, so a lost
// packet is just skipped instead of holding up everything behind it the way TCP does (see #21's
// measurements). Everything else stays on the WebSocket. The server is the other end of the
// connection, so it still decides movement and hits; no relay between players is involved.
//
// The browser asks for a channel after joining; we send an offer, it answers, and both sides trade
// ICE candidates, all over the WebSocket. If the channel never opens (UDP blocked), the browser
// carries on over the WebSocket.
//
// One UDP port carries every channel (ICE UDP mux), so a firewall or platform only has to open one.

import { PeerConnection, type DataChannel } from 'node-datachannel';
import type { ServerMsg } from '../shared/protocol';

export interface RtcOptions {
  /** the UDP port every data channel uses */
  port: number;
  /** address to tell browsers to send to, when it isn't one of this machine's own (NAT, a platform proxy) */
  publicIp: string | null;
  /** local address to bind the UDP port to (default: all) */
  bindAddress: string | null;
}

/** don't queue more than this: anything older is stale by the time it'd go out */
const MAX_BUFFERED = 16 * 1024;

export class FastLink {
  private pc: PeerConnection;
  private dc: DataChannel;
  open = false;
  private closed = false;

  constructor(
    name: string,
    private opts: RtcOptions,
    /** send a signalling message to the browser over the WebSocket */
    private signal: (m: ServerMsg) => void,
    onMessage: (data: Buffer) => void,
    onOpenChange: (open: boolean) => void,
  ) {
    this.pc = new PeerConnection(name, {
      iceServers: [],
      enableIceUdpMux: true,
      portRangeBegin: opts.port,
      portRangeEnd: opts.port,
      ...(opts.bindAddress ? { bindAddress: opts.bindAddress } : {}),
    });
    this.pc.onLocalDescription((sdp, type) => {
      if (type === 'offer') this.signal({ t: 'rtc', sdp: this.rewriteSdp(sdp) });
    });
    this.pc.onLocalCandidate((candidate, mid) => {
      const c = this.rewriteCandidate(candidate);
      if (c) this.signal({ t: 'ice', c, mid });
    });
    this.pc.onStateChange((state) => {
      if ((state === 'failed' || state === 'closed') && this.open) {
        this.open = false;
        onOpenChange(false);
      }
    });
    // unordered, no retransmits: UDP-like delivery
    this.dc = this.pc.createDataChannel('fast', { unordered: true, maxRetransmits: 0 });
    this.dc.onOpen(() => {
      if (this.closed) return;
      this.open = true;
      onOpenChange(true);
    });
    this.dc.onClosed(() => {
      if (!this.open) return;
      this.open = false;
      onOpenChange(false);
    });
    this.dc.onMessage((msg) => {
      if (typeof msg === 'string') return;
      onMessage(Buffer.isBuffer(msg) ? msg : Buffer.from(msg));
    });
  }

  /** the browser's answer */
  answer(sdp: string): void {
    if (this.closed) return;
    try {
      this.pc.setRemoteDescription(sdp, 'answer');
    } catch {
      // garbled: the channel just won't open, and the browser stays on the WebSocket
    }
  }

  /** one of the browser's ICE candidates */
  candidate(c: string, mid: string): void {
    if (this.closed) return;
    try {
      this.pc.addRemoteCandidate(c, mid);
    } catch {
      // ignore candidates we can't use (mDNS names, other families)
    }
  }

  /** send if the channel is open and not backed up; false means use the WebSocket */
  send(data: Uint8Array): boolean {
    if (!this.open || this.dc.bufferedAmount() > MAX_BUFFERED) return false;
    try {
      return this.dc.sendMessageBinary(data);
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    try {
      this.dc.close();
      this.pc.close();
    } catch {
      // already gone
    }
  }

  // Behind NAT or a platform's proxy, this machine's own addresses aren't reachable: advertise one
  // candidate on the public address instead (the UDP mux means they all share the port anyway).
  private rewriteCandidate(raw: string): string | null {
    const c = raw.startsWith('a=') ? raw.slice(2) : raw; // browsers want "candidate:...", not the SDP line
    if (!this.opts.publicIp) return c;
    const parts = c.split(' ');
    // candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ...
    if (parts.length < 8 || parts[7] !== 'host' || parts[2].toUpperCase() !== 'UDP') return null;
    if (parts[4].includes(':') !== this.opts.publicIp.includes(':')) return null; // other address family
    parts[4] = this.opts.publicIp;
    const out = parts.join(' ');
    if (this.sentPublic) return null;
    this.sentPublic = true;
    return out;
  }
  private sentPublic = false;

  private rewriteSdp(sdp: string): string {
    if (!this.opts.publicIp) return sdp;
    // candidates go separately (trickle); drop any already in the offer so only the public one is used
    return sdp
      .split(/\r?\n/)
      .filter((l) => !l.startsWith('a=candidate:'))
      .join('\r\n');
  }
}

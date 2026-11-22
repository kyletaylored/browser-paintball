// Team voice chat in the browser, through the LiveKit media server the game server points us at
// (server/voice.ts). Optional: if the server has no voice, none of this runs and the controls stay
// hidden.
//
//  - Connects (to listen) only while you're online and at least one other human is in the match;
//    bots don't talk, so a bots-only match never touches the media server.
//  - The microphone stays closed until you first hold push-to-talk (V, d-pad up, or the Talk
//    button on a phone). That's when the browser asks for permission.
//  - Team channel during a point; everyone can hear everyone in warm-up and after a match. Your
//    own track only lets your teammates subscribe (the media server enforces that), and voices
//    from the other team are silenced on our side too.
//  - The LiveKit library (about 150 KB compressed) is only downloaded when there's someone to talk to.

import type { Participant, RemoteParticipant, Room } from 'livekit-client';
import type { RoundPhase, Team } from '../shared/protocol';

export interface VoiceSettings {
  /** voice chat on at all */
  enabled: boolean;
  /** 0..1 */
  volume: number;
}

/** off: the server has no voice · idle: no one else to talk to · connecting · on · failed */
export type VoiceState = 'off' | 'idle' | 'connecting' | 'on' | 'failed';

export interface VoicePeer {
  id: number;
  team: Team;
  bot: boolean;
}

const idOf = (identity: string) => (identity.startsWith('p') ? Number(identity.slice(1)) : NaN);
const identityOf = (id: number) => `p${id}`;

export class Voice {
  state: VoiceState = 'off';
  /** the server has voice (from its welcome) */
  available = false;
  /** player ids speaking right now (yours included while you talk) */
  readonly speaking = new Set<number>();
  /** player ids you've muted (this session) */
  readonly muted = new Set<number>();
  /** whether you're holding push-to-talk with the microphone open */
  talking = false;
  /** the team channel (during a point) or everyone (warm-up, match over) */
  teamOnly = true;
  /** something changed that the HUD shows */
  onChange: () => void = () => {};

  private room: Room | null = null;
  private lk: typeof import('livekit-client') | null = null;
  private wantTalk = false;
  private micOn = false;
  /** mic changes one at a time (they're async and can't overlap) */
  private micChain: Promise<void> = Promise.resolve();
  private myId = -1;
  private myTeam: Team = 0;
  private peers: VoicePeer[] = [];
  private permKey = '';
  private tokenWanted = false;
  private retryAt = 0;

  constructor(
    readonly settings: VoiceSettings,
    /** ask the game server for a token; it answers through gotToken() */
    private requestToken: () => void,
  ) {}

  /**
   * Call every frame while online (or once with online=false when leaving). Joins or leaves the
   * media server as people come and go, and keeps the channel rules up to date.
   */
  update(online: boolean, myId: number, myTeam: Team, peers: VoicePeer[], phase: RoundPhase | null, now: number): void {
    if (!online || !this.available) {
      if (this.room || this.state !== 'off') this.leave(this.available ? 'idle' : 'off');
      return;
    }
    this.myId = myId;
    this.myTeam = myTeam;
    this.peers = peers;
    const teamOnly = !(phase === 'waiting' || phase === 'matchover');
    if (teamOnly !== this.teamOnly) {
      this.teamOnly = teamOnly;
      this.onChange();
    }
    const others = peers.some((p) => !p.bot && p.id !== myId);
    if (!this.settings.enabled || !others) {
      if (this.room || this.state === 'connecting') this.leave('idle');
      else if (this.state !== 'idle') this.set('idle');
      return;
    }
    if (!this.room && !this.tokenWanted && now >= this.retryAt) {
      this.tokenWanted = true;
      this.set('connecting');
      this.requestToken();
    }
    if (this.room) {
      this.applyPermissions();
      this.applyVolumes();
    }
  }

  /** the game server's answer to requestToken */
  async gotToken(url: string, token: string): Promise<void> {
    if (!this.tokenWanted) return;
    this.tokenWanted = false;
    try {
      this.lk ??= await import('livekit-client');
      const { Room, RoomEvent, Track } = this.lk;
      const room = new Room({
        adaptiveStream: false,
        dynacast: false,
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach();
        el.dataset.voice = participant.identity;
        document.body.appendChild(el);
        this.applyVolumes(true);
      });
      room.on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()));
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        this.speaking.clear();
        for (const s of speakers) {
          const id = idOf(s.identity);
          if (Number.isFinite(id)) this.speaking.add(id);
        }
        if (this.talking) this.speaking.add(this.myId);
        this.onChange();
      });
      room.on(RoomEvent.ParticipantConnected, () => this.applyVolumes(true));
      room.on(RoomEvent.Disconnected, () => {
        if (this.room !== room) return;
        this.room = null;
        this.micOn = false;
        this.set('idle');
      });
      this.room = room;
      this.permKey = '';
      await room.connect(url, token, { autoSubscribe: true });
      if (this.room !== room) {
        void room.disconnect();
        return;
      }
      this.applyPermissions(); // before anything is published
      this.set('on');
      if (this.wantTalk) this.setMic(true);
    } catch (e) {
      console.warn('voice: could not connect', e);
      this.room = null;
      this.retryAt = performance.now() + 15000;
      this.set('failed');
    }
  }

  /** push-to-talk held (true) or let go (false); call every frame */
  setTalk(held: boolean): void {
    if (held === this.wantTalk) return;
    this.wantTalk = held;
    if (held) void this.room?.startAudio(); // a key press counts as a user gesture for autoplay
    if (this.room && this.state === 'on') this.setMic(held);
  }

  /** mute or unmute one player for yourself */
  toggleMute(id: number): void {
    if (this.muted.has(id)) this.muted.delete(id);
    else this.muted.add(id);
    this.applyVolumes(true);
    this.onChange();
  }

  /** settings changed (volume, on/off) */
  settingsChanged(): void {
    this.applyVolumes(true);
    if (!this.settings.enabled && this.room) this.leave('idle');
  }

  /** let the browser play audio (call from a click or key press) */
  unlock(): void {
    void this.room?.startAudio();
  }

  private setMic(on: boolean): void {
    this.micChain = this.micChain.then(async () => {
      const room = this.room;
      if (!room || on === this.micOn) return;
      try {
        // the first time, this is where the browser asks for the microphone
        await room.localParticipant.setMicrophoneEnabled(on);
        this.micOn = on;
      } catch (e) {
        console.warn('voice: microphone', e);
        this.micOn = false;
      }
      this.talking = this.micOn;
      if (this.talking) this.speaking.add(this.myId);
      else this.speaking.delete(this.myId);
      this.onChange();
    });
  }

  /** who may subscribe to our microphone: teammates during a point, everyone otherwise */
  private applyPermissions(): void {
    const room = this.room;
    if (!room || room.state !== 'connected') return;
    const mates = this.peers.filter((p) => !p.bot && p.id !== this.myId && p.team === this.myTeam).map((p) => identityOf(p.id)).sort();
    const key = this.teamOnly ? `team:${mates.join(',')}` : 'all';
    if (key === this.permKey) return;
    this.permKey = key;
    room.localParticipant.setTrackSubscriptionPermissions(
      !this.teamOnly,
      this.teamOnly ? mates.map((participantIdentity) => ({ participantIdentity, allowAll: true })) : [],
    );
  }

  /** our volume for each voice: the settings volume, silenced if muted (or the other team, during a point) */
  private lastVolumes = '';
  private applyVolumes(force = false): void {
    const room = this.room;
    if (!room) return;
    const teamOf = new Map(this.peers.map((p) => [p.id, p.team]));
    const parts: RemoteParticipant[] = [...room.remoteParticipants.values()];
    const vols = parts.map((rp) => {
      const id = idOf(rp.identity);
      const team = teamOf.get(id) ?? (Number(rp.attributes?.team) as Team);
      const audible = this.settings.enabled && !this.muted.has(id) && (!this.teamOnly || team === this.myTeam);
      return audible ? this.settings.volume : 0;
    });
    const key = parts.map((rp, i) => `${rp.identity}:${vols[i]}`).join(',');
    if (!force && key === this.lastVolumes) return;
    this.lastVolumes = key;
    parts.forEach((rp, i) => rp.setVolume(vols[i]));
  }

  private leave(next: VoiceState): void {
    const room = this.room;
    this.room = null;
    this.tokenWanted = false;
    this.micOn = this.talking = false;
    this.speaking.clear();
    this.permKey = '';
    void room?.disconnect();
    document.querySelectorAll('audio[data-voice]').forEach((el) => el.remove());
    this.set(next);
  }

  private set(s: VoiceState): void {
    if (this.state === s) return;
    this.state = s;
    this.onChange();
  }
}

// Team voice chat, through a LiveKit media server (an SFU: each player sends one audio stream to it
// and it forwards streams to whoever may hear them). It's optional: with the three variables below
// unset, voice is off and the game runs exactly as before.
//
// This server stays in charge of who's in the match and on which team. It hands each player a
// short-lived token for the media server that fixes their identity (p<id>, matching the game's
// player ids), their name and their team; the browser can't change those. See docs/DEPLOY.md.

import { createHmac } from 'node:crypto';
import type { Team } from '../shared/protocol';

export interface VoiceConfig {
  /** where browsers connect, e.g. wss://voice.example.com */
  url: string;
  key: string;
  secret: string;
  room: string;
}

/** read LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET; null (voice off) unless all three are set */
export function voiceConfig(env: NodeJS.ProcessEnv): VoiceConfig | null {
  const url = env.LIVEKIT_URL?.trim();
  const key = env.LIVEKIT_API_KEY?.trim();
  const secret = env.LIVEKIT_API_SECRET?.trim();
  if (!url || !key || !secret) return null;
  return { url, key, secret, room: env.VOICE_ROOM?.trim() || 'splat-arena' };
}

/** tokens only have to last until the browser has connected; the media server refreshes them after that */
export const TOKEN_SECONDS = 10 * 60;

/** the media server identity for a game player */
export const voiceIdentity = (id: number) => `p${id}`;

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

/**
 * A LiveKit access token (a JWT signed with the API secret) that lets player `id` join the voice
 * room, publish their microphone and listen. Their team goes in as an attribute the browser can't
 * change, so other browsers know whose voice they may hear.
 */
export function voiceToken(cfg: VoiceConfig, id: number, name: string, team: Team, now = Math.floor(Date.now() / 1000)): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: cfg.key,
    sub: voiceIdentity(id),
    name,
    nbf: now - 10,
    exp: now + TOKEN_SECONDS,
    video: {
      room: cfg.room,
      roomJoin: true,
      canPublish: true,
      canPublishSources: ['microphone'],
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
    },
    attributes: { team: String(team) },
  };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createHmac('sha256', cfg.secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

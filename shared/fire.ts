// Firing modes: how pulling the trigger turns into paintballs. The mode is part of the game, so
// everyone on a server plays the same one: the server picks it (players vote), tells the browsers,
// and holds every shooter to its rate. The trigger logic is here, with no DOM, so the browser, the
// bots and the tests all use the same rules.
//
//   ramp   one ball per pull, until you've pulled three times quickly in a row: then holding the
//          trigger keeps firing, 10 balls a second, until you let go
//   semi   a mechanical marker: one ball every time you pull, never more than 10 a second
//   pump   one ball, then a pump stroke before the next; a small tube to load

import { FIRE_INTERVAL } from './sim';

export type FireMode = 'ramp' | 'semi' | 'pump';
export const FIRE_MODES: readonly FireMode[] = ['ramp', 'semi', 'pump'];
export const DEFAULT_FIRE_MODE: FireMode = 'ramp';
export const isFireMode = (v: unknown): v is FireMode => typeof v === 'string' && (FIRE_MODES as readonly string[]).includes(v);

/** pulls that come this close together (seconds) count as "in a row" for ramping */
export const RAMP_GAP = 0.3;
/** pulls in a row before holding the trigger keeps firing */
export const RAMP_PULLS = 3;
/** one pump stroke: the shortest time between two pump shots */
export const PUMP_STROKE = 0.5;

export interface ModeRules {
  name: string;
  /** one line for the menus */
  blurb: string;
  /** the shortest time between two balls (the server enforces it) */
  interval: number;
  /** balls per load */
  hopper: number;
  /** how bots fire: balls per burst (min, max), and the time between balls in a burst */
  botBurst: [number, number];
  botGap: number;
}

export const MODE_RULES: Readonly<Record<FireMode, ModeRules>> = {
  ramp: {
    name: 'Ramp',
    blurb: 'One ball per pull. Pull three times quickly and you can hold the trigger for 10 a second.',
    interval: FIRE_INTERVAL, hopper: 200, botBurst: [3, 8], botGap: FIRE_INTERVAL,
  },
  semi: {
    name: 'Semi-auto',
    blurb: 'A mechanical marker: one ball every time you pull the trigger. Holding it does nothing.',
    interval: FIRE_INTERVAL, hopper: 200, botBurst: [2, 4], botGap: 1 / 6,
  },
  pump: {
    name: 'Pump',
    blurb: 'One ball, then pump for the next. A 20-ball tube, so make every shot count.',
    interval: PUMP_STROKE, hopper: 20, botBurst: [1, 2], botGap: PUMP_STROKE + 0.15,
  },
};

/**
 * The trigger, one frame at a time: update(dt, held) says how many balls to fire this frame.
 * A pull while the marker is still cycling is remembered and fires as soon as it can (ramp and
 * semi); on a pump it's lost, as you can't fire mid-stroke.
 */
export class Trigger {
  mode: FireMode = DEFAULT_FIRE_MODE;
  /** time until the marker can fire again */
  private cooldown = 0;
  private held = false;
  private queued = false;
  /** pulls in a row (each within RAMP_GAP of the last) and the time since the last one */
  private pulls = 0;
  private sincePull = Infinity;

  /** ramping: holding the trigger keeps firing */
  get ramping(): boolean {
    return this.mode === 'ramp' && this.held && this.pulls >= RAMP_PULLS;
  }

  /** the pump is mid-stroke (pump mode, just fired) */
  get pumping(): boolean {
    return this.mode === 'pump' && this.cooldown > 0;
  }

  /** forget everything (respawn, menu, mode change) */
  reset(): void {
    this.cooldown = 0;
    this.held = this.queued = false;
    this.pulls = 0;
    this.sincePull = Infinity;
  }

  update(dt: number, held: boolean): number {
    const rules = MODE_RULES[this.mode];
    this.cooldown -= dt;
    this.sincePull += dt;
    if (held && !this.held) {
      this.pulls = this.sincePull <= RAMP_GAP ? this.pulls + 1 : 1;
      this.sincePull = 0;
      if (this.mode !== 'pump' || this.cooldown <= 0) this.queued = true;
    }
    this.held = held;
    let shots = 0;
    while (this.cooldown <= 0 && (this.queued || this.ramping)) {
      this.queued = false;
      shots++;
      this.cooldown += rules.interval;
    }
    if (this.cooldown < 0) this.cooldown = 0; // no saving up shots while nothing's pulled
    return shots;
  }
}

/**
 * Votes for the firing mode (humans; null = no preference): a different mode wins with more than
 * half of all the humans behind it. Otherwise the current one stays.
 */
export function modeVoteWinner(votes: readonly (FireMode | null)[], current: FireMode): FireMode {
  for (const m of FIRE_MODES) {
    if (m === current) continue;
    if (votes.filter((v) => v === m).length * 2 > votes.length) return m;
  }
  return current;
}

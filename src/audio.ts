// Sound. Every effect is synthesised in code into an AudioBuffer when audio starts, so there are no
// asset files yet; swap any of them for a recorded sample later by decoding a file into SOUNDS[name].
//
// three's AudioListener rides on the camera and keeps the Web Audio listener's position and
// orientation in sync with it. 3D sounds get their own PannerNode at a world position, so you can
// hear where shots and footsteps are coming from.
//
// Browsers only allow audio to start from a user gesture, so nothing is created until unlock().

import * as THREE from 'three';

export type SoundName =
  | 'shot' | 'splat' | 'hit' | 'confirm' | 'out' | 'step' | 'reload' | 'reloadDone' | 'dry' | 'beep' | 'go' | 'horn'
  | 'whizz' | 'bounce';

interface PlayOpts {
  /** 0..1+, multiplied with the master volume */
  volume?: number;
  /** playback rate; default adds a little random variation so repeats don't sound mechanical */
  rate?: number;
}

const MAX_VOICES = 48;
const STORE_KEY = 'splat-arena.audio';

export class SoundSystem {
  private listener: THREE.AudioListener | null = null;
  private buffers: Partial<Record<SoundName, AudioBuffer>> = {};
  private voices = 0;
  private _volume = 0.8;
  private _muted = false;

  constructor(private camera: THREE.Camera) {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
      if (saved && typeof saved.volume === 'number') this._volume = Math.min(1, Math.max(0, saved.volume));
      if (saved && typeof saved.muted === 'boolean') this._muted = saved.muted;
    } catch {
      // storage blocked (private window etc.): keep defaults
    }
  }

  get volume(): number {
    return this._volume;
  }
  get muted(): boolean {
    return this._muted;
  }

  setVolume(v: number): void {
    this._volume = Math.min(1, Math.max(0, v));
    this.applyMaster();
    this.save();
  }

  setMuted(m: boolean): void {
    this._muted = m;
    this.applyMaster();
    this.save();
  }

  /** call from a click/keydown handler */
  unlock(): void {
    if (!this.listener) {
      this.listener = new THREE.AudioListener();
      this.camera.add(this.listener);
      this.buffers = buildSounds(this.listener.context);
      this.applyMaster();
    }
    if (this.listener.context.state === 'suspended') void this.listener.context.resume();
  }

  /** a sound with no position: your own marker, UI cues */
  play(name: SoundName, opts: PlayOpts = {}): void {
    const v = this.voice(name, opts);
    if (!v) return;
    v.out.connect(this.listener!.getInput());
  }

  /** a sound at a point in the world */
  playAt(name: SoundName, x: number, y: number, z: number, opts: PlayOpts = {}): void {
    const v = this.voice(name, opts);
    if (!v) return;
    const ctx = this.listener!.context;
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 3;
    p.rolloffFactor = 1.1;
    p.maxDistance = 90;
    if (p.positionX) {
      p.positionX.value = x;
      p.positionY.value = y;
      p.positionZ.value = z;
    } else {
      p.setPosition(x, y, z);
    }
    v.out.connect(p);
    p.connect(this.listener!.getInput());
    v.src.addEventListener('ended', () => p.disconnect());
  }

  private voice(name: SoundName, opts: PlayOpts): { src: AudioBufferSourceNode; out: GainNode } | null {
    const l = this.listener;
    const buf = this.buffers[name];
    if (!l || !buf || l.context.state !== 'running' || this._muted || this.voices >= MAX_VOICES) return null;
    const ctx = l.context;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opts.rate ?? 0.94 + Math.random() * 0.12;
    const out = ctx.createGain();
    out.gain.value = opts.volume ?? 1;
    src.connect(out);
    this.voices++;
    src.addEventListener('ended', () => {
      this.voices--;
      out.disconnect();
    });
    src.start();
    return { src, out };
  }

  private applyMaster(): void {
    this.listener?.setMasterVolume(this._muted ? 0 : this._volume);
  }

  private save(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ volume: this._volume, muted: this._muted }));
    } catch {
      // ignore
    }
  }
}

/** turns distance walked into footstep events */
export class Footsteps {
  private dist = 0;
  constructor(private stride = 1.75) {}

  /** returns true when a foot lands */
  update(moved: number, onGround: boolean): boolean {
    if (!onGround || moved <= 0) return false;
    this.dist += moved;
    if (this.dist < this.stride) return false;
    this.dist %= this.stride;
    return true;
  }
}

// ---- synthesis ------------------------------------------------------------------------------

const TAU = Math.PI * 2;

function buildSounds(ctx: BaseAudioContext): Record<SoundName, AudioBuffer> {
  const sr = ctx.sampleRate;
  const make = (seconds: number, fill: (d: Float32Array, sr: number) => void): AudioBuffer => {
    const buf = ctx.createBuffer(1, Math.ceil(seconds * sr), sr);
    const d = buf.getChannelData(0);
    fill(d, sr);
    normalize(d, 0.9);
    return buf;
  };

  return {
    // pneumatic pop: a falling low thump, a puff of filtered air and a short bright crack
    shot: make(0.2, (d, sr) => {
      let lp = 0;
      let phase = 0;
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const n = Math.random() * 2 - 1;
        lp += (n - lp) * 0.3;
        phase += (TAU * (55 + 150 * Math.exp(-t * 32))) / sr;
        const thump = Math.sin(phase) * Math.exp(-t * 26);
        const air = lp * Math.exp(-t * 38);
        const crack = (n - lp) * Math.exp(-t * 140);
        d[i] = thump * 0.9 + air * 0.7 + crack * 0.45;
      }
    }),

    // wet splat: soft attack, low filtered noise, a little squelch and a few droplets after
    splat: make(0.3, (d, sr) => {
      let lp = 0;
      let phase = 0;
      const drops = Array.from({ length: 4 }, () => 0.05 + Math.random() * 0.2);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const n = Math.random() * 2 - 1;
        lp += (n - lp) * 0.12;
        const body = lp * Math.min(1, t / 0.003) * Math.exp(-t * 16);
        phase += (TAU * (130 + 320 * Math.exp(-t * 28))) / sr;
        const squelch = Math.sin(phase) * Math.exp(-t * 30) * 0.35;
        let drip = 0;
        for (const t0 of drops) if (t > t0) drip += Math.sin(TAU * 900 * (t - t0)) * Math.exp(-(t - t0) * 90) * 0.12;
        d[i] = body * 1.6 + squelch + drip;
      }
    }),

    // paint flying past your head: a quick airy rush that swells and falls away, dropping in pitch
    whizz: make(0.22, (d, sr) => {
      let lp = 0;
      let bp = 0;
      let phase = 0;
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const n = Math.random() * 2 - 1;
        // a resonant band of noise whose centre falls (the doppler drop as it goes by)
        const f = 2600 - 1700 * Math.min(1, t / 0.2);
        const k = Math.min(0.9, (TAU * f) / sr);
        lp += (n - lp) * k;
        bp += (lp - bp) * k * 0.5;
        phase += (TAU * f * 0.5) / sr;
        const env = Math.exp(-(((t - 0.07) / 0.045) ** 2)); // rises and falls, peaking as it passes
        d[i] = ((lp - bp) * 1.4 + Math.sin(phase) * 0.12) * env;
      }
    }),

    // paint bouncing off without breaking: a short rubbery tock
    bounce: make(0.09, (d, sr) => {
      let phase = 0;
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        phase += (TAU * (420 + 520 * Math.exp(-t * 90))) / sr;
        const n = Math.random() * 2 - 1;
        d[i] = Math.sin(phase) * Math.exp(-t * 55) + n * Math.exp(-t * 400) * 0.35;
      }
    }),

    // ball on a player: drier and punchier than a splat
    hit: make(0.16, (d, sr) => {
      let lp = 0;
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const n = Math.random() * 2 - 1;
        lp += (n - lp) * 0.25;
        d[i] = lp * Math.exp(-t * 40) * 1.2 + Math.sin(TAU * 170 * t) * Math.exp(-t * 22) * 0.8;
      }
    }),

    // you eliminated someone: two rising notes
    confirm: make(0.34, (d, sr) => {
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        let s = 0;
        for (const [t0, f] of [[0, 880], [0.08, 1318.5]] as const) {
          if (t < t0) continue;
          const u = t - t0;
          s += (Math.sin(TAU * f * u) + Math.sin(TAU * f * 2 * u) * 0.25) * Math.exp(-u * 18) * Math.min(1, u / 0.004);
        }
        d[i] = s;
      }
    }),

    // you're out: a falling, wobbling tone
    out: make(0.7, (d, sr) => {
      let phase = 0;
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        phase += (TAU * (460 * Math.exp(-t * 1.6) + 12 * Math.sin(TAU * 7 * t))) / sr;
        const env = Math.min(1, t / 0.01) * Math.exp(-t * 3.2);
        d[i] = (Math.sin(phase) + Math.sin(phase * 0.5) * 0.4) * env;
      }
    }),

    // footstep on turf: a soft low thud
    step: make(0.1, (d, sr) => {
      let lp = 0;
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const n = Math.random() * 2 - 1;
        lp += (n - lp) * 0.06;
        d[i] = lp * 4 * Math.exp(-t * 45) + Math.sin(TAU * 75 * t) * Math.exp(-t * 50) * 0.5;
      }
    }),

    // hopper lid open, balls rattling in
    reload: make(1.1, (d, sr) => {
      const clicks: [number, number][] = [[0, 1], [0.1, 0.7]];
      for (let k = 0; k < 26; k++) clicks.push([0.22 + Math.random() * 0.8, 0.15 + Math.random() * 0.25]);
      addClicks(d, sr, clicks);
    }),

    // lid shut
    reloadDone: make(0.12, (d, sr) => addClicks(d, sr, [[0, 1], [0.035, 0.55]])),

    // trigger pulled with nothing to fire
    dry: make(0.06, (d, sr) => addClicks(d, sr, [[0, 1]])),

    // countdown: three short beeps, then a longer higher one
    beep: make(0.16, (d, sr) => tone(d, sr, 880, 0.12)),
    go: make(0.5, (d, sr) => tone(d, sr, 1320, 0.42)),

    // point over: a buzzy two-note horn
    horn: make(0.9, (d, sr) => {
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const env = Math.min(1, t / 0.02) * Math.min(1, (0.85 - t) / 0.15);
        let s = 0;
        for (const f of [220, 277.2]) for (let h = 1; h <= 5; h++) s += Math.sin(TAU * f * h * t) / h;
        d[i] = s * Math.max(0, env);
      }
    }),
  };
}

function tone(d: Float32Array, sr: number, f: number, len: number): void {
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.005) * Math.max(0, Math.min(1, (len - t) / 0.03));
    d[i] = (Math.sin(TAU * f * t) + Math.sin(TAU * f * 2 * t) * 0.2) * env;
  }
}

function addClicks(d: Float32Array, sr: number, clicks: [number, number][]): void {
  for (const [t0, amp] of clicks) {
    const start = Math.floor(t0 * sr);
    const f = 1800 + Math.random() * 1600;
    for (let i = start; i < Math.min(d.length, start + Math.floor(0.03 * sr)); i++) {
      const u = (i - start) / sr;
      d[i] += ((Math.random() * 2 - 1) * 0.6 + Math.sin(TAU * f * u)) * Math.exp(-u * 260) * amp;
    }
  }
}

function normalize(d: Float32Array, peak: number): void {
  let m = 0;
  for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
  if (m > 0) for (let i = 0; i < d.length; i++) d[i] *= peak / m;
}

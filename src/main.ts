// Boot + game loop. Physics runs at a fixed 120 Hz no matter the frame rate, so movement and
// ball flight behave the same on a 60 Hz laptop and a 240 Hz monitor.

import * as THREE from 'three';
import { createRenderer, createComposer } from './render';
import { buildWorld } from './world';
import { field, setMap, spawnPoint } from '../shared/field';
import { MAP_LIST } from '../shared/maps';
import { Input, TOUCH } from './input';
import { TouchControls } from './touch';
import { Menu, type MenuAction } from './menu';
import type { PadSettings } from './gamepad';
import { LocalPlayer } from './player';
import { Paintballs, type Target, type BallEvents } from './paintballs';
import { Fx } from './fx';
import { makeAvatar, fieldOutfit, type Avatar } from './avatars';
import { StarBursts } from './stars';
import { loadModels } from './models';
import { Hud } from './hud';
import { SoundSystem, Footsteps } from './audio';
import { Nameplates, type PlateTarget } from './nameplates';
import { Prediction } from './prediction';
import { Spectator } from './spectate';
import { Director } from './director';
import { waitLine } from '../shared/walkoff';
import { Net, sampleRemote, phaseSecondsLeft } from './net';
import { NetStats } from './netstats';
import { Voice, type VoiceSettings } from './voice';
import { ballSpeed, STAND_HEIGHT, stanceHeight, CLIENT_SEND_HZ, RESPAWN_SECONDS, INPUT_DT, INTERP_DELAY } from '../shared/sim';
import { DEFAULT_PORT, TEAM_COLORS, TEAM_NAMES, cleanName, type RoundPhase, type V3 } from '../shared/protocol';
import { Trigger, MODE_RULES, DEFAULT_FIRE_MODE, isFireMode, type FireMode } from '../shared/fire';

const STEP = INPUT_DT; // the server replays our movement in steps of exactly this
const RELOAD_SECONDS = 1.6;
const SPREAD = 0.012;
const INTERP_DELAY_MS = INTERP_DELAY * 1000; // the server's lag compensation assumes this exact delay

/** development only: ?hitboxes shows where the server tested each hit (after rewinding for lag) */
const SHOW_HITBOXES = import.meta.env.DEV && new URLSearchParams(location.search).has('hitboxes');
const hitboxMat = new THREE.MeshBasicMaterial({ color: 0xffff00, wireframe: true, transparent: true, opacity: 0.8, depthTest: false });
function showHitbox(tp: [number, number, number, number]) {
  const [x, y, z, h] = tp;
  const r = 0.32;
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.01, h - 2 * r), 4, 10), hitboxMat);
  m.position.set(x, y + h / 2, z);
  m.renderOrder = 10;
  scene.add(m);
  setTimeout(() => {
    scene.remove(m);
    m.geometry.dispose();
  }, 2000);
}

// ---- setup --------------------------------------------------------------------------------

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = createRenderer(canvas);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 400);
scene.add(camera); // the gun is a child of the camera, so the camera must be in the scene
const hud = new Hud();
// models first (behind the loading bar); if they fail, everything falls back to shapes drawn in code
const models = await loadModels((f) => hud.setLoading(f));
hud.setLoading(null);
let world = buildWorld(scene, models);
const composer = createComposer(renderer, scene, camera);

// controller settings live in this browser (start screen: sensitivity, invert Y, vibration)
const PAD_KEY = 'splat-arena.pad';
const padSettings: PadSettings = { sensitivity: 1, invertY: false, vibration: true };
try {
  Object.assign(padSettings, pickPadSettings(JSON.parse(localStorage.getItem(PAD_KEY) ?? '{}')));
} catch {
  // storage blocked or garbled: defaults
}
function pickPadSettings(v: unknown): Partial<PadSettings> {
  if (!v || typeof v !== 'object') return {};
  const o = v as Record<string, unknown>;
  const out: Partial<PadSettings> = {};
  if (typeof o.sensitivity === 'number' && o.sensitivity >= 0.3 && o.sensitivity <= 3) out.sensitivity = o.sensitivity;
  if (typeof o.invertY === 'boolean') out.invertY = o.invertY;
  if (typeof o.vibration === 'boolean') out.vibration = o.vibration;
  return out;
}

const input = new Input(canvas, padSettings);
hud.bindPadSettings(padSettings, () => {
  try {
    localStorage.setItem(PAD_KEY, JSON.stringify(padSettings));
  } catch {
    // ignore
  }
});
hud.bindMenuButton(() => input.stop());
// on a touch screen: move, aim and fire from the screen (hidden while a controller is connected)
if (TOUCH) {
  input.touch = new TouchControls(document.getElementById('hud')!, {
    crouch: (down) => input.touchStance('crouch', down),
    prone: (down) => input.touchStance('prone', down),
  });
}
hud.bindQuality();
// the field picker on the main menu: shows the field behind the menu, and practice plays on it
hud.bindMapPicker((id) => {
  if (mode !== 'online') switchMap(id);
  refreshField(); // says what Play online will do with it
});
// online, the pause menu's vote (the server tells everyone through the roster)
hud.bindVote((id) => net.send({ t: 'vote', map: id }));
input.onPadLost = () => hud.toast('Controller disconnected · paused');

// voice chat settings live in this browser too (Settings: on/off, voices volume)
const VOICE_KEY = 'splat-arena.voice';
const voiceSettings: VoiceSettings = { enabled: true, volume: 0.9 };
try {
  const v = JSON.parse(localStorage.getItem(VOICE_KEY) ?? '{}') as Record<string, unknown>;
  if (typeof v.enabled === 'boolean') voiceSettings.enabled = v.enabled;
  if (typeof v.volume === 'number' && v.volume >= 0 && v.volume <= 1) voiceSettings.volume = v.volume;
} catch {
  // storage blocked or garbled: defaults
}
const player = new LocalPlayer(camera, models?.marker ?? null, models?.pumpMarker ?? null);
player.setFigure(scene, (team) => makeAvatar(models, TEAM_COLORS[team]));

// first or third person, remembered in this browser (Settings, H, or click the right stick)
const VIEW_KEY = 'splat-arena.view';
try {
  if (localStorage.getItem(VIEW_KEY) === 'third') player.view = 'third';
} catch {
  // storage blocked: first person
}
function setView(v: string, announce: boolean) {
  player.view = v === 'third' ? 'third' : 'first';
  hud.setView(player.view);
  if (announce) hud.toast(player.view === 'third' ? 'Third person' : 'First person');
  try {
    localStorage.setItem(VIEW_KEY, player.view);
  } catch {
    // ignore
  }
}
hud.bindView(player.view, (v) => setView(v, false));

// which shoulder in third person, remembered too (Settings, Q, d-pad left / right)
const SHOULDER_KEY = 'splat-arena.shoulder';
try {
  const s = localStorage.getItem(SHOULDER_KEY);
  if (s === 'left' || s === 'auto') player.shoulder = s;
} catch {
  // storage blocked: right
}
function saveShoulder() {
  hud.setShoulder(player.shoulder);
  try {
    localStorage.setItem(SHOULDER_KEY, player.shoulder);
  } catch {
    // ignore
  }
}
hud.bindShoulder(player.shoulder, (v) => {
  player.shoulder = v === 'left' || v === 'auto' ? v : 'right';
  saveShoulder();
});
const balls = new Paintballs(scene);
const fx = new Fx(scene);
const stars = new StarBursts(scene);
balls.setStyle(field.map.theme.shots ?? 'paint');
const sound = new SoundSystem(camera);
player.placeAt(spawnPoint(0, 2));

// browsers only let audio start from a click or key press (the menu buttons count)
canvas.addEventListener('click', () => sound.unlock());
document.getElementById('menu')!.addEventListener('click', () => {
  sound.unlock();
  voice.unlock();
});
hud.bindAudio(sound);

// mix levels (each synthesised sound is normalised, so these set the balance)
const VOL = { beep: 0.4, horn: 0.35, shot: 0.5, remoteShot: 0.9, splat: 0.55, hit: 0.9, confirm: 0.5, out: 0.55, step: 0.22, remoteStep: 0.5, reload: 0.45, dry: 0.5, whizz: 0.75, bounce: 0.45 };
const myFeet = new Footsteps();
const plates = new Nameplates(document.getElementById('plates')!);
const prediction = new Prediction();

// ---- your name ------------------------------------------------------------------------------

const NAME_KEY = 'splat-arena.name';
let myName = '';
try {
  myName = cleanName(localStorage.getItem(NAME_KEY));
} catch {
  // storage blocked: no remembered name
}
hud.bindName(myName, (typed) => {
  myName = cleanName(typed);
  try {
    localStorage.setItem(NAME_KEY, myName);
  } catch {
    // ignore
  }
  net.sendName();
});

// the firing mode: online the server's; practice, the one picked on the main menu (remembered here)
const MODE_KEY = 'splat-arena.mode';
let savedMode: FireMode = DEFAULT_FIRE_MODE;
try {
  const v = localStorage.getItem(MODE_KEY);
  if (isFireMode(v)) savedMode = v;
} catch {
  // storage blocked: the default
}
const trigger = new Trigger();
trigger.mode = savedMode;
player.hold(savedMode === 'pump' ? 'pump' : 'marker');
/** balls per load for the mode being played */
const hopperSize = () => MODE_RULES[trigger.mode].hopper;
let hopper = hopperSize();
let reloadLeft = 0;
// the marker (firing mode) chooser: practice plays it, and online it's your vote once you change it
hud.bindModePicker(savedMode, (m) => {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    // ignore
  }
  if (net.status === 'online' && net.modeVotes) net.send({ t: 'mode', mode: m });
});
hud.bindModeVote((m) => net.send({ t: 'mode', mode: m }));
let outUntil = 0;
/** when you were last hit (performance.now ms), for when to start spectating */
let outAt = 0;
const spectator = new Spectator();
const director = new Director();
/** paint each bunker has taken this point (for the "most paint" shot between points) */
let paintHits: number[] = [];
/** out this long (ms) without reaching the side line, and you start watching a teammate anyway */
const SPECTATE_AFTER_MS = 2500;
let practiceHits = 0;

// ---- practice dummies (only while there's no server) --------------------------------------

interface Dummy extends Target {
  avatar: Avatar;
  baseZ: number;
  downUntil: number;
}
const dummies: Dummy[] = field.map.targets.map(([x, z], i) => {
  const avatar = makeAvatar(models, TEAM_COLORS[1]);
  scene.add(avatar.root);
  return { id: -100 - i, team: 1, x, y: 0, z, baseZ: z, height: STAND_HEIGHT, yaw: Math.PI / 2, prone: false, alive: true, avatar, downUntil: 0 };
});

/** play on another field: rebuild the scene and move the practice targets; false if it's already on */
function switchMap(id: string): boolean {
  if (!setMap(id)) return false;
  world.dispose();
  world = buildWorld(scene, models);
  balls.clear();
  fx.clear();
  stars.clear();
  // the field's own look for shots and outfits (moonballs and space suits on the moon)
  balls.setStyle(field.map.theme.shots ?? 'paint');
  const outfit = fieldOutfit();
  for (const d of dummies) d.avatar.dress(outfit);
  for (const ra of remoteAvatars.values()) ra.avatar.dress(outfit);
  player.dressFigure(outfit);
  dummies.forEach((d, i) => {
    const [x, z] = field.map.targets[i % field.map.targets.length];
    Object.assign(d, { x, z, baseZ: z, alive: true });
  });
  hud.setMap(field.map.id);
  return true;
}
const setDummiesVisible = (v: boolean) => dummies.forEach((d) => (d.avatar.root.visible = v));

function updateDummies(now: number) {
  dummies.forEach((d, i) => {
    if (!d.alive && now >= d.downUntil) d.alive = true;
    if (d.alive) d.z = d.baseZ + Math.sin(now / 1000 * 0.8 + i * 2) * 1.2; // strafe so they're not trivial
    d.avatar.set(d.x, d.y, d.z, Math.PI / 2, 0, d.height, d.alive);
  });
}

// ---- networking ---------------------------------------------------------------------------

const remoteAvatars = new Map<number, { avatar: Avatar; target: Target; feet: Footsteps; lx: number; ly: number; lz: number; pitch: number }>();

function clearRemotes() {
  for (const ra of remoteAvatars.values()) {
    scene.remove(ra.avatar.root);
    ra.avatar.dispose();
  }
  remoteAvatars.clear();
}

// Where the game server is: VITE_SERVER_URL if the build set one (site and server on different hosts);
// otherwise the dev server's port in development, or the same host that served this page in production
// (one container serving both, see docs/DEPLOY.md).
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const serverUrl: string =
  import.meta.env.VITE_SERVER_URL ??
  (import.meta.env.DEV ? `${wsProto}://${location.hostname}:${DEFAULT_PORT}` : `${wsProto}://${location.host}`);

const net = new Net(serverUrl, {
  welcome(_id, team, spawn, map) {
    switchMap(map);
    // the field picked on the main menu is your vote (untouched, you go with whatever's on)
    if (net.votes && hud.mapTouched) net.send({ t: 'vote', map: hud.pickedMap() });
    // and so is the marker picked there
    if (net.modeVotes && hud.modeTouched) net.send({ t: 'mode', mode: hud.pickedMode() });
    hud.setModePick(net.mode);
    setFireMode(net.mode, false);
    voice.available = net.voice;
    hud.setVoiceAvailable(net.voice);
    prediction.reset();
    netStats.reset();
    player.setTeam(team);
    player.placeAt(spawn);
    player.alive = true;
    hopper = hopperSize();
    setDummiesVisible(false);
    hud.toast(`Joined the ${TEAM_NAMES[team]} team`);
  },
  ball(m) {
    remoteAvatars.get(m.owner)?.avatar.fire();
    balls.spawn(m.o, m.v, m.owner, m.team, paintOf(m.team), false);
    sound.playAt('shot', m.o[0], m.o[1], m.o[2], { volume: VOL.remoteShot });
  },
  hit(m) {
    if (SHOW_HITBOXES) showHitbox(m.tp);
    fx.burst(m.p[0], m.p[1], m.p[2], 0, 1, 0, paintOf(m.team), 20);
    if (field.map.theme.outFx === 'stars') stars.pop(m.tp[0], m.tp[1], m.tp[2], TEAM_COLORS[m.team]);
    const mine = m.victim === net.id || m.shooter === net.id;
    const shooterTeam = net.roster.get(m.shooter)?.team ?? m.team;
    const victimTeam = net.roster.get(m.victim)?.team ?? (m.team === 0 ? 1 : 0);
    // two or more quickly from the same shooter: a double (triple, …)
    const now = performance.now();
    const prev = multiElims.get(m.shooter);
    const run = prev && now - prev.at < MULTI_MS ? prev.n + 1 : 1;
    multiElims.set(m.shooter, { at: now, n: run });
    const tags = [...(run >= 2 ? [MULTI_NAMES[Math.min(run, MULTI_NAMES.length - 1)]] : []), ...(m.bounced ? ['off a bounce'] : [])];
    hud.killFeed(net.nameOf(m.shooter), shooterTeam, net.nameOf(m.victim), victimTeam, mine, tags);
    if (m.shooter === net.id && player.alive) {
      myStreak++;
      if (myStreak >= 2) hud.streak(myStreak);
    }
    if (m.victim === net.id) {
      myStreak = 0;
      hud.toast(`${net.nameOf(m.shooter)} got you`);
      player.alive = false;
      outUntil = performance.now() + RESPAWN_SECONDS * 1000;
      outAt = performance.now();
      hud.damageFlash();
      input.pad.rumble('out');
      sound.play('out', { volume: VOL.out, rate: 1 });
    }
    if (m.shooter === net.id) {
      hud.hitMarker();
      input.pad.rumble('hit');
      sound.play('confirm', { volume: VOL.confirm, rate: 1 });
      hud.toast(`You eliminated ${net.nameOf(m.victim)}`);
    }
  },
  bounce(m) {
    // a ball skipped off someone: they play on
    const team = net.roster.get(m.victim)?.team ?? 0;
    hud.feedRow([{ text: net.nameOf(m.victim), team }, { text: '· bounce, plays on', cls: 'note' }], m.victim === net.id || m.shooter === net.id);
    sound.playAt('bounce', m.p[0], m.p[1], m.p[2], { volume: VOL.bounce * 1.4 });
    if (m.victim === net.id) hud.toast('That one bounced off you · still in');
    else if (m.shooter === net.id) hud.toast(`Bounced off ${net.nameOf(m.victim)} · still in`);
  },
  ack(m) {
    // the server's word on where we are; replay what it hasn't seen yet on top
    const fix = prediction.reconcile(player.body, m.seq, m.b);
    netStats.correction(prediction.lastError);
    if (fix.snap) player.clearCorrection();
    else player.addCorrection(fix.dx, fix.dy, fix.dz);
  },
  respawn(sp) {
    player.placeAt(sp);
    player.alive = true;
    hopper = hopperSize();
    reloadLeft = 0;
  },
  mode() {
    hud.setModePick(net.mode);
    setFireMode(net.mode, true);
  },
  map(id) {
    clearRemotes();
    if (switchMap(id)) hud.toast(`New field: ${field.map.name}`);
  },
  disconnected() {
    clearRemotes();
    player.setTeam(0);
    player.placeAt(spawnPoint(0, 2));
    player.alive = true;
    hud.toast('Lost the server, back to practice');
  },
  voice(url, token) {
    void voice.gotToken(url, token);
  },
}, () => myName);
const netStats = new NetStats(net);

const voice = new Voice(voiceSettings, () => net.send({ t: 'voice' }));
hud.bindVoice(
  voiceSettings,
  () => {
    voice.settingsChanged();
    try {
      localStorage.setItem(VOICE_KEY, JSON.stringify(voiceSettings));
    } catch {
      // ignore
    }
  },
  (held) => (input.touchTalk = held),
);

function updateRemotes(now: number) {
  const at = now - INTERP_DELAY_MS;
  let dry = false;
  for (const [id, r] of net.remotes) {
    // drawing later than the newest snapshot we have: this player is frozen until the next one arrives
    const newest = r.samples[r.samples.length - 1];
    if (newest && newest.at < at) dry = true;
    let ra = remoteAvatars.get(id);
    if (!ra) {
      const avatar = makeAvatar(models, TEAM_COLORS[r.team]);
      scene.add(avatar.root);
      ra = { avatar, target: { id, team: r.team, x: 0, y: 0, z: 0, height: STAND_HEIGHT, yaw: 0, prone: false, alive: true }, feet: new Footsteps(), lx: NaN, ly: 0, lz: NaN, pitch: 0 };
      remoteAvatars.set(id, ra);
    }
    const s = sampleRemote(r, at);
    if (!s) continue;
    const h = stanceHeight(s.c, s.pr);
    ra.avatar.set(s.x, s.y, s.z, s.yaw, s.pitch, h, s.alive, s.pr);
    Object.assign(ra.target, { x: s.x, y: s.y, z: s.z, height: h, yaw: s.yaw, prone: s.pr, alive: s.alive });
    ra.pitch = s.pitch;
    // footsteps you can hear from around a bunker (crouch-walking and crawling are silent)
    const moved = Number.isNaN(ra.lx) ? 0 : Math.hypot(s.x - ra.lx, s.z - ra.lz);
    const grounded = Math.abs(s.y - ra.ly) < 0.01;
    ra.lx = s.x;
    ra.ly = s.y;
    ra.lz = s.z;
    if (moved < 1 && s.alive && !s.c && !s.pr && ra.feet.update(moved, grounded)) {
      sound.playAt('step', s.x, s.y + 0.05, s.z, { volume: VOL.remoteStep });
    }
  }
  if (net.remotes.size) netStats.frame(dry);
  for (const [id, ra] of remoteAvatars) {
    if (net.remotes.has(id)) continue;
    scene.remove(ra.avatar.root);
    ra.avatar.dispose();
    remoteAvatars.delete(id);
  }
}

// ---- menus ----------------------------------------------------------------------------------
//
// The page opens on the main menu, flying slowly around the field. You join the match only when
// you pick Play online; Practice plays offline against targets. Pausing (Esc, Start, or the Menu
// button on a phone) opens the pause menu; online, you're still in the match while it's open.

type Mode = 'menu' | 'online' | 'practice';
let mode: Mode = 'menu';

const menu = new Menu((action: MenuAction, viaPad: boolean) => {
  switch (action) {
    case 'online':
      if (mode !== 'online') {
        resetLocal();
        mode = 'online';
        net.start();
      }
      play(viaPad);
      break;
    case 'practice':
      net.stop();
      clearRemotes();
      switchMap(hud.pickedMap());
      resetLocal();
      practiceHits = 0;
      mode = 'practice';
      play(viaPad);
      break;
    case 'resume':
      play(viaPad);
      break;
    case 'leave':
      net.stop();
      clearRemotes();
      mode = 'menu';
      menu.show('main');
      refreshField();
      break;
  }
});

/** start (or resume) playing; the menu closes once the mouse is locked or controller play begins */
function play(viaPad: boolean) {
  sound.unlock();
  input.start(viaPad);
}

/** fresh start for practice or a new online session */
function resetLocal() {
  player.setTeam(0);
  player.placeAt(spawnPoint(0, 2));
  player.alive = true;
  hopper = hopperSize();
  reloadLeft = 0;
  outUntil = 0;
}

/** play a firing mode: a fresh load for its hopper or tube, and say so if it changed mid-game */
function setFireMode(m: FireMode, announce: boolean) {
  if (m === trigger.mode) return;
  trigger.mode = m;
  trigger.reset();
  player.hold(m === 'pump' ? 'pump' : 'marker');
  hopper = hopperSize();
  reloadLeft = 0;
  if (announce) hud.toast(`Marker: ${MODE_RULES[m].name} · ${MODE_RULES[m].blurb}`);
}

input.onChange = () => {
  if (input.active) {
    sound.unlock(); // works after a click or tap; a controller press alone may not count
    menu.show(null);
  } else if (mode !== 'menu' && (menu.screen === null || menu.screen === 'main')) {
    // stopped playing (Esc, Start, Menu button, lost the controller) or the mouse lock was refused
    hud.setPause(mode === 'online');
    menu.show('pause');
  }
};

// the main menu says how busy the field is (the server's public health check)
const httpBase = serverUrl.replace(/^ws/, 'http');
let fieldBusy = false;
async function refreshField() {
  if (menu.screen !== 'main' || fieldBusy) return;
  fieldBusy = true;
  try {
    const r = await fetch(`${httpBase}/healthz`, { cache: 'no-store' });
    const j = (await r.json()) as { players?: unknown; bots?: unknown; map?: unknown; vote?: unknown; voice?: unknown };
    const onMap = MAP_LIST.find((m) => m.id === j.map);
    if (onMap) hud.setMap(onMap.id); // the chooser shows what's on, until you pick something else
    if (onMap && mode === 'menu' && !hud.mapTouched) switchMap(onMap.id);
    hud.setFieldInfo({ players: Number(j.players) || 0, bots: Number(j.bots) || 0, map: onMap?.name ?? null, vote: j.vote !== false });
    if (net.status !== 'online') hud.setVoiceAvailable(j.voice === true); // so Settings shows the voice options
  } catch {
    hud.setFieldInfo(null);
  } finally {
    fieldBusy = false;
  }
}
hud.setFieldInfo('checking');
refreshField();
setInterval(refreshField, 10_000);

/** main menu camera: a slow lap of the field, wider for bigger fields; under the trees in the woods */
let orbit = 0.6;
function flyAround(dt: number) {
  orbit += dt * (0.05 * 23) / field.halfL;
  const k = field.halfL / 23;
  const woods = field.map.theme.ground === 'forest';
  const rx = woods ? field.halfL * 0.62 : 27 * k;
  const rz = woods ? field.halfW * 0.62 : 17 * (field.halfW / 15);
  const y = woods ? 3.2 + Math.sin(orbit * 0.7) * 0.4 : (8.5 + Math.sin(orbit * 0.7) * 1.5) * Math.sqrt(k);
  camera.position.set(Math.cos(orbit) * rx, y, Math.sin(orbit) * rz);
  camera.lookAt(0, woods ? 1.2 : 0.8, 0);
}

// ---- shooting -----------------------------------------------------------------------------

const eye = new THREE.Vector3();
const ear = new THREE.Vector3();
const shotPos = new THREE.Vector3();
const shotLook = new THREE.Vector3();
const dir = new THREE.Vector3();
const toTarget = new THREE.Vector3();

/** 0.55 while the crosshair is on (or just beside) an opponent's body, else 1 */
function aimSlowdown(myTeam: number): number {
  player.eye(eye);
  player.aimDir(dir);
  for (const t of targets) {
    if (!t.alive || t.team === myTeam) continue;
    toTarget.set(t.x - eye.x, t.y + t.height * 0.55 - eye.y, t.z - eye.z);
    const d = toTarget.length();
    if (d < 0.5 || d > 70) continue;
    const angle = Math.acos(Math.max(-1, Math.min(1, toTarget.dot(dir) / d)));
    if (angle < Math.atan2(0.7, d)) return 0.55;
  }
  return 1;
}

/** the paint a team shoots on this field: a bright fill, not the team colour */
function paintOf(team: number): number {
  return field.map.theme.paint[team === 1 ? 1 : 0];
}

function fire() {
  player.eye(eye);
  // straight ahead in first person; at what the crosshair is on in third
  player.shotDir(dir, targets, net.status === 'online' ? net.team : 0);
  dir.x += (Math.random() - 0.5) * 2 * SPREAD;
  dir.y += (Math.random() - 0.5) * 2 * SPREAD;
  dir.z += (Math.random() - 0.5) * 2 * SPREAD;
  dir.normalize();
  const o: V3 = [eye.x + dir.x * 0.35, eye.y + dir.y * 0.35 - 0.04, eye.z + dir.z * 0.35];
  const online = net.status === 'online';
  const team = online ? net.team : 0;
  if (online) flushInputs(); // so the server has moved us to where we're shooting from
  // Draw the ball right away (no waiting for the server), then tell the server.
  const speed = ballSpeed(o); // the server picks the same one from o
  balls.spawn(o, [dir.x * speed, dir.y * speed, dir.z * speed], online ? net.id : 0, team, paintOf(team), true);
  if (online) net.send({ t: 'fire', o, d: [dir.x, dir.y, dir.z] });
  hopper--;
  player.kick();
  input.pad.rumble('fire');
  sound.play('shot', { volume: VOL.shot });
}

const ballEvents: BallEvents = {
  onWorld(b, w) {
    fx.splat(w.x, w.y, w.z, w.nx, w.ny, w.nz, b.color);
    fx.burst(w.x, w.y, w.z, w.nx, w.ny, w.nz, b.color, 6);
    sound.playAt('splat', w.x, w.y, w.z, { volume: VOL.splat });
    if (w.bunker >= 0) {
      world.hit(w.bunker, w.nx, w.nz, 1);
      paintHits[w.bunker] = (paintHits[w.bunker] ?? 0) + 1;
    }
  },
  onBounce(b, w, stopped) {
    // no paint: it didn't break. A glancing knock still shakes an inflatable a little
    if (!stopped) sound.playAt('bounce', w.x, w.y, w.z, { volume: VOL.bounce });
    if (w.bunker >= 0) world.hit(w.bunker, w.nx, w.nz, 0.4);
  },
  onPlayerBounce(b, _t, x, y, z, stopped) {
    // skipped off them without breaking: no paint, they play on. Online the server says so (the
    // 'bounce' message); in practice it's decided here
    if (!stopped) sound.playAt('bounce', x, y, z, { volume: VOL.bounce });
    fx.burst(x, y, z, 0, 1, 0, 0xffffff, 3);
    if (b.local && net.status !== 'online') {
      hud.feedRow([{ text: 'Target', team: 1 }, { text: '· bounce, plays on', cls: 'note' }], true);
      hud.toast('Bounced off · still in');
    }
  },
  onNearMiss(_b, x, y, z, d) {
    sound.playAt('whizz', x, y, z, { volume: VOL.whizz * (1.2 - d / 2) });
  },
  onTarget(b, t, x, y, z) {
    fx.burst(x, y, z, 0, 1, 0, b.color, 16);
    sound.playAt('hit', x, y, z, { volume: VOL.hit });
    // Online, this is only a visual: the server decides eliminations (see the 'hit' handler).
    if (b.local && net.status !== 'online') {
      const d = dummies.find((d) => d.id === t.id);
      if (d) {
        d.alive = false;
        d.downUntil = performance.now() + RESPAWN_SECONDS * 1000;
        if (field.map.theme.outFx === 'stars') stars.pop(d.x, d.y, d.z, TEAM_COLORS[b.team]);
        practiceHits++;
        hud.hitMarker();
        input.pad.rumble('hit');
        sound.play('confirm', { volume: VOL.confirm, rate: 1 });
      }
    }
  },
};

// ---- match flow (online) ------------------------------------------------------------------

let lastPhase: RoundPhase | null = null;
let lastCount = 0;

// ---- event feed: doubles, your streak, the last one standing ----------------------------------

/** eliminations this close together (ms) from the same shooter make a double, triple, … */
const MULTI_MS = 4000;
const MULTI_NAMES = ['', '', 'double', 'triple', 'quad', 'clean sweep'];
const multiElims = new Map<number, { at: number; n: number }>();
/** your eliminations this point without being hit */
let myStreak = 0;
/** players still in per team, last frame; and which teams have had their "last one standing" call this point */
let lastAlive: [number, number] = [0, 0];
const lastStandingCalled = new Set<number>();

/** call out the last player standing on a team, once a point */
function checkLastStanding(phase: RoundPhase | null) {
  if (phase !== 'live') {
    lastStandingCalled.clear();
    lastAlive = [0, 0];
    return;
  }
  const alive: [number, number] = [0, 0];
  const last: [number, number] = [-1, -1];
  for (const p of net.players) {
    const isIn = p.id === net.id ? player.alive : p.alive;
    if (!isIn) continue;
    alive[p.team]++;
    last[p.team] = p.id;
  }
  for (const t of [0, 1] as const) {
    const other = alive[t === 0 ? 1 : 0];
    if (alive[t] === 1 && lastAlive[t] > 1 && other > 0 && !lastStandingCalled.has(t)) {
      lastStandingCalled.add(t);
      const id = last[t];
      hud.feedRow([{ text: 'last one standing:', cls: 'note' }, { text: net.nameOf(id), team: t }, { text: `1 v ${other}`, cls: 'tag' }], id === net.id, 'big');
      if (id === net.id) hud.toast(`You're the last one standing · 1 v ${other}`);
    }
  }
  lastAlive = alive;
}

const teamClass = (t: number) => (t === 0 ? 'r' : 'b');
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/** the score bar online: points, the clock (or what's on), and who's still in on each team */
function updateScoreBar(now: number) {
  const r = net.round;
  const left = phaseSecondsLeft(net, now);
  const alive: [boolean[], boolean[]] = [[], []];
  // in id order, so the pips don't swap places as people go out
  for (const p of [...net.players].sort((a, b) => a.id - b.id)) alive[p.team].push(p.id === net.id ? player.alive : p.alive);
  let c = '';
  let sub = '';
  switch (r?.phase) {
    case 'live': c = clock(left); sub = `point ${r.round} · first to ${r.toWin}`; break;
    case 'countdown': c = String(Math.max(1, Math.ceil(left))); sub = `point ${r.round} · get ready`; break;
    case 'point': c = clock(left); sub = 'point over'; break;
    case 'matchover': c = 'FINAL'; sub = 'new match soon'; break;
    default: c = 'WARM-UP'; sub = 'waiting for both teams';
  }
  hud.setScoreBar({ teams: [net.score[0], net.score[1]], clock: c, sub, alive });
}

function outLine(phase: RoundPhase | null, now: number): string {
  if (phase === 'live') return 'walking off the field · out until the point ends';
  if (phase === 'point' || phase === 'matchover' || phase === 'countdown') return 'next point coming up';
  return `back in ${Math.max(1, Math.ceil((outUntil - now) / 1000))}…`;
}

/** plan the camera shots for the break that's starting */
function startBreakShots(phase: 'point' | 'matchover', winner: number, seconds: number) {
  const winners: { x: number; y: number; z: number }[] = [];
  if (winner === 0 || winner === 1) {
    for (const ra of remoteAvatars.values()) if (ra.target.alive && ra.target.team === winner) winners.push(ra.target);
    if (player.alive && net.team === winner) winners.push(player.body);
  }
  director.start({
    kind: phase === 'matchover' ? 'match' : 'point', winner, winnerName: winner >= 0 ? TEAM_NAMES[winner] : '',
    winners: winners.map((p) => ({ x: p.x, y: p.y, z: p.z })), paint: field.bunkers.map((_, i) => paintHits[i] ?? 0), seconds,
  });
}

/** banner, sounds and toasts when the match changes phase */
function updateMatchCues(phase: RoundPhase | null, now: number) {
  const r = net.round;
  if (phase !== lastPhase) {
    if (phase === 'countdown') {
      myStreak = 0;
      paintHits = [];
    }
    if ((phase === 'point' || phase === 'matchover') && r) startBreakShots(phase, r.winner, phaseSecondsLeft(net, now));
    else director.stop();
    if (phase === 'live' && lastPhase === 'countdown') sound.play('go', { volume: VOL.beep, rate: 1 });
    if (phase === 'point' || phase === 'matchover') sound.play('horn', { volume: VOL.horn, rate: 1 });
    if (phase === 'live' && r) hud.toast(`Point ${r.round} · eliminate the other team`);
    lastPhase = phase;
    lastCount = 0;
  }
  if (!r || !phase) return hud.setBanner(null);
  const left = phaseSecondsLeft(net, now);
  switch (phase) {
    case 'countdown': {
      const n = Math.max(1, Math.ceil(left));
      if (n !== lastCount) {
        lastCount = n;
        sound.play('beep', { volume: VOL.beep, rate: 1 });
      }
      hud.setBanner(`${n}<small>Point ${r.round} · first to ${r.toWin}</small>`, 'count');
      break;
    }
    case 'point':
    case 'matchover': {
      const w = r.winner;
      const tally = `${net.score[0]} – ${net.score[1]}`;
      if (w === -1) hud.setBanner(`TIME<small>no one wins the point · ${tally}</small>`);
      else if (phase === 'point') hud.setBanner(`${TEAM_NAMES[w].toUpperCase()} WINS THE POINT<small>${tally}</small>`, teamClass(w));
      else hud.setBanner(`${TEAM_NAMES[w].toUpperCase()} WINS THE MATCH<small>${tally} · new match soon</small>`, teamClass(w));
      break;
    }
    default:
      hud.setBanner(null);
  }
}

const plateTargets: PlateTarget[] = [];
function updatePlates(online: boolean) {
  plateTargets.length = 0;
  if (online) {
    for (const [id, ra] of remoteAvatars) {
      const t = ra.target;
      plateTargets.push({
        id, name: net.nameOf(id), team: t.team === 0 ? 0 : 1, x: t.x, y: t.y + t.height + 0.28, z: t.z, alive: t.alive,
        speaking: voice.speaking.has(id),
      });
    }
  }
  plates.update(camera, plateTargets);
}

function flushInputs() {
  const frames = prediction.takeOutbox();
  if (frames) net.send({ t: 'input', i: frames });
}

function startReload() {
  reloadLeft = RELOAD_SECONDS;
  sound.play('reload', { volume: VOL.reload, rate: 1 });
}

/**
 * Out during a point: once you've walked off (or after SPECTATE_AFTER_MS), watch someone still in
 * over their shoulder; Space or A moves on to the next. Your own figure keeps walking off meanwhile.
 */
function spectate(online: boolean, phase: RoundPhase | null, now: number, dt: number) {
  const offLine = Math.abs(player.body.z) >= waitLine() - 0.05;
  if (!online || phase !== 'live' || player.alive || (!offLine && now - outAt < SPECTATE_AFTER_MS)) {
    spectator.stop();
    hud.setWatching(null);
    return;
  }
  const watchable = [...remoteAvatars.values()].map((ra) => ({ ...ra.target, pitch: ra.pitch }));
  const w = spectator.choose(watchable, net.team, input.active && input.nextPressed, now);
  if (!w) {
    hud.setWatching(null);
    return;
  }
  spectator.view(camera, w, dt);
  player.hideGun();
  const r = net.roster.get(w.id);
  const others = watchable.filter((p) => p.alive && p.id !== w.id).length;
  const how = input.device === 'pad' ? 'A' : TOUCH ? 'Jump' : 'Space';
  hud.setWatching({
    name: net.nameOf(w.id),
    team: w.team === 0 ? 0 : 1,
    line: `${r ? `${r.k} elims · ` : ''}${w.alive ? '' : 'out · '}${others ? `${how} to switch` : 'last one in'}`,
  });
}

// ---- loop ---------------------------------------------------------------------------------

const targets: Target[] = [];
let last = performance.now();
let acc = 0;
let sendAcc = 0;
let wasFireHeld = false;

function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const online = net.status === 'online';

  input.poll(dt);
  if (menu.open) menu.pad(input.pad.state);
  hud.setControls(input.device, input.pad.state.connected ? input.pad.state.id : null, TOUCH, input.active);
  setDummiesVisible(mode === 'practice' || (mode === 'online' && !online));
  input.touch?.setVisible(input.active && !input.pad.state.connected);
  if (input.touch?.shown) input.touch.showStance(input.crouch, input.prone);
  const look = input.takeLook();
  if (input.active && (look.dx || look.dy)) player.look(look.dx, look.dy);
  if (input.active && input.viewPressed) setView(player.view === 'third' ? 'first' : 'third', true);
  const shoulder = input.active && player.view === 'third' ? input.shoulderPressed : null;
  if (shoulder !== null) {
    player.pickShoulder(shoulder);
    saveShoulder();
    hud.toast(`${player.lookingOver === 'left' ? 'Left' : 'Right'} shoulder${player.shoulder === 'auto' ? ' (auto)' : ''}`);
  }

  // who can be hit this frame
  if (online) updateRemotes(now);
  else updateDummies(now);
  targets.length = 0;
  if (online) for (const ra of remoteAvatars.values()) targets.push(ra.target);
  else targets.push(...dummies);

  // controller aim, a little slower while the crosshair is on an opponent (only the feel: the server
  // still decides every hit)
  if (input.active && player.alive) {
    const p = input.pad.state;
    if (p.yawRate || p.pitchRate) {
      const k = aimSlowdown(online ? net.team : 0) * dt;
      player.turn(p.yawRate * k, p.pitchRate * k);
    }
  }

  const px = player.body.x;
  const pz = player.body.z;
  const phase: RoundPhase | null = online ? net.round?.phase ?? null : null;
  const frozen = phase === 'countdown'; // everyone holds still in their start box
  const holdFire = phase === 'countdown' || phase === 'point' || phase === 'matchover';
  updateMatchCues(phase, now);

  acc += dt;
  let steps = 0;
  while (acc >= STEP && steps < 12) {
    const move = player.sample(input.active && !frozen ? input : null);
    if (online) prediction.record(move, player.pitch);
    player.apply(STEP);
    // the same step the server flies balls in (BALL_DT), so they take the same path and bounce the same way
    balls.update(STEP, targets, ballEvents, mode === 'menu' ? null : player.eye(ear)); // your head, even in third person
    acc -= STEP;
    steps++;
  }
  if (steps === 12) acc = 0; // way behind (tab was hidden): drop the backlog instead of spiralling
  const moved = Math.hypot(player.body.x - px, player.body.z - pz);
  if (player.alive && !player.crouching && moved < 1 && myFeet.update(moved, player.body.onGround)) {
    sound.play('step', { volume: VOL.step });
  }

  // reload + fire
  if (reloadLeft > 0) {
    reloadLeft -= dt;
    if (reloadLeft <= 0) {
      hopper = hopperSize();
      sound.play('reloadDone', { volume: VOL.reload });
    }
  } else if (input.reloadPressed && hopper < hopperSize() && player.alive) {
    startReload();
  }
  // the server's firing mode online, the menu's in practice (shared/fire.ts has the rules)
  setFireMode(online ? net.mode : hud.pickedMode(), false);
  const fireHeld = input.fireHeld;
  const firePressed = fireHeld && !wasFireHeld;
  wasFireHeld = fireHeld;
  const canFire = input.active && player.alive && reloadLeft <= 0 && !holdFire;
  if (firePressed && input.active && player.alive && !holdFire && (reloadLeft > 0 || hopper <= 0)) sound.play('dry', { volume: VOL.dry });
  // the trigger only sees the pull while you can fire, so a pull during a reload doesn't count
  const shots = trigger.update(dt, canFire && fireHeld && hopper > 0);
  if (canFire && fireHeld && hopper <= 0) startReload();
  for (let n = 0; n < shots && hopper > 0; n++) {
    fire();
    if (trigger.mode === 'pump') {
      player.pump(MODE_RULES.pump.interval);
      sound.play('pump', { volume: VOL.reload });
    }
  }

  // tell the server where we are
  // send our input frames (the server moves us with them)
  if (online) {
    sendAcc += dt;
    if (sendAcc >= 1 / CLIENT_SEND_HZ) {
      sendAcc = 0;
      flushInputs();
    }
  }

  // HUD
  if (online) {
    const others = net.remotes.size;
    const waiting = phase === 'waiting' ? ' · warm-up, waiting for the other team' : '';
    hud.setStatus('online', `Online · ${TEAM_NAMES[net.team]} team · ${others} other player${others === 1 ? '' : 's'}${waiting}`);
    updateScoreBar(now);
    checkLastStanding(phase);
  } else {
    if (mode === 'practice') hud.setStatus('offline', 'Practice · hit the targets');
    else if (net.status === 'connecting') hud.setStatus('connecting', 'Joining the match…');
    else hud.setStatus('offline', "Can't reach the game server · practising until it's back");
    hud.setScoreBar({ teams: null, clock: `${practiceHits} HITS`, sub: 'practice', alive: [[], []] });
  }
  hud.setAmmo(hopper, hopperSize(), reloadLeft > 0, trigger.ramping ? 'RAMPING' : MODE_RULES[trigger.mode].name);
  const fieldLine = hud.setVote(online && net.votes, online ? [...net.roster.values()] : [], net.id, field.map.id);
  const modeLine = hud.setModeVote(online && net.modeVotes, online ? [...net.roster.values()] : [], net.id, trigger.mode);
  hud.setScoreboard(online && input.active && input.scoreboardHeld ? [...net.roster.values()] : null, net.id, net.score, `${fieldLine} · Marker: ${modeLine}`, voice.speaking);

  // voice chat: join or leave the voice room as people come and go, push-to-talk, the talk chip
  voice.update(online, net.id, net.team, [...net.roster.values()].map((r) => ({ id: r.id, team: r.team, bot: r.bot })), phase, now);
  voice.setTalk(online && input.talkHeld); // out of the point, you can still talk to your team
  hud.setVoice(voice, online && input.active, TOUCH);
  if (menu.screen === 'players') hud.setPlayers(online ? [...net.roster.values()] : [], net.id, voice, (id) => voice.toggleMute(id));
  hud.showOut(player.alive ? null : outLine(phase, now));

  if (menu.screen === 'main') {
    flyAround(dt);
    player.showGun(false);
    hud.setWatching(null);
  } else {
    player.updateCamera(dt);
    if (online && director.active) {
      // between points: the camera shots take over (your own figure still drew, above)
      director.update(dt, camera, shotPos, shotLook);
      player.hideGun();
      hud.setWatching(null);
      const r = net.round;
      const w = r?.winner ?? -1;
      hud.setCinema({
        caption: director.caption, team: w, next: phase === 'matchover' ? 'NEW MATCH' : 'NEXT POINT', time: clock(phaseSecondsLeft(net, now)),
      });
      // after a match: vote for the next field right there (number keys; the pause menu has the same cards)
      const voting = phase === 'matchover' && net.votes;
      hud.setVoteNow(voting ? clock(phaseSecondsLeft(net, now)) : null);
      const n = voting && input.active ? input.numberPressed : 0;
      const pick = n ? hud.voteKey(n) : undefined;
      if (pick !== undefined) net.send({ t: 'vote', map: pick });
    } else {
      hud.setCinema(null);
      hud.setVoteNow(null);
      spectate(online, phase, now, dt);
    }
  }
  updatePlates(online);
  netStats.update(now);
  fx.update(dt);
  stars.update(dt);
  world.update(dt);
  balls.sync(camera);
  composer.render(dt);
  input.endFrame();
}

requestAnimationFrame(frame);

// Poke at the game from the browser console while developing, e.g. __game.player.body.
// import.meta.env.DEV is false in `npm run build`, so this is stripped from production.
if (import.meta.env.DEV) Object.assign(window, { __game: { THREE, scene, camera, renderer, composer, input, player, net, balls, fx, dummies, sound, hud, frame, prediction, models, remoteAvatars, menu, get mode() { return mode; }, get world() { return world; } } });

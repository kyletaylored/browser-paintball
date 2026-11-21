// Boot + game loop. Physics runs at a fixed 120 Hz no matter the frame rate, so movement and
// ball flight behave the same on a 60 Hz laptop and a 240 Hz monitor.

import * as THREE from 'three';
import { createRenderer, createComposer } from './render';
import { buildWorld } from './world';
import { Input, TOUCH } from './input';
import { Menu, type MenuAction } from './menu';
import type { PadSettings } from './gamepad';
import { LocalPlayer } from './player';
import { Paintballs, type Target, type BallEvents } from './paintballs';
import { Fx } from './fx';
import { makeAvatar, type Avatar } from './avatars';
import { loadModels } from './models';
import { Hud } from './hud';
import { SoundSystem, Footsteps } from './audio';
import { Nameplates, type PlateTarget } from './nameplates';
import { Prediction } from './prediction';
import { Net, sampleRemote, phaseSecondsLeft } from './net';
import { spawnPoint } from '../shared/field';
import { BALL_SPEED, FIRE_INTERVAL, STAND_HEIGHT, CROUCH_HEIGHT, CLIENT_SEND_HZ, RESPAWN_SECONDS, INPUT_DT, INTERP_DELAY } from '../shared/sim';
import { DEFAULT_PORT, TEAM_COLORS, TEAM_NAMES, cleanName, type RoundPhase, type V3 } from '../shared/protocol';

const STEP = INPUT_DT; // the server replays our movement in steps of exactly this
const HOPPER = 200;
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
buildWorld(scene, models);
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
hud.bindQuality();
input.onPadLost = () => hud.toast('Controller disconnected · paused');
const player = new LocalPlayer(camera, models?.marker ?? null);
const balls = new Paintballs(scene);
const fx = new Fx(scene);
const sound = new SoundSystem(camera);
player.placeAt(spawnPoint(0, 2));

// browsers only let audio start from a click or key press (the menu buttons count)
canvas.addEventListener('click', () => sound.unlock());
document.getElementById('menu')!.addEventListener('click', () => sound.unlock());
hud.bindAudio(sound);

// mix levels (each synthesised sound is normalised, so these set the balance)
const VOL = { beep: 0.4, horn: 0.35, shot: 0.5, remoteShot: 0.9, splat: 0.55, hit: 0.9, confirm: 0.5, out: 0.55, step: 0.22, remoteStep: 0.5, reload: 0.45, dry: 0.5 };
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

let hopper = HOPPER;
let reloadLeft = 0;
let fireCooldown = 0;
let outUntil = 0;
let practiceHits = 0;

// ---- practice dummies (only while there's no server) --------------------------------------

interface Dummy extends Target {
  avatar: Avatar;
  baseZ: number;
  downUntil: number;
}
const dummies: Dummy[] = ([[7.5, 2.5], [13.8, -6], [11, 8]] as const).map(([x, z], i) => {
  const avatar = makeAvatar(models, TEAM_COLORS[1]);
  scene.add(avatar.root);
  return { id: -100 - i, team: 1, x, y: 0, z, baseZ: z, height: STAND_HEIGHT, alive: true, avatar, downUntil: 0 };
});
const setDummiesVisible = (v: boolean) => dummies.forEach((d) => (d.avatar.root.visible = v));

function updateDummies(now: number) {
  dummies.forEach((d, i) => {
    if (!d.alive && now >= d.downUntil) d.alive = true;
    if (d.alive) d.z = d.baseZ + Math.sin(now / 1000 * 0.8 + i * 2) * 1.2; // strafe so they're not trivial
    d.avatar.set(d.x, d.y, d.z, Math.PI / 2, 0, d.height, d.alive);
  });
}

// ---- networking ---------------------------------------------------------------------------

const remoteAvatars = new Map<number, { avatar: Avatar; target: Target; feet: Footsteps; lx: number; ly: number; lz: number }>();

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
  welcome(_id, team, spawn) {
    prediction.reset();
    player.setTeam(team);
    player.placeAt(spawn);
    player.alive = true;
    hopper = HOPPER;
    setDummiesVisible(false);
    hud.toast(`Joined the ${TEAM_NAMES[team]} team`);
  },
  ball(m) {
    remoteAvatars.get(m.owner)?.avatar.fire();
    balls.spawn(m.o, m.v, m.owner, m.team, TEAM_COLORS[m.team], false);
    sound.playAt('shot', m.o[0], m.o[1], m.o[2], { volume: VOL.remoteShot });
  },
  hit(m) {
    if (SHOW_HITBOXES) showHitbox(m.tp);
    fx.burst(m.p[0], m.p[1], m.p[2], 0, 1, 0, TEAM_COLORS[m.team], 20);
    const mine = m.victim === net.id || m.shooter === net.id;
    const shooterTeam = net.roster.get(m.shooter)?.team ?? m.team;
    const victimTeam = net.roster.get(m.victim)?.team ?? (m.team === 0 ? 1 : 0);
    hud.killFeed(net.nameOf(m.shooter), shooterTeam, net.nameOf(m.victim), victimTeam, mine);
    if (m.victim === net.id) {
      hud.toast(`${net.nameOf(m.shooter)} got you`);
      player.alive = false;
      outUntil = performance.now() + RESPAWN_SECONDS * 1000;
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
  ack(m) {
    // the server's word on where we are; replay what it hasn't seen yet on top
    const fix = prediction.reconcile(player.body, m.seq, m.b);
    if (fix.snap) player.clearCorrection();
    else player.addCorrection(fix.dx, fix.dy, fix.dz);
  },
  respawn(sp) {
    player.placeAt(sp);
    player.alive = true;
    hopper = HOPPER;
    reloadLeft = 0;
  },
  disconnected() {
    clearRemotes();
    player.setTeam(0);
    player.placeAt(spawnPoint(0, 2));
    player.alive = true;
    hud.toast('Lost the server, back to practice');
  },
}, () => myName);

function updateRemotes(now: number) {
  const at = now - INTERP_DELAY_MS;
  for (const [id, r] of net.remotes) {
    let ra = remoteAvatars.get(id);
    if (!ra) {
      const avatar = makeAvatar(models, TEAM_COLORS[r.team]);
      scene.add(avatar.root);
      ra = { avatar, target: { id, team: r.team, x: 0, y: 0, z: 0, height: STAND_HEIGHT, alive: true }, feet: new Footsteps(), lx: NaN, ly: 0, lz: NaN };
      remoteAvatars.set(id, ra);
    }
    const s = sampleRemote(r, at);
    if (!s) continue;
    const h = s.c ? CROUCH_HEIGHT : STAND_HEIGHT;
    ra.avatar.set(s.x, s.y, s.z, s.yaw, s.pitch, h, s.alive);
    Object.assign(ra.target, { x: s.x, y: s.y, z: s.z, height: h, alive: s.alive });
    // footsteps you can hear from around a bunker (crouch-walking is silent)
    const moved = Number.isNaN(ra.lx) ? 0 : Math.hypot(s.x - ra.lx, s.z - ra.lz);
    const grounded = Math.abs(s.y - ra.ly) < 0.01;
    ra.lx = s.x;
    ra.ly = s.y;
    ra.lz = s.z;
    if (moved < 1 && s.alive && !s.c && ra.feet.update(moved, grounded)) {
      sound.playAt('step', s.x, s.y + 0.05, s.z, { volume: VOL.remoteStep });
    }
  }
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
  hopper = HOPPER;
  reloadLeft = 0;
  outUntil = 0;
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
    const j = (await r.json()) as { players?: unknown; bots?: unknown };
    hud.setFieldInfo({ players: Number(j.players) || 0, bots: Number(j.bots) || 0 });
  } catch {
    hud.setFieldInfo(null);
  } finally {
    fieldBusy = false;
  }
}
hud.setFieldInfo('checking');
refreshField();
setInterval(refreshField, 10_000);

/** main menu camera: a slow lap of the field */
let orbit = 0.6;
function flyAround(dt: number) {
  orbit += dt * 0.05;
  camera.position.set(Math.cos(orbit) * 27, 8.5 + Math.sin(orbit * 0.7) * 1.5, Math.sin(orbit) * 17);
  camera.lookAt(0, 0.8, 0);
}

// ---- shooting -----------------------------------------------------------------------------

const eye = new THREE.Vector3();
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

function fire() {
  player.eye(eye);
  player.aimDir(dir);
  dir.x += (Math.random() - 0.5) * 2 * SPREAD;
  dir.y += (Math.random() - 0.5) * 2 * SPREAD;
  dir.z += (Math.random() - 0.5) * 2 * SPREAD;
  dir.normalize();
  const o: V3 = [eye.x + dir.x * 0.35, eye.y + dir.y * 0.35 - 0.04, eye.z + dir.z * 0.35];
  const online = net.status === 'online';
  const team = online ? net.team : 0;
  if (online) flushInputs(); // so the server has moved us to where we're shooting from
  // Draw the ball right away (no waiting for the server), then tell the server.
  balls.spawn(o, [dir.x * BALL_SPEED, dir.y * BALL_SPEED, dir.z * BALL_SPEED], online ? net.id : 0, team, TEAM_COLORS[team], true);
  if (online) net.send({ t: 'fire', o, d: [dir.x, dir.y, dir.z] });
  hopper--;
  player.kick();
  input.pad.rumble('fire');
  sound.play('shot', { volume: VOL.shot });
}

const ballEvents: BallEvents = {
  onWorld(b, x, y, z, nx, ny, nz) {
    fx.splat(x, y, z, nx, ny, nz, b.color);
    fx.burst(x, y, z, nx, ny, nz, b.color, 6);
    sound.playAt('splat', x, y, z, { volume: VOL.splat });
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

const teamClass = (t: number) => (t === 0 ? 'r' : 'b');
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

function scoreHtml(now: number): string {
  const r = net.round;
  const left = phaseSecondsLeft(net, now);
  const extra = r?.phase === 'live' ? clock(left) : r ? `first to ${r.toWin}` : '';
  return `<span class="r">RED ${net.score[0]}</span><span>–</span><span class="b">${net.score[1]} BLUE</span>` +
    (extra ? `<span class="clock">${extra}</span>` : '');
}

function outLine(phase: RoundPhase | null, now: number): string {
  if (phase === 'live') return 'spectating until the point ends';
  if (phase === 'point' || phase === 'matchover' || phase === 'countdown') return 'next point coming up';
  return `back in ${Math.max(1, Math.ceil((outUntil - now) / 1000))}…`;
}

/** banner, sounds and toasts when the match changes phase */
function updateMatchCues(phase: RoundPhase | null, now: number) {
  const r = net.round;
  if (phase !== lastPhase) {
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
      plateTargets.push({ id, name: net.nameOf(id), team: t.team === 0 ? 0 : 1, x: t.x, y: t.y + t.height + 0.28, z: t.z, alive: t.alive });
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
  const look = input.takeLook();
  if (input.locked) player.look(look.dx, look.dy);

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
    balls.update(STEP, targets, ballEvents);
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
      hopper = HOPPER;
      sound.play('reloadDone', { volume: VOL.reload });
    }
  } else if (input.reloadPressed && hopper < HOPPER && player.alive) {
    startReload();
  }
  fireCooldown -= dt;
  const fireHeld = input.fireHeld;
  const firePressed = fireHeld && !wasFireHeld;
  wasFireHeld = fireHeld;
  const canFire = input.active && player.alive && reloadLeft <= 0 && !holdFire;
  if (firePressed && input.active && player.alive && !holdFire && (reloadLeft > 0 || hopper <= 0)) sound.play('dry', { volume: VOL.dry });
  if (canFire && fireHeld) {
    if (hopper <= 0) startReload();
    while (fireCooldown <= 0 && hopper > 0) {
      fire();
      fireCooldown += FIRE_INTERVAL;
    }
  }
  if (fireCooldown < 0) fireCooldown = 0;

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
    hud.setScore(scoreHtml(now));
  } else {
    if (mode === 'practice') hud.setStatus('offline', 'Practice · hit the targets');
    else if (net.status === 'connecting') hud.setStatus('connecting', 'Joining the match…');
    else hud.setStatus('offline', "Can't reach the game server · practising until it's back");
    hud.setScore(`Practice hits: ${practiceHits}`);
  }
  hud.setAmmo(hopper, HOPPER, reloadLeft > 0);
  hud.setScoreboard(online && input.active && input.scoreboardHeld ? [...net.roster.values()] : null, net.id, net.score);
  hud.showOut(player.alive ? null : outLine(phase, now));

  if (menu.screen === 'main') {
    flyAround(dt);
    player.showGun(false);
  } else player.updateCamera(dt);
  updatePlates(online);
  fx.update(dt);
  balls.sync();
  composer.render(dt);
  input.endFrame();
}

requestAnimationFrame(frame);

// Poke at the game from the browser console while developing, e.g. __game.player.body.
// import.meta.env.DEV is false in `npm run build`, so this is stripped from production.
if (import.meta.env.DEV) Object.assign(window, { __game: { THREE, scene, camera, renderer, composer, input, player, net, balls, fx, dummies, sound, hud, frame, prediction, models, remoteAvatars, menu, get mode() { return mode; } } });

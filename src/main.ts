// Boot + game loop. Physics runs at a fixed 120 Hz no matter the frame rate, so movement and
// ball flight behave the same on a 60 Hz laptop and a 240 Hz monitor.

import * as THREE from 'three';
import { createRenderer, createComposer } from './render';
import { buildWorld } from './world';
import { Input } from './input';
import { LocalPlayer } from './player';
import { Paintballs, type Target, type BallEvents } from './paintballs';
import { Fx } from './fx';
import { Avatar } from './avatars';
import { Hud } from './hud';
import { SoundSystem, Footsteps } from './audio';
import { Net, sampleRemote } from './net';
import { spawnPoint } from '../shared/field';
import { BALL_SPEED, FIRE_INTERVAL, STAND_HEIGHT, CROUCH_HEIGHT, CLIENT_SEND_HZ, RESPAWN_SECONDS } from '../shared/sim';
import { DEFAULT_PORT, TEAM_COLORS, TEAM_NAMES, type V3 } from '../shared/protocol';

const STEP = 1 / 120;
const HOPPER = 200;
const RELOAD_SECONDS = 1.6;
const SPREAD = 0.012;
const INTERP_DELAY_MS = 100;

// ---- setup --------------------------------------------------------------------------------

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = createRenderer(canvas);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 400);
scene.add(camera); // the gun is a child of the camera, so the camera must be in the scene
buildWorld(scene);
const composer = createComposer(renderer, scene, camera);

const hud = new Hud();
const input = new Input(canvas, hud.playButton);
const player = new LocalPlayer(camera);
const balls = new Paintballs(scene);
const fx = new Fx(scene);
const sound = new SoundSystem(camera);
player.placeAt(spawnPoint(0, 2));

// browsers only let audio start from a click or key press
hud.playButton.addEventListener('click', () => sound.unlock());
canvas.addEventListener('click', () => sound.unlock());
hud.bindAudio(sound);

// mix levels (each synthesised sound is normalised, so these set the balance)
const VOL = { shot: 0.5, remoteShot: 0.9, splat: 0.55, hit: 0.9, confirm: 0.5, out: 0.55, step: 0.22, remoteStep: 0.5, reload: 0.45, dry: 0.5 };
const myFeet = new Footsteps();

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
  const avatar = new Avatar(TEAM_COLORS[1]);
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

const serverUrl: string =
  import.meta.env.VITE_SERVER_URL ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:${DEFAULT_PORT}`;

const net = new Net(serverUrl, {
  welcome(_id, team, spawn) {
    player.setTeam(team);
    player.placeAt(spawn);
    player.alive = true;
    hopper = HOPPER;
    setDummiesVisible(false);
    hud.toast(`Joined the ${TEAM_NAMES[team]} team`);
  },
  ball(m) {
    balls.spawn(m.o, m.v, m.owner, m.team, TEAM_COLORS[m.team], false);
    sound.playAt('shot', m.o[0], m.o[1], m.o[2], { volume: VOL.remoteShot });
  },
  hit(m) {
    fx.burst(m.p[0], m.p[1], m.p[2], 0, 1, 0, TEAM_COLORS[m.team], 20);
    if (m.victim === net.id) {
      player.alive = false;
      outUntil = performance.now() + RESPAWN_SECONDS * 1000;
      hud.damageFlash();
      sound.play('out', { volume: VOL.out, rate: 1 });
    }
    if (m.shooter === net.id) {
      hud.hitMarker();
      sound.play('confirm', { volume: VOL.confirm, rate: 1 });
      hud.toast('Eliminated!');
    }
  },
  respawn(sp) {
    player.placeAt(sp);
    player.alive = true;
    hopper = HOPPER;
    reloadLeft = 0;
  },
  disconnected() {
    clearRemotes();
    setDummiesVisible(true);
    player.setTeam(0);
    player.placeAt(spawnPoint(0, 2));
    player.alive = true;
    hud.toast('Lost the server, back to practice');
  },
});

function updateRemotes(now: number) {
  const at = now - INTERP_DELAY_MS;
  for (const [id, r] of net.remotes) {
    let ra = remoteAvatars.get(id);
    if (!ra) {
      const avatar = new Avatar(TEAM_COLORS[r.team]);
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

// ---- shooting -----------------------------------------------------------------------------

const eye = new THREE.Vector3();
const dir = new THREE.Vector3();

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
  // Draw the ball right away (no waiting for the server), then tell the server.
  balls.spawn(o, [dir.x * BALL_SPEED, dir.y * BALL_SPEED, dir.z * BALL_SPEED], online ? net.id : 0, team, TEAM_COLORS[team], true);
  if (online) net.send({ t: 'fire', o, d: [dir.x, dir.y, dir.z] });
  hopper--;
  player.kick();
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
        sound.play('confirm', { volume: VOL.confirm, rate: 1 });
      }
    }
  },
};

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

  hud.setLocked(input.locked);
  const look = input.takeLook();
  if (input.locked) player.look(look.dx, look.dy);

  // who can be hit this frame
  if (online) updateRemotes(now);
  else updateDummies(now);
  targets.length = 0;
  if (online) for (const ra of remoteAvatars.values()) targets.push(ra.target);
  else targets.push(...dummies);

  const px = player.body.x;
  const pz = player.body.z;
  acc += dt;
  let steps = 0;
  while (acc >= STEP && steps < 12) {
    player.step(STEP, input.locked ? input : null);
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
  } else if (input.wasPressed('KeyR') && hopper < HOPPER && player.alive) {
    startReload();
  }
  fireCooldown -= dt;
  const firePressed = input.fireHeld && !wasFireHeld;
  wasFireHeld = input.fireHeld;
  const canFire = input.locked && player.alive && reloadLeft <= 0;
  if (firePressed && input.locked && player.alive && (reloadLeft > 0 || hopper <= 0)) sound.play('dry', { volume: VOL.dry });
  if (canFire && input.fireHeld) {
    if (hopper <= 0) startReload();
    while (fireCooldown <= 0 && hopper > 0) {
      fire();
      fireCooldown += FIRE_INTERVAL;
    }
  }
  if (fireCooldown < 0) fireCooldown = 0;

  // tell the server where we are
  if (online && player.alive) {
    sendAcc += dt;
    if (sendAcc >= 1 / CLIENT_SEND_HZ) {
      sendAcc = 0;
      const b = player.body;
      net.send({ t: 'state', x: b.x, y: b.y, z: b.z, yaw: player.yaw, pitch: player.pitch, c: player.crouching });
    }
  }

  // HUD
  if (online) {
    const others = net.remotes.size;
    hud.setStatus('online', `Online · ${TEAM_NAMES[net.team]} team · ${others} other player${others === 1 ? '' : 's'}`);
    hud.setScore(`<span class="r">RED ${net.score[0]}</span><span>–</span><span class="b">${net.score[1]} BLUE</span>`);
  } else {
    hud.setStatus(net.status, net.status === 'connecting' ? 'Connecting…' : `Offline practice · no server at ${serverUrl}`);
    hud.setScore(`Practice hits: ${practiceHits}`);
  }
  hud.setAmmo(hopper, HOPPER, reloadLeft > 0);
  hud.showOut(!player.alive ? Math.max(1, Math.ceil((outUntil - now) / 1000)) : null);

  player.updateCamera(dt);
  fx.update(dt);
  balls.sync();
  composer.render(dt);
  input.endFrame();
}

requestAnimationFrame(frame);

// Poke at the game from the browser console while developing, e.g. __game.player.body.
// import.meta.env.DEV is false in `npm run build`, so this is stripped from production.
if (import.meta.env.DEV) Object.assign(window, { __game: { THREE, scene, camera, renderer, input, player, net, balls, fx, dummies, sound } });

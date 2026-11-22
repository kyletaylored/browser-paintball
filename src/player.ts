// The local player: the camera (first person, or over the shoulder), movement (via shared/sim.ts),
// the marker you see on screen in first person and your own figure in third.

import * as THREE from 'three';
import { stepMovement, traceWorld, segmentHitsPlayer, STAND_HEIGHT, EYE_FROM_TOP, type Body, type MoveInput } from '../shared/sim';
import { TEAM_COLORS, type Spawn, type Team } from '../shared/protocol';
import type { Input } from './input';
import { paintTeam } from './models';
import type { Avatar } from './avatars';
import type { Target } from './paintballs';
import { walkOffInput } from '../shared/walkoff';

export type View = 'first' | 'third';
/** which shoulder the third-person camera looks over; auto follows the way you strafe */
export type Shoulder = 'right' | 'left' | 'auto';

/** over the shoulder: how far behind, to the right and above the eyes the camera sits */
const THIRD_BACK = 2.6;
const THIRD_RIGHT = 0.6;
const THIRD_UP = 0.3;
/** how quickly the camera moves across to the other shoulder (1/s: most of the way in about 0.2 s) */
const SWAP_RATE = 12;
/** auto shoulder: strafe one way this long (seconds) and the camera goes over that shoulder */
const AUTO_STRAFE = 0.15;
/** how far the crosshair looks for something to aim at in third person */
const AIM_RANGE = 150;

const SENSITIVITY = 0.0022;

export class LocalPlayer {
  readonly body: Body = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, height: STAND_HEIGHT, onGround: true };
  yaw = 0;
  pitch = 0;
  alive = true;
  team: Team = 0;

  private gun = new THREE.Group();
  private hopperMat = new THREE.MeshStandardMaterial({ roughness: 0.35 });
  private recoil = 0;
  /** pump stroke: 1 just fired, down to 0 when it's back (seconds per stroke in pumpLen) */
  private pumpT = 0;
  private pumpLen = 0.5;
  private bobPhase = 0;
  private move: MoveInput = { forward: 0, right: 0, jump: false, sprint: false, crouch: false, prone: false, yaw: 0 };
  private euler = new THREE.Euler(0, 0, 0, 'YXZ');
  /** visual-only offset left over from a server correction; decays to zero so fixes don't look like teleports */
  private smooth = { x: 0, y: 0, z: 0 };

  private markerModel: THREE.Object3D | null = null;
  /** the pump marker (pump mode), its animation, and which of the two is in your hands */
  private pumpModel: THREE.Object3D | null = null;
  private pumpMixer: THREE.AnimationMixer | null = null;
  private pumpAction: THREE.AnimationAction | null = null;
  private holding: 'marker' | 'pump' = 'marker';
  /** where the marker sits in front of the camera (right, down, forward) */
  readonly gunOffset = new THREE.Vector3(0.15, -0.14, -0.34);
  /** first person, or over the shoulder */
  view: View = 'first';
  /** your own figure, for third person (made on demand, per team colour) */
  private bodyFig: Avatar | null = null;
  private makeFig: ((team: Team) => Avatar) | null = null;
  private figScene: THREE.Object3D | null = null;
  /** fired since the figure last drew (so it plays the shot) */
  private fired = false;
  /** which shoulder to look over (Settings, Q, d-pad left / right) */
  shoulder: Shoulder = 'right';
  /** the shoulder being looked over: 1 right, -1 left (auto changes it) */
  private side = 1;
  /** where the camera is between the shoulders now (-1..1), easing to `side` */
  private sideNow = 1;
  /** auto: how long you've strafed one way (seconds; negative is left) */
  private strafeFor = 0;
  /** how far back the third-person camera is now (it pulls in when a bunker is behind you, and eases out) */
  private camBack = THIRD_BACK;
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();

  /**
   * marker: the model from marker.glb, or null to draw a simple one from code. pump: the pump
   * marker (pump-marker.glb) and its clips, shown in pump mode
   */
  constructor(private camera: THREE.PerspectiveCamera, marker: THREE.Object3D | null = null, pump: { scene: THREE.Object3D; clips: THREE.AnimationClip[] } | null = null) {
    camera.rotation.order = 'YXZ';
    if (marker) {
      this.markerModel = marker.clone(true);
      this.markerModel.traverse((o) => (o.castShadow = false)); // it's inside your head as far as the sun knows
      this.gun.add(this.markerModel);
      this.gun.scale.setScalar(0.55);
      this.gun.rotation.y = 0.05; // angled a touch toward the centre of the screen
      // held up close, like it's at your mask: higher and nearer than a "gun at the hip" view
      this.gunOffset.set(0.17, -0.18, -0.48);
    } else {
      this.buildGun();
    }
    if (pump && this.markerModel) {
      this.pumpModel = pump.scene.clone(true);
      this.pumpModel.traverse((o) => (o.castShadow = false));
      this.pumpModel.visible = false;
      this.gun.add(this.pumpModel);
      const clip = pump.clips.find((c) => c.name === 'pump');
      if (clip) {
        this.pumpMixer = new THREE.AnimationMixer(this.pumpModel);
        this.pumpAction = this.pumpMixer.clipAction(clip);
        this.pumpAction.setLoop(THREE.LoopOnce, 1);
        this.pumpAction.clampWhenFinished = true;
      }
    }
    camera.add(this.gun);
    this.setTeam(0);
  }

  /** which marker you hold: the pump marker in pump mode (if it loaded), the usual one otherwise */
  hold(kind: 'marker' | 'pump'): void {
    this.holding = kind === 'pump' && this.pumpModel ? 'pump' : 'marker';
    if (this.markerModel) this.markerModel.visible = this.holding === 'marker';
    if (this.pumpModel) this.pumpModel.visible = this.holding === 'pump';
  }

  /** how to make your own figure for third person, and where to put it */
  setFigure(scene: THREE.Object3D, make: (team: Team) => Avatar): void {
    this.figScene = scene;
    this.makeFig = make;
  }

  setTeam(team: Team): void {
    if (team !== this.team && this.bodyFig) {
      this.bodyFig.root.removeFromParent();
      this.bodyFig.dispose();
      this.bodyFig = null;
    }
    this.team = team;
    this.hopperMat.color.setHex(TEAM_COLORS[team]);
    if (this.markerModel) paintTeam(this.markerModel, TEAM_COLORS[team]);
    if (this.pumpModel) paintTeam(this.pumpModel, TEAM_COLORS[team]);
  }

  placeAt(sp: Spawn): void {
    Object.assign(this.body, { x: sp.x, y: sp.y, z: sp.z, vx: 0, vy: 0, vz: 0, height: STAND_HEIGHT, onGround: true });
    this.yaw = sp.yaw;
    this.pitch = 0;
    this.smooth = { x: 0, y: 0, z: 0 };
  }

  /** the server moved us by (-dx, -dy, -dz): show it gradually */
  addCorrection(dx: number, dy: number, dz: number): void {
    this.smooth.x += dx;
    this.smooth.y += dy;
    this.smooth.z += dz;
  }

  clearCorrection(): void {
    this.smooth = { x: 0, y: 0, z: 0 };
  }

  /** mouse movement, in pixels */
  look(dx: number, dy: number): void {
    this.turn(-dx * SENSITIVITY, -dy * SENSITIVITY);
  }

  /** turn by angles (radians): + yaw turns left, + pitch looks up (controller sticks) */
  turn(dyaw: number, dpitch: number): void {
    this.yaw += dyaw;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + dpitch));
  }

  /**
   * read the controls into this step's movement input; null input = stand still (menu open,
   * countdown). Eliminated, you walk off the field whatever you press: the server does the same.
   */
  sample(input: Input | null): MoveInput {
    const m = this.move;
    if (!this.alive) {
      walkOffInput(this.body, m);
      return m;
    }
    const on = input !== null && this.alive;
    m.forward = on ? input.forward : 0;
    m.right = on ? input.right : 0;
    m.jump = on && input.jump;
    m.sprint = on && input.sprint;
    m.prone = on && input.prone;
    m.crouch = on && input.crouch && !m.prone;
    m.yaw = this.yaw;
    return m;
  }

  /** run one fixed movement step with what sample() read */
  apply(dt: number): void {
    stepMovement(this.body, this.move, dt);
  }

  /** crouched or lying down (quiet: no footsteps) */
  get crouching(): boolean {
    return this.move.crouch || this.move.prone;
  }

  eye(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.body.x, this.body.y + this.body.height - EYE_FROM_TOP, this.body.z);
  }

  aimDir(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0, -1).applyEuler(this.euler.set(this.pitch, this.yaw, 0));
  }

  kick(): void {
    this.recoil = 1;
    this.fired = true;
  }

  /**
   * a pump marker's stroke after a shot, over `seconds`: the pump marker's handle racks back and
   * forward (its "pump" animation, from Blender) and the marker rocks a little; without that model
   * the whole marker racks back instead
   */
  pump(seconds: number): void {
    this.pumpT = 1;
    this.pumpLen = seconds;
    if (this.holding === 'pump' && this.pumpAction) {
      this.pumpAction.reset();
      this.pumpAction.timeScale = this.pumpAction.getClip().duration / seconds;
      this.pumpAction.play();
    }
  }

  /**
   * Look over the other shoulder ('swap', Q) or a given one (-1 left, 1 right: d-pad). With a fixed
   * shoulder that changes the setting; on auto it moves the camera until you strafe the other way.
   */
  pickShoulder(to: 'swap' | -1 | 1): void {
    const side = to === 'swap' ? -this.side : to;
    this.side = side;
    this.strafeFor = 0;
    if (this.shoulder !== 'auto') this.shoulder = side < 0 ? 'left' : 'right';
  }

  /** the shoulder being looked over now */
  get lookingOver(): 'left' | 'right' {
    return this.side < 0 ? 'left' : 'right';
  }

  /** the marker in front of the camera (hidden while the main menu shows the field), and your figure */
  showGun(v: boolean): void {
    this.gun.visible = v && this.alive && this.view === 'first';
    if (!v && this.bodyFig) this.bodyFig.root.visible = false;
  }

  /**
   * Which way a shot goes. First person: straight along the view. Third person the camera sits
   * behind your shoulder, so aim from your eyes at whatever the crosshair is on (the first bunker,
   * ground or player along the camera's ray), so paint lands where the crosshair points.
   */
  shotDir(out: THREE.Vector3, targets: readonly Target[], myTeam: number): THREE.Vector3 {
    this.aimDir(out);
    if (this.view !== 'third') return out;
    const eye = this.eye(this.v1);
    const cam = this.camera.position;
    // start the ray level with you, not behind you: nothing between the camera and you counts
    const along = Math.max(0, (eye.x - cam.x) * out.x + (eye.y - cam.y) * out.y + (eye.z - cam.z) * out.z);
    const sx = cam.x + out.x * along;
    const sy = cam.y + out.y * along;
    const sz = cam.z + out.z * along;
    const ex = sx + out.x * AIM_RANGE;
    const ey = sy + out.y * AIM_RANGE;
    const ez = sz + out.z * AIM_RANGE;
    let t = traceWorld(sx, sy, sz, ex, ey, ez)?.t ?? 1;
    for (const p of targets) {
      if (!p.alive || p.team === myTeam) continue;
      const s = segmentHitsPlayer(sx, sy, sz, ex, ey, ez, p.x, p.y, p.z, p.height, p.yaw, p.prone);
      if (s !== null && s < t) t = s;
    }
    const aim = this.v2.set(sx + (ex - sx) * t, sy + (ey - sy) * t, sz + (ez - sz) * t);
    // too close to aim across (a bunker right in front of you): just shoot straight
    if (aim.distanceTo(eye) < 1.5) return out;
    return out.copy(aim).sub(eye).normalize();
  }

  updateCamera(dt: number): void {
    const fired = this.fired;
    this.fired = false;
    const k = Math.exp(-dt * 10);
    this.smooth.x *= k;
    this.smooth.y *= k;
    this.smooth.z *= k;
    this.eye(this.camera.position);
    this.camera.position.x += this.smooth.x;
    this.camera.position.y += this.smooth.y;
    this.camera.position.z += this.smooth.z;
    if (this.view === 'third') {
      this.thirdPerson(dt, fired);
      return;
    }
    if (this.bodyFig) this.bodyFig.root.visible = false;
    const speed = Math.hypot(this.body.vx, this.body.vz);
    if (this.body.onGround && speed > 0.5) this.bobPhase += dt * speed * 1.6;
    const bob = this.body.onGround ? Math.sin(this.bobPhase * 2) * 0.018 * Math.min(1, speed / 5) : 0;
    this.camera.position.y += bob;
    this.camera.rotation.set(this.pitch, this.yaw, 0);

    this.recoil = Math.max(0, this.recoil - dt * 14);
    this.pumpT = Math.max(0, this.pumpT - dt / this.pumpLen);
    this.pumpMixer?.update(dt);
    // the stroke: back and up a little, then forward again (a smooth bump over the stroke). With the
    // pump marker its handle does the work, so the marker itself only rocks a touch
    const bump = this.pumpT > 0 ? Math.sin(Math.PI * Math.min(1, (1 - this.pumpT) * 1.25)) : 0;
    const stroke = this.holding === 'pump' && this.pumpAction ? bump * 0.35 : bump;
    const o = this.gunOffset;
    this.gun.position.set(o.x + Math.cos(this.bobPhase) * 0.005, o.y - bob * 0.5 - stroke * 0.012, o.z + this.recoil * 0.03 + stroke * 0.05);
    this.gun.rotation.x = this.recoil * 0.05 - stroke * 0.12;
    this.gun.rotation.z = -stroke * 0.08;
    this.gun.visible = this.alive;
  }

  /**
   * camera behind your shoulder, pulled in if a bunker (or the ground) is in the way; your figure
   * drawn. The shoulder is the one picked, or on auto the side you last strafed toward (unless a
   * bunker's right against it and the other side is clear: peeking out of the left of a bunker
   * looks over your left shoulder). Swapping slides the camera across rather than jumping.
   */
  private thirdPerson(dt: number, fired: boolean): void {
    const cam = this.camera.position;
    this.gun.visible = false;
    this.recoil = Math.max(0, this.recoil - dt * 14);
    const fwd = this.aimDir(this.v1);
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    const shy = cam.y + THIRD_UP;
    const blocked = (side: number) => traceWorld(cam.x, cam.y, cam.z, cam.x + rx * THIRD_RIGHT * side, shy, cam.z + rz * THIRD_RIGHT * side) !== null;
    if (this.shoulder !== 'auto') {
      this.side = this.shoulder === 'left' ? -1 : 1;
    } else {
      const r = this.move.right;
      this.strafeFor = r < -0.3 ? Math.min(0, this.strafeFor) - dt : r > 0.3 ? Math.max(0, this.strafeFor) + dt : this.strafeFor;
      if (this.strafeFor <= -AUTO_STRAFE) this.side = -1;
      else if (this.strafeFor >= AUTO_STRAFE) this.side = 1;
      if (blocked(this.side) && !blocked(-this.side)) this.side = -this.side;
    }
    this.sideNow += (this.side - this.sideNow) * Math.min(1, dt * SWAP_RATE);
    // the shoulder (or just above your head, if you're right up against something on that side)
    let shx = cam.x + rx * THIRD_RIGHT * this.sideNow;
    let shz = cam.z + rz * THIRD_RIGHT * this.sideNow;
    if (traceWorld(cam.x, cam.y, cam.z, shx, shy, shz)) {
      shx = cam.x;
      shz = cam.z;
    }
    // then back from it along the view, stopping 0.25 m short of whatever's behind you. Two rays, the
    // second a little lower, so the camera doesn't skim over a bunker's top and hide you behind it
    let t = 1;
    for (const drop of [0, 0.35]) {
      const y = shy - drop;
      const hit = traceWorld(shx, y, shz, shx - fwd.x * THIRD_BACK, y - fwd.y * THIRD_BACK, shz - fwd.z * THIRD_BACK);
      if (hit) t = Math.min(t, hit.t);
    }
    const want = t < 1 ? Math.max(0, THIRD_BACK * t - 0.25) : THIRD_BACK;
    // pull in at once (never see through a bunker), ease back out
    this.camBack = want < this.camBack ? want : this.camBack + (want - this.camBack) * Math.min(1, dt * 4);
    cam.set(shx - fwd.x * this.camBack, shy - fwd.y * this.camBack, shz - fwd.z * this.camBack);
    if (cam.y < 0.15) cam.y = 0.15;
    this.camera.rotation.set(this.pitch, this.yaw, 0);

    if (!this.bodyFig && this.makeFig && this.figScene) {
      this.bodyFig = this.makeFig(this.team);
      this.figScene.add(this.bodyFig.root);
    }
    const f = this.bodyFig;
    if (f) {
      // pulled right in against a bunker, the camera would be inside your own head: don't draw it then
      f.root.visible = this.camBack > 0.6;
      const b = this.body;
      // out, the figure faces the way it walks off (you can still look round)
      const yaw = this.alive ? this.yaw : this.move.yaw;
      f.set(b.x + this.smooth.x, b.y + this.smooth.y, b.z + this.smooth.z, yaw, this.pitch, b.height, this.alive, this.move.prone);
      if (fired) f.fire();
    }
  }

  private buildGun(): void {
    const dark = new THREE.MeshStandardMaterial({ color: 0x24222b, roughness: 0.4, metalness: 0.5 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x8a8d96, roughness: 0.25, metalness: 0.9 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.09, 0.3), dark);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.12, 0.05), dark);
    grip.position.set(0, -0.09, 0.07);
    grip.rotation.x = -0.25;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.36, 12), metal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.015, -0.32);
    const hopper = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), this.hopperMat);
    hopper.scale.set(0.9, 0.8, 1.2);
    hopper.position.set(0, 0.11, -0.02);
    this.gun.add(body, grip, barrel, hopper);
    this.gun.scale.setScalar(0.6);
  }
}

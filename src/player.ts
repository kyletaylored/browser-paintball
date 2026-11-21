// The local player: first-person camera, movement (via shared/sim.ts) and the gun you see on screen.

import * as THREE from 'three';
import { stepMovement, STAND_HEIGHT, EYE_FROM_TOP, type Body, type MoveInput } from '../shared/sim';
import { TEAM_COLORS, type Spawn, type Team } from '../shared/protocol';
import type { Input } from './input';
import { paintTeam } from './models';

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
  private bobPhase = 0;
  private move: MoveInput = { forward: 0, right: 0, jump: false, sprint: false, crouch: false, yaw: 0 };
  private euler = new THREE.Euler(0, 0, 0, 'YXZ');
  /** visual-only offset left over from a server correction; decays to zero so fixes don't look like teleports */
  private smooth = { x: 0, y: 0, z: 0 };

  private markerModel: THREE.Object3D | null = null;
  /** where the marker sits in front of the camera (right, down, forward) */
  readonly gunOffset = new THREE.Vector3(0.17, -0.17, -0.4);

  /** marker: the model from marker.glb, or null to draw a simple one from code */
  constructor(private camera: THREE.PerspectiveCamera, marker: THREE.Object3D | null = null) {
    camera.rotation.order = 'YXZ';
    if (marker) {
      this.markerModel = marker.clone(true);
      this.markerModel.traverse((o) => (o.castShadow = false)); // it's inside your head as far as the sun knows
      this.gun.add(this.markerModel);
      this.gun.scale.setScalar(0.55);
      this.gun.rotation.y = 0.06; // angled a touch toward the centre of the screen
      this.gunOffset.set(0.22, -0.24, -0.62);
    } else {
      this.buildGun();
    }
    camera.add(this.gun);
    this.setTeam(0);
  }

  setTeam(team: Team): void {
    this.team = team;
    this.hopperMat.color.setHex(TEAM_COLORS[team]);
    if (this.markerModel) paintTeam(this.markerModel, TEAM_COLORS[team]);
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

  /** read the controls into this step's movement input; null input = stand still (menu open, eliminated, countdown) */
  sample(input: Input | null): MoveInput {
    const m = this.move;
    const on = input !== null && this.alive;
    m.forward = on ? input.forward : 0;
    m.right = on ? input.right : 0;
    m.jump = on && input.jump;
    m.sprint = on && input.sprint;
    m.crouch = on && input.crouch;
    m.yaw = this.yaw;
    return m;
  }

  /** run one fixed movement step with what sample() read */
  apply(dt: number): void {
    stepMovement(this.body, this.move, dt);
  }

  get crouching(): boolean {
    return this.move.crouch;
  }

  eye(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.body.x, this.body.y + this.body.height - EYE_FROM_TOP, this.body.z);
  }

  aimDir(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0, -1).applyEuler(this.euler.set(this.pitch, this.yaw, 0));
  }

  kick(): void {
    this.recoil = 1;
  }

  /** the marker in front of the camera (hidden while the main menu shows the field) */
  showGun(v: boolean): void {
    this.gun.visible = v && this.alive;
  }

  updateCamera(dt: number): void {
    const k = Math.exp(-dt * 10);
    this.smooth.x *= k;
    this.smooth.y *= k;
    this.smooth.z *= k;
    this.eye(this.camera.position);
    this.camera.position.x += this.smooth.x;
    this.camera.position.y += this.smooth.y;
    this.camera.position.z += this.smooth.z;
    const speed = Math.hypot(this.body.vx, this.body.vz);
    if (this.body.onGround && speed > 0.5) this.bobPhase += dt * speed * 1.6;
    const bob = this.body.onGround ? Math.sin(this.bobPhase * 2) * 0.018 * Math.min(1, speed / 5) : 0;
    this.camera.position.y += bob;
    this.camera.rotation.set(this.pitch, this.yaw, 0);

    this.recoil = Math.max(0, this.recoil - dt * 14);
    const o = this.gunOffset;
    this.gun.position.set(o.x + Math.cos(this.bobPhase) * 0.005, o.y - bob * 0.5, o.z + this.recoil * 0.03);
    this.gun.rotation.x = this.recoil * 0.05;
    this.gun.visible = this.alive;
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

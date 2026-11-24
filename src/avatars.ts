// Other players. ModelAvatar is the animated figure from player.glb; PrimitiveAvatar is the simple
// shape drawn from code, used if the models didn't load. Both have the same set() interface.
//
// Outfits: on the moon (theme.outfit 'astronaut') the same figure is dressed in a space suit: white
// where the jersey's sides, trousers and pads were (the team colour stays on the chest, sleeves and
// hopper), a gold visor, a glass helmet bubble and a backpack with an aerial.

import * as THREE from 'three';
import { STAND_HEIGHT, PRONE_FEET, PRONE_RADIUS } from '../shared/sim';
import { field } from '../shared/field';
import { paintTeam, type Models } from './models';
import { toonify } from './toon';

export interface Avatar {
  readonly root: THREE.Object3D;
  /** where they are and what they're doing (call every frame); prone: lying down */
  set(x: number, y: number, z: number, yaw: number, pitch: number, height: number, alive: boolean, prone?: boolean): void;
  /** they fired: play the recoil */
  fire(): void;
  /** what they wear (follows the field: makeAvatar starts with the current field's) */
  dress(outfit: Outfit): void;
  dispose(): void;
}

export type Outfit = 'jersey' | 'astronaut';

/** what players wear on the field being played */
export const fieldOutfit = (): Outfit => field.map.theme.outfit ?? 'jersey';

export function makeAvatar(models: Models | null, color: number): Avatar {
  const a = models ? new ModelAvatar(models, color) : new PrimitiveAvatar(color);
  toonify(a.root); // the arcade look (src/toon.ts)
  a.dress(fieldOutfit());
  return a;
}

/** the space suit's colour for each of the figure's materials (by name; the team colour stays) */
const SUIT: Readonly<Record<string, number>> = {
  side: 0xeef0f5, pants: 0xe4e7ee, pad: 0xc3c9d5, glove: 0xdde1e8, boot: 0xb7bdc8, sole: 0x7d838f,
  mask: 0xf3f4f8, lens: 0xe5ab45, trim: 0x6a7180,
};
/** suit copies of the figure's materials, shared by every astronaut */
const suitCopies = new Map<THREE.Material, THREE.Material>();
function suitMaterial(m: THREE.Material): THREE.Material {
  const color = SUIT[m.name];
  if (color === undefined) return m;
  let c = suitCopies.get(m);
  if (!c) {
    c = m.clone();
    (c as THREE.MeshToonMaterial).color?.setHex(color);
    suitCopies.set(m, c);
  }
  return c;
}

/** the glass bubble round a helmet: see-through and drawn without depth, so it gets no ink outline */
const BUBBLE = new THREE.MeshBasicMaterial({ color: 0xcdeeff, transparent: true, opacity: 0.16, depthWrite: false });
const SHINE = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false });
const PACK = new THREE.MeshStandardMaterial({ color: 0xe8eaf0, roughness: 0.6 });
const DARK = new THREE.MeshStandardMaterial({ color: 0x4a505c, roughness: 0.5 });
const TIP = new THREE.MeshBasicMaterial({ color: 0xff5a5a });

/** the helmet bubble, centred on a head of radius r */
function bubble(r: number): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), BUBBLE));
  // a highlight on the glass, up and to one side at the front
  const shine = new THREE.Mesh(new THREE.SphereGeometry(r * 0.16, 10, 8), SHINE);
  shine.scale.set(1, 1.6, 0.4);
  shine.position.set(-r * 0.45, r * 0.45, -r * 0.72);
  g.add(shine);
  return g;
}

/** the life-support backpack with an aerial; team: a team-colour panel on it (or none) */
function backpack(team: THREE.Material | null): THREE.Group {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  add(new THREE.BoxGeometry(0.36, 0.42, 0.15), PACK, 0, 0, 0);
  if (team) add(new THREE.BoxGeometry(0.22, 0.06, 0.012), team, 0, 0.1, 0.081);
  add(new THREE.CylinderGeometry(0.035, 0.035, 0.3, 10), DARK, -0.12, -0.02, 0.09).rotation.x = 0;
  add(new THREE.CylinderGeometry(0.035, 0.035, 0.3, 10), DARK, 0.12, -0.02, 0.09);
  add(new THREE.CylinderGeometry(0.008, 0.008, 0.32, 5), DARK, 0.13, 0.36, 0);
  add(new THREE.SphereGeometry(0.025, 8, 6), TIP, 0.13, 0.53, 0);
  return g;
}

type State = 'idle' | 'run' | 'crouch' | 'crouchMove' | 'out' | 'outWalk';

/**
 * Lying down, for both kinds of figure: the whole figure tips forward onto its front, feet where the
 * hitbox's legs end (shared/sim.ts segmentHitsPlayer) and head toward where they face. `lie` eases
 * from 0 (upright) to 1 (flat) so getting down and up isn't a snap; crawling rocks it side to side.
 */
class Lying {
  lie = 0;
  private phase = 0;

  place(root: THREE.Object3D, x: number, y: number, z: number, yaw: number, prone: boolean, speed: number, dt: number): void {
    this.lie += ((prone ? 1 : 0) - this.lie) * Math.min(1, dt * 7);
    if (this.lie < 0.002) this.lie = 0;
    const l = this.lie;
    this.phase += dt * speed * 5;
    const back = (PRONE_FEET + PRONE_RADIUS) * l;
    root.position.set(x + Math.sin(yaw) * back, y + 0.12 * l, z + Math.cos(yaw) * back);
    root.rotation.order = 'YXZ';
    root.rotation.set(-Math.PI / 2 * l, yaw, Math.sin(this.phase) * 0.12 * l * Math.min(1, speed));
  }
}

/**
 * The player.glb figure, driven by network state: speed and crouch pick the base animation
 * (crossfaded), "out" / "outWalk" play when eliminated (marker up, walking off the field), and each
 * shot plays the additive "shoot" kick on top.
 * Aim pitch bends the torso and head after the animation is applied.
 */
export class ModelAvatar implements Avatar {
  readonly root = new THREE.Group();
  private model: THREE.Object3D;
  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private shoot: THREE.AnimationAction | null = null;
  private state: State | null = null;
  private torso: THREE.Object3D | null;
  private head: THREE.Object3D | null;
  private last = { x: NaN, z: NaN, t: 0 };
  private speed = 0;
  private lying = new Lying();
  private outfit: Outfit = 'jersey';
  /** the jersey's materials, per mesh, while the suit is on */
  private jersey = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private gear: THREE.Object3D[] = [];

  constructor(models: Models, color: number) {
    this.model = models.player.scene.clone(true);
    paintTeam(this.model, color);
    this.root.add(this.model);
    this.mixer = new THREE.AnimationMixer(this.model);
    for (const clip of models.player.clips) {
      if (clip.name === 'shoot') {
        const add = THREE.AnimationUtils.makeClipAdditive(clip.clone());
        this.shoot = this.mixer.clipAction(add);
        this.shoot.blendMode = THREE.AdditiveAnimationBlendMode;
        this.shoot.setLoop(THREE.LoopOnce, 1);
      } else {
        this.actions.set(clip.name, this.mixer.clipAction(clip));
      }
    }
    this.torso = this.model.getObjectByName('torso') ?? null;
    this.head = this.model.getObjectByName('head') ?? null;
    this.play('idle', 0);
  }

  set(x: number, y: number, z: number, yaw: number, pitch: number, height: number, alive: boolean, prone = false): void {
    const now = performance.now() / 1000;
    const dt = this.last.t ? Math.min(0.1, now - this.last.t) : 0;
    if (dt > 0 && !Number.isNaN(this.last.x)) {
      const v = Math.hypot(x - this.last.x, z - this.last.z) / dt;
      this.speed += ((v > 20 ? 0 : v) - this.speed) * Math.min(1, dt * 10); // > 20 m/s is a respawn jump
    }
    this.last = { x, z, t: now };
    this.lying.place(this.root, x, y, z, yaw, prone && alive, this.speed, dt);

    const crouched = height < STAND_HEIGHT - 0.2;
    // lying flat: a straight figure (rocked by Lying while it crawls)
    const state: State = !alive ? (this.speed > 0.6 && this.actions.has('outWalk') ? 'outWalk' : 'out') : prone ? 'idle' : crouched ? (this.speed > 0.6 ? 'crouchMove' : 'crouch') : this.speed > 1 ? 'run' : 'idle';
    if (state !== this.state) this.play(state, 0.2);
    const run = this.actions.get('run');
    if (run) run.timeScale = Math.max(0.6, Math.min(1.4, this.speed / 6.5));
    const walk = this.actions.get('outWalk');
    if (walk) walk.timeScale = Math.max(0.6, Math.min(1.4, this.speed / 3.1));

    this.mixer.update(dt);
    // aim up/down: bend at the waist and neck on top of whatever the animation did
    if (alive && !prone) {
      if (this.torso) this.torso.rotation.x += pitch * 0.55;
      if (this.head) this.head.rotation.x += pitch * 0.4;
    }
  }

  fire(): void {
    if (this.state === 'out' || this.state === 'outWalk' || !this.shoot) return;
    this.shoot.reset().play();
  }

  dress(outfit: Outfit): void {
    if (outfit === this.outfit) return;
    this.outfit = outfit;
    if (outfit === 'astronaut' && !this.gear.length) this.makeGear();
    for (const g of this.gear) g.visible = outfit === 'astronaut';
    this.model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || this.gear.some((g) => g === mesh || g.getObjectById(mesh.id))) return;
      if (outfit === 'astronaut') {
        this.jersey.set(mesh, mesh.material);
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(suitMaterial) : suitMaterial(mesh.material);
      } else {
        const m = this.jersey.get(mesh);
        if (m) mesh.material = m;
      }
    });
    if (outfit !== 'astronaut') this.jersey.clear();
  }

  /** the helmet bubble on the head and the backpack on the torso, sized from the figure itself */
  private makeGear(): void {
    let team: THREE.Material | null = null;
    this.model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !team) {
        const ms = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        team = ms.find((m) => m.name === 'team') ?? null;
      }
    });
    if (this.head) {
      // the helmet is everything on the head joint: centre the bubble on it, a little bigger
      this.model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(this.head);
      const size = box.getSize(new THREE.Vector3());
      const centre = this.head.worldToLocal(box.getCenter(new THREE.Vector3()));
      const b = bubble(Math.max(size.x, size.y, size.z) / 2 + 0.05);
      b.position.copy(centre);
      this.head.add(b);
      this.gear.push(b);
    }
    if (this.torso) {
      const pack = backpack(team);
      pack.position.set(0, 0.3, 0.235); // on the back (the figure faces -z)
      this.torso.add(pack);
      this.gear.push(pack);
    }
    for (const g of this.gear) toonify(g);
  }

  dispose(): void {
    for (const g of this.gear) g.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    this.model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (m.userData.teamCopy) m.dispose();
    });
  }

  private play(state: State, fade: number): void {
    const next = this.actions.get(state);
    if (!next) return;
    const prev = this.state ? this.actions.get(this.state) : undefined;
    next.reset().setEffectiveWeight(1).play();
    if (prev && prev !== next && fade > 0) prev.crossFadeTo(next, fade, false);
    else if (prev && prev !== next) prev.stop();
    this.state = state;
  }
}

export class PrimitiveAvatar implements Avatar {
  readonly root = new THREE.Group();
  private head = new THREE.Group();
  private mats: THREE.MeshStandardMaterial[] = [];
  private alive = true;
  private lying = new Lying();
  private last = { x: NaN, z: NaN, t: 0 };
  private suit: THREE.Group;

  constructor(color: number) {
    const suit = this.mat({ color, roughness: 0.8 });
    const dark = this.mat({ color: 0x1b1b22, roughness: 0.35, metalness: 0.2 });
    const lens = this.mat({ color: 0x0b0d12, roughness: 0.1, metalness: 0.6 });

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.85, 6, 14), suit);
    body.position.y = 0.72;

    this.head.position.y = 1.56;
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.16, 18, 14), dark);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.1, 0.08), lens);
    visor.position.set(0, 0.02, -0.13);
    this.head.add(skull, visor);

    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.45), dark);
    gun.position.set(0.17, 1.18, -0.3);
    const hopper = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 10), suit);
    hopper.position.set(0.17, 1.3, -0.24);

    this.root.add(body, this.head, gun, hopper);
    this.root.traverse((o) => (o.castShadow = true));
    // the space suit's extras: a helmet bubble and a backpack
    this.suit = new THREE.Group();
    const helmet = bubble(0.24);
    this.head.add(helmet);
    const pack = backpack(null);
    pack.position.set(0, 1.05, 0.3);
    this.suit.add(pack);
    this.root.add(this.suit);
    this.suitParts = [helmet, this.suit];
    this.dress('jersey');
  }

  private suitParts: THREE.Object3D[] = [];

  dress(outfit: Outfit): void {
    for (const p of this.suitParts) p.visible = outfit === 'astronaut';
  }

  set(x: number, y: number, z: number, yaw: number, pitch: number, height: number, alive: boolean, prone = false): void {
    const now = performance.now() / 1000;
    const dt = this.last.t ? Math.min(0.1, now - this.last.t) : 0;
    const speed = dt > 0 && !Number.isNaN(this.last.x) ? Math.min(5, Math.hypot(x - this.last.x, z - this.last.z) / dt) : 0;
    this.last = { x, z, t: now };
    this.lying.place(this.root, x, y, z, yaw, prone && alive, speed, dt);
    // crouching squashes the figure; lying down it's full length, on its front
    this.root.scale.y = prone ? 1 : height / STAND_HEIGHT;
    this.head.rotation.x = pitch * 0.6;
    if (alive !== this.alive) {
      this.alive = alive;
      // eliminated players turn see-through until they respawn
      for (const m of this.mats) {
        m.transparent = !alive;
        m.opacity = alive ? 1 : 0.35;
        m.needsUpdate = true;
      }
    }
  }

  fire(): void {}

  dispose(): void {
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const m of this.mats) m.dispose();
  }

  private mat(p: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial(p);
    this.mats.push(m);
    return m;
  }
}

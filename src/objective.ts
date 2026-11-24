// The buzzers and flags on the field, and a marker over whatever you should be going for. The
// rules (and where they stand) are in shared/objective.ts; the server decides, and tells us with
// 'objective' messages, which main.ts passes to set().
//
//  - buzzer: a post at the back of each end, in the colours of the team it belongs to, with a big
//    button on top. The marker hangs over the other team's buzzer.
//  - flag: a pole and a flag at each team's base. A carried flag rides above its carrier, a dropped
//    one lies on the ground. Markers: over the other team's flag (or over your base while you're
//    carrying it), and over your own flag whenever it isn't at home.

import * as THREE from 'three';
import { baseOf, homeFlags, type FlagState, type ObjectiveKind } from '../shared/objective';
import { TEAM_COLORS, type Team } from '../shared/protocol';
import { toonify } from './toon';

/** where a player is, for a carried flag: null if we don't know them */
export type Locate = (id: number) => { x: number; y: number; z: number; height: number } | null;

const GOLD = 0xffd23f;
const INK = 0x16131c;

export class ObjectiveView {
  kind: ObjectiveKind | null = null;
  flags: [FlagState, FlagState] = homeFlags();
  private root = new THREE.Group();
  private flagModels: THREE.Group[] = [];
  private markers: THREE.Sprite[] = [];
  private markerTex: Map<number, THREE.CanvasTexture> = new Map();
  private time = 0;

  constructor(scene: THREE.Scene) {
    this.root.name = 'objective';
    scene.add(this.root);
  }

  /** draw the field's buzzers or flags (call after the field changes); null hides everything */
  build(kind: ObjectiveKind | null): void {
    // free the old ones (the marker textures are kept: one per colour, reused)
    this.root.traverse((o) => {
      const m = o as THREE.Mesh | THREE.Sprite;
      if (m instanceof THREE.Mesh) m.geometry.dispose();
      if (m instanceof THREE.Mesh || m instanceof THREE.Sprite) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
    });
    for (const o of [...this.root.children]) this.root.remove(o);
    this.flagModels = [];
    this.markers = [];
    this.kind = kind;
    this.flags = homeFlags();
    if (!kind) return;
    for (const team of [0, 1] as const) {
      const at = baseOf(team);
      if (kind === 'buzzer') {
        const b = buzzerModel(team);
        b.position.set(at.x, 0, at.z);
        // the button faces down the field
        b.rotation.y = team === 0 ? -Math.PI / 2 : Math.PI / 2;
        this.root.add(b);
      } else {
        const f = flagModel(team);
        this.flagModels.push(f);
        this.root.add(f);
        // the stand the flag lives on (and is brought back to)
        const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.65, 0.12, 20), new THREE.MeshStandardMaterial({ color: TEAM_COLORS[team], roughness: 0.6 }));
        stand.position.set(at.x, 0.06, at.z);
        this.root.add(stand);
      }
    }
    toonify(this.root);
    for (let i = 0; i < 2; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.marker(GOLD), depthTest: false, transparent: true, sizeAttenuation: false }));
      s.scale.set(0.035, 0.035, 1);
      s.renderOrder = 999;
      s.visible = false;
      this.markers.push(s);
      this.root.add(s);
    }
  }

  /** the server says where the flags are */
  set(flags: [FlagState, FlagState]): void {
    this.flags = [{ ...flags[0] }, { ...flags[1] }];
  }

  /**
   * Once a frame: flags follow their carriers, and the markers go over what `myTeam` should go for
   * (hidden when `show` is false: not playing online, or the point isn't on).
   */
  update(dt: number, locate: Locate, myTeam: Team, myId: number, show: boolean): void {
    this.time += dt;
    if (!this.kind) return;
    const them = (1 - myTeam) as Team;
    const goals: { x: number; y: number; z: number; color: number }[] = [];
    if (this.kind === 'buzzer') {
      const b = baseOf(them);
      goals.push({ x: b.x, y: 2.1, z: b.z, color: GOLD });
    } else {
      for (const team of [0, 1] as const) {
        const f = this.flags[team];
        const model = this.flagModels[team];
        let x = f.x;
        let y = 0;
        let z = f.z;
        const c = f.at === 'carried' ? locate(f.carrier) : null;
        if (c) {
          x = c.x;
          y = c.y + c.height * 0.45;
          z = c.z;
        }
        model.position.set(x, y, z);
        // carried: smaller and over the shoulder; dropped: lying in the dirt; home: upright, waving
        model.scale.setScalar(f.at === 'carried' ? 0.6 : 1);
        model.rotation.set(0, this.time * 0.6, f.at === 'dropped' ? 1.25 : 0);
        const cloth = model.getObjectByName('cloth');
        if (cloth) cloth.rotation.y = Math.sin(this.time * 3 + team) * 0.25;
        if (team === them) {
          // theirs: go and get it, or (carrying it) take it home
          if (f.at === 'carried' && f.carrier === myId) {
            const home = baseOf(myTeam);
            goals.push({ x: home.x, y: 2.1, z: home.z, color: GOLD });
          } else if (!(f.at === 'carried' && locate(f.carrier) === null)) {
            goals.push({ x, y: y + 2.5, z, color: GOLD });
          }
        } else if (f.at !== 'home') {
          // ours is out: get it back
          goals.push({ x, y: y + 2.5, z, color: TEAM_COLORS[myTeam] });
        }
      }
    }
    this.markers.forEach((m, i) => {
      const g = goals[i];
      m.visible = show && !!g;
      if (!g) return;
      m.position.set(g.x, g.y + Math.sin(this.time * 3) * 0.12, g.z);
      m.material.map = this.marker(g.color);
    });
  }

  /** a down-pointing marker in a colour, outlined in ink (made once per colour) */
  private marker(color: number): THREE.CanvasTexture {
    let t = this.markerTex.get(color);
    if (t) return t;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    g.beginPath();
    g.moveTo(8, 10);
    g.lineTo(56, 10);
    g.lineTo(32, 54);
    g.closePath();
    g.lineJoin = 'round';
    g.lineWidth = 8;
    g.strokeStyle = `#${INK.toString(16).padStart(6, '0')}`;
    g.stroke();
    g.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    g.fill();
    t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    this.markerTex.set(color, t);
    return t;
  }
}

/** a post with a box on top in the team's colour, and a big gold button on the front */
function buzzerModel(team: Team): THREE.Group {
  const g = new THREE.Group();
  g.name = `buzzer-${team}`;
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2733, roughness: 0.7 });
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.0, 0.14), dark);
  post.position.y = 0.5;
  const foot = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.5), dark);
  foot.position.y = 0.03;
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.36, 0.3), new THREE.MeshStandardMaterial({ color: TEAM_COLORS[team], roughness: 0.5 }));
  box.position.y = 1.18;
  const button = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.13, 0.08, 20), new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.35, emissive: GOLD, emissiveIntensity: 0.25 }));
  button.rotation.x = Math.PI / 2;
  button.position.set(0, 1.18, -0.18);
  for (const m of [post, foot, box, button]) {
    m.castShadow = true;
    g.add(m);
  }
  return g;
}

/** a pole with a flag in the team's colour; the cloth is named so it can wave */
function flagModel(team: Team): THREE.Group {
  const g = new THREE.Group();
  g.name = `flag-${team}`;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.2, 8), new THREE.MeshStandardMaterial({ color: 0xd9d2c3, roughness: 0.6 }));
  pole.position.y = 1.1;
  const pivot = new THREE.Group();
  pivot.name = 'cloth';
  pivot.position.y = 1.85;
  const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.55), new THREE.MeshStandardMaterial({ color: TEAM_COLORS[team], roughness: 0.8, side: THREE.DoubleSide }));
  cloth.position.x = 0.44;
  pivot.add(cloth);
  for (const m of [pole, cloth]) m.castShadow = true;
  g.add(pole, pivot);
  return g;
}

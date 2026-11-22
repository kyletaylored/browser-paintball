// Builds the game's 3D models from code and writes them as compressed glTF binaries:
//
//   npm run assets   →  public/models/bunkers.glb, marker.glb, player.glb
//
// Every model here is original and made in this file (no downloaded assets): shapes come from
// three.js geometry builders, get merged per material, and are written with glTF tooling, then
// welded, deduplicated and meshopt-compressed. CI rebuilds them and compares against the committed
// files (scripts/check-assets.ts), so they can't drift from this script. To use hand-made models instead, export .glb files
// from Blender with the same node names and drop them in public/models/.
//
// Node names the game relies on:
//   bunkers.glb  one node per bunker shape, named bunkerKey() from shared/field.ts
//   marker.glb   "marker" (origin at the trigger, barrel along -Z), "muzzle" empty at the barrel tip
//   player.glb   "player" root, bones "hips" "torso" "head" "shoulderL/R" "elbowL/R" "thighL/R"
//                "kneeL/R" "gun", animations "idle" "run" "crouch" "crouchMove" "shoot" "out" "outWalk"
// Materials named "team" are recoloured per team in the game.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Document, NodeIO, type Material, type Node } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { mkdirSync, statSync } from 'node:fs';
import { bunkerKey, type BoxBunker, type CanBunker } from '../shared/field';
import { MAPS } from '../shared/maps';
import { STAND_HEIGHT } from '../shared/sim';

/** output folder; `--out <dir>` overrides it (scripts/check-assets.ts builds into a temp folder) */
const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : 'public/models';

// ---- glTF helpers ------------------------------------------------------------------------------

interface MatSpec {
  color: number;
  roughness: number;
  metalness?: number;
}

/** collects geometry per material, then becomes one glTF mesh with a primitive per material */
class Part {
  private byMat = new Map<string, THREE.BufferGeometry[]>();

  add(mat: string, geo: THREE.BufferGeometry, pos: [number, number, number] = [0, 0, 0], rot: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1]): this {
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()).deleteAttribute('uv');
    g.applyMatrix4(
      new THREE.Matrix4().compose(
        new THREE.Vector3(...pos),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)),
        new THREE.Vector3(...scale),
      ),
    );
    if (!this.byMat.has(mat)) this.byMat.set(mat, []);
    this.byMat.get(mat)!.push(g);
    return this;
  }

  /** a glTF node holding this part's mesh */
  toNode(b: Builder, name: string): Node {
    const mesh = b.doc.createMesh(name);
    for (const [mat, geos] of [...this.byMat].sort(([a], [z]) => a.localeCompare(z))) {
      const g = mergeGeometries(geos)!;
      const prim = b.doc
        .createPrimitive()
        .setAttribute('POSITION', b.accessor('VEC3', g.getAttribute('position').array as Float32Array))
        .setAttribute('NORMAL', b.accessor('VEC3', g.getAttribute('normal').array as Float32Array))
        .setMaterial(b.material(mat));
      mesh.addPrimitive(prim);
    }
    return b.doc.createNode(name).setMesh(mesh);
  }
}

class Builder {
  readonly doc = new Document();
  private buffer = this.doc.createBuffer();
  private mats = new Map<string, Material>();
  readonly scene = this.doc.createScene();

  constructor(private specs: Record<string, MatSpec>) {}

  accessor(type: 'VEC3' | 'VEC4' | 'SCALAR', array: Float32Array) {
    return this.doc.createAccessor().setType(type).setArray(new Float32Array(array)).setBuffer(this.buffer);
  }

  material(name: string): Material {
    let m = this.mats.get(name);
    if (!m) {
      const spec = this.specs[name];
      if (!spec) throw new Error(`no material ${name}`);
      const c = new THREE.Color().setHex(spec.color); // linear, as glTF expects
      m = this.doc
        .createMaterial(name)
        .setBaseColorFactor([c.r, c.g, c.b, 1])
        .setRoughnessFactor(spec.roughness)
        .setMetallicFactor(spec.metalness ?? 0);
      this.mats.set(name, m);
    }
    return m;
  }

  async write(file: string): Promise<void> {
    await MeshoptEncoder.ready;
    await this.doc.transform(
      weld(),
      dedup(),
      prune({ keepLeaves: true }),
      // positions 14-bit, normals 10-bit: far below what the eye can see at these sizes
      meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 14, quantizeNormal: 10 }),
    );
    const io = new NodeIO()
      .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
      .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
    await io.write(`${OUT}/${file}`, this.doc);
    console.log(`  ${file.padEnd(12)} ${(statSync(`${OUT}/${file}`).size / 1024).toFixed(1)} KB`);
  }
}

const rbox = (w: number, h: number, d: number, r: number, seg = 3) => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2, h / 2, d / 2) * 0.999);
const cyl = (rt: number, rb: number, h: number, seg = 20) => new THREE.CylinderGeometry(rt, rb, h, seg);
const sphere = (r: number, w = 18, h = 12) => new THREE.SphereGeometry(r, w, h);
const capsule = (r: number, len: number) => new THREE.CapsuleGeometry(r, len, 4, 12);
const torus = (r: number, tube: number, arc = Math.PI * 2) => new THREE.TorusGeometry(r, tube, 6, 16, arc);
const hex = (n: number) => n.toString(16).padStart(6, '0');
const darker = (n: number, k: number) => new THREE.Color(n).multiplyScalar(k).getHex();

// ---- bunkers -----------------------------------------------------------------------------------
// Inflatable-style: a soft body with sewn seams, a darker base skirt and tie-down loops.

async function buildBunkers() {
  // the arena's inflatables (other fields draw their bunkers in code, src/world.ts)
  const unique = new Map<string, BoxBunker | CanBunker>();
  for (const b of MAPS.arena.bunkers) if ((b.kind === 'box' || b.kind === 'can') && !b.look) unique.set(bunkerKey(b), b);
  const specs: Record<string, MatSpec> = { trim: { color: 0x23202a, roughness: 0.75 } };
  for (const b of unique.values()) {
    specs[`skin-${hex(b.color)}`] = { color: b.color, roughness: 0.55 };
    specs[`seam-${hex(b.color)}`] = { color: darker(b.color, 0.72), roughness: 0.65 };
  }
  const B = new Builder(specs);
  for (const [key, b] of unique) {
    const skin = `skin-${hex(b.color)}`;
    const seam = `seam-${hex(b.color)}`;
    const part = new Part();
    if (b.kind === 'box') {
      const r = Math.min(0.18, b.h / 4);
      part.add(skin, rbox(b.w, b.h, b.d, r, 4), [0, b.h / 2, 0]);
      part.add('trim', rbox(b.w + 0.016, 0.07, b.d + 0.016, 0.03, 2), [0, b.h * 0.55, 0]); // belt seam
      part.add('trim', rbox(b.w + 0.024, 0.09, b.d + 0.024, 0.035, 2), [0, 0.045, 0]); // base skirt
      // vertical seams on the two long faces and the two short faces
      const seamsAlong = (len: number) => (len > 1.6 ? [-len / 4, len / 4] : [0]);
      for (const x of seamsAlong(b.w)) for (const s of [-1, 1]) part.add(seam, rbox(0.035, b.h - 2 * r, 0.014, 0.006, 1), [x, b.h / 2, s * (b.d / 2 + 0.002)]);
      for (const z of seamsAlong(b.d)) for (const s of [-1, 1]) part.add(seam, rbox(0.014, b.h - 2 * r, 0.035, 0.006, 1), [s * (b.w / 2 + 0.002), b.h / 2, z]);
      // tie-down loops at the corners
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        part.add('trim', torus(0.045, 0.011), [sx * (b.w / 2 + 0.03), 0.06, sz * (b.d / 2 + 0.03)], [0, sx * sz * Math.PI / 4 + Math.PI / 2, 0]);
      }
    } else {
      const top = b.r * 0.94;
      const rr = Math.min(0.14, b.h / 5);
      // profile up the side, round over the shoulder, a slight dome on top
      const pts: THREE.Vector2[] = [new THREE.Vector2(0, 0), new THREE.Vector2(b.r, 0)];
      for (let i = 0; i <= 6; i++) pts.push(new THREE.Vector2(b.r + (top - b.r) * (i / 6), (b.h - rr) * (i / 6)));
      for (let i = 1; i <= 6; i++) {
        const a = (i / 6) * (Math.PI / 2);
        pts.push(new THREE.Vector2(top - rr + Math.cos(a) * rr, b.h - rr + Math.sin(a) * rr));
      }
      pts.push(new THREE.Vector2(0, b.h + 0.02));
      part.add(skin, new THREE.LatheGeometry(pts, 32));
      const radiusAt = (y: number) => b.r + (top - b.r) * (y / (b.h - rr));
      for (const f of [0.33, 0.66]) part.add(seam, cyl(radiusAt(b.h * f) + 0.006, radiusAt(b.h * f) + 0.006, 0.05, 32), [0, b.h * f, 0]);
      part.add('trim', cyl(b.r + 0.012, b.r + 0.014, 0.09, 32), [0, 0.045, 0]);
      part.add('trim', cyl(0.03, 0.035, 0.035, 12), [0, b.h + 0.03, 0]); // valve
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        part.add('trim', torus(0.045, 0.011), [Math.cos(a) * (b.r + 0.03), 0.06, Math.sin(a) * (b.r + 0.03)], [0, -a, 0]);
      }
    }
    B.scene.addChild(part.toNode(B, `bunker:${key}`));
  }
  await B.write('bunkers.glb');
}

// ---- marker ------------------------------------------------------------------------------------
// Origin at the trigger, barrel along -Z, +Y up. Real size (about 60 cm long).

const MARKER_MATS: Record<string, MatSpec> = {
  body: { color: 0x2d3442, roughness: 0.35, metalness: 0.6 },
  barrel: { color: 0x1a1c22, roughness: 0.3, metalness: 0.7 },
  grip: { color: 0x15161a, roughness: 0.9 },
  chrome: { color: 0xb8bcc6, roughness: 0.2, metalness: 1 },
  tank: { color: 0x8a8f99, roughness: 0.28, metalness: 0.8 },
  lid: { color: 0x111114, roughness: 0.5 },
  team: { color: 0xff3b3b, roughness: 0.35 },
};

function markerPart(): Part {
  const p = new Part();
  p.add('body', rbox(0.04, 0.07, 0.24, 0.012, 2), [0, 0.035, -0.06]);
  p.add('body', cyl(0.017, 0.017, 0.03, 16), [0, 0.05, -0.19], [Math.PI / 2, 0, 0]); // barrel adapter
  p.add('barrel', cyl(0.0118, 0.0125, 0.3, 16), [0, 0.05, -0.355], [Math.PI / 2, 0, 0]);
  for (let i = 0; i < 4; i++) p.add('chrome', cyl(0.0128, 0.0128, 0.006, 16), [0, 0.05, -0.43 - i * 0.018], [Math.PI / 2, 0, 0]); // porting rings
  p.add('body', cyl(0.015, 0.015, 0.02, 16), [0, 0.05, -0.505], [Math.PI / 2, 0, 0]); // tip
  p.add('grip', rbox(0.032, 0.11, 0.046, 0.01, 2), [0, -0.05, 0.035], [-0.26, 0, 0]);
  p.add('body', torus(0.026, 0.0045, Math.PI), [0, -0.012, -0.022], [0, Math.PI / 2, Math.PI]); // trigger guard
  p.add('chrome', rbox(0.008, 0.032, 0.008, 0.003, 1), [0, -0.012, -0.018], [0.15, 0, 0]); // trigger
  p.add('grip', rbox(0.03, 0.085, 0.04, 0.01, 2), [0, -0.04, -0.105], [-0.1, 0, 0]); // foregrip
  p.add('body', cyl(0.019, 0.019, 0.05, 16), [0, 0.09, -0.08]); // feed neck
  p.add('team', sphere(1, 20, 14), [0, 0.15, -0.06], [0, 0, 0], [0.068, 0.062, 0.12]); // loader shell
  p.add('lid', sphere(1, 20, 10), [0, 0.19, -0.065], [0, 0, 0], [0.05, 0.03, 0.085]); // loader lid
  p.add('tank', cyl(0.034, 0.034, 0.18, 20), [0, -0.085, 0.17], [Math.PI / 2, 0, 0]); // air tank
  p.add('tank', sphere(0.034, 16, 8), [0, -0.085, 0.26], [0, 0, 0], [1, 1, 0.6]);
  p.add('chrome', cyl(0.021, 0.021, 0.045, 16), [0, -0.085, 0.06], [Math.PI / 2, 0, 0]); // regulator
  p.add('body', rbox(0.026, 0.05, 0.03, 0.006, 1), [0, -0.075, 0.07]); // tank adapter to grip
  return p;
}

async function buildMarker() {
  const B = new Builder(MARKER_MATS);
  const node = markerPart().toNode(B, 'marker');
  node.addChild(B.doc.createNode('muzzle').setTranslation([0, 0.05, -0.515]));
  B.scene.addChild(node);
  await B.write('marker.glb');
}

// ---- player ------------------------------------------------------------------------------------
// A jointed figure: each bone is a node with no mesh of its own; its geometry hangs off a child
// "<bone>_mesh" node so compression can quantise meshes without touching animated transforms.
// Faces -Z, feet on y = 0, top of the mask at STAND_HEIGHT.

const PLAYER_MATS: Record<string, MatSpec> = {
  ...MARKER_MATS,
  team: { color: 0xff3b3b, roughness: 0.8 }, // jersey + accents
  pants: { color: 0x2b2f3a, roughness: 0.85 },
  glove: { color: 0x1c1c20, roughness: 0.7 },
  shoe: { color: 0x16161a, roughness: 0.6 },
  mask: { color: 0x30343c, roughness: 0.45 },
  lens: { color: 0x0b0d12, roughness: 0.08, metalness: 0.5 },
  pack: { color: 0x222428, roughness: 0.6 },
};

type V3 = [number, number, number];
interface BoneDef {
  parent: string | null;
  at: V3;
  part?: (p: Part) => void;
}

const HIP_Y = 0.95;
const BONES: Record<string, BoneDef> = {
  player: { parent: null, at: [0, 0, 0] },
  hips: {
    parent: 'player', at: [0, HIP_Y, 0], part: (p) => {
      p.add('pants', rbox(0.34, 0.2, 0.22, 0.07), [0, 0, 0]);
      p.add('pack', rbox(0.3, 0.12, 0.09, 0.03), [0, 0.02, 0.15]); // pod pack
      for (const x of [-0.09, 0, 0.09]) {
        p.add('pack', cyl(0.028, 0.028, 0.2, 12), [x, 0.12, 0.19]);
        p.add('team', cyl(0.03, 0.03, 0.03, 12), [x, 0.235, 0.19]);
      }
    },
  },
  torso: {
    parent: 'hips', at: [0, 0.08, 0], part: (p) => {
      p.add('team', rbox(0.4, 0.5, 0.25, 0.09, 3), [0, 0.27, 0]);
      p.add('pants', rbox(0.36, 0.06, 0.23, 0.025, 2), [0, 0.03, 0]); // belt
      p.add('team', cyl(0.07, 0.08, 0.06, 14), [0, 0.54, 0]); // collar
    },
  },
  head: {
    parent: 'torso', at: [0, 0.56, 0], part: (p) => {
      const top = STAND_HEIGHT - (HIP_Y + 0.08 + 0.56); // keep the top of the mask at STAND_HEIGHT
      p.add('mask', sphere(0.125, 20, 14), [0, top - 0.125, 0]);
      p.add('lens', rbox(0.2, 0.07, 0.07, 0.02, 2), [0, top - 0.11, -0.095]);
      p.add('mask', rbox(0.17, 0.09, 0.09, 0.03, 2), [0, top - 0.205, -0.085]); // mouth guard
      p.add('team', rbox(0.23, 0.014, 0.08, 0.005, 1), [0, top - 0.055, -0.11]); // visor
    },
  },
  shoulderR: { parent: 'torso', at: [0.235, 0.46, 0], part: (p) => p.add('team', capsule(0.055, 0.2), [0, -0.13, 0]) },
  elbowR: { parent: 'shoulderR', at: [0, -0.27, 0], part: (p) => p.add('team', capsule(0.048, 0.18), [0, -0.12, 0]).add('glove', sphere(0.05, 12, 8), [0, -0.25, 0]) },
  shoulderL: { parent: 'torso', at: [-0.235, 0.46, 0], part: (p) => p.add('team', capsule(0.055, 0.2), [0, -0.13, 0]) },
  elbowL: { parent: 'shoulderL', at: [0, -0.27, 0], part: (p) => p.add('team', capsule(0.048, 0.18), [0, -0.12, 0]).add('glove', sphere(0.05, 12, 8), [0, -0.25, 0]) },
  thighR: { parent: 'hips', at: [0.1, -0.05, 0], part: (p) => p.add('pants', capsule(0.075, 0.3), [0, -0.21, 0]) },
  kneeR: {
    parent: 'thighR', at: [0, -0.44, 0], part: (p) => p.add('pants', capsule(0.064, 0.3), [0, -0.2, 0]).add('shoe', rbox(0.1, 0.075, 0.25, 0.03, 2), [0, -0.42, -0.05]),
  },
  thighL: { parent: 'hips', at: [-0.1, -0.05, 0], part: (p) => p.add('pants', capsule(0.075, 0.3), [0, -0.21, 0]) },
  kneeL: {
    parent: 'thighL', at: [0, -0.44, 0], part: (p) => p.add('pants', capsule(0.064, 0.3), [0, -0.2, 0]).add('shoe', rbox(0.1, 0.075, 0.25, 0.03, 2), [0, -0.42, -0.05]),
  },
  gun: { parent: 'torso', at: [0.08, 0.2, -0.3] },
};

// Poses are Euler XYZ rotations per bone (+X swings a hanging limb forward), plus hip height and
// gun offset. Rotating the torso by -X leans it forward.
interface Pose {
  rot: Partial<Record<string, V3>>;
  hipY: number;
  gun?: V3;
  gunRot?: V3;
}
// Euler XYZ applies Z first: -Z swings the right arm in toward the chest, +Z the left one.
const HOLD: Partial<Record<string, V3>> = {
  shoulderR: [1.05, 0, -0.3],
  elbowR: [0.55, 0, 0],
  shoulderL: [1.25, 0, 0.5],
  elbowL: [0.35, 0, 0],
};
const GUN_REST: V3 = [0.08, 0.2, -0.3];

const sin = Math.sin;
const CLIPS: Record<string, { length: number; frames: number; pose: (t: number) => Pose }> = {
  idle: {
    length: 2.4, frames: 13, pose: (t) => {
      const b = sin((t / 2.4) * Math.PI * 2);
      return { hipY: HIP_Y - 0.005 * (1 + b), rot: { ...HOLD, torso: [-0.06 + 0.015 * b, 0, 0], head: [0.04, 0.05 * b, 0], thighL: [0.04, 0, -0.04], thighR: [-0.02, 0, 0.04], kneeL: [-0.06, 0, 0], kneeR: [-0.03, 0, 0] } };
    },
  },
  run: {
    length: 0.66, frames: 17, pose: (t) => {
      const ph = (t / 0.66) * Math.PI * 2;
      const s = sin(ph);
      const knee = (x: number) => -(0.25 + 1.1 * Math.max(0, sin(x)));
      return {
        hipY: HIP_Y - 0.06 + 0.035 * Math.abs(sin(ph)),
        rot: {
          ...HOLD,
          torso: [-0.22, 0.08 * s, 0], head: [0.16, -0.08 * s, 0],
          thighL: [0.75 * s, 0, 0], thighR: [-0.75 * s, 0, 0],
          kneeL: [knee(ph + Math.PI / 2 + Math.PI), 0, 0], kneeR: [knee(ph + Math.PI / 2), 0, 0],
        },
      };
    },
  },
  crouch: {
    length: 2, frames: 9, pose: (t) => {
      const b = sin((t / 2) * Math.PI * 2);
      return { hipY: 0.6 + 0.004 * b, rot: { ...HOLD, torso: [-0.38 + 0.01 * b, 0, 0], head: [0.32, 0, 0], thighL: [1.25, 0, -0.12], thighR: [1.05, 0, 0.12], kneeL: [-2.05, 0, 0], kneeR: [-1.7, 0, 0] } };
    },
  },
  crouchMove: {
    length: 0.9, frames: 13, pose: (t) => {
      const s = sin((t / 0.9) * Math.PI * 2);
      return { hipY: 0.62 + 0.015 * Math.abs(s), rot: { ...HOLD, torso: [-0.38, 0.05 * s, 0], head: [0.32, 0, 0], thighL: [1.2 + 0.3 * s, 0, -0.1], thighR: [1.2 - 0.3 * s, 0, 0.1], kneeL: [-1.95 + 0.3 * Math.max(0, s), 0, 0], kneeR: [-1.95 + 0.3 * Math.max(0, -s), 0, 0] } };
    },
  },
  // played additively on top of whatever else is playing: a quick kick back and up
  shoot: {
    length: 0.12, frames: 7, pose: (t) => {
      const k = t < 0.03 ? t / 0.03 : Math.max(0, 1 - (t - 0.03) / 0.09);
      return { hipY: HIP_Y, rot: { ...HOLD, torso: [0.03 * k, 0, 0] }, gun: [GUN_REST[0], GUN_REST[1] + 0.01 * k, GUN_REST[2] + 0.035 * k], gunRot: [0.12 * k, 0, 0] };
    },
  },
  // eliminated: marker and hands up, the universal "I'm out" signal
  out: {
    length: 1.6, frames: 9, pose: (t) => {
      const b = sin((t / 1.6) * Math.PI * 2);
      return {
        hipY: HIP_Y,
        rot: { torso: [0.04, 0, 0], head: [-0.1, 0, 0], shoulderR: [2.85 + 0.03 * b, 0, -0.15], elbowR: [0.25, 0, 0], shoulderL: [2.9 - 0.03 * b, 0, 0.15], elbowL: [0.3, 0, 0] },
        gun: [0.12, 0.98, -0.02], gunRot: [1.25, 0, 0],
      };
    },
  },
  // eliminated and walking off the field: marker still up, an easy walk (about 3 m/s)
  outWalk: {
    length: 0.9, frames: 17, pose: (t) => {
      const ph = (t / 0.9) * Math.PI * 2;
      const s = sin(ph);
      const knee = (x: number) => -(0.12 + 0.6 * Math.max(0, sin(x)));
      return {
        hipY: HIP_Y - 0.02 + 0.015 * Math.abs(s),
        rot: {
          torso: [0.02, 0.05 * s, 0], head: [-0.08, -0.04 * s, 0],
          shoulderR: [2.85, 0, -0.15], elbowR: [0.25, 0, 0], shoulderL: [2.9, 0, 0.15], elbowL: [0.3, 0, 0],
          thighL: [0.45 * s, 0, 0], thighR: [-0.45 * s, 0, 0],
          kneeL: [knee(ph + Math.PI / 2 + Math.PI), 0, 0], kneeR: [knee(ph + Math.PI / 2), 0, 0],
        },
        gun: [0.12, 0.98 + 0.01 * Math.abs(s), -0.02], gunRot: [1.25, 0, 0],
      };
    },
  },
};

async function buildPlayer() {
  const B = new Builder(PLAYER_MATS);
  const nodes = new Map<string, Node>();
  for (const [name, def] of Object.entries(BONES)) {
    const n = B.doc.createNode(name).setTranslation(def.at);
    nodes.set(name, n);
    if (def.parent) nodes.get(def.parent)!.addChild(n);
    else B.scene.addChild(n);
    if (def.part) {
      const p = new Part();
      def.part(p);
      n.addChild(p.toNode(B, `${name}_mesh`));
    }
  }
  nodes.get('gun')!.addChild(markerPart().toNode(B, 'gun_mesh'));

  // animations: sample each pose function and write rotation/translation tracks for every bone
  const animated = ['torso', 'head', 'shoulderR', 'elbowR', 'shoulderL', 'elbowL', 'thighR', 'kneeR', 'thighL', 'kneeL'];
  const q = new THREE.Quaternion();
  for (const [clipName, clip] of Object.entries(CLIPS)) {
    const anim = B.doc.createAnimation(clipName);
    const times = new Float32Array(clip.frames);
    for (let i = 0; i < clip.frames; i++) times[i] = (i / (clip.frames - 1)) * clip.length;
    const poses = [...times].map((t) => clip.pose(t));
    const input = B.accessor('SCALAR', times);
    const track = (node: string, path: 'rotation' | 'translation', values: number[]) => {
      const sampler = B.doc.createAnimationSampler().setInput(input).setOutput(B.accessor(path === 'rotation' ? 'VEC4' : 'VEC3', new Float32Array(values))).setInterpolation('LINEAR');
      anim.addSampler(sampler);
      anim.addChannel(B.doc.createAnimationChannel().setTargetNode(nodes.get(node)!).setTargetPath(path).setSampler(sampler));
    };
    for (const bone of animated) {
      const vals: number[] = [];
      for (const p of poses) {
        q.setFromEuler(new THREE.Euler(...(p.rot[bone] ?? [0, 0, 0])));
        vals.push(q.x, q.y, q.z, q.w);
      }
      track(bone, 'rotation', vals);
    }
    track('hips', 'translation', poses.flatMap((p) => [0, p.hipY, 0]));
    track('gun', 'translation', poses.flatMap((p) => p.gun ?? GUN_REST));
    const gunRot: number[] = [];
    for (const p of poses) {
      q.setFromEuler(new THREE.Euler(...(p.gunRot ?? [0, 0, 0])));
      gunRot.push(q.x, q.y, q.z, q.w);
    }
    track('gun', 'rotation', gunRot);
  }
  await B.write('player.glb');
}

mkdirSync(OUT, { recursive: true });
console.log('building models:');
await buildBunkers();
await buildMarker();
await buildPlayer();

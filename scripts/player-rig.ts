// The player figure's joints and animations, in one place. The figure itself is made in Blender
// (art/player.py builds its geometry round these joints); scripts/blender-assets.ts then adds the
// animations below to the export. The game animates the figure by turning these joints
// (src/avatars.ts), and looks up "torso" and "head" to bend them as you aim up and down.
//
// Coordinates are the game's: metres, Y up, the figure faces -Z, feet on y = 0.

import * as THREE from 'three';
import type { Document, Node } from '@gltf-transform/core';
import { STAND_HEIGHT } from '../shared/sim';

export type V3 = [number, number, number];

export const HIP_Y = 0.95;

/** every joint: its parent and where it sits in its parent (its rest pose has no rotation) */
export const BONES: Record<string, { parent: string | null; at: V3 }> = {
  player: { parent: null, at: [0, 0, 0] },
  hips: { parent: 'player', at: [0, HIP_Y, 0] },
  torso: { parent: 'hips', at: [0, 0.08, 0] },
  head: { parent: 'torso', at: [0, 0.56, 0] },
  shoulderR: { parent: 'torso', at: [0.235, 0.46, 0] },
  elbowR: { parent: 'shoulderR', at: [0, -0.27, 0] },
  shoulderL: { parent: 'torso', at: [-0.235, 0.46, 0] },
  elbowL: { parent: 'shoulderL', at: [0, -0.27, 0] },
  thighR: { parent: 'hips', at: [0.1, -0.05, 0] },
  kneeR: { parent: 'thighR', at: [0, -0.44, 0] },
  thighL: { parent: 'hips', at: [-0.1, -0.05, 0] },
  kneeL: { parent: 'thighL', at: [0, -0.44, 0] },
  gun: { parent: 'torso', at: [0.08, 0.2, -0.3] },
};

/** where the top of the mask has to be (the hitbox is this tall), above the head joint */
export const HEAD_TOP = STAND_HEIGHT - (HIP_Y + 0.08 + 0.56);

// Poses are Euler XYZ rotations per bone (+X swings a hanging limb forward), plus hip height and
// gun offset. Rotating the torso by -X leans it forward.
interface Pose {
  rot: Partial<Record<string, V3>>;
  hipY: number;
  gun?: V3;
  gunRot?: V3;
}
// Euler XYZ applies Z first: -Z swings the right arm in toward the chest, +Z the left one.
export const HOLD: Partial<Record<string, V3>> = {
  shoulderR: [1.05, 0, -0.3],
  elbowR: [0.55, 0, 0],
  shoulderL: [1.25, 0, 0.5],
  elbowL: [0.35, 0, 0],
};
export const GUN_REST: V3 = [0.08, 0.2, -0.3];

const sin = Math.sin;
export const CLIPS: Record<string, { length: number; frames: number; pose: (t: number) => Pose }> = {
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

/** the joint layout as plain data, for the Blender build script */
export function rigData() {
  return { bones: BONES, standHeight: STAND_HEIGHT, headTop: HEAD_TOP, gunRest: GUN_REST };
}

/**
 * Add every animation in CLIPS to a document whose nodes are named like BONES (the Blender export):
 * rotation tracks for the joints, the hips' height and the gun's place in the hands.
 */
export function addPlayerClips(doc: Document): void {
  const root = doc.getRoot();
  const nodes = new Map<string, Node>(root.listNodes().map((n) => [n.getName(), n]));
  for (const name of Object.keys(BONES)) if (!nodes.has(name)) throw new Error(`the player model has no "${name}" node`);
  const buffer = root.listBuffers()[0] ?? doc.createBuffer();
  const B = { doc, accessor: (type: 'VEC3' | 'VEC4' | 'SCALAR', array: Float32Array) => doc.createAccessor().setType(type).setArray(new Float32Array(array)).setBuffer(buffer) };
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
}

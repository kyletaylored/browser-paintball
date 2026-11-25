// Turns a generated character model into a game figure:
//
//   npm run assets:characters              every art/characters/<id>.json
//   npm run assets:characters -- sniper    just that one
//
// The source is one untextured mesh from an image-to-3D tool (art/characters/<id>.glb), standing in
// whatever pose the tool chose. The recipe next to it (art/characters/<id>.json) says which way it
// faces and where its joints are. From those, this script:
//
// 1. turns and scales it into the game's axes (metres, y up, facing -z, feet on y = 0, 1.8 m tall)
// 2. skins it to the player rig (scripts/player-rig.ts): each vertex follows the nearest bones
// 3. colours it from the character's concept drawings (front and back): each triangle takes the
//    colour of the drawing where it lies, snapped to the recipe's palette. Each palette colour is a
//    material, so "team" (the jersey) and "accent" are recoloured by the game like the other models
// 4. puts the arms down, so the rig's animations (which start from arms hanging) fit it
// 5. simplifies it to the recipe's triangle budget, keeping the edges between colours
// 6. writes public/models/<id>.glb: the player rig from public/models/player.glb (joints moved to
//    fit this body, the marker, every animation) with this body in place of the built-in one
//
// Run npm run assets:blender -- player first if the rig or its animations changed.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Document, Node } from '@gltf-transform/core';
import { dedup, dequantize, meshopt, prune } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import * as THREE from 'three';
import { STAND_HEIGHT } from '../shared/sim';
import { BONES, HIP_Y } from './player-rig';
import { checkModel, gltfIO, loadRules } from './model-rules';

type V3 = [number, number, number];
type Side = 'R' | 'L';

interface Recipe {
  /** the generated model */
  source: string;
  /** the concept drawings it was made from: the figure alone on a transparent background */
  concept: { front: string; back: string };
  /** which way the source model faces */
  faces: '+z' | '-z';
  /** after turning and scaling, how far forward (+) of z = 0 the middle of the body is */
  centerZ: number;
  /** joints in the source's pose (game axes, after turning, scaling and centring), right side only */
  joints: Record<'hips' | 'torso' | 'head' | 'shoulder' | 'elbow' | 'hand' | 'thigh' | 'knee' | 'foot', V3>;
  /** material name → its colour in the drawings (and in the game) */
  palette: Record<string, string>;
  /** other colours in the drawings that count as that material (shading, highlights) */
  matchAlso?: Record<string, string[]>;
  /** the triangle budget */
  triangles: number;
}

/** the skinned joints (every bone of the rig but its root and the marker's) */
const JOINTS = ['hips', 'torso', 'head', 'shoulderR', 'elbowR', 'shoulderL', 'elbowL', 'thighR', 'kneeR', 'thighL', 'kneeL'];
const ARM = new Set(['shoulderR', 'elbowR', 'shoulderL', 'elbowL']);

const v3 = (a: V3 | number[]) => new THREE.Vector3(a[0], a[1], a[2]);
const mirror = (a: V3): V3 => [-a[0], a[1], a[2]];

// ---- 1. the source mesh, in game axes ------------------------------------------------------------

async function loadSource(r: Recipe): Promise<{ pos: Float32Array; idx: Uint32Array }> {
  const doc = await (await gltfIO()).read(r.source);
  const ps: number[] = [];
  const is: number[] = [];
  const v = new THREE.Vector3();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = new THREE.Matrix4().fromArray(node.getWorldMatrix());
    for (const prim of mesh.listPrimitives()) {
      const P = prim.getAttribute('POSITION')!;
      const base = ps.length / 3;
      for (let i = 0; i < P.getCount(); i++) {
        v.fromArray(P.getElement(i, [0, 0, 0])).applyMatrix4(m);
        ps.push(v.x, v.y, v.z);
      }
      const I = prim.getIndices();
      const n = I ? I.getCount() : P.getCount();
      for (let i = 0; i < n; i++) is.push(base + (I ? I.getScalar(i) : i));
    }
  }
  const pos = new Float32Array(ps);
  // turn to face -z, scale to standing height, feet on the ground, centred
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], pos[i + k]);
      hi[k] = Math.max(hi[k], pos[i + k]);
    }
  }
  const s = STAND_HEIGHT / (hi[1] - lo[1]);
  const turn = r.faces === '+z' ? -1 : 1;
  const cx = (lo[0] + hi[0]) / 2;
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] = turn * (pos[i] - cx) * s;
    pos[i + 1] = (pos[i + 1] - lo[1]) * s;
    pos[i + 2] = turn * pos[i + 2] * s - r.centerZ;
  }
  return { pos, idx: new Uint32Array(is) };
}

function vertexNormals(pos: Float32Array, idx: Uint32Array): Float32Array {
  const n = new Float32Array(pos.length);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < idx.length; t += 3) {
    a.fromArray(pos, idx[t] * 3);
    b.fromArray(pos, idx[t + 1] * 3).sub(a);
    c.fromArray(pos, idx[t + 2] * 3).sub(a);
    b.cross(c); // area-weighted
    for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) n[idx[t + k] * 3 + j] += b.getComponent(j);
  }
  for (let i = 0; i < n.length; i += 3) a.fromArray(n, i).normalize().toArray(n, i);
  return n;
}

// ---- 2. skinning: which joints move each vertex --------------------------------------------------

interface Bone {
  name: string;
  /** the segment it covers, in the source pose */
  a: THREE.Vector3;
  b: THREE.Vector3;
  /** how thick the body is round it */
  radius: number;
  side?: Side;
}

function bonesOf(r: Recipe): Bone[] {
  const j = r.joints;
  const bones: Bone[] = [
    { name: 'hips', a: v3(j.hips), b: v3([0, j.thigh[1] - 0.04, 0]), radius: 0.15 },
    { name: 'torso', a: v3(j.torso), b: v3(j.head), radius: 0.16 },
    { name: 'head', a: v3(j.head), b: v3([0, STAND_HEIGHT - 0.12, j.head[2]]), radius: 0.17 },
  ];
  for (const side of ['R', 'L'] as Side[]) {
    const f = side === 'R' ? (a: V3) => a : mirror;
    bones.push(
      { name: `shoulder${side}`, a: v3(f(j.shoulder)), b: v3(f(j.elbow)), radius: 0.09, side },
      { name: `elbow${side}`, a: v3(f(j.elbow)), b: v3(f(j.hand)), radius: 0.09, side },
      { name: `thigh${side}`, a: v3(f(j.thigh)), b: v3(f(j.knee)), radius: 0.11, side },
      { name: `knee${side}`, a: v3(f(j.knee)), b: v3(f([j.foot[0], 0, j.foot[2]])), radius: 0.11, side },
    );
  }
  return bones;
}

/** up to four joints per vertex (indices into JOINTS) and their weights */
function skinWeights(pos: Float32Array, bones: Bone[]): { joints: Uint8Array; weights: Float32Array } {
  const count = pos.length / 3;
  const joints = new Uint8Array(count * 4);
  const weights = new Float32Array(count * 4);
  const p = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ap = new THREE.Vector3();
  const SOFT = 0.018; // how far (m) one bone's pull fades into the next round a joint
  const score = new Float32Array(bones.length);
  for (let i = 0; i < count; i++) {
    p.fromArray(pos, i * 3);
    for (let k = 0; k < bones.length; k++) {
      const bn = bones[k];
      // each side's limbs only take vertices on their side
      if ((bn.side === 'R' && p.x < -0.02) || (bn.side === 'L' && p.x > 0.02)) {
        score[k] = Infinity;
        continue;
      }
      ab.subVectors(bn.b, bn.a);
      ap.subVectors(p, bn.a);
      const t = ap.dot(ab) / ab.lengthSq();
      const near = bn.a.clone().addScaledVector(ab, Math.min(1, Math.max(0, t)));
      let d = p.distanceTo(near) - bn.radius;
      // an arm doesn't reach back past its shoulder into the chest
      if (ARM.has(bn.name) && t < 0) d += -t * ab.length() * 3;
      score[k] = d;
    }
    const best = Math.min(...score);
    const ranked = [...score.keys()].filter((k) => score[k] < best + SOFT * 6).sort((a, b) => score[a] - score[b]).slice(0, 4);
    let sum = 0;
    const w = ranked.map((k) => Math.exp(-(score[k] - best) / SOFT));
    for (const x of w) sum += x;
    ranked.forEach((k, n) => {
      joints[i * 4 + n] = JOINTS.indexOf(bones[k].name);
      weights[i * 4 + n] = w[n] / sum;
    });
  }
  return { joints, weights };
}

// ---- 3. colour from the drawings -----------------------------------------------------------------

interface Drawing {
  w: number;
  h: number;
  /** palette index per pixel, -1 where there's no figure */
  label: Int8Array;
  /** the figure's box, and where the tips of its two hands are */
  top: number;
  bottom: number;
  cx: number;
  leftTip: [number, number];
  rightTip: [number, number];
}

const hexRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

async function loadDrawing(file: string, r: Recipe, names: string[]): Promise<Drawing> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const swatches: [number, number[]][] = [];
  names.forEach((n, i) => {
    swatches.push([i, hexRgb(r.palette[n])]);
    for (const c of r.matchAlso?.[n] ?? []) swatches.push([i, hexRgb(c)]);
  });
  const w = info.width;
  const h = info.height;
  const label = new Int8Array(w * h).fill(-1);
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] < 128) continue;
    let best = Infinity;
    for (const [k, c] of swatches) {
      const d = (data[i * 4] - c[0]) ** 2 + (data[i * 4 + 1] - c[1]) ** 2 + (data[i * 4 + 2] - c[2]) ** 2;
      if (d < best) {
        best = d;
        label[i] = k;
      }
    }
    const x = i % w;
    const y = (i / w) | 0;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  // the hand tips: the middle of the figure's pixels in its outermost columns
  const tip = (x: number): [number, number] => {
    const ys: number[] = [];
    for (let y = 0; y < h; y++) if (label[y * w + x] >= 0) ys.push(y);
    return [x, ys.length ? (ys[0] + ys[ys.length - 1]) / 2 : (y0 + y1) / 2];
  };
  return { w, h, label, top: y0, bottom: y1, cx: (x0 + x1) / 2, leftTip: tip(x0), rightTip: tip(x1) };
}

/**
 * The palette index at a point of the drawing (off the figure: the nearest bit of figure). The
 * drawing's ink lines are `ink`-coloured too, so ink only counts where most of the pixels round
 * the point are ink (a black glove, not the line round a red sleeve).
 */
function sample(d: Drawing, u: number, v: number, ink: number): number {
  const l = nearest(d, u, v);
  if (l !== ink) return l;
  const count = new Map<number, number>();
  const R = 6;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const x = Math.round(u) + dx;
      const y = Math.round(v) + dy;
      if (x < 0 || y < 0 || x >= d.w || y >= d.h) continue;
      const k = d.label[y * d.w + x];
      if (k >= 0) count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  const all = [...count.values()].reduce((a, b) => a + b, 0);
  if ((count.get(ink) ?? 0) >= all * 0.45) return ink;
  let best = ink;
  for (const [k, c] of count) if (k !== ink && c > (count.get(best) ?? 0)) best = k;
  return best;
}

function nearest(d: Drawing, u: number, v: number): number {
  const x = Math.round(u);
  const y = Math.round(v);
  for (let r = 0; r < 40; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= d.w || yy >= d.h) continue;
        const l = d.label[yy * d.w + xx];
        if (l >= 0) return l;
      }
    }
  }
  return 0;
}

/**
 * A palette index per triangle. The body is drawn standing straight, so a point on it is where it
 * looks in the drawing from the front or the back (whichever it faces). The arms aren't posed like
 * the drawing's, so a point on an arm is placed by how far along the arm it is, and how far above
 * the arm's middle line.
 */
function colourTriangles(pos: Float32Array, idx: Uint32Array, skin: { joints: Uint8Array; weights: Float32Array }, r: Recipe, front: Drawing, back: Drawing, ink: number): Uint8Array {
  const tris = idx.length / 3;
  const labels = new Uint8Array(tris);
  const armWeight = (i: number, side: Side) => {
    let s = 0;
    for (let k = 0; k < 4; k++) {
      const name = JOINTS[skin.joints[i * 4 + k]];
      if (name === `shoulder${side}` || name === `elbow${side}`) s += skin.weights[i * 4 + k];
    }
    return s;
  };
  // drawing scale: its figure's height is the standing height
  const scale = (d: Drawing) => (d.bottom - d.top) / STAND_HEIGHT;
  // where a body point is in a drawing (the front shows the figure's right on the left)
  const onBody = (d: Drawing, isFront: boolean, p: THREE.Vector3): [number, number] => [d.cx + (isFront ? -1 : 1) * p.x * scale(d), d.bottom - p.y * scale(d)];
  const arm = (side: Side) => {
    const f = side === 'R' ? (a: V3) => a : mirror;
    const s = v3(f(r.joints.shoulder));
    const hand = v3(f(r.joints.hand));
    const along = hand.clone().sub(s);
    const len = along.length();
    along.normalize();
    const up = new THREE.Vector3(0, 1, 0).addScaledVector(along, -along.y).normalize();
    // the direction that faces the viewer of the front drawing once the arm is held out sideways
    const flat = new THREE.Vector3(along.x, 0, along.z).normalize();
    const out = new THREE.Vector3().crossVectors(side === 'R' ? flat : flat.clone().negate(), new THREE.Vector3(0, 1, 0));
    return { s, len, along, up, out };
  };
  const arms = { R: arm('R'), L: arm('L') };
  const onArm = (d: Drawing, isFront: boolean, side: Side, p: THREE.Vector3): [number, number] => {
    const a = arms[side];
    const rel = p.clone().sub(a.s);
    const t = Math.max(0, rel.dot(a.along) / a.len);
    // how far round the arm, from its underside (-1) through its middle (0) to its top (1): the
    // model's arms are thicker than the drawing's, so this is fitted to the drawn arm's width
    const across = rel.clone().addScaledVector(a.along, -rel.dot(a.along));
    const round = across.lengthSq() > 1e-8 ? across.dot(a.up) / across.length() : 0;
    const S = onBody(d, isFront, a.s);
    // the figure's right hand is on the left of the front drawing and the right of the back one
    const T = (side === 'R') === isFront ? d.leftTip : d.rightTip;
    const du = T[0] - S[0];
    const dv = T[1] - S[1];
    const l = Math.hypot(du, dv);
    let nu = dv / l;
    let nv = -du / l;
    if (nv > 0) {
      nu = -nu;
      nv = -nv;
    }
    // across the drawn arm there: the run of figure pixels through (or nearest) the line
    const cu = S[0] + t * du;
    const cv = S[1] + t * dv;
    const REACH = 70;
    const on = (k: number) => {
      const x = Math.round(cu + k * nu);
      const y = Math.round(cv + k * nv);
      return x >= 0 && y >= 0 && x < d.w && y < d.h && d.label[y * d.w + x] >= 0;
    };
    let seed = 0;
    for (let k = 0; k <= REACH && !on(seed); k++) seed = on(k) ? k : on(-k) ? -k : 0;
    let hi = seed;
    let lo = seed;
    while (hi < REACH && on(hi + 1)) hi++;
    while (lo > -REACH && on(lo - 1)) lo--;
    const mid = (hi + lo) / 2;
    const half = ((hi - lo) / 2) * 0.8; // inside the ink outline
    return [cu + (mid + round * half) * nu, cv + (mid + round * half) * nv];
  };
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    const vs = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
    a.fromArray(pos, vs[0] * 3);
    b.fromArray(pos, vs[1] * 3);
    c.fromArray(pos, vs[2] * 3);
    n.subVectors(b, a).cross(c.clone().sub(a)).normalize();
    const mid = a.clone().add(b).add(c).divideScalar(3);
    const side: Side = mid.x >= 0 ? 'R' : 'L';
    const onArmTri = vs.reduce((s, i) => s + armWeight(i, side), 0) / 3 > 0.5;
    const facing = onArmTri ? -n.dot(arms[side].out) : -n.z;
    // side-on to both drawings: neither shows it, so it takes its colour from its neighbours
    if (Math.abs(facing) < 0.35) {
      labels[t] = UNKNOWN;
      continue;
    }
    const isFront = facing > 0;
    const d = isFront ? front : back;
    const [u, v] = onArmTri ? onArm(d, isFront, side, mid) : onBody(d, isFront, mid);
    labels[t] = sample(d, u, v, ink);
  }
  return labels;
}

const UNKNOWN = 255;

/**
 * Fill in the triangles neither drawing shows (UNKNOWN) from the coloured ones round them, then
 * smooth the colouring: each triangle takes the commonest colour round it, so specks and thin
 * lines go.
 */
function smoothLabels(idx: Uint32Array, vertices: number, labels: Uint8Array, passes: number, colours: number): Uint8Array {
  const tris = idx.length / 3;
  const start = new Uint32Array(vertices + 1);
  for (const v of idx) start[v + 1]++;
  for (let i = 0; i < vertices; i++) start[i + 1] += start[i];
  const fill = start.slice(0, vertices);
  const vt = new Uint32Array(idx.length);
  for (let t = 0; t < tris; t++) for (let k = 0; k < 3; k++) vt[fill[idx[t * 3 + k]]++] = t;
  let cur = labels;
  const count = new Uint16Array(colours);
  const step = (fillOnly: boolean): number => {
    const next = cur.slice();
    let unknown = 0;
    for (let t = 0; t < tris; t++) {
      if (fillOnly && cur[t] !== UNKNOWN) continue;
      count.fill(0);
      for (let k = 0; k < 3; k++) {
        const v = idx[t * 3 + k];
        for (let j = start[v]; j < start[v + 1]; j++) if (cur[vt[j]] !== UNKNOWN) count[cur[vt[j]]]++;
      }
      let best = cur[t] === UNKNOWN ? -1 : cur[t];
      for (let l = 0; l < colours; l++) if (count[l] > (best < 0 ? 0 : count[best])) best = l;
      if (best < 0) unknown++;
      else next[t] = best;
    }
    cur = next;
    return unknown;
  };
  for (let i = 0; i < 500 && step(true) > 0; i++);
  for (let p = 0; p < passes; p++) step(false);
  return cur;
}

// ---- 4. arms down: the rest pose the animations start from ---------------------------------------

/** where every joint is with the arms hanging (legs as modelled) */
function restJoints(r: Recipe): Record<string, THREE.Vector3> {
  const j = r.joints;
  const out: Record<string, THREE.Vector3> = { player: new THREE.Vector3(), hips: v3(j.hips), torso: v3(j.torso), head: v3(j.head) };
  for (const side of ['R', 'L'] as Side[]) {
    const f = side === 'R' ? (a: V3) => a : mirror;
    const s = v3(f(j.shoulder));
    out[`shoulder${side}`] = s;
    out[`elbow${side}`] = s.clone().add(new THREE.Vector3(0, -v3(j.elbow).distanceTo(v3(j.shoulder)), 0));
    out[`hand${side}`] = out[`elbow${side}`].clone().add(new THREE.Vector3(0, -v3(j.hand).distanceTo(v3(j.elbow)), 0));
    out[`thigh${side}`] = v3(f(j.thigh));
    out[`knee${side}`] = v3(f(j.knee));
  }
  return out;
}

/** move each vertex from the source pose to the rest pose (undo the skin's pose for it) */
function unpose(pos: Float32Array, nrm: Float32Array, skin: { joints: Uint8Array; weights: Float32Array }, r: Recipe): void {
  const rest = restJoints(r);
  const posed = (name: string): THREE.Vector3 => {
    const side: Side = name.endsWith('L') ? 'L' : 'R';
    const f = side === 'R' ? (a: V3) => a : mirror;
    if (name.startsWith('shoulder')) return v3(f(r.joints.shoulder));
    if (name.startsWith('elbow')) return v3(f(r.joints.elbow));
    return rest[name];
  };
  const down = new THREE.Vector3(0, -1, 0);
  // per joint: the source pose relative to the rest pose (identity but for the arms)
  const M = JOINTS.map((name) => {
    if (!ARM.has(name)) return new THREE.Matrix4();
    const side: Side = name.endsWith('L') ? 'L' : 'R';
    const f = side === 'R' ? (a: V3) => a : mirror;
    const to = name.startsWith('shoulder') ? v3(f(r.joints.elbow)).sub(v3(f(r.joints.shoulder))) : v3(f(r.joints.hand)).sub(v3(f(r.joints.elbow)));
    const q = new THREE.Quaternion().setFromUnitVectors(down, to.normalize());
    const p = posed(name);
    return new THREE.Matrix4().makeTranslation(p.x, p.y, p.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q)).multiply(new THREE.Matrix4().makeTranslation(-rest[name].x, -rest[name].y, -rest[name].z));
  });
  const v = new THREE.Vector3();
  const blend = new THREE.Matrix4();
  const normal = new THREE.Matrix3();
  for (let i = 0; i < pos.length / 3; i++) {
    const e = new Array(16).fill(0);
    for (let k = 0; k < 4; k++) {
      const w = skin.weights[i * 4 + k];
      if (!w) continue;
      const m = M[skin.joints[i * 4 + k]].elements;
      for (let n = 0; n < 16; n++) e[n] += w * m[n];
    }
    blend.fromArray(e).invert();
    v.fromArray(pos, i * 3).applyMatrix4(blend).toArray(pos, i * 3);
    normal.getNormalMatrix(blend);
    v.fromArray(nrm, i * 3).applyMatrix3(normal).normalize().toArray(nrm, i * 3);
  }
}

// ---- 5. simplify, one colour at a time -----------------------------------------------------------

async function simplifyParts(pos: Float32Array, idx: Uint32Array, labels: Uint8Array, colours: number, budget: number): Promise<Uint32Array[]> {
  await MeshoptSimplifier.ready;
  const parts: Uint32Array[] = [];
  const total = labels.length;
  for (let l = 0; l < colours; l++) {
    const mine: number[] = [];
    for (let t = 0; t < total; t++) if (labels[t] === l) mine.push(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
    const share = mine.length / 3 / total;
    const target = Math.max(3, Math.round(budget * share) * 3);
    // edges between colours are borders of each part: kept, so the colours still meet
    const [out] = MeshoptSimplifier.simplify(new Uint32Array(mine), pos, 3, target, 0.02, ['LockBorder']);
    parts.push(out);
  }
  return parts;
}

// ---- 6. the game file ----------------------------------------------------------------------------

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

async function build(id: string, r: Recipe): Promise<string> {
  const names = Object.keys(r.palette);
  const { pos, idx } = await loadSource(r);
  const vertices = pos.length / 3;
  const nrm = vertexNormals(pos, idx);
  const bones = bonesOf(r);
  const skin = skinWeights(pos, bones);
  const [front, back] = await Promise.all([loadDrawing(r.concept.front, r, names), loadDrawing(r.concept.back, r, names)]);
  const labels = smoothLabels(idx, vertices, colourTriangles(pos, idx, skin, r, front, back, names.indexOf('trim')), 5, names.length);
  unpose(pos, nrm, skin, r);
  const parts = await simplifyParts(pos, idx, labels, names.length, r.triangles);

  // the rig and marker from the built-in figure, without its body
  const io = await gltfIO();
  const doc = await io.read('public/models/player.glb');
  await doc.transform(dequantize());
  const root = doc.getRoot();
  const byName = new Map<string, Node>(root.listNodes().map((n) => [n.getName(), n]));
  const gun = byName.get('gun')!;
  const inGun = (n: Node | null): boolean => !!n && (n === gun || inGun(n.getParentNode()));
  for (const n of root.listNodes()) if (n.getMesh() && !inGun(n)) n.dispose();
  // the built-in figure's gloves come with the marker: this body has its own hands
  for (const n of root.listNodes()) {
    for (const p of n.getMesh()?.listPrimitives() ?? []) if (p.getMaterial()?.getName() === 'glove') p.dispose();
  }

  // joints moved to fit this body
  const rest = restJoints(r);
  for (const [name, bone] of Object.entries(BONES)) {
    if (!bone.parent || name === 'gun') continue;
    const at = rest[name].clone().sub(rest[bone.parent]);
    byName.get(name)!.setTranslation([at.x, at.y, at.z]);
  }
  // the animations move the hips to heights made for the built-in figure: scale them to this one
  const hipScale = rest.hips.y / HIP_Y;
  for (const anim of root.listAnimations()) {
    for (const ch of anim.listChannels()) {
      if (ch.getTargetNode()?.getName() !== 'hips' || ch.getTargetPath() !== 'translation') continue;
      const out = ch.getSampler()!.getOutput()!;
      const arr = new Float32Array(out.getArray()!);
      for (let i = 1; i < arr.length; i += 3) arr[i] *= hipScale;
      out.setArray(arr);
    }
  }

  const buffer = root.listBuffers()[0];
  const skinNode = doc.createSkin(`${id}_skin`).setSkeleton(byName.get('player')!);
  const ibm = new Float32Array(JOINTS.length * 16);
  JOINTS.forEach((name, i) => {
    skinNode.addJoint(byName.get(name)!);
    new THREE.Matrix4().makeTranslation(-rest[name].x, -rest[name].y, -rest[name].z).toArray(ibm, i * 16);
  });
  skinNode.setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(ibm).setBuffer(buffer));

  const mesh = doc.createMesh(`body_${id}`);
  parts.forEach((part, l) => {
    if (!part.length) return;
    // just this part's vertices
    const remap = new Map<number, number>();
    const local = new Uint32Array(part.length);
    part.forEach((v, i) => {
      if (!remap.has(v)) remap.set(v, remap.size);
      local[i] = remap.get(v)!;
    });
    const n = remap.size;
    const P = new Float32Array(n * 3);
    const N = new Float32Array(n * 3);
    const J = new Uint8Array(n * 4);
    const W = new Float32Array(n * 4);
    for (const [v, i] of remap) {
      P.set(pos.subarray(v * 3, v * 3 + 3), i * 3);
      N.set(nrm.subarray(v * 3, v * 3 + 3), i * 3);
      J.set(skin.joints.subarray(v * 4, v * 4 + 4), i * 4);
      W.set(skin.weights.subarray(v * 4, v * 4 + 4), i * 4);
    }
    const [cr, cg, cb] = hexRgb(r.palette[names[l]]).map(srgbToLinear);
    const mat = doc.createMaterial(names[l]).setBaseColorFactor([cr, cg, cb, 1]).setRoughnessFactor(0.6).setMetallicFactor(0);
    const acc = (type: 'VEC3' | 'VEC4' | 'SCALAR', a: Float32Array<ArrayBuffer> | Uint8Array<ArrayBuffer> | Uint32Array<ArrayBuffer>) => doc.createAccessor().setType(type).setArray(a).setBuffer(buffer);
    mesh.addPrimitive(
      doc.createPrimitive()
        .setAttribute('POSITION', acc('VEC3', P))
        .setAttribute('NORMAL', acc('VEC3', N))
        .setAttribute('JOINTS_0', acc('VEC4', J))
        .setAttribute('WEIGHTS_0', acc('VEC4', W))
        .setIndices(acc('SCALAR', n < 65536 ? (new Uint16Array(local) as unknown as Uint32Array<ArrayBuffer>) : new Uint32Array(local)))
        .setMaterial(mat),
    );
  });
  byName.get('player')!.addChild(doc.createNode(`body_${id}`).setMesh(mesh).setSkin(skinNode));

  await doc.transform(
    dedup(),
    prune({ keepLeaves: true }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 14, quantizeNormal: 10 }),
  );
  const out = join('public/models', `${id}.glb`);
  await io.write(out, doc);
  return out;
}

// ---- run -----------------------------------------------------------------------------------------

const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const ids = readdirSync('art/characters')
  .filter((f) => f.endsWith('.json'))
  .map((f) => basename(f, '.json'))
  .filter((id) => !filter.length || filter.includes(id));
if (!ids.length) throw new Error(`no recipe art/characters/<id>.json for ${filter.join(' ')}`);
if (!existsSync('public/models/player.glb')) throw new Error('public/models/player.glb is missing: npm run assets:blender -- player');
const rules = loadRules();
let failed = 0;
for (const id of ids) {
  const recipe = JSON.parse(readFileSync(join('art/characters', `${id}.json`), 'utf8')) as Recipe;
  const out = await build(id, recipe);
  const rule = rules.find((x) => x.out === `${id}.glb`);
  if (!rule) {
    console.log(`??    ${id}.glb: no rule for it in art/models.json`);
    failed++;
    continue;
  }
  const { problems, summary } = await checkModel(rule, out);
  console.log(`${problems.length ? 'FAIL' : 'ok  '}  ${`${id}.glb`.padEnd(18)} ${summary}`);
  for (const p of problems) console.log(`      ${p}`);
  if (problems.length) failed++;
}
process.exit(failed ? 1 : 0);

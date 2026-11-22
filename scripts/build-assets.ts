// Builds the game's 3D models from code and writes them as compressed glTF binaries:
//
//   npm run assets   →  public/models/marker.glb (the bunkers and the player figure come from Blender: art/)
//
// Every model here is original and made in this file (no downloaded assets): shapes come from
// three.js geometry builders, get merged per material, and are written with glTF tooling, then
// welded, deduplicated and meshopt-compressed. CI rebuilds them and compares against the committed
// files (scripts/check-assets.ts), so they can't drift from this script. To use hand-made models instead, export .glb files
// from Blender with the same node names and drop them in public/models/.
//
// Node names the game relies on:
//   marker.glb   "marker" (origin at the trigger, barrel along -Z), "muzzle" empty at the barrel tip
// Materials named "team" are recoloured per team in the game. (The player figure's joints and
// animations are in scripts/player-rig.ts.)

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Document, NodeIO, type Material, type Node } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { mkdirSync, statSync } from 'node:fs';

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
const torus = (r: number, tube: number, arc = Math.PI * 2) => new THREE.TorusGeometry(r, tube, 6, 16, arc);

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


mkdirSync(OUT, { recursive: true });
console.log('building models:');
await buildMarker();

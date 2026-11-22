// The rules a Blender-made model has to meet (art/models.json), and the checks for them. Used by
// scripts/blender-assets.ts after each export and by scripts/check-models.ts in CI, which needs
// no Blender: it only reads the committed .glb files.

import { NodeIO, getBounds, type Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { readFileSync, statSync } from 'node:fs';
import { inflatableShapes } from './bunker-shapes';

export interface ModelRule {
  /** art/<name>.py (a Blender build script) or art/<name>.blend */
  source: string;
  /** file name in public/models */
  out: string;
  what: string;
  /** node names the game looks up */
  nodes: string[];
  /** game data the build script needs, handed over as JSON (SPLAT_INPUT): 'bunkers' = every inflatable's shape */
  input?: 'bunkers';
  /** animation name → length in seconds */
  animations: Record<string, number>;
  /** material names the game looks up ("team" is recoloured per team) */
  materials: string[];
  maxTriangles: number;
  maxKB: number;
  /** the largest it may be, metres: x, y, z in the game (y up, -z forward) */
  size: [number, number, number];
}

export function loadRules(): ModelRule[] {
  return (JSON.parse(readFileSync('art/models.json', 'utf8')) as { models: ModelRule[] }).models;
}

export async function gltfIO(): Promise<NodeIO> {
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
}

export function triangles(doc: Document): number {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      const idx = p.getIndices();
      n += (idx ? idx.getCount() : p.getAttribute('POSITION')?.getCount() ?? 0) / 3;
    }
  }
  return n;
}

/** what's wrong with `file` against `rule` (empty: nothing), and a one-line summary of it */
export async function checkModel(rule: ModelRule, file: string): Promise<{ problems: string[]; summary: string }> {
  const problems: string[] = [];
  const io = await gltfIO();
  const doc = await io.read(file);
  const root = doc.getRoot();
  const nodes = new Set(root.listNodes().map((n) => n.getName()));
  for (const n of rule.nodes) if (!nodes.has(n)) problems.push(`no node "${n}"`);
  // every inflatable on every field needs its model (named like the game looks it up)
  if (rule.input === 'bunkers') {
    const missing = inflatableShapes().filter((s) => !nodes.has(`bunker:${s.key}`)).map((s) => s.key);
    if (missing.length) problems.push(`no model for ${missing.length} bunker(s): ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', …' : ''} (re-export: the fields changed)`);
  }
  const mats = new Set(root.listMaterials().map((m) => m.getName()));
  for (const m of rule.materials) if (!mats.has(m)) problems.push(`no material "${m}"`);
  for (const m of root.listMaterials()) {
    if (m.getBaseColorTexture()) problems.push(`material "${m.getName()}" has a texture: the game's models use plain colours`);
  }
  const anims = new Map(root.listAnimations().map((a) => [a.getName(), Math.max(0, ...a.listSamplers().map((s) => s.getInput()?.getMax([])[0] ?? 0))]));
  for (const [name, len] of Object.entries(rule.animations)) {
    const have = anims.get(name);
    if (have === undefined) problems.push(`no animation "${name}" (has ${[...anims.keys()].join(', ') || 'none'})`);
    else if (Math.abs(have - len) > 0.05) problems.push(`animation "${name}" is ${have.toFixed(2)} s long, not ${len} s`);
  }
  const tris = triangles(doc);
  if (tris > rule.maxTriangles) problems.push(`${tris} triangles, over the budget of ${rule.maxTriangles}`);
  const kb = statSync(file).size / 1024;
  if (kb > rule.maxKB) problems.push(`${kb.toFixed(1)} KB, over the budget of ${rule.maxKB} KB`);
  const b = getBounds(root.listScenes()[0]);
  const size = b.max.map((v, i) => v - b.min[i]);
  size.forEach((s, i) => {
    if (s > rule.size[i]) problems.push(`${'xyz'[i]} size ${s.toFixed(2)} m, over ${rule.size[i]} m (wrong scale or orientation?)`);
  });
  if (!root.listExtensionsUsed().some((e) => e.extensionName === 'EXT_meshopt_compression')) problems.push('not compressed (export it with npm run assets:blender)');
  const summary = `${tris} triangles, ${kb.toFixed(1)} KB, ${size.map((s) => s.toFixed(2)).join(' × ')} m, animations: ${[...anims.keys()].join(', ') || 'none'}`;
  return { problems, summary };
}

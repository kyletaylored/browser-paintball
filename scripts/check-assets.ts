// Checks the committed models in public/models still match what scripts/build-assets.ts makes.
// Rebuilds into a temp folder and compares what matters (nodes, triangles, materials, animations,
// bounds) rather than bytes: float rounding differs slightly between Node versions and platforms,
// which shifts a few compressed bytes without changing the models.   npm run check:assets

import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FILES = ['marker.glb']; // bunkers.glb and player.glb are made in Blender: scripts/check-models.ts checks them
const round = (v: number, step: number) => Math.round(v / step) * step;

async function summary(file: string) {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(file);
  const root = doc.getRoot();
  const scene = root.listScenes()[0];
  const b = getBounds(scene);
  return {
    nodes: root.listNodes().map((n) => n.getName()),
    meshes: root.listMeshes().map((m) => `${m.getName()}:${m.listPrimitives().map((p) => `${p.getMaterial()?.getName()}/${(p.getIndices()?.getCount() ?? 0) / 3}`).join(',')}`),
    materials: root.listMaterials().map((m) => `${m.getName()}:${m.getBaseColorFactor().map((c) => round(c, 0.001).toFixed(3)).join(',')}:${m.getRoughnessFactor()}:${m.getMetallicFactor()}`),
    animations: root.listAnimations().map((a) => `${a.getName()}:${a.listChannels().length}:${round(Math.max(...a.listSamplers().map((s) => s.getInput()!.getMax([])[0])), 0.001).toFixed(3)}`),
    bounds: [...b.min, ...b.max].map((v) => round(v, 0.01).toFixed(2)),
  };
}

const dir = mkdtempSync(join(tmpdir(), 'splat-assets-'));
let ok = true;
try {
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/build-assets.ts', '--out', dir], { stdio: 'ignore' });
  for (const f of FILES) {
    const want = JSON.stringify(await summary(join(dir, f)), null, 1);
    const have = JSON.stringify(await summary(join('public/models', f)), null, 1);
    const same = want === have;
    ok &&= same;
    console.log(`${same ? 'PASS' : 'FAIL'}  ${f} matches scripts/build-assets.ts`);
    if (!same) {
      const w = want.split('\n');
      const h = have.split('\n');
      for (let i = 0; i < Math.max(w.length, h.length); i++) if (w[i] !== h[i]) console.log(`   committed: ${h[i]}\n   rebuilt:   ${w[i]}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (!ok) console.log('public/models is stale: run `npm run assets` and commit the result');
process.exit(ok ? 0 : 1);
